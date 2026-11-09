// ============================================================
// AURA. — nfseNacional/client: transporte REST + mTLS com o Sefin Nacional
// e o ADN (DANFSe).
//
// Contrato (Manual dos Contribuintes — API Emissor Público v1.2, out/2025;
// OpenAPI da produção restrita):
//   POST /nfse                         { dpsXmlGZipB64 }
//        201 { tipoAmbiente, versaoAplicativo, dataHoraProcessamento, idDps,
//              chaveAcesso, nfseXmlGZipB64, alertas[] }
//        400/403/500 { idDPS?, erros[{ codigo, descricao, complemento }] }
//   GET  /nfse/{chaveAcesso}           200 { chaveAcesso, nfseXmlGZipB64 } | 404
//   GET  /dps/{idDps}                  200 { idDps, chaveAcesso } | 404 (não gerada)
//   POST /nfse/{chave}/eventos         { pedidoRegistroEventoXmlGZipB64 }
//        201 { eventoXmlGZipB64 } | 400 { erro{...} } (ResponseErro)
//   GET  /nfse/{chave}/eventos/{tipo}/{nSeq}   consulta de evento
//   ADN  GET /danfse/{chaveAcesso}     PDF
// Mensagens em JSON UTF-8; XML vai e volta GZip + base64.
//
// REGRA DE OURO (igual à NFC-e própria): POST de DPS e de evento é UMA
// tentativa. Timeout, erro de rede, 5xx ou resposta ilegível viram
// NfseNacionalTransportError(ambiguous=true) — o chamador consulta pela DPS
// antes de reenviar e nunca renumera. GET (consultas) tem retry curto.
//
// mTLS: o mesmo material da NFC-e (sefazSp/soapClient.tlsMaterial: chave e
// cadeia do A1 extraídas em memória) e as mesmas raízes (Mozilla + ICP-Brasil
// em sefazSp/certs). Testes injetam `transport`.
// ============================================================
'use strict';

const https = require('https');
const zlib = require('zlib');
const { tlsMaterial, caBundle, withRetry } = require('../sefazSp/soapClient');
const { NfseNacionalTransportError } = require('./errors');

const DEFAULT_TIMEOUT_MS = 30000;

function gzipB64(xml) {
  return zlib.gzipSync(Buffer.from(String(xml), 'utf8')).toString('base64');
}

function gunzipB64(b64) {
  return zlib.gunzipSync(Buffer.from(String(b64), 'base64')).toString('utf8');
}

/**
 * Requisição HTTPS crua. Devolve { status, headers, body: Buffer }.
 * `ca` só existe para o teste de mTLS com servidor local; em uso real vale
 * o caBundle() (Mozilla + ICP-Brasil), igual à NFC-e.
 */
