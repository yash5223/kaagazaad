const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { fileTypeFromFile } = require('file-type');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { asyncHandler } = require('../middleware/errorHandler');
const { getFieldSpecs, keyFromLabel } = require('../config/fieldLabels');
const OcrTemplate = require('../models/OcrTemplate');
const { learnTemplate, applyBestTemplate } = require('../utils/ocrTemplates');
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const RECEIPT_ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf', 'doc', 'docx', 'xls', 'xlsx']);
const RECEIPT_ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/x-cfb',
]);
const CFB_EXTENSIONS = new Set(['doc', 'xls']);
const MAX_PDF_PAGES_FOR_OCR = 3;
const MIN_EMBEDDED_TEXT_CHARS = 40;
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || '').replace('.', '').toLowerCase();
    if (!RECEIPT_ALLOWED_EXTENSIONS.has(ext)) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only JPG, PNG, WEBP, HEIC/HEIF images, PDF, DOC/DOCX or XLS/XLSX files are accepted for scanning.'));
    }
    return cb(null, true);
  },
});
async function verifyReceiptImage(req, res, next) {
  if (!req.file) return next();
  try {
    const claimedExt = path.extname(req.file.originalname || '').replace('.', '').toLowerCase();
    const detected = await fileTypeFromFile(req.file.path);
    const mime = detected && detected.mime;
    if (!mime || !RECEIPT_ALLOWED_MIMES.has(mime)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'The uploaded file is not a supported image, PDF, DOC/DOCX or XLS/XLSX file.' });
    }
    if (mime === 'application/x-cfb' && !CFB_EXTENSIONS.has(claimedExt)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'This file looks like a legacy Office document but its extension does not match its contents.' });
    }
    req.file.detectedMime = mime;
    req.file.detectedExt = mime === 'application/x-cfb' ? claimedExt : (detected.ext || claimedExt);
    return next();
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    console.error('[scan-receipt] file verification error:', err);
    return res.status(400).json({ error: 'Could not verify the uploaded file.' });
  }
}
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';
function extract(regex, text) {
  const match = text.match(regex);
  if (!match) return "";
  return (match[1] || match[0]).trim();
}
function normalizeDate(rawValue) {
  if (!rawValue) return '';
  const trimmed = String(rawValue).trim();
  if (!trimmed) return '';
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
  return '';
}
function toIsoDate(year, month, day) {
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);
  if (m < 1 || m > 12 || d < 1 || d > 31) return '';
  const check = new Date(y, m - 1, d);
  if (check.getFullYear() !== y || check.getMonth() !== m - 1 || check.getDate() !== d) return '';
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
// Tidies up whitespace noise that both Tesseract OCR and PDF text extraction tend to
// introduce (stray tabs, repeated blank lines, trailing spaces) so the regexes below
// match reliably regardless of which extraction path produced the text.
function cleanOcrText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
// Counts how many of a set of regexes match `text`. Used to score a document
// against several category "profiles" at once and pick the best fit, instead
function scoreSignals(text, patterns) {
  return patterns.reduce((sum, p) => sum + (p.test(text) ? 1 : 0), 0);
}
const EDUCATION_SIGNALS = [
  /\bthis is to certify that\b/i,
  /\bhas been awarded\b/i,
  /\bhas successfully completed\b/i,
  /\bhas passed\b/i,
  /\bdegree of\b/i,
  /\bbachelor of\b/i,
  /\bmaster of\b/i,
  /\bdiploma in\b/i,
  /\buniversity\b/i,
  /\bvidyapeeth\b/i,
  /\binstitute of technology\b/i,
  /\bconvocation\b/i,
  /\b(cgpa|sgpa)\b/i,
  /\bsemester\b/i,
  /\bgrade card\b/i,
  /\bmark ?sheet\b/i,
  /\btranscript\b/i,
  /\bstatement of marks\b/i,
  /\bseat no\.?\b/i,
  /\bprn\b/i,
  /\benrol(l)?ment no\.?\b/i,
];
// Marksheets (school-level or semester) overlap heavily with degree-certificate
// wording, so they share the same EDUCATION_SIGNALS scoring pass; this narrower
// set is only used afterwards to decide marksheet vs degree, and school vs
// university level, once "education" has already won the category contest.
const MARKSHEET_SIGNALS = [
  /\bmark ?sheet\b/i,
  /\bgrade card\b/i,
  /\bstatement of marks\b/i,
  /\btranscript\b/i,
  /\bsemester\b/i,
  /\b(cgpa|sgpa)\b/i,
  /\bssc\b/i,
  /\bhsc\b/i,
  /\bboard of secondary education\b/i,
  /\bboard of (?:higher )?secondary education\b/i,
];
const TENTH_SIGNALS = [/\b10th\b/i, /\bssc\b/i, /\bsecondary school certificate\b/i, /\bx\s*std\b/i, /\bclass\s*x\b/i];
const TWELFTH_SIGNALS = [/\b12th\b/i, /\bhsc\b/i, /\bhigher secondary certificate\b/i, /\bxii\s*std\b/i, /\bclass\s*xii\b/i, /\bintermediate\b/i];
const UTILITY_SIGNALS = [/\belectricity\b/i, /\bwater bill\b/i, /\bgas bill\b/i, /\bbroadband\b/i, /\binternet bill\b/i, /\bmobile bill\b/i, /\bpostpaid\b/i, /\bunits consumed\b/i, /\bmeter (?:no|number)\b/i, /\bbill amount\b/i, /\bdue date\b/i, /\bconsumer (?:no|number)\b/i];
const RATION_SIGNALS = [/\bration card\b/i, /\bpublic distribution\b/i, /\bfair price shop\b/i, /\bhead of family\b/i, /\bapl\b/i, /\bbpl\b/i];
// Domicile/caste/income certificates are issued by the same revenue-office
// machinery (Tehsildar, SDM, Collector, Mandal/Taluka office) with common
// boilerplate ("this is to certify that ... is a resident of / belongs to
// ... caste / has an annual income of ..."), so one signal set scores the
// whole "Government Certificates" group and a keyword pass below picks the
// specific type.
const GOV_CERT_SIGNALS = [
  /\bdomicile\b/i,
  /\bresident(?:ial)? certificate\b/i,
  /\bcaste certificate\b/i,
  /\bincome certificate\b/i,
  /\bnon[- ]?creamy layer\b/i,
  /\btehsildar\b/i,
  /\bsub[- ]?divisional (?:magistrate|officer)\b/i,
  /\bsdm\b/i,
  /\bcollector\b/i,
  /\brevenue department\b/i,
  /\bmandal\b/i,
  /\btaluka\b/i,
  /\bannual income\b/i,
];
const VEHICLE_SIGNALS = [/\bcar\b/i, /\bmotorcycle\b/i, /\bsuv\b/i, /\bsedan\b/i, /\bmileage\b/i, /\bvin\b/i, /\bregistration number\b/i, /\bchassis\b/i, /\bpuc\b/i];
const JEWELLERY_SIGNALS = [/\bgold\b/i, /\bdiamond\b/i, /\bcarat\b/i, /\bpurity\b/i, /\bjewel+ery\b/i, /\bnecklace\b/i, /\bring\b/i, /\bsilver\b/i, /\bhallmark\b/i];
const PROPERTY_SIGNALS = [/\bflat\b/i, /\bapartment\b/i, /\bvilla\b/i, /\bplot\b/i, /\bkhata\b/i, /\brera\b/i, /\bsale deed\b/i, /\bbuilt[- ]?up area\b/i];
const INSURANCE_SIGNALS = [/\bpolicy\b/i, /\binsurer\b/i, /\bsum insured\b/i, /\bsum assured\b/i, /\bpremium\b/i];
const GADGET_SIGNALS = [/\bphone\b/i, /\bsmartphone\b/i, /\blaptop\b/i, /\bmacbook\b/i, /\bsmartwatch\b/i, /\btablet\b/i, /\bipad\b/i, /\btv\b/i, /\btelevision\b/i, /\brefrigerator\b/i, /\bfridge\b/i, /\bac\b/i, /\bwasher\b/i, /\bdryer\b/i, /\bmicrowave\b/i];
function classifyDocument(text) {
  const candidates = [
    { score: scoreSignals(text, EDUCATION_SIGNALS), category: 'Professional', subCategory: 'Certification', documentType: 'Degree' },
    { score: scoreSignals(text, VEHICLE_SIGNALS), category: 'Personal', subCategory: 'Vehicle', documentType: /\bpuc\b/i.test(text) ? 'PUC' : 'RC Book' },
    { score: scoreSignals(text, JEWELLERY_SIGNALS), category: 'Personal', subCategory: 'Jewellery', documentType: /hallmark/i.test(text) ? 'Hallmark Certificate' : 'Purchase Invoice' },
    { score: scoreSignals(text, PROPERTY_SIGNALS), category: 'Personal', subCategory: 'Property', documentType: /sale deed/i.test(text) ? 'Sale Deed' : 'Purchase Documents' },
    { score: scoreSignals(text, INSURANCE_SIGNALS), category: 'Personal', subCategory: 'Insurance', documentType: (() => {
        if (/\bvehicle\b/i.test(text)) return 'Vehicle Insurance';
        if (/\blife\b/i.test(text)) return 'Life Insurance';
        if (/\bhome\b/i.test(text)) return 'Home Insurance';
        if (/\btravel\b/i.test(text)) return 'Travel Insurance';
        return 'Health Insurance';
      })() },
    { score: scoreSignals(text, GADGET_SIGNALS), category: 'Personal', subCategory: 'Gadgets/Appliances', documentType: 'Purchase Invoice' },
    { score: scoreSignals(text, UTILITY_SIGNALS), category: 'Personal', subCategory: 'Utilities & Bills', documentType: (() => {
        if (/\belectricity\b/i.test(text)) return 'Electricity Bill';
        if (/\bwater\b/i.test(text)) return 'Water Bill';
        if (/\bgas\b/i.test(text)) return 'Gas Bill';
        if (/\bbroadband\b|\binternet\b/i.test(text)) return 'Broadband/Internet Bill';
        if (/\bmobile\b|\bpostpaid\b/i.test(text)) return 'Mobile Bill';
        return 'Other';
      })() },
    { score: scoreSignals(text, RATION_SIGNALS), category: 'Personal', subCategory: 'Identity & Legal', documentType: 'Ration Card' },
    { score: scoreSignals(text, GOV_CERT_SIGNALS), category: 'Personal', subCategory: 'Government Certificates', documentType: (() => {
        if (/non[- ]?creamy layer/i.test(text)) return 'Non-Creamy Layer Certificate';
        if (/\bdomicile\b|\bresident(?:ial)? certificate\b/i.test(text)) return 'Domicile Certificate';
        if (/\bcaste certificate\b|\bcaste\b/i.test(text)) return 'Caste Certificate';
        if (/\bincome certificate\b|\bannual income\b/i.test(text)) return 'Income Certificate';
        return 'Other';
      })() },
  ];
  const education = candidates[0];
  if (education.score < 2) education.score = 0;
  let best = candidates[0];
  for (const c of candidates) {
    if (c.score > best.score) best = c;
  }
  if (best.score === 0) {
    return { category: 'Personal', subCategory: 'Gadgets/Appliances', documentType: 'Purchase Invoice' };
  }
  let result = { category: best.category, subCategory: best.subCategory, documentType: best.documentType };
  // Education wins the category contest for both degree certificates and
  // marksheets (they share wording like "university", "cgpa", "seat no").
  // Only once education has already won do we split marksheet vs degree,
  // and school-level (SSC/HSC) vs semester-level, using the narrower signals.
  if (result.subCategory === 'Certification' && result.documentType === 'Degree') {
    const looksLikeDegree = /\b(degree of|bachelor of|master of|convocation|has been awarded)\b/i.test(text);
    const looksLikeMarksheet = scoreSignals(text, MARKSHEET_SIGNALS) >= 2;
    if (looksLikeMarksheet && !looksLikeDegree) {
      let eduDocType = 'Semester Marksheet';
      if (scoreSignals(text, TWELFTH_SIGNALS) > 0) eduDocType = '12th Marksheet';
      else if (scoreSignals(text, TENTH_SIGNALS) > 0) eduDocType = '10th Marksheet';
      result = { category: 'Personal', subCategory: 'Education', documentType: eduDocType };
    }
  }
  return result;
}
const HINT_HIERARCHY = {
  Personal: {
    'Identity & Legal': ['Aadhaar Card', 'PAN Card', 'Passport', 'Driving Licence', 'Voter ID', 'Birth Certificate', 'Marriage Certificate', 'Name Change Affidavit', 'Ration Card'],
    'Government Certificates': ['Domicile Certificate', 'Caste Certificate', 'Income Certificate', 'Non-Creamy Layer Certificate'],
    Financial: ['Bank Account Documents', 'Fixed Deposits (FDs)', 'Mutual Funds (MF)', 'IT Returns', 'Form 16', 'Loan Documents'],
    Insurance: ['Health Insurance', 'Life Insurance', 'Vehicle Insurance', 'Home Insurance', 'Travel Insurance'],
    Healthcare: ['Medical Reports', 'Prescriptions', 'Vaccinations', 'Blood Group Information'],
    Property: ['Purchase Documents', 'Sale Deed', 'Lease Agreement', 'Property Tax'],
    Vehicle: ['RC Book', 'PUC', 'Service History', 'Purchase Warranty', 'Road Tax'],
    'Gadgets/Appliances': ['Refrigerator', 'Washing Machine', 'Laptop', 'Robo Cleaner', 'User Manual', 'AMC', 'Service Record'],
    Jewellery: ['Hallmark Certificate', 'Valuation Certificate'],
    Travel: ['Flight Ticket', 'Hotel Booking', 'Visa', 'Foreign Exchange Records'],
    Education: ['10th Marksheet', '12th Marksheet', 'Semester Marksheet', 'Hall Ticket / Admit Card', 'Transfer Certificate (TC)', 'Bonafide Certificate', 'School/College ID Card'],
    'Utilities & Bills': ['Electricity Bill', 'Water Bill', 'Gas Bill', 'Broadband/Internet Bill', 'Mobile Bill'],
  },
  Professional: {
    Employment: ['Appointment Letter', 'Offer Letter', 'Experience Certificate', 'Relieving Letter', 'Salary Slip', 'Promotion Letters', 'Appraisal'],
    Certification: ['AI Course', 'Degree', 'Memberships'],
    'IP (Intellectual Property)': ['Patent Application', 'Granted Patent', 'Trademark', 'Copyright'],
    Business: ['GST Documents', 'Company Registration', 'MSME', 'TAN', 'Licenses'],
    'Awards & Recognition': ['Awards', 'Recognition Documents'],
  },
  Corporate: {
    'Company Formation & Registration': ['Certificate of Incorporation', 'MOA', 'AOA', 'Registration Documents'],
    'Board & Shareholder Documents': ['Board Resolutions', 'Shareholder Resolutions', 'Meeting Minutes', 'Share Certificates'],
    'Corporate Governance & Compliance': ['Compliance Documents', 'Corporate Policies', 'Annual Filings', 'Statutory Registers'],
    'Contracts & Commercial': ['Client Contracts', 'Vendor Agreements', 'Service Agreements', 'Purchase Agreements'],
    'Finance & Tax': ['GST Documents', 'Tax Documents', 'Audited Financial Statements'],
    'Intellectual Property': ['Trademark Documents', 'Copyright Documents', 'Patent Documents', 'IP Assignment Agreements'],
  },
  Legal: {
    'Client Management': ['Client Profiles', 'Identity Proof', 'Engagement Letters'],
    'Court Documents': ['Evidence', 'Orders', 'Affidavits', 'Petitions'],
    Agreements: ['NDA', 'Partnership', 'Proprietorship', 'MOUs'],
    Patents: ['Patent Documents'],
    'Corporate Legal': ['Corporate Legal Documents'],
    'Litigation Calendar': ['Litigation-related Calendar Documents'],
  },
};
function normalizeHintText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
// Flattened once at module load: [{ category, subCategory, documentType, normalized }]
const HINT_ENTRIES = [];
for (const [category, subCats] of Object.entries(HINT_HIERARCHY)) {
  for (const [subCategory, items] of Object.entries(subCats)) {
    for (const documentType of items) {
      HINT_ENTRIES.push({ category, subCategory, documentType, normalized: normalizeHintText(documentType) });
    }
  }
}
// Resolves a free-text hint like "aadhaar card" or "health insurance policy"
// to a concrete category/subCategory/documentType by matching it against the
// known document-type names above. Picks the longest matching name so e.g.
// "life insurance policy" prefers "Life Insurance" over a shorter partial
// match. Returns null (falls back to OCR-text classification) if nothing
// matches closely enough — very short fragments are ignored to avoid false
// positives.
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
  return { category: best.category, subCategory: best.subCategory, documentType: best.documentType };
}
// University-agnostic on purpose: every pattern below matches generic
// certificate/marksheet wording ("This is to certify that ...", "degree of
// ...", "Seat No.", "CGPA") rather than any specific university's name or
// board, so it works for SPPU, any other university, or any school board
// alike. Covers both degree certificates (Certification|Degree) and
// marksheets (Education|10th Marksheet, Education|12th Marksheet,
// Education|Semester Marksheet) —
// `classification` (from classifyDocument/classifyFromHint) decides which
// output shape to fill so the keys line up with that document type's fields
// in config/fieldLabels.js.
function parseEducationCertificate(classification, text) {
  const { category, subCategory, documentType } = classification;
  // Real marksheets label this "Name of Candidate"/"Name of Student" (not
  // bare "Name"), and OCR frequently drops or mangles the colon between a
  // label and its value on scanned/table-heavy layouts (e.g. "Seat No. 1 1.
  // B190412345" where "1 1." is OCR noise standing in for the missing
  // colon). These patterns tolerate that noise instead of requiring the
  // label to sit immediately next to a clean separator.
  const name = extract(/name\s+of\s+(?:candidate|student)[^A-Za-z\r\n]{0,8}([A-Z][A-Za-z.'-]+(?:[^\S\r\n]+[A-Z][A-Za-z.'-]+){1,4})/i, text)
    || extract(/(?:this is to certify that|certify that)[^\S\r\n]*(?:mr\.?|ms\.?|mrs\.?|shri\.?|smt\.?|kumari|km\.?)?[^\S\r\n]*([A-Z][A-Za-z.'-]+(?:[^\S\r\n]+[A-Z][A-Za-z.'-]+){1,4})/i, text)
    || extract(/\bname\s*[: ][^\S\r\n]*([A-Z][A-Za-z.'-]+(?:[^\S\r\n]+[A-Z][A-Za-z.'-]+){1,4})/i, text);
  const instituteLine = extract(/^.*\b(?:university|vidyapeeth|institute of technology|board of [a-z ]+ education|school|college)\b.*$/im, text);
  const instituteClean = instituteLine ? instituteLine.replace(/\s{2,}/g, ' ').trim() : '';
  const degreeName = extract(/\b((?:bachelor|master) of [A-Za-z .&()]+|diploma in [A-Za-z .&()]+|b\.?\s?e\.?|b\.?\s?tech\.?|m\.?\s?e\.?|m\.?\s?tech\.?|b\.?\s?sc\.?|m\.?\s?sc\.?|b\.?\s?com\.?|m\.?\s?com\.?|ph\.?\s?d\.?)\b/i, text);
  const branch = extract(/\(([A-Za-z &,.]{3,60})\)/, text)
    || extract(/(?:branch|specialization|stream|course)\s*(?:of|in)?\s*[: ]\s*([A-Za-z &]+)/i, text);
  const seatNumber = extract(/(?:seat\s*no\.?|exam\s*seat\s*no\.?)(?:[^A-Za-z0-9\r\n]{0,5}\d{1,2}){0,3}[^A-Za-z0-9\r\n]{0,5}\b([A-Z]{0,3}\d{6,12})\b/i, text)
    || extract(/(?:seat\s*no\.?|exam\s*seat\s*no\.?|roll\s*no\.?)\s*[: ]\s*([A-Za-z0-9/-]+)/i, text);
  const enrollmentNumber = extract(/(?:enrol{1,2}ment\s*no\.?)\s*[: ]\s*([A-Za-z0-9/-]+)/i, text)
    || extract(/\bprn\s*(?:no\.?)?[^0-9\r\n]{0,10}(\d{9,14})\b/i, text)
    || extract(/\bprn\s*[: ]\s*([A-Za-z0-9/-]+)/i, text);
  const certificateNumber = extract(/certificate\s*no\.?\s*[: ]\s*([A-Za-z0-9/-]+)/i, text);
  const classOrGrade = extract(/\b(first class with distinction|first class|higher second class|second class|pass class|distinction|honou?rs)\b/i, text);
  const cgpa = extract(/\b[cs]gpa\s*[: ]\s*([\d.]{1,5})/i, text);
  const percentage = extract(/\b(\d{1,3}(?:\.\d+)?)\s*%/, text);
  const dateOfIssue = normalizeDate(extract(/(?:dated|date of issue|convocation date|issued on)\s*[: ]\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})/i, text));
  const yearOfPassing = extract(/\b(?:19|20)\d{2}\b/, text);
  const semester = extract(/\bsem(?:ester)?\s*[: ]?\s*([IVXLCivxlc\d]{1,4})\b/i, text);
  const result = extract(/\b(pass(?:ed)?|fail(?:ed)?|reappear|distinction)\b/i, text);
  const classCgpaPercentage = classOrGrade || (cgpa ? `CGPA ${cgpa}` : '') || (percentage ? `${percentage}%` : '');
  const totalMarksPercentage = percentage ? `${percentage}%` : classOrGrade || '';
  const legacy = {
    name: name || '',
    issuingAuthority: instituteClean,
    documentNumber: certificateNumber || enrollmentNumber || seatNumber || '',
    date: dateOfIssue || '',
    category,
    subCategory,
    documentType,
  };
  if (subCategory === 'Education') {
    if (documentType === 'Semester Marksheet') {
      return {
        studentFullName: name || '',
        universityInstituteName: instituteClean,
        courseBranch: branch ? branch.trim() : '',
        semester: semester || '',
        seatNumberRollNumber: seatNumber || '',
        prnEnrollmentNumber: enrollmentNumber || '',
        sgpaCgpa: cgpa || '',
        result: result || '',
        dateOfIssue: dateOfIssue || '',
        ...legacy,
      };
    }
    // 10th/12th Marksheet and any other Education document type share this
    // school-level shape; unmapped labels are simply left unset.
    return {
      studentFullName: name || '',
      schoolBoardName: instituteClean,
      classStandard: branch ? branch.trim() : '',
      seatNumberRollNumber: seatNumber || '',
      totalMarksPercentage,
      grade: classOrGrade || '',
      dateOfIssue: dateOfIssue || '',
      yearOfPassing: yearOfPassing || '',
      ...legacy,
    };
  }
  // Certification|Degree (and any other Certification document type).
  return {
    studentFullName: name || '',
    universityInstituteName: instituteClean,
    degreeName: degreeName ? degreeName.trim() : '',
    branchSpecialization: branch ? branch.trim() : '',
    seatNumberRollNumber: seatNumber || '',
    enrollmentNumberPrn: enrollmentNumber || '',
    classCgpaPercentage,
    certificateNumber: certificateNumber || '',
    dateOfIssue: dateOfIssue || '',
    yearOfPassing: yearOfPassing || '',
    ...legacy,
  };
}
// Generic bill parser shared by Electricity/Water/Gas/Broadband/Mobile bills
// (Utilities & Bills|*) — same layout family (consumer/account name, a bill
// or account number, a billing period, an amount, and a due date), so one
// parser with slightly different label preferences covers all of them.
function parseUtilityBill(text, classification) {
  const { category, subCategory, documentType } = classification;
  const consumerName = extract(/(?:consumer|customer|account holder)\s*name\s*[: ]\s*([A-Za-z .'-]{3,60})/i, text)
    || extract(/\bname\s*[: ]\s*([A-Za-z .'-]{3,60})/i, text);
  const consumerNumber = extract(/(?:consumer|account)\s*(?:no\.?|number|id)\s*[: ]\s*([A-Za-z0-9/-]+)/i, text);
  const billNumber = extract(/(?:bill|invoice)\s*(?:no\.?|number)\s*[: ]\s*([A-Za-z0-9/-]+)/i, text);
  const billingPeriod = extract(/(?:billing period|bill period|billing month)\s*[: ]\s*([A-Za-z0-9 ,.\-\/]{3,30})/i, text);
  const unitsConsumed = extract(/(?:units? consumed|total units)\s*[: ]\s*([\d.,]+)/i, text);
  const meterNumber = extract(/meter\s*(?:no\.?|number)\s*[: ]\s*([A-Za-z0-9/-]+)/i, text);
  const planName = extract(/(?:plan|package)\s*(?:name)?\s*[: ]\s*([A-Za-z0-9 .+-]{3,40})/i, text);
  const billAmount = extract(/(?:bill amount|amount payable|total amount due|net payable|total due)\s*[: ]*₹?\s*([\d,]+(?:\.\d+)?)/i, text)
    || extract(/₹\s*([\d,]+(?:\.\d+)?)/, text);
  const dueDateRaw = extract(/due date\s*[: ]\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})/i, text);
  const dueDate = normalizeDate(dueDateRaw) || dueDateRaw;
  const providerName = extract(/^.*\b(?:electricity board|power|energy|water (?:board|supply)|gas (?:agency|company)|broadband|telecom|communications?)\b.*$/im, text);
  return {
    consumerName: consumerName || '',
    customerName: consumerName || '',
    consumerNumber: consumerNumber || '',
    accountNumber: consumerNumber || '',
    mobileNumber: consumerNumber || '',
    billNumber: billNumber || '',
    billingPeriod: billingPeriod ? billingPeriod.trim() : '',
    unitsConsumed: unitsConsumed || '',
    meterNumber: meterNumber || '',
    planName: planName ? planName.trim() : '',
    billAmount: billAmount || '',
    dueDate: dueDate || '',
    providerName: providerName ? providerName.replace(/\s{2,}/g, ' ').trim() : '',
    // Legacy/common fields.
    name: consumerName || '',
    issuingAuthority: providerName ? providerName.replace(/\s{2,}/g, ' ').trim() : '',
    documentNumber: billNumber || consumerNumber || '',
    date: dueDate || '',
    amount: billAmount || '',
    category,
    subCategory,
    documentType,
  };
}
function parseRationCard(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const headOfFamilyName = extract(/(?:head of (?:the )?family|name of head)\s*[: ]\s*([A-Za-z .'-]{3,60})/i, text)
    || extract(/\bname\s*[: ]\s*([A-Za-z .'-]{3,60})/i, text);
  const rationCardNumber = extract(/ration\s*card\s*(?:no\.?|number)\s*[: ]\s*([A-Za-z0-9/-]+)/i, text);
  const cardType = extract(/\b(APL|BPL|AAY|Antyodaya)\b/i, text).toUpperCase();
  const addressMatch = text.match(/((?:[A-Za-z0-9,./\- ]+\n){0,6}[A-Za-z ]+[-,\s]\d{6})/);
  const address = addressMatch ? addressMatch[1].replace(/\n+/g, ', ').replace(/\s{2,}/g, ' ').trim() : '';
  const dateOfIssue = normalizeDate(extract(/(?:date of issue|issued on)\s*[: ]\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})/i, text));
  return {
    headOfFamilyName: headOfFamilyName || '',
    rationCardNumber: rationCardNumber || '',
    familyMembers: '',
    address,
    cardType: cardType || '',
    issuingAuthority: 'Public Distribution System',
    dateOfIssue: dateOfIssue || '',
    // Legacy/common fields.
    name: headOfFamilyName || '',
    documentNumber: rationCardNumber || '',
    date: dateOfIssue || '',
  };
}
// Shared parser for Domicile/Caste/Income/Non-Creamy Layer certificates
// (Government Certificates|*) — all issued by the same revenue-office
// boilerplate ("... S/o ... is a resident of ... belongs to ... caste ...
// has an annual income of Rs. ..."), so one parser covers all four; unused
// fields for a given documentType are simply left blank by the caller's UI.
function parseGovCertificate(text, classification) {
  const { category: docCategory, subCategory, documentType } = classification;
  const applicantName = extract(/(?:this is to certify that|certify that)[^\S\r\n]*(?:mr\.?|ms\.?|mrs\.?|shri\.?|smt\.?|kumari|km\.?)?[^\S\r\n]*([A-Z][A-Za-z.'-]+(?:[^\S\r\n]+[A-Z][A-Za-z.'-]+){1,4})/i, text)
    || extract(/\bname\s*(?:of applicant)?\s*[: ]\s*([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,4})/i, text);
  const fatherName = extract(/\b(?:s\/o|d\/o|w\/o|son of|daughter of|wife of)\s*[: ]?\s*([A-Z][A-Za-z.'-]+(?:\s+[A-Za-z.'-]+){0,3})/i, text)
    || extract(/father'?s?\s*name\s*[: ]\s*([A-Z][A-Za-z.'-]+(?:\s+[A-Za-z.'-]+){0,3})/i, text);
  const caste = extract(/\bcaste\s*[: ]\s*([A-Za-z ]{3,30})/i, text);
  const casteCategory = extract(/\bcategory\s*[: ]\s*([A-Za-z\/ ]{2,20})/i, text) || extract(/\b(SC|ST|OBC|VJNT|NT|EWS|OPEN)\b/, text);
  const annualIncome = extract(/annual income\s*[: ]*(?:rs\.?|₹)?\s*([\d,]+)/i, text) || extract(/income of\s*(?:rs\.?|₹)?\s*([\d,]+)/i, text);
  const financialYear = extract(/financial year\s*[: ]\s*([\d\-/]{4,10})/i, text);
  const addressMatch = text.match(/((?:[A-Za-z0-9,./\- ]+\n){0,6}[A-Za-z ]+[-,\s]\d{6})/);
  const address = addressMatch ? addressMatch[1].replace(/\n+/g, ', ').replace(/\s{2,}/g, ' ').trim() : '';
  const stateDistrict = extract(/\bdistrict\s*[: ]\s*([A-Za-z ]{2,30})/i, text);
  const certificateNumber = extract(/certificate\s*no\.?\s*[: ]\s*([A-Za-z0-9/-]+)/i, text);
  const issuingAuthorityLine = extract(/^.*\b(?:tehsildar|sub[- ]?divisional (?:magistrate|officer)|sdm|collector|revenue department|district magistrate|mandal|taluka)\b.*$/im, text);
  const dateOfIssue = normalizeDate(extract(/(?:date of issue|issued on|dated)\s*[: ]\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})/i, text));
  const validity = extract(/valid\s*(?:up)?\s*to\s*[: ]?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})/i, text);
  const issuingAuthority = issuingAuthorityLine ? issuingAuthorityLine.replace(/\s{2,}/g, ' ').trim() : '';
  return {
    applicantName: applicantName || '',
    fatherSHusbandSName: fatherName || '',
    fatherSName: fatherName || '',
    caste: caste || '',
    casteCategory: casteCategory || '',
    annualIncome: annualIncome || '',
    financialYear: financialYear || '',
    address,
    stateDistrict: stateDistrict || '',
    certificateNumber: certificateNumber || '',
    issuingAuthority,
    dateOfIssue: dateOfIssue || '',
    validity: validity || '',
    purpose: '',
    certificateTitle: documentType,
    // Legacy/common fields.
    name: applicantName || '',
    documentNumber: certificateNumber || '',
    date: dateOfIssue || '',
    category: docCategory,
    subCategory,
    documentType,
  };
}
const AADHAAR_NUMBER_RE = /\b(\d{4}\s?\d{4}\s?\d{4})\b/;
const PAN_NUMBER_RE = /\b([A-Z]{5}[0-9]{4}[A-Z])\b/;
const VID_RE = /\bVID\b\s*[:.]?\s*(\d{4}\s?\d{4}\s?\d{4}\s?\d{4})/i;
const GENDER_RE = /\b(male|female|transgender)\b/i;
const AADHAAR_DOB_RE = /(?:DOB|Date of Birth|D\.?O\.?B\.?|Year of Birth|YOB)\s*[:.]?\s*(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{4})/i;
const ENROLMENT_ID_RE = /(?:Enrol(?:l)?ment|Update)\s*(?:No\.?|ID)?\s*[:.]?\s*([\d/]{10,})/i;
const HEADER_LINE_RE = /government of india|unique identification|आधार|भारत सरकार|your aadhaar|income tax department|govt\.? of india|permanent account number/i;
function isPlausibleNameLine(line) {
  const trimmed = String(line || '').trim();
  if (trimmed.length < 3) return false;
  return /^[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*)*$/.test(trimmed);
}
// Known ID-number formats for documents that don't have a bespoke parser
// (mirrors AADHAAR_NUMBER_RE / PAN_NUMBER_RE above) — reliable even when the
// value isn't printed with an explicit label next to it.
const PASSPORT_NUMBER_RE = /\b([A-PR-WYa-pr-wy][0-9]{7})\b/; // Indian passport: 1 letter (not Q/X/Z) + 7 digits
const VOTER_ID_RE = /\b([A-Z]{3}[0-9]{7})\b/; // EPIC number
// Turns a FIELD_LABELS-style label like "Father/Mother/Spouse Name" or
// "EPIC / Voter ID Number" into shorter alias phrases, since real documents
// print abbreviated or partial versions of the label ("F/H Name", "Voter ID
// No", "S/o", "DL No") rather than the full spec wording.
// Real documents abbreviate or rephrase FIELD_LABELS wording in ways that
// aren't derivable by mechanically splitting the spec label (e.g. "Sex"
// instead of "Gender", "DL No" instead of "Driving Licence Number", "Elector's
// Name" instead of "Full Name"). Keyed by the normalized full spec label.
// NOTE: keys here must already be normalized (lowercase, punctuation
// collapsed to single spaces) to match how they're looked up below —
// e.g. "Child's Full Name" normalizes to "child s full name", not
// "child's full name".
const LABEL_ALIAS_OVERRIDES = {
  'full name': ["Elector's Name", 'Elector Name', "Holder's Name", 'Holder Name', 'Name'],
  gender: ['Sex'],
  'driving licence number': ['DL No', 'DL No.', 'DLN', 'Licence No', 'License No'],
  'epic voter id number': ['Voter ID No', 'EPIC No', 'Card No', 'EPIC'],
  'passport number': ['Passport No'],
  'father mother spouse name': ['S/o', 'D/o', 'W/o', 'Guardian Name'],
  'father s name': ['S/o', 'Guardian Name'],
  'mother s name': ['D/o'],
  'date of birth': ['DOB'],
  'validity expiry date': ['Valid Till', 'Valid Upto', 'Expiry'],
  'child s full name': ['Name of Child', 'Child Name'],
  'issuing authority': ['Registrar', 'Issued By'],
};
function labelAliases(label) {
  const base = String(label || '');
  const aliases = new Set([base, base.replace(/'s\b/gi, '')]);
  if (base.includes('/') && !/\d/.test(base)) {
    const parts = base.split('/').map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      const lastWords = parts[parts.length - 1].split(' ');
      const suffix = lastWords.length > 1 ? ` ${lastWords.slice(1).join(' ')}` : '';
      for (const p of parts) aliases.add(p.includes(' ') ? p : p + suffix);
    }
  }
  const overrides = LABEL_ALIAS_OVERRIDES[normalizeLabelText(base)];
  if (overrides) overrides.forEach((o) => aliases.add(o));
  return Array.from(aliases).filter(Boolean);
}
function normalizeLabelText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
// Multi-strategy label -> value extractor used for document types that don't
// have a bespoke regex parser. Handles the three layouts real scans commonly
// produce: (1) "Label: Value" / "Label - Value" on one line, (2) "Label" and
// "Value" separated by 2+ spaces on one line (form-style), and (3) "Label"
// alone on a line with the value on the next non-empty line (common when OCR
// reads a boxed field top-to-bottom, the way Aadhaar names sit under a header).
function extractFieldByLabel(lines, label) {
  const variants = labelAliases(label).map(normalizeLabelText).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // Colon is an unambiguous label/value separator; a bare hyphen is only
    // treated as one when it has whitespace on both sides, so it doesn't
    // false-match the hyphens inside dates or ID numbers (e.g. "05-06-2019").
    const colonMatch = line.match(/^(.{2,45}?)\s*(?::\s*|\s-\s)(.{1,80})$/);
    if (colonMatch) {
      const lhs = normalizeLabelText(colonMatch[1]);
      if (variants.some((v) => lhs === v || (v.length > 3 && lhs.startsWith(v)))) {
        const val = colonMatch[2].trim();
        if (val) return val;
      }
    }
    const spacedMatch = line.match(/^(.{2,45}?)\s{2,}(.{1,80})$/);
    if (spacedMatch) {
      const lhs = normalizeLabelText(spacedMatch[1]);
      if (variants.some((v) => lhs === v)) {
        const val = spacedMatch[2].trim();
        if (val) return val;
      }
    }
    const norm = normalizeLabelText(line);
    if (line.length < 40 && variants.some((v) => norm === v)) {
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const next = lines[j];
        if (!next) continue;
        if (variants.some((v) => normalizeLabelText(next) === v)) continue;
        return next;
      }
    }
  }
  return '';
}
// Applies every field defined for a subCategory|documentType in FIELD_LABELS
// (config/fieldLabels.js) against the OCR text. This is the generic
// extraction path used for any document type that doesn't have a bespoke
// parser: Passport, Driving Licence, Voter ID, Birth/Marriage Certificate,
// Name Change Affidavit, and every Financial/Healthcare/Travel/Employment/
// Business/IP/Awards leaf type.
function extractSpecFields(text, subCategory, documentType) {
  const specs = getFieldSpecs(subCategory, documentType);
  if (!specs) return {};
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const result = {};
  for (const spec of specs) {
    const value = extractFieldByLabel(lines, spec.label);
    if (value) result[spec.key] = value;
  }
  return result;
}
function parseAadhaar(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const aadhaarNumber = extract(AADHAAR_NUMBER_RE, text).replace(/\s+/g, ' ');
  const vid = extract(VID_RE, text).replace(/\s+/g, ' ');
  const genderRaw = extract(GENDER_RE, text);
  const gender = genderRaw ? genderRaw[0].toUpperCase() + genderRaw.slice(1).toLowerCase() : '';
  const dobRaw = extract(AADHAAR_DOB_RE, text);
  const dob = normalizeDate(dobRaw) || dobRaw;
  // Name: almost always sits somewhere in the few lines above the Male/
  // Female line on an Aadhaar card, but OCR noise lines often sit between
  // them — walk back a wider window, skipping headers/digits/the "Aadhaar"
  // label/gender-lookalikes, and only accept a line that actually looks
  // like a name rather than stopping at the first non-header line.
  let fullName = '';
  const genderIdx = lines.findIndex((l) => GENDER_RE.test(l));
  if (genderIdx > 0) {
    for (let i = genderIdx - 1; i >= 0 && i >= genderIdx - 6; i--) {
      const l = lines[i];
      if (!l) continue;
      if (HEADER_LINE_RE.test(l) || /^aadhaar$/i.test(l)) continue;
      if (/^\d+$/.test(l) || GENDER_RE.test(l)) continue;
      if (!isPlausibleNameLine(l)) continue;
      fullName = l;
      break;
    }
  }
  // Address: Aadhaar prints a multi-line address block ending in a 6-digit
  // PIN code, usually below the Aadhaar number/photo.
  const addressMatch = text.match(/((?:[A-Za-z0-9,./\- ]+\n){0,6}[A-Za-z ]+[-,\s]\d{6})/);
  const address = addressMatch ? addressMatch[1].replace(/\n+/g, ', ').replace(/\s{2,}/g, ' ').trim() : '';
  const enrolmentId = extract(ENROLMENT_ID_RE, text);
  return {
    fullName,
    aadhaarNumber,
    dateOfBirthYearOfBirth: dob || '',
    gender,
    address,
    vid,
    enrolmentUpdateId: enrolmentId,
    // Legacy/common fields other parts of the app (e.g. documentFieldTemplates.js
    // dynamic fields) still key off.
    name: fullName,
    documentNumber: aadhaarNumber,
    issuingAuthority: 'UIDAI',
  };
}
function parsePan(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const panNumber = extract(PAN_NUMBER_RE, text);
  const dobRaw = extract(/(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{4})/, text);
  const dob = normalizeDate(dobRaw) || dobRaw;
  let fullName = '';
  let fatherName = '';
  const nameLabelIdx = lines.findIndex((l) => /^name$/i.test(l));
  if (nameLabelIdx >= 0 && lines[nameLabelIdx + 1]) fullName = lines[nameLabelIdx + 1];
  const fatherLabelIdx = lines.findIndex((l) => /father|mother/i.test(l) && l.length < 40);
  if (fatherLabelIdx >= 0 && lines[fatherLabelIdx + 1]) fatherName = lines[fatherLabelIdx + 1];
  if (!fullName) {
    // Fallback: first all-caps line (2+ words) that isn't the card's header text.
    const capsLine = lines.find((l) => /^[A-Z][A-Z .'-]{4,40}$/.test(l) && !HEADER_LINE_RE.test(l));
    fullName = capsLine || '';
  }
  return {
    fullName,
    "fatherSMotherSName": fatherName,
    panNumber,
    dateOfBirth: dob || '',
    dateOfIssue: '',
    // Legacy/common fields.
    name: fullName,
    documentNumber: panNumber,
    issuingAuthority: 'Income Tax Department',
  };
}
function parseIdentityDocument(documentType, text) {
  const dt = String(documentType || '').toLowerCase();
  if (dt.includes('aadhaar')) return parseAadhaar(text);
  if (dt.includes('pan card') || dt === 'pan') return parsePan(text);
  if (dt.includes('ration')) return parseRationCard(text);
  // Every other Identity & Legal leaf type (Passport, Driving Licence, Voter
  // ID, Birth Certificate, Marriage Certificate, Name Change Affidavit,
  // Other) doesn't have a bespoke card-layout parser, so extract using the
  // FIELD_LABELS spec for that type, topped up with a couple of
  // high-confidence structured regexes for values that are often printed
  // without an explicit label right next to them.
  const generic = extractSpecFields(text, 'Identity & Legal', documentType);
  // Normalize gender: a full word if we found one, or the M/F/T single-letter
  // shorthand that "Sex" fields commonly use on passports and licences.
  if (generic.gender) {
    const g = generic.gender.trim().toUpperCase();
    if (g === 'M') generic.gender = 'Male';
    else if (g === 'F') generic.gender = 'Female';
    else if (g === 'T') generic.gender = 'Transgender';
  } else {
    const genderRaw = extract(GENDER_RE, text) || extract(/\bsex\s*[:.]?\s*([MFT])\b/i, text);
    if (genderRaw) {
      const g = genderRaw.trim().toUpperCase();
      generic.gender = g === 'M' ? 'Male' : g === 'F' ? 'Female' : g === 'T' ? 'Transgender'
        : genderRaw[0].toUpperCase() + genderRaw.slice(1).toLowerCase();
    }
  }
  if (dt.includes('passport')) {
    if (!generic.passportNumber) generic.passportNumber = extract(PASSPORT_NUMBER_RE, text);
    generic.documentNumber = generic.passportNumber || generic.documentNumber || '';
    if (!generic.fullName) {
      // Passports print Surname and Given Name(s) as two separate boxed
      // fields rather than one "Full Name" field — assemble them if present.
      const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
      const surname = extractFieldByLabel(lines, 'Surname');
      const givenName = extractFieldByLabel(lines, 'Given Name(s)') || extractFieldByLabel(lines, 'Given Names')
        || extractFieldByLabel(lines, 'Given Name');
      const combined = [givenName, surname].filter(Boolean).join(' ').trim();
      if (combined) generic.fullName = combined;
    }
  } else if (dt.includes('voter')) {
    if (!generic.epicVoterIdNumber) generic.epicVoterIdNumber = extract(VOTER_ID_RE, text);
    generic.documentNumber = generic.epicVoterIdNumber || generic.documentNumber || '';
  }
  if (!generic.documentNumber) {
    generic.documentNumber = generic.registrationNumber || generic.certificateNumber
      || generic.marriageRegistrationNumber || generic.affidavitNumber || '';
  }
  if (!generic.documentNumber) {
    // Last resort for formats we don't have a fixed pattern for (e.g. Driving
    // Licence numbers vary widely by state): the most number/letter-dense
    // short token on the document tends to be its reference number.
    generic.documentNumber = extract(/\b([A-Z]{2,4}[\s-]?\d{6,15})\b/, text);
  }
  const nameFallback = generic.fullName || generic.childSFullName || generic.husbandSFullName
    || generic.wifeSFullName || generic.newName || '';
  if (!generic.name) generic.name = nameFallback;
  if (!generic.issuingAuthority) {
    // These document types are issued by a single fixed national/statutory
    // body (same reasoning as Aadhaar -> UIDAI and PAN -> Income Tax
    // Department above), so default to it when the OCR text doesn't spell
    // out an authority label explicitly.
    if (dt.includes('passport')) generic.issuingAuthority = 'Ministry of External Affairs (Passport Seva)';
    else if (dt.includes('voter')) generic.issuingAuthority = 'Election Commission of India';
    else if (dt.includes('driving')) generic.issuingAuthority = extract(/\b([A-Za-z ]*RTO[A-Za-z ]*)\b/i, text) || 'Regional Transport Office (RTO)';
    else if (dt.includes('birth')) generic.issuingAuthority = generic.notaryAuthorityName || 'Registrar of Births & Deaths';
    else if (dt.includes('marriage')) generic.issuingAuthority = generic.notaryAuthorityName || 'Registrar of Marriages';
    else generic.issuingAuthority = generic.notaryAuthorityName || '';
  }
  if (!generic.date) {
    generic.date = generic.dateOfIssue || generic.dateOfRegistration || generic.registrationDate
      || generic.dateOfMarriage || generic.dateOfBirth || '';
  }
  return generic;
}
function parseGenericLabelValues(text) {
  const result = {};
  const lineRe = /^([A-Za-z][A-Za-z0-9 /&().'-]{1,40}?)\s*[:\-]\s*(.{1,80})$/;
  for (const rawLine of String(text || '').split('\n')) {
    const match = rawLine.trim().match(lineRe);
    if (!match) continue;
    const label = match[1].trim();
    const value = match[2].trim();
    if (!label || !value) continue;
    const key = keyFromLabel(label);
    if (!result[key]) result[key] = value;
  }
  return result;
}
function parseInvoice(text, classification) {
  const { category, subCategory, documentType } = classification;
  const nameMatch = extract(/(?:Description|Product|Item|Asset|Property Name)\s*[: ]\s*([A-Za-z0-9 ]+)/i, text);
  const store = extract(/(?:Store|Seller|Broker|Vendor|Agency|Dealer)\s*[: ]\s*([A-Za-z0-9 ]+)/i, text)
    || extract(/\b(Reliance Digital|Croma|Vijay Sales)\b/i, text);
  const brand = extract(/(?:Brand|Builder|Developer|Manufacturer)\s*[: ]\s*([A-Za-z0-9 ]+)/i, text)
    || extract(/\b(LG|Samsung|Sony|Whirlpool|Godrej|IFB|Haier|Bosch|Panasonic|DLF|Godrej Properties|Tata)\b/i, text);
  return {
    category,
    subCategory,
    documentType,
    name: nameMatch || extract(/^([A-Za-z0-9 ]{3,24})/m, text),
    store,
    storeOrSeller: store,
    brand,
    issuingAuthority: store || brand || '',
    date: normalizeDate(extract(/(?:Invoice|Purchase|Registration|Issue)\s*Date\s*[: ]\s*([\d./-]+)/i, text) || extract(/(\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4})/, text)),
    issueDate: normalizeDate(extract(/(?:Invoice|Purchase|Registration|Issue)\s*Date\s*[: ]\s*([\d./-]+)/i, text) || extract(/(\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4})/, text)),
    amount: extract(/(?:Total Amount|Grand Total|Net Payable|Value|Price)\s*[: ]*₹?\s*([\d,]+(?:\.\d+)?)/i, text) || extract(/Total.*?([\d,]+(?:\.\d+)?)/i, text),
    invoiceNumber: extract(/(?:Invoice|Bill|Deed|Agreement|Document)\s*No\s*[:+ ]\s*([A-Z0-9-]+)/i, text),
    documentNumber: extract(/(?:Registration|License Plate|Model Number|Serial Number|S\/N|Policy Number|Account Number|Certificate Number)\s*[: ]\s*([A-Za-z0-9,.\- ]+)/i, text),
    expiryDate: normalizeDate(extract(/(?:Warranty Expiry|Valid Upto|Policy Expiry|Maturity Date)\s*[: ]\s*([\d./-]+)/i, text)),
    notes: extract(/(?:Notes|Address|Location)\s*[: ]\s*([A-Za-z0-9,.\- ]+)/i, text),
    specField1: extract(/(?:Built-up Area|Plot Size|Registration|License Plate|Model Number|Carat|Purity|Dimensions)\s*[: ]\s*([A-Za-z0-9,.\- ]+)/i, text),
    specField2: extract(/(?:RERA|Khata|VIN|Mileage|Serial Number|S\/N|Weight|Material)\s*[: ]\s*([A-Za-z0-9,.\- ]+)/i, text)
  };
}
// Runs the shared sharp preprocessing (deskew via EXIF rotate, resize, grayscale,
// contrast normalize, sharpen) that materially improves Tesseract accuracy on noisy
// phone photos, then writes the result as a PNG ready for OCR.
async function preprocessImageForOcr(inputPath, outputPath) {
  const sharp = require('sharp');
  await sharp(inputPath)
    .rotate()
    .resize({ width: 1800, withoutEnlargement: true })
    .grayscale()
    .normalize()
    .sharpen()
    .png()
    .toFile(outputPath);
}
async function ocrImageFiles(worker, imagePaths) {
  let combinedText = '';
  let confidenceSum = 0;
  let pagesWithText = 0;
  const words = []; // { text, x0, y0, x1, y1 } normalized 0-1, across all pages
  for (const imagePath of imagePaths) {
    const { data } = await worker.recognize(imagePath, {}, { blocks: true });
    const pageText = (data.text || '').trim();
    if (pageText) {
      combinedText += (combinedText ? '\n\n' : '') + pageText;
      confidenceSum += data.confidence || 0;
      pagesWithText += 1;
    }
    const pageWidth = (data.width || 1);
    const pageHeight = (data.height || 1);
    // tesseract.js v5 nests words under blocks -> paragraphs -> lines -> words;
    // fall back to a flat data.words array for older versions.
    const flatWords = [];
    if (Array.isArray(data.words)) {
      flatWords.push(...data.words);
    } else if (Array.isArray(data.blocks)) {
      for (const block of data.blocks) {
        for (const para of block.paragraphs || []) {
          for (const line of para.lines || []) {
            for (const word of line.words || []) flatWords.push(word);
          }
        }
      }
    }
    for (const w of flatWords) {
      if (!w || !w.text || !w.bbox) continue;
      words.push({
        text: w.text,
        x0: w.bbox.x0 / pageWidth,
        y0: w.bbox.y0 / pageHeight,
        x1: w.bbox.x1 / pageWidth,
        y1: w.bbox.y1 / pageHeight,
      });
    }
  }
  return {
    text: combinedText,
    confidence: pagesWithText ? confidenceSum / pagesWithText : 0,
    words,
  };
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
router.post('/scan-receipt', authMiddleware, upload.single('image'), verifyReceiptImage, async (req, res) => {
  const Tesseract = require('tesseract.js');
  const tempFiles = [];
  let worker = null;
  try {
    if (!req.file) { return res.status(400).json({ error: 'No file uploaded' }); }
    trackTemp(tempFiles, req.file.path);
    const trainedDataPath = path.join(__dirname, '..', 'eng.traineddata');
    if (!fs.existsSync(trainedDataPath)) {
      console.error(`[OCR] FATAL: eng.traineddata not found at ${trainedDataPath}. It must be committed to git and present in the deployed repo.`);
      cleanupTempFiles(tempFiles);
      return res.status(500).json({ error: 'OCR language data missing on server (eng.traineddata not found).' });
    }
    console.log(`[OCR] Using trained data at ${trainedDataPath} (${fs.statSync(trainedDataPath).size} bytes)`);
    const mime = req.file.detectedMime;
    let rawText = '';
    let ocrConfidence = 0;
    let ocrWords = [];
    const imagesToOcr = [];
    if (mime === 'application/pdf') {
      const { PDFParse } = require('pdf-parse');
      const pdfBuffer = await fsp.readFile(req.file.path);
      let parser = null;
      try {
        parser = new PDFParse({ data: pdfBuffer });
        const textResult = await parser.getText();
        const embedded = (textResult.text || '').replace(/--\s*\d+\s*of\s*\d+\s*--/g, '');
        if (embedded.replace(/\s/g, '').length >= MIN_EMBEDDED_TEXT_CHARS) {
          rawText = embedded.trim();
          ocrConfidence = 100;
        } else {
          const screenshot = await parser.getScreenshot({ scale: 2.0, first: MAX_PDF_PAGES_FOR_OCR });
          for (let i = 0; i < screenshot.pages.length; i++) {
            const page = screenshot.pages[i];
            const rawPagePath = trackTemp(tempFiles, path.join(uploadDir, `pdfpage_${req.file.filename}_${i}.png`));
            await fsp.writeFile(rawPagePath, page.data);
            const procPath = trackTemp(tempFiles, path.join(uploadDir, `proc_${req.file.filename}_${i}.png`));
            await preprocessImageForOcr(rawPagePath, procPath);
            imagesToOcr.push(procPath);
          }
        }
      } finally {
        if (parser) await parser.destroy();
      }
    } else if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const mammoth = require('mammoth');
      const { value: docxText } = await mammoth.extractRawText({ path: req.file.path });
      rawText = (docxText || '').trim();
      ocrConfidence = rawText ? 100 : 0;
    } else if (req.file.detectedExt === 'doc') {
      const WordExtractor = require('word-extractor');
      const extractor = new WordExtractor();
      const extracted = await extractor.extract(req.file.path);
      rawText = (extracted.getBody() || '').trim();
      ocrConfidence = rawText ? 100 : 0;
    } else if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || req.file.detectedExt === 'xls') {
      const XLSX = require('xlsx');
      const workbook = XLSX.readFile(req.file.path);
      const sheetTexts = workbook.SheetNames.map((sheetName) => {
        const sheet = workbook.Sheets[sheetName];
        return XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
      });
      rawText = sheetTexts.join('\n\n').trim();
      ocrConfidence = rawText ? 100 : 0;
    } else {
      let sourcePath = req.file.path;
      if (mime === 'image/heic' || mime === 'image/heif') {
        const convert = require('heic-convert');
        const heicBuffer = await fsp.readFile(req.file.path);
        const jpegBuffer = await convert({ buffer: heicBuffer, format: 'JPEG', quality: 0.92 });
        sourcePath = trackTemp(tempFiles, path.join(uploadDir, `heic_${req.file.filename}.jpg`));
        await fsp.writeFile(sourcePath, jpegBuffer);
      }
      const procPath = trackTemp(tempFiles, path.join(uploadDir, `proc_${req.file.filename}.png`));
      await preprocessImageForOcr(sourcePath, procPath);
      imagesToOcr.push(procPath);
    }
    if (!rawText && imagesToOcr.length > 0) {
      worker = await Tesseract.createWorker('eng', 1, {
        langPath: path.join(__dirname, '..'),
        gzip: false,
        logger: (m) => {
          if (m.status && m.progress === 1) console.log(`[OCR] ${m.status} done`);
        },
      });
      try {
        const result = await ocrImageFiles(worker, imagesToOcr);
        rawText = result.text;
        ocrConfidence = result.confidence;
        ocrWords = result.words || [];
      } catch (ocrErr) {
        console.error('[OCR] worker.recognize threw:', ocrErr);
        throw ocrErr;
      } finally {
        await worker.terminate();
        worker = null;
      }
    }
    console.log(`[OCR] extracted ${rawText.trim().length} chars, confidence ${ocrConfidence}`);
    cleanupTempFiles(tempFiles);
    if (!rawText || !rawText.trim()) {
      return res.status(200).json({ success: true, extracted: false });
    }
    const cleanedText = cleanOcrText(rawText);
    const documentTypeHint = typeof req.body.documentTypeHint === 'string' ? req.body.documentTypeHint.trim() : '';
    const classification = classifyFromHint(documentTypeHint) || classifyDocument(cleanedText);
    // 2. Run the extractor suited to that classification.
    const ASSET_SUBCATEGORIES = new Set(['Vehicle', 'Jewellery', 'Property', 'Insurance', 'Gadgets/Appliances', 'Gadgets & Appliances']);
    let specific;
    if (classification.subCategory === 'Certification' || classification.subCategory === 'Education') {
      specific = parseEducationCertificate(classification, cleanedText);
    } else if (classification.subCategory === 'Utilities & Bills') {
      specific = parseUtilityBill(cleanedText, classification);
    } else if (classification.subCategory === 'Government Certificates') {
      specific = parseGovCertificate(cleanedText, classification);
    } else if (ASSET_SUBCATEGORIES.has(classification.subCategory)) {
      specific = parseInvoice(cleanedText, classification);
    } else if (classification.subCategory === 'Identity & Legal') {
      let templateFields = {};
      try {
        const templates = await OcrTemplate.find({ documentType: classification.documentType }).lean();
        const templateResult = ocrWords.length > 0 ? applyBestTemplate(templates, classification.documentType, ocrWords) : null;
        if (templateResult) templateFields = templateResult.fields;
      } catch (templateErr) {
        console.error('[OCR template] match failed:', templateErr);
      }
      const regexFields = parseIdentityDocument(classification.documentType, cleanedText);
      specific = { ...classification, ...regexFields, ...templateFields };
    } else {
      // Financial, Healthcare, Travel, Employment, Business, IP, and Awards
      // & Recognition documents don't have bespoke parsers either — use the
      // same FIELD_LABELS-driven extractor so these aren't left empty.
      const specFields = extractSpecFields(cleanedText, classification.subCategory, classification.documentType);
      if (!specFields.name) specFields.name = specFields.fullName || specFields.employeeName || specFields.patientName
        || specFields.applicantName || specFields.accountHolderName || specFields.investorName
        || specFields.passengerName || specFields.guestName || specFields.recipientName || '';
      if (!specFields.documentNumber) specFields.documentNumber = specFields.referenceNumber || specFields.certificateNumber
        || specFields.registrationNumber || specFields.policyNumber || specFields.accountNumber || '';
      specific = { ...classification, ...specFields };
    }
    let parsed = { ...parseGenericLabelValues(cleanedText), ...specific };
    const meaningfulCount = Object.entries(parsed).filter(([k, v]) => (
      !['category', 'subCategory', 'documentType'].includes(k) && v !== undefined && v !== null && String(v).trim() !== ''
    )).length;
    if (meaningfulCount < 3) {
      try {
        const knownSpecs = getFieldSpecs(classification.subCategory, classification.documentType);
        let prompt;
        if (knownSpecs) {
          const fieldList = knownSpecs.map((s) => `${s.key} (${s.label})`).join(', ');
          prompt = 'Extract these fields from the document text below and respond with ONLY valid JSON, no explanation, no markdown fences.\n'
            + `Fields (JSON key and what it means): ${fieldList}.\n`
            + 'Dates must be formatted YYYY-MM-DD. If a field is not found use an empty string.\n\nDocument text:\n' + cleanedText;
        } else {
          prompt = 'Extract these fields from the receipt text below and respond with ONLY valid JSON, no explanation, no markdown fences.\n'
            + 'Fields: name, brand (manufacturer), store (seller/vendor the item was bought from - keep this SEPARATE from brand), date (YYYY-MM-DD), amount (number only, no currency symbol), invoiceNumber, documentNumber, expiryDate (YYYY-MM-DD or empty string), notes, category (always "Personal"), subCategory (one of Property, Vehicle, "Gadgets & Appliances", Jewellery, Insurance), documentType (a specific leaf type such as "Purchase Invoice", "RC Book", "Sale Deeds"), specField1, specField2.\n'
            + 'If a field is not found use an empty string.\n\nReceipt text:\n' + cleanedText;
        }
        const ollamaRes = await fetch(OLLAMA_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: OLLAMA_MODEL, prompt, format: 'json', stream: false })
        });
        if (ollamaRes.ok) {
          const ollamaJson = await ollamaRes.json();
          const llmParsed = JSON.parse(ollamaJson.response);
          if (llmParsed.store) {
            llmParsed.storeOrSeller = llmParsed.store;
            llmParsed.issuingAuthority = llmParsed.store;
          }
          for (const [key, value] of Object.entries(llmParsed)) {
            if (value === undefined || value === null || String(value).trim() === '') continue;
            if (parsed[key] === undefined || parsed[key] === null || String(parsed[key]).trim() === '') {
              parsed[key] = value;
            }
          }
          parsed.date = normalizeDate(parsed.date) || parsed.date;
          parsed.issueDate = normalizeDate(parsed.issueDate) || parsed.issueDate;
          parsed.dateOfIssue = normalizeDate(parsed.dateOfIssue) || parsed.dateOfIssue;
          parsed.expiryDate = normalizeDate(parsed.expiryDate) || parsed.expiryDate;
        }
      } catch (llmError) {
        console.error('Backup LLM extraction failed, returning regex/heuristic map:', llmError);
      }
    }
    return res.status(200).json({ success: true, extracted: true, data: parsed, rawText: cleanedText, ocrWords });
  } catch (err) {
    cleanupTempFiles(tempFiles);
    console.error('[server error]', err);
    return res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  } finally {
    if (worker) { try { await worker.terminate(); } catch (_) { /* already terminated */ } }
  }
});
// Called when the user hits "Save Document" after reviewing/correcting the
// auto-filled fields. This is the "training" step: it takes the OCR word
// boxes from the original scan (echoed back by the client — see ocrWords in
// the /scan-receipt response) plus whatever field values the user actually
// confirmed, locates each value among the OCR words, and learns/updates a
// position-based template for that layout. No labeling tool, no retraining
// job — every save that includes a correction quietly improves the next
// scan of a similarly-laid-out document.
router.post('/confirm-extraction', authMiddleware, asyncHandler(async (req, res) => {
  const { documentType, ocrWords, fields } = req.body || {};
  if (!documentType || !Array.isArray(ocrWords) || ocrWords.length === 0 || !fields || typeof fields !== 'object') {
    return res.status(400).json({ error: 'documentType, ocrWords, and fields are required.' });
  }
  const existing = await OcrTemplate.findOne({ documentType }).sort({ sampleCount: -1 });
  const updated = learnTemplate(existing, documentType, ocrWords, fields);
  await OcrTemplate.findOneAndUpdate(
    { documentType, fingerprint: updated.fingerprint },
    { $set: { anchors: updated.anchors, fields: updated.fields, sampleCount: updated.sampleCount } },
    { upsert: true }
  );
  return res.status(200).json({ success: true, learnedFields: Object.keys(updated.fields) });
}));
module.exports = router;