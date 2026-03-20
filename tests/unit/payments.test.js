// ============================================================
// AURA. — QA-01: Testes Unitários — Payments
// ============================================================

const {
  generatePaymentToken,
  validatePaymentToken,
  validateWebhookSignature,
  calculatePaymentFee,
} = require('../../src/services/payments');

const SECRET = 'test-secret-aura-2026';
const LINK_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

describe('Payments — generatePaymentToken', () => {
  test('gera token com estrutura válida', () => {
    const { token, expiresAt } = generatePaymentToken(LINK_ID, SECRET);
    expect(token).toBeDefined();
    expect(token.split('.').length).toBe(2);
    expect(expiresAt).toBeInstanceOf(Date);
  });

  test('token expira em 7 dias por padrão', () => {
    const { expiresAt } = generatePaymentToken(LINK_ID, SECRET);
    const diff = expiresAt.getTime() - Date.now();
    const days = diff / (1000 * 60 * 60 * 24);
    expect(days).toBeCloseTo(7, 0);
  });

  test('TTL customizado funciona corretamente', () => {
    const { expiresAt } = generatePaymentToken(LINK_ID, SECRET, 30);
    const diff = expiresAt.getTime() - Date.now();
    const days = diff / (1000 * 60 * 60 * 24);
    expect(days).toBeCloseTo(30, 0);
  });

  test('lança erro sem linkId', () => {
    expect(() => generatePaymentToken(null, SECRET)).toThrow();
  });

  test('lança erro sem secret', () => {
    expect(() => generatePaymentToken(LINK_ID, null)).toThrow();
  });

  test('lança erro com days inválido', () => {
    expect(() => generatePaymentToken(LINK_ID, SECRET, 0)).toThrow();
    expect(() => generatePaymentToken(LINK_ID, SECRET, -1)).toThrow();
  });
});

describe('Payments — validatePaymentToken', () => {
  test('token válido retorna valid=true e linkId correto', () => {
    const { token } = generatePaymentToken(LINK_ID, SECRET);
    const result = validatePaymentToken(token, SECRET);
    expect(result.valid).toBe(true);
    expect(result.linkId).toBe(LINK_ID);
    expect(result.secondsRemaining).toBeGreaterThan(0);
  });

  test('token com secret errado é inválido', () => {
    const { token } = generatePaymentToken(LINK_ID, SECRET);
    const result = validatePaymentToken(token, 'wrong-secret');
    expect(result.valid).toBe(false);
  });

  test('token malformado é inválido', () => {
    const result = validatePaymentToken('token.invalido.extra', SECRET);
    expect(result.valid).toBe(false);
  });

  test('token expirado retorna expired=true', () => {
    const { token } = generatePaymentToken(LINK_ID, SECRET, -1);
    const result = validatePaymentToken(token, SECRET);
    expect(result.valid).toBe(false);
    expect(result.expired).toBe(true);
    expect(result.secondsRemaining).toBe(0);
  });

  test('token nulo retorna válido=false', () => {
    const result = validatePaymentToken(null, SECRET);
    expect(result.valid).toBe(false);
  });
});

describe('Payments — validateWebhookSignature', () => {
  const crypto = require('crypto');

  test('assinatura válida retorna true', () => {
    const payload = JSON.stringify({ event: 'payment.confirmed', amount: 100 });
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    expect(validateWebhookSignature(payload, sig, SECRET)).toBe(true);
  });

  test('assinatura errada retorna false', () => {
    const payload = JSON.stringify({ event: 'payment.confirmed' });
    expect(validateWebhookSignature(payload, 'assinatura-errada-x', SECRET)).toBe(false);
  });

  test('payload alterado invalida assinatura', () => {
    const payload = JSON.stringify({ amount: 100 });
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    const tamperedPayload = JSON.stringify({ amount: 999 });
    expect(validateWebhookSignature(tamperedPayload, sig, SECRET)).toBe(false);
  });

  test('parâmetros ausentes retornam false', () => {
    expect(validateWebhookSignature(null, 'sig', SECRET)).toBe(false);
    expect(validateWebhookSignature('payload', null, SECRET)).toBe(false);
    expect(validateWebhookSignature('payload', 'sig', null)).toBe(false);
  });
});

describe('Payments — calculatePaymentFee', () => {
  test('taxa Pix é 0,99%', () => {
    const result = calculatePaymentFee(100, 'pix');
    expect(result.gross).toBe(100);
    expect(result.fee).toBe(0.99);
    expect(result.net).toBe(99.01);
  });

  test('taxa boleto é fixa R$ 1,99', () => {
    const result = calculatePaymentFee(100, 'boleto');
    expect(result.fee).toBe(1.99);
    expect(result.net).toBe(98.01);
  });

  test('taxa débito é 1,89%', () => {
    const result = calculatePaymentFee(200, 'debito');
    expect(result.fee).toBe(3.78);
    expect(result.net).toBe(196.22);
  });

  test('método padrão é pix', () => {
    const resultPix     = calculatePaymentFee(100, 'pix');
    const resultDefault = calculatePaymentFee(100);
    expect(resultDefault.fee).toBe(resultPix.fee);
  });

  test('net nunca ultrapassa gross', () => {
    const result = calculatePaymentFee(50, 'pix');
    expect(result.net).toBeLessThanOrEqual(result.gross);
  });
});
