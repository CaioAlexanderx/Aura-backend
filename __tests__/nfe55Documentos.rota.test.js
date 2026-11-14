// ============================================================
// AURA. — Documentos da NF-e 55 (CP3, 14/11/2026)
//   GET  /companies/:id/nfe55/:emissaoId/danfe.pdf
//   GET  /companies/:id/nfe55/:emissaoId/xml
//   POST /companies/:id/nfe55/:emissaoId/enviar-email
//   + GET /print/danfe/devolucao/:saleId (devolução própria → DANFE da Aura)
// Banco falso; e-mail mockado (services/mailer.sendMail). Dados fictícios.
// ============================================================
'use strict';

const supertest = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const { textoDoPdf } = require('../tests/helpers/textoDoPdf');
const fx = require('../tests/fixtures/nfe55Documentos');
const { extrairProtNFe } = require('../src/services/sefazSp/nfeProc');

const SECRET = 'aura-test-secret-2026';
const CID = '00000000-0000-0000-0000-0000000000c1';
const OUTRA = '00000000-0000-0000-0000-0000000000c2';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };
const EM = (n) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDA = 'aaaaaaaa-0000-4000-8000-000000000001';
const TROCA = 'aaaaaaaa-0000-4000-8000-000000000002';

let state;
let ctx;

function estado() {
  const homolog = fx.xmlVenda({ tpAmb: 2 });
  const semEmail = fx.xmlVenda({ tpAmb: 1, emailDest: '' });
  const prod = fx.xmlVenda({ tpAmb: 1 });
  const base = { company_id: CID, tipo: 'nfe', finalidade: 1, serie: 2, numero: 15, total_nfce: 63, authorized_at: '2026-11-14T13:00:05.000Z' };
  return {
    chaves: { homolog: homolog.chave, prod: prod.chave },
    emissions: [
      { ...base, id: EM(1), sale_id: VENDA, status: 'autorizada', protocolo: '135260000000001', chave_acesso: homolog.chave, xml_signed: homolog.xml,
        metadata: { prot_xml: extrairProtNFe(fx.retornoSoapAutorizado(homolog.chave)) } },
      { ...base, id: EM(2), sale_id: VENDA, status: 'autorizada', protocolo: '135260000000002', chave_acesso: semEmail.chave, xml_signed: semEmail.xml, metadata: {} },
      { ...base, id: EM(3), sale_id: VENDA, status: 'rejeitada', protocolo: null, chave_acesso: prod.chave, xml_signed: prod.xml, metadata: {} },
      { ...base, id: EM(4), sale_id: VENDA, status: 'autorizada', protocolo: '1', chave_acesso: null, xml_signed: null, nuvemfiscal_id: 'nf-antigo', metadata: {} },
      { ...base, id: EM(5), company_id: OUTRA, sale_id: VENDA, status: 'autorizada', protocolo: '1', chave_acesso: prod.chave, xml_signed: prod.xml, metadata: {} },
      { ...base, id: EM(6), sale_id: TROCA, finalidade: 4, status: 'autorizada', protocolo: '135260000000006', chave_acesso: prod.chave, xml_signed: prod.xml, metadata: {} },
      { ...base, id: EM(7), sale_id: VENDA, status: 'cancelada', protocolo: '135260000000007', chave_acesso: prod.chave, xml_signed: prod.xml, metadata: {} },
    ],
    clienteEmail: 'cliente.ficticio@exemplo.com',
    company: { nome: 'Loja Exemplo', email: 'loja@exemplo.com' },
    metadataUpdates: [],
  };
}

async function fakeQuery(sql, params = []) {
  const s = String(sql);
  if (/FROM nfce_emissions\s+WHERE id = \$1 AND company_id = \$2 AND tipo IN/.test(s)) {
    const e = state.emissions.find((x) => x.id === params[0] && x.company_id === params[1]);
    return { rows: e ? [{ ...e }] : [] };
  }
  if (/FROM nfce_emissions\s+WHERE sale_id = \$1 AND company_id = \$2/.test(s)) {
    const rows = state.emissions.filter((x) => x.sale_id === params[0] && x.company_id === params[1] && (x.xml_signed || x.nuvemfiscal_id))
      .sort((a, b) => (b.status === 'autorizada') - (a.status === 'autorizada'));
    return { rows: rows.slice(0, 1).map((r) => ({ ...r })) };
  }
  if (/FROM sales s JOIN customers c/.test(s)) return { rows: state.clienteEmail ? [{ email: state.clienteEmail }] : [] };
  if (/FROM companies WHERE id = \$1/.test(s)) return { rows: [{ ...state.company }] };
  if (/UPDATE nfce_emissions\s+SET metadata/.test(s)) {
    state.metadataUpdates.push({ id: params[1], registro: JSON.parse(params[0]) });
    return { rows: [] };
  }
  return { rows: [] };
}

