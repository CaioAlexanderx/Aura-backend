// ============================================================
// AURA. — sefazSp/soapClient: transporte HTTPS mTLS + SOAP 1.2
// Roadmap NFC-e própria v1 — S1.4.
//
// Serviços (versão 4.00): NFeAutorizacao4 (síncrono p/ NFC-e, indSinc=1),
// NFeRetAutorizacao4, NFeStatusServico4, NFeConsultaProtocolo4.
//
// REGRA DE OURO (risco "timeout ambíguo"): este módulo NUNCA reenvia
// autorização sozinho. Timeout/erro de rede na autorização lança
// SefazTransportError com ambiguous=true — o chamador consulta por chave
// (consultarChave) antes de qualquer retransmissão, e JAMAIS renumera.
// Retry automático só em operações idempotentes (status/consulta).
//
// mTLS: agent https com pfx+passphrase EM MEMÓRIA (vindo do certStore).
// ============================================================
'use strict';

const https = require('https');
const { XMLParser } = require('fast-xml-parser');
const { getEndpoints, WSDL_NS } = require('./endpoints');

const SOAP_NS = 'http://www.w3.org/2003/05/soap-envelope';
const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
const DEFAULT_TIMEOUT_MS = 30000;

class SefazTransportError extends Error {
  constructor(message, { ambiguous = false, cause = null, httpStatus = null } = {}) {
    super(message);
    this.name = 'SefazTransportError';
    this.ambiguous = ambiguous;     // true = pode ter autorizado: consultar antes de reemitir
    this.httpStatus = httpStatus;
    if (cause) this.cause = cause;
  }
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,   // cStat '100' fica string (preserva zeros)
});

function soapEnvelope(wsdlNs, innerXml) {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + `<soap12:Envelope xmlns:soap12="${SOAP_NS}">`
    + '<soap12:Body>'
    + `<nfeDadosMsg xmlns="${wsdlNs}">${innerXml}</nfeDadosMsg>`
    + '</soap12:Body>'
    + '</soap12:Envelope>';
}

// ── TLS: Node/OpenSSL 3 também rejeita PFX moderno/misto ("Unsupported
// PKCS12 PFX data"). Extraímos key/cert PEM via openPfx (que tem fallback
// openssl) e entregamos ao https nesse formato — independe do formato do
// .pfx. Cache por hash (evita reparse/subprocesso a cada chamada).
const cryptoNode = require('crypto');
const fs = require('fs');
const path = require('path');
const { openPfx } = require('./pfx');
const _tlsCache = new Map(); // sha256(pfx|senha) → { key, cert }
function tlsMaterial(pfx, passphrase) {
  if (!pfx) return {}; // sem cert de cliente (ex.: diagnóstico)
  const h = cryptoNode.createHash('sha256')
    .update(pfx).update('|')
    .update(cryptoNode.createHash('sha256').update(String(passphrase || '')).digest())
    .digest('hex');
  if (_tlsCache.has(h)) return _tlsCache.get(h);
  let material;
  try {
    const c = openPfx(pfx, passphrase);
    material = { key: c.keyPem, cert: c.chainPem || c.certPem };
  } catch (_) {
    material = { pfx: pfx, passphrase: passphrase }; // fallback: comportamento antigo
  }
  if (_tlsCache.size > 32) _tlsCache.clear();
  _tlsCache.set(h, material);
  return material;
}

// ── CA dos servidores SEFAZ: as raízes ICP-Brasil não vêm no bundle
// Mozilla embutido no Node ("unable to get local issuer certificate").
// Anexamos os PEMs de ./certs (hoje: raiz v10, que assina a AC SOLUTI
// SSL EV G4 usada por nfce.fazenda.sp.gov.br homolog+prod) às raízes
// padrão. Novas raízes = só dropar o .pem na pasta.
let _caBundle = null;
function caBundle() {
  if (_caBundle) return _caBundle;
  const extra = [];
  try {
    const dir = path.join(__dirname, 'certs');
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.pem') || f.endsWith('.crt')) {
        extra.push(fs.readFileSync(path.join(dir, f), 'utf8'));
      }
    }
  } catch (_) { /* sem ./certs → segue só com as raízes padrão */ }
  _caBundle = require('tls').rootCertificates.concat(extra);
  return _caBundle;
}

