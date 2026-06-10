const { buildComparable, diffNotas } = require('../../src/services/sefazSp/shadowDiff');
const xb = require('../../src/services/sefazSp/xmlBuilder');
const { companyDavi, nfceDataVendaTipica } = require('../fixtures/nfceDavi');

// XML "do gateway": mesmo conteúdo fiscal, embalagem nfeProc, emitente e
// chave DIFERENTES (como no shadow real: emitente é a empresa de teste).
function gatewayXml({ ncm1 = '64022000', vNF = '549.96', tPagExtra = null } = {}) {
  return `<?xml version="1.0"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><NFe><infNFe Id="NFe35260647123119000115650010000000991999999991" versao="4.00">
  <ide><cUF>35</cUF><cNF>99999999</cNF><natOp>Venda ao consumidor</natOp><mod>65</mod><serie>1</serie><nNF>99</nNF><dhEmi>2026-05-01T09:00:00-03:00</dhEmi><tpNF>1</tpNF><idDest>1</idDest><cMunFG>3524402</cMunFG><tpImp>4</tpImp><tpEmis>1</tpEmis><cDV>1</cDV><tpAmb>1</tpAmb><finNFe>1</finNFe><indFinal>1</indFinal><indPres>1</indPres><procEmi>0</procEmi><verProc>NuvemFiscal</verProc></ide>
  <emit><CNPJ>47123119000115</CNPJ><xNome>OUTRA RAZAO SOCIAL</xNome><enderEmit><xLgr>Outra rua</xLgr><nro>1</nro><xBairro>B</xBairro><cMun>3550308</cMun><xMun>Sao Paulo</xMun><UF>SP</UF><CEP>01000000</CEP><cPais>1058</cPais><xPais>Brasil</xPais></enderEmit><IE>999</IE><CRT>1</CRT></emit>
  <dest><CPF>39053344705</CPF><xNome>QUALQUER</xNome><indIEDest>9</indIEDest></dest>
  <det nItem="1"><prod><cProd>a1</cProd><cEAN>SEM GTIN</cEAN><xProd>Azaleia Rasteirinha Amarelo</xProd><NCM>${ncm1}</NCM><CFOP>5102</CFOP><uCom>PAR</uCom><qCom>1</qCom><vUnCom>89.99</vUnCom><vProd>89.99</vProd><cEANTrib>SEM GTIN</cEANTrib><uTrib>PAR</uTrib><qTrib>1</qTrib><vUnTrib>89.99</vUnTrib><indTot>1</indTot></prod><imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS><PIS><PISNT><CST>07</CST></PISNT></PIS><COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS></imposto></det>
  <det nItem="2"><prod><cProd>b2</cProd><cEAN>SEM GTIN</cEAN><xProd>Activita Tenis</xProd><NCM>64041100</NCM><CFOP>5102</CFOP><uCom>PAR</uCom><qCom>2</qCom><vUnCom>159.99</vUnCom><vProd>319.98</vProd><cEANTrib>SEM GTIN</cEANTrib><uTrib>PAR</uTrib><qTrib>2</qTrib><vUnTrib>159.99</vUnTrib><vDesc>10.00</vDesc><indTot>1</indTot></prod><imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS><PIS><PISNT><CST>07</CST></PISNT></PIS><COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS></imposto></det>
  <det nItem="3"><prod><cProd>c3</cProd><cEAN>SEM GTIN</cEAN><xProd>Bolsa Arezzo</xProd><NCM>42029220</NCM><CFOP>5102</CFOP><uCom>UN</uCom><qCom>1</qCom><vUnCom>149.99</vUnCom><vProd>149.99</vProd><cEANTrib>SEM GTIN</cEANTrib><uTrib>UN</uTrib><qTrib>1</qTrib><vUnTrib>149.99</vUnTrib><indTot>1</indTot></prod><imposto><ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS><PIS><PISNT><CST>07</CST></PISNT></PIS><COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS></imposto></det>
  <total><ICMSTot><vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet><vProd>559.96</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>10.00</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro><vNF>${vNF}</vNF></ICMSTot></total>
  <transp><modFrete>9</modFrete></transp>
  <pag><detPag><indPag>0</indPag><tPag>99</tPag><xPag>PIX</xPag><vPag>300.00</vPag></detPag><detPag><indPag>0</indPag><tPag>01</tPag><vPag>150.00</vPag></detPag><detPag><indPag>1</indPag><tPag>05</tPag><vPag>99.96</vPag></detPag>${tPagExtra || ''}<vTroco>0.04</vTroco></pag>
  </infNFe></NFe><protNFe><infProt><cStat>100</cStat></infProt></protNFe></nfeProc>`;
}

function ownXml() {
  const built = xb.buildInfNfe(companyDavi, nfceDataVendaTipica,
    { tpAmb: 2, cNF: '12345678', dhEmi: '2026-06-10T10:00:00-03:00' });
  return xb.composeNfe({ signedInfNfeXml: built.infNfeXml, signatureXml: '<Signature/>' });
}

describe('S2.6 — shadowDiff', () => {
  test('mesma venda: própria ≡ gateway (ignora chave/emitente/dhEmi/QR/tpAmb)', () => {
    const { igual, diffs } = diffNotas(ownXml(), gatewayXml());
    expect(diffs).toEqual([]);
    expect(igual).toBe(true);
  });

  test('NCM divergente é apontado campo a campo', () => {
    const { igual, diffs } = diffNotas(ownXml(), gatewayXml({ ncm1: '64029990' }));
    expect(igual).toBe(false);
    expect(diffs.some((d) => d.includes('det[1].ncm') && d.includes('64029990'))).toBe(true);
  });

  test('vNF divergente é apontado', () => {
    const { diffs } = diffNotas(ownXml(), gatewayXml({ vNF: '500.00' }));
    expect(diffs.some((d) => d.includes('ICMSTot.vNF'))).toBe(true);
  });

  test('forma de pagamento extra no gateway é apontada', () => {
    const { diffs } = diffNotas(ownXml(), gatewayXml({
      tPagExtra: '<detPag><indPag>0</indPag><tPag>03</tPag><vPag>1.00</vPag></detPag>',
    }));
    expect(diffs.some((d) => d.startsWith('pag:'))).toBe(true);
  });

  test('buildComparable extrai CSOSN/crediário/troco', () => {
    const c = buildComparable(gatewayXml());
    expect(c.itens[0].csosn).toBe('102');
    expect(c.pagamentos.find((p) => p.tPag === '05').indPag).toBe('1');
    expect(c.vTroco).toBe(0.04);
    expect(c.destDoc).toBe('39053344705');
  });
});
