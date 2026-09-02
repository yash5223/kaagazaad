const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Otp = require('../models/Otp');
const { sendOtpEmail } = require('../utils/mailer');
const authMiddleware = require('../middleware/authMiddleware');
const { encryptAadhaar, decryptAadhaar, hashAadhaar } = require('../utils/aadhaarCrypto');
const { authLimiter, otpRequestLimiter, otpVerifyLimiter, loginSlowDown } = require('../middleware/rateLimiters');
const { validate, schemas } = require('../middleware/validators');
const { checkLocked, recordFailure, recordSuccess } = require('../utils/accountLockout');
const { logSecurityEvent } = require('../utils/securityLog');
const router = express.Router();
const EMAIL_REGEX = /^[\w.\-]+@[\w-]+\.[a-zA-Z]{2,}$/;
const OTP_MAX_ATTEMPTS = 5;
function issueToken(user) {
  return jwt.sign(
    { id: user._id, customer_id: user.customer_id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}
async function verifyOtpWithAttemptLimit({ contactInfo, otpCode, purpose }) {
  const doc = await Otp.findOne({ contactInfo, purpose });
  if (!doc) {
    return { ok: false, status: 400, error: 'Invalid or expired verification code.' };
  }
  if (doc.expiresAt < new Date()) {
    await Otp.deleteOne({ _id: doc._id });
    return { ok: false, status: 400, error: 'This code has expired. Please request a new one.' };
  }
  if (doc.attempts >= OTP_MAX_ATTEMPTS) {
    await Otp.deleteOne({ _id: doc._id });
    return { ok: false, status: 429, error: 'Too many incorrect attempts. Please request a new code.' };
  }
  if (doc.otpCode !== otpCode) {
    doc.attempts += 1;
    await doc.save();
    const remaining = OTP_MAX_ATTEMPTS - doc.attempts;
    if (remaining <= 0) {
      await Otp.deleteOne({ _id: doc._id });
      return { ok: false, status: 429, error: 'Too many incorrect attempts. Please request a new code.' };
    }
    return { ok: false, status: 400, error: `Invalid verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` };
  }
  return { ok: true, doc };
}
router.post('/register/send-otp', otpRequestLimiter, loginSlowDown, async (req, res) => {
  try {
    const { email } = req.body;
    const cleanEmail = (email || '').toLowerCase().trim();
    if (!cleanEmail || !EMAIL_REGEX.test(cleanEmail)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    if (await User.findOne({ email: cleanEmail })) {
      return res.status(400).json({ error: 'Email address already registered.' });
    }
    const otpCode = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await Otp.deleteMany({ contactInfo: cleanEmail, purpose: { $in: ['register', 'register_verified'] } });
    await Otp.create({ contactInfo: cleanEmail, otpCode, expiresAt, purpose: 'register' });
    try {
      await sendOtpEmail(cleanEmail, otpCode, 'register');
    } catch (mailErr) {
      console.error('[OTP] Failed to send registration email:', mailErr.message);
      await Otp.deleteMany({ contactInfo: cleanEmail, purpose: 'register' });
      const debugDetail = process.env.DEBUG_EMAIL_ERRORS === 'true' ? ` (${mailErr.message})` : '';
      return res.status(500).json({ error: `Could not send verification email. Please try again in a moment.${debugDetail}` });
    }
    res.status(200).json({ success: true, message: 'Verification code sent to your email' });
  } catch (err) {
    console.error('[server error]', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  }
});
router.post('/register/verify-otp', otpVerifyLimiter, async (req, res) => {
  try {
    const { email, otpCode } = req.body;
    const cleanEmail = (email || '').toLowerCase().trim();
    if (!cleanEmail || !otpCode) {
      return res.status(400).json({ error: 'Email and verification code are required.' });
    }
    const result = await verifyOtpWithAttemptLimit({ contactInfo: cleanEmail, otpCode, purpose: 'register' });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    await Otp.deleteOne({ _id: result.doc._id });
    const verificationToken = crypto.randomBytes(24).toString('hex');
    const tokenExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await Otp.create({ contactInfo: cleanEmail, otpCode: verificationToken, expiresAt: tokenExpiresAt, purpose: 'register_verified' });
    res.status(200).json({ success: true, verificationToken });
  } catch (err) {
    console.error('[server error]', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  }
});
router.post('/register', validate(schemas.registerPassword), async (req, res) => {
  try {
    const { firstName, lastName, fatherName, dob, gender, email, phone, aadhaar, passwordHash, verificationToken } = req.body;
    const cleanEmail = (email || '').toLowerCase().trim();
    const cleanFirstName = (firstName || '').trim();
    const cleanLastName = (lastName || '').trim();
    const cleanFatherName = (fatherName || '').trim(); // optional
    if (!cleanFirstName || !cleanLastName) {
      return res.status(400).json({ error: 'First name and last name are required.' });
    }
    if (!verificationToken) {
      return res.status(400).json({ error: 'Email verification is required before creating an account.' });
    }
    const verified = await Otp.findOne({ contactInfo: cleanEmail, otpCode: verificationToken, purpose: 'register_verified' });
    if (!verified) {
      return res.status(400).json({ error: 'Email verification is required or has expired. Please verify your email again.' });
    }
    if (verified.expiresAt < new Date()) {
      await Otp.deleteOne({ _id: verified._id });
      return res.status(400).json({ error: 'Email verification has expired. Please verify your email again.' });
    }
    if (await User.findOne({ email: cleanEmail })) {
      return res.status(400).json({ error: 'Email address already registered.' });
    }
    if (await User.findOne({ phone: phone.trim() })) {
      return res.status(400).json({ error: 'Phone number already registered.' });
    }
    const cleanAadhaar = (aadhaar || '').trim();
    if (!/^\d{12}$/.test(cleanAadhaar)) {
      return res.status(400).json({ error: 'A valid 12-digit Aadhaar number is required.' });
    }
    const aadhaarHash = hashAadhaar(cleanAadhaar);
    if (await User.findOne({ aadhaarHash })) {
      return res.status(400).json({ error: 'Aadhaar card number already registered.' });
    }
    const lastUser = await User.findOne().sort({ _id: -1 });
    let nextNum = 1;
    if (lastUser && lastUser.customer_id) {
      const lastIdParts = lastUser.customer_id.split('_');
      const lastNum = parseInt(lastIdParts[1], 10);
      if (!isNaN(lastNum)) {
        nextNum = lastNum + 1;
      }
    }
    const generatedCustomerId = `CUST_${nextNum}`;
    const hashedPassword = await bcrypt.hash(passwordHash, 10);
    const newUser = await User.create({
      firstName: cleanFirstName,
      lastName: cleanLastName,
      fatherName: cleanFatherName,
      dob: new Date(dob),
      gender,
      email: cleanEmail,
      phone: phone.trim(),
      aadhaarEncrypted: encryptAadhaar(cleanAadhaar),
      aadhaarHash,
      passwordHash: hashedPassword,
      customer_id: generatedCustomerId,
      subscription_plan: "",
      emailVerified: true
    });
    await Otp.deleteOne({ _id: verified._id });
    logSecurityEvent('register', { req, userId: newUser.customer_id, email: cleanEmail });
    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      data: {
        customer_id: newUser.customer_id,
        subscription_plan: newUser.subscription_plan
      }
    });
  } catch (err) {
    console.error('[server error]', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  }
});
router.post('/login', authLimiter, loginSlowDown, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    const cleanEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: cleanEmail });
    if (!user) {
      // Deliberately the same "not found" response whether or not the
      logSecurityEvent('login_failure', { req, email: cleanEmail, meta: { reason: 'no_account' } });
      return res.status(404).json({ error: 'No account found with this email.' });
    }
    const lockState = checkLocked(user, { lockedUntilField: 'loginLockedUntil' });
    if (lockState.locked) {
      logSecurityEvent('login_blocked', { req, userId: user.customer_id, email: cleanEmail, meta: { retryAfterSeconds: lockState.retryAfterSeconds } });
      return res.status(429).json({
        error: `Too many failed login attempts. Please try again in ${Math.ceil(lockState.retryAfterSeconds / 60)} minute(s).`,
      });
    }
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      const failResult = recordFailure(user, {
        attemptsField: 'failedLoginAttempts',
        lockedUntilField: 'loginLockedUntil',
        lockoutCountField: 'loginLockoutCount',
      });
      await user.save({ validateModifiedOnly: true });
      logSecurityEvent(failResult.justLocked ? 'login_lockout' : 'login_failure', {
        req,
        userId: user.customer_id,
        email: cleanEmail,
        meta: failResult.justLocked ? { retryAfterSeconds: failResult.retryAfterSeconds } : { remainingAttempts: failResult.remainingAttempts },
      });
      if (failResult.justLocked) {
        return res.status(429).json({
          error: `Too many failed login attempts. Please try again in ${Math.ceil(failResult.retryAfterSeconds / 60)} minute(s).`,
        });
      }
      return res.status(400).json({ error: 'Incorrect password.' });
    }
    recordSuccess(user, { attemptsField: 'failedLoginAttempts', lockedUntilField: 'loginLockedUntil' });
    await user.save({ validateModifiedOnly: true });
    logSecurityEvent('login_success', { req, userId: user.customer_id, email: cleanEmail });
    const token = issueToken(user);
    res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id,
        fullName: user.fullName,
        email: user.email,
        customer_id: user.customer_id,
        pinEnabled: !!user.pinEnabled
      }
    });
  } catch (err) {
    console.error('[server error]', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  }
});
router.post('/forgot-password/request', otpRequestLimiter, loginSlowDown, async (req, res) => {
  try {
    const { contactInfo } = req.body;
    if (!contactInfo || !contactInfo.trim()) {
      return res.status(400).json({ error: 'Email or phone number is required.' });
    }
    const cleanContact = contactInfo.toLowerCase().trim();
    const user = await User.findOne({
      $or: [{ email: cleanContact }, { phone: cleanContact }]
    });
    if (!user) {
      return res.status(404).json({ error: 'No account associated with that contact.' });
    }
    if (!cleanContact.includes('@')) {
      return res.status(400).json({ error: 'Password reset via phone number is not supported yet. Please use your registered email address instead.' });
    }
    const otpCode = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await Otp.deleteMany({ contactInfo: cleanContact, purpose: 'password_reset' });
    await Otp.create({ contactInfo: cleanContact, otpCode, expiresAt, purpose: 'password_reset' });
    try {
      await sendOtpEmail(cleanContact, otpCode);
    } catch (mailErr) {
      console.error('[OTP] Failed to send email:', mailErr.message);
      await Otp.deleteMany({ contactInfo: cleanContact, purpose: 'password_reset' });
      return res.status(500).json({ error: 'Could not send verification email. Please try again in a moment.' });
    }
    res.status(200).json({ success: true, message: 'Verification code sent to your email' });
  } catch (err) {
    console.error('[server error]', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  }
});
router.post('/forgot-password/verify', otpVerifyLimiter, async (req, res) => {
  try {
    const { contactInfo, otpCode } = req.body;
    if (!contactInfo || !otpCode) {
      return res.status(400).json({ error: 'Contact info and verification code are required.' });
    }
    const cleanContact = contactInfo.toLowerCase().trim();
    const result = await verifyOtpWithAttemptLimit({ contactInfo: cleanContact, otpCode, purpose: 'password_reset' });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('[server error]', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  }
});
router.post('/forgot-password/reset', otpVerifyLimiter, validate(schemas.resetPassword), async (req, res) => {
  try {
    const { contactInfo, otpCode, newPassword } = req.body;
    if (!contactInfo || !otpCode || !newPassword) {
      return res.status(400).json({ error: 'Contact info, verification code and new password are required.' });
    }
    const cleanContact = contactInfo.toLowerCase().trim();
    const result = await verifyOtpWithAttemptLimit({ contactInfo: cleanContact, otpCode, purpose: 'password_reset' });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    const hashedNewPassword = await bcrypt.hash(newPassword, 10);
    await User.updateMany(
      { $or: [{ email: cleanContact }, { phone: cleanContact }] },
      {
        $set: { passwordHash: hashedNewPassword },
        $unset: { loginLockedUntil: '' },
      }
    );
    await Otp.deleteMany({ contactInfo: cleanContact, purpose: 'password_reset' });
    logSecurityEvent('password_reset', { req, email: cleanContact });
    res.status(200).json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    console.error('[server error]', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  }
});
router.post('/set-pin', authMiddleware, validate(schemas.pinBody), async (req, res) => {
  try {
    const { password, pin } = req.body;
    if (!password || !pin) {
      return res.status(400).json({ error: 'Password and pin are required.' });
    }
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'No account found for this session.' });
    }
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Incorrect password.' });
    }
    const hashedPin = await bcrypt.hash(pin, 10);
    user.pinHash = hashedPin;
    user.pinEnabled = true;
    user.failedPinAttempts = 0;
    user.pinLockedUntil = null;
    await user.save({ validateModifiedOnly: true });
    logSecurityEvent('pin_set', { req, userId: user.customer_id, email: user.email });
    res.status(200).json({ success: true, message: '2FA PIN saved successfully.', pinEnabled: true });
  } catch (err) {
    console.error('[server error]', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  }
});
router.post('/verify-pin', authMiddleware, async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin) {
      return res.status(400).json({ error: 'Pin is required.' });
    }
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'No account found for this session.' });
    }
    if (!user.pinEnabled || !user.pinHash) {
      return res.status(200).json({ success: true, valid: true });
    }
    const lockState = checkLocked(user, { lockedUntilField: 'pinLockedUntil' });
    if (lockState.locked) {
      logSecurityEvent('pin_blocked', { req, userId: user.customer_id, email: user.email, meta: { retryAfterSeconds: lockState.retryAfterSeconds } });
      return res.status(429).json({
        success: false,
        valid: false,
        error: `Too many incorrect PIN attempts. Please try again in ${Math.ceil(lockState.retryAfterSeconds / 60)} minute(s).`,
      });
    }
    const isMatch = await bcrypt.compare(pin, user.pinHash);
    if (!isMatch) {
      const failResult = recordFailure(user, {
        attemptsField: 'failedPinAttempts',
        lockedUntilField: 'pinLockedUntil',
        lockoutCountField: 'pinLockoutCount',
      });
      await user.save({ validateModifiedOnly: true });
      logSecurityEvent(failResult.justLocked ? 'pin_lockout' : 'pin_failure', {
        req,
        userId: user.customer_id,
        email: user.email,
        meta: failResult.justLocked ? { retryAfterSeconds: failResult.retryAfterSeconds } : { remainingAttempts: failResult.remainingAttempts },
      });
      if (failResult.justLocked) {
        return res.status(429).json({
          success: false,
          valid: false,
          error: `Too many incorrect PIN attempts. Please try again in ${Math.ceil(failResult.retryAfterSeconds / 60)} minute(s).`,
        });
      }
      return res.status(200).json({ success: false, valid: false, remainingAttempts: failResult.remainingAttempts });
    }
    recordSuccess(user, { attemptsField: 'failedPinAttempts', lockedUntilField: 'pinLockedUntil' });
    await user.save({ validateModifiedOnly: true });
    res.status(200).json({ success: true, valid: true });
  } catch (err) {
    console.error('[server error]', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  }
});
router.post('/remove-pin', authMiddleware, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ error: 'Password is required.' });
    }
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'No account found for this session.' });
    }
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Incorrect password.' });
    }
    user.pinHash = null;
    user.pinEnabled = false;
    user.failedPinAttempts = 0;
    user.pinLockedUntil = null;
    await user.save({ validateModifiedOnly: true });
    logSecurityEvent('pin_removed', { req, userId: user.customer_id, email: user.email });
    res.status(200).json({ success: true, message: '2FA PIN removed successfully.', pinEnabled: false });
  } catch (err) {
    console.error('[server error]', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  }
});
router.get('/pin-status', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'No account found for this session.' });
    }
    res.status(200).json({ success: true, pinEnabled: !!user.pinEnabled });
  } catch (err) {
    console.error('[server error]', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  }
});
router.get('/profile', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'No account found for this session.' });
    }
    let aadhaar = '';
    try {
      aadhaar = decryptAadhaar(user.aadhaarEncrypted);
    } catch (decryptErr) {
      console.error('[profile] Failed to decrypt Aadhaar for user', user._id, decryptErr.message);
    }
    res.status(200).json({
      success: true,
      user: {
        firstName: user.firstName,
        lastName: user.lastName,
        fatherName: user.fatherName,
        fullName: user.fullName,
        email: user.email,
        phone: user.phone,
        dob: user.dob,
        gender: user.gender,
        aadhaar,
        customer_id: user.customer_id,
        subscription_plan: user.subscription_plan,
      },
    });
  } catch (err) {
    console.error('[server error]', err);
    res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  }
});
module.exports = router;
