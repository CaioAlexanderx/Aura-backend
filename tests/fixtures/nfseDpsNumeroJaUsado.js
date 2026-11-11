// ============================================================
// Fixture do incidente de 10/11/2026 (produção, Emissor Nacional da NFS-e):
// loja de São Paulo capital (IBGE 3550308), Simples Nacional.
//
//   * 22/10/2026 — a loja emitiu, por OUTRO emissor (verAplic
//     1.6.0+910FFC), a DPS série 1, número 1: R$ 25,00, "10 - IMPRESSÕES
//     COLORIDAS", cTribNac 130501. Virou a NFS-e nº 1.
//   * 10/11/2026 — a Aura montou a DPS da venda (carimbo, R$ 44,00,
//     cTribNac 240101) com a MESMA série 1 e o MESMO número 1, portanto o
//     MESMO Id de DPS. A consulta GET /dps/{Id} devolveu a NFS-e antiga.
//
// Valores e datas do incidente; CNPJ, chave e nomes são FICTÍCIOS (sem dado
// pessoal). O XML segue o leiaute NFSe_v1.01 (infNFSe/DPS obrigatória).
// ============================================================
'use strict';

const CNPJ = '11222333000181'; // fictício, dígitos válidos
const IBGE_SP = '3550308';
const ID_DPS_SERIE1_N1 = `DPS${IBGE_SP}2${CNPJ}${'1'.padStart(5, '0')}${'1'.padStart(15, '0')}`;
// chave de acesso fictícia de 50 dígitos (município + ambiente + CNPJ + ...)
const CHAVE_DO_OUTRO_EMISSOR = `${IBGE_SP}1${'2'}${CNPJ}${'1'.padStart(13, '0')}2610${'123456789'}1`;

/** A NFS-e ANTIGA (22/10) que o Sefin devolve para o Id da DPS série 1 nº 1. */
const NFSE_DO_OUTRO_EMISSOR = '<?xml version="1.0" encoding="UTF-8"?>'
  + '<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">'
  + `<infNFSe Id="NFS${CHAVE_DO_OUTRO_EMISSOR}">`
  + '<xLocEmi>São Paulo</xLocEmi><xLocPrestacao>São Paulo</xLocPrestacao>'
  + '<nNFSe>1</nNFSe><cLocIncid>3550308</cLocIncid><xLocIncid>São Paulo</xLocIncid>'
  + '<xTribNac>Serviços de impressão</xTribNac>'
  + '<verAplic>1.6.0+910FFC</verAplic><ambGer>2</ambGer><tpEmis>1</tpEmis><procEmi>2</procEmi>'
  + '<cStat>100</cStat><dhProc>2026-10-22T14:31:07-03:00</dhProc><nDFSe>1</nDFSe>'
  + `<emit><CNPJ>${CNPJ}</CNPJ><xNome>LOJA FICTICIA LTDA</xNome></emit>`
  + '<valores><vBC>25.00</vBC><vLiq>25.00</vLiq></valores>'
  + '<DPS versao="1.01">'
  + `<infDPS Id="${ID_DPS_SERIE1_N1}">`
  + '<tpAmb>1</tpAmb><dhEmi>2026-10-22T14:30:52-03:00</dhEmi><verAplic>1.6.0+910FFC</verAplic>'
  + '<serie>1</serie><nDPS>1</nDPS><dCompet>2026-10-22</dCompet><tpEmit>1</tpEmit>'
  + `<cLocEmi>${IBGE_SP}</cLocEmi>`
  + `<prest><CNPJ>${CNPJ}</CNPJ><regTrib><opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN><regEspTrib>0</regEspTrib></regTrib></prest>`
  + '<serv><locPrest><cLocPrestacao>3550308</cLocPrestacao></locPrest>'
  + '<cServ><cTribNac>130501</cTribNac><xDescServ>10 - IMPRESSÕES COLORIDAS</xDescServ></cServ></serv>'
  + '<valores><vServPrest><vServ>25.00</vServ></vServPrest>'
  + '<trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun><totTrib><pTotTribSN>6.00</pTotTribSN></totTrib></trib>'
  + '</valores></infDPS></DPS>'
  + '</infNFSe></NFSe>';

/**
 * A MESMA NFS-e antiga como ela está de verdade no banco de produção (lida
 * em 11/11/2026, só SELECT): gerada pelo emissor da PREFEITURA — ambGer 1
 * (ambiente gerador = prefeitura) e tpEmis 2 —, não pelo Emissor Nacional.
 * Mesma série 1, nº 1, R$ 25,00, cTribNac 130501; a DPS embutida não tem
 * assinatura (a conferência é campo a campo). dhEmi/dhProc da nota real.
 */
