const express = require("express");
const router = express.Router();
const User = require("../models/User");
const Asset = require("../models/Asset");
const authMiddleware = require("../middleware/authMiddleware");
const {uploadBufferToCloudinary: uploadBufferToCloudinary, deleteFromCloudinaryByUrl: deleteFromCloudinaryByUrl, resolveDocumentUrl: resolveDocumentUrl, documentEntryMatches: documentEntryMatches} = require("../utils/cloudinary");
const {createAlert: createAlert, checkExpiryAlerts: checkExpiryAlerts} = require("./alertRoutes");
const {documentUpload: documentUpload} = require("../middleware/upload");
const {fileTypeGuard: fileTypeGuard} = require("../middleware/fileTypeGuard");
const {validate: validate, validateAssetDataField: validateAssetDataField, schemas: schemas} = require("../middleware/validators");
const {asyncHandler: asyncHandler} = require("../middleware/errorHandler");
const {logSecurityEvent: logSecurityEvent} = require("../utils/securityLog");
router.use(authMiddleware);
function serializeAsset(assetDoc) {
  const plain = assetDoc.toObject ? assetDoc.toObject() : {
    ...assetDoc
  };
  const rawDocuments = plain.documents || [];
  plain.documentsSizeBytes = rawDocuments.reduce((sum, entry) => {
    if (entry && typeof entry === "object" && typeof entry.bytes === "number") {
      return sum + entry.bytes;
    }
    return sum;
  }, 0);
  plain.documents = rawDocuments.map(entry => resolveDocumentUrl(entry)).filter(Boolean);
  return plain;
}
router.post("/save-asset", documentUpload.array("images", 10), fileTypeGuard(), validate(schemas.saveAssetBody), validateAssetDataField, asyncHandler(async (expressRequest, expressResponse) => {
  const assetData = expressRequest.assetData;
  const userMatch = await User.findById(expressRequest.user.id);
  if (!userMatch) {
    return expressResponse.status(401).json({
      error: "Invalid user account credentials."
    });
  }
  const assetDocuments = [];
  const uploadedFiles = expressRequest.files || [];
  if (uploadedFiles.length > 0) {
    const sanitizedAssetName = assetData.name.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
    const timestamp = Date.now();
    for (let i = 0; i < uploadedFiles.length; i++) {
      const file = uploadedFiles[i];
      const fileIndex = String(i + 1).padStart(2, "0");
      const publicId = `${userMatch.customer_id}_${sanitizedAssetName}_${fileIndex}_${timestamp}`;
      const uploaded = await uploadBufferToCloudinary(file.buffer, publicId, file.verifiedResourceType);
      assetDocuments.push(uploaded);
    }
  }
  const documentTypeValue = assetData.subSubCategory || assetData.documentType || "";
  const editAssetId = assetData._id || assetData.id;
  const isEdit = Boolean(editAssetId);
  const KNOWN_META_KEYS = new Set([ "_id", "id", "name", "category", "subCategory", "subSubCategory", "documentType", "issueDate", "notesOrAddress", "storeOrSeller" ]);
  const dynamicFields = {};
  for (const [key, rawValue] of Object.entries(assetData)) {
    if (KNOWN_META_KEYS.has(key)) continue;
    if (rawValue === undefined || rawValue === null) continue;
    const trimmed = String(rawValue).trim();
    dynamicFields[key] = trimmed === "" || trimmed === "-" ? "" : trimmed;
  }
  const assetFields = {
    userId: userMatch.customer_id,
    name: assetData.name,
    category: assetData.category,
    subCategory: assetData.subCategory,
    subSubCategory: documentTypeValue,
    ...dynamicFields
  };
  if (assetData.issueDate) {
    assetFields.issueDate = new Date(assetData.issueDate);
  }
  if (assetData.notesOrAddress !== undefined && assetData.notesOrAddress !== null && String(assetData.notesOrAddress).trim() !== "") {
    assetFields.notesOrAddress = assetData.notesOrAddress;
  }
  if (assetData.storeOrSeller !== undefined && assetData.storeOrSeller !== null && String(assetData.storeOrSeller).trim() !== "") {
    assetFields.storeOrSeller = assetData.storeOrSeller;
  }
  if (assetDocuments.length > 0) {
    assetFields.documents = assetDocuments;
  }
  let savedAsset;
  if (isEdit) {
    savedAsset = await Asset.findOneAndUpdate({
      _id: editAssetId,
      userId: userMatch.customer_id
    }, {
      $set: assetFields
    }, {
      new: true,
      runValidators: true
    });
    if (!savedAsset) {
      return expressResponse.status(404).json({
        error: "Asset to update was not found."
      });
    }
    if (assetDocuments.length > 0) {
      savedAsset.documents = [ ...savedAsset.documents || [], ...assetDocuments ];
      await savedAsset.save();
    }
  } else {
    savedAsset = new Asset({
      ...assetFields,
      documents: assetDocuments
    });
    await savedAsset.save();
  }
  await createAlert({
    title: isEdit ? "Document Updated" : "Document Added",
    message: isEdit ? `"${savedAsset.name}" was updated in your vault.` : `"${savedAsset.name}" was added to your vault.`,
    type: "success",
    priority: "low",
    sent_by: userMatch.fullName || userMatch.email,
    sent_to: userMatch.customer_id
  });
  return expressResponse.status(201).json({
    success: true,
    message: "Asset successfully saved to vault.",
    asset: serializeAsset(savedAsset)
  });
}));
router.post("/append-document", documentUpload.single("image"), fileTypeGuard(), validate(schemas.appendDocumentBody), asyncHandler(async (req, res) => {
  const {assetId: assetId} = req.body;
  if (!req.file) {
    return res.status(400).json({
      error: "Missing parameters or file data."
    });
  }
  const user = await User.findById(req.user.id);
  const asset = await Asset.findOne({
    _id: assetId,
    userId: req.user.customer_id
  });
  if (!user || !asset) {
    return res.status(404).json({
      error: "Asset parameters not found."
    });
  }
  const currentCount = asset.documents ? asset.documents.length : 0;
  const nextIndex = String(currentCount + 1).padStart(2, "0");
  const sanitizedName = asset.name.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
  const publicId = `${user.customer_id}_${sanitizedName}_${nextIndex}_${Date.now()}`;
  const uploaded = await uploadBufferToCloudinary(req.file.buffer, publicId, req.file.verifiedResourceType);
  asset.documents = asset.documents || [];
  asset.documents.push(uploaded);
  await asset.save();
  return res.status(200).json({
    success: true,
    documents: serializeAsset(asset).documents
  });
}));
router.delete("/delete-document", validate(schemas.deleteDocumentBody), asyncHandler(async (req, res) => {
  const {assetId: assetId, filename: filename} = req.body;
  const asset = await Asset.findOne({
    _id: assetId,
    userId: req.user.customer_id
  });
  if (!asset) {
    return res.status(404).json({
      error: "Asset record not found."
    });
  }
  const matched = (asset.documents || []).find(entry => documentEntryMatches(entry, filename));
  if (!matched) {
    return res.status(404).json({
      error: "Document not found on this asset."
    });
  }
  asset.documents = asset.documents.filter(entry => entry !== matched);
  await asset.save();
  await deleteFromCloudinaryByUrl(matched);
  return res.status(200).json({
    success: true,
    documents: serializeAsset(asset).documents
  });
}));
router.post("/log-download", validate(schemas.logDownloadBody), asyncHandler(async (req, res) => {
  const {assetId: assetId} = req.body;
  const asset = await Asset.findOne({
    _id: assetId,
    userId: req.user.customer_id
  });
  if (!asset) {
    return res.status(404).json({
      error: "Asset record not found."
    });
  }
  logSecurityEvent("document_downloaded", {
    req: req,
    userId: req.user.customer_id,
    email: req.user.email,
    meta: {
      assetId: assetId,
      assetName: asset.name
    }
  });
  await createAlert({
    title: "Document Downloaded",
    message: `"${asset.name}" was downloaded to a device.`,
    type: "info",
    priority: "low",
    sent_by: "System",
    sent_to: asset.userId
  });
  return res.status(200).json({
    success: true
  });
}));
router.get("/dashboard-summary", asyncHandler(async (expressRequest, expressResponse) => {
  const userMatch = await User.findById(expressRequest.user.id);
  if (!userMatch) {
    return expressResponse.status(404).json({
      error: "User account profile not found."
    });
  }
  const userAssets = await Asset.find({
    userId: userMatch.customer_id
  });
  await checkExpiryAlerts(userMatch, userAssets);
  let totalValue = 0;
  let activeCount = 0;
  let expiredCount = 0;
  const rightNow = new Date;
  userAssets.forEach(asset => {
    totalValue += Number(asset.valueAmount) || 0;
    if (asset.category === "Property") {
      activeCount++;
    } else if (asset.expiryDate) {
      const expiryDate = new Date(asset.expiryDate);
      if (!isNaN(expiryDate.getTime()) && expiryDate < rightNow) {
        expiredCount++;
      } else {
        activeCount++;
      }
    } else {
      activeCount++;
    }
  });
  return expressResponse.status(200).json({
    success: true,
    metrics: {
      totalAssets: userAssets.length,
      totalValue: Math.round(totalValue),
      activeAssets: activeCount,
      expiredAssets: expiredCount
    }
  });
}));
router.post("/append-service-record", validate(schemas.serviceRecordBody), asyncHandler(async (req, res) => {
  const {assetId: assetId, title: title, date: date, cost: cost, notes: notes} = req.body;
  const asset = await Asset.findOne({
    _id: assetId,
    userId: req.user.customer_id
  });
  if (!asset) {
    return res.status(404).json({
      error: "Target asset record not found."
    });
  }
  asset.serviceRecords = asset.serviceRecords || [];
  asset.serviceRecords.push({
    title: title,
    date: new Date(date),
    cost: cost,
    notes: notes
  });
  await asset.save();
  return res.status(200).json({
    success: true,
    serviceRecords: asset.serviceRecords
  });
}));
router.put("/edit-service-record", validate(schemas.editServiceRecordBody), asyncHandler(async (req, res) => {
  const {assetId: assetId, recordId: recordId, title: title, date: date, cost: cost, notes: notes} = req.body;
  const asset = await Asset.findOne({
    _id: assetId,
    userId: req.user.customer_id
  });
  if (!asset) {
    return res.status(404).json({
      error: "Target asset record not found."
    });
  }
  const record = asset.serviceRecords.id(recordId);
  if (!record) {
    return res.status(404).json({
      error: "Service record not found."
    });
  }
  record.title = title;
  record.date = new Date(date);
  record.cost = cost;
  record.notes = notes;
  await asset.save();
  return res.status(200).json({
    success: true,
    serviceRecords: asset.serviceRecords
  });
}));
router.delete("/delete-service-record", validate(schemas.deleteServiceRecordBody), asyncHandler(async (req, res) => {
  const {assetId: assetId, recordId: recordId} = req.body;
  const asset = await Asset.findOne({
    _id: assetId,
    userId: req.user.customer_id
  });
  if (!asset) {
    return res.status(404).json({
      error: "Target asset record not found."
    });
  }
  const record = asset.serviceRecords.id(recordId);
  if (!record) {
    return res.status(404).json({
      error: "Service record not found."
    });
  }
  record.deleteOne();
  await asset.save();
  return res.status(200).json({
    success: true,
    serviceRecords: asset.serviceRecords
  });
}));
router.delete("/delete-asset/:id", validate(schemas.assetIdParam, "params"), asyncHandler(async (req, res) => {
  const assetId = req.params.id;
  const asset = await Asset.findOne({
    _id: assetId,
    userId: req.user.customer_id
  });
  if (!asset) {
    return res.status(404).json({
      error: "Asset record not found."
    });
  }
  const filesToDelete = asset.documents || [];
  await Promise.all(filesToDelete.map(entry => deleteFromCloudinaryByUrl(entry)));
  await Asset.findByIdAndDelete(assetId);
  logSecurityEvent("document_deleted", {
    req: req,
    userId: req.user.customer_id,
    email: req.user.email,
    meta: {
      assetId: assetId,
      assetName: asset.name
    }
  });
  await createAlert({
    title: "Document Deleted",
    message: `"${asset.name}" was removed from your vault.`,
    type: "warning",
    priority: "medium",
    sent_by: "System",
    sent_to: asset.userId
  });
  return res.status(200).json({
    success: true,
    message: "Asset and all associated files deleted successfully."
  });
}));
router.get("/fetch-assets", asyncHandler(async (expressRequest, expressResponse) => {
  const {search: search} = expressRequest.query;
  const userMatch = await User.findById(expressRequest.user.id);
  if (!userMatch) {
    return expressResponse.status(404).json({
      error: "User account profile not found."
    });
  }
  let queryConditions = {
    userId: userMatch.customer_id
  };
  if (search && search.trim() !== "") {
    const searchRegex = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    queryConditions.$or = [ {
      name: searchRegex
    }, {
      subSubCategory: searchRegex
    }, {
      storeOrSeller: searchRegex
    } ];
  }
  const userAssets = await Asset.find(queryConditions).sort({
    createdAt: -1
  });
  await checkExpiryAlerts(userMatch, userAssets);
  return expressResponse.status(200).json({
    success: true,
    assets: userAssets.map(serializeAsset)
  });
}));
module.exports = router;