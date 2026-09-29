let Sentry = null;
function scrub(event) {
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;
    if (event.request.headers) {
      for (const h of ["authorization", "cookie", "x-signature", "x-nonce", "x-timestamp"]) delete event.request.headers[h];
    }
  }
  delete event.user;
  return event;
}
function initMonitoring() {
  if (!process.env.SENTRY_DSN) {
    console.warn("[monitoring] SENTRY_DSN not set - error reporting to Sentry is disabled. See SECURITY.md.");
    return null;
  }
  Sentry = require("@sentry/node");
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "production",
    release: process.env.RENDER_GIT_COMMIT || process.env.SENTRY_RELEASE || undefined,
    sendDefaultPii: false,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
    beforeSend: scrub
  });
  console.log("[monitoring] Sentry error reporting enabled");
  return Sentry;
}
function isEnabled() {
  return !!Sentry;
}
function reportError(err, {where: where = "unknown", req: req} = {}) {
  console.error(`[${where}]`, err);
  if (!Sentry) return;
  try {
    Sentry.withScope(scope => {
      scope.setTag("where", where);
      if (req) {
        scope.setTag("route", String(req.originalUrl || "").split("?")[0]);
        scope.setTag("method", req.method);
      }
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
    });
  } catch (_) {   }
}
function captureSecurityMessage(message, {level: level = "warning", tags: tags = {}} = {}) {
  if (!Sentry) return;
  try {
    Sentry.withScope(scope => {
      scope.setLevel(level);
      for (const [k, v] of Object.entries(tags)) scope.setTag(k, String(v));
      Sentry.captureMessage(message);
    });
  } catch (_) {}
}
module.exports = {
  initMonitoring: initMonitoring,
  isEnabled: isEnabled,
  reportError: reportError,
  captureSecurityMessage: captureSecurityMessage
};
