const crypto = require('crypto');

// AES-256-GCM encryption for Aadhaar numbers at rest.
//
// Why not just hash it? We need to show the real number back to the
// account owner on their own profile screen, so this has to be reversible
// — a hash alone won't do. AES-GCM gives us confidentiality (nobody can
// read the number from a DB dump without the key) *and* integrity (any
// tampering with the ciphertext is detected on decrypt, since GCM includes
// an auth tag).
//
// Why also store a separate hash? AES-GCM uses a random IV per encryption,
// so encrypting the same Aadhaar number twice produces different ciphertext
// every time. That's exactly what you want for confidentiality, but it means
// you can't query MongoDB for "does this ciphertext already exist" to
// enforce uniqueness or to look a user up by Aadhaar. So alongside the
// encrypted value we store a deterministic HMAC-SHA256 of the raw number
// (keyed with its own secret, separate from the encryption key). That hash
// is unique-indexed and is what registration/lookup queries actually use;
// the encrypted field is only ever decrypted for display to the verified
// owner.

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV is the GCM-recommended size

function getEncryptionKey() {
  const keyHex = process.env.AADHAAR_ENCRYPTION_KEY;
  if (!keyHex) {
    throw new Error(
      'AADHAAR_ENCRYPTION_KEY is not set. Generate one with: ' +
      "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" " +
      'and set it in your environment.'
    );
  }
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error('AADHAAR_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).');
  }
  return key;
}

function getHashSecret() {
  const secret = process.env.AADHAAR_HASH_SECRET;
  if (!secret) {
    throw new Error(
      'AADHAAR_HASH_SECRET is not set. Generate one with: ' +
      "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" " +
      'and set it in your environment.'
    );
  }
  return secret;
}

/**
 * Encrypts a plaintext Aadhaar number. Returns a single string in the form
 * "iv:authTag:ciphertext" (all hex-encoded) that's safe to store in Mongo.
 */
function encryptAadhaar(plainAadhaar) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainAadhaar), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a value previously produced by encryptAadhaar(). Throws if the
 * ciphertext or auth tag has been tampered with.
 */
function decryptAadhaar(encryptedValue) {
  const key = getEncryptionKey();
  const parts = String(encryptedValue).split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted Aadhaar value.');
  }
  const [ivHex, authTagHex, dataHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(dataHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Deterministic HMAC-SHA256 of the raw Aadhaar number, used for uniqueness
 * checks and lookups. Never store the raw number alongside this — the hash
 * itself doesn't need extra protection since it's one-way, but it does let
 * anyone who has it confirm a guess against the DB, so treat it like any
 * other sensitive index (not exposed in API responses).
 */
function hashAadhaar(plainAadhaar) {
  const secret = getHashSecret();
  return crypto.createHmac('sha256', secret).update(String(plainAadhaar).trim()).digest('hex');
}

/**
 * Masks an Aadhaar number for contexts where the full number shouldn't be
 * shown (e.g. logs, non-owner views). Shows only the last 4 digits.
 */
function maskAadhaar(plainAadhaar) {
  const str = String(plainAadhaar).trim();
  if (str.length < 4) return '••••';
  return `•••• •••• ${str.slice(-4)}`;
}

module.exports = { encryptAadhaar, decryptAadhaar, hashAadhaar, maskAadhaar };
