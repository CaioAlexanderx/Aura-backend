const { validateBarcode, validateEAN13, validateEAN8, validateCODE128 } = require('../../src/services/barcode');

describe('EAN-13 validation', () => {
  test('valid EAN-13', () => {
    expect(validateEAN13('7891000315507')).toBe(true);  // Coca-Cola BR
    expect(validateEAN13('7891910000197')).toBe(true);  // Nestlé BR
  });
  test('invalid check digit', () => {
    expect(validateEAN13('7891000315508')).toBe(false);
  });
  test('wrong length', () => {
    expect(validateEAN13('123456789012')).toBe(false);
    expect(validateEAN13('12345678901234')).toBe(false);
  });
  test('non-numeric', () => {
    expect(validateEAN13('789100031550A')).toBe(false);
  });
});

describe('EAN-8 validation', () => {
  test('valid EAN-8', () => {
    expect(validateEAN8('96385074')).toBe(true);
  });
  test('invalid check digit', () => {
    expect(validateEAN8('96385075')).toBe(false);
  });
  test('wrong length', () => {
    expect(validateEAN8('1234567')).toBe(false);
  });
});

describe('CODE-128 validation', () => {
  test('valid codes', () => {
    expect(validateCODE128('ABC-123')).toBe(true);
    expect(validateCODE128('A')).toBe(true);
    expect(validateCODE128('A'.repeat(48))).toBe(true);
  });
  test('too long', () => {
    expect(validateCODE128('A'.repeat(49))).toBe(false);
  });
  test('empty', () => {
    expect(validateCODE128('')).toBe(false);
  });
});

describe('QR validation', () => {
  test('any non-empty string is valid', () => {
    expect(validateBarcode('produto-123', 'QR')).toBe(true);
    expect(validateBarcode('{"id":1,"name":"Produto"}', 'QR')).toBe(true);
  });
  test('empty string is invalid', () => {
    expect(validateBarcode('', 'QR')).toBe(false);
  });
});

describe('validateBarcode dispatcher', () => {
  test('valid EAN-13 via dispatcher', () => {
    expect(validateBarcode('7891000315507', 'EAN-13')).toBe(true);
  });
  test('invalid format returns false', () => {
    expect(validateBarcode('123', 'UNKNOWN')).toBe(false);
  });
});
