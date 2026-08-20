// ============================================================
// AURA DOJÔ — Testes Integração: F3a motor de mensalidades (charge-based)
// Cobre:
//   planos: POST cria (escopo dojo_id do token) + amount<=0 → 422
//   subscribe: herda amount/due_day do plano quando omitidos
//   generate: cria 1 e REGERAR skipa (idempotente — ON CONFLICT)
//   charges: overdue DERIVADO na leitura + summary
//   confirm: pending→paid e já paga → 200 already_paid:true (idempotente)
//   cancel: de cobrança paga → 409 CHARGE_ALREADY_PAID
//   Canal B: GET charges ok / POST generate 403 PORTAL_READ_ONLY
//   pix sem chave configurada → 409 PIX_NAO_CONFIGURADO
//   escopo — queries SEMPRE parametrizadas por req.dojoId (nunca do body)
//
// Padrão karateDojoStudents.test.js: db.query.mockReset() em afterEach
// (jest.clearAllMocks NÃO drena filas mockResolvedValueOnce).
// ============================================================
'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
});

const SECRET = 'aura-test-secret-2026';
const fedId = 'fed00000-0000-0000-0000-000000000001';
const dojoId = 'd0000000-0000-0000-0000-000000000002';
const sid = 'a1000000-0000-0000-0000-00000000000a';
const cid = 'c1000000-0000-0000-0000-00000000000c';
const base = `/api/v1/federation/${fedId}/dojo/billing`;

const canalA = () => ({
  Authorization: `Bearer ${jwt.sign(
    { id: 'u1', email: 'sensei@dojo.com.br', type: 'access', dojo_id: dojoId, federation_id: fedId },
    SECRET,
    { expiresIn: '1h' }
  )}`,
});

const canalB = () => ({
  Authorization: `Bearer ${jwt.sign(
    { type: 'portal', scope: 'dojo_portal', dojo_id: dojoId, federation_id: fedId },
    SECRET,
    { expiresIn: '1h' }
  )}`,
});

afterEach(() => {
  db.query.mockReset();
});

const chargeRow = (over = {}) => ({
  id: cid,
  competence: '2020-01',
  amount: '140.00',
  due_date: '2020-01-05',
  status: 'pending',
  paid_at: null,
  payment_method: null,
  pix_txid: null,
  student_id: sid,
  student_name: 'Aluno Teste',
  guardian_id: null,
  guardian_name: null,
  ...over,
});

