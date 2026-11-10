// ============================================================
// AURA. — nfseNacional/eventoBuilder: Pedido de Registro de Evento
// (pedRegEvento) de CANCELAMENTO de NFS-e (código 101101) — função PURA.
//
// Fonte: ANEXO_II-SEFIN_ADN-PEDREGEVT_EVT-SNNFSe-v1.01-20260122 + XSD
// pedRegEvento_v1.01 / tiposEventos_v1.01 (schemas/NFSe_v1.01/ e
// schemas/NFSe_v1.01_PRODREST_20261020/ — iguais nos dois ambientes).
//   Id = "PRE" + chave de acesso (50) + código do evento (6)  (TSIdPedRegEvt, PRE[0-9]{56})
//   infPedReg: tpAmb, verAplic, dhEvento, CNPJAutor, chNFSe, e101101
//   e101101:   xDesc="Cancelamento de NFS-e", cMotivo (1 erro na emissão,
//              2 serviço não prestado, 9 outros), xMotivo (15 a 255)
// O autor é o próprio emitente (CNPJ do prestador). Assinatura obrigatória
// (tabela "TIPO EVENTOS DE NFSe" do Anexo II), em infPedReg.
// ============================================================
'use strict';

const { isoBR } = require('../sefazSp/nfeHelpers');
const { NfseNacionalError } = require('./errors');
const { paraLatin1, NFSE_NS, VERSAO_LEIAUTE, VER_APLIC } = require('./dpsBuilder');

const COD_CANCELAMENTO = '101101';
const MOTIVOS_CANCELAMENTO = { 1: 'Erro na Emissão', 2: 'Serviço não Prestado', 9: 'Outros' };

const onlyDigits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function buildIdPedido(chave, codEvento = COD_CANCELAMENTO) {
  return `PRE${chave}${codEvento}`;
}

/**
 * @param {{ tpAmb: 1|2, chave: string, cnpjAutor: string, cMotivo: 1|2|9, xMotivo: string, dhEvento?: Date }} p
 * @returns {{ xml: string, idPedido: string }}
 */
function buildCancelamento(p) {
  const chave = String(p.chave || '');
  if (!/^\d{50}$/.test(chave)) throw new NfseNacionalError('Chave de acesso da NFS-e deve ter 50 dígitos.', 'INVALID_INPUT');
  const cnpj = onlyDigits(p.cnpjAutor);
  if (cnpj.length !== 14) throw new NfseNacionalError('CNPJ do autor do cancelamento inválido.', 'INVALID_INPUT');
  const cMotivo = Number(p.cMotivo);
  if (!MOTIVOS_CANCELAMENTO[cMotivo]) {
    throw new NfseNacionalError('Código do motivo do cancelamento deve ser 1, 2 ou 9.', 'INVALID_INPUT');
  }
  const xMotivo = paraLatin1(p.xMotivo);
  if (xMotivo.length < 15 || xMotivo.length > 255) {
    throw new NfseNacionalError('Explique o motivo do cancelamento com 15 a 255 caracteres.', 'INVALID_INPUT');
  }
  if (![1, 2].includes(Number(p.tpAmb))) throw new NfseNacionalError('Ambiente inválido.', 'INVALID_INPUT');

  const idPedido = buildIdPedido(chave);
  const xml = `<pedRegEvento xmlns="${NFSE_NS}" versao="${VERSAO_LEIAUTE}">`
    + `<infPedReg Id="${idPedido}">`
    + `<tpAmb>${Number(p.tpAmb)}</tpAmb>`
    + `<verAplic>${esc(VER_APLIC)}</verAplic>`
    + `<dhEvento>${isoBR(p.dhEvento || new Date())}</dhEvento>`
    + `<CNPJAutor>${cnpj}</CNPJAutor>`
    + `<chNFSe>${chave}</chNFSe>`
    + '<e101101>'
    + '<xDesc>Cancelamento de NFS-e</xDesc>'
    + `<cMotivo>${cMotivo}</cMotivo>`
    + `<xMotivo>${esc(xMotivo)}</xMotivo>`
    + '</e101101>'
    + '</infPedReg>'
    + '</pedRegEvento>';
  return { xml, idPedido };
}

module.exports = { buildCancelamento, buildIdPedido, COD_CANCELAMENTO, MOTIVOS_CANCELAMENTO };
