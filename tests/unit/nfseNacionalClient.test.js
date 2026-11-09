// ============================================================
// NFS-e Nacional — cliente REST do Sefin/ADN com respostas SIMULADAS.
// Mapeamento de status (manual + OpenAPI da produção restrita):
//   201 → autorizada | 400 → rejeitada (com erros) | 401/403 → recusada
//   500, 502 HTML, timeout, rede → ambíguo (consultar antes de reenviar)
// GETs com retry curto; POSTs uma tentativa só.
// ============================================================
'use strict';

const zlib = require('zlib');
const c = require('../../src/services/nfseNacional/client');
const { NfseNacionalTransportError } = require('../../src/services/nfseNacional/errors');
const { getEndpoints, normalizarAmbiente } = require('../../src/services/nfseNacional/endpoints');

const SEFIN = 'https://sefin.producaorestrita.nfse.gov.br/SefinNacional';
const gz = (s) => zlib.gzipSync(Buffer.from(s, 'utf8')).toString('base64');
const json = (status, body) => async () => ({ status, headers: {}, body: Buffer.from(JSON.stringify(body)) });
const semRetry = { attempts: 1, baseDelayMs: 0 };

describe('gzip + base64', () => {
  test('ida e volta preservam UTF-8', () => {
    const xml = '<DPS>Licença ção</DPS>';
    expect(c.gunzipB64(c.gzipB64(xml))).toBe(xml);
  });
});

describe('endpoints', () => {
  test('só "producao" é produção; o resto é produção restrita', () => {
    expect(normalizarAmbiente('producao')).toBe('producao');
    for (const v of ['homologacao', 'producao_restrita', null, '', 'PRODUCAO_RESTRITA']) expect(normalizarAmbiente(v)).toBe('producao_restrita');
    expect(getEndpoints('producao')).toMatchObject({ tpAmb: 1, sefin: 'https://sefin.nfse.gov.br/SefinNacional', danfse: 'https://adn.nfse.gov.br/danfse' });
    expect(getEndpoints(null)).toMatchObject({ tpAmb: 2, sefin: SEFIN, danfse: 'https://adn.producaorestrita.nfse.gov.br/danfse' });
  });
});

