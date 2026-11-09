// ============================================================
// AURA. — nfseNacional/nfseParser: lê o XML da NFS-e devolvida pelo Sefin
// (TCNFSe / TCInfNFSe do XSD 1.01) — função PURA.
//
// Id da NFS-e (Anexo I, E1263): "NFS" + 50 dígitos — os 50 dígitos são a
// chave de acesso. nNFSe é gerado pelo Sefin (sequencial por emitente).
// ============================================================
'use strict';

const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false, // números como texto: preserva zeros
});

function txt(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object') return v['#text'] != null ? String(v['#text']) : null;
  return String(v);
}

function num(v) {
  const t = txt(v);
  if (t == null || t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * @returns {{ chaveAcesso, nNFSe, dhProc, cStat, verAplic, valores: { vBC, pAliqAplic, vISSQN, vTotalRet, vLiq } }}
 */
function lerNfse(xml) {
  const doc = parser.parse(String(xml || ''));
  const nfse = doc.NFSe || {};
  const inf = nfse.infNFSe;
  if (!inf) throw new Error('XML da NFS-e sem infNFSe');
  const id = txt(inf['@_Id']) || '';
  const m = id.match(/^NFS(\d{50})$/);
  const val = inf.valores || {};
  return {
    chaveAcesso: m ? m[1] : null,
    nNFSe: txt(inf.nNFSe),
    dhProc: txt(inf.dhProc),
    cStat: txt(inf.cStat),
    verAplic: txt(inf.verAplic),
    valores: {
      vBC: num(val.vBC),
      pAliqAplic: num(val.pAliqAplic),
      vISSQN: num(val.vISSQN),
      vTotalRet: num(val.vTotalRet),
      vLiq: num(val.vLiq),
    },
  };
}

module.exports = { lerNfse };
