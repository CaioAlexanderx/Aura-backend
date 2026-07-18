// ============================================================
// AURA KARATÊ — Testes Integração: F0 claim da conta do dojô
// Cobre:
//   POST   /federation/:id/dojos/:dojoId/claim-invite  (staffWrite)
//   POST   /public/karate/dojo-claim/verify
//   POST   /public/karate/dojo-claim/complete
//
// Ordem dos mocks db.query DEVE espelhar a ordem real dos handlers:
//   claim-invite: 1) requireCompanyAccess (role)
//                 2) SELECT dojô+owner   3) UPDATE invalida pendentes
//                 4) INSERT convite RETURNING
//   verify:       1) SELECT convite (join nomes)
//   complete:     transação via db.connect() — client mock em ordem:
//                 BEGIN, SELECT FOR UPDATE, SELECT user, INSERT user,
//                 UPDATE companies(owner_id), SELECT member, INSERT member,
//                 UPDATE used_at, COMMIT
//
// REGRA CRÍTICA: db.query.mockReset() em afterEach — jest.clearAllMocks
// NÃO drena filas mockResolvedValueOnce. Para db.connect usamos
// mockImplementationOnce (preserva a implementação base do jest.setup).
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
const LOCKED = '!locked-system-no-login';
const FUTURE = () => new Date(Date.now() + 7 * 86400000).toISOString();
const PAST = () => new Date(Date.now() - 86400000).toISOString();

const authHeader = () => ({
  Authorization: `Bearer ${jwt.sign(
    { id: 'u1', role: 'client', plan: 'negocio' },
    SECRET,
    { expiresIn: '1h' }
  )}`,
});

afterEach(() => {
  db.query.mockReset();
});

function mockCompanyAccess() {
  db.query.mockResolvedValueOnce({ rows: [{ role: 'federation_admin' }] });
}

// Client de transação: fila Once na ordem exata + default vazio p/ excedentes
function makeTxClient(queue) {
  const client = { query: jest.fn(), release: jest.fn() };
  client.query.mockResolvedValue({ rows: [], rowCount: 0 });
  for (const item of queue) client.query.mockResolvedValueOnce(item);
  return client;
}

const inviteRow = (over = {}) => ({
  id: 'inv-1',
  dojo_id: dojoId,
  email: 'sensei@dojo.com.br',
  expires_at: FUTURE(),
  used_at: null,
  current_owner_id: 'sys-user',
  owner_password_hash: LOCKED,
  dojo_name: 'Dojô Fênix',
  federation_name: 'FPKT',
  ...over,
});

