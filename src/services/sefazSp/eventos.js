// ============================================================
// AURA. — sefazSp/eventos: cancelamento (evento 110111) e inutilização
// Roadmap NFC-e própria v1 — S2.1.
//
// - Cancelamento: NFeRecepcaoEvento4, envEvento/evento/infEvento assinado
//   (Id = "ID" + tpEvento + chave + nSeqEvento[2]). Sucesso: cStat 135/136.
//   Justificativa 15–255 chars (regra já existente na rota).
//   ⚠️ Prazo legal de cancelamento de NFC-e em SP: tratado na camada de
//   rota (CANCEL_DEADLINE_MIN) — confirmar valor vigente no MOC SP.
// - Inutilização: NFeInutilizacao4, inutNFe/infInut assinado
//   (Id = "ID" + cUF + ano2 + CNPJ + mod + serie[3] + nIni[9] + nFin[9]).
//   Sucesso: cStat 102.
//
// cOrgao/cUF: código IBGE da UF da empresa (35=SP, 16=AP, ...) — precisa
// bater com a UF que o Web Service atende (mesma regra do statusServico
// em soapClient.js). Default 35 só por compat retroativa (empresas SP
// existentes antes desse parâmetro existir).
//
// Auto-contido no transporte (reusa soapEnvelope/postSoap exportados)
// e na assinatura (constantes do signer) — não altera módulos da S1.
// ============================================================
'use strict';

const { SignedXml } = require('xml-crypto');
const { XMLParser } = require('fast-xml-parser');
const { soapEnvelope, postSoap, SefazTransportError } = require('./soapClient');
const { WSDL_NS } = require('./endpoints');
const { C14N, ENVELOPED, RSA_SHA1, SHA1 } = require('./signer');
const { isoBR } = require('../nuvemfiscal');

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';
const TP_EVENTO_CANCELAMENTO = '110111';

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_',
  removeNSPrefix: true, parseTagValue: false,
});

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function onlyDigits(s) { return String(s || '').replace(/\D/g, ''); }

