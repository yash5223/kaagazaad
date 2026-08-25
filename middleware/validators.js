const { z } = require('zod');

// ---------------------------------------------------------------------
// Reusable primitives
// ---------------------------------------------------------------------

// A Mongo ObjectId as used for _id / assetId / recordId path & body params.
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid ID.');

// App-generated customer IDs (see models/User.js) — bounded length,
// restricted charset, so a client can never smuggle something absurd
// through into a query.
const customerId = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid account ID.');

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .email('Must be a valid email address.');

// Filenames/identifiers arriving from clients (e.g. delete-document's
// `filename`, which today is a Cloudinary URL) — bounded length, no path
// traversal sequences, no control characters.
const safeFilename = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((v) => !v.includes('..') && !/[\x00-\x1f]/.test(v), 'Invalid filename.');

const isoDateString = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Must be a valid date.');

const nonEmptyString = (max = 500) => z.string().trim().min(1).max(max);
const optionalString = (max = 500) => z.string().trim().max(max).optional().default('');

const moneyAmount = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === 'number' ? v : parseFloat(v)))
  .refine((n) => Number.isFinite(n) && n >= 0, 'Must be a non-negative number.');

// Minimum password strength: 8+ chars, at least one uppercase, one
// lowercase, one digit, and one special character. Capped at 128 to keep
// bcrypt's input bounded (bcrypt itself silently truncates beyond 72
// bytes, but there's no reason to accept an arbitrarily long string here).
const strongPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(128, 'Password is too long.')
  .refine((v) => /[a-z]/.test(v), 'Password must include a lowercase letter.')
  .refine((v) => /[A-Z]/.test(v), 'Password must include an uppercase letter.')
  .refine((v) => /[0-9]/.test(v), 'Password must include a number.')
  .refine((v) => /[^A-Za-z0-9]/.test(v), 'Password must include a special character.');

// PIN used for the app's secondary/2FA unlock (see routes/userRoutes.js
// set-pin/verify-pin). 4-6 digits, matching the existing UI.
const pinCode = z.string().regex(/^\d{4,6}$/, 'PIN must be 4 to 6 digits.');

// Vault invite token: `crypto.randomBytes(16).toString('hex')` in
// routes/vaultRoutes.js — always exactly 32 lowercase hex chars. Rejecting
// anything else here is what stops a client from sending a Mongo query
// operator object (e.g. `{ "$ne": null }`) instead of a real token string
// and having it evaluated as part of the `Invite.findOne({ token })`
// query — that would match ANY pending invite instead of the specific one
// the caller was actually given.
const inviteToken = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{32}$/, 'Invalid invite token.');

// Free-text "email or phone" a document is being shared to
// (routes/vaultRoutes.js share-document). Bounded length, no control
// characters — actual email/phone shape is checked downstream by looking
// the value up against real User records, so this only needs to guarantee
// it's a plain string a Mongo query can safely embed.
const contactLookup = z
  .string()
  .trim()
  .min(1)
  .max(254)
  .refine((v) => !/[\x00-\x1f]/.test(v), 'Invalid value.');

// ---------------------------------------------------------------------
// Route-specific schemas
// ---------------------------------------------------------------------

// `assetData` arrives as a JSON string inside multipart form data
// (see routes/assetRoutes.js). This validates the *parsed* object.
// `.passthrough()` because document-type-specific dynamic fields (spec
// fields, warranty numbers, etc.) are handled separately by
// config/documentFieldTemplates.js and vary by category — this layer only
// guarantees the fields every asset always needs are present and sane.
const assetDataSchema = z
  .object({
    _id: objectId.optional(),
    id: objectId.optional(),
    name: nonEmptyString(200),
    category: nonEmptyString(100),
    subCategory: nonEmptyString(100),
    subSubCategory: optionalString(100),
    documentType: optionalString(100),
    issueDate: z.string().optional(),
    notesOrAddress: optionalString(2000),
    storeOrSeller: optionalString(200),
  })
  .passthrough();