function buildApp() {
  jest.resetModules();
  const query = jest.fn(fakeQuery);
  const db = { query, queryRetry: (...a) => query(...a), isTransientConnError: () => false, connect: jest.fn() };
  const sendMail = jest.fn(async () => ({ id: 'resend-ficticio-1' }));
  jest.doMock('../src/config/database', () => db);
  jest.doMock('../src/services/mailer', () => ({ sendMail }));
  jest.doMock('../src/middleware/auditLog', () => ({ logAuditAction: jest.fn() }));
  const app = express();
  app.use(express.json());
  app.use('/c/:id/nfe55', require('../src/routes/nfe55Documentos'));
  app.use('/c/:id/print', require('../src/routes/print'));
  ctx = { app, db, sendMail };
}

const get = (path) => supertest(ctx.app).get(path).set(auth).buffer(true).parse((res, cb) => {
  const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => cb(null, Buffer.concat(parts)));
});
const paginas = (pdf) => (pdf.toString('latin1').match(/\/Type \/Page[^s]/g) || []).length;
const enviar = (id, body = {}) => supertest(ctx.app).post(`/c/${CID}/nfe55/${id}/enviar-email`).set(auth).send(body);

beforeEach(() => {
  state = estado();
  buildApp();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('GET /nfe55/:emissaoId/danfe.pdf', () => {
  it('nota autorizada em homologação: PDF de 1 página com chave, número e a marca', async () => {
    const r = await get(`/c/${CID}/nfe55/${EM(1)}/danfe.pdf`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['content-disposition']).toBe(`inline; filename="${state.chaves.homolog}-danfe.pdf"`);
    expect(r.body.length).toBeGreaterThan(1000);
    expect(paginas(r.body)).toBe(1);
    const t = textoDoPdf(r.body);
    expect(t).toContain(state.chaves.homolog.replace(/(\d{4})(?=\d)/g, '$1 '));
    expect(t).toContain('Nº 000.000.015');
    expect(t).toContain('135260000000001  14/11/2026 10:00:05');
    expect(t).toContain('SEM VALOR FISCAL');
  });

  it('cancelada: PDF com a marca CANCELADA', async () => {
    const r = await get(`/c/${CID}/nfe55/${EM(7)}/danfe.pdf`);
    expect(r.status).toBe(200);
    expect(textoDoPdf(r.body)).toContain('CANCELADA');
  });

  it('404 nota de outra loja e id inválido; 409 rejeitada; 422 nota antiga sem XML', async () => {
    expect((await supertest(ctx.app).get(`/c/${CID}/nfe55/${EM(5)}/danfe.pdf`).set(auth)).status).toBe(404);
    expect((await supertest(ctx.app).get(`/c/${CID}/nfe55/nao-e-uuid/danfe.pdf`).set(auth)).status).toBe(404);
    const rej = await supertest(ctx.app).get(`/c/${CID}/nfe55/${EM(3)}/danfe.pdf`).set(auth);
    expect(rej.status).toBe(409);
    expect(rej.body).toMatchObject({ code: 'NFE_NAO_AUTORIZADA' });
    const antiga = await supertest(ctx.app).get(`/c/${CID}/nfe55/${EM(4)}/danfe.pdf`).set(auth);
    expect(antiga.status).toBe(422);
    expect(antiga.body.code).toBe('NFE_SEM_XML');
  });

  it('sem token: 401', async () => {
    expect((await supertest(ctx.app).get(`/c/${CID}/nfe55/${EM(1)}/danfe.pdf`)).status).toBe(401);
  });
});

describe('GET /nfe55/:emissaoId/xml', () => {
  it('nfeProc com o protNFe da SEFAZ e o nome <chave>-nfe.xml', async () => {
    const r = await supertest(ctx.app).get(`/c/${CID}/nfe55/${EM(1)}/xml`).set(auth);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/application\/xml/);
    expect(r.headers['content-disposition']).toBe(`attachment; filename="${state.chaves.homolog}-nfe.xml"`);
    expect(r.headers['x-aura-protnfe']).toBe('sefaz');
    expect(r.text).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?><nfeProc xmlns="http:\/\/www\.portalfiscal\.inf\.br\/nfe" versao="4\.00"><NFe/);
    expect(r.text).toContain('<verAplic>SP_NFE_PL009_V4</verAplic>');
    expect(r.text.endsWith('</protNFe></nfeProc>')).toBe(true);
  });

  it('nota de antes do CP3 (sem protNFe guardado): protNFe remontado', async () => {
    const r = await supertest(ctx.app).get(`/c/${CID}/nfe55/${EM(2)}/xml`).set(auth);
    expect(r.status).toBe(200);
    expect(r.headers['x-aura-protnfe']).toBe('reconstruido');
    expect(r.text).toContain('<nProt>135260000000002</nProt>');
  });

  it('só autorizada: 409 rejeitada e cancelada; 404 outra loja', async () => {
    expect((await supertest(ctx.app).get(`/c/${CID}/nfe55/${EM(3)}/xml`).set(auth)).status).toBe(409);
    expect((await supertest(ctx.app).get(`/c/${CID}/nfe55/${EM(7)}/xml`).set(auth)).status).toBe(409);
    expect((await supertest(ctx.app).get(`/c/${CID}/nfe55/${EM(5)}/xml`).set(auth)).status).toBe(404);
  });
});

