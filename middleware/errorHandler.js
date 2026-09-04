function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  if (process.env.SENTRY_DSN) {
    try {
      require("@sentry/node").captureException(err);
    } catch {}
  }
  if (err && err.name === "ValidationError") {
    return res.status(400).json({
      error: "The submitted data failed validation."
    });
  }
  if (err && err.name === "CastError") {
    return res.status(400).json({
      error: "One of the submitted values is not valid."
    });
  }
  if (err && err.code === 11e3) {
    return res.status(409).json({
      error: "A record with these details already exists."
    });
  }
  if (err && err.name === "MulterError") {
    const message = err.code === "LIMIT_FILE_SIZE" ? "That file is too large." : "File upload failed.";
    return res.status(400).json({
      error: message
    });
  }
  if (err && err.message === "Not allowed by CORS") {
    return res.status(403).json({
      error: "This origin is not permitted to access the API."
    });
  }
  return res.status(500).json({
    error: "Something went wrong on our end. Please try again shortly."
  });
}
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
module.exports = {
  errorHandler: errorHandler,
  asyncHandler: asyncHandler
};