function findDeep(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj[key] !== undefined) return obj[key];
  for (const k of Object.keys(obj)) {
    const found = findDeep(obj[k], key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Assina elemento com atributo Id (enveloped, padrão NF-e) e devolve <Signature>. */
function signElement(wrappedXml, refLocalName, { keyPem, certDerBase64 }) {
  const sig = new SignedXml({
    privateKey: keyPem,
    canonicalizationAlgorithm: C14N,
    signatureAlgorithm: RSA_SHA1,
    getKeyInfoContent: () => `<X509Data><X509Certificate>${certDerBase64}</X509Certificate></X509Data>`,
  });
  sig.addReference({
    xpath: `//*[local-name(.)='${refLocalName}']`,
    transforms: [ENVELOPED, C14N],
    digestAlgorithm: SHA1,
  });
  sig.computeSignature(wrappedXml, {
    location: { reference: `//*[local-name(.)='${refLocalName}']`, action: 'after' },
  });
  const m = sig.getSignedXml().match(/<Signature[\s\S]*<\/Signature>/);
  if (!m) throw new Error('eventos: assinatura não gerada');
  return m[0];
}

async function callSoap(url, wsdlNs, innerXml, retKey, opts) {
  let resp;
  try {
    resp = await postSoap(url, soapEnvelope(wsdlNs, innerXml), opts);
  } catch (err) {
    throw new SefazTransportError(`SEFAZ-SP inacessível (${err.message})`, { cause: err });
  }
  if (resp.status !== 200) {
    throw new SefazTransportError(`SEFAZ-SP HTTP ${resp.status}`, { httpStatus: resp.status });
  }
  let parsed;
  try { parsed = parser.parse(resp.body); }
  catch (err) { throw new SefazTransportError('Resposta SEFAZ-SP não é XML válido', { cause: err }); }
  const ret = findDeep(parsed, retKey);
  if (!ret) throw new SefazTransportError(`Resposta SEFAZ-SP sem ${retKey}`);
  return { ret, rawXml: resp.body };
}

// ---------- Cancelamento (evento 110111) ----------

/**
 * Monta o infEvento de cancelamento (sem assinatura).
 * @param {number|string} [cOrgao=35] — código IBGE da UF da empresa.
 * @returns { infEventoXml, idEvento }
 */
function buildInfEventoCancelamento({ chave, cnpj, tpAmb, cOrgao = 35, protocolo, justificativa, nSeqEvento = 1, dhEvento }) {
  if (!/^\d{44}$/.test(String(chave))) throw new Error('cancelamento: chave deve ter 44 dígitos');
  const cnpjClean = onlyDigits(cnpj);
  if (cnpjClean.length !== 14) throw new Error('cancelamento: CNPJ inválido');
  if (!protocolo) throw new Error('cancelamento: protocolo de autorização obrigatório');
  const xJust = String(justificativa || '').replace(/\s+/g, ' ').trim();
  if (xJust.length < 15 || xJust.length > 255) {
    throw new Error('cancelamento: justificativa deve ter entre 15 e 255 caracteres');
  }
  const seq = String(nSeqEvento).padStart(2, '0');
  const idEvento = `ID${TP_EVENTO_CANCELAMENTO}${chave}${seq}`;
  const infEventoXml = `<infEvento Id="${idEvento}">`
    + `<cOrgao>${cOrgao}</cOrgao>`
    + `<tpAmb>${Number(tpAmb)}</tpAmb>`
    + `<CNPJ>${cnpjClean}</CNPJ>`
    + `<chNFe>${chave}</chNFe>`
    + `<dhEvento>${dhEvento || isoBR()}</dhEvento>`
    + `<tpEvento>${TP_EVENTO_CANCELAMENTO}</tpEvento>`
    + `<nSeqEvento>${Number(nSeqEvento)}</nSeqEvento>`
    + '<verEvento>1.00</verEvento>'
    + '<detEvento versao="1.00">'
    + '<descEvento>Cancelamento</descEvento>'
    + `<nProt>${esc(protocolo)}</nProt>`
    + `<xJust>${esc(xJust)}</xJust>`
    + '</detEvento>'
    + '</infEvento>';
  return { infEventoXml, idEvento };
}

/**
 * Envia o cancelamento. Sucesso: cStat 135 (vinculado) ou 136 (registrado).
 * 573 = duplicidade de evento (já cancelada) — tratado como sucesso idempotente.
 */
async function cancelarNfce({ chave, cnpj, tpAmb, cOrgao, protocolo, justificativa, endpoints, cert, ...opts }) {
  const { infEventoXml } = buildInfEventoCancelamento({ chave, cnpj, tpAmb, cOrgao, protocolo, justificativa });
  const eventoWrapper = `<evento xmlns="${NFE_NS}" versao="1.00">${infEventoXml}</evento>`;
  const signatureXml = signElement(eventoWrapper, 'infEvento', cert);
  const eventoXml = `<evento xmlns="${NFE_NS}" versao="1.00">${infEventoXml}${signatureXml}</evento>`;
  const inner = `<envEvento xmlns="${NFE_NS}" versao="1.00">`
    + `<idLote>${Date.now()}</idLote>${eventoXml}</envEvento>`;

  const { ret, rawXml } = await callSoap(
    endpoints.recepcaoEvento, WSDL_NS.recepcaoEvento, inner, 'retEnvEvento', opts
  );
  const retEvento = ret.retEvento ? (Array.isArray(ret.retEvento) ? ret.retEvento[0] : ret.retEvento) : null;
  const infEvento = retEvento ? retEvento.infEvento : null;
  const cStat = infEvento ? String(infEvento.cStat ?? '') : String(ret.cStat ?? '');
  const xMotivo = (infEvento && infEvento.xMotivo) || ret.xMotivo || null;
  const sucesso = cStat === '135' || cStat === '136';
  const jaCancelada = cStat === '573';

  return {
    sucesso: sucesso || jaCancelada,
    cStat, xMotivo,
    protocoloEvento: infEvento && infEvento.nProt != null ? String(infEvento.nProt) : null,
    dhRegEvento: infEvento ? (infEvento.dhRegEvento || null) : null,
    jaCancelada,
    rawXml,
  };
}

// ---------- Inutilização ----------

/**
 * Monta o infInut (sem assinatura).
 * @param {number|string} [cUF=35] — código IBGE da UF da empresa (entra
 *   no campo <cUF> e no prefixo do atributo Id).
 * @returns { infInutXml, idInut }
 */
function buildInfInut({ tpAmb, cUF = 35, ano2, cnpj, serie, nIni, nFin, justificativa, mod = 65 }) {
  const cnpjClean = onlyDigits(cnpj);
  if (cnpjClean.length !== 14) throw new Error('inutilização: CNPJ inválido');
  const a2 = String(ano2 ?? String(new Date().getFullYear()).slice(2));
  if (!/^\d{2}$/.test(a2)) throw new Error('inutilização: ano (2 dígitos) inválido');
  const ini = Number(nIni), fin = Number(nFin);
  if (!Number.isInteger(ini) || !Number.isInteger(fin) || ini < 1 || fin < ini) {
    throw new Error('inutilização: faixa inválida (numero_inicial ≤ numero_final, ambos ≥ 1)');
  }
  const xJust = String(justificativa || '').replace(/\s+/g, ' ').trim();
  if (xJust.length < 15 || xJust.length > 255) {
    throw new Error('inutilização: justificativa deve ter entre 15 e 255 caracteres');
  }
  const serie3 = String(Number(serie)).padStart(3, '0');
  const idInut = `ID${cUF}${a2}${cnpjClean}${mod}${serie3}${String(ini).padStart(9, '0')}${String(fin).padStart(9, '0')}`;
  const infInutXml = `<infInut Id="${idInut}">`
    + `<tpAmb>${Number(tpAmb)}</tpAmb>`
    + '<xServ>INUTILIZAR</xServ>'
    + `<cUF>${cUF}</cUF>`
    + `<ano>${a2}</ano>`
    + `<CNPJ>${cnpjClean}</CNPJ>`
    + `<mod>${mod}</mod>`
    + `<serie>${Number(serie)}</serie>`
    + `<nNFIni>${ini}</nNFIni>`
    + `<nNFFin>${fin}</nNFFin>`
    + `<xJust>${esc(xJust)}</xJust>`
    + '</infInut>';
  return { infInutXml, idInut };
}

/** Envia a inutilização da faixa. Sucesso: cStat 102. */
async function inutilizar({ tpAmb, cUF, ano2, cnpj, serie, nIni, nFin, justificativa, endpoints, cert, ...opts }) {
  const { infInutXml } = buildInfInut({ tpAmb, cUF, ano2, cnpj, serie, nIni, nFin, justificativa });
  const wrapper = `<inutNFe xmlns="${NFE_NS}" versao="4.00">${infInutXml}</inutNFe>`;
  const signatureXml = signElement(wrapper, 'infInut', cert);
  const inner = `<inutNFe xmlns="${NFE_NS}" versao="4.00">${infInutXml}${signatureXml}</inutNFe>`;

  const { ret, rawXml } = await callSoap(
    endpoints.inutilizacao, WSDL_NS.inutilizacao, inner, 'retInutNFe', opts
  );
  const infInut = ret.infInut || null;
  const cStat = infInut ? String(infInut.cStat ?? '') : String(ret.cStat ?? '');
  return {
    sucesso: cStat === '102',
    cStat,
    xMotivo: (infInut && infInut.xMotivo) || ret.xMotivo || null,
    protocolo: infInut && infInut.nProt != null ? String(infInut.nProt) : null,
    rawXml,
  };
}

module.exports = {
  cancelarNfce, inutilizar,
  buildInfEventoCancelamento, buildInfInut, signElement,
  TP_EVENTO_CANCELAMENTO,
};