describe('POST /nfe55/:emissaoId/enviar-email', () => {
  it('padrão: e-mail do destinatário do XML; anexa DANFE e XML; remetente neutro, resposta para a loja; registra no metadata', async () => {
    const r = await enviar(EM(1));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enviado: true, para: 'compras@exemplo.com' });
    expect(ctx.sendMail).toHaveBeenCalledTimes(1);
    const m = ctx.sendMail.mock.calls[0][0];
    expect(m.to).toBe('compras@exemplo.com');
    expect(m.from).toBe('Aura <contato@getaura.com.br>');
    expect(m.replyTo).toBe('loja@exemplo.com');
    expect(m.subject).toBe('Nota fiscal da sua compra — Loja Exemplo');
    expect(m.text).toContain('NF-e nº 15, série 2');
    expect(m.text).toContain('não tem valor fiscal'); // homologação
    expect(m.text.trim().endsWith('Loja Exemplo')).toBe(true);
    expect(m.html).toContain('Enviado pela Aura para Loja Exemplo');
    expect(m.attachments.map((a) => [a.filename, a.contentType])).toEqual([
      [`${state.chaves.homolog}-danfe.pdf`, 'application/pdf'],
      [`${state.chaves.homolog}-nfe.xml`, 'application/xml'],
    ]);
    expect(m.attachments[0].content.slice(0, 5).toString()).toBe('%PDF-');
    expect(m.attachments[1].content.toString()).toContain('<nfeProc');
    expect(state.metadataUpdates).toEqual([{ id: EM(1), registro: [expect.objectContaining({ para: 'compras@exemplo.com', por: 'u1', id: 'resend-ficticio-1' })] }]);
  });

  it('e-mail no corpo vence; sem e-mail no XML usa o do cadastro do cliente', async () => {
    const r1 = await enviar(EM(1), { email: 'outro@exemplo.com' });
    expect(r1.body.para).toBe('outro@exemplo.com');
    const r2 = await enviar(EM(2));
    expect(r2.status).toBe(200);
    expect(r2.body.para).toBe('cliente.ficticio@exemplo.com');
    expect(ctx.sendMail.mock.calls[1][0].text).not.toContain('não tem valor fiscal'); // produção
  });

  it('422 sem e-mail nenhum e 422 e-mail inválido ou em lote; nada é enviado', async () => {
    state.clienteEmail = null;
    const sem = await enviar(EM(2));
    expect(sem.status).toBe(422);
    expect(sem.body.code).toBe('NFE_SEM_EMAIL');
    expect(sem.body.error).toMatch(/Digite o e-mail/);
    const lote = await enviar(EM(1), { email: 'a@exemplo.com, b@exemplo.com' });
    expect(lote.status).toBe(422);
    expect(lote.body.code).toBe('EMAIL_INVALIDO');
    expect(ctx.sendMail).not.toHaveBeenCalled();
  });

  it('409 nota não autorizada; 404 de outra loja', async () => {
    expect((await enviar(EM(3))).status).toBe(409);
    expect((await enviar(EM(7))).status).toBe(409);
    expect((await enviar(EM(5))).status).toBe(404);
    expect(ctx.sendMail).not.toHaveBeenCalled();
  });

  it('nota de devolução: texto de devolução', async () => {
    const r = await enviar(EM(6), { email: 'cliente@exemplo.com' });
    expect(r.status).toBe(200);
    expect(ctx.sendMail.mock.calls[0][0].subject).toBe('Nota fiscal de devolução — Loja Exemplo');
  });
});

describe('GET /print/danfe/devolucao/:saleId', () => {
  it('devolução da engine própria sai com o DANFE da Aura (sem Nuvem Fiscal)', async () => {
    const r = await get(`/c/${CID}/print/danfe/devolucao/${TROCA}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(textoDoPdf(r.body)).toContain('135260000000006');
  });
});
