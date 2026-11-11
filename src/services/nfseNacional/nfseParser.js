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

// ── leitura completa para o DANFSe gerado pela Aura (11/11/2026) ──
//
// Quando o ADN não entrega o PDF (503, timeout), o DANFSe é montado a
// partir do XML AUTORIZADO gravado na nota. Aqui só se LÊ o que o XML traz
// (TCInfNFSe + a DPS embutida): campo ausente fica null e não aparece no
// documento. Nada é deduzido nem completado com dado do cadastro.

const vazioANull = (v) => {
  const t = txt(v);
  if (t == null) return null;
  const s = t.trim();
  return s === '' ? null : s;
};

function lerEnderecoNac(end) {
  const e = primeiro(end);
  if (!e || typeof e !== 'object') return null;
  const nac = primeiro(e.endNac) || {};
  const ext = primeiro(e.endExt) || {};
  const r = {
    xLgr: vazioANull(e.xLgr),
    nro: vazioANull(e.nro),
    xCpl: vazioANull(e.xCpl),
    xBairro: vazioANull(e.xBairro),
    // emit/enderNac traz cMun/UF/CEP direto; toma/end traz em endNac
    cMun: vazioANull(e.cMun) || vazioANull(nac.cMun),
    UF: vazioANull(e.UF),
    CEP: vazioANull(e.CEP) || vazioANull(nac.CEP),
    cPais: vazioANull(ext.cPais),
    xCidade: vazioANull(ext.xCidade),
  };
  return Object.values(r).some((v) => v != null) ? r : null;
}

function lerPessoa(no, { enderecoEm }) {
  const p = primeiro(no);
  if (!p || typeof p !== 'object') return null;
  const r = {
    CNPJ: vazioANull(p.CNPJ),
    CPF: vazioANull(p.CPF),
    NIF: vazioANull(p.NIF),
    IM: vazioANull(p.IM),
    xNome: vazioANull(p.xNome),
    xFant: vazioANull(p.xFant),
    fone: vazioANull(p.fone),
    email: vazioANull(p.email),
    endereco: lerEnderecoNac(p[enderecoEm]),
  };
  return Object.values(r).some((v) => v != null) ? r : null;
}

/**
 * Tudo o que o DANFSe mostra, lido do XML da NFS-e autorizada.
 * Lança se o XML não tem infNFSe (igual a lerNfse).
 */
