const DOCUMENT_TYPE_FIELDS = {
  "Aadhaar Card": [ "documentNumber", "issuingAuthority" ],
  "PAN Card": [ "documentNumber", "issuingAuthority" ],
  Passport: [ "documentNumber", "issuingAuthority", "expiryDate" ],
  "Driving Licence": [ "documentNumber", "issuingAuthority", "expiryDate" ],
  "Voter ID": [ "documentNumber", "issuingAuthority" ],
  "Bank Account Documents": [ "documentNumber", "issuingAuthority" ],
  "Fixed Deposits (FDs)": [ "documentNumber", "issuingAuthority", "valueAmount", "expiryDate" ],
  "Health Insurance": [ "documentNumber", "issuingAuthority", "valueAmount", "expiryDate" ],
  "Life Insurance": [ "documentNumber", "issuingAuthority", "valueAmount", "expiryDate" ],
  "Vehicle Insurance": [ "documentNumber", "issuingAuthority", "expiryDate" ],
  "Home Insurance": [ "documentNumber", "issuingAuthority", "expiryDate" ],
  "Travel Insurance": [ "documentNumber", "issuingAuthority", "expiryDate" ],
  "Medical Reports": [ "issuingAuthority" ],
  Prescriptions: [ "issuingAuthority" ],
  "RC Book": [ "documentNumber", "issuingAuthority" ],
  "PUC Certificate": [ "documentNumber", "expiryDate" ],
  "Purchase Invoice": [ "invoiceNumber", "issuingAuthority", "valueAmount" ],
  Warranty: [ "invoiceNumber", "issuingAuthority", "expiryDate" ],
  "Hallmark Certificate": [ "documentNumber", "issuingAuthority" ],
  "Valuation Certificate": [ "issuingAuthority", "valueAmount" ],
  "Flight Tickets": [ "invoiceNumber", "issuingAuthority" ],
  "Hotel Bookings": [ "invoiceNumber", "issuingAuthority" ],
  Visa: [ "documentNumber", "issuingAuthority", "expiryDate" ],
  "Salary Slips": [ "issuingAuthority", "valueAmount" ],
  "Degree Certificate": [ "documentNumber", "issuingAuthority" ],
  "Mark Sheets": [ "documentNumber", "issuingAuthority" ],
  "GST Documents": [ "documentNumber", "issuingAuthority" ],
  "Business PAN": [ "documentNumber", "issuingAuthority" ],
  "Patent Application": [ "documentNumber", "issuingAuthority" ],
  "Granted Patents": [ "documentNumber", "issuingAuthority" ],
  "Trademark Registration": [ "documentNumber", "issuingAuthority" ],
  Will: [ "issuingAuthority" ],
  "Power of Attorney": [ "issuingAuthority" ]
};
const DEFAULT_FIELDS = [ "documentNumber", "issuingAuthority", "expiryDate", "valueAmount" ];
const ALL_DYNAMIC_FIELDS = [ "documentNumber", "issuingAuthority", "expiryDate", "valueAmount", "invoiceNumber" ];
function getFieldsForDocumentType(documentType) {
  return DOCUMENT_TYPE_FIELDS[documentType] || DEFAULT_FIELDS;
}
function buildDynamicFields(documentType, assetData) {
  const applicableFields = getFieldsForDocumentType(documentType);
  const result = {};
  for (const key of ALL_DYNAMIC_FIELDS) {
    if (!applicableFields.includes(key)) {
      result[key] = "";
      continue;
    }
    const rawValue = assetData[key];
    if (rawValue === undefined || rawValue === null) {
      result[key] = "";
      continue;
    }
    const trimmed = String(rawValue).trim();
    if (trimmed === "" || trimmed === "-") {
      result[key] = "";
      continue;
    }
    result[key] = trimmed;
  }
  return result;
}
module.exports = {
  DOCUMENT_TYPE_FIELDS: DOCUMENT_TYPE_FIELDS,
  DEFAULT_FIELDS: DEFAULT_FIELDS,
  ALL_DYNAMIC_FIELDS: ALL_DYNAMIC_FIELDS,
  getFieldsForDocumentType: getFieldsForDocumentType,
  buildDynamicFields: buildDynamicFields
};