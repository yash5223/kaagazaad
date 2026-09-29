// Run:  MONGODB_TEST_URI=mongodb://127.0.0.1:27017/kz_enc_test node tests/encryption.integration.js
process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY || require("crypto").randomBytes(32).toString("hex");
const assert = require("assert");
const mongoose = require("mongoose");
const User = require("../models/User");
const Asset = require("../models/Asset");
const Alert = require("../models/Alert");
const Otp = require("../models/Otp");
const RefreshToken = require("../models/RefreshToken");
const SharedDocument = require("../models/SharedDocument");
const VaultMember = require("../models/VaultMember");
const SecurityEvent = require("../models/SecurityEvent");

let pass = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ok  ", name); }
  catch (e) { console.log("  FAIL", name, "\n      ", e.stack.split("\n").slice(0, 3).join("\n       ")); process.exitCode = 1; }
}

// Remove ciphertext blobs and 64-hex blind indexes before searching, otherwise short needles
// (e.g. "2031") match random hex by chance.
const scrub = json => json.replace(/enc:v[12]:[0-9a-f:]+/g, "<ct>").replace(/"[0-9a-f]{64}"/g, '"<idx>"').replace(/"_id":"[0-9a-f]{24}"/g, '"_id":"<id>"');
const rawOf = (M, id) => M.collection.findOne({ _id: id });
function assertNoPlain(raw, secrets, label) {
  const dump = scrub(JSON.stringify(raw));
  for (const s of secrets) assert(!dump.includes(s), `${label}: plaintext "${s}" found in raw document: ${dump.slice(0, 300)}`);
}
(async () => {
  await mongoose.connect(process.env.MONGODB_TEST_URI || "mongodb://127.0.0.1:27017/kz_enc_test");
  await mongoose.connection.dropDatabase();
  const models = [User, Asset, Alert, Otp, RefreshToken, SharedDocument, VaultMember, SecurityEvent];
  // FerretDB (used for local testing) lacks TTL indexes; real MongoDB has them. Build all others.
  for (const M of models) {
    await M.createCollection().catch(() => {});
    for (const [fields, options] of M.schema.indexes()) {
      if (options.expireAfterSeconds !== undefined) continue;
      await M.collection.createIndex(fields, { ...options, background: undefined });
    }
  }

  console.log("User");
  let user;
  await t("create stores no plaintext; reads back decrypted", async () => {
    user = await User.create({ firstName: "Asha", lastName: "Verma", fatherName: "Ramesh", dob: new Date("1990-05-04"), gender: "Female",
      email: "Asha.Verma@Example.com ", phone: "9876500001", aadhaarEncrypted: "x:y:z", aadhaarHash: "h1", passwordHash: "bcrypt$", customer_id: "CUST_1" });
    assertNoPlain(await rawOf(User, user._id), ["Asha", "Verma", "Ramesh", "example.com", "9876500001", "CUST_1", "1990"], "user");
    assert.strictEqual(user.email, "asha.verma@example.com");
    const raw = await rawOf(User, user._id);
    assert(raw.emailIdx && raw.phoneIdx && raw.customer_idIdx);
    assert.strictEqual(raw.passwordHash, "bcrypt$");
    const again = await User.findById(user._id);
    assert.strictEqual(again.firstName, "Asha");
    assert(again.dob instanceof Date && again.dob.getUTCFullYear() === 1990);
    assert.strictEqual(again.pinEnabled, false);
    assert.strictEqual(again.fullName, "Asha Verma");
    assert.strictEqual(again.toJSON().emailIdx, undefined);
    assert.strictEqual(again.toJSON().passwordHash, undefined);
  });
  await t("findOne by email is case/space-insensitive; $or email/phone works", async () => {
    assert((await User.findOne({ email: "ASHA.verma@example.com" }))._id.equals(user._id));
    assert((await User.findOne({ $or: [{ email: "nobody@x.com" }, { phone: "9876500001" }] }))._id.equals(user._id));
    assert.strictEqual(await User.findOne({ email: "nobody@x.com" }), null);
  });
  await t("lean + select is decrypted (authMiddleware pattern)", async () => {
    const l = await User.findById(user._id).select("tokenVersion customer_id email").lean();
    assert.strictEqual(l.customer_id, "CUST_1"); assert.strictEqual(l.email, "asha.verma@example.com"); assert.strictEqual(l.tokenVersion, 0);
  });
  await t("duplicate email / phone rejected by unique blind index", async () => {
    await assert.rejects(User.create({ firstName: "B", lastName: "B", dob: new Date(), gender: "Male", email: "asha.verma@example.com", phone: "1", aadhaarEncrypted: "a", aadhaarHash: "h2", passwordHash: "p", customer_id: "CUST_2" }), /E11000|duplicate/i);
    await assert.rejects(User.create({ firstName: "B", lastName: "B", dob: new Date(), gender: "Male", email: "b@x.com", phone: "9876500001", aadhaarEncrypted: "a", aadhaarHash: "h3", passwordHash: "p", customer_id: "CUST_3" }), /E11000|duplicate/i);
  });
  await t("enum validation still enforced on encrypted field", async () => {
    await assert.rejects(User.create({ firstName: "B", lastName: "B", dob: new Date(), gender: "Robot", email: "c@x.com", phone: "2", aadhaarEncrypted: "a", aadhaarHash: "h4", passwordHash: "p", customer_id: "CUST_4" }), /gender|enum/i);
    await assert.rejects(User.create({ lastName: "B", dob: new Date(), gender: "Male", email: "d@x.com", phone: "3", aadhaarEncrypted: "a", aadhaarHash: "h5", passwordHash: "p", customer_id: "CUST_5" }), /firstName|required/i);
  });
  await t("doc modify + save re-encrypts; updateOne $set encrypted; atomic $inc on plain tokenVersion", async () => {
    const u = await User.findById(user._id);
    u.failedLoginAttempts = 3; u.loginLockedUntil = new Date("2030-01-01"); u.trustedDevices.push({ tokenHash: "t", label: "Pixel" });
    await u.save();
    let raw = await rawOf(User, user._id);
    assertNoPlain(raw, ["Pixel", "2030"], "user2");
    let r = await User.findById(user._id);
    assert.strictEqual(r.failedLoginAttempts, 3); assert(r.loginLockedUntil instanceof Date); assert.strictEqual(r.trustedDevices[0].label, "Pixel");
    await User.updateOne({ _id: user._id }, { $set: { subscription_plan: "premium", plan_expires_at: new Date("2031-02-03") }, $inc: { tokenVersion: 1 } });
    raw = await rawOf(User, user._id);
    assertNoPlain(raw, ["premium", "2031"], "user3"); assert.strictEqual(raw.tokenVersion, 1);
    r = await User.findById(user._id);
    assert.strictEqual(r.subscription_plan, "premium"); assert(r.plan_expires_at instanceof Date); assert.strictEqual(r.tokenVersion, 1);
    assert.strictEqual(r.ai_usage.count, 0);
  });
  await t("unsupported operations throw loudly", async () => {
    await assert.rejects(User.find({ firstName: "Asha" }), /encrypted at rest/);
    await assert.rejects(User.find({ email: /asha/ }), /regex/);
    await assert.rejects(User.find().sort({ firstName: 1 }), /sort/);
    await assert.rejects(User.updateOne({ _id: user._id }, { $inc: { failedLoginAttempts: 1 } }), /encrypted at rest/);
    await assert.rejects(User.aggregate([{ $match: {} }]), /bypasses/);
    assert((await User.findOne().sort({ _id: -1 }))._id.equals(user._id));
  });

  console.log("Asset");
  let asset;
  await t("all fields incl. dynamic + documents + dates encrypted; round-trip", async () => {
    asset = new Asset({ userId: "CUST_1", name: "Honda City Insurance", category: "Personal", subCategory: "Insurance", subSubCategory: "Vehicle Insurance",
      issueDate: new Date("2024-03-05"), notesOrAddress: "Flat 4B, Ganesh Nagar", storeOrSeller: "ICICI Lombard", documentNumber: "POL-123-456",
      panNumber: "ABCDE1234F", valueAmount: "45000", expiryDate: "2027-03-04", documents: [{ url: "https://res.cloudinary.com/x/secret.pdf", bytes: 10 }] });
    await asset.save();
    assert.strictEqual(asset.name, "Honda City Insurance");
    const raw = await rawOf(Asset, asset._id);
    assertNoPlain(raw, ["Honda", "Personal", "Insurance", "2024", "Ganesh", "ICICI", "POL-123", "ABCDE", "45000", "cloudinary", "CUST_1"], "asset");
    assert(raw.userIdIdx && raw.documentNumberIdx);
    const r = await Asset.findOne({ _id: asset._id, userId: "CUST_1" });
    assert.strictEqual(r.name, "Honda City Insurance"); assert(r.issueDate instanceof Date); assert.strictEqual(r.panNumber, "ABCDE1234F");
    assert.strictEqual(r.documents[0].bytes, 10);
    assert.strictEqual(r.toObject().userIdIdx, undefined);
    assert.strictEqual(await Asset.findOne({ _id: asset._id, userId: "CUST_2" }), null);
    assert.strictEqual(await Asset.countDocuments({ userId: "CUST_1" }), 1);
  });
  await t("in-place array push (no markModified) persists", async () => {
    const a = await Asset.findById(asset._id);
    a.documents.push({ url: "second", bytes: 5 });
    a.serviceRecords.push({ _id: new mongoose.Types.ObjectId(), title: "Service", date: new Date("2025-01-01"), cost: 100, notes: "ok" });
    await a.save();
    assertNoPlain(await rawOf(Asset, asset._id), ["second", "Service"], "asset push");
    const r = await Asset.findById(asset._id);
    assert.strictEqual(r.documents.length, 2); assert.strictEqual(r.serviceRecords[0].title, "Service"); assert(r.serviceRecords[0].date instanceof Date);
    assert.strictEqual(a.documents.length, 2, "in-memory doc still plaintext after save");
  });
  await t("findOneAndUpdate $set encrypts (save-asset edit path)", async () => {
    const r = await Asset.findOneAndUpdate({ _id: asset._id, userId: "CUST_1" }, { $set: { name: "Renamed Policy", storeOrSeller: "HDFC Ergo", documentNumber: "NEW 999", issueDate: new Date("2025-06-06") } }, { new: true, runValidators: true });
    assert.strictEqual(r.name, "Renamed Policy"); assert(r.issueDate instanceof Date);
    const raw = await rawOf(Asset, asset._id);
    assertNoPlain(raw, ["Renamed", "HDFC", "NEW 999"], "asset update");
    const { blindIndex } = require("../utils/fieldCrypto");
    assert.strictEqual(raw.documentNumberIdx, blindIndex("NEW 999"));
  });
  await t("lean find decrypts (aiRoutes pattern) and hides indexes", async () => {
    const l = await Asset.find({ userId: "CUST_1" }).lean();
    assert.strictEqual(l[0].name, "Renamed Policy"); assert.strictEqual(l[0].userIdIdx, undefined); assert.strictEqual(l[0].panNumber, "ABCDE1234F");
  });
  await t("legacy plaintext + enc:v1 rows still read; migration plan converts them", async () => {
    const vault = require("../utils/fieldVault"); const legacy = require("../utils/fieldCrypto");
    const _id = new mongoose.Types.ObjectId();
    await Asset.collection.insertOne({ _id, userId: "CUST_9", name: "Old Plain", category: "c", subCategory: "s", subSubCategory: "x", issueDate: new Date("2020-01-01"), documentNumber: legacy.encryptField("OLD-1"), documents: [], serviceRecords: [] });
    const r = await Asset.findById(_id);
    assert.strictEqual(r.name, "Old Plain"); assert.strictEqual(r.documentNumber, "OLD-1"); assert(r.issueDate instanceof Date);
    const plan = Asset.encryptionPlan(await rawOf(Asset, _id));
    await Asset.collection.updateOne({ _id }, { $set: plan.set });
    const raw = await rawOf(Asset, _id);
    assertNoPlain(raw, ["Old Plain", "CUST_9"], "migrated"); assert(vault.isCurrent(raw.documentNumber)); assert(raw.userIdIdx);
    assert.strictEqual((await Asset.findOne({ userId: "CUST_9" })).name, "Old Plain");
    const again = Asset.encryptionPlan(raw);
    assert.deepStrictEqual(Object.keys(again.set), [], "migration is idempotent");
  });

  console.log("Alert / Otp / RefreshToken / SecurityEvent");
  await t("Alert encrypted, filtered by sent_to, sorted by plain created_at, mark-read update", async () => {
    const a1 = await new Alert({ title: "Doc Added", message: '"Passport" was added', sent_to: "CUST_1", related_asset_id: "zz-asset" }).save();
    await new Alert({ title: "Other", message: "m", sent_to: "CUST_2" }).save();
    assertNoPlain(await rawOf(Alert, a1._id), ["Passport", "CUST_1", "Doc Added", "zz-asset"], "alert");
    const list = await Alert.find({ sent_to: "CUST_1" }).sort({ created_at: -1 });
    assert.strictEqual(list.length, 1); assert.strictEqual(list[0].message, '"Passport" was added');
    const up = await Alert.findOneAndUpdate({ _id: a1._id, sent_to: "CUST_1" }, { is_read: true }, { new: true });
    assert.strictEqual(up.is_read, true);
    assert.strictEqual((await Alert.find({ sent_to: "CUST_1", related_asset_id: "zz-asset" })).length, 1);
  });
  await t("Otp: contactInfo encrypted, atomic attempts $inc + TTL fields stay usable", async () => {
    const o = await Otp.create({ contactInfo: "Asha.Verma@Example.com", otpCode: "hmac", expiresAt: new Date(Date.now() + 60000), purpose: "register" });
    assertNoPlain(await rawOf(Otp, o._id), ["example.com"], "otp");
    const d = await Otp.findOneAndUpdate({ contactInfo: "asha.verma@example.com", purpose: "register", attempts: { $lt: 5 }, expiresAt: { $gt: new Date() } }, { $inc: { attempts: 1 } }, { new: true });
    assert(d && d.attempts === 1 && d.contactInfo === "asha.verma@example.com");
    assert.strictEqual((await Otp.deleteMany({ contactInfo: "asha.verma@example.com", purpose: { $in: ["register", "register_verified"] } })).deletedCount, 1);
  });
  await t("RefreshToken: userId encrypted; deleteMany by userId $in; rotation claim query", async () => {
    const uid = new mongoose.Types.ObjectId();
    const rt = await RefreshToken.create({ userId: uid, family: "fam", tokenHash: "th", expiresAt: new Date(Date.now() + 9e6), familyExpiresAt: new Date(Date.now() + 9e6) });
    assertNoPlain(await rawOf(RefreshToken, rt._id), [String(uid)], "refresh");
    const c = await RefreshToken.findOneAndUpdate({ tokenHash: "th", usedAt: null, expiresAt: { $gt: new Date() } }, { $set: { usedAt: new Date() } }, { new: false });
    assert.strictEqual(String(c.userId), String(uid));
    assert.strictEqual((await RefreshToken.deleteMany({ userId: { $in: [uid] } })).deletedCount, 1);
  });
  await t("SecurityEvent: everything but TTL timestamp encrypted", async () => {
    const e = await SecurityEvent.create({ type: "login_failure", userId: "CUST_1", email: "a@b.com", ip: "1.2.3.4", meta: { reason: "no_account" } });
    assertNoPlain(await rawOf(SecurityEvent, e._id), ["login_failure", "a@b.com", "1.2.3.4", "no_account", "CUST_1"], "sec");
  });

  console.log("Sharing / vault");
  await t("SharedDocument: one active share per (owner, receiver, asset); revoked frees slot", async () => {
    const f = { ownerCustomerId: "CUST_1", ownerName: "Asha", ownerEmail: "a@x.com", receiverEmail: "R@x.com", assetId: "A1", status: "active", pinHash: "bcrypt" };
    const s1 = await SharedDocument.create(f);
    assertNoPlain(await rawOf(SharedDocument, s1._id), ["Asha", "r@x.com", "A1", "CUST_1"], "share");
    await assert.rejects(SharedDocument.create(f), /E11000|duplicate/i);
    const found = await SharedDocument.findOne({ ownerCustomerId: "CUST_1", receiverEmail: "r@x.com", assetId: "A1" }).select("+pinHash");
    assert.strictEqual(found.pinHash, "bcrypt"); assert.strictEqual(found.status, "active");
    found.status = "revoked"; found.revokedAt = new Date(); await found.save();
    const s2 = await SharedDocument.create(f);
    assert(s2._id);
  });
  await t("VaultMember pair uniqueness", async () => {
    await VaultMember.create({ ownerCustomerId: "O", memberCustomerId: "M", memberEmail: "M@x.com" });
    await assert.rejects(VaultMember.create({ ownerCustomerId: "O", memberCustomerId: "M", memberEmail: "m@x.com" }), /E11000|duplicate/i);
    assert.strictEqual((await VaultMember.findOne({ ownerCustomerId: "O", memberCustomerId: "M" })).memberEmail, "m@x.com");
  });
  await t("ciphertext cannot be swapped between fields (AAD)", async () => {
    const raw = await rawOf(User, user._id);
    await User.collection.updateOne({ _id: user._id }, { $set: { firstName: raw.lastName } });
    const r = await User.findById(user._id);
    assert.strictEqual(r.firstName, null, "swapped ciphertext must not decrypt");
  });
  console.log(`\n${pass} passed`);
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
