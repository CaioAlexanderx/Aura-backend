// ============================================================
// Assento de temporada — rotas (13/10/2026)
//
//   GET    /companies/:id/billing/seat-pass         estado (qualquer membro)
//   POST   /companies/:id/billing/seat-pass         { qty } so o dono (e a Aura)
//   DELETE /companies/:id/billing/seat-pass/:passId cancela (dono/Aura)
//   POST   /admin/clients/:cid/seat-pass            cortesia/concessao (staff)
//
// O servico e' mockado: a regra e o SQL estao em
// tests/integration/seatPassLive.test.js (Postgres real). Aqui: quem pode,
// o que a rota repassa ao servico e como os erros do servico viram resposta.
// ============================================================
'use strict';

jest.mock('../src/services/seatPass', () => {
  const actual = jest.requireActual('../src/services/seatPass');
  return { ...actual, estado: jest.fn(), contratar: jest.fn(), cancelar: jest.fn() };
});

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../src/config/database');
const seatPass = require('../src/services/seatPass');
const { requireAuth, requireCompanyAccess } = require('../src/middleware/auth');

const CID = '00000000-0000-0000-0000-0000000000c1';
const PASS = '11111111-2222-4333-8444-555555555555';
const SECRET = 'aura-test-secret-2026';
const tok = (user) => ({ Authorization: 'Bearer ' + jwt.sign(user, SECRET, { expiresIn: '1h' }) });

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id/billing/seat-pass', requireAuth, requireCompanyAccess(), require('../src/routes/seatPass'));
  app.use('/admin', require('../src/routes/adminClients360'));
  return app;
}

let app;
let auditInserts;
beforeAll(() => { app = makeApp(); });

// role: papel da pessoa na empresa (owner | gerente | ...)
function comPapel(role) {
  auditInserts = [];
  db.query.mockImplementation(async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ');
    if (s.includes('AS role')) return { rows: role ? [{ role }] : [] };
    if (s.includes('INSERT INTO admin_audit_log')) { auditInserts.push({ s, params }); return { rows: [] }; }
    return { rows: [], rowCount: 0 };
  });
}

const dono = tok({ id: 'u-dono', role: 'client' });
const vendedor = tok({ id: 'u-vend', role: 'client' });
const staff = tok({ id: 'u-staff', role: 'admin' });

const contratado = {
  passe: { id: PASS, qty: 2, status: 'ativo', cortesia: false, starts_at: '2026-11-01', ends_at: '2027-01-31', aplicado: true },
  cobranca: { forma: 'assinatura_asaas', valor_mensal: 38, ate: '2027-01-31', texto: 'R$ 38,00 por mensalidade...' },
  comeca_em: '2026-11-01',
  aplicado_agora: true,
  mensagem: 'R$ 38,00 por mensalidade...',
};

beforeEach(() => {
  jest.clearAllMocks();
  comPapel('owner');
});

describe('GET /billing/seat-pass', () => {
  test('qualquer membro le o estado; ?qty vira previa', async () => {
    comPapel('vendedor');
    seatPass.estado.mockResolvedValue({ assentos_ativos: 0, pode_contratar: true });
    const res = await request(app).get(`/companies/${CID}/billing/seat-pass?qty=3`).set(vendedor);
    expect(res.status).toBe(200);
    expect(res.body.pode_contratar).toBe(true);
    expect(seatPass.estado).toHaveBeenCalledWith(CID, { previaQty: '3' });
  });

  test('sem token: 401; sem acesso a empresa: 403', async () => {
    expect((await request(app).get(`/companies/${CID}/billing/seat-pass`)).status).toBe(401);
    comPapel(null);
    expect((await request(app).get(`/companies/${CID}/billing/seat-pass`).set(vendedor)).status).toBe(403);
    expect(seatPass.estado).not.toHaveBeenCalled();
  });
});

