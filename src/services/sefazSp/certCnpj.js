// ============================================================
// AURA. — sefazSp/certCnpj: CNPJ de dentro do certificado A1 (14/10/2026)
//
// Funções PURAS (sem banco, sem log, sem I/O) usadas pela rota do cliente
// (routes/fiscalCertificate.js) para conferir que o e-CNPJ enviado é da
// empresa certa ANTES de gravar.
//
// Fontes, em ordem de confiança (certificado ICP-Brasil):
//   1. OID 2.16.76.1.3.3 (CNPJ da pessoa jurídica, campo otherName do
//      subjectAltName) — é o campo oficial.
//   2. CN no formato "RAZAO SOCIAL:CNPJ14" (padrão das ACs).
// e-CPF (11 dígitos) e certificado sem CNPJ devolvem null.
// ============================================================
'use strict';

// DER de OID 2.16.76.1.3.3: 06 05 60 4C 01 03 03
const OID_CNPJ_PJ = Buffer.from([0x06, 0x05, 0x60, 0x4c, 0x01, 0x03, 0x03]);

function soDigitos(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

/** "RAZAO SOCIAL LTDA:11222333000181" → "11222333000181" | null */
function cnpjDoCn(cn) {
  if (!cn) return null;
  const txt = String(cn);
  const depoisDosDoisPontos = txt.includes(':') ? txt.slice(txt.lastIndexOf(':') + 1) : txt;
  const d = soDigitos(depoisDosDoisPontos);
  if (d.length === 14) return d;
  // CN sem ":" ou com texto depois: aceita uma sequência isolada de 14 dígitos.
  const m = txt.replace(/[.\-/\s]/g, '').match(/(?:^|\D)(\d{14})(?!\d)/);
  return m ? m[1] : null;
}

/** Procura o OID 2.16.76.1.3.3 no DER do certificado e lê os 14 dígitos que vêm logo depois. */
function cnpjDoOid(certDer) {
  if (!Buffer.isBuffer(certDer) || certDer.length === 0) return null;
  let from = 0;
  for (;;) {
    const i = certDer.indexOf(OID_CNPJ_PJ, from);
    if (i === -1) return null;
    const ini = i + OID_CNPJ_PJ.length;
    const janela = certDer.slice(ini, ini + 24).toString('latin1');
    const m = janela.match(/\d{14}/);
    if (m) return m[0];
    from = i + 1;
  }
}

/**
 * @param {{ certDerBase64?: string, subjectCN?: string }} info — retorno de openPfx
 * @returns {{ cnpj: string, origem: 'oid'|'cn' } | null}
 */
function extrairCnpjDoCertificado(info) {
  if (!info) return null;
  let der = null;
  try {
    if (info.certDerBase64) der = Buffer.from(String(info.certDerBase64), 'base64');
  } catch (_) { der = null; }
  const doOid = cnpjDoOid(der);
  if (doOid) return { cnpj: doOid, origem: 'oid' };
  const doCn = cnpjDoCn(info.subjectCN);
  if (doCn) return { cnpj: doCn, origem: 'cn' };
  return null;
}

/**
 * Compara o CNPJ do certificado com o da empresa (só dígitos).
 * `aceitaRaiz`: aceita matriz/filial do mesmo grupo (8 primeiros dígitos) —
 * a SEFAZ aceita o e-CNPJ da matriz para as filiais. Padrão: igualdade total.
 */
function cnpjConfere(cnpjCert, cnpjEmpresa, aceitaRaiz = false) {
  const a = soDigitos(cnpjCert);
  const b = soDigitos(cnpjEmpresa);
  if (a.length !== 14 || b.length !== 14) return false;
  if (a === b) return true;
  return aceitaRaiz === true && a.slice(0, 8) === b.slice(0, 8);
}

module.exports = { extrairCnpjDoCertificado, cnpjDoCn, cnpjDoOid, cnpjConfere, soDigitos };
