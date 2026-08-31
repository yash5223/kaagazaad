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

const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Accepted for OCR scanning: common photo formats (incl. HEIC/HEIF from iPhones and
// WEBP) plus PDF, DOC/DOCX and XLS/XLSX, since a large share of receipts/policies/
// tickets now arrive as emailed or downloaded documents/spreadsheets rather than photos.
const RECEIPT_ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf', 'doc', 'docx', 'xls', 'xlsx']);
const RECEIPT_ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/x-cfb', // legacy OLE container shared by .doc and .xls
]);
// Legacy OLE-based Office files (.doc / .xls) all sniff as the same generic
// "application/x-cfb" compound-file mime, so the claimed extension is what tells them
// apart once we already know the container format is genuine.
const CFB_EXTENSIONS = new Set(['doc', 'xls']);
// Max pages to rasterize + OCR for a scanned (image-only) PDF. Receipts/certificates
// rarely run past a couple of pages, and capping this keeps a single scan fast.
const MAX_PDF_PAGES_FOR_OCR = 3;
// A PDF's embedded text layer is only trusted (and OCR skipped) once it clears this
// many non-whitespace characters — short strings are usually just a watermark/footer.
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
// of the old first-match-wins chain (which meant anything that wasn't a
// vehicle/jewellery/property/insurance/gadget silently fell through to
// "Gadgets & Appliances / Purchase Invoice" no matter what it actually was).
function scoreSignals(text, patterns) {
  return patterns.reduce((sum, p) => sum + (p.test(text) ? 1 : 0), 0);
}

// Deliberately contains no university name, board name, or institute name —
// these signals are generic wording every degree certificate / marksheet /
// provisional certificate uses regardless of which university issued it
// (SPPU, any other Indian university, or a foreign one), so classification
// doesn't need to be taught each new university by name.
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
const VEHICLE_SIGNALS = [/\bcar\b/i, /\bmotorcycle\b/i, /\bsuv\b/i, /\bsedan\b/i, /\bmileage\b/i, /\bvin\b/i, /\bregistration number\b/i, /\bchassis\b/i, /\bpuc\b/i];
const JEWELLERY_SIGNALS = [/\bgold\b/i, /\bdiamond\b/i, /\bcarat\b/i, /\bpurity\b/i, /\bjewel+ery\b/i, /\bnecklace\b/i, /\bring\b/i, /\bsilver\b/i, /\bhallmark\b/i];
const PROPERTY_SIGNALS = [/\bflat\b/i, /\bapartment\b/i, /\bvilla\b/i, /\bplot\b/i, /\bkhata\b/i, /\brera\b/i, /\bsale deed\b/i, /\bbuilt[- ]?up area\b/i];
const INSURANCE_SIGNALS = [/\bpolicy\b/i, /\binsurer\b/i, /\bsum insured\b/i, /\bsum assured\b/i, /\bpremium\b/i];
const GADGET_SIGNALS = [/\bphone\b/i, /\bsmartphone\b/i, /\blaptop\b/i, /\bmacbook\b/i, /\bsmartwatch\b/i, /\btablet\b/i, /\bipad\b/i, /\btv\b/i, /\btelevision\b/i, /\brefrigerator\b/i, /\bfridge\b/i, /\bac\b/i, /\bwasher\b/i, /\bdryer\b/i, /\bmicrowave\b/i];

// Classifies text against every known category profile and returns the best
// match, so a document that isn't a receipt (a degree certificate, a
// marksheet, an offer letter, ...) no longer gets forced into "Gadgets &
// Appliances". Ties/no-signal cases fall back to the old default so existing
// receipt-scanning behaviour for personal assets is unchanged.
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
  ];
  // Education needs at least 2 independent signals before it wins — a single
  // stray word (e.g. "semester" in an unrelated sentence) shouldn't be enough
  // to reclassify a receipt as a degree certificate.
  const education = candidates[0];
  if (education.score < 2) education.score = 0;
  let best = candidates[0];
  for (const c of candidates) {
    if (c.score > best.score) best = c;
  }
  if (best.score === 0) {
    return { category: 'Personal', subCategory: 'Gadgets/Appliances', documentType: 'Purchase Invoice' };
  }
  return { category: best.category, subCategory: best.subCategory, documentType: best.documentType };
}

