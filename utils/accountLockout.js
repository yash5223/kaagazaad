// Generic brute-force lockout helper, shared by password login and PIN
// verification (see routes/userRoutes.js). Both follow the same shape:
// track consecutive failures on the user document itself, and once a
// threshold is hit, lock further attempts out for a backoff window that
// grows with each additional lockout — so a script that keeps retrying
// gets slower, not faster, the longer it persists.

const MAX_ATTEMPTS = 5;
const BASE_LOCKOUT_MS = 60 * 1000; // 1 minute after the first lockout
const MAX_LOCKOUT_MS = 30 * 60 * 1000; // capped at 30 minutes

/**
 * Computes how long a fresh lockout should last, given how many times this
 * counter has already tripped into lockout territory. Doubles each time
 * (1m, 2m, 4m, 8m, ...) up to the cap, rather than a single fixed window,
 * so a persistent attacker faces a steadily worse cost/attempt ratio
 * instead of one static 5-minute wall they can just wait out on a loop.
 */
function computeLockoutMs(priorLockoutCount) {
  const ms = BASE_LOCKOUT_MS * Math.pow(2, Math.max(0, priorLockoutCount));
  return Math.min(ms, MAX_LOCKOUT_MS);
}

/**
 * Checks whether `[attemptsField]`/`[lockedUntilField]` on `user` currently
 * represent an active lockout. Returns { locked: false } if the user is
 * free to attempt, or { locked: true, retryAfterSeconds } if not.
 */
function checkLocked(user, { lockedUntilField }) {
  const lockedUntil = user[lockedUntilField];
  if (lockedUntil && lockedUntil > new Date()) {
    const retryAfterSeconds = Math.ceil((lockedUntil.getTime() - Date.now()) / 1000);
    return { locked: true, retryAfterSeconds };
  }
  return { locked: false };
}

/**
 * Records one failed attempt. Once `attempts` reaches MAX_ATTEMPTS, sets a
 * lockout window (with growing backoff — see computeLockoutMs) and resets
 * the attempt counter for the next window. Caller is responsible for
 * calling `user.save()` afterward.
 */
function recordFailure(user, { attemptsField, lockedUntilField, lockoutCountField }) {
  user[attemptsField] = (user[attemptsField] || 0) + 1;
  if (user[attemptsField] >= MAX_ATTEMPTS) {
    const priorLockoutCount = user[lockoutCountField] || 0;
    const lockoutMs = computeLockoutMs(priorLockoutCount);
    user[lockedUntilField] = new Date(Date.now() + lockoutMs);
    user[lockoutCountField] = priorLockoutCount + 1;
    user[attemptsField] = 0;
    return { justLocked: true, retryAfterSeconds: Math.ceil(lockoutMs / 1000) };
  }
  return { justLocked: false, remainingAttempts: MAX_ATTEMPTS - user[attemptsField] };
}

/**
 * Clears the failure/lockout state on a successful attempt. Deliberately
 * does NOT reset `lockoutCountField` — that's the backoff-growth memory,
 * and clearing it on every success would let an attacker who succeeds
 * once (e.g. because they're also the legitimate user, mid-attack) reset
 * the escalating cost back to the minimum.
 */
function recordSuccess(user, { attemptsField, lockedUntilField }) {
  user[attemptsField] = 0;
  user[lockedUntilField] = null;
}

module.exports = {
  MAX_ATTEMPTS,
  checkLocked,
  recordFailure,
  recordSuccess,
};
