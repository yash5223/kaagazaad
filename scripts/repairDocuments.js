// Usage: node scripts/repairDocuments.js          (dry run)
//        node scripts/repairDocuments.js --apply  (writes changes)
// Wraps any asset whose decrypted `documents` is a bare string into a one-item array.
require("dotenv").config();
const mongoose = require("mongoose");
const Asset = require("../models/Asset");
(async () => {
  const apply = process.argv.includes("--apply");
  await mongoose.connect(process.env.MONGODB_URI);
  let fixed = 0;
  const ids = (await Asset.collection.find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id);
  for (const _id of ids) {
    const asset = await Asset.findById(_id);
    if (!asset) continue;
    const d = asset.documents;
    if (Array.isArray(d)) continue;
    let next = [];
    if (typeof d === "string" && d.trim()) {
      try { const p = JSON.parse(d); next = Array.isArray(p) ? p : [d.trim()]; } catch (_) { next = [d.trim()]; }
    }
    fixed++;
    console.log(`${apply ? "FIX" : "WOULD FIX"} ${_id}: ${typeof d} -> array(${next.length})`);
    if (apply) { asset.documents = next; asset.markModified("documents"); await asset.save({ validateModifiedOnly: true }); }
  }
  console.log(`${apply ? "Repaired" : "Would repair"} ${fixed} asset(s).`);
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
