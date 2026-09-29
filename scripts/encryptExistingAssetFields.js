require("dotenv").config();
const mongoose = require("mongoose");
const {isSensitiveKey, isEncrypted, encryptField, blindIndex} = require("../utils/fieldCrypto");
(async () => {
  const apply = process.argv.includes("--apply");
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set.");
  await mongoose.connect(process.env.MONGODB_URI);
  const col = mongoose.connection.collection("assets");
  let scanned = 0, changedDocs = 0, changedFields = 0;
  for await (const doc of col.find({})) {
    scanned++;
    const $set = {};
    for (const [k, v] of Object.entries(doc)) {
      if (k.endsWith("Idx") || !isSensitiveKey(k)) continue;
      if (typeof v !== "string" || v === "" || isEncrypted(v)) continue;
      $set[k] = encryptField(v);
      if (k === "documentNumber") $set.documentNumberIdx = blindIndex(v);
      changedFields++;
    }
    if (Object.keys($set).length) {
      changedDocs++;
      if (apply) await col.updateOne({_id: doc._id}, {$set});
    }
  }
  console.log(`${apply ? "APPLIED" : "DRY RUN"}: scanned ${scanned} assets; ${changedFields} fields in ${changedDocs} assets ${apply ? "encrypted" : "would be encrypted"}.`);
  await mongoose.disconnect();
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
