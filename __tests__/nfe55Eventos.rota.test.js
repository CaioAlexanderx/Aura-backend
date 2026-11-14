// ============================================================
// AURA. — Eventos da NF-e 55 (CP5, 14/11/2026)
//   POST /companies/:id/nfe55/:emissaoId/cancelar        (110111)
//   POST /companies/:id/nfe55/:emissaoId/carta-correcao  (110110)
//   GET  /companies/:id/nfe55/:emissaoId/carta-correcao/:seq/xml
//   GET  /companies/:id/nfe55/:emissaoId/eventos
//   POST /companies/:id/nfce/:nfceId/cancel  (55 → evento da 55; NFC-e igual)
// Banco falso; SOAP falso (soapClient.postSoap) que devolve o retEnvEvento;
// assinatura REAL com uma chave de teste. Dados fictícios.
// ============================================================
'use strict';

const supertest = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const forge = require('node-forge');

const SECRET = 'aura-test-secret-2026';
const CID = '00000000-0000-0000-0000-0000000000c1';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };
const EM = (n) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CHAVE_55 = '35261111222333000181550020000000151123456786';
const CHAVE_65 = '35261111222333000181650020000009001123456780';
const NFE = '<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe' + CHAVE_55 + '"><ide><mod>55</mod><tpAmb>2</tpAmb></ide></infNFe></NFe>';
const NFCE = '<NFe xmlns="http://www.portalfiscal.inf.br/nfe"><infNFe Id="NFe' + CHAVE_65 + '"><ide><mod>65</mod><tpAmb>2</tpAmb></ide></infNFe></NFe>';
const JUST = 'Cliente desistiu da compra antes da entrega';

function certDeTeste() {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const c = forge.pki.createCertificate();
  c.publicKey = keys.publicKey; c.serialNumber = '09';
  c.validity.notBefore = new Date(Date.now() - 864e5);
  c.validity.notAfter = new Date(Date.now() + 365 * 864e5);
  const attrs = [{ name: 'commonName', value: 'TESTE' }];
  c.setSubject(attrs); c.setIssuer(attrs);
  c.sign(keys.privateKey, forge.md.sha256.create());
  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certDerBase64: forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(c)).getBytes()),
  };
}
const CERT = certDeTeste();

function retEnvEvento(cStat, xMotivo, { chave = CHAVE_55, tpEvento = '110111', seq = 1, prot = '135260000009999' } = {}) {
  return '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeResultMsg>'
    + '<retEnvEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><idLote>1</idLote><tpAmb>2</tpAmb>'
    + '<cStat>128</cStat><xMotivo>Lote de evento processado</xMotivo>'
    + `<retEvento versao="1.00"><infEvento><tpAmb>2</tpAmb><cStat>${cStat}</cStat><xMotivo>${xMotivo}</xMotivo>`
    + `<chNFe>${chave}</chNFe><tpEvento>${tpEvento}</tpEvento><nSeqEvento>${seq}</nSeqEvento>`
    + `<dhRegEvento>2026-11-14T10:00:00-03:00</dhRegEvento><nProt>${prot}</nProt></infEvento></retEvento>`
    + '</retEnvEvento></nfeResultMsg></soap:Body></soap:Envelope>';
}

let state;
let ctx;
const horasAtras = (h) => new Date(Date.now() - h * 3600e3).toISOString();

function estado() {
  const base = { company_id: CID, tipo: 'nfe', finalidade: 1, serie: 2, numero: 15, total_nfce: 63, protocolo: '135260000000001', chave_acesso: CHAVE_55, xml_signed: NFE, status: 'autorizada', metadata: {} };
  return {
    config: { company_id: CID, uf: 'SP', ambiente: 'homologacao', is_active: true },
    emissions: {
      [EM(1)]: { ...base, id: EM(1), authorized_at: horasAtras(2) },
      [EM(2)]: { ...base, id: EM(2), authorized_at: horasAtras(25) },
      [EM(3)]: { ...base, id: EM(3), status: 'cancelada', authorized_at: horasAtras(2) },
      [EM(4)]: { ...base, id: EM(4), tipo: 'nfce', chave_acesso: CHAVE_65, xml_signed: NFCE, numero: 900, authorized_at: horasAtras(40 / 60) },
      [EM(5)]: { ...base, id: EM(5), tipo: 'nfce', chave_acesso: CHAVE_65, xml_signed: NFCE, numero: 901, authorized_at: horasAtras(10 / 60) },
    },
    soap: [],
    resposta: (url, env) => retEnvEvento('135', 'Evento registrado e vinculado a NF-e', { tpEvento: (env.match(/<tpEvento>(\d+)/) || [])[1], seq: (env.match(/<nSeqEvento>(\d+)/) || [])[1] }),
  };
}

