// ============================================================
// AURA KARATÊ — Testes: proteção P0 "praticante inativo não pode receber
// baixa/cobrança" (409 MEMBER_INACTIVE).
//
// Ver/listar praticante inativo (member_status=all/inactive na listagem)
// continua permitido — este arquivo cobre só o lado de MUTAÇÃO: as duas
// rotas que dão baixa/lançam cobrança pra um practitioner_id precisam
// revalidar customers.is_active NO SERVIDOR, mesmo que a listagem já
// tenha mostrado o praticante (member_status pode ter sido usado só pra
// auditoria, não uma autorização implícita pra agir).
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
const practitionerId = 'c1000000-0000-0000-0000-00000000000c';
const installmentId = 'inst-cpf-1';
const financialBase = `/api/v1/federation/${fedId}/financial`;

const authHeader = () => ({
  Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client' }, SECRET, { expiresIn: '1h' })}`,
});

function mockCompanyAccess() {
  db.query.mockResolvedValueOnce({ rows: [{ role: 'federation_admin' }] });
}

afterEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
});

describe('POST /annuities/cpf/:practitionerId/charge — proteção P0 MEMBER_INACTIVE', () => {
  test('praticante inativo -> 409 MEMBER_INACTIVE, ROLLBACK, nenhuma cobrança criada', async () => {
    mockCompanyAccess();
    const calls = [];
    const client = {
      query: jest.fn((sql, params) => {
        const text = String(sql).trim();
        calls.push(text);
        if (/^BEGIN/.test(text)) return Promise.resolve({});
        if (/^ROLLBACK/.test(text)) return Promise.resolve({});
        if (/^SELECT id, name AS full_name, cpf_cnpj, is_active/.test(text)) {
          return Promise.resolve({ rows: [{ id: practitionerId, full_name: 'Praticante Inativo', cpf_cnpj: null, is_active: false }] });
        }
        throw new Error('query inesperada: ' + text);
      }),
      release: jest.fn(),
    };
    db.connect.mockResolvedValueOnce(client);

    const res = await request(app)
      .post(`${financialBase}/annuities/cpf/${practitionerId}/charge`)
      .set(authHeader())
      .send({ reference_period: '2026', amount: 100, due_date: '2026-05-31' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('MEMBER_INACTIVE');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    // nenhum INSERT em karate_dojo_annuity_history/transactions foi tentado
    expect(calls.some((t) => /INSERT/.test(t))).toBe(false);
  });

  test('praticante ativo: passa da checagem de is_active (segue fluxo normal)', async () => {
    mockCompanyAccess();
    const client = {
      query: jest.fn((sql) => {
        const text = String(sql).trim();
        if (/^BEGIN/.test(text)) return Promise.resolve({});
        if (/^ROLLBACK/.test(text)) return Promise.resolve({});
        if (/^SELECT id, name AS full_name, cpf_cnpj, is_active/.test(text)) {
          return Promise.resolve({ rows: [{ id: practitionerId, full_name: 'Praticante Ativo', cpf_cnpj: null, is_active: true }] });
        }
        // Deixa o resto (advisory lock, dedupe, insert) explodir de propósito
        // pra provar que passou da checagem de is_active sem 409 — o teste
        // só precisa confirmar que NÃO caiu no 409 MEMBER_INACTIVE.
        return Promise.reject(new Error('fim do escopo deste teste'));
      }),
      release: jest.fn(),
    };
    db.connect.mockResolvedValueOnce(client);

    const res = await request(app)
      .post(`${financialBase}/annuities/cpf/${practitionerId}/charge`)
      .set(authHeader())
      .send({ reference_period: '2026', amount: 100, due_date: '2026-05-31' });

    expect(res.status).not.toBe(409);
  });
});

describe('POST /annuities/installments/:installmentId/pay — proteção P0 MEMBER_INACTIVE', () => {
  test('parcela de PRATICANTE inativo -> 409 MEMBER_INACTIVE, motor de pagamento nunca chamado', async () => {
    mockCompanyAccess();
    db.query.mockResolvedValueOnce({
      rows: [{
        id: installmentId, annuity_id: 'annuity-1', seq: 1, amount: '100.00', amount_paid: '0',
        status: 'pending', due_date: '2026-05-31', kind: 'anuidade',
        federation_id: fedId, dojo_id: null, practitioner_id: practitionerId,
        reference_period: '2026', plan: 'anual', ref_name: 'Praticante Inativo',
        practitioner_is_active: false,
      }],
    });

    const res = await request(app)
      .post(`${financialBase}/annuities/installments/${installmentId}/pay`)
      .set(authHeader())
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('MEMBER_INACTIVE');
    // só a query de busca da parcela rodou (1 role check + 1 SELECT parcela)
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  test('parcela de PRATICANTE inativo, mas JÁ PAGA -> 200 idempotent_hit (replay não é bloqueado)', async () => {
    mockCompanyAccess();
    db.query.mockResolvedValueOnce({
      rows: [{
        id: installmentId, annuity_id: 'annuity-1', seq: 1, amount: '100.00', amount_paid: '100.00',
        status: 'paid', due_date: '2026-05-31', kind: 'anuidade', paid_at: '2026-06-01T12:00:00-03:00',
        payment_method: 'pix', transaction_id: 'txn-1',
        federation_id: fedId, dojo_id: null, practitioner_id: practitionerId,
        reference_period: '2026', plan: 'anual', ref_name: 'Praticante Inativo',
        practitioner_is_active: false,
      }],
    });

    const res = await request(app)
      .post(`${financialBase}/annuities/installments/${installmentId}/pay`)
      .set(authHeader())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.idempotent_hit).toBe(true);
  });

  test('parcela de DOJÔ (sem practitioner_id) nunca é bloqueada por este critério, mesmo com o campo ausente', async () => {
    mockCompanyAccess();
    // parcela de dojô: dojo_id setado, practitioner_id null -> a checagem
    // é pulada mesmo que practitioner_is_active venha undefined (join
    // LEFT JOIN customers sem match).
    db.query
      .mockResolvedValueOnce({
        rows: [{
          id: installmentId, annuity_id: 'annuity-1', seq: 1, amount: '100.00', amount_paid: '0',
          status: 'pending', due_date: '2026-05-31', kind: 'anuidade',
          federation_id: fedId, dojo_id: 'dojo-1', practitioner_id: null,
          reference_period: '2026', plan: 'anual', ref_name: 'Dojô Teste',
          practitioner_is_active: null, transaction_id: 'txn-dojo-1',
        }],
      })
      .mockRejectedValueOnce(new Error('fim do escopo deste teste — só valida que não caiu em 409'));

    const res = await request(app)
      .post(`${financialBase}/annuities/installments/${installmentId}/pay`)
      .set(authHeader())
      .send({});

    expect(res.status).not.toBe(409);
  });
});
