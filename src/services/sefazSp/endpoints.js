// ============================================================
// AURA. — sefazSp/endpoints: URLs dos webservices SEFAZ-SP (NFC-e 65)
// Roadmap NFC-e própria v1 — S1.4. Config VERSIONADA no repo (decisão
// de arquitetura: NT muda → diff rastreável).
//
// ⚠️ Conferir contra a tabela oficial de endereços no portal da NFC-e SP
// na primeira rodada de homologação (S1.6 smoke) — URLs de webservice
// mudam raramente, mas a conferência é parte do checklist.
// Versão dos serviços: 4.00 (NFeAutorizacao4 síncrono p/ NFC-e).
// ============================================================
'use strict';

const ENDPOINTS = {
  SP: {
    homologacao: {
      autorizacao:    'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeAutorizacao4.asmx',
      retAutorizacao: 'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeRetAutorizacao4.asmx',
      statusServico:  'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeStatusServico4.asmx',
      consultaProtocolo: 'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeConsultaProtocolo4.asmx',
      recepcaoEvento: 'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeRecepcaoEvento4.asmx',
      inutilizacao:   'https://homologacao.nfce.fazenda.sp.gov.br/ws/NFeInutilizacao4.asmx',
      // QR Code v2 + consulta pública (S1.5)
      qrCodeBase:     'https://www.homologacao.nfce.fazenda.sp.gov.br/qrcode',
      urlConsulta:    'https://www.homologacao.nfce.fazenda.sp.gov.br/consulta',
    },
    producao: {
      autorizacao:    'https://nfce.fazenda.sp.gov.br/ws/NFeAutorizacao4.asmx',
      retAutorizacao: 'https://nfce.fazenda.sp.gov.br/ws/NFeRetAutorizacao4.asmx',
      statusServico:  'https://nfce.fazenda.sp.gov.br/ws/NFeStatusServico4.asmx',
      consultaProtocolo: 'https://nfce.fazenda.sp.gov.br/ws/NFeConsultaProtocolo4.asmx',
      recepcaoEvento: 'https://nfce.fazenda.sp.gov.br/ws/NFeRecepcaoEvento4.asmx',
      inutilizacao:   'https://nfce.fazenda.sp.gov.br/ws/NFeInutilizacao4.asmx',
      qrCodeBase:     'https://www.nfce.fazenda.sp.gov.br/qrcode',
      urlConsulta:    'https://www.nfce.fazenda.sp.gov.br/consulta',
    },
  },
};

// Namespace do wsdl por serviço (vai no nfeDadosMsg)
const WSDL_NS = {
  autorizacao:       'http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4',
  retAutorizacao:    'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRetAutorizacao4',
  statusServico:     'http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4',
  consultaProtocolo: 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4',
  recepcaoEvento:    'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4',
  inutilizacao:      'http://www.portalfiscal.inf.br/nfe/wsdl/NFeInutilizacao4',
};

/**
 * @param {'SP'} uf
 * @param {'homologacao'|'producao'|1|2} ambiente — aceita tpAmb numérico
 */
function getEndpoints(uf, ambiente) {
  const ufKey = String(uf || 'SP').toUpperCase();
  if (!ENDPOINTS[ufKey]) {
    throw new Error(`sefazSp: UF ${ufKey} não suportada na emissão própria (escopo: SP). Use o gateway.`);
  }
  const amb = ambiente === 1 || ambiente === '1' || ambiente === 'producao' ? 'producao'
    : ambiente === 2 || ambiente === '2' || ambiente === 'homologacao' ? 'homologacao'
    : null;
  if (!amb) throw new Error(`sefazSp: ambiente inválido (${ambiente})`);
  return ENDPOINTS[ufKey][amb];
}

module.exports = { getEndpoints, WSDL_NS, ENDPOINTS };
