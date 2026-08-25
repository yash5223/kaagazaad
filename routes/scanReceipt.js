const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { fileTypeFromFile } = require('file-type');
const router = express.Router();
const authMiddleware = require('../middleware/authMiddleware');
const { asyncHandler } = require('../middleware/errorHandler');

const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Accepted for OCR scanning: common photo formats (incl. HEIC/HEIF from iPhones and
// WEBP) plus PDF, since a large share of receipts/policies/tickets now arrive as
// emailed or downloaded PDFs rather than photos.
const RECEIPT_ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf']);
const RECEIPT_ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);
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
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only JPG, PNG, WEBP, HEIC/HEIF images or PDF files are accepted for scanning.'));
    }
    return cb(null, true);
  },
});

async function verifyReceiptImage(req, res, next) {
  if (!req.file) return next();
  try {
    const detected = await fileTypeFromFile(req.file.path);
    const mime = detected && detected.mime;
    if (!mime || !RECEIPT_ALLOWED_MIMES.has(mime)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'The uploaded file is not a supported image or PDF.' });
    }
    req.file.detectedMime = mime;
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
function detectCategoryAndType(text) {
  if (/\b(car|motorcycle|suv|sedan|mileage|vin|registration number|chassis|puc\b)\b/i.test(text)) {
    const isPuc = /\bpuc\b/i.test(text);
    return { category: 'Personal', subCategory: 'Vehicle', documentType: isPuc ? 'PUC Certificate' : 'RC Book' };
  }
  if (/\b(gold|diamond|carat|purity|jewel+ery|necklace|\bring\b|silver|hallmark)\b/i.test(text)) {
    const isHallmark = /hallmark/i.test(text);
    return { category: 'Personal', subCategory: 'Jewellery', documentType: isHallmark ? 'Hallmark Certificate' : 'Purchase Invoice' };
  }
  if (/\b(flat|apartment|villa|plot|khata|\brera\b|sale deed|built[- ]?up area)\b/i.test(text)) {
    const isDeed = /sale deed/i.test(text);
    return { category: 'Personal', subCategory: 'Property', documentType: isDeed ? 'Sale Deeds' : 'Purchase Documents' };
  }
  if (/\b(policy|insurer|sum insured|sum assured|premium)\b/i.test(text)) {
    let documentType = 'Health Insurance';
    if (/\bvehicle\b/i.test(text)) documentType = 'Vehicle Insurance';
    else if (/\blife\b/i.test(text)) documentType = 'Life Insurance';
    else if (/\bhome\b/i.test(text)) documentType = 'Home Insurance';
    else if (/\btravel\b/i.test(text)) documentType = 'Travel Insurance';
    return { category: 'Personal', subCategory: 'Insurance', documentType };
  }
  if (/\b(phone|smartphone|laptop|macbook|smartwatch|tablet|ipad|\btv\b|television|refrigerator|fridge|\bac\b|washer|dryer|microwave)\b/i.test(text)) {
    return { category: 'Personal', subCategory: 'Gadgets & Appliances', documentType: 'Mobile Phone' };
  }
  return { category: 'Personal', subCategory: 'Gadgets & Appliances', documentType: 'Purchase Invoice' };
}
function parseInvoice(text) {
  const { category, subCategory, documentType } = detectCategoryAndType(text);
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
    let parsed = parseInvoice(cleanedText);
    if (!parsed.name || !parsed.amount) {
      try {
        const prompt = 'Extract these fields from the receipt text below and respond with ONLY valid JSON, no explanation, no markdown fences.\n'
          + 'Fields: name, brand (manufacturer), store (seller/vendor the item was bought from - keep this SEPARATE from brand), date (YYYY-MM-DD), amount (number only, no currency symbol), invoiceNumber, documentNumber, expiryDate (YYYY-MM-DD or empty string), notes, category (always "Personal"), subCategory (one of Property, Vehicle, "Gadgets & Appliances", Jewellery, Insurance), documentType (a specific leaf type such as "Purchase Invoice", "RC Book", "Sale Deeds"), specField1, specField2.\n'
          + 'If a field is not found use an empty string.\n\nReceipt text:\n' + cleanedText;
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
          parsed = { ...parsed, ...llmParsed };
          parsed.date = normalizeDate(parsed.date) || parsed.date;
          parsed.issueDate = normalizeDate(parsed.issueDate) || parsed.issueDate;
          parsed.expiryDate = normalizeDate(parsed.expiryDate) || parsed.expiryDate;
        }
      } catch (llmError) {
        console.error("Backup LLM extraction failed, returning default regex map:", llmError);
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