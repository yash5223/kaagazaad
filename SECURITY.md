# Security architecture

This document lists the layers standing between the Flutter client and the
API, in the order a request actually passes through them. It exists so
"why is this here" isn't only answered by a code comment someone might
delete along with the code.

No single layer here is meant to be unbreakable on its own — the point of
listing them together is that they overlap. A gap in one is expected to be
caught by another.

## 1. Transport

- **HTTPS only.** The client's `rootUrl` is hardcoded to an `https://`
  origin (`lib/core/core.dart`); there is no HTTP fallback.
- **Certificate pinning** (client-side, mobile/desktop only — see
  `lib/core/core.dart` → `_pinnedClient`). The app validates the server's
  certificate against a pinned SHA-256 public-key fingerprint in addition
  to normal OS certificate-chain validation, so a network-level MITM
  (rogue CA, compromised Wi-Fi, corporate proxy with a trusted root
  installed) can't silently intercept traffic even if it can present a
  chain the OS itself would accept. Pins must be rotated before the
  server's certificate is; see the comment above `_certPins` for how to
  regenerate them and always ship **two** valid pins (current + next) so a
  routine cert renewal doesn't lock out shipped app versions.

## 2. Edge / HTTP hygiene (`server.js`)

- `helmet()` — standard security headers (HSTS, X-Content-Type-Options,
  X-Frame-Options, etc.) plus a real **Content-Security-Policy** (default
  `'self'`, no framing, no inline scripts except the one explicitly
  nonced on `/join/:token`).
- **CORS allowlist** — browser origins are restricted to
  `ALLOWED_ORIGINS`; requests without an `Origin` header (native app,
  server-to-server) are allowed through since CORS doesn't apply to them
  in the first place.
- **`express-mongo-sanitize`** — strips `$`-prefixed / dotted keys from
  `body`/`query`/`params` before anything downstream sees them. Backstop
  against NoSQL injection; the primary defense is the zod schemas below.
- **`hpp`** — collapses duplicate query-string keys so a route can't be
  handed an unexpected array where it expects a single value.
- **Body size caps** — 1MB on JSON/urlencoded bodies (file uploads have
  their own multer-level limits, see below).

## 3. Rate limiting & throttling (`middleware/rateLimiters.js`)

Two different shapes of friction, stacked:

- **Hard limits** (`express-rate-limit`) — a wall. `globalLimiter` on
  every request; tighter `authLimiter` / `otpRequestLimiter` /
  `otpVerifyLimiter` on auth-adjacent routes. Once hit, requests 429 until
  the window resets.
- **Progressive slow-down** (`express-slow-down`, `loginSlowDown`) — a
  ramp, layered in front of the hard limiters on login/OTP-request routes.
  Each request past the first few gets progressively slower (capped at
  8s), so a scripted brute-force loop bleeds time well before it ever
  reaches the hard wall, while a real user mistyping a password once or
  twice barely notices.
- **Account lockout** (`utils/accountLockout.js`) — per-account, not
  per-IP: after 5 consecutive failures, the account itself locks with an
  exponentially growing backoff (1m → 2m → 4m → ... capped at 30m),
  independent of which IP the attempts came from.

## 4. App-level request signing (`middleware/requestSignature.js`)

Every `/api/*` request must carry `X-Timestamp`, `X-Nonce`, and
`X-Signature` headers. The signature is an HMAC-SHA256 over
`METHOD\nPATH\nTIMESTAMP\nNONCE\nRAW_BODY`, keyed by a secret
(`APP_SIGNING_SECRET`) shared between server and client build.

This is a **separate layer from the user's JWT** (below) and answers a
different question:

| Layer | Answers |
|---|---|
| JWT (`authMiddleware.js`) | "Is this a valid, unexpired session for some user?" |
| Request signature | "Was this exact request built by our client, right now, and not replayed?" |

A captured JWT can be replayed from any HTTP client indefinitely until it
expires. Signing narrows that: a captured request is only replayable
within a 5-minute window, and the nonce is burned on first use — so it's
not replayable at all, once.

**Threat model honesty:** `APP_SIGNING_SECRET` ships inside the client
build. A sufficiently motivated attacker who decompiles the mobile app or
inspects the web bundle can recover it. This layer is defense-in-depth
against casual scripted abuse and replay of captured traffic — it is not,
and cannot be, a secret the client can truly keep. Do not rely on it as
the sole authorization check for anything; every route must still enforce
its own authorization independent of this header.

