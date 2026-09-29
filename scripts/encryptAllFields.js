#!/usr/bin/env node
/**
 * One-off / repeatable migration: encrypt every field of every existing document.
 *
 *   node scripts/encryptAllFields.js            # dry run: reports what WOULD change
 *   node scripts/encryptAllFields.js --apply    # performs the migration
 *   node scripts/encryptAllFields.js --apply --skip-indexes
 *
 * Safe to run more than once (already-encrypted fields are skipped) and safe to run while
 * the NEW app version is live (it reads both formats). Each write is guarded by the
 * document's previous field values, so if the app changed a document mid-migration that
 * write is skipped and picked up on the next run - re-run until "skipped: 0".
 *
 * Also upgrades legacy `enc:v1:` fields, fills blind-index columns, and (unless
 * --skip-indexes) runs syncIndexes() to drop the old plaintext unique indexes
 * (email_1, phone_1, ...) and build the new blind-index ones.
 *
 * !! TAKE A DATABASE BACKUP FIRST. Losing FIELD_ENCRYPTION_KEY makes the data unrecoverable.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const MODELS = ["User", "Asset", "Alert", "Invite", "VaultMember", "SharedDocument", "OcrTemplate", "SecurityEvent", "Otp", "RefreshToken"];
const apply = process.argv.includes("--apply");
const skipIndexes = process.argv.includes("--skip-indexes");

(async () => {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set.");
  require("../utils/fieldVault").blindIndex("probe", "x"); // fail fast if the key is missing/invalid
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(apply ? "MODE: APPLY (writing changes)" : "MODE: DRY RUN (no writes). Re-run with --apply.");
  let totalSkipped = 0;
  for (const name of MODELS) {
    const Model = require(`../models/${name}`);
    const col = Model.collection;
    let scanned = 0, changed = 0, fields = 0, skipped = 0, failed = 0;
    let ops = [];
    const flush = async () => {
      if (!ops.length) return;
      const batch = ops; ops = [];
      const res = await col.bulkWrite(batch.map(o => o.op), { ordered: false });
      const modified = res.modifiedCount;
      skipped += batch.length - modified;
    };
    for await (const raw of col.find({})) {
      scanned++;
      let plan;
      try { plan = Model.encryptionPlan(raw); }
      catch (e) { failed++; console.error(`  ! ${name} ${raw._id}: ${e.message}`); continue; }
      const setKeys = Object.keys(plan.set), unsetKeys = Object.keys(plan.unset);
      if (!setKeys.length && !unsetKeys.length) continue;
      changed++; fields += setKeys.length;
      if (!apply) continue;
      // Guard: only write if the source fields still hold the values we read.
      const filter = { _id: raw._id };
      for (const k of setKeys) if (raw[k] !== undefined && !k.endsWith("Idx")) filter[k] = raw[k];
      const update = {};
      if (setKeys.length) update.$set = plan.set;
      if (unsetKeys.length) update.$unset = plan.unset;
      ops.push({ op: { updateOne: { filter, update } } });
      if (ops.length >= 500) await flush();
    }
    if (apply) await flush();
    totalSkipped += skipped;
    console.log(`${name.padEnd(15)} scanned ${String(scanned).padStart(6)}  need-migration ${String(changed).padStart(6)}  fields ${String(fields).padStart(7)}  skipped ${skipped}  failed ${failed}`);
    if (apply && !skipIndexes) {
      try { const dropped = await Model.syncIndexes(); if (dropped.length) console.log(`  indexes dropped: ${dropped.join(", ")}`); }
      catch (e) { console.error(`  ! syncIndexes(${name}) failed: ${e.message}`); }
    }
  }
  if (apply) {
    console.log("\nVerifying (every document must now be fully migrated)...");
    let remaining = 0;
    for (const name of MODELS) {
      const Model = require(`../models/${name}`);
      for await (const raw of Model.collection.find({})) {
        const p = Model.encryptionPlan(raw);
        if (Object.keys(p.set).length || Object.keys(p.unset).length) remaining++;
      }
    }
    console.log(remaining === 0 ? "OK - all documents are encrypted." : `${remaining} document(s) still need migration - re-run this script.`);
    if (totalSkipped) console.log(`${totalSkipped} write(s) were skipped because the app changed those documents; re-run.`);
  }
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
