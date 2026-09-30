require("dotenv").config();
const mongoose = require("mongoose");
const Asset = require("../models/Asset");
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  let n = 0, bad = 0;
  for await (const raw of Asset.collection.find({})) {
    n++;
    const d = raw.documents;
    const kind = Array.isArray(d) ? "array" : typeof d === "string" ? (d.startsWith("enc:v1:") ? "legacy enc:v1 string" : d.startsWith("enc:v2:") ? "enc:v2 string" : "plain string") : d === undefined ? "missing" : typeof d;
    if (kind !== "enc:v2 string" && kind !== "array" && kind !== "missing") { bad++; console.log(String(raw._id), raw.e2ee ? "(e2ee)" : "", kind); }
  }
  console.log(`Scanned ${n} assets, ${bad} with unexpected documents shape.`);
  await mongoose.disconnect();
})();
