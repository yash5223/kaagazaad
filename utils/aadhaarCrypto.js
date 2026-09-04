const crypto = require("crypto");
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
function getEncryptionKey() {
  const keyHex = process.env.AADHAAR_ENCRYPTION_KEY;
  if (!keyHex) {
    throw new Error("AADHAAR_ENCRYPTION_KEY is not set. Generate one with: " + "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" " + "and set it in your environment.");
  }
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) {
    throw new Error("AADHAAR_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).");
  }
  return key;
}
function getHashSecret() {
  const secret = process.env.AADHAAR_HASH_SECRET;
  if (!secret) {
    throw new Error("AADHAAR_HASH_SECRET is not set. Generate one with: " + "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" " + "and set it in your environment.");
  }
  return secret;
}
function encryptAadhaar(plainAadhaar) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([ cipher.update(String(plainAadhaar), "utf8"), cipher.final() ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}
function decryptAadhaar(encryptedValue) {
  const key = getEncryptionKey();
  const parts = String(encryptedValue).split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted Aadhaar value.");
  }
  const [ivHex, authTagHex, dataHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const encrypted = Buffer.from(dataHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([ decipher.update(encrypted), decipher.final() ]);
  return decrypted.toString("utf8");
}
function hashAadhaar(plainAadhaar) {
  const secret = getHashSecret();
  return crypto.createHmac("sha256", secret).update(String(plainAadhaar).trim()).digest("hex");
}
function maskAadhaar(plainAadhaar) {
  const str = String(plainAadhaar).trim();
  if (str.length < 4) return "••••";
  return `•••• •••• ${str.slice(-4)}`;
}
module.exports = {
  encryptAadhaar: encryptAadhaar,
  decryptAadhaar: decryptAadhaar,
  hashAadhaar: hashAadhaar,
  maskAadhaar: maskAadhaar
};