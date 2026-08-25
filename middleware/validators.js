const { z } = require('zod');
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid ID.');
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
const strongPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(128, 'Password is too long.')
  .refine((v) => /[a-z]/.test(v), 'Password must include a lowercase letter.')
  .refine((v) => /[A-Z]/.test(v), 'Password must include an uppercase letter.')
  .refine((v) => /[0-9]/.test(v), 'Password must include a number.')
  .refine((v) => /[^A-Za-z0-9]/.test(v), 'Password must include a special character.');
const pinCode = z.string().regex(/^\d{4,6}$/, 'PIN must be 4 to 6 digits.');
const inviteToken = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{32}$/, 'Invalid invite token.');
const contactLookup = z
  .string()
  .trim()
  .min(1)
  .max(254)
  .refine((v) => !/[\x00-\x1f]/.test(v), 'Invalid value.');
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
    passwordHash: strongPassword, 
  }).passthrough(),
  resetPassword: z.object({
    newPassword: strongPassword,
  }).passthrough(),
  pinBody: z.object({
    pin: pinCode,
  }).passthrough(),
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
