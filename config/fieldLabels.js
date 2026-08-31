// Mirrors `_documentFieldLabels` in lib/screens/upload_screen.dart (Flutter).
// Every label string here MUST stay identical, word-for-word, to the Flutter
// side — the OCR pipeline turns each label into a camelCase JSON key with
// keyFromLabel() below (a JS port of the Dart `_keyFromLabel`), and the
// Flutter form looks up extracted data by that same computed key. If a label
// changes on one side without changing on the other, that one field will
// silently stop auto-filling (everything else still works).
//
// Only the "Professional" branch is listed here (Employment, Certification —
// which is where Degree/AI Course/etc. live —, IP, Business, Awards &
// Recognition). Personal-category documents (Aadhaar, Vehicle, Insurance,
// Jewellery, ...) are still handled by the asset-style extractor in
// scanReceipt.js and don't need an entry here.
const FIELD_LABELS = {
  'Employment|Appointment Letter / Offer Letter': ['Employee Name', 'Employer / Company Name', 'Designation', 'Department', 'Date of Joining', 'Offer Date', 'CTC / Salary', 'Employment Type', 'Reporting Manager', 'Reference Number'],
  'Employment|Experience Certificate': ['Employee Name', 'Employer / Company Name', 'Designation', 'Department', 'Date of Joining', 'Date of Relieving', 'Duration of Employment', 'Certificate Date', 'Reference Number'],
  'Employment|Relieving Letter': ['Employee Name', 'Employer / Company Name', 'Designation', 'Date of Joining', 'Last Working Day', 'Relieving Date', 'Reference Number'],
  'Employment|Salary Slip': ['Employee Name', 'Employer / Company Name', 'Employee ID', 'Designation', 'Pay Period', 'Gross Salary', 'Deductions', 'Net Salary', 'Date of Issue'],
  'Employment|Promotion Letters': ['Employee Name', 'Employer / Company Name', 'Previous Designation', 'New Designation', 'Effective Date', 'New Salary / CTC', 'Reference Number'],
  'Employment|Appraisal': ['Employee Name', 'Employer / Company Name', 'Designation', 'Appraisal Period', 'Rating', 'Revised Salary / CTC', 'Effective Date'],
  'Employment|Other': ['Employee Name', 'Employer / Company Name', 'Designation', 'Date', 'Reference Number'],

  // University-agnostic on purpose: the same field set fits an SPPU degree
  // certificate, a degree certificate from any other Indian or foreign
  // university, or a provisional certificate. Nothing here names a specific
  // university — see parseEducationCertificate() in scanReceipt.js.
  'Certification|Degree': ['Student Full Name', 'University / Institute Name', 'Degree Name', 'Branch / Specialization', 'Seat Number / Roll Number', 'Enrollment Number / PRN', 'Class / CGPA / Percentage', 'Certificate Number', 'Date of Issue', 'Year of Passing'],
  'Certification|AI Course': ['Student / Participant Name', 'Course Name', 'Institution / Platform Name', 'Certificate Number', 'Completion Date', 'Grade / Score', 'Duration'],
  'Certification|Memberships': ['Member Name', 'Organization / Association Name', 'Membership Number', 'Membership Type', 'Valid From', 'Valid Until'],
  'Certification|Sports': ['Participant Name', 'Event / Tournament Name', 'Organizing Authority', 'Position / Achievement', 'Date', 'Certificate Number'],
  'Certification|Music': ['Participant Name', 'Course / Exam Name', 'Institution Name', 'Grade / Level', 'Certificate Number', 'Date of Issue'],
  'Certification|Others': ['Recipient Name', 'Certificate Title', 'Issuing Authority', 'Certificate Number', 'Date of Issue'],

  'IP (Intellectual Property)|Patent Application': ['Applicant Name', 'Invention Title', 'Application Number', 'Filing Date', 'Patent Office', 'Status'],
  'IP (Intellectual Property)|Granted Patent': ['Patentee Name', 'Invention Title', 'Patent Number', 'Filing Date', 'Grant Date', 'Patent Office', 'Validity'],
  'IP (Intellectual Property)|Trademark': ['Applicant / Owner Name', 'Trademark Name', 'Application / Registration Number', 'Class', 'Filing Date', 'Registration Date', 'Validity'],
  'IP (Intellectual Property)|Copyright': ['Author / Owner Name', 'Work Title', 'Registration Number', 'Registration Date', 'Copyright Office'],
  'IP (Intellectual Property)|Other': ['Applicant Name', 'Reference Number', 'Filing Date', 'Issuing Authority'],

  'Business|GST Documents': ['Business Name', 'GSTIN', 'Registration Date', 'Business Address', 'Constitution of Business'],
  'Business|Company Registration': ['Company Name', 'CIN', 'Registration Date', 'Registered Address', 'Registrar of Companies'],
  'Business|MSME': ['Business Name', 'Udyam / MSME Registration Number', 'Registration Date', 'Business Category'],
  'Business|PAN': ['Entity Name', 'PAN Number', 'Date of Issue'],
  'Business|TAN': ['Entity Name', 'TAN Number', 'Date of Issue'],
  'Business|Licenses': ['Business Name', 'License Number', 'Issuing Authority', 'Issue Date', 'Expiry Date'],
  'Business|Other': ['Business Name', 'Reference Number', 'Issuing Authority', 'Date'],

  'Awards & Recognition|Awards': ['Recipient Name', 'Award Title', 'Awarding Organization', 'Date', 'Category / Field'],
  'Awards & Recognition|Certificates': ['Recipient Name', 'Certificate Title', 'Issuing Authority', 'Certificate Number', 'Date of Issue'],
  'Awards & Recognition|Recognition Documents': ['Recipient Name', 'Recognition Title', 'Issuing Organization', 'Date'],
  'Awards & Recognition|Other': ['Recipient Name', 'Reference Number', 'Issuing Authority', 'Date'],
};

// JS port of the Dart `_keyFromLabel` in upload_screen.dart — must stay
// algorithmically identical (split on non-alphanumerics, lowercase the first
// word, capitalize-first-letter the rest) or generated keys will diverge.
function keyFromLabel(label) {
  const words = String(label || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return 'field';
  let out = words[0].toLowerCase();
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    out += w[0].toUpperCase() + w.slice(1).toLowerCase();
  }
  return out;
}

// Returns [{ key, label }, ...] for a subCategory + documentType pair, or
// null if this document type isn't in the Professional table above (the
// caller falls back to the generic/asset extractor in that case).
function getFieldSpecs(subCategory, documentType) {
  const labels = FIELD_LABELS[`${subCategory}|${documentType}`];
  if (!labels) return null;
  return labels.map((label) => ({ key: keyFromLabel(label), label }));
}

module.exports = { FIELD_LABELS, keyFromLabel, getFieldSpecs };