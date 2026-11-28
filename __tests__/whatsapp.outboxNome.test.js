// ============================================================
// AURA — GET /whatsapp/outbox devolve customer_name
// A tela "Mensagens > Enviadas" mostra o nome da cliente em vez do
// telefone. O nome vem do cadastro (LEFT JOIN em customers pelo telefone,
// sempre da mesma empresa); sem cliente, o campo vem null.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const db = require('../src/config/database');

const COMPANY = 'company-uuid-outbox';
const token = jwt.sign(
  { id: 'user-admin', role: 'admin', plan: 'essencial' },
  'aura-test-secret-2026', { expiresIn: '1h' }
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id', require('../src/routes/whatsappCloud'));
  return app;
}

afterEach(() => { if (typeof db.query.mockReset === 'function') db.query.mockReset(); });

function linha(extra) {
  return Object.assign({
    id: 'ob-1', to_phone: '5511988887777', kind: 'template', template_name: 'x',
    status: 'sent', skip_reason: null, attempts: 1, last_error: null,
    source_type: 'teste', created_at: '2026-11-28T12:00:00Z', updated_at: '2026-11-28T12:00:00Z',
  }, extra);
}

it('com cliente cadastrada: devolve customer_name como esta no cadastro', async () => {
  db.query.mockResolvedValue({ rows: [linha({ customer_name: 'Maria da Silva' })] });
  const r = await request(buildApp()).get(`/companies/${COMPANY}/whatsapp/outbox`).set('Authorization', 'Bearer ' + token);
  expect(r.status).toBe(200);
  expect(r.body.data[0].customer_name).toBe('Maria da Silva');
});

it('sem cliente: customer_name vem null', async () => {
  db.query.mockResolvedValue({ rows: [linha({ customer_name: null })] });
  const r = await request(buildApp()).get(`/companies/${COMPANY}/whatsapp/outbox`).set('Authorization', 'Bearer ' + token);
  expect(r.status).toBe(200);
  expect(r.body.data[0].customer_name).toBeNull();
});

it('a consulta junta cliente so da mesma empresa e filtra a fila pela empresa da rota', async () => {
  db.query.mockResolvedValue({ rows: [] });
  await request(buildApp()).get(`/companies/${COMPANY}/whatsapp/outbox`).set('Authorization', 'Bearer ' + token);
  const call = db.query.mock.calls.find(([sql]) => /FROM wa_outbox o/.test(String(sql)));
  expect(call).toBeTruthy();
  const sql = String(call[0]);
  expect(sql).toMatch(/LEFT JOIN LATERAL/);
  expect(sql).toMatch(/c\.company_id = o\.company_id/);
  expect(sql).toMatch(/WHERE o\.company_id = \$1/);
  expect(call[1]).toEqual([COMPANY]);
});

it('sem token: 401, nada e consultado', async () => {
  const r = await request(buildApp()).get(`/companies/${COMPANY}/whatsapp/outbox`);
  expect(r.status).toBe(401);
  expect(db.query).not.toHaveBeenCalled();
});
