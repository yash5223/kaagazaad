const ANCHOR_PATTERNS = [ {
  key: "genderWord",
  test: w => /^(male|female|transgender)$/i.test(w.text)
}, {
  key: "numberGroup",
  test: w => /^\d{4}$/.test(w.text)
}, {
  key: "aadhaarLabel",
  test: w => /^aadhaar$/i.test(w.text)
}, {
  key: "panLabel",
  test: w => /^income$/i.test(w.text)
} ];
const GENERIC_ANCHOR_WORD_RE = /^[A-Za-z][A-Za-z.'-]{2,}$/;
function findAnchors(words) {
  const found = [];
  for (const pattern of ANCHOR_PATTERNS) {
    const match = words.find(w => pattern.test(w));
    if (match) found.push({
      key: pattern.key,
      x: (match.x0 + match.x1) / 2,
      y: (match.y0 + match.y1) / 2
    });
  }
  const seen = new Set(found.map(a => a.key));
  for (const w of words) {
    const text = String(w.text || "").trim();
    if (!GENERIC_ANCHOR_WORD_RE.test(text)) continue;
    const key = `w:${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      key: key,
      x: (w.x0 + w.x1) / 2,
      y: (w.y0 + w.y1) / 2
    });
  }
  return found;
}
function fingerprint(anchors) {
  return anchors.slice().sort((a, b) => a.key.localeCompare(b.key)).map(a => `${a.key}:${a.x.toFixed(2)},${a.y.toFixed(2)}`).join("|");
}
function distance(anchorsA, anchorsB) {
  const mapB = new Map(anchorsB.map(a => [ a.key, a ]));
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
function locateValue(words, value) {
  const target = String(value || "").trim().toLowerCase();
  if (!target) return null;
  for (let start = 0; start < words.length; start++) {
    let acc = "";
    for (let end = start; end < Math.min(start + 6, words.length); end++) {
      acc = (acc ? acc + " " : "") + words[end].text;
      if (acc.toLowerCase().replace(/[^a-z0-9 ]/g, "") === target.replace(/[^a-z0-9 ]/g, "")) {
        const box = words.slice(start, end + 1);
        return {
          x0: Math.min(...box.map(w => w.x0)),
          y0: Math.min(...box.map(w => w.y0)),
          x1: Math.max(...box.map(w => w.x1)),
          y1: Math.max(...box.map(w => w.y1))
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
    if (d < bestDist) {
      bestDist = d;
      best = a;
    }
  }
  return best;
}
function learnTemplate(existingTemplate, documentType, words, confirmedFields) {
  const anchors = findAnchors(words);
  const fields = {
    ...existingTemplate ? existingTemplate.fields : {}
  };
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
      height: box.y1 - box.y0
    };
    const prior = fields[fieldKey];
    fields[fieldKey] = prior && prior.anchorKey === offset.anchorKey ? {
      anchorKey: offset.anchorKey,
      dx: (prior.dx + offset.dx) / 2,
      dy: (prior.dy + offset.dy) / 2,
      width: (prior.width + offset.width) / 2,
      height: (prior.height + offset.height) / 2
    } : offset;
  }
  return {
    documentType: documentType,
    fingerprint: fingerprint(anchors),
    anchors: anchors,
    fields: fields,
    sampleCount: (existingTemplate ? existingTemplate.sampleCount : 0) + 1
  };
}
const MATCH_DISTANCE_THRESHOLD = .05;
function applyBestTemplate(templates, documentType, words) {
  const candidates = templates.filter(t => t.documentType === documentType);
  if (candidates.length === 0) return null;
  const anchors = findAnchors(words);
  if (anchors.length === 0) return null;
  let best = null;
  let bestDist = Infinity;
  for (const t of candidates) {
    const d = distance(anchors, t.anchors);
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  if (!best || bestDist > MATCH_DISTANCE_THRESHOLD) return null;
  const anchorByKey = new Map(anchors.map(a => [ a.key, a ]));
  const result = {};
  for (const [fieldKey, offset] of Object.entries(best.fields)) {
    const anchor = anchorByKey.get(offset.anchorKey);
    if (!anchor) continue;
    const cx = anchor.x + offset.dx;
    const cy = anchor.y + offset.dy;
    const box = {
      x0: cx - offset.width / 2,
      y0: cy - offset.height / 2,
      x1: cx + offset.width / 2,
      y1: cy + offset.height / 2
    };
    const hit = words.filter(w => {
      const wx = (w.x0 + w.x1) / 2;
      const wy = (w.y0 + w.y1) / 2;
      return wx >= box.x0 - .02 && wx <= box.x1 + .02 && wy >= box.y0 - .02 && wy <= box.y1 + .02;
    }).map(w => w.text).join(" ").trim();
    if (hit) result[fieldKey] = hit;
  }
  return {
    matchedTemplate: best,
    matchDistance: bestDist,
    fields: result
  };
}
module.exports = {
  findAnchors: findAnchors,
  fingerprint: fingerprint,
  distance: distance,
  locateValue: locateValue,
  learnTemplate: learnTemplate,
  applyBestTemplate: applyBestTemplate
};