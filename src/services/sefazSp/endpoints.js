// ============================================================
// AURA. — sefazSp/endpoints: URLs dos webservices SEFAZ (NFC-e 65)
// Roadmap NFC-e própria v1 — S1.4. Config VERSIONADA no repo (decisão
// de arquitetura: NT muda → diff rastreável).
//
// 06/08/2026 — Nuvem Fiscal não existe mais: toda emissão sai pela
// engine própria (sem fallback de gateway). Estendido pra AP, que não
// roda SEFAZ própria — autorização é delegada à SVRS (Sefaz Virtual do
// Rio Grande do Sul), infraestrutura compartilhada usada por vários
// estados menores. O layout do XML (NFC-e 65) é o mesmo em todo o
// país; só muda o host que autoriza e o host de consulta pública/QR.
//
// ⚠️ Conferir contra a tabela oficial de endereços de cada UF na
// primeira rodada de homologação real (S1.6 smoke, agora repetido p/
// AP) — URLs de webservice mudam raramente, mas a conferência é parte
// do checklist. qrCodeBase/urlConsulta de AP seguem o padrão do portal
// SVRS+SEFAZ-AP hoje conhecido; CONFIRMAR antes do primeiro emissão
// real em produção para AP.
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
      urlConsulta:    'https://www.homologacao.nfce.fazenda.sp.gov.br/NFCeConsultaPublica',
    },
    producao: {
      autorizacao:    'https://nfce.fazenda.sp.gov.br/ws/NFeAutorizacao4.asmx',
      retAutorizacao: 'https://nfce.fazenda.sp.gov.br/ws/NFeRetAutorizacao4.asmx',
      statusServico:  'https://nfce.fazenda.sp.gov.br/ws/NFeStatusServico4.asmx',
      consultaProtocolo: 'https://nfce.fazenda.sp.gov.br/ws/NFeConsultaProtocolo4.asmx',
      recepcaoEvento: 'https://nfce.fazenda.sp.gov.br/ws/NFeRecepcaoEvento4.asmx',
      inutilizacao:   'https://nfce.fazenda.sp.gov.br/ws/NFeInutilizacao4.asmx',
      qrCodeBase:     'https://www.nfce.fazenda.sp.gov.br/qrcode',
      urlConsulta:    'https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica',
    },
  },
  // AP não tem SEFAZ própria — autorização delegada à SVRS (Sefaz Virtual
  // do RS). Fonte: portal oficial SVRS (dfe-portal.svrs.rs.gov.br).
  AP: {
    homologacao: {
      autorizacao:    'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
      retAutorizacao: 'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
      statusServico:  'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
      consultaProtocolo: 'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
      recepcaoEvento: 'https://nfce-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
      inutilizacao:   'https://nfce-homologacao.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
      // ⚠️ NÃO CONFIRMADO com fonte 100% oficial — conferir antes do go-live.
      qrCodeBase:     'https://www.sefaz.ap.gov.br/nfce/consulta',
      urlConsulta:    'https://www.sefaz.ap.gov.br/nfce/consulta',
    },
    producao: {
      autorizacao:    'https://nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
      retAutorizacao: 'https://nfce.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
      statusServico:  'https://nfce.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
      consultaProtocolo: 'https://nfce.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
      recepcaoEvento: 'https://nfce.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
      inutilizacao:   'https://nfce.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
      // ⚠️ NÃO CONFIRMADO com fonte 100% oficial — conferir antes do go-live.
      qrCodeBase:     'https://www.sefaz.ap.gov.br/nfce/consulta',
      urlConsulta:    'https://www.sefaz.ap.gov.br/nfce/consulta',
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
 * @param {'SP'|'AP'} uf
 * @param {'homologacao'|'producao'|1|2} ambiente — aceita tpAmb numérico
 */
function getEndpoints(uf, ambiente) {
  const ufKey = String(uf || 'SP').toUpperCase();
  if (!ENDPOINTS[ufKey]) {
    throw new Error(`sefazSp: UF ${ufKey} não suportada na emissão própria. UFs disponíveis: ${Object.keys(ENDPOINTS).join(', ')}.`);
  }
  const amb = ambiente === 1 || ambiente === '1' || ambiente === 'producao' ? 'producao'
    : ambiente === 2 || ambiente === '2' || ambiente === 'homologacao' ? 'homologacao'
    : null;
  if (!amb) throw new Error(`sefazSp: ambiente inválido (${ambiente})`);
  return ENDPOINTS[ufKey][amb];
}

module.exports = { getEndpoints, WSDL_NS, ENDPOINTS };
