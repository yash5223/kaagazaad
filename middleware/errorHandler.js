/**
 * Central error handler — the single place allowed to decide what error
 * detail reaches a client. Routes should let errors reach here (throw
 * inside an asyncHandler-wrapped route, or call next(err)) instead of
 * hand-rolling `res.status(500).json({ error: err.message })`, which leaks
 * internal detail — stack traces, driver error strings, file paths,
 * dependency versions — to whoever is calling the API.
 *
 * Must be registered LAST, after all routes, in server.js.
 */
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  console.error(`[error] ${req.method} ${req.originalUrl}:`, err);

  // Forward to Sentry (or whatever monitoring is configured) if enabled —
  // see server.js for the conditional init. No-op if SENTRY_DSN isn't set.
  if (process.env.SENTRY_DSN) {
    try {
      require('@sentry/node').captureException(err);
    } catch {
      // Monitoring must never be able to break the actual error response.
    }
  }

  // A handful of well-known error shapes get a specific-but-still-safe
  // message; everything else collapses to one generic message so no
  // internal detail ever leaks.
  if (err && err.name === 'ValidationError') {
    // Mongoose schema validation error
    return res.status(400).json({ error: 'The submitted data failed validation.' });
  }
  if (err && err.name === 'CastError') {
    // Mongoose failed to cast a param (e.g. malformed ObjectId that slipped past our own checks)
    return res.status(400).json({ error: 'One of the submitted values is not valid.' });
  }
  if (err && err.code === 11000) {
    // Mongo duplicate key
    return res.status(409).json({ error: 'A record with these details already exists.' });
  }
  if (err && err.name === 'MulterError') {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'That file is too large.'
      : 'File upload failed.';
    return res.status(400).json({ error: message });
  }
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'This origin is not permitted to access the API.' });
  }

  return res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
}

/**
 * Wraps an async route handler so a rejected promise is forwarded to
 * next(err) — and therefore to errorHandler above — instead of crashing
 * the process or leaving the request hanging.
 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { errorHandler, asyncHandler };
