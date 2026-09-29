// ============================================================
// Comprovante do lançamento (contas a pagar F3 · 29/09/2026)
// Foto ou PDF até 3,5 MB no R2; a tabela guarda a chave. Anexar de novo
// substitui e apaga o antigo; abrir devolve URL assinada da própria empresa.
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/utils/r2Storage', () => ({
  uploadToR2: jest.fn(async (key, content) => ({ success: true, key, size: content.length })),
  getSignedUrl: jest.fn(async (key) => 'https://r2.example/' + key + '?assinado'),
  deleteFromR2: jest.fn(async () => ({ success: true })),
}));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const r2 = require('../src/utils/r2Storage');

const COMPANY = '11111111-1111-4111-8111-111111111111';
const TX = '22222222-2222-4222-8222-222222222222';
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '6mb' }));
  app.use('/companies/:id/transactions', require('../src/routes/transactionReceipt'));
  return app;
}

function mockBanco(linha) {
  const estado = { updates: [] };
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (/^SELECT id, receipt_key FROM transactions/.test(s)) return Promise.resolve({ rows: linha ? [linha] : [] });
    if (/^UPDATE transactions SET receipt_key/.test(s)) { estado.updates.push({ sql: s, params }); return Promise.resolve({ rows: [] }); }
    return Promise.resolve({ rows: [] });
  });
  return estado;
}

const url = '/companies/' + COMPANY + '/transactions/' + TX + '/receipt';

beforeEach(() => { db.query.mockReset(); jest.clearAllMocks(); });

describe('POST /:txId/receipt', () => {
  it('guarda no R2 com chave da empresa e grava chave, nome e tipo', async () => {
    const estado = mockBanco({ id: TX, receipt_key: null });
    const res = await request(buildApp()).post(url).send({ content: PNG_1PX, filename: 'boleto energia.png', content_type: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.receipt).toMatchObject({ filename: 'boleto energia.png', content_type: 'image/png' });
    const [key, bytes, tipo] = r2.uploadToR2.mock.calls[0];
    expect(key).toMatch(new RegExp('^' + COMPANY + '/comprovantes/\\d{4}/' + TX + '-[0-9a-f]{12}\\.png$'));
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(tipo).toBe('image/png');
    expect(estado.updates[0].params.slice(0, 3)).toEqual([key, 'boleto energia.png', 'image/png']);
    expect(r2.deleteFromR2).not.toHaveBeenCalled();
  });

  it('anexar de novo apaga o arquivo antigo depois de gravar o novo', async () => {
    mockBanco({ id: TX, receipt_key: COMPANY + '/comprovantes/2026/antigo.pdf' });
    const res = await request(buildApp()).post(url).send({ content: PNG_1PX, filename: 'novo.png', content_type: 'image/png' });
    expect(res.status).toBe(201);
    expect(r2.deleteFromR2).toHaveBeenCalledWith(COMPANY + '/comprovantes/2026/antigo.pdf');
  });

  it.each([
    ['tipo nao aceito', { content: PNG_1PX, content_type: 'text/html' }, 400],
    ['sem conteudo', { content: '', content_type: 'image/png' }, 400],
  ])('recusa %s', async (_n, corpo, status) => {
    mockBanco({ id: TX, receipt_key: null });
    const res = await request(buildApp()).post(url).send(corpo);
    expect(res.status).toBe(status);
    expect(r2.uploadToR2).not.toHaveBeenCalled();
  });

  it('recusa arquivo acima de 3,5 MB com 413', async () => {
    mockBanco({ id: TX, receipt_key: null });
    const grande = Buffer.alloc(3.6 * 1024 * 1024, 1).toString('base64');
    const res = await request(buildApp()).post(url).send({ content: grande, content_type: 'application/pdf' });
    expect(res.status).toBe(413);
    expect(r2.uploadToR2).not.toHaveBeenCalled();
  });

  it('lancamento de outra empresa (ou inexistente) da 404 e nao sobe nada', async () => {
    mockBanco(null);
    const res = await request(buildApp()).post(url).send({ content: PNG_1PX, content_type: 'image/png' });
    expect(res.status).toBe(404);
    expect(r2.uploadToR2).not.toHaveBeenCalled();
  });

  it('data URL com prefixo e aceita', async () => {
    mockBanco({ id: TX, receipt_key: null });
    const res = await request(buildApp()).post(url).send({ content: 'data:image/png;base64,' + PNG_1PX, content_type: 'image/png' });
    expect(res.status).toBe(201);
  });
});

describe('GET e DELETE /:txId/receipt', () => {
  it('GET devolve URL assinada', async () => {
    mockBanco({ id: TX, receipt_key: COMPANY + '/comprovantes/2026/x.pdf' });
    const res = await request(buildApp()).get(url);
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/assinado$/);
  });

  it('GET sem comprovante da 404', async () => {
    mockBanco({ id: TX, receipt_key: null });
    const res = await request(buildApp()).get(url);
    expect(res.status).toBe(404);
  });

  it('GET recusa chave que nao e da empresa', async () => {
    mockBanco({ id: TX, receipt_key: 'outra-empresa/comprovantes/2026/x.pdf' });
    const res = await request(buildApp()).get(url);
    expect(res.status).toBe(403);
    expect(r2.getSignedUrl).not.toHaveBeenCalled();
  });

  it('DELETE limpa as colunas e apaga no R2', async () => {
    const estado = mockBanco({ id: TX, receipt_key: COMPANY + '/comprovantes/2026/x.pdf' });
    const res = await request(buildApp()).delete(url);
    expect(res.body).toEqual({ deleted: true });
    expect(estado.updates[0].sql).toMatch(/receipt_key = NULL/);
    expect(r2.deleteFromR2).toHaveBeenCalled();
  });
});
