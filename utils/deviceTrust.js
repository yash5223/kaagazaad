const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const MAX_TRUSTED_DEVICES = 10;
const DEVICE_OTP_TTL_MS = 10 * 60 * 1e3;
const DEVICE_OTP_RESEND_COOLDOWN_MS = 45 * 1e3;
const CHALLENGE_TTL = "10m";
const sha256Hex = v => crypto.createHash("sha256").update(String(v)).digest("hex");
function newDeviceToken() {
  return crypto.randomBytes(32).toString("base64url");
}
function isPlausibleToken(t) {
  return typeof t === "string" && t.length >= 32 && t.length <= 128;
}
function isDeviceTrusted(user, token) {
  if (!isPlausibleToken(token)) return false;
  const h = sha256Hex(token);
  return (user.trustedDevices || []).some(d => d.tokenHash === h);
}
// trustedDevices is encrypted as a whole, so MongoDB cannot patch one element ($push/$slice or
// the positional operator). Read the current list, change it in memory, write it back.
async function touchDevice(user, token) {
  try {
    const fresh = await User.findById(user._id).select("trustedDevices");
    if (!fresh) return;
    const h = sha256Hex(token);
    const devices = (fresh.trustedDevices || []).map(d => d.tokenHash === h ? {...d, lastSeenAt: new Date} : d);
    await User.updateOne({_id: user._id}, {$set: {trustedDevices: devices}});
  } catch (_) {   }
}
async function trustDevice(user, {label: label = "", ip: ip = ""} = {}) {
  const token = newDeviceToken();
  const fresh = await User.findById(user._id).select("trustedDevices");
  const devices = [...(fresh && fresh.trustedDevices || []), {
    tokenHash: sha256Hex(token),
    label: String(label).slice(0, 80),
    ip: String(ip).slice(0, 64),
    addedAt: new Date,
    lastSeenAt: new Date
  }].slice(-MAX_TRUSTED_DEVICES);
  await User.updateOne({_id: user._id}, {$set: {trustedDevices: devices}});
  return token;
}
function challengeSecret() {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET must be set.");
  return crypto.createHmac("sha256", process.env.JWT_SECRET).update("device-challenge-v1").digest();
}
function signChallenge(user, {remember: remember = true} = {}) {
  return jwt.sign({uid: String(user._id), typ: "device_challenge", rm: !!remember}, challengeSecret(), {
    algorithm: "HS256",
    expiresIn: CHALLENGE_TTL
  });
}
function verifyChallenge(token) {
  const decoded = jwt.verify(String(token || ""), challengeSecret(), {algorithms: [ "HS256" ]});
  if (!decoded || decoded.typ !== "device_challenge" || !decoded.uid) throw new Error("bad challenge");
  return {userId: decoded.uid, remember: decoded.rm !== false};
}
function maskEmail(email) {
  const [name, domain] = String(email).split("@");
  if (!domain) return "your email";
  return `${name.slice(0, 2)}${"*".repeat(Math.max(1, name.length - 2))}@${domain}`;
}
module.exports = {
  DEVICE_OTP_TTL_MS: DEVICE_OTP_TTL_MS,
  DEVICE_OTP_RESEND_COOLDOWN_MS: DEVICE_OTP_RESEND_COOLDOWN_MS,
  isDeviceTrusted: isDeviceTrusted,
  touchDevice: touchDevice,
  trustDevice: trustDevice,
  signChallenge: signChallenge,
  verifyChallenge: verifyChallenge,
  maskEmail: maskEmail
};
