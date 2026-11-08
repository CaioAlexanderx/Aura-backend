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
// 07/08/2026 — qrCodeBase de AP corrigido conforme referência ACBr
// (Fontes/ACBrDFe/ACBrNFe/ACBrNFeServicos.ini, seção [NFCe_AP_P]/
// [NFCe_AP_H]): homologação usa nfcehml/nfce.php, produção usa
// nfce/nfcep.php — antes ambos apontavam pro mesmo /nfce/consulta
// (só correto pra urlConsulta, não pro QR).
//
// ⚠️ Conferir contra a tabela oficial de endereços de cada UF na
// primeira rodada de homologação real (S1.6 smoke, agora repetido p/
// AP) — URLs de webservice mudam raramente, mas a conferência é parte
// do checklist.
// Versão dos serviços: 4.00 (NFeAutorizacao4 síncrono p/ NFC-e).
//
// 08/11/2026 — MG entra. Minas autoriza NFC-e na PRÓPRIA SEFAZ (não usa
// SVRS). Serviços Java em https://nfce.fazenda.mg.gov.br/nfce/services/
// (homologação: hnfce.fazenda.mg.gov.br), sem ".asmx". QR Code v2 com a
// mesma base nos dois ambientes; consulta por chave (urlChave) muda de
// host na homologação (hportalsped). Um CSC/ID vale p/ os dois ambientes.
// Fontes, conferidas em 08/11/2026:
//   - Portal SPED MG, "Web Services" da NFC-e:
//     https://portalsped.fazenda.mg.gov.br/spedmg/nfce/web-services/
//   - ACBr, Fontes/ACBrDFe/ACBrNFe/ACBrNFeServicos.ini, seções
//     [NFCe_MG_P] e [NFCe_MG_H] (mesmas URLs, URL-QRCode_2.00 e
//     URL-ConsultaNFCe_2.00).
// TLS do servidor MG: cadeia Valid Certificadora -> Sectigo Public Server
// Authentication Root R46, que já vem nas raízes padrão do Node (não
// precisa de .pem em ./certs, ao contrário da SP).
//
// Flags por UF (opcionais; ausentes = comportamento de SP/AP, intocado):
//   soapAction  — manda o header SOAPAction "<wsdl ns>/<operação>", como o
//                 ACBr faz em todas as UFs. SP/AP nunca precisaram dele;
//                 só MG (Java) liga, p/ não depender de despacho pelo corpo.
//   infRespTec  — inclui o grupo do responsável técnico (NT 2018.005) no
//                 XML, SE os dados da Aura estiverem configurados (ver
//                 respTec.js). Relatos de rejeição 972 em MG sem o grupo.
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
  // do RS). Fonte: portal oficial SVRS (dfe-portal.svrs.rs.gov.br) +
  // referência ACBr (ACBrNFeServicos.ini) pras URLs de QR/consulta.
  AP: {
    homologacao: {
      autorizacao:    'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
      retAutorizacao: 'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
      statusServico:  'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
      consultaProtocolo: 'https://nfce-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
      recepcaoEvento: 'https://nfce-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
      inutilizacao:   'https://nfce-homologacao.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
      qrCodeBase:     'https://www.sefaz.ap.gov.br/nfcehml/nfce.php',
      urlConsulta:    'https://www.sefaz.ap.gov.br/nfce/consulta',
    },
    producao: {
      autorizacao:    'https://nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx',
      retAutorizacao: 'https://nfce.svrs.rs.gov.br/ws/NfeRetAutorizacao/NFeRetAutorizacao4.asmx',
      statusServico:  'https://nfce.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx',
      consultaProtocolo: 'https://nfce.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx',
      recepcaoEvento: 'https://nfce.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx',
      inutilizacao:   'https://nfce.svrs.rs.gov.br/ws/nfeinutilizacao/nfeinutilizacao4.asmx',
      qrCodeBase:     'https://www.sefaz.ap.gov.br/nfce/nfcep.php',
      urlConsulta:    'https://www.sefaz.ap.gov.br/nfce/consulta',
    },
  },
  // MG — SEFAZ própria (ver cabeçalho: fontes e flags).
  MG: {
    homologacao: {
      autorizacao:    'https://hnfce.fazenda.mg.gov.br/nfce/services/NFeAutorizacao4',
      retAutorizacao: 'https://hnfce.fazenda.mg.gov.br/nfce/services/NFeRetAutorizacao4',
      statusServico:  'https://hnfce.fazenda.mg.gov.br/nfce/services/NFeStatusServico4',
      consultaProtocolo: 'https://hnfce.fazenda.mg.gov.br/nfce/services/NFeConsultaProtocolo4',
      recepcaoEvento: 'https://hnfce.fazenda.mg.gov.br/nfce/services/NFeRecepcaoEvento4',
      inutilizacao:   'https://hnfce.fazenda.mg.gov.br/nfce/services/NFeInutilizacao4',
      qrCodeBase:     'https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml',
      urlConsulta:    'https://hportalsped.fazenda.mg.gov.br/portalnfce',
      soapAction:     true,
      infRespTec:     true,
    },
    producao: {
      autorizacao:    'https://nfce.fazenda.mg.gov.br/nfce/services/NFeAutorizacao4',
      retAutorizacao: 'https://nfce.fazenda.mg.gov.br/nfce/services/NFeRetAutorizacao4',
      statusServico:  'https://nfce.fazenda.mg.gov.br/nfce/services/NFeStatusServico4',
      consultaProtocolo: 'https://nfce.fazenda.mg.gov.br/nfce/services/NFeConsultaProtocolo4',
      recepcaoEvento: 'https://nfce.fazenda.mg.gov.br/nfce/services/NFeRecepcaoEvento4',
      inutilizacao:   'https://nfce.fazenda.mg.gov.br/nfce/services/NFeInutilizacao4',
      qrCodeBase:     'https://portalsped.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml',
      urlConsulta:    'https://portalsped.fazenda.mg.gov.br/portalnfce',
      soapAction:     true,
      infRespTec:     true,
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

// Operação do wsdl 4.00 por serviço — compõe o SOAPAction (mesmos nomes que
// o ACBr usa: ACBrNFeWebServices.pas, DefinirServicoEAction de cada serviço).
const SOAP_OPERATION = {
  autorizacao:       'nfeAutorizacaoLote',
  retAutorizacao:    'nfeRetAutorizacaoLote',
  statusServico:     'nfeStatusServicoNF',
  consultaProtocolo: 'nfeConsultaNF',
  recepcaoEvento:    'nfeRecepcaoEvento',
  inutilizacao:      'nfeInutilizacaoNF',
};

/**
 * SOAPAction do serviço p/ este conjunto de endpoints, ou null quando a UF
 * não liga a flag soapAction (SP/AP: nenhum header novo, como sempre foi).
 */
function soapActionFor(endpoints, service) {
  if (!endpoints || endpoints.soapAction !== true) return null;
  if (!WSDL_NS[service] || !SOAP_OPERATION[service]) {
    throw new Error(`sefazSp: serviço SOAP desconhecido (${service})`);
  }
  return `${WSDL_NS[service]}/${SOAP_OPERATION[service]}`;
}

/**
 * @param {'SP'|'AP'|'MG'} uf
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

module.exports = { getEndpoints, WSDL_NS, ENDPOINTS, SOAP_OPERATION, soapActionFor };