const schemas = {
  saveAssetBody: z.object({
    assetData: z.string().min(1, 'Asset parameters are missing.'),
  }),
  assetData: assetDataSchema,
  appendDocumentBody: z.object({
    assetId: objectId,
  }),
  deleteDocumentBody: z.object({
    assetId: objectId,
    filename: safeFilename,
  }),
  assetIdParam: z.object({
    id: objectId,
  }),
  serviceRecordBody: z.object({
    assetId: objectId,
    title: nonEmptyString(200),
    date: isoDateString,
    cost: moneyAmount,
    notes: optionalString(1000),
  }),
  editServiceRecordBody: z.object({
    assetId: objectId,
    recordId: objectId,
    title: nonEmptyString(200),
    date: isoDateString,
    cost: moneyAmount,
    notes: optionalString(1000),
  }),
  deleteServiceRecordBody: z.object({
    assetId: objectId,
    recordId: objectId,
  }),
  emailOnly: z.object({
    email,
  }),
  registerPassword: z.object({
    passwordHash: strongPassword, // field name kept for compatibility — see routes/userRoutes.js
  }).passthrough(),
  resetPassword: z.object({
    newPassword: strongPassword,
  }).passthrough(),
  pinBody: z.object({
    pin: pinCode,
  }).passthrough(),
  // --- routes/vaultRoutes.js ---
  // Every body/param field this router reads is validated here — the
  // router previously read req.body/req.params directly with no shape
  // checks at all, which is what let a Mongo query operator be smuggled
  // in as e.g. `token` on /join (see inviteToken above).
  createInviteBody: z.object({
    role: z.enum(['view', 'edit', 'admin'], { errorMap: () => ({ message: 'Role must be view, edit, or admin.' }) }),
  }),
  inviteTokenParam: z.object({
    token: inviteToken,
  }),
  joinBody: z.object({
    token: inviteToken,
  }),
  memberIdParam: z.object({
    id: objectId,
  }),
  shareDocumentBody: z.object({
    assetId: objectId,
    documentPath: optionalString(2048),
    documentName: optionalString(200),
    receiver: contactLookup,
  }),
  sharedAssetIdParam: z.object({
    assetId: objectId,
  }),
  sharedIdParam: z.object({
    id: objectId,
  }),
};

// ---------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------

/**
 * Express middleware factory: validates & coerces `req[source]` (default
 * 'body') against a zod schema, replacing it with the parsed value on
 * success so downstream handlers get clean, typed data. On failure,
 * responds 400 with field-level messages — this is deliberately the ONLY
 * detail sent to the client; it never forwards a raw thrown error (see
 * middleware/errorHandler.js for that half of the "don't expose
 * err.message" rule).
 */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.') || source,
        message: issue.message,
      }));
      return res.status(400).json({ error: 'Validation failed.', details });
    }
    req[source] = result.data;
    return next();
  };
}

/**
 * Same as `validate`, but for the JSON-encoded `assetData` field inside
 * multipart form submissions — parses the JSON first (rejecting malformed
 * JSON up front) and then validates its shape.
 */
function validateAssetDataField(req, res, next) {
  let parsed;
  try {
    parsed = JSON.parse(req.body.assetData);
  } catch {
    return res.status(400).json({ error: 'Asset parameters are not valid JSON.' });
  }
  const result = schemas.assetData.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'assetData',
      message: issue.message,
    }));
    return res.status(400).json({ error: 'Validation failed.', details });
  }
  req.assetData = result.data;
  return next();
}

module.exports = {
  z,
  schemas,
  validate,
  validateAssetDataField,
  objectId,
  customerId,
  email,
  safeFilename,
  isoDateString,
  nonEmptyString,
  moneyAmount,
  strongPassword,
  pinCode,
  inviteToken,
  contactLookup,
};
