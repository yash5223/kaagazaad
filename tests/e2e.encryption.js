// End-to-end: real Express server + real (test) MongoDB. Drives the actual HTTP routes with
// minted JWTs, then inspects raw stored documents.  node tests/e2e.encryption.js
const {spawn} = require("child_process");
const assert = require("assert");
const crypto = require("crypto");
const path = require("path");
const PORT = 3999;
const env = {
  ...process.env, PORT: String(PORT), NODE_ENV: "test", MONGODB_URI: process.env.MONGODB_TEST_URI || "mongodb://127.0.0.1:27017/kz_e2e",
  JWT_SECRET: "e2e-jwt-secret-e2e-jwt-secret-1234", REQUEST_SIGNATURE_MODE: "off",
  FIELD_ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex"), AADHAAR_ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex"), AADHAAR_HASH_SECRET: "x".repeat(32)
};
Object.assign(process.env, env);
const mongoose = require("mongoose");
const User = require("../models/User");
const {issueAccessToken} = require("../utils/tokens");
const base = `http://127.0.0.1:${PORT}/api`;
let pass = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log("  ok  ", name); } catch (e) { console.log("  FAIL", name, "\n      ", e.stack.split("\n").slice(0, 6).join("\n       ")); process.exitCode = 1; }
}

// Remove ciphertext blobs and 64-hex blind indexes before searching, otherwise short needles
// (e.g. "2031") match random hex by chance.
const scrub = json => json.replace(/enc:v[12]:[0-9a-f:]+/g, "<ct>").replace(/"[0-9a-f]{64}"/g, '"<idx>"').replace(/"_id":"[0-9a-f]{24}"/g, '"_id":"<id>"');
const api = (token) => async (method, url, body, form) => {
  const headers = {Authorization: `Bearer ${token}`};
  let payload;
  if (form) payload = form; else if (body) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const r = await fetch(base + url, {method, headers, body: payload});
  let json = null; try { json = await r.json(); } catch (_) {}
  return {status: r.status, json};
};
const mkUser = (n, email, phone) => User.create({firstName: n, lastName: "Tester", dob: new Date("1991-01-01"), gender: "Male", email, phone,
  aadhaarEncrypted: "a:b:c", aadhaarHash: crypto.randomBytes(8).toString("hex"), passwordHash: "x", customer_id: `CUST_${phone.slice(-3)}`,
  subscription_plan: "premium", plan_expires_at: new Date(Date.now() + 200 * 864e5), emailVerified: true});