// University-agnostic on purpose: every pattern below matches generic
// certificate/marksheet wording ("This is to certify that ...", "degree of
// ...", "Seat No.", "CGPA") rather than any specific university's name or
// layout, so the same function extracts an SPPU degree certificate, a
// certificate from any other Indian university, or a foreign one, without
// changes. `documentType` is passed through so a detected marksheet still
// reports itself as such even though it shares the "Degree" field template.
function parseEducationCertificate(documentType, text) {
  const isMarksheet = /\b(mark ?sheet|grade card|statement of marks|transcript)\b/i.test(text);
  // [^\S\r\n] (horizontal whitespace only) keeps the name match on one line —
  // \s alone matches newlines too and would swallow the next line's label
  // (e.g. "Seat No") into the captured name.
  const name = extract(/(?:this is to certify that|certify that)[^\S\r\n]*(?:mr\.?|ms\.?|mrs\.?|shri\.?|smt\.?|kumari|km\.?)?[^\S\r\n]*([A-Z][A-Za-z.'-]+(?:[^\S\r\n]+[A-Z][A-Za-z.'-]+){1,4})/i, text)
    || extract(/\bname\s*[: ][^\S\r\n]*([A-Z][A-Za-z.'-]+(?:[^\S\r\n]+[A-Z][A-Za-z.'-]+){1,4})/i, text);
  const universityLine = extract(/^.*\b(?:university|vidyapeeth|institute of technology|board of [a-z ]+ education)\b.*$/im, text);
  const degreeName = extract(/\b((?:bachelor|master) of [A-Za-z .&()]+|diploma in [A-Za-z .&()]+|b\.?\s?e\.?|b\.?\s?tech\.?|m\.?\s?e\.?|m\.?\s?tech\.?|b\.?\s?sc\.?|m\.?\s?sc\.?|b\.?\s?com\.?|m\.?\s?com\.?|ph\.?\s?d\.?)\b/i, text);
  const branch = extract(/\(([A-Za-z &,.]{3,60})\)/, text)
    || extract(/(?:branch|specialization|stream)\s*(?:of|in)?\s*[: ]\s*([A-Za-z &]+)/i, text);
  const seatNumber = extract(/(?:seat\s*no\.?|exam\s*seat\s*no\.?|roll\s*no\.?)\s*[: ]\s*([A-Za-z0-9/-]+)/i, text);
  const enrollmentNumber = extract(/(?:enrol{1,2}ment\s*no\.?)\s*[: ]\s*([A-Za-z0-9/-]+)/i, text) || extract(/\bprn\s*[: ]\s*([A-Za-z0-9/-]+)/i, text);
  const certificateNumber = extract(/certificate\s*no\.?\s*[: ]\s*([A-Za-z0-9/-]+)/i, text);
  const classOrGrade = extract(/\b(first class with distinction|first class|higher second class|second class|pass class|distinction|honou?rs)\b/i, text);
  const cgpa = extract(/\b[cs]gpa\s*[: ]\s*([\d.]{1,5})/i, text);
  const percentage = extract(/\b(\d{1,3}(?:\.\d+)?)\s*%/, text);
  const dateOfIssue = normalizeDate(extract(/(?:dated|date of issue|convocation date|issued on)\s*[: ]\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4})/i, text));
  const yearOfPassing = extract(/\b(?:19|20)\d{2}\b/, text);
  const classCgpaPercentage = classOrGrade || (cgpa ? `CGPA ${cgpa}` : '') || (percentage ? `${percentage}%` : '');
  return {
    // Keys computed with keyFromLabel() from the exact labels registered for
    // 'Certification|Degree' in config/fieldLabels.js (kept in sync with
    // Flutter's _documentFieldLabels) — these are what the upload form reads.
    studentFullName: name || '',
    universityInstituteName: universityLine ? universityLine.replace(/\s{2,}/g, ' ').trim() : '',
    degreeName: degreeName ? degreeName.trim() : '',
    branchSpecialization: branch ? branch.trim() : '',
    seatNumberRollNumber: seatNumber || '',
    enrollmentNumberPrn: enrollmentNumber || '',
    classCgpaPercentage,
    certificateNumber: certificateNumber || '',
    dateOfIssue: dateOfIssue || '',
    yearOfPassing: yearOfPassing || '',
    // Legacy/common fields kept for backward compatibility with anything
    // still reading the older generic shape.
    name: name || '',
    issuingAuthority: universityLine ? universityLine.replace(/\s{2,}/g, ' ').trim() : '',
    documentNumber: certificateNumber || enrollmentNumber || seatNumber || '',
    date: dateOfIssue || '',
    category: 'Professional',
    subCategory: 'Certification',
    documentType: isMarksheet ? 'Degree' : documentType,
  };
}

