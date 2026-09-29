// Mongoose plugin: encrypt EVERY field of a collection at rest.
//
//   schema.plugin(encryptedFields, {
//     collection: "assets",                 // bound into every ciphertext (AAD)
//     plain: ["passwordHash", ...],         // fields that must stay plaintext (see docs)
//     lookups: { email: { unique: true }, userId: {} },   // equality-searchable via HMAC blind index
//     composites: [{ name, fields, unique, when }]         // composite uniqueness keys
//   });
//
// Application code keeps working with plaintext values: documents are decrypted on
// load/after save, .lean() results are decrypted, equality filters on `lookups`
// fields are rewritten to their blind index, and updates ($set / top-level) are
// encrypted. Anything that cannot work on ciphertext (range/regex filters, sorts,
// $inc/$push on encrypted fields, aggregate, bulkWrite, insertMany) THROWS instead of
// silently returning wrong results.
const mongoose = require("mongoose");
const vault = require("./fieldVault");
const Mixed = mongoose.Schema.Types.Mixed;

const ALWAYS_PLAIN = ["_id", "__v", "createdAt", "updatedAt"];
const CASTABLE = new Set(["String", "Date", "Number", "Boolean", "ObjectId"]);
const FILTER_OPS = ["find", "findOne", "findOneAndUpdate", "findOneAndDelete", "findOneAndReplace",
  "updateOne", "updateMany", "deleteOne", "deleteMany", "countDocuments", "distinct", "replaceOne"];
const UPDATE_OPS = ["findOneAndUpdate", "updateOne", "updateMany"];
const LEAN_OPS = ["find", "findOne", "findOneAndUpdate", "findOneAndDelete", "findOneAndReplace"];

function safeStringify(v) {
  try { return JSON.stringify(v); } catch (_) { return undefined; }
}

