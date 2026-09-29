const {isSensitiveKey, isEncrypted, encryptField, decryptField, blindIndex} = require("./fieldCrypto");
function sensitiveKeysOf(obj) {
  return Object.keys(obj || {}).filter(k => isSensitiveKey(k) && !k.endsWith("Idx"));
}
function decryptDoc(doc) {
  const raw = doc._doc;
  for (const k of sensitiveKeysOf(raw)) {
    if (!isEncrypted(raw[k])) continue;
    try {
      raw[k] = decryptField(raw[k]);
    } catch (err) {
      console.error(`[assetFieldEncryption] could not decrypt "${k}":`, err.message);
      raw[k] = "";
    }
  }
}
const hideIndex = (doc, ret) => {
  delete ret.documentNumberIdx;
  return ret;
};
module.exports = function assetFieldEncryption(schema) {
  schema.set("toObject", {transform: hideIndex});
  schema.set("toJSON", {transform: hideIndex});
  schema.pre("save", function(next) {
    try {
      for (const k of sensitiveKeysOf(this._doc)) {
        const v = this._doc[k];
        if (typeof v !== "string" || v === "" || isEncrypted(v)) continue;
        if (!this.isNew && !this.isModified(k)) continue;
        if (k === "documentNumber") this.set("documentNumberIdx", blindIndex(v));
        this.set(k, encryptField(v));
      }
      next();
    } catch (err) {
      next(err);
    }
  });
  schema.post("save", function(doc) {
    decryptDoc(doc);
  });
  schema.post("init", function(doc) {
    decryptDoc(doc);
  });
  schema.pre("findOneAndUpdate", function(next) {
    try {
      const update = this.getUpdate() || {};
      for (const bag of [update, update.$set]) {
        if (!bag) continue;
        for (const k of sensitiveKeysOf(bag)) {
          const v = bag[k];
          if (typeof v !== "string" || v === "" || isEncrypted(v)) continue;
          if (k === "documentNumber") bag.documentNumberIdx = blindIndex(v);
          bag[k] = encryptField(v);
        }
        if (Object.prototype.hasOwnProperty.call(bag, "documentNumber") && bag.documentNumber === "") bag.documentNumberIdx = "";
      }
      next();
    } catch (err) {
      next(err);
    }
  });
};
