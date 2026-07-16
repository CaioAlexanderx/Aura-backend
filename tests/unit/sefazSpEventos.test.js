const crypto = require('crypto');
const forge = require('node-forge');

process.env.CERT_MASTER_KEY = crypto.randomBytes(32).toString('hex');

const eventos = require('../../src/services/sefazSp/eventos');
const { getEndpoints } = require('../../src/services/sefazSp/endpoints');
const { verifyNfeSignature } = require('../../src/services/sefazSp/signer');

const CHAVE = '35260611222333000181650010000002311123456786';
const CNPJ = '11222333000181';
const JUST = 'Cancelamento por erro de digitacao no PDV da loja';
const ENDPOINTS = getEndpoints('SP', 2);

function makeCert() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '03';
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400e3);
  const attrs = [{ name: 'commonName', value: 'TESTE' }];
  cert.setSubject(attrs); cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certDerBase64: forge.util.encode64(der),
  };
}
const CERT = makeCert();

function soapWrap(inner) {
  return '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg>'
    + inner + '</nfeResultMsg></soap:Body></soap:Envelope>';
}

function retEvento(cStat, xMotivo) {
  return soapWrap(
    '<retEnvEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><idLote>1</idLote><tpAmb>2</tpAmb>'
    + '<cStat>128</cStat><xMotivo>Lote de evento processado</xMotivo>'
    + `<retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><cStat>${cStat}</cStat><xMotivo>${xMotivo}</xMotivo>`
    + `<chNFe>${CHAVE}</chNFe><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento>`
    + '<nProt>135260000000555</nProt><dhRegEvento>2026-06-10T10:20:00-03:00</dhRegEvento></infEvento></retEvento>'
    + '</retEnvEvento>'
  );
}

describe('S2.1 — infEvento de cancelamento', () => {
  test('Id = ID + 110111 + chave + seq(2); campos na ordem', () => {
    const { infEventoXml, idEvento } = eventos.buildInfEventoCancelamento({
      chave: CHAVE, cnpj: CNPJ, tpAmb: 2, protocolo: '135260000000001',
      justificativa: JUST, dhEvento: '2026-06-10T10:10:00-03:00',
    });
    expect(idEvento).toBe(`ID110111${CHAVE}01`);
    expect(infEventoXml).toContain(`Id="${idEvento}"`);
    expect(infEventoXml).toContain('<cOrgao>35</cOrgao>');
    expect(infEventoXml).toContain('<tpEvento>110111</tpEvento>');
    expect(infEventoXml).toContain('<descEvento>Cancelamento</descEvento>');
    expect(infEventoXml).toContain('<nProt>135260000000001</nProt>');
  });

  test('justificativa <15 ou >255 rejeita localmente', () => {
    const base = { chave: CHAVE, cnpj: CNPJ, tpAmb: 2, protocolo: 'x' };
    expect(() => eventos.buildInfEventoCancelamento({ ...base, justificativa: 'curta' }))
      .toThrow(/15 e 255/);
    expect(() => eventos.buildInfEventoCancelamento({ ...base, justificativa: 'y'.repeat(256) }))
      .toThrow(/15 e 255/);
  });

  test('cancelamento aceito (135): sucesso + protocolo do evento; evento assinado', async () => {
    let sentEnvelope;
    const transport = async (url, envelope) => {
      sentEnvelope = envelope;
      expect(url).toBe(ENDPOINTS.recepcaoEvento);
      return { status: 200, body: retEvento('135', 'Evento registrado e vinculado a NF-e') };
    };
    const r = await eventos.cancelarNfce({
      chave: CHAVE, cnpj: CNPJ, tpAmb: 2, protocolo: '135260000000001',
      justificativa: JUST, endpoints: ENDPOINTS, cert: CERT, transport,
    });
    expect(r.sucesso).toBe(true);
    expect(r.cStat).toBe('135');
    expect(r.protocoloEvento).toBe('135260000000555');
    // evento dentro do envelope está assinado e a assinatura confere
    const eventoXml = sentEnvelope.match(/<evento[\s\S]*<\/evento>/)[0];
    expect(eventoXml).toContain(`URI="#ID110111${CHAVE}01"`);
    expect(verifyNfeSignature(eventoXml).valid).toBe(true);
  });

  test('573 (duplicidade) = sucesso idempotente, sinalizado', async () => {
    const transport = async () => ({ status: 200, body: retEvento('573', 'Rejeicao: Duplicidade de Evento') });
    const r = await eventos.cancelarNfce({
      chave: CHAVE, cnpj: CNPJ, tpAmb: 2, protocolo: 'p', justificativa: JUST,
      endpoints: ENDPOINTS, cert: CERT, transport,
    });
    expect(r.sucesso).toBe(true);
    expect(r.jaCancelada).toBe(true);
  });

  test('501 (prazo expirado na SEFAZ): sucesso=false com motivo', async () => {
    const transport = async () => ({ status: 200, body: retEvento('501', 'Rejeicao: Pedido de Cancelamento intempestivo') });
    const r = await eventos.cancelarNfce({
      chave: CHAVE, cnpj: CNPJ, tpAmb: 2, protocolo: 'p', justificativa: JUST,
      endpoints: ENDPOINTS, cert: CERT, transport,
    });
    expect(r.sucesso).toBe(false);
    expect(r.cStat).toBe('501');
    expect(r.xMotivo).toContain('intempestivo');
  });
});

