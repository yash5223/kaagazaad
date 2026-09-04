const express = require("express");
const multer = require("multer");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const {execFile: execFile} = require("child_process");
const {fileTypeFromFile: fileTypeFromFile} = require("file-type");
const router = express.Router();
const authMiddleware = require("../middleware/authMiddleware");
const {asyncHandler: asyncHandler} = require("../middleware/errorHandler");
const {getFieldSpecs: getFieldSpecs, keyFromLabel: keyFromLabel} = require("../config/fieldLabels");
const uploadDir = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, {
    recursive: true
  });
}
const RECEIPT_ALLOWED_EXTENSIONS = new Set([ "jpg", "jpeg", "png", "webp", "heic", "heif", "pdf", "doc", "docx", "xls", "xlsx" ]);
const RECEIPT_ALLOWED_MIMES = new Set([ "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/x-cfb" ]);
const CFB_EXTENSIONS = new Set([ "doc", "xls" ]);
const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 15 * 1024 * 1024
  },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || "").replace(".", "").toLowerCase();
    if (!RECEIPT_ALLOWED_EXTENSIONS.has(ext)) {
      return cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "Only JPG, PNG, WEBP, HEIC/HEIF images, PDF, DOC/DOCX or XLS/XLSX files are accepted for scanning."));
    }
    return cb(null, true);
  }
});
async function verifyReceiptImage(req, res, next) {
  if (!req.file) return next();
  try {
    const claimedExt = path.extname(req.file.originalname || "").replace(".", "").toLowerCase();
    const detected = await fileTypeFromFile(req.file.path);
    const mime = detected && detected.mime;
    if (!mime || !RECEIPT_ALLOWED_MIMES.has(mime)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({
        error: "The uploaded file is not a supported image, PDF, DOC/DOCX or XLS/XLSX file."
      });
    }
    if (mime === "application/x-cfb" && !CFB_EXTENSIONS.has(claimedExt)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({
        error: "This file looks like a legacy Office document but its extension does not match its contents."
      });
    }
    req.file.detectedMime = mime;
    req.file.detectedExt = mime === "application/x-cfb" ? claimedExt : detected.ext || claimedExt;
    return next();
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    console.error("[scan-receipt] file verification error:", err);
    return res.status(400).json({
      error: "Could not verify the uploaded file."
    });
  }
}
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434/api/generate";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1:8b";
function normalizeDate(rawValue) {
  if (!rawValue) return "";
  const trimmed = String(rawValue).trim();
  if (!trimmed) return "";
  let match = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) {
    const [, y, m, d] = match;
    return toIsoDate(y, m, d);
  }
  match = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match) {
    const [, d, m, y] = match;
    return toIsoDate(y, m, d);
  }
  return "";
}
function toIsoDate(year, month, day) {
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);
  if (m < 1 || m > 12 || d < 1 || d > 31) return "";
  const check = new Date(y, m - 1, d);
  if (check.getFullYear() !== y || check.getMonth() !== m - 1 || check.getDate() !== d) return "";
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
const HINT_HIERARCHY = {
  Personal: {
    "Identity & Legal": [ "Aadhaar Card", "PAN Card", "Passport", "Driving Licence", "Voter ID", "Birth Certificate", "Marriage Certificate", "Name Change Affidavit", "Ration Card" ],
    "Government Certificates": [ "Domicile Certificate", "Caste Certificate", "Income Certificate", "Non-Creamy Layer Certificate" ],
    Financial: [ "Bank Account Documents", "Fixed Deposits (FDs)", "Mutual Funds (MF)", "IT Returns", "Form 16", "Loan Documents" ],
    Insurance: [ "Health Insurance", "Life Insurance", "Vehicle Insurance", "Home Insurance", "Travel Insurance" ],
    Healthcare: [ "Medical Reports", "Prescriptions", "Vaccinations", "Blood Group Information" ],
    Property: [ "Purchase Documents", "Sale Deed", "Lease Agreement", "Property Tax" ],
    Vehicle: [ "RC Book", "PUC", "Service History", "Purchase Warranty", "Road Tax" ],
    "Gadgets/Appliances": [ "Refrigerator", "Washing Machine", "Laptop", "Robo Cleaner", "User Manual", "AMC", "Service Record" ],
    Jewellery: [ "Hallmark Certificate", "Valuation Certificate" ],
    Travel: [ "Flight Ticket", "Hotel Booking", "Visa", "Foreign Exchange Records" ],
    Education: [ "10th Marksheet", "12th Marksheet", "Semester Marksheet", "Hall Ticket / Admit Card", "Transfer Certificate (TC)", "Bonafide Certificate", "School/College ID Card" ],
    "Utilities & Bills": [ "Electricity Bill", "Water Bill", "Gas Bill", "Broadband/Internet Bill", "Mobile Bill" ]
  },
  Professional: {
    Employment: [ "Appointment Letter", "Offer Letter", "Experience Certificate", "Relieving Letter", "Salary Slip", "Promotion Letters", "Appraisal" ],
    Certification: [ "AI Course", "Degree", "Memberships" ],
    "IP (Intellectual Property)": [ "Patent Application", "Granted Patent", "Trademark", "Copyright" ],
    Business: [ "GST Documents", "Company Registration", "MSME", "TAN", "Licenses" ],
    "Awards & Recognition": [ "Awards", "Recognition Documents" ]
  },
  Corporate: {
    "Company Formation & Registration": [ "Certificate of Incorporation", "MOA", "AOA", "Registration Documents" ],
    "Board & Shareholder Documents": [ "Board Resolutions", "Shareholder Resolutions", "Meeting Minutes", "Share Certificates" ],
    "Corporate Governance & Compliance": [ "Compliance Documents", "Corporate Policies", "Annual Filings", "Statutory Registers" ],
    "Contracts & Commercial": [ "Client Contracts", "Vendor Agreements", "Service Agreements", "Purchase Agreements" ],
    "Finance & Tax": [ "GST Documents", "Tax Documents", "Audited Financial Statements" ],
    "Intellectual Property": [ "Trademark Documents", "Copyright Documents", "Patent Documents", "IP Assignment Agreements" ]
  },
  Legal: {
    "Client Management": [ "Client Profiles", "Identity Proof", "Engagement Letters" ],
    "Court Documents": [ "Evidence", "Orders", "Affidavits", "Petitions" ],
    Agreements: [ "NDA", "Partnership", "Proprietorship", "MOUs" ],
    Patents: [ "Patent Documents" ],
    "Corporate Legal": [ "Corporate Legal Documents" ],
    "Litigation Calendar": [ "Litigation-related Calendar Documents" ]
  }
};
function normalizeHintText(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
const HINT_ENTRIES = [];
for (const [category, subCats] of Object.entries(HINT_HIERARCHY)) {
  for (const [subCategory, items] of Object.entries(subCats)) {
    for (const documentType of items) {
      HINT_ENTRIES.push({
        category: category,
        subCategory: subCategory,
        documentType: documentType,
        normalized: normalizeHintText(documentType)
      });
    }
  }
}
function classifyFromHint(hint) {
  const normalizedHint = normalizeHintText(hint);
  if (normalizedHint.length < 3) return null;
  let best = null;
  for (const entry of HINT_ENTRIES) {
    if (entry.normalized.length < 3) continue;
    const matches = normalizedHint.includes(entry.normalized) || entry.normalized.includes(normalizedHint);
    if (!matches) continue;
    if (!best || entry.normalized.length > best.normalized.length) best = entry;
  }
  if (!best) return null;
  return {
    category: best.category,
    subCategory: best.subCategory,
    documentType: best.documentType
  };
}
const PYTHON_BIN = process.env.PYTHON_BIN || "python3";
const OCR_PIPELINE_SCRIPT = path.join(__dirname, "..", "scripts", "ocr_pipeline.py");
const OCR_MODEL_PATH = path.join(__dirname, "..", "scripts", "classifier_model.joblib");
const OCR_FEEDBACK_PATH = path.join(__dirname, "..", "scripts", "training_data.jsonl");
const OCR_LOW_TIER_DB_PATH = path.join(__dirname, "..", "scripts", "low_tier_value_store.json");
const OCR_SUBPROCESS_TIMEOUT_MS = 90 * 1e3;
async function runOcrPipeline(filePath, documentTypeHint) {
  const args = [ OCR_PIPELINE_SCRIPT, filePath, "--model", OCR_MODEL_PATH, "--feedback", OCR_FEEDBACK_PATH, "--low-tier-db", OCR_LOW_TIER_DB_PATH ];
  if (documentTypeHint) {
    args.push("--document-type-hint", documentTypeHint);
  }
  const {stdout: stdout} = await new Promise((resolve, reject) => {
    execFile(PYTHON_BIN, args, {
      timeout: OCR_SUBPROCESS_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024
    }, (err, stdoutData, stderrData) => {
      if (err) {
        const message = stderrData && stderrData.trim() || stdoutData && stdoutData.trim() || err.message;
        return reject(new Error(`OCR pipeline subprocess failed: ${message}`));
      }
      resolve({
        stdout: stdoutData,
        stderr: stderrData
      });
    });
  });
  try {
    return JSON.parse(stdout);
  } catch (parseErr) {
    throw new Error(`OCR pipeline returned invalid JSON: ${parseErr.message}`);
  }
}
function runOcrPipelineCli(extraArgs) {
  return new Promise((resolve, reject) => {
    execFile(PYTHON_BIN, [ OCR_PIPELINE_SCRIPT, ...extraArgs ], {
      timeout: OCR_SUBPROCESS_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024
    }, (err, stdoutData, stderrData) => {
      if (err) {
        const message = stderrData && stderrData.trim() || stdoutData && stdoutData.trim() || err.message;
        return reject(new Error(`OCR pipeline learning step failed: ${message}`));
      }
      resolve(stdoutData);
    });
  });
}
async function learnDocumentType(rawText, documentType) {
  if (!rawText || !documentType) return;
  const tmpPath = path.join(uploadDir, `learn_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  await fsp.writeFile(tmpPath, JSON.stringify({
    ocr: {
      raw_text: rawText
    }
  }));
  try {
    await runOcrPipelineCli([ "--correct", tmpPath, documentType, "--feedback", OCR_FEEDBACK_PATH ]);
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}
async function learnConfirmedFields(documentType, fields) {
  if (!documentType || !fields || typeof fields !== "object") return;
  const cleanFields = {};
  for (const [label, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    const str = String(value).trim();
    if (str) cleanFields[label] = str;
  }
  if (Object.keys(cleanFields).length === 0) return;
  await runOcrPipelineCli([ "--confirm-fields", documentType, JSON.stringify(cleanFields), "--low-tier-db", OCR_LOW_TIER_DB_PATH ]);
}
function trackTemp(list, filePath) {
  list.push(filePath);
  return filePath;
}
function cleanupTempFiles(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) fs.unlink(p, () => {});
  }
}
async function withExtension(tempFiles, sourcePath, ext) {
  const target = `${sourcePath}.${ext}`;
  await fsp.copyFile(sourcePath, target);
  return trackTemp(tempFiles, target);
}
router.post("/scan-receipt", authMiddleware, upload.single("image"), verifyReceiptImage, async (req, res) => {
  const tempFiles = [];
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "No file uploaded"
      });
    }
    trackTemp(tempFiles, req.file.path);
    const mime = req.file.detectedMime;
    let ext = req.file.detectedExt;
    let sourcePath = req.file.path;
    if (mime === "image/heic" || mime === "image/heif") {
      const convert = require("heic-convert");
      const heicBuffer = await fsp.readFile(sourcePath);
      const jpegBuffer = await convert({
        buffer: heicBuffer,
        format: "JPEG",
        quality: .92
      });
      sourcePath = trackTemp(tempFiles, path.join(uploadDir, `heic_${req.file.filename}.jpg`));
      await fsp.writeFile(sourcePath, jpegBuffer);
      ext = "jpg";
    } else if (mime === "image/webp") {
      const sharp = require("sharp");
      const jpegPath = trackTemp(tempFiles, path.join(uploadDir, `webp_${req.file.filename}.jpg`));
      await sharp(sourcePath).jpeg({
        quality: 92
      }).toFile(jpegPath);
      sourcePath = jpegPath;
      ext = "jpg";
    }
    const inputPath = await withExtension(tempFiles, sourcePath, ext);
    const documentTypeHint = typeof req.body.documentTypeHint === "string" ? req.body.documentTypeHint.trim() : "";
    const hintedClassification = classifyFromHint(documentTypeHint);
    let pipelineResult;
    try {
      pipelineResult = await runOcrPipeline(inputPath, hintedClassification ? hintedClassification.documentType : null);
    } catch (ocrErr) {
      console.error("[OCR pipeline] failed:", ocrErr);
      cleanupTempFiles(tempFiles);
      return res.status(500).json({
        error: "Something went wrong while reading this document. Please try again shortly."
      });
    }
    cleanupTempFiles(tempFiles);
    const cleanedText = pipelineResult.ocr && pipelineResult.ocr.raw_text ? pipelineResult.ocr.raw_text.trim() : "";
    // --- Debug logging: prints exactly what OCR read and what the pipeline
    // extracted, so field-extraction gaps (e.g. "why wasn't Aadhaar Number
    // filled") can be diagnosed from the server console without needing to
    // touch the DB or the frontend. Set OCR_DEBUG=0 to silence this.
    if (process.env.OCR_DEBUG !== "0") {
      console.log("\n========== [scan-receipt] OCR DEBUG ==========");
      console.log(`[scan-receipt] avg_confidence=${pipelineResult.ocr && pipelineResult.ocr.average_confidence} ensemble=${pipelineResult.ocr && pipelineResult.ocr.ensemble_method}`);
      console.log("[scan-receipt] RAW OCR TEXT:\n" + (cleanedText || "(empty — nothing was read from this file)"));
      const du = pipelineResult.document_understanding || {};
      console.log(`[scan-receipt] classified as: ${du.domain} / ${du.category} / ${du.document_type} (confidence=${du.classification_confidence}, method=${du.classification_method})`);
      if (du.compulsory_fields && du.compulsory_fields.required_fields) {
        console.log(`[scan-receipt] compulsory fields (${du.compulsory_fields.found_count}/${du.compulsory_fields.total_count} found):`);
        for (const [label, info] of Object.entries(du.compulsory_fields.required_fields)) {
          console.log(`    ${info.found ? "[x]" : "[ ]"} ${label}: ${info.found ? info.value : "(not found)"}${info.matched_by ? ` (${info.matched_by})` : ""}`);
        }
      } else {
        console.log("[scan-receipt] compulsory_fields: none (document type has no required-field template)");
      }
      if (du.low_tier_fields && du.low_tier_fields.fields && Object.keys(du.low_tier_fields.fields).length) {
        console.log("[scan-receipt] low-tier fields:", JSON.stringify(du.low_tier_fields.fields, null, 2));
      }
      if (pipelineResult.validation) {
        console.log("[scan-receipt] validation flags:", pipelineResult.validation.flags);
      }
    }
    if (!cleanedText) {
      return res.status(200).json({
        success: true,
        extracted: false
      });
    }
    const understanding = pipelineResult.document_understanding || {};
    const classification = hintedClassification || {
      category: understanding.domain || "Personal",
      subCategory: understanding.category || "Gadgets/Appliances",
      documentType: understanding.document_type || "Purchase Invoice"
    };
    let parsed = {
      category: classification.category,
      subCategory: classification.subCategory,
      documentType: classification.documentType
    };
    const compulsory = understanding.compulsory_fields;
    if (compulsory && compulsory.required_fields) {
      for (const [label, info] of Object.entries(compulsory.required_fields)) {
        if (info && info.found && info.value) parsed[keyFromLabel(label)] = info.value;
      }
    }
    const lowTier = understanding.low_tier_fields;
    if (lowTier && lowTier.fields) {
      for (const [label, info] of Object.entries(lowTier.fields)) {
        if (info && info.found && info.value) parsed[keyFromLabel(label)] = info.value;
      }
    }
    parsed.name = parsed.name || parsed.fullName || parsed.studentFullName || parsed.applicantName || parsed.patientName || parsed.employeeName || parsed.customerName || parsed.consumerName || parsed.ownerName || parsed.recipientName || parsed.guestName || parsed.passengerName || parsed.policyholderName || parsed.accountHolderName || parsed.investorName || parsed.borrowerName || parsed.headOfFamilyName || "";
    parsed.documentNumber = parsed.documentNumber || parsed.certificateNumber || parsed.registrationNumber || parsed.policyNumber || parsed.accountNumber || parsed.aadhaarNumber || parsed.panNumber || parsed.passportNumber || parsed.rationCardNumber || "";
    const rawDate = parsed.dateOfIssue || parsed.date || parsed.issueDate || parsed.dueDate || "";
    parsed.date = normalizeDate(rawDate) || rawDate;
    parsed.issuingAuthority = parsed.issuingAuthority || parsed.providerName || parsed.insuranceCompany || parsed.employerCompanyName || "";
    const meaningfulCount = Object.entries(parsed).filter(([k, v]) => ![ "category", "subCategory", "documentType" ].includes(k) && v !== undefined && v !== null && String(v).trim() !== "").length;
    if (meaningfulCount < 3) {
      try {
        const knownSpecs = getFieldSpecs(classification.subCategory, classification.documentType);
        let prompt;
        if (knownSpecs) {
          const fieldList = knownSpecs.map(s => `${s.key} (${s.label})`).join(", ");
          prompt = "Extract these fields from the document text below and respond with ONLY valid JSON, no explanation, no markdown fences.\n" + `Fields (JSON key and what it means): ${fieldList}.\n` + "Dates must be formatted YYYY-MM-DD. If a field is not found use an empty string.\n\nDocument text:\n" + cleanedText;
        } else {
          prompt = "Extract these fields from the receipt text below and respond with ONLY valid JSON, no explanation, no markdown fences.\n" + 'Fields: name, brand (manufacturer), store (seller/vendor the item was bought from - keep this SEPARATE from brand), date (YYYY-MM-DD), amount (number only, no currency symbol), invoiceNumber, documentNumber, expiryDate (YYYY-MM-DD or empty string), notes, category (always "Personal"), subCategory (one of Property, Vehicle, "Gadgets & Appliances", Jewellery, Insurance), documentType (a specific leaf type such as "Purchase Invoice", "RC Book", "Sale Deeds"), specField1, specField2.\n' + "If a field is not found use an empty string.\n\nReceipt text:\n" + cleanedText;
        }
        const ollamaRes = await fetch(OLLAMA_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: OLLAMA_MODEL,
            prompt: prompt,
            format: "json",
            stream: false
          })
        });
        if (ollamaRes.ok) {
          const ollamaJson = await ollamaRes.json();
          const llmParsed = JSON.parse(ollamaJson.response);
          if (llmParsed.store) {
            llmParsed.storeOrSeller = llmParsed.store;
            llmParsed.issuingAuthority = llmParsed.store;
          }
          for (const [key, value] of Object.entries(llmParsed)) {
            if (value === undefined || value === null || String(value).trim() === "") continue;
            if (parsed[key] === undefined || parsed[key] === null || String(parsed[key]).trim() === "") {
              parsed[key] = value;
            }
          }
          parsed.date = normalizeDate(parsed.date) || parsed.date;
          parsed.issueDate = normalizeDate(parsed.issueDate) || parsed.issueDate;
          parsed.dateOfIssue = normalizeDate(parsed.dateOfIssue) || parsed.dateOfIssue;
          parsed.expiryDate = normalizeDate(parsed.expiryDate) || parsed.expiryDate;
        }
      } catch (llmError) {
        console.error("Backup LLM extraction failed, returning pipeline field map:", llmError);
      }
    }
    if (process.env.OCR_DEBUG !== "0") {
      console.log("[scan-receipt] FINAL parsed fields sent to frontend:", JSON.stringify(parsed, null, 2));
      console.log("========== [scan-receipt] END DEBUG ==========\n");
    }
    return res.status(200).json({
      success: true,
      extracted: true,
      data: parsed,
      rawText: cleanedText,
      ocrWords: []
    });
  } catch (err) {
    cleanupTempFiles(tempFiles);
    console.error("[server error]", err);
    return res.status(500).json({
      error: "Something went wrong on our end. Please try again shortly."
    });
  }
});
router.post("/confirm-extraction", authMiddleware, asyncHandler(async (req, res) => {
  const {documentType: documentType, rawText: rawText, fields: fields} = req.body || {};
  if (!documentType) {
    return res.status(400).json({
      error: "documentType is required."
    });
  }
  const learnedFields = [];
  const warnings = [];
  // A user confirming (or correcting) the classification/fields after a scan
  // is a strong, human-verified signal. Feed it back into the same
  // classifier-feedback log and value-history DB the OCR pipeline learns
  // from automatically, so accuracy and auto-fill coverage keep improving
  // the more documents people confirm.
  try {
    if (typeof rawText === "string" && rawText.trim()) {
      await learnDocumentType(rawText, documentType);
    }
  } catch (err) {
    console.error("[confirm-extraction] classification learning failed:", err);
    warnings.push("classification_learning_failed");
  }
  try {
    if (fields && typeof fields === "object") {
      await learnConfirmedFields(documentType, fields);
      learnedFields.push(...Object.keys(fields));
    }
  } catch (err) {
    console.error("[confirm-extraction] field learning failed:", err);
    warnings.push("field_learning_failed");
  }
  return res.status(200).json({
    success: true,
    learnedFields: learnedFields,
    warnings: warnings
  });
}));
module.exports = router;