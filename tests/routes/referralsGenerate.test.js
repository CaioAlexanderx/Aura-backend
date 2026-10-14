// ============================================================
// POST /referrals/generate — codigo de indicacao (13/10/2026).
//
// O codigo novo nasce igual ao COMECAR: Negocio, 7 dias de teste, 20% no
// primeiro pagamento. O codigo ativo mas VENCIDO e renovado (o link que o
// cliente ja compartilhou volta a valer); o vigente e devolvido como esta.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../../src/config/database');
const router = require('../../src/routes/accessCodes');

const USER = '5c19f573-0943-4263-beba-805456e32b13';
const token = jwt.sign({ id: USER, role: 'owner' }, 'aura-test-secret-2026');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/referrals', router);
  return app;
}
const gerar = () => request(makeApp()).post('/referrals/generate').set('Authorization', 'Bearer ' + token);

afterEach(() => db.query.mockReset());

describe('POST /referrals/generate', () => {
  test('sem codigo: cria Negocio, 7 dias, 20%, 5 usos e 90 dias', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/FROM access_codes WHERE referrer_id/.test(sql)) return { rows: [] };
      if (/FROM users WHERE id/.test(sql)) return { rows: [{ full_name: 'Maria Silva' }] };
      return { rows: [] };
    });
    const res = await gerar();
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^REF-MARIA[0-9A-F]{4}$/);
    const insert = db.query.mock.calls.find(([s]) => /INSERT INTO access_codes/.test(s));
    expect(insert[0]).toMatch(/trial_days/);
    expect(insert[0]).toContain("INTERVAL '90 days'");
    // [code, plan, trial_days, referrer_id]
    expect(insert[1].slice(1)).toEqual(['negocio', 7, USER]);
  });

  test('codigo vigente e devolvido como esta, sem escrita', async () => {
    db.query.mockResolvedValue({
      rows: [{ id: 'c1', code: 'REF-MARIAC9C5', expires_at: new Date(Date.now() + 30 * 86400000) }],
    });
    const res = await gerar();
    expect(res.body).toEqual({ code: 'REF-MARIAC9C5', existing: true, renewed: false });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('codigo ativo mas vencido e renovado por 90 dias, mesmo codigo', async () => {
    db.query.mockResolvedValue({
      rows: [{ id: 'c1', code: 'REF-CAIO1D05', expires_at: new Date('2026-07-21T00:00:00Z') }],
    });
    const res = await gerar();
    expect(res.body).toEqual({ code: 'REF-CAIO1D05', existing: true, renewed: true });
    const upd = db.query.mock.calls.find(([s]) => /UPDATE access_codes SET expires_at/.test(s));
    expect(upd[0]).toContain("INTERVAL '90 days'");
    expect(upd[1]).toEqual(['c1']);
  });
});