describe('F0 — claim da conta do dojô', () => {
  test('claim-invite exige auth (401 sem token)', async () => {
    const res = await request(app)
      .post(`/api/v1/federation/${fedId}/dojos/${dojoId}/claim-invite`)
      .send({ email: 'sensei@dojo.com.br' });
    expect(res.status).toBe(401);
  });

  test('fluxo completo: convite → verify → complete troca o owner', async () => {
    // 1) POST claim-invite (federação)
    mockCompanyAccess();
    db.query
      .mockResolvedValueOnce({
        rows: [{
          id: dojoId,
          owner_id: 'sys-user',
          dojo_name: 'Dojô Fênix',
          federation_name: 'FPKT',
          federation_slug: 'fpkt',
          owner_password_hash: LOCKED,
        }],
      })
      .mockResolvedValueOnce({ rowCount: 0 }) // invalida pendentes anteriores
      .mockResolvedValueOnce({ rows: [{ id: 'inv-1', expires_at: FUTURE() }] });

    const inviteRes = await request(app)
      .post(`/api/v1/federation/${fedId}/dojos/${dojoId}/claim-invite`)
      .set(authHeader())
      .send({ email: 'sensei@dojo.com.br' });

    expect(inviteRes.status).toBe(201);
    expect(inviteRes.body.expires_at).toBeTruthy();
    // o token NUNCA sai na resposta da federação (vai só no e-mail)
    expect(inviteRes.body.token).toBeUndefined();

    // 2) POST /verify (público)
    db.query.mockReset();
    db.query.mockResolvedValueOnce({ rows: [inviteRow()] });

    const verifyRes = await request(app)
      .post('/api/v1/public/karate/dojo-claim/verify')
      .send({ token: 'tok-qualquer' });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.dojoName).toBe('Dojô Fênix');
    expect(verifyRes.body.federationName).toBe('FPKT');
    expect(verifyRes.body.email).toBe('s***@d***'); // mascarado

    // 3) POST /complete (público) — transação troca o owner
    db.query.mockReset();
    const client = makeTxClient([
      {},                                     // BEGIN
      { rows: [inviteRow()] },                // SELECT convite FOR UPDATE
      { rows: [] },                           // user do e-mail não existe
      { rows: [{ id: 'u-real' }] },           // INSERT users
      { rowCount: 1 },                        // UPDATE companies.owner_id
      { rows: [] },                           // company_members ainda não
      {},                                     // INSERT company_members
      {},                                     // UPDATE used_at
      {},                                     // COMMIT
    ]);
    db.connect.mockImplementationOnce(() => client);

    const completeRes = await request(app)
      .post('/api/v1/public/karate/dojo-claim/complete')
      .send({ token: 'tok-qualquer', name: 'Sensei Kenji', password: 'senha-forte-123' });

    expect(completeRes.status).toBe(200);
    expect(completeRes.body.ok).toBe(true);

    const calls = client.query.mock.calls.map((c) => ({ sql: String(c[0]), params: c[1] }));
    // ownership trocado: UPDATE companies SET owner_id=$1 WHERE id=$2 (só o dojô)
    const ownerUpdate = calls.find((c) => c.sql.includes('UPDATE companies') && c.sql.includes('owner_id'));
    expect(ownerUpdate).toBeDefined();
    expect(ownerUpdate.params).toEqual(['u-real', dojoId]);
    // convite marcado como usado + COMMIT
    expect(calls.some((c) => c.sql.includes('SET used_at'))).toBe(true);
    expect(calls.some((c) => c.sql === 'COMMIT')).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  test('complete com token expirado → 410 CONVITE_EXPIRADO (com ROLLBACK)', async () => {
    const client = makeTxClient([
      {},                                              // BEGIN
      { rows: [inviteRow({ expires_at: PAST() })] },   // SELECT: expirado
    ]);
    db.connect.mockImplementationOnce(() => client);

    const res = await request(app)
      .post('/api/v1/public/karate/dojo-claim/complete')
      .send({ token: 'tok-expirado', name: 'Sensei', password: 'senha-forte-123' });

    expect(res.status).toBe(410);
    expect(res.body.code).toBe('CONVITE_EXPIRADO');
    const calls = client.query.mock.calls.map((c) => String(c[0]));
    expect(calls).toContain('ROLLBACK');
    expect(calls.some((sql) => sql.includes('UPDATE companies'))).toBe(false);
  });

  test('segundo complete (token já usado) → 409 CLAIM_JA_REALIZADO', async () => {
    const client = makeTxClient([
      {},                                                          // BEGIN
      { rows: [inviteRow({ used_at: new Date().toISOString() })] }, // SELECT: usado
    ]);
    db.connect.mockImplementationOnce(() => client);

    const res = await request(app)
      .post('/api/v1/public/karate/dojo-claim/complete')
      .send({ token: 'tok-usado', name: 'Sensei', password: 'senha-forte-123' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CLAIM_JA_REALIZADO');
    const calls = client.query.mock.calls.map((c) => String(c[0]));
    expect(calls).toContain('ROLLBACK');
    expect(calls.some((sql) => sql.includes('UPDATE companies'))).toBe(false);
  });

  test('convite para dojô com owner real → 409 DOJO_JA_RECLAMADO', async () => {
    mockCompanyAccess();
    // owner_password_hash = hash bcrypt de verdade → dojô já reclamado
    db.query.mockResolvedValueOnce({
      rows: [{
        id: dojoId,
        owner_id: 'u-real',
        dojo_name: 'Dojô Fênix',
        federation_name: 'FPKT',
        federation_slug: 'fpkt',
        owner_password_hash: '$2b$12$abcdefghijklmnopqrstuv',
      }],
    });

    const res = await request(app)
      .post(`/api/v1/federation/${fedId}/dojos/${dojoId}/claim-invite`)
      .set(authHeader())
      .send({ email: 'sensei@dojo.com.br' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DOJO_JA_RECLAMADO');
  });

  test('verify com token desconhecido → 404 genérico', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post('/api/v1/public/karate/dojo-claim/verify')
      .send({ token: 'nao-existe' });
    expect(res.status).toBe(404);
  });
});