async function fakeQuery(sql, params = []) {
  const s = String(sql);
  if (/FROM nfce_emissions\s+WHERE id = \$1 AND company_id = \$2 AND tipo IN/.test(s)) {
    const e = state.emissions[params[0]];
    return { rows: e && e.company_id === params[1] && ['nfe', 'nfe_devolucao'].includes(e.tipo) ? [JSON.parse(JSON.stringify(e))] : [] };
  }
  if (/SELECT \* FROM nfce_emissions WHERE id=\$1 AND company_id=\$2 AND xml_signed IS NOT NULL/.test(s)) {
    const e = state.emissions[params[0]];
    return { rows: e && e.company_id === params[1] ? [JSON.parse(JSON.stringify(e))] : [] };
  }
  if (/SELECT \* FROM nfce_config WHERE company_id\s*=\s*\$1/.test(s)) return { rows: [{ ...state.config }] };
  if (/UPDATE nfce_emissions\s+SET status = 'cancelada'/.test(s)) {
    const e = state.emissions[params[2]];
    Object.assign(e, { status: 'cancelada', cancel_reason: params[0], cancelled_at: 'agora' });
    e.metadata = { ...(e.metadata || {}), ...JSON.parse(params[1]) };
    return { rows: [JSON.parse(JSON.stringify(e))] };
  }
  if (/UPDATE nfce_emissions SET status='cancelada'/.test(s)) {
    const e = state.emissions[params[1]];
    Object.assign(e, { status: 'cancelada', cancel_reason: params[0] });
    return { rows: [JSON.parse(JSON.stringify(e))] };
  }
  if (/UPDATE nfce_emissions SET metadata = COALESCE/.test(s)) {
    const e = state.emissions[params[1]];
    e.metadata = { ...(e.metadata || {}), ...JSON.parse(params[0]) };
    return { rows: [] };
  }
  return { rows: [] };
}

function buildApp() {
  jest.resetModules();
  const query = jest.fn(fakeQuery);
  const db = { query, queryRetry: (...a) => query(...a), isTransientConnError: () => false, connect: jest.fn() };
  const soapReal = jest.requireActual('../src/services/sefazSp/soapClient');
  const postSoap = jest.fn(async (url, envelope) => {
    state.soap.push({ url, envelope });
    if (state.falhaDeRede) throw new Error('ECONNRESET');
    return { status: 200, body: state.resposta(url, envelope) };
  });
  jest.doMock('../src/config/database', () => db);
  jest.doMock('../src/services/sefazSp/soapClient', () => ({ ...soapReal, postSoap }));
  jest.doMock('../src/services/sefazSp/certStore', () => ({ loadCertificate: jest.fn(async () => ({ pfx: Buffer.from('x'), password: 'p' })) }));
  jest.doMock('../src/services/sefazSp/pfx', () => ({ openPfx: jest.fn(() => CERT), assertValidity: jest.fn() }));
  jest.doMock('../src/middleware/auditLog', () => ({ logAuditAction: jest.fn() }));
  jest.doMock('../src/services/nuvemfiscal', () => ({ cancelNfe: jest.fn(), cancelNfce: jest.fn(), ufToCodigo: () => 35 }));
  const app = express();
  app.use(express.json());
  app.use('/c/:id/nfe55', require('../src/routes/nfe55Documentos'));
  app.use('/c/:id/nfce', require('../src/routes/nfce'));
  ctx = { app, postSoap };
}

const post = (path, body) => supertest(ctx.app).post(`/c/${CID}${path}`).set(auth).send(body);
const get = (path) => supertest(ctx.app).get(`/c/${CID}${path}`).set(auth);

