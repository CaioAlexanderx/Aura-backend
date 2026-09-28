// ============================================================
// Upload do Studio · teto real de 15 MB (28/09/2026)
//
// O express.json global (5 MB) barrava o upload antes do limite de 15 MB
// das rotas: 5 MB de base64 sao ~3,7 MB de arquivo. As duas rotas de
// upload ganham um parser proprio de 25 MB, montado antes do global.
//
// O que trava aqui, no app DE VERDADE (src/app.js):
//   - 6 MB de corpo chegam na rota de upload (vitrine e painel);
//   - 6 MB em qualquer outra rota continuam 413 (nada mais mudou);
//   - acima de 25 MB: 413 com JSON em portugues, sem 500.
// ============================================================
'use strict';

const request = require('supertest');
const db = require('../src/config/database');
const {
  ROTAS_DE_UPLOAD, MENSAGEM_ARQUIVO_GRANDE, jsonDeUpload,
} = require('../src/middleware/jsonDeUpload');

let app;
beforeAll(() => {
  app = require('../src/app');
});

beforeEach(() => {
  db.query.mockReset();
  // Loja inexistente: a rota de upload responde 404 — prova que o corpo
  // passou do parser e chegou nela.
  db.query.mockResolvedValue({ rows: [] });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); });

const MB = 1024 * 1024;
const corpoDe = (bytes) => ({ content_type: 'image/png', content_base64: 'A'.repeat(bytes) });

describe('parser de 25 MB so nas rotas de upload', () => {
  test('os caminhos montados sao os reais, com /api/v1', () => {
    expect(ROTAS_DE_UPLOAD).toEqual([
      '/api/v1/storefront/:slug/studio/upload',
      '/api/v1/companies/:id/studio/upload-mockup',
    ]);
  });

  test('vitrine: 6 MB de corpo chegam na rota (antes: 413 do parser global)', async () => {
    const r = await request(app).post('/api/v1/storefront/loja-inexistente/studio/upload').send(corpoDe(6 * MB));
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('Loja nao encontrada');
  });

  test('painel: 6 MB passam do parser (e param na autenticacao, nao no tamanho)', async () => {
    const r = await request(app)
      .post('/api/v1/companies/c0000000-0000-0000-0000-000000000001/studio/upload-mockup')
      .send(corpoDe(6 * MB));
    expect(r.status).not.toBe(413);
    expect(r.status).toBe(401);
  });

  test('qualquer outra rota continua com 5 MB', async () => {
    const r = await request(app).post('/api/v1/storefront/loja-inexistente/studio/cotacao').send(corpoDe(6 * MB));
    expect(r.status).toBe(413);
  });

  test('acima de 25 MB: 413 com JSON em portugues', async () => {
    const r = await request(app).post('/api/v1/storefront/loja-inexistente/studio/upload').send(corpoDe(26 * MB));
    expect(r.status).toBe(413);
    expect(r.body).toEqual({ error: MENSAGEM_ARQUIVO_GRANDE });
    expect(r.body.error).toBe('arquivo muito grande (max 15MB)');
  });

  test('upload-mockup acima de 25 MB tambem', async () => {
    const r = await request(app)
      .post('/api/v1/companies/c0000000-0000-0000-0000-000000000001/studio/upload-mockup')
      .send(corpoDe(26 * MB));
    expect(r.status).toBe(413);
    expect(r.body).toEqual({ error: MENSAGEM_ARQUIVO_GRANDE });
  });
});

describe('jsonDeUpload', () => {
  test('outros erros de parse seguem para o tratador de erros (400, nao 413)', async () => {
    const express = require('express');
    const mini = express();
    mini.post('/u', jsonDeUpload({ limite: '1kb' }), (req, res) => res.json({ ok: true }));
    // eslint-disable-next-line no-unused-vars
    mini.use((err, req, res, next) => res.status(err.status || 500).json({ tipo: err.type }));
    const r = await request(mini).post('/u').set('Content-Type', 'application/json').send('{"quebrado":');
    expect(r.status).toBe(400);
    expect(r.body.tipo).toBe('entity.parse.failed');
    const grande = await request(mini).post('/u').send({ x: 'a'.repeat(2048) });
    expect(grande.status).toBe(413);
    expect(grande.body).toEqual({ error: MENSAGEM_ARQUIVO_GRANDE });
  });
});