/** POST SOAP 1.2 com mTLS. Injetável p/ testes via opts.transport. */
function postSoap(url, envelope, { pfx, passphrase, timeoutMs = DEFAULT_TIMEOUT_MS, transport } = {}) {
  if (transport) return transport(url, envelope);
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = Buffer.from(envelope, 'utf8');
    const req = https.request({
      host: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      ca: caBundle(),
      ...tlsMaterial(pfx, passphrase),
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8',
        'Content-Length': body.length,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => {
      req.destroy(new Error(`timeout após ${timeoutMs}ms`));
    });
    req.on('error', (err) => reject(err));
    req.write(body);
    req.end();
  });
}

function findDeep(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj[key] !== undefined) return obj[key];
  for (const k of Object.keys(obj)) {
    const found = findDeep(obj[k], key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Faz o POST, valida HTTP e extrai o elemento de retorno do Body. */
async function callService(url, wsdlNs, innerXml, retKey, opts, { ambiguousOnNetError }) {
  const envelope = soapEnvelope(wsdlNs, innerXml);
  let resp;
  try {
    resp = await postSoap(url, envelope, opts);
  } catch (err) {
    throw new SefazTransportError(
      `SEFAZ-SP inacessível (${err.message})`,
      { ambiguous: ambiguousOnNetError, cause: err }
    );
  }
  if (resp.status !== 200) {
    // HTML de proxy/erro 500: nunca tentar parsear como autorização
    throw new SefazTransportError(
      `SEFAZ-SP HTTP ${resp.status}`,
      { ambiguous: ambiguousOnNetError, httpStatus: resp.status }
    );
  }
  let parsed;
  try {
    parsed = parser.parse(resp.body);
  } catch (err) {
    throw new SefazTransportError('Resposta SEFAZ-SP não é XML válido', { ambiguous: ambiguousOnNetError, cause: err });
  }
  const ret = findDeep(parsed, retKey);
  if (!ret) {
    throw new SefazTransportError(`Resposta SEFAZ-SP sem ${retKey}`, { ambiguous: ambiguousOnNetError });
  }
  return { ret, rawXml: resp.body };
}

async function withRetry(fn, { attempts = 3, baseDelayMs = 500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
    }
  }
  throw lastErr;
}

// ---------- serviços ----------

/**
 * NFeStatusServico4 — consSitServ. Idempotente: retry automático.
 * @param {number|string} [cUF] — código IBGE da UF da empresa (ex.: 35=SP,
 *   16=AP). Precisa bater com a UF que o Web Service atende, senão a SEFAZ
 *   rejeita com cStat 410. Fallback 35 só por compat retroativa.
 * @returns { cStat, xMotivo, dhRecbto, tMed, online } (107 = em operação)
 */
async function statusServico({ tpAmb, cUF, endpoints, ...opts }) {
  const eps = endpoints || getEndpoints('SP', tpAmb);
  const cUFResolved = cUF || 35;
  const inner = `<consStatServ xmlns="${NFE_NS}" versao="4.00">`
    + `<tpAmb>${tpAmb}</tpAmb><cUF>${cUFResolved}</cUF><xServ>STATUS</xServ></consStatServ>`;
  const { ret } = await withRetry(
    () => callService(eps.statusServico, WSDL_NS.statusServico, inner, 'retConsStatServ', opts,
      { ambiguousOnNetError: false })
  );
  return {
    cStat: String(ret.cStat ?? ''),
    xMotivo: ret.xMotivo || null,
    dhRecbto: ret.dhRecbto || null,
    tMed: ret.tMed != null ? Number(ret.tMed) : null,
    online: String(ret.cStat) === '107',
  };
}

/**
 * NFeAutorizacao4 síncrono (indSinc=1) — UMA tentativa, sem retry.
 * Timeout/erro de rede → SefazTransportError(ambiguous=true): o chamador
 * DEVE consultar por chave antes de reemitir. Nunca renumerar.
 * @param {string} signedNfeXml — '<NFe>...</NFe>' assinado (+infNFeSupl)
 * @returns { cStat, xMotivo, protNFe?, protocolo?, chNFe?, digVal?, autorizada, rejeitada, rawXml }
 */
async function autorizar({ signedNfeXml, idLote, tpAmb, endpoints, ...opts }) {
  const eps = endpoints || getEndpoints('SP', tpAmb);
  const lote = String(idLote || Date.now()).replace(/\D/g, '').slice(0, 15);
  const inner = `<enviNFe xmlns="${NFE_NS}" versao="4.00">`
    + `<idLote>${lote}</idLote><indSinc>1</indSinc>${signedNfeXml}</enviNFe>`;

  const { ret, rawXml } = await callService(
    eps.autorizacao, WSDL_NS.autorizacao, inner, 'retEnviNFe', opts,
    { ambiguousOnNetError: true }
  );

  const cStatLote = String(ret.cStat ?? '');
  const prot = ret.protNFe ? (Array.isArray(ret.protNFe) ? ret.protNFe[0] : ret.protNFe) : null;
  const infProt = prot ? prot.infProt : null;
  const cStat = infProt ? String(infProt.cStat ?? '') : cStatLote;
  const xMotivo = (infProt && infProt.xMotivo) || ret.xMotivo || null;

  return {
    cStatLote,
    cStat,
    xMotivo,
    protocolo: infProt ? (infProt.nProt != null ? String(infProt.nProt) : null) : null,
    chNFe: infProt ? (infProt.chNFe || null) : null,
    dhRecbto: infProt ? (infProt.dhRecbto || null) : null,
    digVal: infProt ? (infProt.digVal || null) : null,
    autorizada: cStat === '100' || cStat === '150',
    rejeitada: !!infProt && cStat !== '100' && cStat !== '150',
    rawXml,
  };
}

/**
 * NFeConsultaProtocolo4 — consSitNFe por chave. Idempotente: retry.
 * Resolve o "timeout ambíguo": diz se a nota chegou a ser autorizada.
 */
async function consultarChave({ chave, tpAmb, endpoints, ...opts }) {
  if (!/^\d{44}$/.test(String(chave))) throw new Error('consultarChave: chave deve ter 44 dígitos');
  const eps = endpoints || getEndpoints('SP', tpAmb);
  const inner = `<consSitNFe xmlns="${NFE_NS}" versao="4.00">`
    + `<tpAmb>${tpAmb}</tpAmb><xServ>CONSULTAR</xServ><chNFe>${chave}</chNFe></consSitNFe>`;
  const { ret, rawXml } = await withRetry(
    () => callService(eps.consultaProtocolo, WSDL_NS.consultaProtocolo, inner, 'retConsSitNFe', opts,
      { ambiguousOnNetError: false })
  );
  const prot = ret.protNFe ? ret.protNFe.infProt : null;
  const cStat = String(ret.cStat ?? '');
  return {
    cStat,
    xMotivo: ret.xMotivo || null,
    autorizada: cStat === '100',                       // 100 = uso autorizado
    naoConsta: cStat === '217',                        // 217 = não consta na base
    protocolo: prot && prot.nProt != null ? String(prot.nProt) : null,
    dhRecbto: prot ? (prot.dhRecbto || null) : null,
    rawXml,
  };
}

module.exports = {
  statusServico, autorizar, consultarChave,
  soapEnvelope, postSoap, withRetry,
  SefazTransportError, SOAP_NS, NFE_NS, DEFAULT_TIMEOUT_MS,
};
