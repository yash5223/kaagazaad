const COOKIE_NAME = "__Secure-kz_rt";
const COOKIE_PATH = "/api/users";
const TTL_MS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 30) * 24 * 60 * 60 * 1e3;
function allowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || "").split(",").map(o => o.trim()).filter(Boolean);
}
function sameSite() {
  const v = (process.env.WEB_COOKIE_SAMESITE || "none").toLowerCase();
  return ["none", "lax", "strict"].includes(v) ? v : "none";
}
function isWebClient(req) {
  return String(req.headers["x-client-platform"] || "").toLowerCase() === "web";
}
function isTrustedWebRequest(req) {
  const origin = req.headers.origin;
  return isWebClient(req) && !!origin && allowedOrigins().includes(origin);
}
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch (_) {
        return null;
      }
    }
  }
  return null;
}
function setRefreshCookie(res, token, {persistent: persistent = true} = {}) {
  const opts = {
    httpOnly: true,
    secure: true,
    sameSite: sameSite(),
    path: COOKIE_PATH
  };
  if (persistent) opts.maxAge = TTL_MS;
  res.cookie(COOKIE_NAME, `${persistent ? "p" : "s"}.${token}`, opts);
}
function clearRefreshCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: sameSite(),
    path: COOKIE_PATH
  });
}
function readRefreshCookie(req) {
  const raw = readCookie(req, COOKIE_NAME);
  if (!raw) return null;
  const i = raw.indexOf(".");
  if (i !== 1) return null;
  const flag = raw[0];
  if (flag !== "p" && flag !== "s") return null;
  const token = raw.slice(2);
  return token ? {token: token, persistent: flag === "p"} : null;
}
const DEVICE_COOKIE_NAME = "__Secure-kz_dev";
const DEVICE_TTL_MS = 180 * 24 * 60 * 60 * 1e3;
function setDeviceCookie(res, token) {
  res.cookie(DEVICE_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: sameSite(),
    path: COOKIE_PATH,
    maxAge: DEVICE_TTL_MS
  });
}
function readDeviceCookie(req) {
  return readCookie(req, DEVICE_COOKIE_NAME);
}
module.exports = {
  setDeviceCookie: setDeviceCookie,
  readDeviceCookie: readDeviceCookie,
  COOKIE_NAME: COOKIE_NAME,
  isWebClient: isWebClient,
  isTrustedWebRequest: isTrustedWebRequest,
  setRefreshCookie: setRefreshCookie,
  clearRefreshCookie: clearRefreshCookie,
  readRefreshCookie: readRefreshCookie
};
