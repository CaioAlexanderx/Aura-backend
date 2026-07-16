// ============================================================
// AURA. — sefazSp/qrcode: QR Code v2 da NFC-e + infNFeSupl
// Roadmap NFC-e própria v1 — S1.5.
//
// Formato (NT do QR Code, versão 2):
// - Emissão NORMAL (tpEmis=1):
//     p = chNFe|2|tpAmb|idCSC|hash
// - Contingência OFFLINE (tpEmis=9):
//     p = chNFe|2|tpAmb|diaDhEmi|vNF|digValHex|idCSC|hash
// hash = SHA-1(p_sem_hash + CSC_token) em HEX MAIÚSCULO (40 chars).
// idCSC sem zeros à esquerda. CSC token NUNCA aparece na URL/log.
//
// ⚠️ Validar no validador de QR Code do portal de homologação SP na
// primeira nota do smoke (S1.6) — caixa de maiúsculas/minúsculas do hash
// é o erro clássico aqui.
// ============================================================
'use strict';

const crypto = require('crypto');

const QR_VERSION = '2';

function sha1HexUpper(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex').toUpperCase();
}

/** (16/07: urlChave vai COM esquema — SP espera https://...; rejeição 878 sem ele. stripScheme mantida p/ uso futuro.) */
function stripScheme(url) {
  return String(url || '').replace(/^https?:\/\//, '');
}

/**
 * Monta a URL completa do QR Code v2.
 * @param {{ chave, tpAmb, cscId, cscToken, qrCodeBase,
 *           tpEmis?, dhEmi?, vNF?, digVal? }} p
 *   - contingência (tpEmis=9) exige dhEmi (ISO c/ offset), vNF e digVal
 *     (DigestValue base64 do XML assinado)
 */
function buildQrCodeUrl(p) {
  if (!/^\d{44}$/.test(String(p.chave))) throw new Error('qrcode: chave deve ter 44 dígitos');
  const tpAmb = Number(p.tpAmb);
  if (tpAmb !== 1 && tpAmb !== 2) throw new Error('qrcode: tpAmb inválido');
  if (!p.cscId) throw new Error('qrcode: cscId obrigatório');
  if (!p.cscToken) throw new Error('qrcode: cscToken obrigatório');
  if (!p.qrCodeBase) throw new Error('qrcode: qrCodeBase obrigatório (endpoints.js)');

  const idCsc = String(parseInt(String(p.cscId).replace(/\D/g, ''), 10)); // sem zeros à esquerda
  const tpEmis = Number(p.tpEmis || 1);

  let semHash;
  if (tpEmis === 9) {
    if (!p.dhEmi || p.vNF === undefined || !p.digVal) {
      throw new Error('qrcode: contingência exige dhEmi, vNF e digVal');
    }
    const dia = String(p.dhEmi).slice(8, 10);             // DD do dhEmi
    if (!/^\d{2}$/.test(dia)) throw new Error('qrcode: dhEmi inválido');
    const vNF = Number(p.vNF).toFixed(2);
    // digVal = DigestValue (base64, 28 chars p/ SHA-1) convertido pra HEX
    // DA PRÓPRIA STRING base64 (XSD PL_010c: [A-Fa-f0-9]{56}) — não dos
    // bytes decodificados.
    const digValStr = String(p.digVal).trim();
    if (digValStr.length !== 28) {
      throw new Error('qrcode: digVal deve ser o DigestValue base64 da assinatura (28 chars)');
    }
    const digValHex = Buffer.from(digValStr, 'ascii').toString('hex').toUpperCase();
    semHash = [p.chave, QR_VERSION, tpAmb, dia, vNF, digValHex, idCsc].join('|');
  } else {
    semHash = [p.chave, QR_VERSION, tpAmb, idCsc].join('|');
  }

  const hash = sha1HexUpper(semHash + p.cscToken);
  return `${p.qrCodeBase}?p=${semHash}|${hash}`;
}

/**
 * Monta o bloco infNFeSupl (entra entre infNFe e Signature no <NFe>).
 * @param {{ qrCodeUrl: string, urlConsulta: string }} p
 */
function buildInfNfeSupl({ qrCodeUrl, urlConsulta }) {
  if (!qrCodeUrl) throw new Error('infNFeSupl: qrCodeUrl obrigatória');
  if (!urlConsulta) throw new Error('infNFeSupl: urlConsulta obrigatória');
  return '<infNFeSupl>'
    + `<qrCode><![CDATA[${qrCodeUrl}]]></qrCode>`
    + `<urlChave>${urlConsulta}</urlChave>`
    + '</infNFeSupl>';
}

module.exports = { buildQrCodeUrl, buildInfNfeSupl, sha1HexUpper, stripScheme, QR_VERSION };
