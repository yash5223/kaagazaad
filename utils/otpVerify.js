const Otp = require("../models/Otp");
const { otpMatches } = require("./tokens");
const OTP_MAX_ATTEMPTS = 5;
const fail = (status, error) => ({ ok: false, status, error });
async function verifyOtpWithAttemptLimit({ contactInfo, otpCode, purpose }) {
  const now = new Date;
  const doc = await Otp.findOneAndUpdate(
    { contactInfo, purpose, attempts: { $lt: OTP_MAX_ATTEMPTS }, expiresAt: { $gt: now } },
    { $inc: { attempts: 1 } },
    { new: true }
  );
  if (!doc) {
    const existing = await Otp.findOne({ contactInfo, purpose });
    if (!existing) return fail(400, "Invalid or expired verification code.");
    await Otp.deleteOne({ _id: existing._id });
    if (existing.expiresAt <= now) {
      return fail(400, "This code has expired. Please request a new one.");
    }
    return fail(429, "Too many incorrect attempts. Please request a new code.");
  }
  if (otpMatches(doc.otpCode, otpCode, contactInfo, purpose)) {
    await Otp.updateOne({ _id: doc._id }, { $inc: { attempts: -1 } });
    return { ok: true, doc };
  }
  const remaining = OTP_MAX_ATTEMPTS - doc.attempts;
  if (remaining <= 0) {
    await Otp.deleteOne({ _id: doc._id });
    return fail(429, "Too many incorrect attempts. Please request a new code.");
  }
  return fail(400, `Invalid verification code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`);
}
module.exports = { verifyOtpWithAttemptLimit, OTP_MAX_ATTEMPTS };
