// Reference implementation of the client-side E2EE scheme (lib/core/e2ee.dart) using Node crypto.
// It exists to (1) prove the design round-trips, and (2) produce test vectors that the Dart
// implementation must reproduce (see the Flutter test test/e2ee_test.dart).
// Run: node tests/e2ee.reference.js
const crypto = require("crypto");
const assert = require("assert");

const ITER = 600000;
const b64u = b => Buffer.from(b).toString("base64url");
const unb64u = s => Buffer.from(s, "base64url");
const hkdf = (ikm, info) => Buffer.from(crypto.hkdfSync("sha256", ikm, Buffer.alloc(0), info, 32));

function seal(plain, key, aad, nonce = crypto.randomBytes(12)) {
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, ct, c.getAuthTag()]);
}
function open(sealed, key, aad) {
  assert(sealed[0] === 1 && sealed.length >= 29, "bad format");
  const d = crypto.createDecipheriv("aes-256-gcm", key, sealed.subarray(1, 13));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(13, sealed.length - 16)), d.final()]);
}
function deriveCredentials(password, email, iter = ITER) {
  const salt = Buffer.from(`kaagazaad|v1|${email.trim().toLowerCase()}`);
  const pwKey = crypto.pbkdf2Sync(password, salt, iter, 32, "sha256");
  return {authSecret: hkdf(pwKey, "kz-auth").toString("hex"), kek: hkdf(pwKey, "kz-kek")};
}
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function formatRk(bytes) {
  let bits = 0, acc = 0, s = "";
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { s += B32[(acc >> (bits - 5)) & 31]; bits -= 5; acc &= (1 << bits) - 1; } }
  return s.match(/.{1,4}/g).join("-");
}
function parseRk(rk) {
  const s = rk.toUpperCase().replace(/[^A-Z2-7]/g, "");
  assert(s.length === 32, "bad recovery key");
  let bits = 0, acc = 0; const out = [];
  for (const c of s) { acc = (acc << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((acc >> (bits - 8)) & 255); bits -= 8; acc &= (1 << bits) - 1; } }
  return Buffer.from(out);
}
const rkKey = rk => hkdf(parseRk(rk), "kz-recovery");

function createAccountKeys(creds) {
  const mk = crypto.randomBytes(32);
  const rk = formatRk(crypto.randomBytes(20));
  return {mk, rk, bundle: {v: 1, kdfIter: ITER,
    wrappedMk: b64u(seal(mk, creds.kek, "kz1|mk")),
    recoveryWrappedMk: b64u(seal(mk, rkKey(rk), "kz1|mk-recovery"))}};
}

module.exports = {seal, open, deriveCredentials, createAccountKeys, rkKey, formatRk, parseRk, b64u, unb64u, hkdf};

if (require.main === module) {
  const cust = "CUST_7";
  const aadRecord = `kz1|record|${cust}`, aadDek = `kz1|dek|${cust}`, aadFile = `kz1|file|${cust}`;

  // register
  const creds = deriveCredentials("Str0ng!Pass", "Asha@Example.com");
  assert(/^[0-9a-f]{64}$/.test(creds.authSecret));
  const {mk, rk, bundle} = createAccountKeys(creds);
  // the bundle matches the server validator (b64url charset, <=400 chars)
  for (const f of [bundle.wrappedMk, bundle.recoveryWrappedMk]) assert(/^[A-Za-z0-9_.\-]+$/.test(f) && f.length < 400);
  assert.notStrictEqual(creds.authSecret, creds.kek.toString("hex"), "auth secret must be independent of the KEK");

  // login on another device: same password + email (case-insensitive) unwraps the same MK
  const creds2 = deriveCredentials("Str0ng!Pass", " asha@example.com ");
  assert.strictEqual(creds2.authSecret, creds.authSecret);
  assert(open(unb64u(bundle.wrappedMk), creds2.kek, "kz1|mk").equals(mk));

  // wrong password: different auth secret AND cannot unwrap
  const bad = deriveCredentials("wrong", "asha@example.com");
  assert.notStrictEqual(bad.authSecret, creds.authSecret);
  assert.throws(() => open(unb64u(bundle.wrappedMk), bad.kek, "kz1|mk"));

  // record + file with a per-record DEK
  const dek = crypto.randomBytes(32);
  const wrappedDek = b64u(seal(dek, mk, aadDek));
  const record = {name: "Passport", issueDate: "2024-01-05", files: [{publicId: "kaagazaad/CUST_7_e2ee_1_ab", name: "passport.pdf"}]};
  const blob = b64u(seal(Buffer.from(JSON.stringify(record)), dek, aadRecord));
  assert(!Buffer.from(blob, "base64url").toString("latin1").includes("Passport"), "no plaintext in blob");
  const dek2 = open(unb64u(wrappedDek), mk, aadDek);
  assert.deepStrictEqual(JSON.parse(open(unb64u(blob), dek2, aadRecord).toString()), record);
  const file = crypto.randomBytes(5000);
  assert(open(seal(file, dek, aadFile), dek, aadFile).equals(file));

  // integrity / binding
  const tampered = Buffer.from(unb64u(blob)); tampered[20] ^= 1;
  assert.throws(() => open(tampered, dek, aadRecord), "tamper detected");
  assert.throws(() => open(unb64u(blob), dek, `kz1|record|CUST_8`), "another user's context rejected");
  assert.throws(() => open(seal(file, dek, aadFile), dek, aadRecord), "file can't be passed off as record");

  // recovery key path (forgot password)
  const rk2 = rk.toLowerCase().replace(/-/g, " ");
  assert(open(unb64u(bundle.recoveryWrappedMk), rkKey(rk2), "kz1|mk-recovery").equals(mk));
  const newCreds = deriveCredentials("Br@ndNew123", "asha@example.com");
  const rewrapped = b64u(seal(mk, newCreds.kek, "kz1|mk"));
  assert(open(unb64u(rewrapped), newCreds.kek, "kz1|mk").equals(mk), "same MK after reset -> old records still readable");
  assert.throws(() => rkKey("AAAA-BBBB"), "short recovery key rejected");
  assert.throws(() => open(unb64u(bundle.recoveryWrappedMk), rkKey(formatRk(crypto.randomBytes(20))), "kz1|mk-recovery"), "wrong recovery key");

  // fixed vectors for the Dart test (deterministic nonce)
  const v = deriveCredentials("Test#Pass123", "vector@kaagazaad.in");
  const key = Buffer.alloc(32, 7), nonce = Buffer.alloc(12, 9);
  const sealed = seal(Buffer.from("hello vault"), key, "kz1|record|CUST_1", nonce);
  console.log("VECTORS " + JSON.stringify({authSecret: v.authSecret, kekHex: v.kek.toString("hex"), sealedB64u: b64u(sealed),
    rk: "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-2345-67AB", rkKeyHex: rkKey("ABCD-EFGH-IJKL-MNOP-QRST-UVWX-2345-67AB").toString("hex")}));
  console.log("e2ee reference: all checks passed");
}
