const crypto = require("crypto");
const PREFIX = "enc:v1:";
const SENSITIVE_KEY_RE = new RegExp("^(" + [
  "documentNumber",
  "pan\\w*", "passport\\w*", "aadhaar\\w*", "aadhar\\w*", "vid",
  "drivingLicen[cs]e\\w*", "licen[cs]e\\w*number", "epic\\w*", "voter\\w*",
  "rationCard\\w*", "\\w*account\\w*", "\\w*policy\\w*number", "folio\\w*",
  "\\w*deposit\\w*", "\\w*loan\\w*number", "\\w*card\\w*number", "ifsc\\w*",
  "gstin\\w*", "upi\\w*", "\\w*registration\\w*number", "enrolment\\w*", "enrollment\\w*",
  "\\w*idNumber", "importantReferenceNumber", "affidavitNumber", "certificateNumber"
].join("|") + ")$", "i");
function isSensitiveKey(key) {
  return SENSITIVE_KEY_RE.test(String(key));
}
function isEncrypted(v) {
  return typeof v === "string" && v.startsWith(PREFIX);
}
let cachedKeys = null;
function keys() {
  if (cachedKeys) return cachedKeys;
  let master;
  if (process.env.FIELD_ENCRYPTION_KEY) {
    master = Buffer.from(process.env.FIELD_ENCRYPTION_KEY, "hex");
    if (master.length !== 32) throw new Error("FIELD_ENCRYPTION_KEY must be 64 hex characters (32 bytes).");
  } else if (process.env.AADHAAR_ENCRYPTION_KEY) {
    master = Buffer.from(process.env.AADHAAR_ENCRYPTION_KEY, "hex");
    if (master.length !== 32) throw new Error("AADHAAR_ENCRYPTION_KEY must be 64 hex characters (32 bytes).");
  } else {
    throw new Error("Set FIELD_ENCRYPTION_KEY (or AADHAAR_ENCRYPTION_KEY) to encrypt sensitive fields.");
  }
  const derive = info => Buffer.from(crypto.hkdfSync("sha256", master, Buffer.alloc(0), info, 32));
  cachedKeys = {enc: derive("kaagazaad/asset-fields/enc/v1"), idx: derive("kaagazaad/asset-fields/blind-index/v1")};
  return cachedKeys;
}
function encryptField(plain) {
  if (plain === undefined || plain === null || plain === "" || isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keys().enc, iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${data.toString("hex")}`;
}
function decryptField(value) {
  if (!isEncrypted(value)) return value;
  const [ivHex, tagHex, dataHex] = value.slice(PREFIX.length).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keys().enc, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}
function normalizeForIndex(v) {
  return String(v).toUpperCase().replace(/[\s-]+/g, "");
}
function blindIndex(value) {
  if (value === undefined || value === null || String(value).trim() === "") return "";
  return crypto.createHmac("sha256", keys().idx).update(normalizeForIndex(value)).digest("hex");
}
function decryptPlain(obj) {
  if (!obj || typeof obj !== "object") return obj;
  for (const k of Object.keys(obj)) {
    if (isEncrypted(obj[k])) {
      try {
        obj[k] = decryptField(obj[k]);
      } catch (err) {
        console.error(`[fieldCrypto] could not decrypt "${k}":`, err.message);
        obj[k] = "";
      }
    }
  }
  return obj;
}
module.exports = {
  isSensitiveKey: isSensitiveKey,
  isEncrypted: isEncrypted,
  encryptField: encryptField,
  decryptField: decryptField,
  decryptPlain: decryptPlain,
  blindIndex: blindIndex
};
