// ============================================================
// AURA. — sefazSp/pfx: abre certificado A1 (.pfx/PKCS#12) EM MEMÓRIA
// Roadmap NFC-e própria v1 — S1.3.
//
// 16/07/2026 (fix PFX moderno): node-forge só entende PKCS#12 "legado"
// (3DES/RC2). Certificadoras recentes (OpenSSL 3) exportam com
// PBES2/AES-256 → forge lança "Unsupported PKCS12 PFX data" (caso Davi).
// Fallback: extrair via `openssl pkcs12 -nodes` do sistema (stdin/stdout,
// nada em disco; senha via env, nunca em argv). Railway (Linux) tem
// openssl; no Windows resolvemos o binário do Git.
//
// REGRAS: o buffer do .pfx e a senha nunca tocam disco nem log.
// Mensagens de erro não ecoam senha/conteúdo.
// ============================================================
'use strict';

const forge = require('node-forge');
const { execFileSync } = require('child_process');
const fs = require('fs');

// ── Fallback OpenSSL (PFX moderno PBES2/AES que o forge não lê) ──────

const OPENSSL_CANDIDATES = [
  'openssl',
  'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
];

function resolveOpensslBin() {
  for (const bin of OPENSSL_CANDIDATES) {
    try {
      execFileSync(bin, ['version'], { stdio: ['ignore', 'ignore', 'ignore'] });
      return bin;
    } catch (_) {
      if (bin.includes('\\') && !fs.existsSync(bin)) continue;
      // existe mas 'version' falhou: tenta o próximo mesmo assim
    }
  }
  return null;
}

function opensslPkcs12ToPem(bin, pfxBuffer, password, extraArgs) {
  // -nodes: chave sem re-cifragem (fica só em memória, como o keyPem do
  // caminho forge). Senha via env (-passin env:) pra não vazar em argv/ps.
  return execFileSync(
    bin,
    ['pkcs12', '-nodes', '-passin', 'env:AURA_PFX_PASSIN'].concat(extraArgs),
    {
      input: pfxBuffer,
      env: Object.assign({}, process.env, { AURA_PFX_PASSIN: password }),
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'], // stderr descartado: não logar conteúdo
    }
  ).toString('utf8');
}

/** Extrai {keyObj, certs[]} via openssl do sistema. Lança se indisponível/senha errada. */
function openWithOpenssl(pfxBuffer, password) {
  const bin = resolveOpensslBin();
  if (!bin) {
    throw new Error(
      'openPfx: .pfx em formato moderno (AES/PBES2) e openssl não encontrado no sistema. ' +
      'Instale o OpenSSL (no Windows, o Git já inclui) ou converta o .pfx para o formato legado.'
    );
  }
  let pem;
  try {
    pem = opensslPkcs12ToPem(bin, pfxBuffer, password, []);
  } catch (_) {
    try {
      // PFX antigo (RC2/3DES) em OpenSSL 3 exige provider legacy
      pem = opensslPkcs12ToPem(bin, pfxBuffer, password, ['-legacy']);
    } catch (_2) {
      throw new Error('openPfx: não foi possível abrir o .pfx (senha incorreta ou arquivo corrompido)');
    }
  }

  const keyMatch = pem.match(/-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/);
  const certMatches = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  if (!keyMatch) throw new Error('openPfx: chave privada não encontrada no .pfx');
  if (!certMatches.length) throw new Error('openPfx: certificado não encontrado no .pfx');

  return {
    keyObj: forge.pki.privateKeyFromPem(keyMatch[0]),
    certs: certMatches.map(function (c) { return forge.pki.certificateFromPem(c); }),
  };
}

/** Extrai {keyObj, certs[]} via node-forge (PKCS#12 legado 3DES/RC2). */
function openWithForge(pfxBuffer, password) {
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfxBuffer.toString('binary')));
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);

  let keyObj = null;
  const certs = [];
  for (const safeContent of p12.safeContents) {
    for (const safeBag of safeContent.safeBags) {
      if (safeBag.type === forge.pki.oids.pkcs8ShroudedKeyBag || safeBag.type === forge.pki.oids.keyBag) {
        if (safeBag.key) keyObj = safeBag.key;
      } else if (safeBag.type === forge.pki.oids.certBag && safeBag.cert) {
        certs.push(safeBag.cert);
      }
    }
  }
  return { keyObj: keyObj, certs: certs };
}

/**
 * Abre um .pfx e extrai chave privada + certificado em PEM.
 * @param {Buffer} pfxBuffer
 * @param {string} password
 * @returns {{ keyPem, certPem, certDerBase64, notBefore, notAfter, subjectCN, issuerCN }}
 */
function openPfx(pfxBuffer, password) {
  if (!Buffer.isBuffer(pfxBuffer) || pfxBuffer.length === 0) {
    throw new Error('openPfx: buffer do certificado vazio');
  }
  let keyObj = null;
  let certs = [];
  let forgeErr = null;
  try {
    const r = openWithForge(pfxBuffer, password);
    keyObj = r.keyObj;
    certs = r.certs;
  } catch (e) {
    forgeErr = e;
  }
  if (forgeErr || !keyObj || !certs.length) {
    // forge não abriu (formato moderno AES/PBES2 — "Unsupported PKCS12 PFX
    // data" — ou bags cifradas com PBES2). Tenta via openssl do sistema.
    // Se também falhar por senha, o erro do openssl prevalece (mais preciso).
    const r = openWithOpenssl(pfxBuffer, password);
    keyObj = r.keyObj;
    certs = r.certs;
  }
  if (!keyObj) throw new Error('openPfx: chave privada não encontrada no .pfx');
  if (!certs.length) throw new Error('openPfx: certificado não encontrado no .pfx');

  // Certificado do titular = o que NÃO é CA; fallback: primeiro.
  const leaf = certs.find(function (c) {
    const bc = c.getExtension('basicConstraints');
    return !bc || !bc.cA;
  }) || certs[0];

  const cnAttr = leaf.subject.getField('CN');
  const issuerAttr = leaf.issuer.getField('CN');

  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(leaf)).getBytes();

  return {
    keyPem: forge.pki.privateKeyToPem(keyObj),
    certPem: forge.pki.certificateToPem(leaf),
    // DER base64 "puro" (sem header PEM) — vai no <X509Certificate>
    certDerBase64: forge.util.encode64(certDer),
    notBefore: leaf.validity.notBefore,
    notAfter: leaf.validity.notAfter,
    subjectCN: cnAttr ? cnAttr.value : null,
    issuerCN: issuerAttr ? issuerAttr.value : null,
  };
}

/** Valida vigência: lança se expirado/ainda não válido (tolerância 0). */
function assertValidity(info, now = new Date()) {
  if (info.notBefore && now < info.notBefore) {
    throw new Error('Certificado A1 ainda não é válido (notBefore no futuro)');
  }
  if (info.notAfter && now > info.notAfter) {
    throw new Error(`Certificado A1 expirado em ${info.notAfter.toISOString().slice(0, 10)}`);
  }
}

module.exports = { openPfx, assertValidity };
