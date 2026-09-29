const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const RefreshToken = require("../models/RefreshToken");
const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_EXPIRES_IN || "15m";
const REFRESH_TOKEN_TTL_MS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30) * 24 * 60 * 60 * 1e3;
const REFRESH_FAMILY_MAX_MS = Number(process.env.REFRESH_FAMILY_MAX_DAYS || 90) * 24 * 60 * 60 * 1e3;
const JWT_ALGORITHM = "HS256";
function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
function issueAccessToken(user) {
  return jwt.sign({
    id: user._id,
    customer_id: user.customer_id,
    email: user.email,
    tv: user.tokenVersion || 0
  }, process.env.JWT_SECRET, {
    algorithm: JWT_ALGORITHM,
    expiresIn: ACCESS_TOKEN_TTL
  });
}
function verifyAccessToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET, { algorithms: [ JWT_ALGORITHM ] });
}
function newOpaqueToken() {
  return crypto.randomBytes(32).toString("base64url");
}
async function createRefreshToken(userId, { family, familyExpiresAt } = {}) {
  const now = Date.now();
  const famExpires = familyExpiresAt || new Date(now + REFRESH_FAMILY_MAX_MS);
  const expiresAt = new Date(Math.min(now + REFRESH_TOKEN_TTL_MS, famExpires.getTime()));
  const token = newOpaqueToken();
  await RefreshToken.create({
    userId,
    family: family || crypto.randomUUID(),
    tokenHash: sha256Hex(token),
    expiresAt,
    familyExpiresAt: famExpires
  });
  return token;
}
async function rotateRefreshToken(presented) {
  if (typeof presented !== "string" || presented.length < 20 || presented.length > 200) {
    return { ok: false, reason: "invalid" };
  }
  const tokenHash = sha256Hex(presented);
  const claimed = await RefreshToken.findOneAndUpdate(
    { tokenHash, usedAt: null, expiresAt: { $gt: new Date } },
    { $set: { usedAt: new Date } },
    { new: false }
  );
  if (!claimed) {
    const existing = await RefreshToken.findOne({ tokenHash });
    if (!existing) return { ok: false, reason: "invalid" };
    if (existing.usedAt) {
      await RefreshToken.deleteMany({ family: existing.family });
      return { ok: false, reason: "reuse", userId: existing.userId };
    }
    return { ok: false, reason: "expired" };
  }
  const refreshToken = await createRefreshToken(claimed.userId, {
    family: claimed.family,
    familyExpiresAt: claimed.familyExpiresAt
  });
  return { ok: true, userId: claimed.userId, refreshToken };
}
async function revokeRefreshToken(presented) {
  if (typeof presented !== "string" || !presented) return;
  const row = await RefreshToken.findOne({ tokenHash: sha256Hex(presented) });
  if (row) await RefreshToken.deleteMany({ family: row.family });
}
async function revokeAllRefreshTokens(userIds) {
  const ids = Array.isArray(userIds) ? userIds : [ userIds ];
  await RefreshToken.deleteMany({ userId: { $in: ids } });
}
function otpSecret() {
  const s = process.env.OTP_HASH_SECRET || process.env.JWT_SECRET;
  if (!s) throw new Error("OTP_HASH_SECRET (or JWT_SECRET) must be set.");
  return s;
}
function generateOtpCode() {
  return String(crypto.randomInt(100000, 1000000));
}
function hashOtp(code, contactInfo, purpose) {
  return crypto
    .createHmac("sha256", otpSecret())
    .update(`${purpose}\n${contactInfo}\n${String(code)}`)
    .digest("hex");
}
function otpMatches(storedHash, code, contactInfo, purpose) {
  const expected = Buffer.from(String(storedHash || ""), "utf8");
  const actual = Buffer.from(hashOtp(code, contactInfo, purpose), "utf8");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}
module.exports = {
  ACCESS_TOKEN_TTL,
  issueAccessToken,
  verifyAccessToken,
  createRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
  generateOtpCode,
  hashOtp,
  otpMatches
};