// Generic "Label: Value" / "Label - Value" line scanner. Not tied to any
// particular document type — it's the safety net that lets fields populate
// for the long tail of document varieties (employment letters, business
// registrations, award certificates, and anything else) that don't have a
// dedicated parser, by matching whatever labels the document itself prints
// and turning them into the same camelCase keys the Flutter form expects.
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

// OCRs a sequence of already-preprocessed image files with one shared Tesseract
// worker (creating a worker per page would multiply startup cost) and concatenates
// the recognized text, separating pages so downstream regexes still see clean lines.
async function ocrImageFiles(worker, imagePaths) {
  let combinedText = '';
  let confidenceSum = 0;
  let pagesWithText = 0;
  for (const imagePath of imagePaths) {
    const { data } = await worker.recognize(imagePath);
    const pageText = (data.text || '').trim();
    if (pageText) {
      combinedText += (combinedText ? '\n\n' : '') + pageText;
      confidenceSum += data.confidence || 0;
      pagesWithText += 1;
    }
  }
  return {
    text: combinedText,
    confidence: pagesWithText ? confidenceSum / pagesWithText : 0,
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
    const imagesToOcr = [];

    if (mime === 'application/pdf') {
      // A digital PDF (e-invoice, e-ticket, e-policy) already has a text layer — reading
      // it directly is faster and far more accurate than rasterizing + OCR-ing it, so try
      // that first and only fall back to OCR for scanned/photographed PDFs.
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
      // .docx has a text layer just like a digital PDF — read it directly, no OCR needed.
      const mammoth = require('mammoth');
      const { value: docxText } = await mammoth.extractRawText({ path: req.file.path });
      rawText = (docxText || '').trim();
      ocrConfidence = rawText ? 100 : 0;
    } else if (req.file.detectedExt === 'doc') {
      // Legacy binary .doc — mammoth only understands the modern .docx XML format,
      // so pull the body text out of the OLE container with word-extractor instead.
      const WordExtractor = require('word-extractor');
      const extractor = new WordExtractor();
      const extracted = await extractor.extract(req.file.path);
      rawText = (extracted.getBody() || '').trim();
      ocrConfidence = rawText ? 100 : 0;
    } else if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || req.file.detectedExt === 'xls') {
      // SheetJS reads both modern .xlsx and legacy .xls workbooks. Flatten every sheet
      // to CSV-ish text so the same regex/LLM extraction used for receipts still works.
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
        // sharp/libvips can't reliably decode HEIC/HEIF (common for iPhone photos) across
        // all deployment environments, so decode it to JPEG ourselves first.
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

    // 1. Classify once: which category/subCategory/documentType is this?
    // Works across every category (not just personal receipts), including
    // university-agnostic degree certificates and marksheets.
    const classification = classifyDocument(cleanedText);

    // 2. Run the extractor suited to that classification.
    const ASSET_SUBCATEGORIES = new Set(['Vehicle', 'Jewellery', 'Property', 'Insurance', 'Gadgets/Appliances', 'Gadgets & Appliances']);
    let specific;
    if (classification.subCategory === 'Certification') {
      specific = parseEducationCertificate(classification.documentType, cleanedText);
    } else if (ASSET_SUBCATEGORIES.has(classification.subCategory)) {
      specific = parseInvoice(cleanedText, classification);
    } else {
      specific = { ...classification };
    }

    // 3. Always run the generic label:value line scanner as a safety net —
    // it fills gaps for whatever the specific extractor above missed,
    // without overriding anything it already found (specific wins on
    // conflicts since it's spread second).
    let parsed = { ...parseGenericLabelValues(cleanedText), ...specific };

    // 4. Decide whether to top up with the local LLM: count meaningful
    // (non-empty, non-classification) fields we already have. Below the
    // threshold — or for a document type that has a known field template but
    // regex/heuristics under-filled it — ask Ollama for exactly the fields
    // this document type's form actually shows, so results come back keyed
    // the same way the specific extractor's do.
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
          // LLM only fills what regex/heuristics left empty — never overrides
          // an already-extracted value.
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
    return res.status(200).json({ success: true, extracted: true, data: parsed, rawText: cleanedText });
  } catch (err) {
    cleanupTempFiles(tempFiles);
    console.error('[server error]', err);
    return res.status(500).json({ error: 'Something went wrong on our end. Please try again shortly.' });
  } finally {
    if (worker) { try { await worker.terminate(); } catch (_) { /* already terminated */ } }
  }
});
module.exports = router;