describe('S2.1 — inutilização de faixa', () => {
  test('Id = ID+35+ano+CNPJ+65+serie3+ini9+fin9 (41 chars após ID)', () => {
    const { idInut, infInutXml } = eventos.buildInfInut({
      tpAmb: 2, ano2: '26', cnpj: CNPJ, serie: 1, nIni: 105, nFin: 110, justificativa: JUST,
    });
    expect(idInut).toBe(`ID3526${CNPJ}65001000000105000000110`);
    expect(idInut.length).toBe(2 + 41);
    expect(infInutXml).toContain('<xServ>INUTILIZAR</xServ>');
    expect(infInutXml).toContain('<nNFIni>105</nNFIni>');
    expect(infInutXml).toContain('<nNFFin>110</nNFFin>');
  });

  test('faixa invertida rejeita localmente', () => {
    expect(() => eventos.buildInfInut({
      tpAmb: 2, cnpj: CNPJ, serie: 1, nIni: 10, nFin: 5, justificativa: JUST,
    })).toThrow(/faixa inválida/);
  });

  test('inutilização homologada (102) com infInut assinado', async () => {
    let sentEnvelope;
    const transport = async (url, envelope) => {
      sentEnvelope = envelope;
      expect(url).toBe(ENDPOINTS.inutilizacao);
      return {
        status: 200,
        body: soapWrap('<retInutNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><infInut>'
          + '<tpAmb>2</tpAmb><cStat>102</cStat><xMotivo>Inutilizacao de numero homologado</xMotivo>'
          + '<cUF>35</cUF><ano>26</ano><nProt>135260000000888</nProt></infInut></retInutNFe>'),
      };
    };
    const r = await eventos.inutilizar({
      tpAmb: 2, ano2: '26', cnpj: CNPJ, serie: 1, nIni: 105, nFin: 110,
      justificativa: JUST, endpoints: ENDPOINTS, cert: CERT, transport,
    });
    expect(r.sucesso).toBe(true);
    expect(r.protocolo).toBe('135260000000888');
    const inutXml = sentEnvelope.match(/<inutNFe[\s\S]*<\/inutNFe>/)[0];
    expect(verifyNfeSignature(inutXml).valid).toBe(true);
  });

  test('241/falha: sucesso=false', async () => {
    const transport = async () => ({
      status: 200,
      body: soapWrap('<retInutNFe xmlns="http://www.portalfiscal.inf.br/nfe"><infInut><cStat>241</cStat><xMotivo>Rejeicao: Um numero da faixa ja foi utilizado</xMotivo></infInut></retInutNFe>'),
    });
    const r = await eventos.inutilizar({
      tpAmb: 2, ano2: '26', cnpj: CNPJ, serie: 1, nIni: 1, nFin: 2,
      justificativa: JUST, endpoints: ENDPOINTS, cert: CERT, transport,
    });
    expect(r.sucesso).toBe(false);
    expect(r.cStat).toBe('241');
  });
});
