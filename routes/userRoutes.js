const express = require("express");
const {reportError: reportError} = require("../utils/monitoring");
const bcrypt = require("bcryptjs");
const {hashSecret: hashSecret, needsRehash: needsRehash} = require("../utils/passwordHash");
const crypto = require("crypto");
const User = require("../models/User");
const Otp = require("../models/Otp");
const {ACCESS_TOKEN_TTL: ACCESS_TOKEN_TTL, issueAccessToken: issueAccessToken, createRefreshToken: createRefreshToken, rotateRefreshToken: rotateRefreshToken, revokeRefreshToken: revokeRefreshToken, revokeAllRefreshTokens: revokeAllRefreshTokens, generateOtpCode: generateOtpCode, hashOtp: hashOtp} = require("../utils/tokens");
const {isTrustedWebRequest: isTrustedWebRequest, setRefreshCookie: setRefreshCookie, clearRefreshCookie: clearRefreshCookie, readRefreshCookie: readRefreshCookie} = require("../utils/webSession");
const {isDeviceTrusted: isDeviceTrusted, touchDevice: touchDevice, trustDevice: trustDevice, signChallenge: signChallenge, verifyChallenge: verifyChallenge, maskEmail: maskEmail, DEVICE_OTP_TTL_MS: DEVICE_OTP_TTL_MS, DEVICE_OTP_RESEND_COOLDOWN_MS: DEVICE_OTP_RESEND_COOLDOWN_MS} = require("../utils/deviceTrust");
const {setDeviceCookie: setDeviceCookie, readDeviceCookie: readDeviceCookie} = require("../utils/webSession");
const {verifyOtpWithAttemptLimit: verifyOtpWithAttemptLimit} = require("../utils/otpVerify");
const {sendOtpEmail: sendOtpEmail, sendCredentialsEmail: sendCredentialsEmail} = require("../utils/mailer");
const {activatePlan: activatePlan} = require("../middleware/planGuard");
const authMiddleware = require("../middleware/authMiddleware");
const {encryptAadhaar: encryptAadhaar, decryptAadhaar: decryptAadhaar, hashAadhaar: hashAadhaar} = require("../utils/aadhaarCrypto");
const {authLimiter: authLimiter, otpRequestLimiter: otpRequestLimiter, otpVerifyLimiter: otpVerifyLimiter, loginSlowDown: loginSlowDown} = require("../middleware/rateLimiters");
const {validate: validate, schemas: schemas} = require("../middleware/validators");
const {checkLocked: checkLocked, recordFailure: recordFailure, recordSuccess: recordSuccess} = require("../utils/accountLockout");
const {logSecurityEvent: logSecurityEvent} = require("../utils/securityLog");
const {createAlert: createAlert} = require("./alertRoutes");
const router = express.Router();
const EMAIL_REGEX = /^[\w.\-]+@[\w-]+\.[a-zA-Z]{2,}$/;
const PLAN_DAYS = {
  free: 0,
  basic: 30,
  premium: 365
};
router.post("/register/send-otp", otpRequestLimiter, loginSlowDown, async (req, res) => {
  try {
    const {email: email} = req.body;
    const cleanEmail = (email || "").toLowerCase().trim();
    if (!cleanEmail || !EMAIL_REGEX.test(cleanEmail)) {
      return res.status(400).json({
        error: "A valid email address is required."
      });
    }
    if (await User.findOne({
      email: cleanEmail
    })) {
      return res.status(400).json({
        error: "Email address already registered."
      });
    }
    const otpCode = generateOtpCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1e3);
    await Otp.deleteMany({
      contactInfo: cleanEmail,
      purpose: {
        $in: [ "register", "register_verified" ]
      }
    });
    await Otp.create({
      contactInfo: cleanEmail,
      otpCode: hashOtp(otpCode, cleanEmail, "register"),
      expiresAt: expiresAt,
      purpose: "register"
    });
    try {
      await sendOtpEmail(cleanEmail, otpCode, "register");
    } catch (mailErr) {
      console.error("[OTP] Failed to send registration email:", mailErr.message);
      await Otp.deleteMany({
        contactInfo: cleanEmail,
        purpose: "register"
      });
      const debugDetail = process.env.DEBUG_EMAIL_ERRORS === "true" ? ` (${mailErr.message})` : "";
      return res.status(500).json({
        error: `Could not send verification email. Please try again in a moment.${debugDetail}`
      });
    }
    res.status(200).json({
      success: true,
      message: "Verification code sent to your email"
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.post("/register/verify-otp", otpVerifyLimiter, async (req, res) => {
  try {
    const {email: email, otpCode: otpCode} = req.body;
    const cleanEmail = (email || "").toLowerCase().trim();
    if (!cleanEmail || !otpCode) {
      return res.status(400).json({
        error: "Email and verification code are required."
      });
    }
    const result = await verifyOtpWithAttemptLimit({
      contactInfo: cleanEmail,
      otpCode: otpCode,
      purpose: "register"
    });
    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error
      });
    }
    await Otp.deleteOne({
      _id: result.doc._id
    });
    const verificationToken = crypto.randomBytes(24).toString("hex");
    const tokenExpiresAt = new Date(Date.now() + 15 * 60 * 1e3);
    await Otp.create({
      contactInfo: cleanEmail,
      otpCode: hashOtp(verificationToken, cleanEmail, "register_verified"),
      expiresAt: tokenExpiresAt,
      purpose: "register_verified"
    });
    res.status(200).json({
      success: true,
      verificationToken: verificationToken
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.post("/register", validate(schemas.registerPassword), async (req, res) => {
  try {
    const {firstName: firstName, lastName: lastName, fatherName: fatherName, dob: dob, gender: gender, email: email, phone: phone, aadhaar: aadhaar, passwordHash: passwordHash, plan: plan, verificationToken: verificationToken, e2ee: e2eeBundle} = req.body;
    const cleanEmail = (email || "").toLowerCase().trim();
    const cleanFirstName = (firstName || "").trim();
    const cleanLastName = (lastName || "").trim();
    const cleanFatherName = (fatherName || "").trim();
    if (!cleanFirstName || !cleanLastName) {
      return res.status(400).json({
        error: "First name and last name are required."
      });
    }
    if (!verificationToken) {
      return res.status(400).json({
        error: "Email verification is required before creating an account."
      });
    }
    const verified = await Otp.findOne({
      contactInfo: cleanEmail,
      otpCode: hashOtp(String(verificationToken), cleanEmail, "register_verified"),
      purpose: "register_verified"
    });
    if (!verified) {
      return res.status(400).json({
        error: "Email verification is required or has expired. Please verify your email again."
      });
    }
    if (verified.expiresAt < new Date) {
      await Otp.deleteOne({
        _id: verified._id
      });
      return res.status(400).json({
        error: "Email verification has expired. Please verify your email again."
      });
    }
    if (await User.findOne({
      email: cleanEmail
    })) {
      return res.status(400).json({
        error: "Email address already registered."
      });
    }
    if (await User.findOne({
      phone: phone.trim()
    })) {
      return res.status(400).json({
        error: "Phone number already registered."
      });
    }
    const cleanAadhaar = (aadhaar || "").trim();
    if (!/^\d{12}$/.test(cleanAadhaar)) {
      return res.status(400).json({
        error: "A valid 12-digit Aadhaar number is required."
      });
    }
    const aadhaarHash = hashAadhaar(cleanAadhaar);
    if (await User.findOne({
      aadhaarHash: aadhaarHash
    })) {
      return res.status(400).json({
        error: "Aadhaar card number already registered."
      });
    }
    const lastUser = await User.findOne().sort({
      _id: -1
    });
    let nextNum = 1;
    if (lastUser && lastUser.customer_id) {
      const lastIdParts = lastUser.customer_id.split("_");
      const lastNum = parseInt(lastIdParts[1], 10);
      if (!isNaN(lastNum)) {
        nextNum = lastNum + 1;
      }
    }
    const generatedCustomerId = `CUST_${nextNum}`;
    const hashedPassword = await hashSecret(passwordHash);
    const newUser = await User.create({
      firstName: cleanFirstName,
      lastName: cleanLastName,
      fatherName: cleanFatherName,
      dob: new Date(dob),
      gender: gender,
      email: cleanEmail,
      phone: phone.trim(),
      aadhaarEncrypted: encryptAadhaar(cleanAadhaar),
      aadhaarHash: aadhaarHash,
      passwordHash: hashedPassword,
      e2ee: e2eeBundle,
      customer_id: generatedCustomerId,
      subscription_plan: "",
      emailVerified: true
    });
    await Otp.deleteOne({
      _id: verified._id
    });
    let chosenPlan = String(plan || "").toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(PLAN_DAYS, chosenPlan)) {
      chosenPlan = "free";
    }
    const activated = await activatePlan(newUser._id, chosenPlan, PLAN_DAYS[chosenPlan]);
    newUser.subscription_plan = activated.plan;
    console.log(`[register] ${cleanEmail} plan=${activated.plan} (requested=${plan || "none"})`);
    // E2EE: the server only ever sees a derived secret, so there is nothing to email back.
    logSecurityEvent("register", {
      req: req,
      userId: newUser.customer_id,
      email: cleanEmail
    });
    const registerDeviceToken = await trustDevice(newUser, {
      label: String(req.body && req.body.deviceLabel || req.headers["user-agent"] || "").slice(0, 80),
      ip: req.ip || ""
    });
    const registerViaCookie = isTrustedWebRequest(req);
    if (registerViaCookie) setDeviceCookie(res, registerDeviceToken);
    res.status(201).json({
      success: true,
      message: "Account created successfully",
      ...(registerViaCookie ? {} : {deviceToken: registerDeviceToken}),
      data: {
        customer_id: newUser.customer_id,
        subscription_plan: newUser.subscription_plan
      }
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
async function sendDeviceCode(req, user) {
  const purpose = "device_login";
  const existing = await Otp.findOne({
    contactInfo: user.email,
    purpose: purpose
  });
  if (existing) {
    const createdAt = existing.expiresAt.getTime() - DEVICE_OTP_TTL_MS;
    if (Date.now() - createdAt < DEVICE_OTP_RESEND_COOLDOWN_MS) {
      return {
        ok: true,
        sentNow: false
      };
    }
  }
  const code = generateOtpCode();
  await Otp.deleteMany({
    contactInfo: user.email,
    purpose: purpose
  });
  await Otp.create({
    contactInfo: user.email,
    otpCode: hashOtp(code, user.email, purpose),
    expiresAt: new Date(Date.now() + DEVICE_OTP_TTL_MS),
    purpose: purpose
  });
  try {
    await sendOtpEmail(user.email, code, purpose);
  } catch (mailErr) {
    console.error("[device-otp] failed to send code:", mailErr.message);
    await Otp.deleteMany({
      contactInfo: user.email,
      purpose: purpose
    });
    return {
      ok: false
    };
  }
  return {
    ok: true,
    sentNow: true
  };
}
async function respondWithSession(req, res, user, {remember: remember = true, newDeviceToken: newDeviceToken} = {}) {
  const token = issueAccessToken(user);
  const refreshToken = await createRefreshToken(user._id);
  const viaCookie = isTrustedWebRequest(req);
  if (viaCookie) {
    setRefreshCookie(res, refreshToken, {
      persistent: remember
    });
    if (newDeviceToken) setDeviceCookie(res, newDeviceToken);
  }
  return res.status(200).json({
    success: true,
    token: token,
    ...(viaCookie ? {refreshInCookie: true} : {refreshToken: refreshToken}),
    ...(newDeviceToken && !viaCookie ? {deviceToken: newDeviceToken} : {}),
    expiresIn: ACCESS_TOKEN_TTL,
    user: {
      id: user._id,
      fullName: user.fullName,
      email: user.email,
      customer_id: user.customer_id,
      pinEnabled: !!user.pinEnabled
    },
    e2ee: user.e2ee || null
  });
}
function loadChallengeUser(req) {
  const decoded = verifyChallenge(req.body && req.body.challengeToken);
  return {
    decoded: decoded,
    userPromise: User.findById(decoded.userId)
  };
}
router.post("/login/verify-device", otpVerifyLimiter, async (req, res) => {
  try {
    let ctx;
    try {
      ctx = loadChallengeUser(req);
    } catch (_) {
      return res.status(401).json({
        error: "This sign-in attempt expired. Please sign in again.",
        code: "CHALLENGE_INVALID"
      });
    }
    const user = await ctx.userPromise;
    const otpCode = String(req.body && req.body.otpCode || "").trim();
    if (!user || !/^\d{6}$/.test(otpCode)) {
      return res.status(400).json({
        error: "Enter the 6-digit code from your email."
      });
    }
    const lockState = checkLocked(user, {
      lockedUntilField: "loginLockedUntil"
    });
    if (lockState.locked) {
      return res.status(429).json({
        error: `Too many failed login attempts. Please try again in ${Math.ceil(lockState.retryAfterSeconds / 60)} minute(s).`
      });
    }
    const result = await verifyOtpWithAttemptLimit({
      contactInfo: user.email,
      otpCode: otpCode,
      purpose: "device_login"
    });
    if (!result.ok) {
      logSecurityEvent("device_verify_failure", {
        req: req,
        userId: user.customer_id,
        email: user.email
      });
      return res.status(result.status).json({
        error: result.error
      });
    }
    await Otp.deleteOne({
      _id: result.doc._id
    });
    const label = String(req.body && req.body.deviceLabel || req.headers["user-agent"] || "").slice(0, 80);
    const newDeviceToken = await trustDevice(user, {
      label: label,
      ip: req.ip || ""
    });
    logSecurityEvent("device_trusted", {
      req: req,
      userId: user.customer_id,
      email: user.email,
      meta: {
        label: label
      }
    });
    await createAlert({
      title: "New Device Signed In",
      message: "A new device was verified and signed in to your account. If this wasn't you, change your password right away.",
      type: "warning",
      priority: "high",
      sent_by: "System",
      sent_to: user.customer_id
    });
    return respondWithSession(req, res, user, {
      remember: ctx.decoded.remember,
      newDeviceToken: newDeviceToken
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.post("/login/resend-device-code", otpRequestLimiter, async (req, res) => {
  try {
    let ctx;
    try {
      ctx = loadChallengeUser(req);
    } catch (_) {
      return res.status(401).json({
        error: "This sign-in attempt expired. Please sign in again.",
        code: "CHALLENGE_INVALID"
      });
    }
    const user = await ctx.userPromise;
    if (!user) {
      return res.status(401).json({
        error: "This sign-in attempt expired. Please sign in again.",
        code: "CHALLENGE_INVALID"
      });
    }
    const sent = await sendDeviceCode(req, user);
    if (!sent.ok) {
      return res.status(500).json({
        error: "Could not send the verification code. Please try again in a moment."
      });
    }
    if (!sent.sentNow) {
      return res.status(429).json({
        error: "A code was just sent. Please wait a moment before requesting another."
      });
    }
    return res.status(200).json({
      success: true,
      message: "A new code was sent."
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
// Tells the app which credential to derive. Unknown emails are reported as E2EE so a mistyped
// email never causes a raw password to be sent to the server.
router.post("/login-mode", authLimiter, loginSlowDown, async (req, res) => {
  const email = String((req.body && req.body.email) || "").toLowerCase().trim();
  const user = email ? await User.findOne({email: email}) : null;
  return res.status(200).json({success: true, legacy: !!(user && !user.e2ee)});
});
router.post("/login", authLimiter, loginSlowDown, async (req, res) => {
  try {
    const {email: email, password: password} = req.body;
    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password are required."
      });
    }
    const cleanEmail = email.toLowerCase().trim();
    const user = await User.findOne({
      email: cleanEmail
    });
    if (!user) {
      logSecurityEvent("login_failure", {
        req: req,
        email: cleanEmail,
        meta: {
          reason: "no_account"
        }
      });
      return res.status(404).json({
        error: "No account found with this email."
      });
    }
    const lockState = checkLocked(user, {
      lockedUntilField: "loginLockedUntil"
    });
    if (lockState.locked) {
      logSecurityEvent("login_blocked", {
        req: req,
        userId: user.customer_id,
        email: cleanEmail,
        meta: {
          retryAfterSeconds: lockState.retryAfterSeconds
        }
      });
      return res.status(429).json({
        error: `Too many failed login attempts. Please try again in ${Math.ceil(lockState.retryAfterSeconds / 60)} minute(s).`
      });
    }
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      const failResult = recordFailure(user, {
        attemptsField: "failedLoginAttempts",
        lockedUntilField: "loginLockedUntil",
        lockoutCountField: "loginLockoutCount"
      });
      await user.save({
        validateModifiedOnly: true
      });
      logSecurityEvent(failResult.justLocked ? "login_lockout" : "login_failure", {
        req: req,
        userId: user.customer_id,
        email: cleanEmail,
        meta: failResult.justLocked ? {
          retryAfterSeconds: failResult.retryAfterSeconds
        } : {
          remainingAttempts: failResult.remainingAttempts
        }
      });
      if (failResult.justLocked) {
        await createAlert({
          title: "Account Temporarily Locked",
          message: "Your account was locked after multiple failed login attempts. If this wasn't you, consider resetting your password.",
          type: "error",
          priority: "high",
          sent_by: "System",
          sent_to: user.customer_id
        });
        return res.status(429).json({
          error: `Too many failed login attempts. Please try again in ${Math.ceil(failResult.retryAfterSeconds / 60)} minute(s).`
        });
      }
      return res.status(400).json({
        error: "Incorrect password."
      });
    }
    recordSuccess(user, {
      attemptsField: "failedLoginAttempts",
      lockedUntilField: "loginLockedUntil"
    });
    if (needsRehash(user.passwordHash)) user.passwordHash = await hashSecret(password);
    await user.save({
      validateModifiedOnly: true
    });
    logSecurityEvent("login_success", {
      req: req,
      userId: user.customer_id,
      email: cleanEmail
    });
    const remember = !(req.body && req.body.remember === false);
    const presentedDeviceToken = isTrustedWebRequest(req) ? readDeviceCookie(req) : req.body && req.body.deviceToken;
    const clientSupportsChallenge = req.headers["x-device-verification"] === "1";
    const strictMode = (process.env.REQUIRE_DEVICE_VERIFICATION || "").toLowerCase() === "strict";
    if ((clientSupportsChallenge || strictMode) && !isDeviceTrusted(user, presentedDeviceToken)) {
      const sent = await sendDeviceCode(req, user);
      if (!sent.ok) {
        return res.status(500).json({
          error: "Could not send the verification code. Please try again in a moment."
        });
      }
      logSecurityEvent("device_challenge_sent", {
        req: req,
        userId: user.customer_id,
        email: cleanEmail,
        meta: {
          resent: !sent.sentNow
        }
      });
      return res.status(200).json({
        success: true,
        requiresDeviceVerification: true,
        challengeToken: signChallenge(user, {
          remember: remember
        }),
        maskedEmail: maskEmail(user.email),
        codeExpiresInSeconds: DEVICE_OTP_TTL_MS / 1e3
      });
    }
    await touchDevice(user, presentedDeviceToken);
    return respondWithSession(req, res, user, {
      remember: remember
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.post("/forgot-password/request", otpRequestLimiter, loginSlowDown, async (req, res) => {
  try {
    const {contactInfo: contactInfo} = req.body;
    if (!contactInfo || !contactInfo.trim()) {
      return res.status(400).json({
        error: "Email or phone number is required."
      });
    }
    const cleanContact = contactInfo.toLowerCase().trim();
    const user = await User.findOne({
      $or: [ {
        email: cleanContact
      }, {
        phone: cleanContact
      } ]
    });
    if (!user) {
      return res.status(404).json({
        error: "No account associated with that contact."
      });
    }
    if (!cleanContact.includes("@")) {
      return res.status(400).json({
        error: "Password reset via phone number is not supported yet. Please use your registered email address instead."
      });
    }
    const otpCode = generateOtpCode();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1e3);
    await Otp.deleteMany({
      contactInfo: cleanContact,
      purpose: "password_reset"
    });
    await Otp.create({
      contactInfo: cleanContact,
      otpCode: hashOtp(otpCode, cleanContact, "password_reset"),
      expiresAt: expiresAt,
      purpose: "password_reset"
    });
    try {
      await sendOtpEmail(cleanContact, otpCode);
    } catch (mailErr) {
      console.error("[OTP] Failed to send email:", mailErr.message);
      await Otp.deleteMany({
        contactInfo: cleanContact,
        purpose: "password_reset"
      });
      return res.status(500).json({
        error: "Could not send verification email. Please try again in a moment."
      });
    }
    res.status(200).json({
      success: true,
      message: "Verification code sent to your email"
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.post("/forgot-password/verify", otpVerifyLimiter, async (req, res) => {
  try {
    const {contactInfo: contactInfo, otpCode: otpCode} = req.body;
    if (!contactInfo || !otpCode) {
      return res.status(400).json({
        error: "Contact info and verification code are required."
      });
    }
    const cleanContact = contactInfo.toLowerCase().trim();
    const result = await verifyOtpWithAttemptLimit({
      contactInfo: cleanContact,
      otpCode: otpCode,
      purpose: "password_reset"
    });
    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error
      });
    }
    const resetUser = await User.findOne({email: cleanContact});
    res.status(200).json({
      success: true,
      e2ee: resetUser && resetUser.e2ee ? {v: resetUser.e2ee.v, kdfIter: resetUser.e2ee.kdfIter, recoveryWrappedMk: resetUser.e2ee.recoveryWrappedMk} : null
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.post("/forgot-password/reset", otpVerifyLimiter, validate(schemas.resetPassword), async (req, res) => {
  try {
    const {contactInfo: contactInfo, otpCode: otpCode, newPassword: newPassword, e2ee: newBundle} = req.body;
    if (!contactInfo || !otpCode || !newPassword) {
      return res.status(400).json({
        error: "Contact info, verification code and new password are required."
      });
    }
    const cleanContact = contactInfo.toLowerCase().trim();
    const result = await verifyOtpWithAttemptLimit({
      contactInfo: cleanContact,
      otpCode: otpCode,
      purpose: "password_reset"
    });
    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error
      });
    }
    const hashedNewPassword = await hashSecret(newPassword);
    const affectedUsers = await User.find({
      $or: [ {
        email: cleanContact
      }, {
        phone: cleanContact
      } ]
    });
    await User.updateMany({
      $or: [ {
        email: cleanContact
      }, {
        phone: cleanContact
      } ]
    }, {
      $set: {
        passwordHash: hashedNewPassword,
        e2ee: newBundle,
        trustedDevices: []
      },
      $inc: {
        tokenVersion: 1
      },
      $unset: {
        loginLockedUntil: ""
      }
    });
    await revokeAllRefreshTokens(affectedUsers.map(u => u._id));
    await Otp.deleteMany({
      contactInfo: cleanContact,
      purpose: "password_reset"
    });
    logSecurityEvent("password_reset", {
      req: req,
      email: cleanContact
    });
    for (const affectedUser of affectedUsers) {
      await createAlert({
        title: "Password Changed",
        message: "Your account password was changed successfully. If this wasn't you, please contact support immediately.",
        type: "warning",
        priority: "high",
        sent_by: "System",
        sent_to: affectedUser.customer_id
      });
    }
    res.status(200).json({
      success: true,
      message: "Password updated successfully"
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});

// ---- E2EE key management -------------------------------------------------------------
// The server stores only ciphertext key material. Losing the password AND the recovery key
// means the vault is unrecoverable - by design.
router.get("/e2ee/bundle", authMiddleware, async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(401).json({error: "Invalid user account credentials."});
  return res.status(200).json({success: true, e2ee: user.e2ee || null});
});
// Existing (pre-E2EE) account: prove knowledge of the old password once, then switch the
// account to the derived-secret login. The client re-encrypts existing documents afterwards.
router.post("/e2ee/upgrade", authLimiter, authMiddleware, validate(schemas.e2eeUpgrade), async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(401).json({error: "Invalid user account credentials."});
  if (user.e2ee) return res.status(409).json({error: "This account already uses end-to-end encryption."});
  if (!(await bcrypt.compare(req.body.currentPassword, user.passwordHash))) {
    return res.status(400).json({error: "Incorrect password."});
  }
  user.passwordHash = await hashSecret(req.body.newAuthSecret);
  user.e2ee = req.body.e2ee;
  await user.save({validateModifiedOnly: true});
  logSecurityEvent("e2ee_upgrade", {req: req, userId: user.customer_id, email: user.email});
  return res.status(200).json({success: true});
});
// Change password while logged in. The client re-wraps the SAME master key with the new KEK.
router.post("/e2ee/change-password", authLimiter, authMiddleware, validate(schemas.e2eeChangePassword), async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user || !user.e2ee) return res.status(400).json({error: "End-to-end encryption is not set up."});
  if (!(await bcrypt.compare(req.body.currentAuthSecret, user.passwordHash))) {
    return res.status(400).json({error: "Incorrect password."});
  }
  user.passwordHash = await hashSecret(req.body.newAuthSecret);
  user.e2ee = req.body.e2ee;
  user.tokenVersion = (user.tokenVersion || 0) + 1;
  await user.save({validateModifiedOnly: true});
  logSecurityEvent("password_changed", {req: req, userId: user.customer_id, email: user.email});
  return res.status(200).json({success: true});
});
router.post("/refresh", authLimiter, async (req, res) => {
  try {
    const viaCookie = isTrustedWebRequest(req);
    const cookie = viaCookie ? readRefreshCookie(req) : null;
    const presented = viaCookie ? cookie && cookie.token : req.body && req.body.refreshToken;
    if (typeof presented !== "string" || !presented) {
      return res.status(400).json({
        error: "Refresh token is required.",
        code: "REFRESH_MISSING"
      });
    }
    const result = await rotateRefreshToken(presented);
    if (!result.ok) {
      if (result.reason === "reuse") {
        logSecurityEvent("refresh_token_reuse", {
          req: req,
          userId: String(result.userId)
        });
      }
      if (viaCookie) clearRefreshCookie(res);
      return res.status(401).json({
        error: "Session expired. Please sign in again.",
        code: "REFRESH_INVALID"
      });
    }
    const user = await User.findById(result.userId);
    if (!user) {
      await revokeRefreshToken(result.refreshToken);
      if (viaCookie) clearRefreshCookie(res);
      return res.status(401).json({
        error: "Session expired. Please sign in again.",
        code: "REFRESH_INVALID"
      });
    }
    if (viaCookie) {
      setRefreshCookie(res, result.refreshToken, {
        persistent: cookie.persistent
      });
    }
    res.status(200).json({
      success: true,
      token: issueAccessToken(user),
      ...(viaCookie ? {refreshInCookie: true} : {refreshToken: result.refreshToken}),
      expiresIn: ACCESS_TOKEN_TTL
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.post("/logout", authLimiter, async (req, res) => {
  try {
    const viaCookie = isTrustedWebRequest(req);
    const cookie = viaCookie ? readRefreshCookie(req) : null;
    await revokeRefreshToken(cookie ? cookie.token : req.body && req.body.refreshToken);
    if (viaCookie) clearRefreshCookie(res);
    res.status(200).json({
      success: true
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.post("/set-pin", authMiddleware, validate(schemas.pinBody), async (req, res) => {
  try {
    const {password: password, pin: pin} = req.body;
    if (!password || !pin) {
      return res.status(400).json({
        error: "Password and pin are required."
      });
    }
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        error: "No account found for this session."
      });
    }
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(400).json({
        error: "Incorrect password."
      });
    }
    const hashedPin = await hashSecret(pin);
    user.pinHash = hashedPin;
    user.pinEnabled = true;
    user.failedPinAttempts = 0;
    user.pinLockedUntil = null;
    await user.save({
      validateModifiedOnly: true
    });
    logSecurityEvent("pin_set", {
      req: req,
      userId: user.customer_id,
      email: user.email
    });
    await createAlert({
      title: "2FA PIN Enabled",
      message: "A 2-factor authentication PIN was set up on your account.",
      type: "success",
      priority: "medium",
      sent_by: "System",
      sent_to: user.customer_id
    });
    res.status(200).json({
      success: true,
      message: "2FA PIN saved successfully.",
      pinEnabled: true
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.post("/verify-pin", authMiddleware, async (req, res) => {
  try {
    const {pin: pin} = req.body;
    if (!pin) {
      return res.status(400).json({
        error: "Pin is required."
      });
    }
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        error: "No account found for this session."
      });
    }
    if (!user.pinEnabled || !user.pinHash) {
      return res.status(200).json({
        success: true,
        valid: true
      });
    }
    const lockState = checkLocked(user, {
      lockedUntilField: "pinLockedUntil"
    });
    if (lockState.locked) {
      logSecurityEvent("pin_blocked", {
        req: req,
        userId: user.customer_id,
        email: user.email,
        meta: {
          retryAfterSeconds: lockState.retryAfterSeconds
        }
      });
      return res.status(429).json({
        success: false,
        valid: false,
        error: `Too many incorrect PIN attempts. Please try again in ${Math.ceil(lockState.retryAfterSeconds / 60)} minute(s).`
      });
    }
    const isMatch = await bcrypt.compare(pin, user.pinHash);
    if (!isMatch) {
      const failResult = recordFailure(user, {
        attemptsField: "failedPinAttempts",
        lockedUntilField: "pinLockedUntil",
        lockoutCountField: "pinLockoutCount"
      });
      await user.save({
        validateModifiedOnly: true
      });
      logSecurityEvent(failResult.justLocked ? "pin_lockout" : "pin_failure", {
        req: req,
        userId: user.customer_id,
        email: user.email,
        meta: failResult.justLocked ? {
          retryAfterSeconds: failResult.retryAfterSeconds
        } : {
          remainingAttempts: failResult.remainingAttempts
        }
      });
      if (failResult.justLocked) {
        await createAlert({
          title: "Account PIN Locked",
          message: "Your account PIN was temporarily locked after multiple failed attempts.",
          type: "error",
          priority: "high",
          sent_by: "System",
          sent_to: user.customer_id
        });
        return res.status(429).json({
          success: false,
          valid: false,
          error: `Too many incorrect PIN attempts. Please try again in ${Math.ceil(failResult.retryAfterSeconds / 60)} minute(s).`
        });
      }
      return res.status(200).json({
        success: false,
        valid: false,
        remainingAttempts: failResult.remainingAttempts
      });
    }
    recordSuccess(user, {
      attemptsField: "failedPinAttempts",
      lockedUntilField: "pinLockedUntil"
    });
    if (needsRehash(user.pinHash)) user.pinHash = await hashSecret(pin);
    await user.save({
      validateModifiedOnly: true
    });
    res.status(200).json({
      success: true,
      valid: true
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.post("/remove-pin", authMiddleware, async (req, res) => {
  try {
    const {password: password} = req.body;
    if (!password) {
      return res.status(400).json({
        error: "Password is required."
      });
    }
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        error: "No account found for this session."
      });
    }
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(400).json({
        error: "Incorrect password."
      });
    }
    user.pinHash = null;
    user.pinEnabled = false;
    user.failedPinAttempts = 0;
    user.pinLockedUntil = null;
    await user.save({
      validateModifiedOnly: true
    });
    logSecurityEvent("pin_removed", {
      req: req,
      userId: user.customer_id,
      email: user.email
    });
    await createAlert({
      title: "2FA PIN Removed",
      message: "The 2-factor authentication PIN was removed from your account. If this wasn't you, please secure your account immediately.",
      type: "warning",
      priority: "high",
      sent_by: "System",
      sent_to: user.customer_id
    });
    res.status(200).json({
      success: true,
      message: "2FA PIN removed successfully.",
      pinEnabled: false
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.get("/pin-status", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        error: "No account found for this session."
      });
    }
    res.status(200).json({
      success: true,
      pinEnabled: !!user.pinEnabled
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.get("/profile", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        error: "No account found for this session."
      });
    }
    let aadhaar = "";
    try {
      aadhaar = decryptAadhaar(user.aadhaarEncrypted);
    } catch (decryptErr) {
      console.error("[profile] Failed to decrypt Aadhaar for user", user._id, decryptErr.message);
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
        aadhaar: aadhaar,
        customer_id: user.customer_id,
        subscription_plan: user.subscription_plan
      }
    });
  } catch (err) {
    reportError(err, {where: "server_error", req: req});
    res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
module.exports = router;
