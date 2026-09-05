/**
 * One-time backfill: existing documents uploaded before storage tracking was
 * added don't have a `bytes` field on their document entry, so the Storage
 * Overview widget in the app can't count them. This script looks up the real
 * file size for each of those documents from Cloudinary's Admin API and
 * writes it back onto the asset record.
 *
 * Safe to re-run: it only touches document entries that are missing `bytes`.
 *
 * Usage:
 *   node scripts/backfillDocumentSizes.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Asset = require("../models/Asset");
const { cloudinary, parseCloudinaryUrl } = require("../utils/cloudinary");

// Cloudinary Admin API is rate limited - stagger requests slightly.
const DELAY_MS = 150;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function resolveBytes(entry) {
  let publicId;
  let resourceType = "raw";
  if (typeof entry === "string") {
    const parsed = parseCloudinaryUrl(entry);
    if (!parsed) return null;
    publicId = parsed.publicId;
    resourceType = parsed.resourceType;
  } else if (entry && typeof entry === "object" && entry.publicId) {
    publicId = entry.publicId;
    resourceType = entry.resourceType || "raw";
  } else {
    return null;
  }
  try {
    const resource = await cloudinary.api.resource(publicId, {
      resource_type: resourceType,
      type: "authenticated",
    });
    return typeof resource.bytes === "number" ? resource.bytes : null;
  } catch (err) {
    try {
      const resource = await cloudinary.api.resource(publicId, {
        resource_type: resourceType,
        type: "upload",
      });
      return typeof resource.bytes === "number" ? resource.bytes : null;
    } catch (err2) {
      console.warn(`  ! Could not resolve size for publicId=${publicId}: ${err2.message}`);
      return null;
    }
  }
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("Set MONGODB_URI (or MONGO_URI) before running this script.");
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log("Connected. Scanning assets collection for documents missing size data...\n");

  const assets = await Asset.find({});
  let assetsUpdated = 0;
  let documentsUpdated = 0;
  let documentsSkipped = 0;

  for (const asset of assets) {
    const docs = asset.documents || [];
    let changed = false;
    const newDocs = [];
    for (const entry of docs) {
      const alreadySized = entry && typeof entry === "object" && typeof entry.bytes === "number";
      if (alreadySized) {
        newDocs.push(entry);
        continue;
      }
      const bytes = await resolveBytes(entry);
      await sleep(DELAY_MS);
      if (bytes === null) {
        documentsSkipped++;
        newDocs.push(entry);
        continue;
      }
      if (typeof entry === "string") {
        const parsed = parseCloudinaryUrl(entry);
        newDocs.push({
          publicId: parsed.publicId,
          resourceType: parsed.resourceType,
          bytes,
        });
      } else {
        newDocs.push({ ...entry, bytes });
      }
      documentsUpdated++;
      changed = true;
    }
    if (changed) {
      asset.documents = newDocs;
      await asset.save();
      assetsUpdated++;
      console.log(`Updated asset _id=${asset._id} name="${asset.name}"`);
    }
  }

  console.log(
    `\nDone. Scanned ${assets.length} asset(s). ` +
    `Updated ${documentsUpdated} document(s) across ${assetsUpdated} asset(s). ` +
    `Skipped ${documentsSkipped} document(s) whose size could not be resolved ` +
    `(likely deleted from Cloudinary or not a Cloudinary asset).`
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Script error:", err);
  process.exit(1);
});