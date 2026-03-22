function validateEAN13(code) {
  if (!/^\d{13}$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const sum = digits.slice(0, 12).reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
  const check = (10 - (sum % 10)) % 10;
  return check === digits[12];
}

function validateEAN8(code) {
  if (!/^\d{8}$/.test(code)) return false;
  const digits = code.split('').map(Number);
  const sum = digits.slice(0, 7).reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  const check = (10 - (sum % 10)) % 10;
  return check === digits[7];
}

function validateCODE128(code) {
  return typeof code === 'string' && code.length >= 1 && code.length <= 48;
}

function validateBarcode(code, format) {
  switch (format) {
    case 'EAN-13':  return validateEAN13(code);
    case 'EAN-8':   return validateEAN8(code);
    case 'CODE-128': return validateCODE128(code);
    case 'QR':      return typeof code === 'string' && code.length >= 1;
    default:        return false;
  }
}

module.exports = { validateBarcode, validateEAN13, validateEAN8, validateCODE128 };
