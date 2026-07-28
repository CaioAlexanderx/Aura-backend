// ============================================================
// AURA DOJÔ — Testes Integração: F6 conexão/filiação self-serve
// (karate_affiliation_requests, migration 252)
//
// Contrato validado:
//   LADO DOJÔ   GET  /dojo/connection → none | pending | rejected | approved
//               POST /dojo/connection → 201 | 200 already_pending | 409
//                                        JA_CONECTADO | 403 PORTAL_READ_ONLY
//   LADO FED.   GET  /affiliation-requests (+ /metrics, rota estática)
//               POST /:id/approve → 422 sem número, 409 número em uso,
//                                    409 já resolvida, 200 SETA o vínculo
//               POST /:id/reject  → 422 sem motivo, 200 sem tocar linked_at
//
// ⚠️ MOCK POR SQL (mockImplementation), NUNCA fila posicional de
// mockResolvedValueOnce: qualquer query nova entrando na frente (foi o que
// o helper karateDojoLinkStatus fez no PR #422) desalinha a fila inteira e
// derruba o CI. Mock genérico {rows: []} também não serve: os handlers
// leem rows[0] direto.
//
// db.query.mockReset() + db.connect.mockReset() em afterEach
// (jest.clearAllMocks NÃO drena filas nem implementações).
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
const reqId = 'a0000000-0000-0000-0000-00000000000f';
const dojoBase = `/api/v1/federation/${fedId}/dojo`;
const fedBase = `/api/v1/federation/${fedId}`;

// Canal A: JWT de acesso do Aura Dojô (dojo_id no token)
const canalA = () => ({
  Authorization: `Bearer ${jwt.sign(
    { id: 'u1', email: 'sensei@dojo.com.br', type: 'access', dojo_id: dojoId, federation_id: fedId },
    SECRET,
    { expiresIn: '1h' }
  )}`,
});

// Canal B: token de portal (leitura)
const canalB = () => ({
  Authorization: `Bearer ${jwt.sign(
    { type: 'portal', scope: 'dojo_portal', dojo_id: dojoId, federation_id: fedId },
    SECRET,
    { expiresIn: '1h' }
  )}`,
});

// Federação: role 'admin' de plataforma passa em requireCompanyAccess SEM
// SELECT de papel — as únicas db.query são as do handler.
const adminHeader = () => ({
  Authorization: `Bearer ${jwt.sign({ id: 'staff1', role: 'admin' }, SECRET, { expiresIn: '1h' })}`,
});

const sqls = () => db.query.mock.calls.map((c) => String(c[0]));
const hitSql = (re) => sqls().some((s) => re.test(s));
const findCall = (re) => db.query.mock.calls.find((c) => re.test(String(c[0])));

// Query do helper karateDojoLinkStatus (a única que menciona a coluna).
const isLinkQuery = (s) => /SELECT\s+karate_dojo_linked_at/i.test(s);
// Último pedido do dojô (GET /dojo/connection) x pendente (POST idempotente)
const isLastRequestQuery = (s) =>
  /FROM karate_affiliation_requests/.test(s) && /AND federation_id = \$2/.test(s);
const isPendingLookupQuery = (s) =>
  /FROM karate_affiliation_requests/.test(s) && /AND status = 'pending'/.test(s);

function mockDojo(linkedAt, extra) {
  db.query.mockImplementation((sql) => {
    const s = String(sql);
    if (isLinkQuery(s)) return Promise.resolve({ rows: [{ karate_dojo_linked_at: linkedAt }] });
    // Contato da federação (best-effort na tela de conexão)
    if (/AS name, slug/.test(s)) {
      return Promise.resolve({ rows: [{ name: 'FPKT', slug: 'fpkt' }] });
    }
    if (extra) {
      const r = extra(s);
      if (r) return Promise.resolve(r);
    }
    return Promise.resolve({ rows: [] });
  });
}

// Client de transação despachando por SQL (mesma filosofia do mock de
// db.query: imune a query nova entrando na frente).
function mockTx(dispatch) {
  const client = {
    query: jest.fn((sql) => Promise.resolve(dispatch(String(sql)) || { rows: [] })),
    release: jest.fn(),
  };
  db.connect.mockImplementation(() => client);
  return client;
}

const txSqls = (client) => client.query.mock.calls.map((c) => String(c[0]));

afterEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
});