function lerDanfse(xml) {
  const doc = parser.parse(String(xml || ''));
  const nfse = doc.NFSe || {};
  const inf = primeiro(nfse.infNFSe);
  if (!inf) throw new Error('XML da NFS-e sem infNFSe');
  const id = txt(inf['@_Id']) || '';
  const m = id.match(/^NFS(\d{50})$/);
  const valN = primeiro(inf.valores) || {};

  const dpsNo = primeiro(inf.DPS) || {};
  const infDps = primeiro(dpsNo.infDPS) || {};
  const prest = primeiro(infDps.prest) || {};
  const regTrib = primeiro(prest.regTrib) || {};
  const serv = primeiro(infDps.serv) || {};
  const locPrest = primeiro(serv.locPrest) || {};
  const cServ = primeiro(serv.cServ) || {};
  const infoCompl = primeiro(serv.infoCompl) || {};
  const valD = primeiro(infDps.valores) || {};
  const vServPrest = primeiro(valD.vServPrest) || {};
  const desc = primeiro(valD.vDescCondIncond) || {};
  const dedRed = primeiro(valD.vDedRed) || {};
  const trib = primeiro(valD.trib) || {};
  const tribMun = primeiro(trib.tribMun) || {};
  const tribFed = primeiro(trib.tribFed) || {};
  const piscofins = primeiro(tribFed.piscofins) || {};
  const totTrib = primeiro(trib.totTrib) || {};
  const vTotTrib = primeiro(totTrib.vTotTrib) || {};
  const pTotTrib = primeiro(totTrib.pTotTrib) || {};

  return {
    chaveAcesso: m ? m[1] : null,
    nNFSe: vazioANull(inf.nNFSe),
    nDFSe: vazioANull(inf.nDFSe),
    cStat: vazioANull(inf.cStat),
    dhProc: vazioANull(inf.dhProc),
    verAplic: vazioANull(inf.verAplic),
    ambGer: vazioANull(inf.ambGer),
    tpEmis: vazioANull(inf.tpEmis),
    xLocEmi: vazioANull(inf.xLocEmi),
    xLocPrestacao: vazioANull(inf.xLocPrestacao),
    cLocIncid: vazioANull(inf.cLocIncid),
    xLocIncid: vazioANull(inf.xLocIncid),
    xTribNac: vazioANull(inf.xTribNac),
    xTribMun: vazioANull(inf.xTribMun),
    xNBS: vazioANull(inf.xNBS),
    xOutInf: vazioANull(inf.xOutInf),
    emitente: lerPessoa(inf.emit, { enderecoEm: 'enderNac' }),
    valoresNfse: {
      vCalcDR: num(valN.vCalcDR),
      vCalcBM: num(valN.vCalcBM),
      vBC: num(valN.vBC),
      pAliqAplic: num(valN.pAliqAplic),
      vISSQN: num(valN.vISSQN),
      vTotalRet: num(valN.vTotalRet),
      vLiq: num(valN.vLiq),
    },
    dps: {
      tpAmb: vazioANull(infDps.tpAmb),
      dhEmi: vazioANull(infDps.dhEmi),
      serie: vazioANull(infDps.serie),
      nDPS: vazioANull(infDps.nDPS),
      dCompet: vazioANull(infDps.dCompet),
      cLocEmi: vazioANull(infDps.cLocEmi),
    },
    prestador: {
      CNPJ: vazioANull(prest.CNPJ),
      CPF: vazioANull(prest.CPF),
      IM: vazioANull(prest.IM),
      opSimpNac: vazioANull(regTrib.opSimpNac),
      regApTribSN: vazioANull(regTrib.regApTribSN),
      regEspTrib: vazioANull(regTrib.regEspTrib),
    },
    tomador: lerPessoa(infDps.toma, { enderecoEm: 'end' }),
    servico: {
      cLocPrestacao: vazioANull(locPrest.cLocPrestacao),
      cPaisPrestacao: vazioANull(locPrest.cPaisPrestacao),
      cTribNac: vazioANull(cServ.cTribNac),
      cTribMun: vazioANull(cServ.cTribMun),
      cNBS: vazioANull(cServ.cNBS),
      xDescServ: vazioANull(cServ.xDescServ),
      xInfComp: vazioANull(infoCompl.xInfComp),
    },
    valoresDps: {
      vReceb: num(vServPrest.vReceb),
      vServ: num(vServPrest.vServ),
      vDescIncond: num(desc.vDescIncond),
      vDescCond: num(desc.vDescCond),
      pDR: num(dedRed.pDR),
      vDR: num(dedRed.vDR),
      tribISSQN: vazioANull(tribMun.tribISSQN),
      tpRetISSQN: vazioANull(tribMun.tpRetISSQN),
      pAliq: num(tribMun.pAliq),
      vPis: num(piscofins.vPis),
      vCofins: num(piscofins.vCofins),
      tpRetPisCofins: vazioANull(piscofins.tpRetPisCofins),
      vRetCP: num(tribFed.vRetCP),
      vRetIRRF: num(tribFed.vRetIRRF),
      vRetCSLL: num(tribFed.vRetCSLL),
      vTotTribFed: num(vTotTrib.vTotTribFed),
      vTotTribEst: num(vTotTrib.vTotTribEst),
      vTotTribMun: num(vTotTrib.vTotTribMun),
      pTotTribFed: num(pTotTrib.pTotTribFed),
      pTotTribEst: num(pTotTrib.pTotTribEst),
      pTotTribMun: num(pTotTrib.pTotTribMun),
      pTotTribSN: num(totTrib.pTotTribSN),
    },
  };
}

module.exports = { lerNfse, lerDps, lerDanfse };
