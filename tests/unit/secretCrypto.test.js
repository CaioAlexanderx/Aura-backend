const crypto = require('crypto');

const KEY = crypto.randomBytes(32).toString('hex');

describe('secretCrypto (AES-256-GCM)', () => {
  let sc;
  beforeAll(() => {
    process.env.CERT_MASTER_KEY = KEY;
    sc = require('../../src/utils/secretCrypto');
  });

  test('round-trip de string (csc_token)', () => {
    const env = sc.encryptString('ABCD-1234-CSC-TOKEN');
    expect(env.startsWith('v1:')).toBe(true);
    expect(env).not.toContain('ABCD-1234');
    expect(sc.decryptString(env)).toBe('ABCD-1234-CSC-TOKEN');
  });

  test('IVs aleatórios: mesmo plaintext → envelopes diferentes', () => {
    expect(sc.encryptString('x')).not.toBe(sc.encryptString('x'));
  });

  test('isEncrypted detecta envelope e rejeita claro', () => {
    expect(sc.isEncrypted(sc.encryptString('tok'))).toBe(true);
    expect(sc.isEncrypted('token-em-claro')).toBe(false);
    expect(sc.isEncrypted(null)).toBe(false);
  });

  test('round-trip de buffer (.pfx)', () => {
    const pfx = crypto.randomBytes(2048);
    const { enc, iv } = sc.encryptBuffer(pfx);
    expect(enc.length).toBe(pfx.length + 16); // cipher || tag
    expect(sc.decryptBuffer(enc, iv).equals(pfx)).toBe(true);
  });

  test('tampering falha autenticação sem vazar payload', () => {
    const { enc, iv } = sc.encryptBuffer(Buffer.from('segredo'));
    enc[0] ^= 0xff;
    expect(() => sc.decryptBuffer(enc, iv)).toThrow(/autenticação/);
  });

  test('chave errada falha autenticação', () => {
    const env = sc.encryptString('tok');
    process.env.CERT_MASTER_KEY = crypto.randomBytes(32).toString('hex');
    expect(() => sc.decryptString(env)).toThrow(/autenticação/);
    process.env.CERT_MASTER_KEY = KEY;
  });

  test('chave malformada é rejeitada sem ecoar valor', () => {
    process.env.CERT_MASTER_KEY = 'curta';
    expect(() => sc.encryptString('x')).toThrow(/64 chars hex/);
    expect(sc.hasMasterKey()).toBe(false);
    process.env.CERT_MASTER_KEY = KEY;
    expect(sc.hasMasterKey()).toBe(true);
  });
});