describe('enviarDps', () => {
  test('201: devolve chave e XML descompactado; corpo enviado é { dpsXmlGZipB64 }', async () => {
    const transport = jest.fn(json(201, { chaveAcesso: '1'.repeat(50), idDps: 'DPSx', nfseXmlGZipB64: gz('<NFSe/>'), alertas: [{ codigo: 'A1', descricao: 'aviso' }] }));
    const r = await c.enviarDps({ sefinUrl: SEFIN, signedXml: '<DPS/>', transport });
    expect(r).toMatchObject({ kind: 'autorizada', chaveAcesso: '1'.repeat(50), nfseXml: '<NFSe/>' });
    expect(r.alertas[0].codigo).toBe('A1');
    const req = transport.mock.calls[0][0];
    expect(req).toMatchObject({ method: 'POST', url: `${SEFIN}/nfse` });
    expect(Object.keys(req.body)).toEqual(['dpsXmlGZipB64']);
    expect(c.gunzipB64(req.body.dpsXmlGZipB64)).toBe('<DPS/>');
  });

  test('400: rejeitada, erros normalizados (aceita Codigo/Descricao em PascalCase)', async () => {
    const r = await c.enviarDps({ sefinUrl: SEFIN, signedXml: '<DPS/>', transport: json(400, { idDPS: 'DPSx', erros: [{ Codigo: 'E0004', Descricao: 'Id difere', Complemento: 'x' }] }) });
    expect(r).toEqual({ kind: 'rejeitada', httpStatus: 400, idDps: 'DPSx', erros: [{ codigo: 'E0004', descricao: 'Id difere', complemento: 'x' }], cabecalho: { tipoAmbiente: null, versaoAplicativo: null, dataHoraProcessamento: null } });
  });

  test('403: recusada (certificado da conexão), não é ambíguo', async () => {
    const r = await c.enviarDps({ sefinUrl: SEFIN, signedXml: '<DPS/>', transport: json(403, { erros: [{ codigo: 'E1200' }] }) });
    expect(r.kind).toBe('recusada');
  });

  test.each([
    ['500 com corpo', json(500, { erros: [{ codigo: 'E999' }] })],
    ['502 HTML do proxy', async () => ({ status: 502, headers: {}, body: Buffer.from('<html>Bad gateway</html>') })],
    ['201 sem XML', json(201, { chaveAcesso: '1'.repeat(50) })],
    ['timeout', async () => { throw new Error('timeout após 30000ms'); }],
  ])('%s → NfseNacionalTransportError ambíguo', async (_n, transport) => {
    let err;
    try { await c.enviarDps({ sefinUrl: SEFIN, signedXml: '<DPS/>', transport }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(NfseNacionalTransportError);
    expect(err.ambiguous).toBe(true);
  });

  test('POST nunca repete sozinho', async () => {
    const transport = jest.fn(async () => { throw new Error('ECONNRESET'); });
    await expect(c.enviarDps({ sefinUrl: SEFIN, signedXml: '<DPS/>', transport })).rejects.toBeInstanceOf(NfseNacionalTransportError);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe('mTLS de verdade (servidor HTTPS local que exige certificado de cliente)', () => {
  const https = require('https');
  const forge = require('node-forge');
  const { gerarA1 } = require('../helpers/certA1Teste');

  function certServidor() {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const crt = forge.pki.createCertificate();
    crt.publicKey = keys.publicKey;
    crt.serialNumber = '01';
    crt.validity.notBefore = new Date(Date.now() - 864e5);
    crt.validity.notAfter = new Date(Date.now() + 864e5);
    const attrs = [{ name: 'commonName', value: 'localhost' }];
    crt.setSubject(attrs);
    crt.setIssuer(attrs);
    crt.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }]);
    crt.sign(keys.privateKey, forge.md.sha256.create());
    return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(crt) };
  }

  let server;
  let port;
  let srv;
  const vistos = [];
  beforeAll(async () => {
    srv = certServidor();
    server = https.createServer({ key: srv.key, cert: srv.cert, requestCert: true, rejectUnauthorized: false }, (req, res) => {
      const peer = req.socket.getPeerCertificate();
      let corpo = '';
      req.on('data', (d) => { corpo += d; });
      req.on('end', () => {
        vistos.push({ cn: peer && peer.subject ? peer.subject.CN : null, path: req.url, corpo, ct: req.headers['content-type'] });
        if (!peer || !peer.subject) { res.writeHead(403); return res.end('{}'); }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ chaveAcesso: '7'.repeat(50), nfseXmlGZipB64: gz('<NFSe/>') }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  test('o A1 da empresa vai no handshake TLS e o JSON chega como application/json', async () => {
    const a1 = gerarA1();
    const resp = await c.httpsRequest({
      method: 'POST', url: `https://localhost:${port}/SefinNacional/nfse`,
      body: { dpsXmlGZipB64: gz('<DPS/>') }, pfx: a1.pfx, passphrase: a1.senha, ca: [srv.cert], timeoutMs: 5000,
    });
    expect(resp.status).toBe(201);
    const visto = vistos[vistos.length - 1];
    expect(visto.cn).toBe(`EMPRESA TESTE LTDA:${a1.cnpj}`);
    expect(visto.ct).toMatch(/^application\/json/);
    expect(JSON.parse(visto.corpo)).toHaveProperty('dpsXmlGZipB64');
  });
});

describe('consultas', () => {
  test('GET /dps/{id}: 200 → chave; 404 → não encontrada', async () => {
    expect(await c.consultarDps({ sefinUrl: SEFIN, idDps: 'DPS1', transport: json(200, { chaveAcesso: '2'.repeat(50) }), retry: semRetry }))
      .toEqual({ encontrada: true, chaveAcesso: '2'.repeat(50) });
    expect((await c.consultarDps({ sefinUrl: SEFIN, idDps: 'DPS1', transport: json(404, { erro: { codigo: 'E2404' } }), retry: semRetry })).encontrada).toBe(false);
  });

  test('GET repete em falha transitória (idempotente)', async () => {
    let n = 0;
    const transport = jest.fn(async () => { n += 1; if (n < 3) throw new Error('ECONNRESET'); return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ chaveAcesso: '3'.repeat(50) })) }; });
    const r = await c.consultarDps({ sefinUrl: SEFIN, idDps: 'DPS1', transport, retry: { attempts: 3, baseDelayMs: 0 } });
    expect(r.encontrada).toBe(true);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  test('GET /nfse/{chave}: 200 → XML; 404 → null', async () => {
    const r = await c.consultarNfse({ sefinUrl: SEFIN, chave: '4'.repeat(50), transport: json(200, { chaveAcesso: '4'.repeat(50), nfseXmlGZipB64: gz('<NFSe>x</NFSe>') }), retry: semRetry });
    expect(r.nfseXml).toBe('<NFSe>x</NFSe>');
    expect(await c.consultarNfse({ sefinUrl: SEFIN, chave: '4'.repeat(50), transport: json(404, {}), retry: semRetry })).toBeNull();
  });

  test('evento: 201 registrado; 400 rejeitado (ResponseErro com erro{} único)', async () => {
    const ok = await c.enviarEvento({ sefinUrl: SEFIN, chave: '5'.repeat(50), signedXml: '<pedRegEvento/>', transport: json(201, { eventoXmlGZipB64: gz('<evento/>') }) });
    expect(ok).toMatchObject({ kind: 'registrado', eventoXml: '<evento/>' });
    const no = await c.enviarEvento({ sefinUrl: SEFIN, chave: '5'.repeat(50), signedXml: '<pedRegEvento/>', transport: json(400, { erro: { codigo: 'E1830', descricao: 'Evento já existe' } }) });
    expect(no).toMatchObject({ kind: 'rejeitado', erros: [{ codigo: 'E1830' }] });
  });

  test('DANFSe: só aceita PDF de verdade', async () => {
    const pdf = await c.baixarDanfse({ danfseUrl: 'https://adn.producaorestrita.nfse.gov.br/danfse', chave: '6'.repeat(50), transport: async () => ({ status: 200, headers: {}, body: Buffer.from('%PDF-1.7') }), retry: semRetry });
    expect(pdf.toString()).toBe('%PDF-1.7');
    await expect(c.baixarDanfse({ danfseUrl: 'https://x/danfse', chave: '6'.repeat(50), transport: async () => ({ status: 200, headers: {}, body: Buffer.from('<html/>') }), retry: semRetry }))
      .rejects.toBeInstanceOf(NfseNacionalTransportError);
  });
});
