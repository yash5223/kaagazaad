const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const router = express.Router();
const User = require('../models/User');
const Asset = require('../models/Asset');
const { buildDynamicFields } = require('../config/documentFieldTemplates');
const { uploadBufferToCloudinary, deleteFromCloudinaryByUrl } = require('../utils/cloudinary');
const { createAlert, checkExpiryAlerts } = require('./alertRoutes');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
router.post('/save-asset', upload.array('images', 10), async (expressRequest, expressResponse) => {
  try {
    const { email, password } = expressRequest.body;
    if (!expressRequest.body.assetData) {
      return expressResponse.status(400).json({ error: 'Asset parameters are missing.' });
    }
    const assetData = JSON.parse(expressRequest.body.assetData);
    if (!email || !password) {
      return expressResponse.status(401).json({ error: 'Authentication credentials required.' });
    }
    const userMatch = await User.findOne({ email: email.toLowerCase().trim() });
    if (!userMatch) {
      return expressResponse.status(401).json({ error: 'Invalid user account credentials.' });
    }
    const isPasswordValid = await bcrypt.compare(password, userMatch.passwordHash);
    if (!isPasswordValid) {
      return expressResponse.status(401).json({ error: 'Invalid user account credentials.' });
    }
    const assetDocuments = [];
    const uploadedFiles = expressRequest.files || [];
    if (uploadedFiles.length > 0) {
      const sanitizedAssetName = assetData.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
      const timestamp = Date.now();
      for (let i = 0; i < uploadedFiles.length; i++) {
        const fileIndex = String(i + 1).padStart(2, '0');
        const publicId = `${userMatch.customer_id}_${sanitizedAssetName}_${fileIndex}_${timestamp}`;
        const secureUrl = await uploadBufferToCloudinary(uploadedFiles[i].buffer, publicId);
        assetDocuments.push(secureUrl);
      }
    }
    // subSubCategory doubles as "document type" (they were always the same
    // value, so we no longer store them as two separate fields). Fall back
    // to a legacy `documentType` key in case any caller still sends that
    // name instead of `subSubCategory`.
    const documentTypeValue = assetData.subSubCategory || assetData.documentType || '';

    // Only the dynamic fields that are actually relevant to this document
    // type get a real value; everything else on the schema is explicitly
    // stored as '' (see config/documentFieldTemplates.js).
    // E.g. Personal > Gadgets & Appliances > Mobile Phone currently maps to
    // the default field set (documentNumber, issuingAuthority, expiryDate,
    // valueAmount) — invoiceNumber would be stored as '' for that type.
    const dynamicFields = buildDynamicFields(documentTypeValue, assetData);

    const issueDateValue = assetData.issueDate;
    const storeOrSellerValue = assetData.storeOrSeller || '';

    const editAssetId = assetData._id || assetData.id;
    const isEdit = Boolean(editAssetId);

    const assetFields = {
      userId: userMatch.customer_id,
      name: assetData.name,
      category: assetData.category,
      subCategory: assetData.subCategory,
      subSubCategory: documentTypeValue,
      issueDate: issueDateValue ? new Date(issueDateValue) : null,
      notesOrAddress: assetData.notesOrAddress || '',
      storeOrSeller: storeOrSellerValue,
      ...dynamicFields,
    };
    // Only touch `documents` if new images were actually uploaded this time,
    // otherwise we'd wipe out the asset's existing document list on a plain
    // details edit.
    if (assetDocuments.length > 0) {
      assetFields.documents = assetDocuments;
    }

    let savedAsset;
    if (isEdit) {
      // Update the existing asset in place. Using findByIdAndUpdate (rather
      // than creating a fresh document) is what preserves the asset's
      // original `_id` and its existing `serviceRecords` / `documents`
      // subdocuments — previously every edit created a brand-new duplicate
      // Asset with an empty serviceRecords array, orphaning the original
      // one and breaking edit/delete of its service records (the app kept
      // referencing an `_id` whose sibling duplicate no longer matched).
      savedAsset = await Asset.findOneAndUpdate(
        { _id: editAssetId, userId: userMatch.customer_id },
        { $set: assetFields },
        { new: true, runValidators: true }
      );
      if (!savedAsset) {
        return expressResponse.status(404).json({ error: 'Asset to update was not found.' });
      }
      if (assetDocuments.length > 0) {
        savedAsset.documents = [...(savedAsset.documents || []), ...assetDocuments];
        await savedAsset.save();
      }
    } else {
      savedAsset = new Asset({ ...assetFields, documents: assetDocuments });
      await savedAsset.save();
    }

    await createAlert({
      title: isEdit ? 'Document Updated' : 'Document Added',
      message: isEdit
        ? `"${savedAsset.name}" was updated in your vault.`
        : `"${savedAsset.name}" was added to your vault.`,
      type: 'success',
      priority: 'low',
      sent_by: userMatch.fullName || userMatch.email,
      sent_to: userMatch.customer_id,
    });
    return expressResponse.status(201).json({ success: true, message: 'Asset successfully saved to vault.', asset: savedAsset });
  } catch (serverError) {
    return expressResponse.status(500).json({ error: serverError.message });
  }
});
router.post('/append-document', upload.single('image'), async (req, res) => {
  try {
    const { assetId, email } = req.body;
    if (!req.file || !assetId || !email) {
      return res.status(400).json({ error: 'Missing parameters or file data.' });
    }
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    const asset = await Asset.findById(assetId);
    if (!user || !asset) {
      return res.status(404).json({ error: 'Asset parameters not found.' });
    }
    const currentCount = asset.documents ? asset.documents.length : 0;
    const nextIndex = String(currentCount + 1).padStart(2, '0');
    const sanitizedName = asset.name.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const publicId = `${user.customer_id}_${sanitizedName}_${nextIndex}_${Date.now()}`;
    const secureUrl = await uploadBufferToCloudinary(req.file.buffer, publicId);
    asset.documents = asset.documents || [];
    asset.documents.push(secureUrl);
    await asset.save();
    return res.status(200).json({ success: true, documents: asset.documents });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
router.delete('/delete-document', async (req, res) => {
  try {
    const { assetId, filename } = req.body;
    if (!assetId || !filename) {
      return res.status(400).json({ error: 'Asset ID and filename are required parameters.' });
    }
    const asset = await Asset.findById(assetId);
    if (!asset) {
      return res.status(404).json({ error: 'Asset record not found.' });
    }
    asset.documents = asset.documents.filter(doc => doc !== filename);
    await asset.save();
    await deleteFromCloudinaryByUrl(filename);
    return res.status(200).json({ success: true, documents: asset.documents });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
router.get('/dashboard-summary', async (expressRequest, expressResponse) => {
  try {
    const { email } = expressRequest.query;
    if (!email) {
      return expressResponse.status(400).json({ error: 'Email parameter is required.' });
    }
    const userMatch = await User.findOne({ email: email.toLowerCase().trim() });
    if (!userMatch) {
      return expressResponse.status(404).json({ error: 'User account profile not found.' });
    }
    const userAssets = await Asset.find({ userId: userMatch.customer_id });
    await checkExpiryAlerts(userMatch, userAssets);
    let totalValue = 0;
    let activeCount = 0;
    let expiredCount = 0;
    const rightNow = new Date();
    userAssets.forEach(asset => {
      totalValue += asset.valueAmount || 0;
      if (asset.category === 'Property') {
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
  } catch (serverError) {
    return expressResponse.status(500).json({ error: serverError.message });
  }
});
router.post('/append-service-record', async (req, res) => {
  try {
    const { assetId, title, date, cost, notes } = req.body;
    if (!assetId || !title || !date || !cost) {
      return res.status(400).json({ error: 'Missing mandatory record parameters.' });
    }
    const asset = await Asset.findById(assetId);
    if (!asset) {
      return res.status(404).json({ error: 'Target asset record not found.' });
    }
    asset.serviceRecords = asset.serviceRecords || [];
    asset.serviceRecords.push({
      title,
      date: new Date(date),
      cost: parseFloat(cost) || 0,
      notes: notes || '-'
    });
    await asset.save();
    return res.status(200).json({ success: true, serviceRecords: asset.serviceRecords });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
router.put('/edit-service-record', async (req, res) => {
  try {
    const { assetId, recordId, title, date, cost, notes } = req.body;
    if (!assetId || !recordId || !title || !date || !cost) {
      return res.status(400).json({ error: 'Missing mandatory record parameters.' });
    }
    const asset = await Asset.findById(assetId);
    if (!asset) {
      return res.status(404).json({ error: 'Target asset record not found.' });
    }
    const record = asset.serviceRecords.id(recordId);
    if (!record) {
      return res.status(404).json({ error: 'Service record not found.' });
    }
    record.title = title;
    record.date = new Date(date);
    record.cost = parseFloat(cost) || 0;
    record.notes = notes || '-';
    await asset.save();
    return res.status(200).json({ success: true, serviceRecords: asset.serviceRecords });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
router.delete('/delete-service-record', async (req, res) => {
  try {
    const { assetId, recordId } = req.body;
    if (!assetId || !recordId) {
      return res.status(400).json({ error: 'Asset ID and record ID are required parameters.' });
    }
    const asset = await Asset.findById(assetId);
    if (!asset) {
      return res.status(404).json({ error: 'Target asset record not found.' });
    }
    const record = asset.serviceRecords.id(recordId);
    if (!record) {
      return res.status(404).json({ error: 'Service record not found.' });
    }
    record.deleteOne();
    await asset.save();
    return res.status(200).json({ success: true, serviceRecords: asset.serviceRecords });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
router.delete('/delete-asset/:id', async (req, res) => {
  try {
    const assetId = req.params.id;
    const asset = await Asset.findById(assetId);
    if (!asset) {
      return res.status(404).json({ error: 'Asset record not found.' });
    }
    const filesToDelete = asset.documents || [];
    await Promise.all(filesToDelete.map(filename => deleteFromCloudinaryByUrl(filename)));
    await Asset.findByIdAndDelete(assetId);
    await createAlert({
      title: 'Document Deleted',
      message: `"${asset.name}" was removed from your vault.`,
      type: 'warning',
      priority: 'medium',
      sent_by: 'System',
      sent_to: asset.userId,
    });
    return res.status(200).json({ success: true, message: 'Asset and all associated files deleted successfully.' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
router.get('/fetch-assets', async (expressRequest, expressResponse) => {
  try {
    const { email, search } = expressRequest.query;
    if (!email) {
      return expressResponse.status(400).json({ error: 'Email parameter is required.' });
    }
    const userMatch = await User.findOne({ email: email.toLowerCase().trim() });
    if (!userMatch) {
      return expressResponse.status(404).json({ error: 'User account profile not found.' });
    }
    let queryConditions = { userId: userMatch.customer_id };
    if (search && search.trim() !== '') {
      const searchRegex = new RegExp(search.trim(), 'i');
      queryConditions.$or = [
        { name: searchRegex },
        { subSubCategory: searchRegex },
        { storeOrSeller: searchRegex }
      ];
    }
    const userAssets = await Asset.find(queryConditions).sort({ createdAt: -1 });
    await checkExpiryAlerts(userMatch, userAssets);
    return expressResponse.status(200).json({
      success: true,
      assets: userAssets
    });
  } catch (serverError) {
    return expressResponse.status(500).json({ error: serverError.message });
  }
});
module.exports = router;