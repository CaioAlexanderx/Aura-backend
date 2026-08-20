// ============================================================
// AURA — Onda 5a (2/3): o wa_access_token é cifrado em repouso (A9).
// Guarda o mecanismo de cifra que whatsappRoutes usa (encrypt no connect,
// decrypt no getWaConfig, com detecção de legado por prefixo "v1:").
// ============================================================
'use strict';

const crypto = require('crypto');

// PRECISA vir antes de require do módulo de cifra (getKey é lazy mas lê env).
process.env.DOJO_BAAS_ENC_KEY = crypto.randomBytes(32).toString('hex');

const { encrypt, decrypt } = require('../src/services/dojoBaasCrypto');

// Espelha a detecção de legado do whatsappRoutes.decryptToken.
function decryptToken(stored) {
  if (!stored) return stored;
  if (!/^v1:/.test(String(stored))) return stored; // texto puro (legado)
  return decrypt(stored);
}

describe('wa_access_token — cifra em repouso (A9)', () => {
  const TOKEN = 'EAAG_meta_permanent_token_abc123';

  test('encrypt produz payload v1: que NÃO contém o token em claro', () => {
    const enc = encrypt(TOKEN);
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain(TOKEN);
  });

  test('decrypt reverte a cifra (roundtrip)', () => {
    expect(decrypt(encrypt(TOKEN))).toBe(TOKEN);
  });

  test('token cifrado → decryptToken devolve o claro; legado em texto puro → passa direto', () => {
    const enc = encrypt(TOKEN);
    expect(decryptToken(enc)).toBe(TOKEN);          // cifrado
    expect(decryptToken(TOKEN)).toBe(TOKEN);        // legado (sem prefixo v1:)
    expect(decryptToken(null)).toBe(null);
  });
});
