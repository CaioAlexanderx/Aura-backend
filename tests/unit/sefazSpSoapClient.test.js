const sc = require('../../src/services/sefazSp/soapClient');
const { getEndpoints, WSDL_NS } = require('../../src/services/sefazSp/endpoints');

const CHAVE = '35260611222333000181650010000002311123456786';

// ---------- fixtures de resposta SEFAZ (mock SOAP) ----------

function soapWrap(inner) {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body>'
    + '<nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">'
    + inner
    + '</nfeResultMsg></soap:Body></soap:Envelope>';
}

const RET_AUTORIZADA = soapWrap(
  '<retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">'
  + '<tpAmb>2</tpAmb><verAplic>SP_NFCE_PL009</verAplic><cStat>104</cStat>'
  + '<xMotivo>Lote processado</xMotivo><cUF>35</cUF>'
  + `<protNFe versao="4.00"><infProt><tpAmb>2</tpAmb><verAplic>SP_NFCE_PL009</verAplic><chNFe>${CHAVE}</chNFe>`
  + '<dhRecbto>2026-06-10T10:00:05-03:00</dhRecbto><nProt>135260000000001</nProt>'
  + '<digVal>abc=</digVal><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>'
  + '</retEnviNFe>'
);

const RET_REJEITADA_539 = soapWrap(
  '<retEnviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">'
  + '<tpAmb>2</tpAmb><cStat>104</cStat><xMotivo>Lote processado</xMotivo><cUF>35</cUF>'
  + `<protNFe versao="4.00"><infProt><chNFe>${CHAVE}</chNFe><cStat>539</cStat>`
  + '<xMotivo>Rejeicao: Duplicidade de NF-e com diferenca na Chave de Acesso</xMotivo></infProt></protNFe>'
  + '</retEnviNFe>'
);

const RET_STATUS_OK = soapWrap(
  '<retConsStatServ xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">'
  + '<tpAmb>2</tpAmb><cStat>107</cStat><xMotivo>Servico em Operacao</xMotivo>'
  + '<dhRecbto>2026-06-10T10:00:00-03:00</dhRecbto><tMed>1</tMed></retConsStatServ>'
);

const RET_CONSULTA_AUTORIZADA = soapWrap(
  '<retConsSitNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">'
  + '<tpAmb>2</tpAmb><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo>'
  + `<protNFe versao="4.00"><infProt><chNFe>${CHAVE}</chNFe><nProt>135260000000001</nProt>`
  + '<dhRecbto>2026-06-10T10:00:05-03:00</dhRecbto><cStat>100</cStat></infProt></protNFe>'
  + '</retConsSitNFe>'
);

const RET_CONSULTA_NAO_CONSTA = soapWrap(
  '<retConsSitNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">'
  + '<tpAmb>2</tpAmb><cStat>217</cStat><xMotivo>NF-e nao consta na base de dados da SEFAZ</xMotivo></retConsSitNFe>'
);

