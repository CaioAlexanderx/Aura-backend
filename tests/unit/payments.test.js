const {
  generatePaymentToken, validatePaymentToken,
  validateWebhookSignature, calculatePaymentFee,
} = require('../../src/services/payments');

const SECRET  = 'test-secret-aura-2026';
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
    const days = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(days).toBeCloseTo(7, 0);
  });
  test('TTL customizado funciona corretamente', () => {
    const { expiresAt } = generatePaymentToken(LINK_ID, SECRET, 30);
    const days = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(days).toBeCloseTo(30, 0);
  });
  test('lança erro sem linkId', () => {
    expect(() => generatePaymentToken(null, SECRET)).toThrow();
  });
  test('lança erro sem secret', () => {
    expect(() => generatePaymentToken(LINK_ID, null)).toThrow();
  });
  test('lança erro com days zero ou negativo', () => {
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
    const result = validatePaymentToken('tokeninvalido', SECRET);
    expect(result.valid).toBe(false);
  });
  test('token expirado — simulado via payload manual', () => {
    // Cria payload com expiração no passado sem passar pela validação de days
    const crypto = require('crypto');
    const pastExp = Date.now() - 1000;
    const payload = Buffer.from(JSON.stringify({ linkId: LINK_ID, exp: pastExp })).toString('base64url');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
    const token = `${payload}.${sig}`;
    const result = validatePaymentToken(token, SECRET);
    expect(result.valid).toBe(false);
    expect(result.expired).toBe(true);
    expect(result.secondsRemaining).toBe(0);
  });
  test('token nulo retorna valid=false', () => {
    expect(validatePaymentToken(null, SECRET).valid).toBe(false);
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
    expect(validateWebhookSignature(payload, 'assinatura-errada', SECRET)).toBe(false);
  });
  test('payload alterado invalida assinatura', () => {
    const payload = JSON.stringify({ amount: 100 });
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    expect(validateWebhookSignature(JSON.stringify({ amount: 999 }), sig, SECRET)).toBe(false);
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
    expect(calculatePaymentFee(100).fee).toBe(calculatePaymentFee(100, 'pix').fee);
  });
  test('net nunca ultrapassa gross', () => {
    expect(calculatePaymentFee(50, 'pix').net).toBeLessThanOrEqual(50);
  });
});
