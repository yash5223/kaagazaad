const {z: z} = require("zod");
const {isWeakPin: isWeakPin, WEAK_PIN_MESSAGE: WEAK_PIN_MESSAGE} = require("../utils/pinPolicy");
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Must be a valid ID.");
const customerId = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, "Invalid account ID.");
const email = z.string().trim().toLowerCase().max(254).email("Must be a valid email address.");
const safeFilename = z.string().trim().min(1).max(2048).refine(v => !v.includes("..") && !/[\x00-\x1f]/.test(v), "Invalid filename.");
const isoDateString = z.string().refine(v => !Number.isNaN(Date.parse(v)), "Must be a valid date.");
const nonEmptyString = (max = 500) => z.string().trim().min(1).max(max);
const optionalString = (max = 500) => z.string().trim().max(max).optional().default("");
const moneyAmount = z.union([ z.number(), z.string() ]).transform(v => typeof v === "number" ? v : parseFloat(v)).refine(n => Number.isFinite(n) && n >= 0, "Must be a non-negative number.");
const strongPassword = z.string().min(8, "Password must be at least 8 characters.").max(128, "Password is too long.").refine(v => /[a-z]/.test(v), "Password must include a lowercase letter.").refine(v => /[A-Z]/.test(v), "Password must include an uppercase letter.").refine(v => /[0-9]/.test(v), "Password must include a number.").refine(v => /[^A-Za-z0-9]/.test(v), "Password must include a special character.");
// E2EE: the client never sends the real password. It sends a 256-bit secret derived from it
// (PBKDF2 -> HKDF "kz-auth"), so password-strength rules are enforced in the app, not here.
const authSecret = z.string().regex(/^[0-9a-f]{64}$/, "Invalid credential format.");
const b64url = (max) => z.string().min(16).max(max).regex(/^[A-Za-z0-9_.\-]+$/, "Invalid encrypted value.");
const e2eeBundle = z.object({
  v: z.literal(1),
  kdfIter: z.number().int().min(600000).max(5000000),
  wrappedMk: b64url(400),
  recoveryWrappedMk: b64url(400)
});
const pinCode = z.string().regex(/^\d{5,6}$/, "PIN must be 5 or 6 digits.").refine(v => !isWeakPin(v), WEAK_PIN_MESSAGE);
const sharePinCode = z.string().trim().regex(/^\d{4,6}$/, "PIN must be 4 to 6 digits.").refine(v => !isWeakPin(v), WEAK_PIN_MESSAGE);
const inviteToken = z.string().trim().regex(/^[0-9a-f]{32}$/, "Invalid invite token.");
const contactLookup = z.string().trim().min(1).max(254).refine(v => !/[\x00-\x1f]/.test(v), "Invalid value.");
const assetDataSchema = z.object({
  _id: objectId.optional(),
  id: objectId.optional(),
  name: nonEmptyString(200),
  category: nonEmptyString(100),
  subCategory: nonEmptyString(100),
  subSubCategory: optionalString(100),
  documentType: optionalString(100),
  issueDate: z.string().optional(),
  notesOrAddress: optionalString(2e3),
  storeOrSeller: optionalString(200)
}).passthrough();
const schemas = {
  saveAssetBody: z.object({
    assetData: z.string().min(1, "Asset parameters are missing.")
  }),
  assetData: assetDataSchema,
  appendDocumentBody: z.object({
    assetId: objectId
  }),
  deleteDocumentBody: z.object({
    assetId: objectId,
    filename: safeFilename
  }),
  logDownloadBody: z.object({
    assetId: objectId,
    filename: safeFilename.optional()
  }),
  assetIdParam: z.object({
    id: objectId
  }),
  serviceRecordBody: z.object({
    assetId: objectId,
    title: nonEmptyString(200),
    date: isoDateString,
    cost: moneyAmount,
    notes: optionalString(1e3)
  }),
  editServiceRecordBody: z.object({
    assetId: objectId,
    recordId: objectId,
    title: nonEmptyString(200),
    date: isoDateString,
    cost: moneyAmount,
    notes: optionalString(1e3)
  }),
  deleteServiceRecordBody: z.object({
    assetId: objectId,
    recordId: objectId
  }),
  emailOnly: z.object({
    email: email
  }),
  registerPassword: z.object({
    passwordHash: authSecret,
    e2ee: e2eeBundle
  }).passthrough(),
  resetPassword: z.object({
    newPassword: authSecret,
    e2ee: e2eeBundle
  }).passthrough(),
  e2eeUpgrade: z.object({
    currentPassword: z.string().min(1).max(128),
    newAuthSecret: authSecret,
    e2ee: e2eeBundle
  }),
  e2eeChangePassword: z.object({
    currentAuthSecret: authSecret,
    newAuthSecret: authSecret,
    e2ee: e2eeBundle
  }),
  e2eeSaveAsset: z.object({
    id: objectId.optional(),
    blob: b64url(2e6),
    wrappedDek: b64url(400),
    docIds: z.array(z.string().min(1).max(300)).max(20).default([])
  }),
  pinBody: z.object({
    pin: pinCode
  }).passthrough(),
  createInviteBody: z.object({
    role: z.enum([ "view", "edit", "admin" ], {
      errorMap: () => ({
        message: "Role must be view, edit, or admin."
      })
    })
  }),
  inviteTokenParam: z.object({
    token: inviteToken
  }),
  joinBody: z.object({
    token: inviteToken
  }),
  memberIdParam: z.object({
    id: objectId
  }),
  shareDocumentBody: z.object({
    assetId: objectId,
    documentPath: optionalString(2048),
    documentName: optionalString(200),
    receiver: contactLookup,
    recipientLabel: optionalString(120),
    expiresInMinutes: z.coerce.number().int().min(5).max(60 * 24 * 90).optional(),
    viewOnly: z.boolean().optional().default(true),
    pin: sharePinCode.optional().or(z.literal("")).default(""),
    watermarkText: optionalString(120)
  }),
  sharedAssetIdParam: z.object({
    assetId: objectId
  }),
  sharedIdParam: z.object({
    id: objectId
  })
};
function validate(schema, source = "body") {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues.map(issue => ({
        field: issue.path.join(".") || source,
        message: issue.message
      }));
      return res.status(400).json({
        error: "Validation failed.",
        details: details
      });
    }
    req[source] = result.data;
    return next();
  };
}
function validateAssetDataField(req, res, next) {
  let parsed;
  try {
    parsed = JSON.parse(req.body.assetData);
  } catch {
    return res.status(400).json({
      error: "Asset parameters are not valid JSON."
    });
  }
  const result = schemas.assetData.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues.map(issue => ({
      field: issue.path.join(".") || "assetData",
      message: issue.message
    }));
    return res.status(400).json({
      error: "Validation failed.",
      details: details
    });
  }
  req.assetData = result.data;
  return next();
}
module.exports = {
  z: z,
  schemas: schemas,
  validate: validate,
  validateAssetDataField: validateAssetDataField,
  objectId: objectId,
  customerId: customerId,
  email: email,
  safeFilename: safeFilename,
  isoDateString: isoDateString,
  nonEmptyString: nonEmptyString,
  moneyAmount: moneyAmount,
  strongPassword: strongPassword,
  authSecret: authSecret,
  pinCode: pinCode,
  inviteToken: inviteToken,
  contactLookup: contactLookup
};