beforeEach(() => {
  delete process.env.NFE55_CANCEL_DEADLINE_H;
  delete process.env.NFCE_CANCEL_DEADLINE_MIN;
  state = estado();
  buildApp();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('cancelamento 110111 da NF-e 55', () => {
  it('dentro de 24 h: vai ao NFeRecepcaoEvento4 da NF-e (não ao da NFC-e), grava cancelada + procEventoNFe', async () => {
    const r = await post(`/nfe55/${EM(1)}/cancelar`, { justificativa: JUST });
    expect(r.status).toBe(200);
    expect(r.body.nfe).toMatchObject({ id: EM(1), status: 'cancelada' });
    expect(r.body.nfe.xml_signed).toBeUndefined();
    expect(r.body.evento).toMatchObject({ cStat: '135', protocolo: '135260000009999', ja_cancelada: false });
    expect(r.body.cancelavel_ate).toBeTruthy();
    expect(state.soap).toHaveLength(1);
    expect(state.soap[0].url).toBe('https://homologacao.nfe.fazenda.sp.gov.br/ws/nferecepcaoevento4.asmx');
    expect(state.soap[0].url).not.toMatch(/nfce/);
    const env = state.soap[0].envelope;
    expect(env).toContain('<tpEvento>110111</tpEvento>');
    expect(env).toContain(`<chNFe>${CHAVE_55}</chNFe>`);
    expect(env).toContain('<nProt>135260000000001</nProt>');
    expect(env).toContain(`<xJust>${JUST}</xJust>`);
    expect(env).toContain('<cOrgao>35</cOrgao>');
    expect(env).toContain('<Signature');
    const meta = state.emissions[EM(1)].metadata.cancelamento;
    expect(meta).toMatchObject({ protocolo: '135260000009999', justificativa: JUST });
    expect(meta.xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?><procEventoNFe xmlns="http:\/\/www\.portalfiscal\.inf\.br\/nfe" versao="1\.00"><evento versao="1\.00">/);
    expect(meta.xml).toContain('<retEvento versao="1.00">');
    expect(meta.xml.endsWith('</retEvento></procEventoNFe>')).toBe(true);
  });

  it('depois de 24 h: recusa com texto humano (devolução, contador) e não chama a SEFAZ', async () => {
    const r = await post(`/nfe55/${EM(2)}/cancelar`, { justificativa: JUST });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('NFE_PRAZO_CANCELAMENTO_VENCIDO');
    expect(r.body.error).toMatch(/^Passou o prazo de 24 h para cancelar esta NF-e \(venceu em \d{2}\/\d{2} às \d{2}:\d{2}\)\. Para desfazer, emita uma NF-e de devolução — fale com seu contador\.$/);
    expect(r.body.cancelavel_ate).toBeTruthy();
    expect(state.soap).toHaveLength(0);
  });

  it('prazo configurável por env (NFE55_CANCEL_DEADLINE_H=48)', async () => {
    process.env.NFE55_CANCEL_DEADLINE_H = '48';
    const r = await post(`/nfe55/${EM(2)}/cancelar`, { justificativa: JUST });
    expect(r.status).toBe(200);
    const s = await get(`/nfe55/${EM(1)}/eventos`);
    expect(s.body).toMatchObject({ prazo_horas: 48, pode_cancelar: true });
  });

  it('justificativa fora de 15–255 letras: 422', async () => {
    expect((await post(`/nfe55/${EM(1)}/cancelar`, { justificativa: 'curta' })).body.code).toBe('JUSTIFICATIVA_INVALIDA');
    expect((await post(`/nfe55/${EM(1)}/cancelar`, { justificativa: 'x'.repeat(256) })).body.code).toBe('JUSTIFICATIVA_INVALIDA');
    expect(state.soap).toHaveLength(0);
  });

  it('SEFAZ recusa por prazo (501): mensagem da devolução; outra recusa: texto do catálogo', async () => {
    state.resposta = () => retEnvEvento('501', 'Rejeicao: Prazo de cancelamento superior ao previsto na Legislacao');
    const r = await post(`/nfe55/${EM(1)}/cancelar`, { justificativa: JUST });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('NFE_PRAZO_CANCELAMENTO_VENCIDO');
    expect(r.body.error).toMatch(/NF-e de devolução/);
    expect(r.body.rejeicao_amigavel).toMatchObject({ cStat: '501', conhecida: true });
    expect(state.emissions[EM(1)].status).toBe('autorizada');

    state.resposta = () => retEnvEvento('218', 'Rejeicao: NF-e ja esta cancelada na base de dados da SEFAZ');
    const r2 = await post(`/nfe55/${EM(1)}/cancelar`, { justificativa: JUST });
    expect(r2.status).toBe(422);
    expect(r2.body).toMatchObject({ code: 'NFE_CANCELAMENTO_RECUSADO', cStat: '218' });
    expect(r2.body.error).toMatch(/já está cancelada na SEFAZ/);
  });

  it('573 (duplicidade de evento) no cancelamento = já estava cancelada: grava como cancelada', async () => {
    state.resposta = () => retEnvEvento('573', 'Rejeicao: Duplicidade de evento');
    const r = await post(`/nfe55/${EM(1)}/cancelar`, { justificativa: JUST });
    expect(r.status).toBe(200);
    expect(r.body.evento.ja_cancelada).toBe(true);
    expect(state.emissions[EM(1)].status).toBe('cancelada');
  });

  it('nota já cancelada: idempotente, sem SEFAZ; SEFAZ fora: 502 com texto humano', async () => {
    const r = await post(`/nfe55/${EM(3)}/cancelar`, { justificativa: JUST });
    expect(r.status).toBe(200);
    expect(r.body.idempotente).toBe(true);
    expect(state.soap).toHaveLength(0);
    state.falhaDeRede = true;
    const f = await post(`/nfe55/${EM(1)}/cancelar`, { justificativa: JUST });
    expect(f.status).toBe(502);
    expect(f.body.code).toBe('NFE_EVENTO_SEM_RESPOSTA');
    expect(state.emissions[EM(1)].status).toBe('autorizada');
  });

  it('DANFE da nota cancelada sai com a marca CANCELADA (CP3)', async () => {
    const { textoDoPdf } = require('../tests/helpers/textoDoPdf');
    const fx = require('../tests/fixtures/nfe55Documentos');
    const { xml, chave } = fx.xmlVenda({ tpAmb: 1 });
    Object.assign(state.emissions[EM(1)], { xml_signed: xml, chave_acesso: chave });
    await post(`/nfe55/${EM(1)}/cancelar`, { justificativa: JUST });
    const pdf = await get(`/nfe55/${EM(1)}/danfe.pdf`).buffer(true).parse((res, cb) => { const p = []; res.on('data', (c) => p.push(c)); res.on('end', () => cb(null, Buffer.concat(p))); });
    expect(pdf.status).toBe(200);
    expect(textoDoPdf(pdf.body)).toContain('CANCELADA');
  });
});

describe('POST /nfce/:id/cancel (rota antiga)', () => {
  it('NF-e 55: vai ao evento da 55 (24 h), não ao da NFC-e', async () => {
    const r = await post(`/nfce/${EM(1)}/cancel`, { reason: JUST });
    expect(r.status).toBe(200);
    expect(r.body.nfce.status).toBe('cancelada');
    expect(state.soap[0].url).toBe('https://homologacao.nfe.fazenda.sp.gov.br/ws/nferecepcaoevento4.asmx');
  });

  it('NFC-e continua igual: endpoint da NFC-e e prazo de 30 min', async () => {
    const vencida = await post(`/nfce/${EM(4)}/cancel`, { reason: JUST });
    expect(vencida.status).toBe(400);
    expect(vencida.body.error).toMatch(/Prazo de cancelamento expirado \(30 min/);
    expect(state.soap).toHaveLength(0);
    const ok = await post(`/nfce/${EM(5)}/cancel`, { reason: JUST });
    expect(ok.status).toBe(200);
    expect(state.soap[0].url).toMatch(/^https:\/\/homologacao\.nfce\.fazenda\.sp\.gov\.br\//);
  });
});

describe('carta de correção 110110', () => {
  const TEXTO = (n) => `Onde se le Sala ${n}, leia-se Sala ${n}0 no endereco do cliente`;

  it('sequência 1, 2, 3 com o xCondUso oficial; cada carta no metadata; XML de cada uma para baixar', async () => {
    const { X_COND_USO_CCE } = require('../src/services/sefazSp/eventos');
    for (const n of [1, 2, 3]) {
      const r = await post(`/nfe55/${EM(1)}/carta-correcao`, { texto: TEXTO(n) });
      expect(r.status).toBe(201);
      expect(r.body.carta).toMatchObject({ seq: n, texto: TEXTO(n), protocolo: '135260000009999' });
      expect(r.body.cartas).toHaveLength(n);
      const env = state.soap[n - 1].envelope;
      expect(state.soap[n - 1].url).toBe('https://homologacao.nfe.fazenda.sp.gov.br/ws/nferecepcaoevento4.asmx');
      expect(env).toContain('<tpEvento>110110</tpEvento>');
      expect(env).toContain(`<nSeqEvento>${n}</nSeqEvento>`);
      expect(env).toContain(`Id="ID110110${CHAVE_55}0${n}"`);
      expect(env).toContain('<descEvento>Carta de Correcao</descEvento>');
      expect(env).toContain(`<xCorrecao>${TEXTO(n)}</xCorrecao>`);
      expect(env).toContain(`<xCondUso>${X_COND_USO_CCE}</xCondUso>`);
    }
    expect(X_COND_USO_CCE).toBe('A Carta de Correcao e disciplinada pelo paragrafo 1o-A do art. 7o do Convenio S/N, de 15 de dezembro de 1970 e pode ser utilizada para regularizacao de erro ocorrido na emissao de documento fiscal, desde que o erro nao esteja relacionado com: I - as variaveis que determinam o valor do imposto tais como: base de calculo, aliquota, diferenca de preco, quantidade, valor da operacao ou da prestacao; II - a correcao de dados cadastrais que implique mudanca do remetente ou do destinatario; III - a data de emissao ou de saida.');
    const cartas = state.emissions[EM(1)].metadata.cartas_correcao;
    expect(cartas.map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(cartas[1].xml).toContain('<procEventoNFe');
    const x = await get(`/nfe55/${EM(1)}/carta-correcao/2/xml`);
    expect(x.status).toBe(200);
    expect(x.headers['content-disposition']).toBe(`attachment; filename="${CHAVE_55}-cce-2.xml"`);
    expect(x.text).toContain('<nSeqEvento>2</nSeqEvento>');
    expect((await get(`/nfe55/${EM(1)}/carta-correcao/9/xml`)).status).toBe(404);
    const s = await get(`/nfe55/${EM(1)}/eventos`);
    expect(s.body.cartas.map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(s.body.cartas[0].xml).toBeUndefined();
  });

  it('texto fora de 15–1000 letras: 422; nota cancelada: 409; nada vai à SEFAZ', async () => {
    expect((await post(`/nfe55/${EM(1)}/carta-correcao`, { texto: 'curto' })).body.code).toBe('TEXTO_INVALIDO');
    expect((await post(`/nfe55/${EM(1)}/carta-correcao`, { texto: 'x'.repeat(1001) })).body.code).toBe('TEXTO_INVALIDO');
    const c = await post(`/nfe55/${EM(3)}/carta-correcao`, { texto: TEXTO(1) });
    expect(c.status).toBe(409);
    expect(c.body.error).toMatch(/cancelada/);
    expect(state.soap).toHaveLength(0);
  });

  it('recusas da carta: 573 duplicidade e 594 limite em texto humano; nada é gravado', async () => {
    state.resposta = () => retEnvEvento('573', 'Rejeicao: Duplicidade de evento', { tpEvento: '110110' });
    const d = await post(`/nfe55/${EM(1)}/carta-correcao`, { texto: TEXTO(1) });
    expect(d.status).toBe(409);
    expect(d.body.code).toBe('CARTA_JA_REGISTRADA');
    expect(d.body.error).toMatch(/já tem uma carta de correção com o número 1/);
    state.resposta = () => retEnvEvento('594', 'Rejeicao: Numero de sequencia do evento maior que o permitido', { tpEvento: '110110' });
    const l = await post(`/nfe55/${EM(1)}/carta-correcao`, { texto: TEXTO(1) });
    expect(l.status).toBe(422);
    expect(l.body).toMatchObject({ code: 'CARTA_CORRECAO_RECUSADA', cStat: '594' });
    expect(l.body.error).toMatch(/limite de cartas de correção/);
    expect(state.emissions[EM(1)].metadata.cartas_correcao).toBeUndefined();
  });
});
