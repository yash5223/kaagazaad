const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) { 
  fs.mkdirSync(uploadDir, { recursive: true }); 
}
const upload = multer({ dest: uploadDir });
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';
function extract(regex, text) {
  const match = text.match(regex);
  if (!match) return "";
  return (match[1] || match[0]).trim();
}
// OCR text (and the LLM fallback, despite being asked for YYYY-MM-DD) can
// hand back dates as DD-MM-YYYY, DD/MM/YYYY, DD.MM.YYYY, etc. — but every
// date field in the app (and the Flutter date picker's parser) requires
// strict YYYY-MM-DD. This normalizes whatever we found into that shape,
// or returns '' if it can't confidently parse it.
function normalizeDate(rawValue) {
  if (!rawValue) return '';
  const trimmed = String(rawValue).trim();
  if (!trimmed) return '';

  // Already YYYY-MM-DD (or YYYY/MM/DD) — just normalize the separators.
  let match = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) {
    const [, y, m, d] = match;
    return toIsoDate(y, m, d);
  }

  // DD-MM-YYYY / DD/MM/YYYY / DD.MM.YYYY — the common format on Indian
  // documents (and what OCR most often yields).
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
// Maps detected keywords to the app's real category tree:
// top-level category -> subCategory -> documentType (leaf item), so
// _applyCategoryFromOcr on the client can actually match it.
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
  // Default: most scanned receipts are retail purchase invoices for a gadget/appliance.
  return { category: 'Personal', subCategory: 'Gadgets & Appliances', documentType: 'Purchase Invoice' };
}

