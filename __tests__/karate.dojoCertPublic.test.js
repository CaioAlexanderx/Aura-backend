// ============================================================
// AURA DOJÔ — F9.1 (público): verificação do certificado do dojô
//
// Cobre: certificado válido devolve certificate_type:'dojo' +
// official:false + aviso textual (nunca pode ser confundido com o
// certificado OFICIAL da federação); revogado; token inexistente;
// tabela ainda não migrada (42P01) degrada para 404 em vez de 500.
//
// Mock por SQL — aqui só existe UMA query nesta rota (sem âncora `--`,
// é curta o bastante para dispensar), então o mock despacha por
// db.query.mockImplementation direto por cenário, sem tabela de estado.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const publicRouter = require('../src/routes/karateDojoCertPublic');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/public/karate', publicRouter);
  return app;
}

beforeEach(() => {
  db.query.mockReset();
});

test('token válido devolve certificate_type dojo + official:false + notice', async () => {
  db.query.mockResolvedValueOnce({
    rows: [{
      data_snapshot: { participant_name: 'Aluna Federada' },
      template_snapshot: { layout: 'A' },
      revoked: false,
      issued_at: '2026-08-04T10:00:00Z',
      dojo_name: 'Dojô Kondei',
    }],
  });
  const res = await request(buildApp()).get('/public/karate/verify/dojo-cert/abc123');
  expect(res.status).toBe(200);
  expect(res.body.valid).toBe(true);
  expect(res.body.certificate_type).toBe('dojo');
  expect(res.body.official).toBe(false);
  expect(res.body.notice).toMatch(/próprio dojô/i);
  expect(res.body.notice).toMatch(/federação \(fpkt\)/i);
  expect(res.body.dojo_name).toBe('Dojô Kondei');
});

test('certificado revogado é valid:false com revoked:true, sem vazar dados', async () => {
  db.query.mockResolvedValueOnce({
    rows: [{ data_snapshot: {}, template_snapshot: {}, revoked: true, issued_at: '2026-08-04T10:00:00Z', dojo_name: 'Dojô Kondei' }],
  });
  const res = await request(buildApp()).get('/public/karate/verify/dojo-cert/revoked-token');
  expect(res.status).toBe(200);
  expect(res.body.valid).toBe(false);
  expect(res.body.revoked).toBe(true);
  expect(res.body.certificate_type).toBe('dojo');
  expect(res.body.data).toBeUndefined();
});

test('token inexistente é 404', async () => {
  db.query.mockResolvedValueOnce({ rows: [] });
  const res = await request(buildApp()).get('/public/karate/verify/dojo-cert/nao-existe');
  expect(res.status).toBe(404);
  expect(res.body.valid).toBe(false);
});

test('tabela ainda não migrada (42P01) degrada para 404, não 500', async () => {
  const err = new Error('relation "karate_dojo_issued_certificates" does not exist');
  err.code = '42P01';
  db.query.mockRejectedValueOnce(err);
  const res = await request(buildApp()).get('/public/karate/verify/dojo-cert/xyz');
  expect(res.status).toBe(404);
  expect(res.body.valid).toBe(false);
});
