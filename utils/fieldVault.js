// Low-level crypto for whole-database field encryption.
//   * AES-256-GCM, random 96-bit IV per value.
//   * The "scope" (collection.field) is bound as AAD, so a ciphertext copied into a
//     different field/collection fails authentication instead of decrypting.
//   * Any JSON-able value (string, number, boolean, Date, array, object) round-trips
//     with its type intact.
//   * Blind indexes are HMAC-SHA256 (separate derived key) for equality lookups.
// Legacy "enc:v1:" values (old assetFieldEncryption) are still readable.
const crypto = require("crypto");
const legacy = require("./fieldCrypto");

const PREFIX = "enc:v2:";
const LEGACY_PREFIX = "enc:v1:";

let cached = null;
function keys() {
  if (cached) return cached;
  const hex = process.env.FIELD_ENCRYPTION_KEY || process.env.AADHAAR_ENCRYPTION_KEY;
  if (!hex) throw new Error("Set FIELD_ENCRYPTION_KEY (64 hex chars) to encrypt database fields.");
  const master = Buffer.from(hex, "hex");
  if (master.length !== 32) throw new Error("FIELD_ENCRYPTION_KEY must be 64 hex characters (32 bytes).");
  const derive = info => Buffer.from(crypto.hkdfSync("sha256", master, Buffer.alloc(0), info, 32));
  cached = { enc: derive("kaagazaad/db-fields/enc/v2"), idx: derive("kaagazaad/db-fields/blind-index/v2") };
  return cached;
}

function isEncrypted(v) {
  return typeof v === "string" && (v.startsWith(PREFIX) || v.startsWith(LEGACY_PREFIX));
}
function isCurrent(v) {
  return typeof v === "string" && v.startsWith(PREFIX);
}

function serialize(value) {
  return JSON.stringify(value, function (k, v) {
    const raw = this[k];
    if (raw instanceof Date) return { $d: isNaN(raw.getTime()) ? null : raw.toISOString() };
    return v;
  });
}
function revive(text) {
  return JSON.parse(text, (k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && "$d" in v) {
      return v.$d === null ? new Date(NaN) : new Date(v.$d);
    }
    return v;
  });
}

function encryptValue(scope, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keys().enc, iv);
  cipher.setAAD(Buffer.from(scope, "utf8"));
  const data = Buffer.concat([cipher.update(serialize(value), "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${data.toString("hex")}`;
}

function decryptValue(scope, stored) {
  if (!isEncrypted(stored)) return stored;
  if (!isCurrent(stored)) return legacy.decryptField(stored); // v1: plain string, no AAD
  const [ivHex, tagHex, dataHex] = stored.slice(PREFIX.length).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keys().enc, Buffer.from(ivHex, "hex"));
  decipher.setAAD(Buffer.from(scope, "utf8"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const text = Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
  return revive(text);
}

function blindIndex(scope, normalized) {
  return crypto.createHmac("sha256", keys().idx).update(`${scope}\u0000${normalized}`).digest("hex");
}

module.exports = { PREFIX, isEncrypted, isCurrent, encryptValue, decryptValue, blindIndex };
