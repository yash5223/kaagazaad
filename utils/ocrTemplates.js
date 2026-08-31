// Learns document layouts from corrected extractions instead of hardcoded
// per-format regex/line-order parsers. This is the "automatic training"
// piece: Tesseract's character recognition doesn't need retraining (it
// already reads the text fine); what varies between an Aadhaar's old paper
// format, new PVC format, e-Aadhaar PDF, etc. is WHERE each field sits on
// the page. A template records that once, and every future scan of a
// visually similar layout reuses it — no new code per format.
//
// Anchors are the fixed, always-present words we can reliably relocate
// across scans of the same layout (a 12-digit number, "Male"/"Female", the
// word "Aadhaar", ...). A template stores each field's bounding-box offset
// *relative to its nearest anchor*, so it's robust to the whole card being
// shifted/cropped/rotated slightly differently between photos.

const ANCHOR_PATTERNS = [
  { key: 'genderWord', test: (w) => /^(male|female|transgender)$/i.test(w.text) },
  { key: 'numberGroup', test: (w) => /^\d{4}$/.test(w.text) },
  { key: 'aadhaarLabel', test: (w) => /^aadhaar$/i.test(w.text) },
  { key: 'panLabel', test: (w) => /^income$/i.test(w.text) },
];

function findAnchors(words) {
  const found = [];
  for (const pattern of ANCHOR_PATTERNS) {
    const match = words.find((w) => pattern.test(w));
    if (match) found.push({ key: pattern.key, x: (match.x0 + match.x1) / 2, y: (match.y0 + match.y1) / 2 });
  }
  return found;
}

// A layout "fingerprint" is just the relative positions of whichever anchors
// were found, sorted by key so two scans of the same layout produce
// comparable vectors even if OCR found the anchors in a different order.
function fingerprint(anchors) {
  return anchors
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((a) => `${a.key}:${a.x.toFixed(2)},${a.y.toFixed(2)}`)
    .join('|');
}

function distance(anchorsA, anchorsB) {
  const mapB = new Map(anchorsB.map((a) => [a.key, a]));
  let sum = 0;
  let shared = 0;
  for (const a of anchorsA) {
    const b = mapB.get(a.key);
    if (!b) continue;
    sum += Math.hypot(a.x - b.x, a.y - b.y);
    shared += 1;
  }
  if (shared === 0) return Infinity;
  return sum / shared;
}

// Finds the OCR word (or short run of adjacent words on the same line) whose
// text best matches `value`, so we can learn the field's on-page position
// from a value we already know is correct (the user's typed correction).
function locateValue(words, value) {
  const target = String(value || '').trim().toLowerCase();
  if (!target) return null;
  // Try growing windows of consecutive words (same line, close together) up
  // to 6 words, since names/addresses span multiple OCR word boxes.
  for (let start = 0; start < words.length; start++) {
    let acc = '';
    for (let end = start; end < Math.min(start + 6, words.length); end++) {
      acc = (acc ? acc + ' ' : '') + words[end].text;
      if (acc.toLowerCase().replace(/[^a-z0-9 ]/g, '') === target.replace(/[^a-z0-9 ]/g, '')) {
        const box = words.slice(start, end + 1);
        return {
          x0: Math.min(...box.map((w) => w.x0)),
          y0: Math.min(...box.map((w) => w.y0)),
          x1: Math.max(...box.map((w) => w.x1)),
          y1: Math.max(...box.map((w) => w.y1)),
        };
      }
    }
  }
  return null;
}

function nearestAnchor(box, anchors) {
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  let best = null;
  let bestDist = Infinity;
  for (const a of anchors) {
    const d = Math.hypot(a.x - cx, a.y - cy);
    if (d < bestDist) { bestDist = d; best = a; }
  }
  return best;
}

// Builds (or updates) a template from a confirmed-correct set of field
// values plus the OCR words from that same scan. Call this when the user
// saves a document after correcting/confirming the extracted fields.
function learnTemplate(existingTemplate, documentType, words, confirmedFields) {
  const anchors = findAnchors(words);
  const fields = { ...(existingTemplate ? existingTemplate.fields : {}) };
  for (const [fieldKey, value] of Object.entries(confirmedFields || {})) {
    if (!value) continue;
    const box = locateValue(words, value);
    if (!box) continue;
    const anchor = nearestAnchor(box, anchors);
    if (!anchor) continue;
    const offset = {
      anchorKey: anchor.key,
      dx: (box.x0 + box.x1) / 2 - anchor.x,
      dy: (box.y0 + box.y1) / 2 - anchor.y,
      width: box.x1 - box.x0,
      height: box.y1 - box.y0,
    };
    // Average with any existing offset for this field so the template
    // converges as more confirmed samples come in, rather than the latest
    // scan just overwriting a previously-learned position.
    const prior = fields[fieldKey];
    fields[fieldKey] = prior && prior.anchorKey === offset.anchorKey
      ? {
          anchorKey: offset.anchorKey,
          dx: (prior.dx + offset.dx) / 2,
          dy: (prior.dy + offset.dy) / 2,
          width: (prior.width + offset.width) / 2,
          height: (prior.height + offset.height) / 2,
        }
      : offset;
  }
  return {
    documentType,
    fingerprint: fingerprint(anchors),
    anchors,
    fields,
    sampleCount: (existingTemplate ? existingTemplate.sampleCount : 0) + 1,
  };
}

// Finds the best matching saved template for a new scan's anchors (within a
// distance threshold — a bad match is worse than no match) and, if found,
// reads each learned field's value off the new scan's words by relocating
// its anchor-relative offset.
const MATCH_DISTANCE_THRESHOLD = 0.05; // normalized page-fraction distance

function applyBestTemplate(templates, documentType, words) {
  const candidates = templates.filter((t) => t.documentType === documentType);
  if (candidates.length === 0) return null;
  const anchors = findAnchors(words);
  if (anchors.length === 0) return null;
  let best = null;
  let bestDist = Infinity;
  for (const t of candidates) {
    const d = distance(anchors, t.anchors);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  if (!best || bestDist > MATCH_DISTANCE_THRESHOLD) return null;
  const anchorByKey = new Map(anchors.map((a) => [a.key, a]));
  const result = {};
  for (const [fieldKey, offset] of Object.entries(best.fields)) {
    const anchor = anchorByKey.get(offset.anchorKey);
    if (!anchor) continue;
    const cx = anchor.x + offset.dx;
    const cy = anchor.y + offset.dy;
    const box = { x0: cx - offset.width / 2, y0: cy - offset.height / 2, x1: cx + offset.width / 2, y1: cy + offset.height / 2 };
    // Collect words whose centers fall inside the projected box.
    const hit = words
      .filter((w) => {
        const wx = (w.x0 + w.x1) / 2;
        const wy = (w.y0 + w.y1) / 2;
        return wx >= box.x0 - 0.02 && wx <= box.x1 + 0.02 && wy >= box.y0 - 0.02 && wy <= box.y1 + 0.02;
      })
      .map((w) => w.text)
      .join(' ')
      .trim();
    if (hit) result[fieldKey] = hit;
  }
  return { matchedTemplate: best, matchDistance: bestDist, fields: result };
}

module.exports = { findAnchors, fingerprint, distance, locateValue, learnTemplate, applyBestTemplate };