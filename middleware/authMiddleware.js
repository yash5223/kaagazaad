const User = require("../models/User");
const { verifyAccessToken } = require("../utils/tokens");
const { authenticatedUserLimiter } = require("./rateLimiters");
function deny(res, code, error) {
  return res.status(401).json({ error, code });
}
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) {
    return deny(res, "TOKEN_MISSING", "Authorization token is required.");
  }
  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ error: "Server auth configuration missing." });
  }
  let decoded;
  try {
    decoded = verifyAccessToken(parts[1]);
  } catch (err) {
    if (err && err.name === "TokenExpiredError") {
      return deny(res, "TOKEN_EXPIRED", "Session expired.");
    }
    return deny(res, "TOKEN_INVALID", "Invalid or expired token.");
  }
  if (!decoded || !decoded.id || !decoded.customer_id || !decoded.email) {
    return deny(res, "TOKEN_INVALID", "Invalid token payload.");
  }
  try {
    const user = await User.findById(decoded.id).select("tokenVersion customer_id email").lean();
    if (!user || user.customer_id !== decoded.customer_id) {
      return deny(res, "TOKEN_INVALID", "Invalid token.");
    }
    if ((user.tokenVersion || 0) !== (decoded.tv || 0)) {
      return deny(res, "TOKEN_REVOKED", "Session is no longer valid. Please sign in again.");
    }
  } catch (err) {
    console.error("[auth] token version lookup failed:", err.message);
    return res.status(500).json({ error: "Something went wrong on our end. Please try again shortly." });
  }
  req.user = {
    id: decoded.id,
    customer_id: decoded.customer_id,
    email: decoded.email
  };
  return authenticatedUserLimiter(req, res, next);
}
module.exports = authMiddleware;