function httpsRequest({ method, url, body, pfx, passphrase, timeoutMs = DEFAULT_TIMEOUT_MS, accept = 'application/json', ca }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { Accept: accept };
    if (payload) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = payload.length;
    }
    const req = https.request({
      host: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      ca: ca || caBundle(),
      ...tlsMaterial(pfx, passphrase),
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout após ${timeoutMs}ms`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function send(opts) {
  const { transport, ...rest } = opts;
  return transport ? transport(rest) : httpsRequest(rest);
}

function parseJson(resp) {
  const txt = Buffer.isBuffer(resp.body) ? resp.body.toString('utf8') : String(resp.body || '');
  if (!txt.trim()) return null;
  try { return JSON.parse(txt); } catch (_) { return undefined; }
}

/** Normaliza a lista de mensagens: aceita erros[] ou erro{}, camelCase ou PascalCase. */
function mensagens(json, chave = 'erros') {
  if (!json || typeof json !== 'object') return [];
  let lista = json[chave] ?? json[chave.charAt(0).toUpperCase() + chave.slice(1)];
  if (!lista && chave === 'erros') lista = json.erro ?? json.Erro;
  if (!lista) return [];
  if (!Array.isArray(lista)) lista = [lista];
  return lista.filter(Boolean).map((m) => ({
    codigo: String(m.codigo ?? m.Codigo ?? '').trim() || null,
    descricao: String(m.descricao ?? m.Descricao ?? '').trim() || null,
    complemento: String(m.complemento ?? m.Complemento ?? '').trim() || null,
  }));
}

function cabecalho(json) {
  if (!json || typeof json !== 'object') return {};
  return {
    tipoAmbiente: json.tipoAmbiente ?? null,
    versaoAplicativo: json.versaoAplicativo ?? null,
    dataHoraProcessamento: json.dataHoraProcessamento ?? null,
  };
}

async function sendOrAmbiguous(opts, ambiguous) {
  try {
    return await send(opts);
  } catch (err) {
    throw new NfseNacionalTransportError(`Sistema Nacional NFS-e inacessível (${err.message})`, { ambiguous, cause: err });
  }
}

/**
 * Envia a DPS assinada. UMA tentativa.
 * @returns {{ kind: 'autorizada', chaveAcesso, idDps, nfseXml, alertas, cabecalho }
 *         | { kind: 'rejeitada', httpStatus, idDps, erros, cabecalho }
 *         | { kind: 'recusada', httpStatus: 401|403, erros }}
 */
async function enviarDps({ sefinUrl, signedXml, pfx, passphrase, timeoutMs, transport }) {
  const resp = await sendOrAmbiguous({
    method: 'POST', url: `${sefinUrl}/nfse`,
    body: { dpsXmlGZipB64: gzipB64(signedXml) },
    pfx, passphrase, timeoutMs, transport,
  }, true);
  const json = parseJson(resp);

  if (resp.status === 201 || resp.status === 200) {
    if (!json || !json.chaveAcesso || !json.nfseXmlGZipB64) {
      throw new NfseNacionalTransportError('Resposta de sucesso do Sefin sem chave ou sem XML', { ambiguous: true, httpStatus: resp.status });
    }
    let nfseXml;
    try { nfseXml = gunzipB64(json.nfseXmlGZipB64); } catch (err) {
      throw new NfseNacionalTransportError('XML da NFS-e devolvido pelo Sefin ilegível', { ambiguous: true, httpStatus: resp.status, cause: err });
    }
    return {
      kind: 'autorizada',
      chaveAcesso: String(json.chaveAcesso),
      idDps: json.idDps || json.idDPS || null,
      nfseXml,
      alertas: mensagens(json, 'alertas'),
      cabecalho: cabecalho(json),
    };
  }
  if (resp.status === 400 && json) {
    return { kind: 'rejeitada', httpStatus: 400, idDps: json.idDPS || json.idDps || null, erros: mensagens(json), cabecalho: cabecalho(json) };
  }
  if ((resp.status === 401 || resp.status === 403) && json !== undefined) {
    // certificado da conexão recusado: nada foi processado
    return { kind: 'recusada', httpStatus: resp.status, erros: mensagens(json) };
  }
  // 500 ("falha durante o processamento"), 502/503/504 de proxy, HTML, etc.
  throw new NfseNacionalTransportError(`Sefin Nacional HTTP ${resp.status}`, { ambiguous: true, httpStatus: resp.status });
}

/** GET /dps/{id}: { encontrada: true, chaveAcesso } | { encontrada: false }. Idempotente: retry. */
async function consultarDps({ sefinUrl, idDps, pfx, passphrase, timeoutMs, transport, retry }) {
  return withRetry(async () => {
    const resp = await sendOrAmbiguous({ method: 'GET', url: `${sefinUrl}/dps/${encodeURIComponent(idDps)}`, pfx, passphrase, timeoutMs, transport }, false);
    const json = parseJson(resp);
    if (resp.status === 200 && json && json.chaveAcesso) return { encontrada: true, chaveAcesso: String(json.chaveAcesso) };
    if (resp.status === 404) return { encontrada: false, erros: mensagens(json) };
    throw new NfseNacionalTransportError(`Consulta da DPS: HTTP ${resp.status}`, { httpStatus: resp.status });
  }, retry);
}

/** GET /nfse/{chave}: { chaveAcesso, nfseXml } | null (404). Idempotente: retry. */
async function consultarNfse({ sefinUrl, chave, pfx, passphrase, timeoutMs, transport, retry }) {
  return withRetry(async () => {
    const resp = await sendOrAmbiguous({ method: 'GET', url: `${sefinUrl}/nfse/${encodeURIComponent(chave)}`, pfx, passphrase, timeoutMs, transport }, false);
    const json = parseJson(resp);
    if (resp.status === 200 && json && json.nfseXmlGZipB64) {
      return { chaveAcesso: String(json.chaveAcesso || chave), nfseXml: gunzipB64(json.nfseXmlGZipB64) };
    }
    if (resp.status === 404) return null;
    throw new NfseNacionalTransportError(`Consulta da NFS-e: HTTP ${resp.status}`, { httpStatus: resp.status });
  }, retry);
}

/** POST /nfse/{chave}/eventos. UMA tentativa. */
async function enviarEvento({ sefinUrl, chave, signedXml, pfx, passphrase, timeoutMs, transport }) {
  const resp = await sendOrAmbiguous({
    method: 'POST', url: `${sefinUrl}/nfse/${encodeURIComponent(chave)}/eventos`,
    body: { pedidoRegistroEventoXmlGZipB64: gzipB64(signedXml) },
    pfx, passphrase, timeoutMs, transport,
  }, true);
  const json = parseJson(resp);
  if ((resp.status === 201 || resp.status === 200) && json && json.eventoXmlGZipB64) {
    return { kind: 'registrado', eventoXml: gunzipB64(json.eventoXmlGZipB64), cabecalho: cabecalho(json) };
  }
  if ((resp.status === 400 || resp.status === 401 || resp.status === 403) && json) {
    return { kind: 'rejeitado', httpStatus: resp.status, erros: mensagens(json) };
  }
  throw new NfseNacionalTransportError(`Evento: Sefin Nacional HTTP ${resp.status}`, { ambiguous: true, httpStatus: resp.status });
}

/** GET /nfse/{chave}/eventos/{tipo}/{nSeq}: { eventoXml } | null. */
async function consultarEvento({ sefinUrl, chave, tipoEvento, nSeq = 1, pfx, passphrase, timeoutMs, transport, retry }) {
  return withRetry(async () => {
    const resp = await sendOrAmbiguous({
      method: 'GET', url: `${sefinUrl}/nfse/${encodeURIComponent(chave)}/eventos/${tipoEvento}/${nSeq}`,
      pfx, passphrase, timeoutMs, transport,
    }, false);
    const json = parseJson(resp);
    if (resp.status === 200 && json) {
      const b64 = json.eventoXmlGZipB64 || (Array.isArray(json.eventos) && json.eventos[0] && json.eventos[0].eventoXmlGZipB64);
      return { eventoXml: b64 ? gunzipB64(b64) : null };
    }
    if (resp.status === 404) return null;
    throw new NfseNacionalTransportError(`Consulta de evento: HTTP ${resp.status}`, { httpStatus: resp.status });
  }, retry);
}

/** ADN GET /danfse/{chave}: Buffer do PDF. */
async function baixarDanfse({ danfseUrl, chave, pfx, passphrase, timeoutMs, transport, retry }) {
  return withRetry(async () => {
    const resp = await sendOrAmbiguous({
      method: 'GET', url: `${danfseUrl}/${encodeURIComponent(chave)}`,
      pfx, passphrase, timeoutMs, transport, accept: 'application/pdf',
    }, false);
    const body = Buffer.isBuffer(resp.body) ? resp.body : Buffer.from(resp.body || '');
    if (resp.status === 200 && body.slice(0, 5).toString('latin1') === '%PDF-') return body;
    if (resp.status === 404) return null;
    throw new NfseNacionalTransportError(`DANFSe: HTTP ${resp.status}`, { httpStatus: resp.status });
  }, retry);
}

module.exports = {
  enviarDps, consultarDps, consultarNfse, enviarEvento, consultarEvento, baixarDanfse,
  gzipB64, gunzipB64, mensagens, httpsRequest, DEFAULT_TIMEOUT_MS,
};
