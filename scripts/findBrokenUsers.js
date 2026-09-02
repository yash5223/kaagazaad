require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const REQUIRED_FIELDS = [
  'firstName',
  'lastName',
  'dob',
  'gender',
  'email',
  'phone',
  'aadhaarEncrypted',
  'aadhaarHash',
  'passwordHash',
];
async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('Set MONGODB_URI (or MONGO_URI) before running this script.');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log('Connected. Scanning users collection...\n');
  const users = await User.collection.find({}).toArray();
  let brokenCount = 0;
  for (const u of users) {
    const missing = REQUIRED_FIELDS.filter((f) => u[f] === undefined || u[f] === null || u[f] === '');
    if (missing.length > 0) {
      brokenCount++;
      console.log(`Broken user _id=${u._id} email=${u.email || '(none)'} missing=[${missing.join(', ')}]`);
    }
  }
  console.log(`\nScanned ${users.length} user(s). Found ${brokenCount} broken document(s).`);
  if (brokenCount > 0) {
    console.log(
      '\nEach one above will throw a ValidationError the next time it is `.save()`d ' +
      '(login, set-pin, verify-pin, remove-pin), regardless of validateModifiedOnly, ' +
      'because required fields are outright missing from the stored document.\n' +
      'Decide per-record whether to delete it (if it is junk/test data) or backfill ' +
      'the missing fields directly, e.g.:\n\n' +
      "  db.users.updateOne({ _id: ObjectId('...') }, { $set: { firstName: '...', lastName: '...' } })\n"
    );
  }
  await mongoose.disconnect();
}
main().catch((err) => {
  console.error('Script error:', err);
  process.exit(1);
});
