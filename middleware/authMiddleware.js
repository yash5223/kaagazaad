const jwt = require("jsonwebtoken");
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) {
    return res.status(401).json({
      error: "Authorization token is required."
    });
  }
  const token = parts[1];
  if (!process.env.JWT_SECRET) {
    return res.status(500).json({
      error: "Server auth configuration missing."
    });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded || !decoded.customer_id || !decoded.email) {
      return res.status(401).json({
        error: "Invalid token payload."
      });
    }
    req.user = {
      id: decoded.id,
      customer_id: decoded.customer_id,
      email: decoded.email
    };
    return next();
  } catch (err) {
    return res.status(401).json({
      error: "Invalid or expired token."
    });
  }
}
module.exports = authMiddleware;