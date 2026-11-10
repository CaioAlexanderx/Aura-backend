// ============================================================
// AURA. — nfseNacional/nfseParser: lê o XML da NFS-e devolvida pelo Sefin
// (TCNFSe / TCInfNFSe do XSD 1.01) — função PURA.
//
// Id da NFS-e (Anexo I, E1263): "NFS" + 50 dígitos — os 50 dígitos são a
// chave de acesso. nNFSe é gerado pelo Sefin (sequencial por emitente).
//
// A NFS-e traz a DPS que a gerou (infNFSe/DPS, TCDPS, obrigatória no XSD
// NFSe_v1.01), com a assinatura de quem a emitiu (ds:Signature, opcional).
// lerDps/lerNfse().dps leem dela o que serve para conferir se a nota é
// mesmo da DPS que a Aura assinou (conferenciaDps.js).
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

const primeiro = (v) => (Array.isArray(v) ? v[0] : v);

/**
 * Campos de conferência de um nó <DPS> já lido pelo parser.
 * @returns {{ id, dhEmi, dCompet, serie, nDPS, verAplic, cTribNac, vServ, tomadorDoc, digest } | null}
 */
function lerInfDps(dpsNode) {
  const dps = primeiro(dpsNode);
  if (!dps || typeof dps !== 'object') return null;
  const inf = primeiro(dps.infDPS);
  if (!inf || typeof inf !== 'object') return null;
  const toma = primeiro(inf.toma) || null;
  const serv = primeiro(inf.serv) || {};
  const cServ = primeiro(serv.cServ) || {};
  const val = primeiro(inf.valores) || {};
  const vsp = primeiro(val.vServPrest) || {};
  const sig = primeiro(dps.Signature);
  const signed = sig && primeiro(sig.SignedInfo);
  const ref = signed && primeiro(signed.Reference);
  return {
    id: txt(inf['@_Id']),
    dhEmi: txt(inf.dhEmi),
    dCompet: txt(inf.dCompet),
    serie: txt(inf.serie),
    nDPS: txt(inf.nDPS),
    verAplic: txt(inf.verAplic),
    cTribNac: txt(cServ.cTribNac),
    vServ: num(vsp.vServ),
    tomadorDoc: toma ? (txt(toma.CNPJ) || txt(toma.CPF) || txt(toma.NIF)) : null,
    digest: ref ? txt(ref.DigestValue) : null,
  };
}

/** Lê a DPS (assinada ou não) — o XML que a Aura grava em nfse.xml_dps. */
function lerDps(xml) {
  const doc = parser.parse(String(xml || ''));
  return lerInfDps(doc.DPS);
}

/**
 * @returns {{ chaveAcesso, nNFSe, dhProc, cStat, verAplic, valores: { vBC, pAliqAplic, vISSQN, vTotalRet, vLiq }, dps }}
 *   dps = a DPS embutida na NFS-e (lerInfDps) ou null
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
    dps: lerInfDps(inf.DPS),
  };
}

module.exports = { lerNfse, lerDps };
