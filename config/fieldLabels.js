const FIELD_LABELS = {
  'Identity & Legal|Aadhaar Card': ['Full Name', 'Aadhaar Number', 'Date of Birth / Year of Birth', 'Gender', 'Address', 'VID', 'Enrolment/Update ID'],
  'Identity & Legal|PAN Card': ['Full Name', "Father's/Mother's Name", 'PAN Number', 'Date of Birth', 'Date of Issue'],
  'Identity & Legal|Passport': ['Full Name', 'Passport Number', 'Date of Birth', 'Gender', 'Nationality', 'Place of Birth', 'Place of Issue', 'Date of Issue', 'Date of Expiry', 'Father/Mother/Spouse Name'],
  'Identity & Legal|Driving Licence': ['Full Name', 'Driving Licence Number', 'Date of Birth', 'Gender', 'Address', 'Issue Date', 'Validity / Expiry Date', 'Vehicle Classes', 'Issuing Authority / RTO'],
  'Identity & Legal|Voter ID': ['Full Name', 'EPIC / Voter ID Number', 'Date of Birth / Age', 'Gender', 'Father/Mother/Spouse Name', 'Address', 'Assembly Constituency', 'Polling Station'],
  'Identity & Legal|Birth Certificate': ["Child's Full Name", 'Date of Birth', 'Time of Birth', 'Place of Birth', 'Gender', "Father's Name", "Mother's Name", 'Registration Number', 'Date of Registration', 'Issuing Authority'],
  'Identity & Legal|Marriage Certificate': ["Husband's Full Name", "Wife's Full Name", 'Date of Marriage', 'Place of Marriage', 'Marriage Registration Number', 'Registration Date', "Father's/Mother's Names", 'Issuing Authority'],
  'Identity & Legal|Name Change Affidavit': ['Old Name', 'New Name', 'Date of Birth', "Father/Husband's Name", 'Address', 'Reason for Name Change', 'Affidavit Number', 'Date', 'Notary / Authority Name'],
  'Identity & Legal|Other': ['Document Title', 'Document Number', 'Full Name', 'Date', 'Issuing Authority', 'Important Reference Number'],
  'Financial|Bank Account Documents': ['Account Holder Name', 'Bank Name', 'Account Number', 'IFSC Code', 'Branch Name', 'Account Type', 'Customer ID', 'Statement Period', 'Balance'],
  'Financial|Fixed Deposits (FDs)': ['Account Holder Name', 'Bank Name', 'FD / Deposit Number', 'Principal Amount', 'Interest Rate', 'Start Date', 'Maturity Date', 'Maturity Amount', 'Tenure', 'Nominee Name'],
  'Financial|Mutual Funds (MF)': ['Investor Name', 'Folio Number', 'AMC / Fund House', 'Scheme Name', 'Plan / Option', 'Investment Amount', 'Units', 'NAV', 'Transaction Date', 'Current Value'],
  'Financial|IT Returns': ['Name', 'PAN', 'Assessment Year', 'Financial Year', 'ITR Form Type', 'Acknowledgement Number', 'Gross Total Income', 'Total Tax', 'Refund / Tax Payable', 'Filing Date'],
  'Financial|Form 16': ['Employee Name', 'PAN', 'Employer Name', 'Employer TAN', 'Assessment Year', 'Financial Year', 'Gross Salary', 'Tax Deducted (TDS)', 'Taxable Income', 'Date of Issue'],
  'Financial|Loan Documents': ['Borrower Name', 'Lender / Bank Name', 'Loan Account Number', 'Loan Type', 'Loan Amount', 'Interest Rate', 'Tenure', 'EMI Amount', 'Loan Start Date', 'Maturity / End Date', 'Outstanding Amount'],
  'Financial|Other': ['Account Holder / Customer Name', 'Institution Name', 'Account / Reference Number', 'Amount', 'Transaction / Issue Date', 'Maturity / Due Date', 'Important Reference Number'],
  'Healthcare|Medical Reports': ['Patient Name', 'Patient ID', 'Date of Birth / Age', 'Gender', 'Doctor Name', 'Hospital / Lab Name', 'Report Type', 'Test Date', 'Report Date', 'Test Results', 'Diagnosis / Impression'],
  'Healthcare|Prescriptions': ['Patient Name', 'Doctor Name', 'Hospital / Clinic', 'Prescription Date', 'Medicine Names', 'Dosage', 'Frequency', 'Duration', 'Instructions'],
  'Healthcare|Vaccinations': ['Patient Name', 'Date of Birth', 'Vaccine Name', 'Dose Number', 'Vaccination Date', 'Next Dose Date', 'Batch Number', 'Vaccination Centre', 'Doctor / Healthcare Provider'],
  'Healthcare|Blood Group Information': ['Patient Name', 'Blood Group', 'Rh Factor', 'Test Date', 'Patient ID', 'Hospital / Lab Name'],
  'Healthcare|Other': ['Patient Name', 'Healthcare Provider', 'Document Type', 'Date', 'Diagnosis / Result', 'Important Medical Reference Number'],
  'Travel|Flight Ticket': ['Passenger Name', 'PNR', 'Ticket Number', 'Airline', 'Flight Number', 'Departure Airport', 'Arrival Airport', 'Departure Date', 'Departure Time', 'Arrival Date', 'Arrival Time', 'Seat Number', 'Class', 'Booking Reference'],
  'Travel|Hotel Booking': ['Guest Name', 'Hotel Name', 'Booking Number', 'Check-in Date', 'Check-out Date', 'Number of Guests', 'Room Type', 'Number of Rooms', 'Booking Amount', 'Address', 'Contact Number'],
  'Travel|Visa': ['Applicant Name', 'Passport Number', 'Visa Number', 'Nationality', 'Date of Birth', 'Visa Type', 'Country', 'Issue Date', 'Expiry Date', 'Number of Entries', 'Duration of Stay'],
  'Travel|Travel Insurance': ['Traveller Name', 'Policy Number', 'Insurance Company', 'Destination', 'Trip Start Date', 'Trip End Date', 'Coverage Amount', 'Premium', 'Policy Start Date', 'Policy Expiry Date'],
  'Travel|Foreign Exchange Records': ['Customer Name', 'Transaction Number', 'Exchange Provider / Bank', 'Currency', 'Foreign Currency Amount', 'Exchange Rate', 'INR Amount', 'Transaction Date', 'Receipt Number'],
  'Travel|Other': ['Traveller Name', 'Booking / Reference Number', 'Destination', 'Travel Date', 'Return Date', 'Provider', 'Amount', 'Important Reference Number'],
  'Employment|Appointment Letter / Offer Letter': ['Employee Name', 'Employer / Company Name', 'Designation', 'Department', 'Date of Joining', 'Offer Date', 'CTC / Salary', 'Employment Type', 'Reporting Manager', 'Reference Number'],
  'Employment|Experience Certificate': ['Employee Name', 'Employer / Company Name', 'Designation', 'Department', 'Date of Joining', 'Date of Relieving', 'Duration of Employment', 'Certificate Date', 'Reference Number'],
  'Employment|Relieving Letter': ['Employee Name', 'Employer / Company Name', 'Designation', 'Date of Joining', 'Last Working Day', 'Relieving Date', 'Reference Number'],
  'Employment|Salary Slip': ['Employee Name', 'Employer / Company Name', 'Employee ID', 'Designation', 'Pay Period', 'Gross Salary', 'Deductions', 'Net Salary', 'Date of Issue'],
  'Employment|Promotion Letters': ['Employee Name', 'Employer / Company Name', 'Previous Designation', 'New Designation', 'Effective Date', 'New Salary / CTC', 'Reference Number'],
  'Employment|Appraisal': ['Employee Name', 'Employer / Company Name', 'Designation', 'Appraisal Period', 'Rating', 'Revised Salary / CTC', 'Effective Date'],
  'Employment|Other': ['Employee Name', 'Employer / Company Name', 'Designation', 'Date', 'Reference Number'],
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
function getFieldSpecs(subCategory, documentType) {
  const labels = FIELD_LABELS[`${subCategory}|${documentType}`];
  if (!labels) return null;
  return labels.map((label) => ({ key: keyFromLabel(label), label }));
}
module.exports = { FIELD_LABELS, keyFromLabel, getFieldSpecs };
