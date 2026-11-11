// ============================================================
// Fixture do DANFSe gerado pela Aura (11/11/2026): uma NFS-e nacional
// AUTORIZADA no leiaute NFSe_v1.01 (infNFSe + DPS embutida), emitida por
// ME/EPP do Simples Nacional em Jacareí-SP, com tomador.
//
// Tudo FICTÍCIO: CNPJ e CPF de teste (dígitos válidos), nomes inventados,
// chave de acesso montada à mão. Nenhum dado de cliente.
// ============================================================
'use strict';

const CNPJ = '11222333000181';
const CPF_TOMADOR = '52998224725';
const IBGE = '3524402'; // Jacareí-SP
const CHAVE = `${IBGE}1${'2'}${CNPJ}${'15'.padStart(13, '0')}2611${'123456789'}7`;
const ID_DPS = `DPS${IBGE}2${CNPJ}${'3'.padStart(5, '0')}${'15'.padStart(15, '0')}`;

const INF_DPS = `<infDPS Id="${ID_DPS}">`
  + '<tpAmb>1</tpAmb><dhEmi>2026-11-11T09:41:12-03:00</dhEmi><verAplic>Aura-1.0</verAplic>'
  + '<serie>3</serie><nDPS>15</nDPS><dCompet>2026-11-11</dCompet><tpEmit>1</tpEmit>'
  + `<cLocEmi>${IBGE}</cLocEmi>`
  + `<prest><CNPJ>${CNPJ}</CNPJ><IM>123456</IM>`
  + '<regTrib><opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN><regEspTrib>0</regEspTrib></regTrib></prest>'
  + `<toma><CPF>${CPF_TOMADOR}</CPF><xNome>CLIENTE FICTICIO DE TESTE</xNome>`
  + '<end><endNac><cMun>3549904</cMun><CEP>12245000</CEP></endNac>'
  + '<xLgr>Rua Imaginaria</xLgr><nro>100</nro><xBairro>Centro</xBairro></end>'
  + '<email>cliente@exemplo.test</email></toma>'
  + `<serv><locPrest><cLocPrestacao>${IBGE}</cLocPrestacao></locPrest>`
  + '<cServ><cTribNac>140101</cTribNac><xDescServ>Manutenção preventiva de equipamento &amp; limpeza</xDescServ><cNBS>120012100</cNBS></cServ>'
  + '<infoCompl><xInfComp>Pedido interno 77</xInfComp></infoCompl></serv>'
  + '<valores><vServPrest><vServ>150.00</vServ></vServPrest>'
  + '<trib><tribMun><tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN></tribMun>'
  + '<totTrib><pTotTribSN>6.00</pTotTribSN></totTrib></trib></valores>'
  + '</infDPS>';

/** A DPS que a Aura gravou em nfse.xml_dps (sem assinatura: conferência campo a campo). */
const XML_DPS = '<?xml version="1.0" encoding="UTF-8"?>'
  + `<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">${INF_DPS}</DPS>`;

/** A NFS-e autorizada gravada em nfse.xml_nfse. */
function nfseXml({ descricao, nomeEmitente, tpAmb } = {}) {
  let dps = INF_DPS;
  if (descricao != null) dps = dps.replace(/<xDescServ>[^<]*<\/xDescServ>/, `<xDescServ>${descricao}</xDescServ>`);
  if (tpAmb != null) dps = dps.replace('<tpAmb>1</tpAmb>', `<tpAmb>${tpAmb}</tpAmb>`);
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">'
    + `<infNFSe Id="NFS${CHAVE}">`
    + '<xLocEmi>Jacareí</xLocEmi><xLocPrestacao>Jacareí</xLocPrestacao>'
    + `<nNFSe>15</nNFSe><cLocIncid>${IBGE}</cLocIncid><xLocIncid>Jacareí</xLocIncid>`
    + '<xTribNac>Lubrificação, limpeza, lustração, revisão, carga e recarga, conserto, restauração</xTribNac>'
    + '<xNBS>Serviços de manutenção e reparação</xNBS>'
    + '<verAplic>SefinNac_1.4.0</verAplic><ambGer>2</ambGer><tpEmis>1</tpEmis><procEmi>1</procEmi>'
    + '<cStat>100</cStat><dhProc>2026-11-11T09:41:15-03:00</dhProc><nDFSe>987</nDFSe>'
    + `<emit><CNPJ>${CNPJ}</CNPJ><IM>123456</IM><xNome>${nomeEmitente || 'EMPRESA FICTICIA DE SERVICOS LTDA'}</xNome>`
    + `<enderNac><xLgr>Avenida de Teste</xLgr><nro>200</nro><xCpl>Sala 3</xCpl><xBairro>Jardim Exemplo</xBairro><cMun>${IBGE}</cMun><UF>SP</UF><CEP>12300000</CEP></enderNac>`
    + '<fone>12999990000</fone><email>contato@exemplo.test</email></emit>'
    + '<valores><vBC>150.00</vBC><pAliqAplic>2.00</pAliqAplic><vISSQN>3.00</vISSQN><vTotalRet>0.00</vTotalRet><vLiq>150.00</vLiq></valores>'
    + `<DPS versao="1.01">${dps}</DPS>`
    + '</infNFSe></NFSe>';
}

/** Linha da tabela nfse como repo.buscarPorId devolve. */
function linhaAutorizada(over = {}) {
  return {
    id: 'nfse-danfse-1', company_id: 'loja-teste', status: 'autorizada', provider: 'nacional',
    ambiente: 'producao', chave_acesso: CHAVE, nfse_number: '15', dps_serie: '3', dps_number: '15',
    dps_id: ID_DPS, transmitted_at: '2026-11-11T12:41:12Z', issued_at: '2026-11-11T12:41:15Z',
    xml_dps: XML_DPS, xml_nfse: nfseXml(), error_codes: null, rejection_reason: null,
    ...over,
  };
}

module.exports = { CNPJ, CPF_TOMADOR, IBGE, CHAVE, ID_DPS, XML_DPS, nfseXml, linhaAutorizada };
