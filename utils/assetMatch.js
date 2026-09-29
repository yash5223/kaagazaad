// Duplicate detection & text search now happen in application code: asset fields are
// encrypted at rest, so MongoDB can no longer run regex / date-range filters on them.
// Assets are always fetched per user (indexed by the userId blind index) first.
const Asset = require("../models/Asset");

const normDocNumber = v => String(v).toUpperCase().replace(/[\s-]+/g, "");
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

async function findDuplicateAsset(userId, {documentNumber, name, issueDate} = {}) {
  const docNo = documentNumber ? normDocNumber(String(documentNumber).trim()) : "";
  const cleanName = name ? String(name).trim().toLowerCase() : "";
  const issue = issueDate ? new Date(String(issueDate).trim()) : null;
  const issueOk = issue && !isNaN(issue.getTime());
  if (!docNo && !(cleanName && issueOk)) return null;
  const assets = await Asset.find({userId});
  return assets.find(a => {
    if (docNo && a.documentNumber && normDocNumber(String(a.documentNumber)) === docNo) return true;
    if (cleanName && issueOk && a.issueDate && String(a.name || "").trim().toLowerCase() === cleanName) {
      const d = new Date(a.issueDate);
      return !isNaN(d.getTime()) && sameDay(d, issue);
    }
    return false;
  }) || null;
}

function filterAssetsBySearch(assets, search) {
  const q = String(search || "").trim().toLowerCase();
  if (!q) return assets;
  const hit = v => v != null && String(v).toLowerCase().includes(q);
  return assets.filter(a => hit(a.name) || hit(a.subSubCategory) || hit(a.storeOrSeller));
}

module.exports = {findDuplicateAsset, filterAssetsBySearch};