describe('POST /billing/seat-pass', () => {
  test('dono contrata: 201 com o que sera cobrado e ate quando', async () => {
    seatPass.contratar.mockResolvedValue(contratado);
    const res = await request(app).post(`/companies/${CID}/billing/seat-pass`).set(dono).send({ qty: 2 });
    expect(res.status).toBe(201);
    expect(res.body.cobranca).toMatchObject({ valor_mensal: 38, ate: '2027-01-31' });
    expect(seatPass.contratar).toHaveBeenCalledWith({ companyId: CID, qty: 2, source: 'loja', userId: 'u-dono' });
  });

  test('quem nao e dono nao contrata (403 SOMENTE_DONO)', async () => {
    comPapel('vendedor');
    const res = await request(app).post(`/companies/${CID}/billing/seat-pass`).set(vendedor).send({ qty: 1 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SOMENTE_DONO');
    expect(seatPass.contratar).not.toHaveBeenCalled();
  });

  test('membro com role_label "admin" na empresa nao e o dono', async () => {
    comPapel('admin');
    const res = await request(app).post(`/companies/${CID}/billing/seat-pass`).set(vendedor).send({ qty: 1 });
    expect(res.status).toBe(403);
    expect(seatPass.contratar).not.toHaveBeenCalled();
  });

  test('a Aura (admin) contrata pela loja', async () => {
    seatPass.contratar.mockResolvedValue(contratado);
    const res = await request(app).post(`/companies/${CID}/billing/seat-pass`).set(staff).send({ qty: 1 });
    expect(res.status).toBe(201);
  });

  test('erro do servico vira status + code, sem 500', async () => {
    seatPass.contratar.mockRejectedValue(new seatPass.SeatPassError(409, 'SEM_ASSINATURA', 'Para contratar o assento ... assinatura ativa.'));
    const res = await request(app).post(`/companies/${CID}/billing/seat-pass`).set(dono).send({ qty: 1 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SEM_ASSINATURA' });
    expect(res.body.error).toMatch(/assinatura/);
  });

  test('falha inesperada: 500 generico', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    seatPass.contratar.mockRejectedValue(new Error('boom'));
    const res = await request(app).post(`/companies/${CID}/billing/seat-pass`).set(dono).send({ qty: 1 });
    expect(res.status).toBe(500);
    expect(res.body.error).not.toMatch(/boom/);
  });
});

describe('DELETE /billing/seat-pass/:passId', () => {
  test('dono cancela', async () => {
    seatPass.cancelar.mockResolvedValue({ cancelado: true, assentos_removidos: 2 });
    const res = await request(app).delete(`/companies/${CID}/billing/seat-pass/${PASS}`).set(dono);
    expect(res.status).toBe(200);
    expect(seatPass.cancelar).toHaveBeenCalledWith({ companyId: CID, passId: PASS, userId: 'u-dono', source: 'loja' });
  });

  test('admin cancela marcando a origem', async () => {
    seatPass.cancelar.mockResolvedValue({ cancelado: true, assentos_removidos: 0 });
    await request(app).delete(`/companies/${CID}/billing/seat-pass/${PASS}`).set(staff);
    expect(seatPass.cancelar.mock.calls[0][0]).toMatchObject({ source: 'admin' });
  });

  test('membro nao dono: 403; id malformado: 404 sem ir ao servico', async () => {
    comPapel('vendedor');
    expect((await request(app).delete(`/companies/${CID}/billing/seat-pass/${PASS}`).set(vendedor)).status).toBe(403);
    comPapel('owner');
    expect((await request(app).delete(`/companies/${CID}/billing/seat-pass/nao-e-uuid`).set(dono)).status).toBe(404);
    expect(seatPass.cancelar).not.toHaveBeenCalled();
  });

  test('passe inexistente: 404 do servico', async () => {
    seatPass.cancelar.mockRejectedValue(new seatPass.SeatPassError(404, 'PASSE_NAO_ENCONTRADO', 'nao encontrado'));
    const res = await request(app).delete(`/companies/${CID}/billing/seat-pass/${PASS}`).set(dono);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PASSE_NAO_ENCONTRADO');
  });
});

describe('POST /admin/clients/:cid/seat-pass (Gestao Aura)', () => {
  test('so staff', async () => {
    const res = await request(app).post(`/admin/clients/${CID}/seat-pass`).set(dono).send({ qty: 1 });
    expect(res.status).toBe(403);
    expect(seatPass.contratar).not.toHaveBeenCalled();
  });

  test('concede como admin, com o motivo, e audita em admin_audit_log', async () => {
    seatPass.contratar.mockResolvedValue({
      ...contratado,
      passe: { ...contratado.passe, cortesia: true },
      cobranca: { forma: 'cortesia', valor_mensal: 0, ate: '2027-01-31', texto: 'Cortesia da Aura' },
    });
    const res = await request(app).post(`/admin/clients/${CID}/seat-pass`).set(staff)
      .send({ qty: 2, reason: '  vendedora de natal ' });
    expect(res.status).toBe(201);
    expect(res.body.cobranca.forma).toBe('cortesia');
    expect(seatPass.contratar).toHaveBeenCalledWith({
      companyId: CID, qty: 2, source: 'admin', userId: 'u-staff', reason: 'vendedora de natal',
    });
    expect(auditInserts).toHaveLength(1);
    expect(auditInserts[0].s).toContain('staff_user_id, company_id, action, payload, reason');
    expect(auditInserts[0].params[0]).toBe('u-staff');
    expect(auditInserts[0].params[1]).toBe(CID);
    expect(JSON.parse(auditInserts[0].params[2])).toMatchObject({ qty: 2, cortesia: true, ends_at: '2027-01-31' });
  });

  test('erro de regra volta com code', async () => {
    seatPass.contratar.mockRejectedValue(new seatPass.SeatPassError(409, 'TEMPORADA_ENCERRADA', 'A temporada terminou em 31/01/2027.'));
    const res = await request(app).post(`/admin/clients/${CID}/seat-pass`).set(staff).send({ qty: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TEMPORADA_ENCERRADA');
    expect(auditInserts).toHaveLength(0);
  });
});