function parseInvoice(text) {
  const { category, subCategory, documentType } = detectCategoryAndType(text);
  const nameMatch = extract(/(?:Description|Product|Item|Asset|Property Name)\s*[: ]\s*([A-Za-z0-9 ]+)/i, text);

  // Kept separate on purpose: `store` (who it was bought/registered FROM,
  // e.g. "Croma", "DLF Properties") vs `brand` (who MADE/manufactures it,
  // e.g. "Samsung"). Conflating the two loses information, so both are
  // extracted independently and both are always returned to the caller.
  const store = extract(/(?:Store|Seller|Broker|Vendor|Agency|Dealer)\s*[: ]\s*([A-Za-z0-9 ]+)/i, text)
    || extract(/\b(Reliance Digital|Croma|Vijay Sales)\b/i, text);
  const brand = extract(/(?:Brand|Builder|Developer|Manufacturer)\s*[: ]\s*([A-Za-z0-9 ]+)/i, text)
    || extract(/\b(LG|Samsung|Sony|Whirlpool|Godrej|IFB|Haier|Bosch|Panasonic|DLF|Godrej Properties|Tata)\b/i, text);

  return {
    category,
    subCategory,
    documentType,
    name: nameMatch || extract(/^([A-Za-z0-9 ]{3,24})/m, text),
    // `store` is always surfaced on its own key so it is never silently
    // dropped by callers that only look for a generic "issuingAuthority".
    store,
    storeOrSeller: store,
    brand,
    issuingAuthority: store || brand || '',
    date: normalizeDate(extract(/(?:Invoice|Purchase|Registration|Issue)\s*Date\s*[: ]\s*([\d./-]+)/i, text) || extract(/(\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4})/, text)),
    issueDate: normalizeDate(extract(/(?:Invoice|Purchase|Registration|Issue)\s*Date\s*[: ]\s*([\d./-]+)/i, text) || extract(/(\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4})/, text)),
    amount: extract(/(?:Total Amount|Grand Total|Net Payable|Value|Price)\s*[: ]*₹?\s*([\d,]+\.\d+)/i, text) || extract(/Total.*?([\d,]+\.\d+)/i, text),
    invoiceNumber: extract(/(?:Invoice|Bill|Deed|Agreement|Document)\s*No\s*[:+ ]\s*([A-Z0-9-]+)/i, text),
    documentNumber: extract(/(?:Registration|License Plate|Model Number|Serial Number|S\/N|Policy Number|Account Number|Certificate Number)\s*[: ]\s*([A-Za-z0-9,.\- ]+)/i, text),
    expiryDate: normalizeDate(extract(/(?:Warranty Expiry|Valid Upto|Policy Expiry|Maturity Date)\s*[: ]\s*([\d./-]+)/i, text)),
    notes: extract(/(?:Notes|Address|Location)\s*[: ]\s*([A-Za-z0-9,.\- ]+)/i, text),
    specField1: extract(/(?:Built-up Area|Plot Size|Registration|License Plate|Model Number|Carat|Purity|Dimensions)\s*[: ]\s*([A-Za-z0-9,.\- ]+)/i, text),
    specField2: extract(/(?:RERA|Khata|VIN|Mileage|Serial Number|S\/N|Weight|Material)\s*[: ]\s*([A-Za-z0-9,.\- ]+)/i, text)
  };
}
router.post('/scan-receipt', upload.single('image'), async (req, res) => {
  const sharp = require('sharp');
  const Tesseract = require('tesseract.js');
  let processedImagePath = null;
  try {
    if (!req.file) { return res.status(400).json({ error: 'No image uploaded' }); }
    const trainedDataPath = path.join(__dirname, '..', 'eng.traineddata');
    if (!fs.existsSync(trainedDataPath)) {
      console.error(`[OCR] FATAL: eng.traineddata not found at ${trainedDataPath}. It must be committed to git and present in the deployed repo.`);
      return res.status(500).json({ error: 'OCR language data missing on server (eng.traineddata not found).' });
    }
    console.log(`[OCR] Using trained data at ${trainedDataPath} (${fs.statSync(trainedDataPath).size} bytes)`);
    processedImagePath = path.join(uploadDir, `proc_${req.file.filename}.png`);
    await sharp(req.file.path)
      .rotate()
      .resize({ width: 1800 })
      .grayscale()
      .normalize()
      .sharpen()
      .png()
      .toFile(processedImagePath);
    const worker = await Tesseract.createWorker('eng', 1, {
      langPath: path.join(__dirname, '..'),
      gzip: false,
      logger: (m) => {
        if (m.status && m.progress === 1) console.log(`[OCR] ${m.status} done`);
      },
    });
    let rawText = '';
    let ocrConfidence = 0;
    try {
      const { data } = await worker.recognize(processedImagePath);
      rawText = data.text || '';
      ocrConfidence = data.confidence || 0;
    } catch (ocrErr) {
      console.error('[OCR] worker.recognize threw:', ocrErr);
      throw ocrErr;
    } finally {
      await worker.terminate();
    }
    console.log(`[OCR] extracted ${rawText.trim().length} chars, confidence ${ocrConfidence}`);
    fs.unlink(req.file.path, () => {});
    fs.unlink(processedImagePath, () => {});
    if (!rawText || !rawText.trim()) {
      return res.status(200).json({ success: true, extracted: false });
    }
    let parsed = parseInvoice(rawText);
    if (!parsed.name || !parsed.amount) {
      try {
        const prompt = 'Extract these fields from the receipt text below and respond with ONLY valid JSON, no explanation, no markdown fences.\n'
          + 'Fields: name, brand (manufacturer), store (seller/vendor the item was bought from - keep this SEPARATE from brand), date (YYYY-MM-DD), amount (number only, no currency symbol), invoiceNumber, documentNumber, expiryDate (YYYY-MM-DD or empty string), notes, category (always "Personal"), subCategory (one of Property, Vehicle, "Gadgets & Appliances", Jewellery, Insurance), documentType (a specific leaf type such as "Purchase Invoice", "RC Book", "Sale Deeds"), specField1, specField2.\n'
          + 'If a field is not found use an empty string.\n\nReceipt text:\n' + rawText;
        const ollamaRes = await fetch(OLLAMA_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: OLLAMA_MODEL, prompt, format: 'json', stream: false })
        });
        if (ollamaRes.ok) {
          const ollamaJson = await ollamaRes.json();
          const llmParsed = JSON.parse(ollamaJson.response);
          // Never let the LLM fallback silently drop the store name: only
          // overwrite storeOrSeller/issuingAuthority when the LLM actually
          // found a store, otherwise keep whatever the regex pass extracted.
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
    return res.status(200).json({ success: true, extracted: true, data: parsed, rawText });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlink(req.file.path, () => {});
    if (processedImagePath && fs.existsSync(processedImagePath)) fs.unlink(processedImagePath, () => {});
    return res.status(500).json({ error: err.message });
  }
});
module.exports = router;