const NFSE_DA_PREFEITURA = NFSE_DO_OUTRO_EMISSOR
  .replace('<ambGer>2</ambGer><tpEmis>1</tpEmis><procEmi>2</procEmi>', '<ambGer>1</ambGer><tpEmis>2</tpEmis>')
  .replace('<dhProc>2026-10-22T14:31:07-03:00</dhProc>', '<dhProc>2026-10-22T15:47:57-03:00</dhProc>')
  .replace('<dhEmi>2026-10-22T14:30:52-03:00</dhEmi>', '<dhEmi>2026-10-22T15:47:57-03:00</dhEmi>');

/**
 * A DPS que a Aura assinou para a venda de 10/11 (série 1, nº 1, R$ 44,00,
 * cTribNac 240101) — o nfse.xml_dps da linha. Assinatura fictícia: só o
 * DigestValue importa para a conferência.
 */
const DPS_DA_AURA_SERIE1_N1 = '<?xml version="1.0" encoding="UTF-8"?>'
  + '<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">'
  + `<infDPS Id="${ID_DPS_SERIE1_N1}">`
  + '<tpAmb>1</tpAmb><dhEmi>2026-11-10T19:15:22-03:00</dhEmi><verAplic>Aura-1.0</verAplic>'
  + '<serie>1</serie><nDPS>1</nDPS><dCompet>2026-11-10</dCompet><tpEmit>1</tpEmit>'
  + `<cLocEmi>${IBGE_SP}</cLocEmi>`
  + `<prest><CNPJ>${CNPJ}</CNPJ><regTrib><opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN><regEspTrib>0</regEspTrib></regTrib></prest>`
  + '<serv><locPrest><cLocPrestacao>3550308</cLocPrestacao></locPrest>'
  + '<cServ><cTribNac>240101</cTribNac><xDescServ>Carimbo</xDescServ></cServ></serv>'
  + '<valores><vServPrest><vServ>44.00</vServ></vServPrest></valores></infDPS>'
  + '<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo>'
  + `<Reference URI="#${ID_DPS_SERIE1_N1}"><DigestValue>QXVyYURpZ2VzdEZpY3RpY2lvU2VyaWUxTjE=</DigestValue></Reference>`
  + '</SignedInfo></Signature></DPS>';

/**
 * A linha do banco como o código antigo a deixou: a DPS série 1 nº 1 da
 * venda de R$ 44,00 ADOTOU a NFS-e de R$ 25,00 da prefeitura — status
 * 'autorizada', chave e número da nota alheia, evidência sobrescrita (o
 * provider_response só com o cabeçalho da "recuperação"). É o estado real
 * de produção em 11/11/2026 (ids e CNPJ fictícios).
 */
function linhaAdotada(over = {}) {
  return {
    id: 'nota-adotada', company_id: 'loja-sp', provider: 'nacional', status: 'autorizada', ambiente: 'producao',
    source_type: 'pdv_sale', idempotency_key: 'aura-auto-venda-v1-240101-1', idempotency_fingerprint: null,
    dps_serie: '1', dps_number: '1', dps_id: ID_DPS_SERIE1_N1,
    chave_acesso: CHAVE_DO_OUTRO_EMISSOR, nfse_number: '1', service_amount: '44.00',
    issued_at: '2026-10-22T18:47:57Z', transmitted_at: '2026-11-10T22:16:24Z',
    xml_dps: DPS_DA_AURA_SERIE1_N1, xml_nfse: NFSE_DA_PREFEITURA, dps_dados: null,
    error_codes: null, rejection_reason: null, cancel_event_xml: null,
    provider_response: { cStat: '100', alertas: [], cabecalho: { recuperada_por: 'consulta_dps' } },
    ...over,
  };
}

/** A venda de 10/11 que a Aura mandou com a série 1 e o número 1. */
const VENDA_DA_AURA = Object.freeze({
  descricao: 'Carimbo',
  valor: 44,
  competencia: '2026-11-10',
  ctribnac: '240101',
});

module.exports = {
  CNPJ, IBGE_SP, ID_DPS_SERIE1_N1, CHAVE_DO_OUTRO_EMISSOR, NFSE_DO_OUTRO_EMISSOR, VENDA_DA_AURA,
  NFSE_DA_PREFEITURA, DPS_DA_AURA_SERIE1_N1, linhaAdotada,
};
