const MAX_ATTEMPTS = 5;
const BASE_LOCKOUT_MS = 60 * 1000; 
const MAX_LOCKOUT_MS = 30 * 60 * 1000; 
function computeLockoutMs(priorLockoutCount) {
  const ms = BASE_LOCKOUT_MS * Math.pow(2, Math.max(0, priorLockoutCount));
  return Math.min(ms, MAX_LOCKOUT_MS);
}
function checkLocked(user, { lockedUntilField }) {
  const lockedUntil = user[lockedUntilField];
  if (lockedUntil && lockedUntil > new Date()) {
    const retryAfterSeconds = Math.ceil((lockedUntil.getTime() - Date.now()) / 1000);
    return { locked: true, retryAfterSeconds };
  }
  return { locked: false };
}
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