describe('F3a — motor de mensalidades do dojô (charge-based)', () => {
  test('GET plans sem token → 401', async () => {
    const res = await request(app).get(`${base}/plans`);
    expect(res.status).toBe(401);
  });

  test('POST plano (Canal A) → 201; dojo_id vem do TOKEN', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'p1', name: 'Mensal', amount: '140.00', due_day: 10, active: true }] });
    const res = await request(app)
      .post(`${base}/plans`)
      .set(canalA())
      .send({ name: 'Mensal', amount: 140, due_day: 10 });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('p1');
    expect(res.body.amount).toBe(140);
    expect(res.body.due_day).toBe(10);
    expect(res.body.students_count).toBe(0);
    // escopo: dojo_id do INSERT é o do token
    expect(db.query.mock.calls[0][1][0]).toBe(dojoId);
  });

  test('POST plano amount<=0 → 422 VALIDATION_ERROR (sem tocar o banco)', async () => {
    const res = await request(app)
      .post(`${base}/plans`)
      .set(canalA())
      .send({ name: 'Grátis', amount: 0, due_day: 10 });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('POST plano due_day fora de 1-28 → 422', async () => {
    const res = await request(app)
      .post(`${base}/plans`)
      .set(canalA())
      .send({ name: 'Mensal', amount: 140, due_day: 31 });
    expect(res.status).toBe(422);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('subscribe herda amount/due_day do plano quando omitidos', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: sid }] })                                  // aluno do dojô
      .mockResolvedValueOnce({ rows: [{ id: 'p1', amount: '140.00', due_day: 10 }] })  // plano
      .mockResolvedValueOnce({ rows: [] })                                             // sem assinatura ativa
      .mockResolvedValueOnce({ rows: [{ id: 'sub1', student_id: sid, plan_id: 'p1', amount: '140.00', due_day: 10, payer_guardian_id: null, active_from: '2026-07-19', canceled_at: null }] });

    const res = await request(app)
      .post(`${base}/students/${sid}/subscribe`)
      .set(canalA())
      .send({ plan_id: 'p1' });

    expect(res.status).toBe(201);
    expect(res.body.amount).toBe(140);
    expect(res.body.due_day).toBe(10);
    expect(res.body.plan_id).toBe('p1');
    expect(res.body.canceled_at).toBeNull();
    // escopo: aluno buscado por [sid, dojoId]
    expect(db.query.mock.calls[0][1]).toEqual([sid, dojoId]);
  });

  test('generate cria 1 cobrança; REGERAR skipa (idempotente)', async () => {
    // 1ª geração: 1 assinatura ativa, INSERT retorna 1 linha
    db.query
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })      // count assinaturas ativas
      .mockResolvedValueOnce({ rows: [{ id: 'ch1' }] }); // INSERT ... RETURNING
    const r1 = await request(app).post(`${base}/generate`).set(canalA()).send({ competence: '2026-07' });
    expect(r1.status).toBe(200);
    expect(r1.body).toEqual({ created: 1, skipped: 0 });
    // escopo do count por dojô do token
    expect(db.query.mock.calls[0][1][0]).toBe(dojoId);
    // EXP3: inativar aluno PARA de cobrar — count e INSERT filtram s.status='active'
    expect(String(db.query.mock.calls[0][0])).toMatch(/s\.status = 'active'/);
    expect(String(db.query.mock.calls[1][0])).toMatch(/s\.status = 'active'/);

    db.query.mockReset();

    // regerar: mesma assinatura, ON CONFLICT DO NOTHING → 0 linhas
    db.query
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })  // count
      .mockResolvedValueOnce({ rows: [] });          // INSERT ... RETURNING (conflito)
    const r2 = await request(app).post(`${base}/generate`).set(canalA()).send({ competence: '2026-07' });
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual({ created: 0, skipped: 1 });
  });

  test('generate competence inválida → 422', async () => {
    const res = await request(app).post(`${base}/generate`).set(canalA()).send({ competence: '2026/07' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('GET charges — overdue DERIVADO na leitura + summary', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        chargeRow(),                                                                         // pending + due_date no passado → overdue
        chargeRow({ id: 'c2', due_date: '2020-01-31', status: 'paid', payment_method: 'pix', pix_txid: 'DJ1', student_name: 'Bruno' }),
      ],
    });
    const res = await request(app).get(`${base}/charges?competence=2020-01`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    const overdue = res.body.data.find((c) => c.id === cid);
    expect(overdue.status).toBe('overdue');  // banco tem 'pending'; leitura derivou
    const paid = res.body.data.find((c) => c.id === 'c2');
    expect(paid.status).toBe('paid');
    expect(paid.has_pix).toBe(true);
    expect(res.body.summary).toEqual({ total_amount: 280, paid_amount: 140, pending_count: 0, overdue_count: 1, paid_count: 1 });
    // escopo por dojô do token
    expect(db.query.mock.calls[0][1][0]).toBe(dojoId);
  });

  test('confirm pending → paid (already_paid:false)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: cid, status: 'pending' }] })                                  // SELECT status
      .mockResolvedValueOnce({ rows: [] })                                                                // UPDATE
      .mockResolvedValueOnce({ rows: [chargeRow({ status: 'paid', paid_at: '2026-07-19T00:00:00Z', payment_method: 'dinheiro' })] }); // shaped
    const res = await request(app).post(`${base}/charges/${cid}/confirm`).set(canalA()).send({ method: 'dinheiro' });

    expect(res.status).toBe(200);
    expect(res.body.already_paid).toBe(false);
    expect(res.body.status).toBe('paid');
  });

  test('confirm de cobrança JÁ paga → 200 already_paid:true (idempotente)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: cid, status: 'paid' }] })                                     // SELECT status
      .mockResolvedValueOnce({ rows: [chargeRow({ status: 'paid', paid_at: '2026-07-19T00:00:00Z', payment_method: 'pix' })] }); // shaped
    const res = await request(app).post(`${base}/charges/${cid}/confirm`).set(canalA()).send({});

    expect(res.status).toBe(200);
    expect(res.body.already_paid).toBe(true);
    expect(res.body.status).toBe('paid');
  });

  test('cancel de cobrança PAGA → 409 CHARGE_ALREADY_PAID', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: cid, status: 'paid' }] });
    const res = await request(app).post(`${base}/charges/${cid}/cancel`).set(canalA());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CHARGE_ALREADY_PAID');
  });

  test('Canal B: GET charges OK / POST generate 403 PORTAL_READ_ONLY', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const g = await request(app).get(`${base}/charges`).set(canalB());
    expect(g.status).toBe(200);
    expect(g.body.summary).toBeDefined();

    db.query.mockReset();
    const p = await request(app).post(`${base}/generate`).set(canalB()).send({ competence: '2026-07' });
    expect(p.status).toBe(403);
    expect(p.body.code).toBe('PORTAL_READ_ONLY');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('pix sem chave configurada no dojô → 409 PIX_NAO_CONFIGURADO', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: cid, amount: '140.00', competence: '2026-07', status: 'pending' }] }) // SELECT charge
      .mockResolvedValueOnce({ rows: [] });                                                                        // config sem pix_key
    const res = await request(app).post(`${base}/charges/${cid}/pix`).set(canalA());

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PIX_NAO_CONFIGURADO');
  });

  test('GET config — chave mascarada quando configurada', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ pix_key: '12345678900', pix_key_type: 'CPF', pix_holder_name: null, pix_holder_city: null }] });
    const res = await request(app).get(`${base}/config`).set(canalA());
    expect(res.status).toBe(200);
    expect(res.body.pix_configured).toBe(true);
    expect(res.body.pix_key_type).toBe('CPF');
    expect(res.body.pix_key_masked).not.toContain('345678'); // mascarado, não vaza o miolo
  });
});