// ============================================================
// LADO DOJÔ
// ============================================================
describe('F6 — lado dojô: pedir conexão à federação', () => {
  test('sem token → 401', async () => {
    const res = await request(app).get(`${dojoBase}/connection`);
    expect(res.status).toBe(401);
  });

  test('GET /connection — dojô virgem (sem pedido, sem vínculo) → status none', async () => {
    mockDojo(null);
    const res = await request(app).get(`${dojoBase}/connection`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('none');
    expect(res.body.linked).toBe(false);
    expect(res.body.request).toBeNull();
    expect(res.body.federation).toEqual({ name: 'FPKT', slug: 'fpkt' });
  });

  test('GET /connection — com pedido pendente → status pending', async () => {
    mockDojo(null, (s) =>
      isLastRequestQuery(s)
        ? {
            rows: [{
              id: reqId,
              status: 'pending',
              created_at: new Date('2026-07-26T10:00:00Z'),
              reviewed_at: null,
              rejection_reason: null,
            }],
          }
        : null
    );
    const res = await request(app).get(`${dojoBase}/connection`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(res.body.linked).toBe(false);
    expect(res.body.request.id).toBe(reqId);
    expect(res.body.request.created_at).toBe('2026-07-26T10:00:00.000Z');
    expect(res.body.request.rejection_reason).toBeNull();
  });

  test('GET /connection — pedido recusado → status rejected + motivo visível', async () => {
    mockDojo(null, (s) =>
      isLastRequestQuery(s)
        ? {
            rows: [{
              id: reqId,
              status: 'rejected',
              created_at: new Date('2026-07-20T10:00:00Z'),
              reviewed_at: new Date('2026-07-21T10:00:00Z'),
              rejection_reason: 'Faltou o comprovante de endereço do dojô.',
            }],
          }
        : null
    );
    const res = await request(app).get(`${dojoBase}/connection`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.request.rejection_reason).toMatch(/comprovante/i);
    expect(res.body.request.reviewed_at).toBe('2026-07-21T10:00:00.000Z');
  });

  test('GET /connection — dojô conectado SEM registro de pedido → approved (criado pela federação)', async () => {
    mockDojo(new Date('2026-07-01T12:00:00Z'));
    const res = await request(app).get(`${dojoBase}/connection`).set(canalA());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');
    expect(res.body.linked).toBe(true);
    expect(res.body.linked_at).toBe('2026-07-01T12:00:00.000Z');
    expect(res.body.request).toBeNull();
  });

  test('POST /connection — dojô não conectado pede → 201 pending (ids vêm do TOKEN)', async () => {
    mockDojo(null, (s) =>
      /INSERT INTO karate_affiliation_requests/.test(s)
        ? { rows: [{ id: reqId, status: 'pending', created_at: new Date('2026-07-26T10:00:00Z') }] }
        : null
    );

    const res = await request(app)
      .post(`${dojoBase}/connection`)
      .set(canalA())
      .send({
        contact_name: 'Sensei Kondei',
        contact_phone: '91999990000',
        contact_email: 'sensei@dojo.com.br',
        city: 'Belém',
        state: 'PA',
        students_count: 42,
        // dojo_id do BODY deve ser ignorado — escopo vem do token
        dojo_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(reqId);
    expect(res.body.status).toBe('pending');
    expect(res.body.already_pending).toBe(false);

    const insert = findCall(/INSERT INTO karate_affiliation_requests/);
    expect(insert[1][0]).toBe(fedId);
    expect(insert[1][1]).toBe(dojoId); // nunca o dojo_id do body
    expect(insert[1][2]).toBe('Sensei Kondei');
    expect(insert[1][10]).toBe(42);
  });

  test('POST /connection — sem contact_phone → 422, nada gravado', async () => {
    mockDojo(null);
    const res = await request(app)
      .post(`${dojoBase}/connection`)
      .set(canalA())
      .send({ contact_name: 'Sensei Sem Telefone' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(hitSql(/INSERT INTO karate_affiliation_requests/)).toBe(false);
  });

  test('POST /connection — pedir de novo com pendente → 200 already_pending (idempotente)', async () => {
    mockDojo(null, (s) => {
      if (/INSERT INTO karate_affiliation_requests/.test(s)) return { rows: [] }; // ON CONFLICT DO NOTHING
      if (isPendingLookupQuery(s)) {
        return { rows: [{ id: reqId, status: 'pending', created_at: new Date('2026-07-26T10:00:00Z') }] };
      }
      return null;
    });

    const res = await request(app)
      .post(`${dojoBase}/connection`)
      .set(canalA())
      .send({ contact_name: 'Sensei Kondei', contact_phone: '91999990000' });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(reqId);
    expect(res.body.already_pending).toBe(true);
  });

  test('POST /connection — dojô JÁ conectado → 409 JA_CONECTADO, nada gravado', async () => {
    mockDojo(new Date('2026-07-01T12:00:00Z'));
    const res = await request(app)
      .post(`${dojoBase}/connection`)
      .set(canalA())
      .send({ contact_name: 'Sensei Kondei', contact_phone: '91999990000' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JA_CONECTADO');
    expect(hitSql(/INSERT INTO karate_affiliation_requests/)).toBe(false);
  });

  test('Canal B (portal) — GET lê, POST 403 PORTAL_READ_ONLY sem tocar o banco', async () => {
    mockDojo(null);
    const g = await request(app).get(`${dojoBase}/connection`).set(canalB());
    expect(g.status).toBe(200);
    expect(g.body.status).toBe('none');

    db.query.mockReset();
    const p = await request(app)
      .post(`${dojoBase}/connection`)
      .set(canalB())
      .send({ contact_name: 'Sensei Kondei', contact_phone: '91999990000' });

    expect(p.status).toBe(403);
    expect(p.body.code).toBe('PORTAL_READ_ONLY');
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ============================================================
// LADO FEDERAÇÃO
// ============================================================
describe('F6 — lado federação: inbox, aceite e recusa', () => {
  test('GET /affiliation-requests — pendentes primeiro, mais recentes no topo', async () => {
    db.query.mockImplementation(() =>
      Promise.resolve({
        rows: [{
          id: reqId,
          dojo_id: dojoId,
          dojo_name: 'Dojô Kondei',
          contact_name: 'Sensei Kondei',
          contact_phone: '91999990000',
          contact_email: null,
          cnpj: null,
          cpf: '52998224725',
          city: 'Belém',
          state: 'PA',
          students_count: 42,
          notes: null,
          status: 'pending',
          created_at: new Date('2026-07-26T10:00:00Z'),
          reviewed_at: null,
          rejection_reason: null,
        }],
      })
    );

    const res = await request(app).get(`${fedBase}/affiliation-requests`).set(adminHeader());

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.data[0].dojo).toEqual({ id: dojoId, name: 'Dojô Kondei' });
    expect(res.body.data[0].students_count).toBe(42);
    const listSql = sqls().find((s) => /FROM karate_affiliation_requests/.test(s));
    expect(listSql).toContain("ORDER BY (r.status = 'pending') DESC");
  });

  test('GET /affiliation-requests/metrics — rota ESTÁTICA, não cai em :requestId', async () => {
    db.query.mockImplementation(() =>
      Promise.resolve({
        rows: [{
          pending: 2,
          approved: 5,
          rejected: 1,
          mais_antiga_criada_em: new Date(Date.now() - 3 * 86400000),
        }],
      })
    );

    const res = await request(app).get(`${fedBase}/affiliation-requests/metrics`).set(adminHeader());

    expect(res.status).toBe(200);
    expect(res.body.pending).toBe(2);
    expect(res.body.approved).toBe(5);
    expect(res.body.rejected).toBe(1);
    expect(res.body.mais_antiga.dias).toBe(3);
    // Se tivesse sido capturada como :requestId, o handler de approve/reject
    // (POST) nem responderia a GET — e nenhuma query de métricas rodaria.
    expect(hitSql(/FILTER \(WHERE r\.status = 'pending'\)/)).toBe(true);
  });

  test('approve SEM fpkt_number → 422 FPKT_NUMBER_REQUIRED (nem abre transação)', async () => {
    const res = await request(app)
      .post(`${fedBase}/affiliation-requests/${reqId}/approve`)
      .set(adminHeader())
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('FPKT_NUMBER_REQUIRED');
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('approve com número JÁ EM USO → 409 FPKT_NUMBER_TAKEN + ROLLBACK, sem tocar companies', async () => {
    const client = mockTx((s) => {
      if (/FROM karate_affiliation_requests/.test(s) && /FOR UPDATE/.test(s)) {
        return { rows: [{ id: reqId, dojo_id: dojoId, status: 'pending' }] };
      }
      if (/SELECT id FROM companies/.test(s)) return { rows: [{ id: 'outro-dojo' }] };
      return { rows: [] };
    });

    const res = await request(app)
      .post(`${fedBase}/affiliation-requests/${reqId}/approve`)
      .set(adminHeader())
      .send({ fpkt_number: 'FPKT-007' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FPKT_NUMBER_TAKEN');
    expect(txSqls(client)).toContain('ROLLBACK');
    expect(txSqls(client).some((s) => /UPDATE companies/.test(s))).toBe(false);
    expect(client.release).toHaveBeenCalled();
  });

  test('approve feliz → seta karate_dojo_linked_at + número + affiliation_since, tudo em UMA transação', async () => {
    const client = mockTx((s) => {
      if (/FROM karate_affiliation_requests/.test(s) && /FOR UPDATE/.test(s)) {
        return { rows: [{ id: reqId, dojo_id: dojoId, status: 'pending' }] };
      }
      if (/SELECT id FROM companies/.test(s)) return { rows: [] }; // número livre
      if (/UPDATE companies/.test(s)) {
        return {
          rows: [{
            id: dojoId,
            karate_dojo_linked_at: new Date('2026-07-26T12:00:00Z'),
            fpkt_affiliation_id: 'FPKT-007',
          }],
        };
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post(`${fedBase}/affiliation-requests/${reqId}/approve`)
      .set(adminHeader())
      .send({ fpkt_number: 'FPKT-007' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.dojo_id).toBe(dojoId);
    expect(res.body.fpkt_affiliation_id).toBe('FPKT-007');
    expect(res.body.linked_at).toBe('2026-07-26T12:00:00.000Z');

    const all = txSqls(client);
    expect(all).toContain('BEGIN');
    expect(all).toContain('COMMIT');
    expect(all).not.toContain('ROLLBACK');

    // A asserção que importa: o UPDATE em companies marca o vínculo, com
    // COALESCE (reaprovar não reescreve a data original) e o número
    // DIGITADO pela federação nos params.
    const upd = client.query.mock.calls.find((c) => /UPDATE companies/.test(String(c[0])));
    expect(String(upd[0])).toContain('karate_dojo_linked_at = COALESCE(karate_dojo_linked_at, NOW())');
    expect(String(upd[0])).toContain('affiliation_since     = COALESCE(affiliation_since, CURRENT_DATE)');
    expect(upd[1]).toEqual(['FPKT-007', dojoId, fedId]);

    // E a solicitação vira approved com quem/quando
    const mark = client.query.mock.calls.find(
      (c) => /UPDATE karate_affiliation_requests/.test(String(c[0]))
    );
    expect(String(mark[0])).toContain("status = 'approved'");
    expect(mark[1]).toEqual(['staff1', reqId]);
  });

  test('approve de solicitação JÁ RESOLVIDA → 409 JA_RESOLVIDA, nada escrito', async () => {
    const client = mockTx((s) => {
      if (/FROM karate_affiliation_requests/.test(s) && /FOR UPDATE/.test(s)) {
        return { rows: [{ id: reqId, dojo_id: dojoId, status: 'approved' }] };
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post(`${fedBase}/affiliation-requests/${reqId}/approve`)
      .set(adminHeader())
      .send({ fpkt_number: 'FPKT-008' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JA_RESOLVIDA');
    expect(txSqls(client).some((s) => /UPDATE companies/.test(s))).toBe(false);
    expect(txSqls(client)).toContain('ROLLBACK');
  });

  test('reject SEM motivo → 422 (o sensei precisa ver o porquê), nada gravado', async () => {
    db.query.mockImplementation(() => Promise.resolve({ rows: [] }));

    const res = await request(app)
      .post(`${fedBase}/affiliation-requests/${reqId}/reject`)
      .set(adminHeader())
      .send({ reason: '   ' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('reject feliz → status rejected e karate_dojo_linked_at INTOCADO', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/UPDATE karate_affiliation_requests/.test(s)) {
        return Promise.resolve({
          rows: [{
            id: reqId,
            dojo_id: dojoId,
            status: 'rejected',
            rejection_reason: 'Documentação incompleta',
            reviewed_at: new Date('2026-07-26T15:00:00Z'),
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post(`${fedBase}/affiliation-requests/${reqId}/reject`)
      .set(adminHeader())
      .send({ reason: 'Documentação incompleta' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.rejection_reason).toBe('Documentação incompleta');
    expect(res.body.reviewed_at).toBe('2026-07-26T15:00:00.000Z');
    // recusar NÃO desconecta ninguém
    expect(hitSql(/UPDATE companies/)).toBe(false);
    expect(hitSql(/karate_dojo_linked_at/)).toBe(false);
  });

  test('reject de solicitação já resolvida → 409 JA_RESOLVIDA', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/UPDATE karate_affiliation_requests/.test(s)) return Promise.resolve({ rows: [] });
      if (/SELECT id FROM karate_affiliation_requests/.test(s)) {
        return Promise.resolve({ rows: [{ id: reqId }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post(`${fedBase}/affiliation-requests/${reqId}/reject`)
      .set(adminHeader())
      .send({ reason: 'Motivo qualquer' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JA_RESOLVIDA');
  });
});

// ============================================================
// LADO FEDERAÇÃO — abre pelo dojô (migration 255, origin='federation')
// Convergência com "Conectar dojô": mesmo inbox, mesmo approve/reject —
// só quem inicia muda.
// ============================================================
describe('F6b — federação abre a filiação pelo dojô (migration 255)', () => {
  const outroFedId = 'fed00000-0000-0000-0000-000000000099';

  test('POST /affiliation-requests — dojô roteado e não linkado → 201 pending, origin=federation', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/SELECT id, federation_id, karate_dojo_linked_at FROM companies/.test(s)) {
        return Promise.resolve({ rows: [{ id: dojoId, federation_id: fedId, karate_dojo_linked_at: null }] });
      }
      if (isLinkQuery(s)) return Promise.resolve({ rows: [{ karate_dojo_linked_at: null }] });
      if (/INSERT INTO karate_affiliation_requests/.test(s)) {
        return Promise.resolve({
          rows: [{ id: reqId, status: 'pending', origin: 'federation', created_at: new Date('2026-07-27T10:00:00Z') }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post(`${fedBase}/affiliation-requests`)
      .set(adminHeader())
      .send({ dojo_id: dojoId, contact_name: 'Sensei Kondei', contact_phone: '91999990000' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(reqId);
    expect(res.body.status).toBe('pending');
    expect(res.body.origin).toBe('federation');
    expect(res.body.already_pending).toBe(false);

    const insert = findCall(/INSERT INTO karate_affiliation_requests/);
    expect(insert[1][0]).toBe(fedId);
    expect(insert[1][1]).toBe(dojoId);
    expect(insert[1][12]).toBe('federation'); // origin
    expect(insert[1][13]).toBe('staff1');     // requested_by = actorId (adminHeader)
  });

  test('POST /affiliation-requests — dojô de OUTRA federação (federation_id não bate) → 422 DOJO_NAO_ROTEADO', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/SELECT id, federation_id, karate_dojo_linked_at FROM companies/.test(s)) {
        return Promise.resolve({ rows: [{ id: dojoId, federation_id: outroFedId, karate_dojo_linked_at: null }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post(`${fedBase}/affiliation-requests`)
      .set(adminHeader())
      .send({ dojo_id: dojoId, contact_name: 'Sensei Kondei', contact_phone: '91999990000' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('DOJO_NAO_ROTEADO');
    expect(hitSql(/INSERT INTO karate_affiliation_requests/)).toBe(false);
  });

  test('POST /affiliation-requests — dojô já linkado → 409 JA_CONECTADO, nada gravado', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/SELECT id, federation_id, karate_dojo_linked_at FROM companies/.test(s)) {
        return Promise.resolve({
          rows: [{ id: dojoId, federation_id: fedId, karate_dojo_linked_at: new Date('2026-01-01T00:00:00Z') }],
        });
      }
      if (isLinkQuery(s)) return Promise.resolve({ rows: [{ karate_dojo_linked_at: new Date('2026-01-01T00:00:00Z') }] });
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post(`${fedBase}/affiliation-requests`)
      .set(adminHeader())
      .send({ dojo_id: dojoId, contact_name: 'Sensei Kondei', contact_phone: '91999990000' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JA_CONECTADO');
    expect(hitSql(/INSERT INTO karate_affiliation_requests/)).toBe(false);
  });

  test('POST /affiliation-requests — dojô não encontrado → 404 DOJO_NOT_FOUND', async () => {
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      if (/SELECT id, federation_id, karate_dojo_linked_at FROM companies/.test(s)) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(app)
      .post(`${fedBase}/affiliation-requests`)
      .set(adminHeader())
      .send({ dojo_id: dojoId, contact_name: 'Sensei Kondei', contact_phone: '91999990000' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('DOJO_NOT_FOUND');
  });

  test('POST /affiliation-requests — sem dojo_id → 422 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post(`${fedBase}/affiliation-requests`)
      .set(adminHeader())
      .send({ contact_name: 'Sensei Kondei', contact_phone: '91999990000' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('GET /affiliation-requests/metrics — inclui pending_by_origin', async () => {
    db.query.mockImplementation(() =>
      Promise.resolve({
        rows: [{
          pending: 3,
          approved: 5,
          rejected: 1,
          pending_dojo: 2,
          pending_federation: 1,
          mais_antiga_criada_em: new Date(Date.now() - 3 * 86400000),
        }],
      })
    );

    const res = await request(app).get(`${fedBase}/affiliation-requests/metrics`).set(adminHeader());

    expect(res.status).toBe(200);
    expect(res.body.pending_by_origin).toEqual({ dojo: 2, federation: 1 });
  });
});
