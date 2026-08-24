// Mirrors `_documentTypeFieldsMap` in upload_screen.dart.
// Keep these two in sync: if you add/remove a FieldSpec on the Flutter
// side for a documentType, mirror the change here.
//
// Frontend key 'amount' is stored as 'valueAmount' in the DB — everything
// else keeps the same key name on both sides.

const DOCUMENT_TYPE_FIELDS = {
  'Aadhaar Card': ['documentNumber', 'issuingAuthority'],
  'PAN Card': ['documentNumber', 'issuingAuthority'],
  'Passport': ['documentNumber', 'issuingAuthority', 'expiryDate'],
  'Driving Licence': ['documentNumber', 'issuingAuthority', 'expiryDate'],
  'Voter ID': ['documentNumber', 'issuingAuthority'],
  'Bank Account Documents': ['documentNumber', 'issuingAuthority'],
  'Fixed Deposits (FDs)': ['documentNumber', 'issuingAuthority', 'valueAmount', 'expiryDate'],
  'Health Insurance': ['documentNumber', 'issuingAuthority', 'valueAmount', 'expiryDate'],
  'Life Insurance': ['documentNumber', 'issuingAuthority', 'valueAmount', 'expiryDate'],
  'Vehicle Insurance': ['documentNumber', 'issuingAuthority', 'expiryDate'],
  'Home Insurance': ['documentNumber', 'issuingAuthority', 'expiryDate'],
  'Travel Insurance': ['documentNumber', 'issuingAuthority', 'expiryDate'],
  'Medical Reports': ['issuingAuthority'],
  'Prescriptions': ['issuingAuthority'],
  'RC Book': ['documentNumber', 'issuingAuthority'],
  'PUC Certificate': ['documentNumber', 'expiryDate'],
  'Purchase Invoice': ['invoiceNumber', 'issuingAuthority', 'valueAmount'],
  'Warranty': ['invoiceNumber', 'issuingAuthority', 'expiryDate'],
  'Hallmark Certificate': ['documentNumber', 'issuingAuthority'],
  'Valuation Certificate': ['issuingAuthority', 'valueAmount'],
  'Flight Tickets': ['invoiceNumber', 'issuingAuthority'],
  'Hotel Bookings': ['invoiceNumber', 'issuingAuthority'],
  'Visa': ['documentNumber', 'issuingAuthority', 'expiryDate'],
  'Salary Slips': ['issuingAuthority', 'valueAmount'],
  'Degree Certificate': ['documentNumber', 'issuingAuthority'],
  'Mark Sheets': ['documentNumber', 'issuingAuthority'],
  'GST Documents': ['documentNumber', 'issuingAuthority'],
  'Business PAN': ['documentNumber', 'issuingAuthority'],
  'Patent Application': ['documentNumber', 'issuingAuthority'],
  'Granted Patents': ['documentNumber', 'issuingAuthority'],
  'Trademark Registration': ['documentNumber', 'issuingAuthority'],
  'Will': ['issuingAuthority'],
  'Power of Attorney': ['issuingAuthority'],
};

// Anything not listed above (this currently includes Mobile Phone, Laptop,
// TV, Refrigerator, Washing Machine, and every other type not explicitly
// mapped on the Flutter side) falls back to this set — matching
// `_defaultDocumentFields` in upload_screen.dart.
const DEFAULT_FIELDS = ['documentNumber', 'issuingAuthority', 'expiryDate', 'valueAmount'];

// The full universe of dynamic keys that exist on the Asset schema.
const ALL_DYNAMIC_FIELDS = ['documentNumber', 'issuingAuthority', 'expiryDate', 'valueAmount', 'invoiceNumber'];

// `documentType` here is the value stored in Asset.subSubCategory — the
// DB no longer has a separate documentType field (subSubCategory and
// documentType were always the same value, so we only store it once).
function getFieldsForDocumentType(documentType) {
  return DOCUMENT_TYPE_FIELDS[documentType] || DEFAULT_FIELDS;
}

/**
 * Builds the dynamic-field portion of an Asset document for the given
 * documentType (i.e. Asset.subSubCategory). Every key in ALL_DYNAMIC_FIELDS
 * is present in the result; only the ones applicable to this documentType
 * get a real value pulled from assetData — everything else is explicitly ''.
 */
function buildDynamicFields(documentType, assetData) {
  const applicableFields = getFieldsForDocumentType(documentType);
  const result = {};

  for (const key of ALL_DYNAMIC_FIELDS) {
    if (!applicableFields.includes(key)) {
      result[key] = '';
      continue;
    }

    const rawValue = assetData[key];
    if (rawValue === undefined || rawValue === null) {
      result[key] = '';
      continue;
    }

    const trimmed = String(rawValue).trim();
    // The Flutter app sends '-' for anything the user left blank.
    if (trimmed === '' || trimmed === '-') {
      result[key] = '';
      continue;
    }

    result[key] = trimmed;
  }

  return result;
}

module.exports = { DOCUMENT_TYPE_FIELDS, DEFAULT_FIELDS, ALL_DYNAMIC_FIELDS, getFieldsForDocumentType, buildDynamicFields };