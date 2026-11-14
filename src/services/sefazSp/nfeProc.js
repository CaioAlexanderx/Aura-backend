// ============================================================
// AURA. — sefazSp/nfeProc: o arquivo XML "de guardar" da NF-e 55
// (nfeProc = NFe assinada + protNFe). 14/11/2026 — CP3.
//
// A partir do CP3 a engine guarda o <protNFe> que a SEFAZ devolve
// (metadata.prot_xml). Notas autorizadas antes disso só têm os campos do
// protocolo (nProt, data): o protNFe é remontado com eles + o digVal da
// assinatura, com verAplic='AURA' marcando a remontagem.
// Funções puras, sem PDF (a engine usa extrairProtNFe a cada envio).
// ============================================================
'use strict';

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';

const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Extrai o <protNFe> de um retorno SOAP da SEFAZ (autorização ou consulta). null se não houver. */
function extrairProtNFe(rawXml) {
  const m = String(rawXml || '').match(/<(?:\w+:)?protNFe\b[\s\S]*?<\/(?:\w+:)?protNFe>/);
  if (!m) return null;
  // sem prefixo nem xmlns próprio: entra no nfeProc sob o namespace padrão da NF-e
  return m[0].replace(/<(\/?)\w+:/g, '<$1').replace(/\sxmlns(:\w+)?="[^"]*"/g, '');
}

/** DigestValue da assinatura (é o digVal do protocolo). */
function digestValue(xmlSigned) {
  const m = String(xmlSigned || '').match(/<DigestValue>([^<]+)<\/DigestValue>/);
  return m ? m[1] : null;
}

/** Só o elemento <NFe>...</NFe> de um xml_signed (ou de um nfeProc). */
function soNFe(xmlSigned) {
  const x = String(xmlSigned || '');
  const i = x.search(/<NFe[\s>]/);
  const j = x.lastIndexOf('</NFe>');
  if (i < 0 || j < 0) throw new Error('nfeProc: XML sem <NFe>');
  return x.slice(i, j + '</NFe>'.length);
}

function protNFeReconstruido({ chave, tpAmb, nProt, dhRecbto, digVal }) {
  return '<protNFe versao="4.00"><infProt>'
    + `<tpAmb>${esc(tpAmb)}</tpAmb><verAplic>AURA</verAplic><chNFe>${esc(chave)}</chNFe>`
    + `<dhRecbto>${esc(dhRecbto)}</dhRecbto><nProt>${esc(nProt)}</nProt>`
    + (digVal ? `<digVal>${esc(digVal)}</digVal>` : '')
    + '<cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo>'
    + '</infProt></protNFe>';
}

/** "2026-11-14T13:00:05.000Z" (Date/ISO) → "2026-11-14T10:00:05-03:00" (formato TDateTimeUTC da NF-e). */
function dhBrasilia(v) {
  if (!v) return '';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[-+]\d{2}:\d{2}$/.test(v)) return v;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - 3 * 3600e3).toISOString().replace(/\.\d{3}Z$/, '-03:00');
}

/**
 * nfeProc pronto para baixar/anexar.
 * @param {string} xmlSigned
 * @param {{ protXml?, protocolo?, dhRecbto? }} p
 * @returns {{ xml: string, chave: string, protOrigem: 'sefaz'|'reconstruido' }}
 */
function montarNfeProc(xmlSigned, { protXml, protocolo, dhRecbto } = {}) {
  const nfe = soNFe(xmlSigned);
  const chave = (nfe.match(/Id="NFe(\d{44})"/) || [])[1];
  if (!chave) throw new Error('nfeProc: chave de acesso não encontrada no XML');
  let prot = protXml && /<protNFe\b/.test(protXml) && protXml.includes(chave) ? protXml : null;
  let origem = 'sefaz';
  if (!prot) {
    if (!protocolo) throw new Error('nfeProc: nota sem protocolo de autorização');
    const tpAmb = (nfe.match(/<tpAmb>(\d)<\/tpAmb>/) || [])[1] || '';
    prot = protNFeReconstruido({ chave, tpAmb, nProt: protocolo, dhRecbto: dhBrasilia(dhRecbto), digVal: digestValue(nfe) });
    origem = 'reconstruido';
  }
  return {
    xml: `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="${NFE_NS}" versao="4.00">${nfe}${prot}</nfeProc>`,
    chave,
    protOrigem: origem,
  };
}

module.exports = { extrairProtNFe, digestValue, soNFe, protNFeReconstruido, montarNfeProc, dhBrasilia };