If `APP_SIGNING_SECRET` is unset, this layer no-ops (fails open) rather
than blocking traffic — useful for rolling out to environments where the
client hasn't been updated to sign requests yet. Set the env var only once
every client in the field sends signed requests.

## 5. Authentication & authorization

- **JWT bearer auth** (`middleware/authMiddleware.js`) — required on every
  route that reads/writes user data. Verified server-side against
  `JWT_SECRET`; payload shape is checked, not just signature validity.
- **Session token storage on the client** — the JWT is the *only*
  credential persisted client-side, and only in the OS-backed secure
  store (Keychain / Android Keystore-backed EncryptedSharedPreferences via
  `flutter_secure_storage`) on mobile/desktop. The account password is
  never cached.
- **Secondary PIN unlock** (`set-pin` / `verify-pin` routes) — an
  additional local-unlock factor on top of the session token, with its
  own lockout counter.

## 6. Input validation (`middleware/validators.js`)

Every route body/param/query that isn't trivially safe is run through a
`zod` schema before a handler ever sees it — bounded lengths, restricted
charsets, `ObjectId` shape checks, etc. This is what stops, for example, a
client from sending a Mongo query operator object (`{"$ne": null}`) as a
`token` value and having it evaluated as part of a `findOne({ token })`
query.

## 7. File upload validation

Two independent checks, not one:

- `middleware/upload.js` — multer, memory storage only (never written to
  disk under a client-controlled name), extension allowlist, 10MB cap.
- `middleware/fileTypeGuard.js` — **sniffs the actual file bytes**
  (magic-number detection) and rejects anything where the real content
  doesn't match the claimed extension/mimetype. This is what stops
  `payload.exe` renamed to `invoice.pdf` from passing a
  header-only check.

## 8. Data protection at rest

- **Passwords** — bcrypt-hashed, never stored or logged in plaintext.
- **Aadhaar numbers** — AES-256-GCM encrypted (`utils/aadhaarCrypto.js`);
  a separate one-way hash (`aadhaarHash`) is stored only for uniqueness
  enforcement/lookups, since the encrypted value itself isn't queryable.
  Both encrypted and hashed fields are stripped from every JSON
  serialization (`models/User.js` `toJSON`), so they never round-trip
  back to a client even by accident.
- **File storage** — uploaded documents live in Cloudinary, not on the
  app server's filesystem, keyed by credentials in `CLOUDINARY_API_SECRET`
  (never exposed to the client).

## 9. Error handling (`middleware/errorHandler.js`)

Single, centralized error handler. Internal detail (stack traces, driver
error strings, file paths, dependency versions) never reaches a client
response — a fixed set of well-known error shapes get a specific-but-safe
message; everything else collapses to one generic message.

## 10. Auditing & monitoring

- **`utils/securityLog.js`** — structured security events (login
  success/failure, lockouts, PIN failures, document deletions, etc.)
  logged to stdout and persisted to the `SecurityEvent` collection for a
  queryable audit trail.
- **Sentry** (optional, `SENTRY_DSN`) — error/exception reporting, wired
  in as early as possible in `server.js` so it captures request context.
  A complete no-op when unset.
- **`/healthz`** — reports process + DB connectivity for uptime
  monitoring, distinct from `/` which is just a liveness ping.

## Required environment variables for the layers above

| Variable | Layer | Required? |
|---|---|---|
| `JWT_SECRET` | Auth (§5) | Yes — server refuses `authMiddleware` calls without it |
| `MONGODB_URI` | — | Yes — server refuses to boot without it |
| `ALLOWED_ORIGINS` | CORS (§2) | Recommended for any web client |
| `APP_SIGNING_SECRET` | Request signing (§4) | Recommended; fails open if unset |
| `CLOUDINARY_*` | File storage (§8) | Yes, for uploads to work |
| `SENTRY_DSN` | Monitoring (§10) | Optional |

## Deliberately out of scope here

- **CSRF tokens** — not applicable; this API is Bearer-token authenticated
  (not cookie/session based), so there's no ambient credential a
  cross-site request could ride on. The one HTML page the server renders
  (`/join/:token`) performs no state-changing action itself.
- **mTLS** — not currently implemented; would require distributing and
  rotating client certificates to every mobile install, which is a much
  heavier operational cost than the app-signing layer above for a
  comparable amount of added assurance at this app's threat level.