module.exports = function encryptedFields(schema, opts = {}) {
  const collection = opts.collection;
  if (!collection) throw new Error("[encryptedFields] `collection` option is required.");
  const plain = new Set([...ALWAYS_PLAIN, ...(opts.plain || [])]);
  const lookups = {};
  const casters = {};
  const composites = (opts.composites || []).map(c => ({ sparse: true, ...c }));
  const scopeOf = p => `${collection}.${p}`;
  const rootOf = p => String(p).split(".")[0];

  // ---- 1. inspect + rewrite the schema -----------------------------------------
  const original = {};
  for (const p of Object.keys(schema.paths)) {
    const root = rootOf(p);
    if (plain.has(root)) continue;
    if (p !== root) {
      throw new Error(`[encryptedFields:${collection}] nested path "${p}": declare "${root}" as one Mixed field (or add it to \`plain\`).`);
    }
    original[p] = schema.path(p);
  }
  for (const [p, cfg] of Object.entries(opts.lookups || {})) {
    if (plain.has(p)) throw new Error(`[encryptedFields:${collection}] lookup "${p}" cannot also be plain.`);
    const o = (original[p] && original[p].options) || {}; // dynamic (strict:false) fields have no schema path
    lookups[p] = {
      idx: cfg.idx || `${p}Idx`,
      unique: !!cfg.unique,
      lower: !!o.lowercase,
      trim: !!o.trim || o.trim === undefined,
      normalize: cfg.normalize,
      legacyHash: cfg.legacyHash
    };
  }
  for (const [p, orig] of Object.entries(original)) {
    const o = orig.options || {};
    const def = { type: Mixed };
    if (o.required) def.required = o.required;
    if ("default" in o) def.default = o.default;
    else if (orig.instance === "Array" || orig.instance === "DocumentArray") def.default = () => [];
    if (o.select === false) def.select = false;
    if (orig.instance !== "Mixed") schema.path(p, def);
    if (CASTABLE.has(orig.instance)) casters[p] = orig;
  }
  const idxSet = new Set();
  for (const L of Object.values(lookups)) {
    idxSet.add(L.idx);
    schema.add({ [L.idx]: L.unique ? { type: String, unique: true, sparse: true } : { type: String, index: true } });
  }
  for (const c of composites) {
    idxSet.add(c.name);
    schema.add({ [c.name]: c.unique ? { type: String, unique: true, sparse: c.sparse } : { type: String, index: true } });
  }
  const compositeFields = new Set(composites.flatMap(c => c.fields));
  const isPlainKey = k => plain.has(rootOf(k)) || idxSet.has(rootOf(k));

  // ---- 2. helpers ---------------------------------------------------------------
  function normalizeFor(p, v) {
    const L = lookups[p];
    let s = String(v);
    if (L) {
      if (L.trim) s = s.trim();
      if (L.lower) s = s.toLowerCase();
      if (L.normalize) s = L.normalize(s);
    }
    return s;
  }
  function hashLookup(p, v) {
    if (v === undefined || v === null) return undefined;
    const L = lookups[p];
    if (L.legacyHash) return L.legacyHash(v) || undefined;
    const s = normalizeFor(p, v);
    return s === "" ? undefined : vault.blindIndex(scopeOf(p), s);
  }
  function hashComposite(c, getter) {
    const parts = [];
    for (const f of c.fields) {
      const v = getter(f);
      if (v === undefined || v === null || v === "") return undefined;
      parts.push(normalizeFor(f, v));
    }
    return vault.blindIndex(scopeOf(c.name), parts.join("\u0000"));
  }
  function decryptKey(k, v) {
    try {
      return vault.decryptValue(scopeOf(k), v);
    } catch (err) {
      console.error(`[encryptedFields] could not decrypt ${scopeOf(k)}:`, err.message);
      return null;
    }
  }
  function decryptRaw(obj) {
    if (!obj || typeof obj !== "object") return obj;
    for (const k of Object.keys(obj)) {
      if (idxSet.has(k)) { delete obj[k]; continue; }
      if (plain.has(k)) continue;
      if (vault.isEncrypted(obj[k])) obj[k] = decryptKey(k, obj[k]);
    }
    return obj;
  }
  function snapshot(doc) {
    const snap = {};
    for (const k of Object.keys(doc._doc)) {
      if (isPlainKey(k)) continue;
      const v = doc._doc[k];
      if (v && typeof v === "object" && !(v instanceof Date)) snap[k] = safeStringify(v);
    }
    doc.$locals.encSnap = snap;
  }
  // strict:false models: Mongoose mirrors unknown fields onto the instance as plain own
  // properties at load time (doc.valueAmount). Keep those in sync with the decrypted _doc.
  const syncOwn = (doc, k) => {
    if (!schema.paths[k] && Object.prototype.hasOwnProperty.call(doc, k)) doc[k] = doc._doc[k];
  };
  function decryptDoc(doc) {
    const raw = doc._doc;
    for (const k of Object.keys(raw)) {
      if (idxSet.has(k) || plain.has(k)) continue;
      if (vault.isEncrypted(raw[k])) {
        raw[k] = decryptKey(k, raw[k]);
        syncOwn(doc, k);
      }
    }
    snapshot(doc);
  }

  // ---- 3. document middleware ---------------------------------------------------
  schema.post("init", function (doc) { decryptDoc(doc); });

  schema.pre("validate", function (next) {
    for (const [p, orig] of Object.entries(casters)) {
      const v = this._doc[p];
      if (v === undefined || v === null) continue;
      if (!this.isNew && !this.isModified(p)) continue;
      try {
        const c = orig.applySetters(v, this);
        this._doc[p] = c;
        const err = orig.doValidateSync(c, this);
        if (err) this.invalidate(p, err.message, c, err.kind);
      } catch (e) {
        this.invalidate(p, e.message, v);
      }
    }
    next();
  });

  schema.pre("save", function (next) {
    try {
      const raw = this._doc;
      for (const [p, L] of Object.entries(lookups)) this.set(L.idx, hashLookup(p, raw[p]));
      for (const c of composites) {
        const on = c.when ? c.when(raw) : true;
        this.set(c.name, on ? hashComposite(c, f => raw[f]) : undefined);
      }
      const snap = this.$locals.encSnap || {};
      const pending = {};
      for (const k of Object.keys(raw)) {
        if (isPlainKey(k)) continue;
        const v = raw[k];
        if (v === undefined || v === null) continue;
        let dirty = this.isNew || this.isModified(k);
        if (!dirty && v && typeof v === "object" && !(v instanceof Date) && safeStringify(v) !== snap[k]) dirty = true;
        if (!dirty) continue;
        pending[k] = v;
        this.set(k, vault.encryptValue(scopeOf(k), v));
      }
      this.$locals.encPending = pending;
      next();
    } catch (err) {
      next(err);
    }
  });
  const restore = doc => {
    const pending = doc.$locals.encPending;
    if (pending) {
      for (const [k, v] of Object.entries(pending)) {
        doc._doc[k] = v;
        syncOwn(doc, k);
      }
      doc.$locals.encPending = null;
    }
    snapshot(doc);
  };
  schema.post("save", function (doc) { restore(doc); });
  schema.post("save", function (err, doc, next) { restore(doc); next(err); });

  // ---- 4. query middleware ------------------------------------------------------
  const fail = (what, k) => new Error(
    `[encryptedFields:${collection}] ${what} "${k}" is encrypted at rest and cannot be evaluated by MongoDB. ` +
    `Fetch by an indexed lookup field and do this in application code.`);

  function rewriteLookupValue(p, v) {
    const L = lookups[p];
    if (v === null) return null;
    if (v instanceof RegExp) throw fail("regex filter on", p);
    if (v && typeof v === "object" && !(v instanceof Date) && !(v._bsontype)) {
      const out = {};
      for (const [op, arg] of Object.entries(v)) {
        if (op === "$eq" || op === "$ne") out[op] = arg === null ? null : hashLookup(p, arg);
        else if (op === "$in" || op === "$nin") out[op] = arg.map(x => (x === null ? null : hashLookup(p, x)));
        else if (op === "$exists") out[op] = arg;
        else throw fail(`operator ${op} on`, p);
      }
      return out;
    }
    return hashLookup(p, v) ?? "__no_match__";
  }
  function rewriteFilter(filter) {
    if (!filter || typeof filter !== "object") return filter;
    const out = {};
    for (const [k, v] of Object.entries(filter)) {
      if (k === "$or" || k === "$and" || k === "$nor") { out[k] = v.map(rewriteFilter); continue; }
      if (k.startsWith("$")) throw fail(`operator ${k} in filter on`, collection);
      const root = rootOf(k);
      if (isPlainKey(k)) { out[k] = v; continue; }
      if (lookups[root] && k === root) { out[lookups[root].idx] = rewriteLookupValue(root, v); continue; }
      throw fail("filter on", k);
    }
    return out;
  }
  function processField(bag, key) {
    const root = rootOf(key);
    if (isPlainKey(key)) return;
    if (key !== root) throw fail("dotted update into", key);
    if (compositeFields.has(root)) throw new Error(`[encryptedFields:${collection}] "${root}" feeds a composite key; update it via doc.save().`);
    let v = bag[key];
    if (v === undefined) return;
    if (v !== null) {
      if (casters[root]) v = casters[root].applySetters(v, {});
      bag[key] = vault.encryptValue(scopeOf(root), v);
    }
    if (lookups[root]) bag[lookups[root].idx] = v === null ? null : hashLookup(root, v);
  }
  function rewriteUpdate(upd) {
    if (!upd) return upd;
    if (Array.isArray(upd)) throw new Error(`[encryptedFields:${collection}] pipeline updates are not supported.`);
    for (const key of Object.keys(upd)) {
      if (!key.startsWith("$")) { processField(upd, key); continue; }
      const bag = upd[key];
      if (key === "$set" || key === "$setOnInsert") {
        for (const f of Object.keys(bag)) processField(bag, f);
      } else if (key === "$unset") {
        for (const f of Object.keys(bag)) {
          if (isPlainKey(f)) continue;
          if (f !== rootOf(f)) throw fail("dotted $unset on", f);
          if (lookups[f]) bag[lookups[f].idx] = "";
        }
      } else {
        for (const f of Object.keys(bag)) {
          if (!isPlainKey(f)) throw fail(`${key} on`, f);
        }
      }
    }
    return upd;
  }
  function assertSortable(q) {
    const sort = q.options && q.options.sort;
    if (!sort) return;
    const ks = sort instanceof Map ? [...sort.keys()] : Array.isArray(sort) ? sort.map(s => s[0]) : Object.keys(sort);
    for (const k of ks) if (!isPlainKey(k)) throw fail("sort on", k);
  }

  schema.pre(FILTER_OPS, { query: true, document: false }, function (next) {
    try {
      this.setQuery(rewriteFilter(this.getFilter()));
      assertSortable(this);
      if (this.op === "distinct") {
        const f = this._distinct;
        if (!isPlainKey(f)) throw fail("distinct on", f);
      }
      next();
    } catch (err) {
      next(err);
    }
  });
  schema.pre(UPDATE_OPS, { query: true, document: false }, function (next) {
    try {
      rewriteUpdate(this.getUpdate());
      next();
    } catch (err) {
      next(err);
    }
  });
  schema.pre("replaceOne", { query: true, document: false }, function (next) {
    next(new Error(`[encryptedFields:${collection}] replaceOne is not supported; use doc.save().`));
  });
  schema.post(LEAN_OPS, function (res) {
    const lean = this.mongooseOptions && this.mongooseOptions().lean;
    if (!lean || !res) return;
    (Array.isArray(res) ? res : [res]).forEach(decryptRaw);
  });
  const unsupported = name => function (next) {
    next(new Error(`[encryptedFields:${collection}] ${name} bypasses field encryption; use create()/save().`));
  };
  schema.pre("insertMany", unsupported("insertMany"));
  schema.pre("aggregate", unsupported("aggregate"));
  schema.pre("bulkWrite", unsupported("bulkWrite"));

  // ---- 5. never leak blind indexes through toJSON/toObject ----------------------
  for (const kind of ["toJSON", "toObject"]) {
    const prev = schema.get(kind) || {};
    schema.set(kind, {
      ...prev,
      transform(doc, ret, o) {
        for (const i of idxSet) delete ret[i];
        return prev.transform ? prev.transform(doc, ret, o) || ret : ret;
      }
    });
  }

  // ---- 6. migration support -----------------------------------------------------
  // Given a raw driver document, returns {set, unset} that brings it to the current
  // encrypted format (idempotent).
  schema.statics.encryptionPlan = function (rawDoc) {
    const plainVals = {};
    const set = {};
    const unset = {};
    for (const k of Object.keys(rawDoc)) {
      if (isPlainKey(k)) continue;
      const v = rawDoc[k];
      if (v === undefined || v === null) continue;
      if (vault.isCurrent(v)) { plainVals[k] = vault.decryptValue(scopeOf(k), v); continue; }
      plainVals[k] = vault.isEncrypted(v) ? vault.decryptValue(scopeOf(k), v) : v;
      set[k] = vault.encryptValue(scopeOf(k), plainVals[k]);
    }
    for (const [p, L] of Object.entries(lookups)) {
      const h = hashLookup(p, plainVals[p]);
      if (h === undefined) { if (rawDoc[L.idx] !== undefined) unset[L.idx] = ""; }
      else if (rawDoc[L.idx] !== h) set[L.idx] = h;
    }
    for (const c of composites) {
      const h = (c.when ? c.when(plainVals) : true) ? hashComposite(c, f => plainVals[f]) : undefined;
      if (h === undefined) { if (rawDoc[c.name] !== undefined) unset[c.name] = ""; }
      else if (rawDoc[c.name] !== h) set[c.name] = h;
    }
    return { set, unset };
  };
  schema.statics.encryptionInfo = () => ({ collection, plain: [...plain], lookups: Object.keys(lookups) });
};
