const bcrypt = require("bcryptjs");
const BCRYPT_ROUNDS = Math.min(14, Math.max(12, Number(process.env.BCRYPT_ROUNDS) || 12));
function hashSecret(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}
function needsRehash(hash) {
  try {
    return !!hash && bcrypt.getRounds(hash) < BCRYPT_ROUNDS;
  } catch (_) {
    return false;
  }
}
module.exports = {
  BCRYPT_ROUNDS: BCRYPT_ROUNDS,
  hashSecret: hashSecret,
  needsRehash: needsRehash
};
