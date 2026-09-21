// ============================================================
// Pedidos de disparo preparados para aprovação (migration 348, 18/09/2026)
//
//  (1) aprovar: reserva atômica com quem aprovou; executa pelo caminho do
//      painel (sendBannerEmail) com sentBy = aprovador; resultado gravado.
//  (2) pedido já decidido / expirado / inexistente → 409/404, nada enviado.
//  (3) ação fora da lista branca → failed, nada enviado.
//  (4) envio recusado pelas regras do painel → failed (422), registrado.
//  (5) recusar não executa; lista devolve [] sem a migration.
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: 'staff-1', role: 'admin' }; next(); },
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/notificationEmail', () => ({
  sendBannerEmail: jest.fn(),
  listRecipients: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const { sendBannerEmail } = require('../src/services/notificationEmail');

const REQ = '11111111-2222-4333-8444-555555555555';
const BANNER = '8f6af433-9b4a-420f-82e2-ff157c2f5452';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/admin', require('../src/routes/adminDispatchRequests'));
  return a;
}

const row = (over = {}) => ({
  id: REQ, action: 'notification_email', status: 'processing',
  payload: { notification_id: BANNER, subject: 'Vence hoje', pix: { code: '000201abc' } }, ...over,
});

beforeEach(() => { db.query.mockReset(); sendBannerEmail.mockReset(); });

describe('aprovar', () => {
  test('reserva com o aprovador, executa e grava done', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [row()] })   // claim
      .mockResolvedValueOnce({ rows: [] });       // finish
    sendBannerEmail.mockResolvedValue({ status: 200, body: { sent: [{ email: 'a@b.com' }], failed: [] } });

    const r = await request(app()).post(`/admin/dispatch-requests/${REQ}/approve`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('done');

    const [claimSql, claimArgs] = db.query.mock.calls[0];
    expect(claimSql).toMatch(/status = 'awaiting_approval' AND expires_at > NOW\(\)/);
    expect(claimArgs).toEqual([REQ, 'staff-1']);
    expect(sendBannerEmail).toHaveBeenCalledWith({
      notificationId: BANNER, recipients: null, subject: 'Vence hoje', pix: { code: '000201abc' }, sentBy: 'staff-1',
    });
    const [, finishArgs] = db.query.mock.calls[1];
    expect(finishArgs[1]).toBe('done');
  });

  test('já decidido → 409 e nada enviado', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ status: 'done' }] });
    const r = await request(app()).post(`/admin/dispatch-requests/${REQ}/approve`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PEDIDO_JA_DECIDIDO');
    expect(sendBannerEmail).not.toHaveBeenCalled();
  });

  test('expirado → 409 PEDIDO_EXPIRADO; inexistente → 404', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ status: 'awaiting_approval' }] });
    const r = await request(app()).post(`/admin/dispatch-requests/${REQ}/approve`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PEDIDO_EXPIRADO');

    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    expect((await request(app()).post(`/admin/dispatch-requests/${REQ}/approve`)).status).toBe(404);
    expect(sendBannerEmail).not.toHaveBeenCalled();
  });

  test('ação fora da lista branca → failed, nada enviado', async () => {
    db.query.mockResolvedValueOnce({ rows: [row({ action: 'drop_table' })] }).mockResolvedValueOnce({ rows: [] });
    const r = await request(app()).post(`/admin/dispatch-requests/${REQ}/approve`);
    expect(r.status).toBe(400);
    expect(db.query.mock.calls[1][1][1]).toBe('failed');
    expect(sendBannerEmail).not.toHaveBeenCalled();
  });

  test('regra do painel recusa (ex.: destinatário de fora) → 422 e failed gravado', async () => {
    db.query.mockResolvedValueOnce({ rows: [row()] }).mockResolvedValueOnce({ rows: [] });
    sendBannerEmail.mockResolvedValue({ status: 400, body: { error: 'Destinatário fora do cadastro da empresa' } });
    const r = await request(app()).post(`/admin/dispatch-requests/${REQ}/approve`);
    expect(r.status).toBe(422);
    const finishArgs = db.query.mock.calls[1][1];
    expect(finishArgs[1]).toBe('failed');
    expect(finishArgs[3]).toBe('Destinatário fora do cadastro da empresa');
  });

  test('id malformado → 400 sem ir ao banco', async () => {
    expect((await request(app()).post('/admin/dispatch-requests/x/approve')).status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('recusar e listar', () => {
  test('recusar grava rejected e não executa', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: REQ }] });
    const r = await request(app()).post(`/admin/dispatch-requests/${REQ}/reject`);
    expect(r.status).toBe(200);
    expect(db.query.mock.calls[0][0]).toMatch(/SET status = 'rejected'/);
    expect(sendBannerEmail).not.toHaveBeenCalled();
  });

  test('sem a migration 348 a lista vem vazia', async () => {
    const e = new Error('relation does not exist'); e.code = '42P01';
    db.query.mockRejectedValueOnce(e);
    const r = await request(app()).get('/admin/dispatch-requests');
    expect(r.status).toBe(200);
    expect(r.body.requests).toEqual([]);
  });
});
