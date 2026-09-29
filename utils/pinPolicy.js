const COMMON = new Set([
  "13579", "24680", "11223", "12321", "12345", "54321", "112233", "121212",
  "123123", "123321", "654321", "123456", "111222", "159753", "147258", "142536",
  "19191", "20202", "10101", "15151", "00700", "77777", "12131", "11211"
]);
function isWeakPin(pin) {
  const p = String(pin);
  if (!/^\d+$/.test(p)) return true;
  if (COMMON.has(p)) return true;
  if (/^(\d)\1+$/.test(p)) return true;
  const d = p.split("").map(Number);
  const step = d[1] - d[0];
  if ((step === 1 || step === -1) && d.every((x, i) => i === 0 || x - d[i - 1] === step)) {
    return true;
  }
  if (d.every((x, i) => i === 0 || (x - d[i - 1] + 10) % 10 === 1)) return true;
  if (d.every((x, i) => i === 0 || (d[i - 1] - x + 10) % 10 === 1)) return true;
  for (const period of [2, 3]) {
    if (p.length > period && d.every((x, i) => x === d[i % period])) return true;
  }
  return false;
}
const WEAK_PIN_MESSAGE = "That PIN is too easy to guess. Avoid repeated digits, sequences (like 12345) and patterns.";
module.exports = {
  isWeakPin: isWeakPin,
  WEAK_PIN_MESSAGE: WEAK_PIN_MESSAGE
};