(async () => {
  await mongoose.connect(env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  const server = spawn("node", ["server.js"], {cwd: path.join(__dirname, ".."), env, stdio: ["ignore", "pipe", "pipe"]});
  let log = ""; server.stdout.on("data", d => log += d); server.stderr.on("data", d => log += d);
  for (let i = 0; i < 60 && !/Connected to MongoDB/.test(log); i++) await new Promise(r => setTimeout(r, 250));
  await new Promise(r => setTimeout(r, 1500));
  try {
    const owner = await mkUser("Ravi", "ravi.owner@example.com", "9000000111");
    const friend = await mkUser("Meera", "meera.friend@example.com", "9000000222");
    const O = api(issueAccessToken(owner)), F = api(issueAccessToken(friend));
    let assetId, inviteToken;
    const soon = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);

    console.log("Assets");
    await t("save-asset stores encrypted, API returns plaintext", async () => {
      const form = new FormData();
      form.append("assetData", JSON.stringify({name: "Honda City Insurance", category: "Personal", subCategory: "Insurance", subSubCategory: "Vehicle Insurance",
        issueDate: "2024-03-05", notesOrAddress: "Flat 4B Ganesh Nagar", storeOrSeller: "ICICI Lombard", documentNumber: "POL-123-456", valueAmount: "1500", expiryDate: soon}));
      const r = await O("POST", "/assets/save-asset", null, form);
      assert.strictEqual(r.status, 201, JSON.stringify(r.json));
      assetId = r.json.asset._id;
      assert.strictEqual(r.json.asset.name, "Honda City Insurance"); assert.strictEqual(r.json.asset.userIdIdx, undefined);
      assert.strictEqual(r.json.asset.documentNumber, "POL-123-456");
    });
    await t("fetch-assets + server-side search", async () => {
      let r = await O("GET", "/assets/fetch-assets");
      assert.strictEqual(r.json.assets.length, 1); assert.strictEqual(r.json.assets[0].storeOrSeller, "ICICI Lombard");
      assert(typeof r.json.assets[0].issueDate === "string" && r.json.assets[0].issueDate.startsWith("2024-03-05"));
      r = await O("GET", "/assets/fetch-assets?search=icici"); assert.strictEqual(r.json.assets.length, 1);
      r = await O("GET", "/assets/fetch-assets?search=vehicle"); assert.strictEqual(r.json.assets.length, 1);
      r = await O("GET", "/assets/fetch-assets?search=nomatch"); assert.strictEqual(r.json.assets.length, 0);
      r = await F("GET", "/assets/fetch-assets"); assert.strictEqual(r.json.assets.length, 0, "other users see nothing");
    });
    await t("edit via save-asset ($set path)", async () => {
      const form = new FormData();
      form.append("assetData", JSON.stringify({_id: assetId, name: "Honda City Policy", category: "Personal", subCategory: "Insurance", subSubCategory: "Vehicle Insurance", valueAmount: "2500", expiryDate: soon, documentNumber: "POL-123-456"}));
      const r = await O("POST", "/assets/save-asset", null, form);
      assert.strictEqual(r.status, 201, JSON.stringify(r.json)); assert.strictEqual(r.json.asset.name, "Honda City Policy");
    });
    await t("dashboard-summary reads dynamic fields (valueAmount/expiryDate) decrypted", async () => {
      const r = await O("GET", "/assets/dashboard-summary");
      assert.strictEqual(r.status, 200); assert.strictEqual(r.json.metrics.totalValue, 2500); assert.strictEqual(r.json.metrics.activeAssets, 1);
    });
    await t("expiry alert generated once, readable, no duplicates on repeat", async () => {
      await O("GET", "/assets/fetch-assets"); await O("GET", "/assets/fetch-assets");
      const r = await O("GET", "/alerts/fetch-alerts");
      const exp = r.json.alerts.filter(a => a.title === "Document Expiring Soon");
      assert.strictEqual(exp.length, 1, JSON.stringify(r.json.alerts.map(a => a.title)));
      assert(/Honda City/.test(exp[0].message)); assert.strictEqual(exp[0].sent_toIdx, undefined);
      const up = await O("PATCH", `/alerts/mark-read/${exp[0]._id}`); assert.strictEqual(up.json.alert.is_read, true);
      assert.strictEqual((await F("GET", "/alerts/fetch-alerts")).json.alerts.length, 0);
    });
    await t("check-duplicate by normalised document number and by name+day", async () => {
      let r = await O("POST", "/assets/check-duplicate", {documentNumber: "pol 123 456"}); assert(r.json.duplicate && r.json.duplicate._id === assetId);
      r = await O("POST", "/assets/check-duplicate", {documentNumber: "NOPE"}); assert.strictEqual(r.json.duplicate, null);
      r = await O("POST", "/assets/check-duplicate", {name: "honda city policy", issueDate: "2024-03-05"}); assert(r.json.duplicate);
    });
    await t("service records: add / edit / delete", async () => {
      let r = await O("POST", "/assets/append-service-record", {assetId, title: "Oil change", date: "2025-02-01", cost: 900, notes: "ok"});
      assert.strictEqual(r.status, 200, JSON.stringify(r.json)); assert.strictEqual(r.json.serviceRecords.length, 1);
      const rid = r.json.serviceRecords[0]._id; assert(/^[0-9a-f]{24}$/.test(rid));
      r = await O("PUT", "/assets/edit-service-record", {assetId, recordId: rid, title: "Oil + filter", date: "2025-02-02", cost: 1200, notes: "n"});
      assert.strictEqual(r.status, 200, JSON.stringify(r.json)); assert.strictEqual(r.json.serviceRecords[0].title, "Oil + filter");
      r = await O("GET", "/assets/fetch-assets"); assert.strictEqual(r.json.assets[0].serviceRecords[0].cost, 1200);
      r = await O("DELETE", "/assets/delete-service-record", {assetId, recordId: rid}); assert.strictEqual(r.json.serviceRecords.length, 0);
    });
    await t("plan-status counts documents through blind index", async () => {
      const r = await O("GET", "/assets/plan-status"); assert.strictEqual(r.status, 200); assert.strictEqual(r.json.usage.documents, 1);
    });

    console.log("Family vault + sharing");
    await t("create-invite / list / join / members", async () => {
      let r = await O("POST", "/vault/create-invite", {role: "view"});
      assert.strictEqual(r.status, 201, JSON.stringify(r.json)); inviteToken = r.json.invite.token;
      r = await O("GET", "/vault/invites"); assert.strictEqual(r.json.invites.length, 1);
      r = await F("POST", "/vault/join", {token: inviteToken}); assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      r = await O("GET", "/vault/invites"); assert.strictEqual(r.json.invites.length, 0, "accepted invite is no longer pending");
      r = await O("GET", "/vault/members"); assert.strictEqual(r.json.members.length, 1); assert.strictEqual(r.json.members[0].email, "meera.friend@example.com");
      const html = await (await fetch(`http://127.0.0.1:${PORT}/join/${inviteToken}`)).text(); assert(/already been used/.test(html));
    });
    await t("expired pending invites are auto-revoked", async () => {
      const Invite = require("../models/Invite");
      const inv = await Invite.create({ownerCustomerId: owner.customer_id, token: crypto.randomBytes(16).toString("hex"), expiresAt: new Date(Date.now() - 1000)});
      const r = await O("GET", "/vault/invites"); assert.strictEqual(r.json.invites.length, 0);
      assert.strictEqual((await Invite.findById(inv._id)).status, "revoked");
    });
    await t("share-document → receiver opens (viewCount) → duplicate blocked → revoke", async () => {
      let r = await O("POST", "/vault/share-document", {assetId, receiver: "meera.friend@example.com", recipientLabel: "Friend"});
      assert.strictEqual(r.status, 201, JSON.stringify(r.json)); const shareId = r.json.share._id || r.json.share.id;
      r = await O("POST", "/vault/share-document", {assetId, receiver: "MEERA.friend@example.com"}); assert.strictEqual(r.status, 201, JSON.stringify(r.json)); assert.strictEqual(r.json.share.id, shareId, "re-share updates the same active share");
      r = await F("GET", `/vault/shared-asset/${assetId}`); assert.strictEqual(r.status, 200, JSON.stringify(r.json)); assert.strictEqual(r.json.asset.name, "Honda City Policy");
      await F("GET", `/vault/shared-asset/${assetId}`);
      r = await F("GET", "/vault/shared-with-me"); assert.strictEqual(r.json.documents.length, 1); assert.strictEqual(r.json.documents[0].viewCount, 2); assert.strictEqual(r.json.documents[0].status, "active");
      r = await O("GET", "/vault/shared-by-me"); assert.strictEqual(r.json.documents.length, 1);
      const alerts = (await O("GET", "/alerts/fetch-alerts")).json.alerts; assert(alerts.some(a => a.title === "Document Opened"));
      r = await O("DELETE", `/vault/shared/${shareId}`); assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      r = await F("GET", `/vault/shared-asset/${assetId}`); assert.strictEqual(r.status, 403);
      r = await O("POST", "/vault/share-document", {assetId, receiver: "meera.friend@example.com"}); assert.strictEqual(r.status, 201, "can share again after revoke: " + JSON.stringify(r.json));
    });
    await t("AI chat + summary read decrypted lean assets", async () => {
      const r = await O("POST", "/ai/chat", {message: "how many documents do I have?"});
      assert.strictEqual(r.status, 200, JSON.stringify(r.json)); assert(typeof r.json.reply === "string");
      const s = await O("POST", "/ai/summary", {assetId}); assert(s.status === 200 || s.status === 429, JSON.stringify(s.json));
    });

    console.log("Raw database inspection");
    await t("no collection contains any plaintext PII / content", async () => {
      const secrets = ["Honda", "ICICI", "Ganesh", "POL-123", "ravi.owner", "meera.friend", "Meera", "Tester", "9000000111", "9000000222", "CUST_111", "CUST_222",
        "Oil", "Friend", "Insurance", "Document Expiring", "was added", "Vehicle", "1991", soon, inviteToken];
      const cols = await mongoose.connection.db.listCollections().toArray();
      let docs = 0;
      for (const c of cols) {
        for (const d of await mongoose.connection.db.collection(c.name).find({}).toArray()) {
          docs++;
          const j = scrub(JSON.stringify(d));
          for (const s of secrets) if (j.includes(s)) assert.fail(`plaintext "${s}" in ${c.name}: ${j.slice(0, 400)}`);
        }
      }
      console.log(`       (${docs} raw documents across ${cols.map(c => c.name).join(", ")})`);
    });
  } finally {
    server.kill();
    console.log(`\n${pass} passed`);
    if (process.exitCode) console.log("--- server log tail ---\n" + log.split("\n").filter(l => /error|Error|encrypted at rest|fail/i.test(l)).slice(-15).join("\n"));
    await mongoose.disconnect(); process.exit();
  }
})();