function mockTransport(responses) {
  const calls = [];
  let i = 0;
  const fn = async (url, envelope) => {
    calls.push({ url, envelope });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}

const NFE_FAKE = '<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe' + CHAVE + '"/></NFe>';

describe('sefazSp/endpoints', () => {
  test('homolog/produção SP e namespaces wsdl', () => {
    const h = getEndpoints('SP', 2);
    const p = getEndpoints('SP', 'producao');
    expect(h.autorizacao).toContain('homologacao.nfce.fazenda.sp.gov.br');
    expect(p.autorizacao).toContain('https://nfce.fazenda.sp.gov.br');
    expect(WSDL_NS.autorizacao).toContain('NFeAutorizacao4');
  });

  test('UF fora do escopo rejeita com orientação de gateway', () => {
    expect(() => getEndpoints('RJ', 2)).toThrow(/escopo: SP/);
  });
});

describe('sefazSp/soapClient — autorização síncrona', () => {
  test('nota autorizada: cStat 100, protocolo extraído', async () => {
    const transport = mockTransport([{ status: 200, body: RET_AUTORIZADA }]);
    const r = await sc.autorizar({ signedNfeXml: NFE_FAKE, idLote: '1', tpAmb: 2, transport });
    expect(r.autorizada).toBe(true);
    expect(r.cStat).toBe('100');
    expect(r.protocolo).toBe('135260000000001');
    expect(r.chNFe).toBe(CHAVE);
    // envelope SOAP 1.2 com indSinc=1 e NFe embutida
    expect(transport.calls[0].envelope).toContain('<indSinc>1</indSinc>');
    expect(transport.calls[0].envelope).toContain('soap12:Envelope');
    expect(transport.calls[0].envelope).toContain(NFE_FAKE);
  });

  test('rejeição 539: rejeitada=true com cStat/xMotivo preservados', async () => {
    const transport = mockTransport([{ status: 200, body: RET_REJEITADA_539 }]);
    const r = await sc.autorizar({ signedNfeXml: NFE_FAKE, tpAmb: 2, transport });
    expect(r.autorizada).toBe(false);
    expect(r.rejeitada).toBe(true);
    expect(r.cStat).toBe('539');
    expect(r.xMotivo).toContain('Duplicidade');
  });

  test('timeout na autorização: erro AMBÍGUO, sem retry automático', async () => {
    const transport = mockTransport([new Error('timeout após 30000ms')]);
    await expect(sc.autorizar({ signedNfeXml: NFE_FAKE, tpAmb: 2, transport }))
      .rejects.toMatchObject({ name: 'SefazTransportError', ambiguous: true });
    expect(transport.calls.length).toBe(1); // UMA tentativa — nunca reenvia sozinho
  });

  test('HTML de proxy (502) não é parseado como autorização: erro ambíguo', async () => {
    const transport = mockTransport([{ status: 502, body: '<html>Bad Gateway</html>' }]);
    await expect(sc.autorizar({ signedNfeXml: NFE_FAKE, tpAmb: 2, transport }))
      .rejects.toMatchObject({ ambiguous: true, httpStatus: 502 });
  });

  test('200 com corpo não-SOAP: erro ambíguo', async () => {
    const transport = mockTransport([{ status: 200, body: '<html>manutencao</html>' }]);
    await expect(sc.autorizar({ signedNfeXml: NFE_FAKE, tpAmb: 2, transport }))
      .rejects.toMatchObject({ ambiguous: true });
  });
});

describe('sefazSp/soapClient — status e consulta (idempotentes, com retry)', () => {
  test('status 107 = online', async () => {
    const transport = mockTransport([{ status: 200, body: RET_STATUS_OK }]);
    const r = await sc.statusServico({ tpAmb: 2, transport });
    expect(r.online).toBe(true);
    expect(r.cStat).toBe('107');
    expect(r.tMed).toBe(1);
  });

  test('status com falha transitória: retry até sucesso', async () => {
    const transport = mockTransport([
      new Error('ECONNRESET'),
      { status: 200, body: RET_STATUS_OK },
    ]);
    const r = await sc.statusServico({ tpAmb: 2, transport });
    expect(r.online).toBe(true);
    expect(transport.calls.length).toBe(2);
  });

  test('consulta por chave resolve timeout ambíguo: autorizada', async () => {
    const transport = mockTransport([{ status: 200, body: RET_CONSULTA_AUTORIZADA }]);
    const r = await sc.consultarChave({ chave: CHAVE, tpAmb: 2, transport });
    expect(r.autorizada).toBe(true);
    expect(r.protocolo).toBe('135260000000001');
  });

  test('consulta 217 (não consta): seguro retransmitir MESMO número', async () => {
    const transport = mockTransport([{ status: 200, body: RET_CONSULTA_NAO_CONSTA }]);
    const r = await sc.consultarChave({ chave: CHAVE, tpAmb: 2, transport });
    expect(r.autorizada).toBe(false);
    expect(r.naoConsta).toBe(true);
  });

  test('chave inválida rejeitada localmente', async () => {
    await expect(sc.consultarChave({ chave: '123', tpAmb: 2 })).rejects.toThrow(/44 dígitos/);
  });
});
