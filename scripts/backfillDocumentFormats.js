require("dotenv").config();
const mongoose = require("mongoose");
const { fileTypeFromBuffer } = require("file-type");
const Asset = require("../models/Asset");
const { cloudinary, mintSignedUrl } = require("../utils/cloudinary");
const DELAY_MS = 200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MIME_TO_EXT = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};
const CFB_MIME = "application/x-cfb";
async function resourceExists(publicId) {
  try {
    await cloudinary.api.resource(publicId, { resource_type: "raw", type: "authenticated" });
    return true;
  } catch {
    return false;
  }
}
async function downloadBuffer(entry) {
  const url = mintSignedUrl(entry, 5 * 60);
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
async function detectExt(buffer) {
  const detected = await fileTypeFromBuffer(buffer).catch(() => null);
  if (!detected || detected.mime === CFB_MIME) return null;
  return MIME_TO_EXT[detected.mime] || null;
}
async function repairMismatchedId(entry) {
  const bareExists = await resourceExists(entry.publicId);
  await sleep(DELAY_MS);
  if (bareExists) return null;
  const combinedId = `${entry.publicId}.${entry.format}`;
  const combinedExists = await resourceExists(combinedId);
  await sleep(DELAY_MS);
  if (!combinedExists) return "not_found";
  return { ...entry, publicId: combinedId };
}
async function fixMissingFormat(entry) {
  const buffer = await downloadBuffer(entry);
  await sleep(DELAY_MS);
  if (!buffer) return "no_url";
  const ext = await detectExt(buffer);
  if (!ext) return "undetectable";
  const newPublicId = `${entry.publicId}.${ext}`;
  await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { public_id: newPublicId, resource_type: "raw", type: "authenticated", overwrite: true },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    stream.end(buffer);
  });
  await sleep(DELAY_MS);
  return { ...entry, publicId: newPublicId, format: ext };
}
async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error("Set MONGODB_URI (or MONGO_URI) before running this script.");
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log("Connected. Scanning assets collection for raw documents needing repair...\n");
  const assets = await Asset.find({});
  let assetsUpdated = 0;
  let documentsFixed = 0;
  let documentsSkipped = 0;
  for (const asset of assets) {
    const docs = asset.documents || [];
    let changed = false;
    const newDocs = [];
    for (const entry of docs) {
      const isRaw = entry && typeof entry === "object" && entry.publicId && (entry.resourceType || "raw") === "raw";
      if (!isRaw) {
        newDocs.push(entry);
        continue;
      }
      try {
        let result;
        if (entry.format) {
          result = await repairMismatchedId(entry);
        } else {
          result = await fixMissingFormat(entry);
        }
        if (result === null) {
          newDocs.push(entry);
        } else if (typeof result === "string") {
          console.warn(`  ! Skipped publicId=${entry.publicId} (${result})`);
          documentsSkipped++;
          newDocs.push(entry);
        } else {
          console.log(`  Fixed publicId=${entry.publicId} -> ${result.publicId} (format=${result.format})`);
          newDocs.push(result);
          documentsFixed++;
          changed = true;
        }
      } catch (err) {
        console.warn(`  ! Failed on publicId=${entry.publicId}: ${err.message}`);
        documentsSkipped++;
        newDocs.push(entry);
      }
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
      `Fixed ${documentsFixed} document(s) across ${assetsUpdated} asset(s). ` +
      `Skipped ${documentsSkipped} document(s) — legacy .doc/.xls need manual review, ` +
      `or nothing was found on Cloudinary under either candidate id.`
  );
  await mongoose.disconnect();
}
main().catch((err) => {
  console.error("Script error:", err);
  process.exit(1);
});
