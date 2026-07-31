// ============================================================
// AURA DOJÔ — F7.4: REVOGAÇÃO DA FILIAÇÃO (ato exclusivo da federação)
//
// AS DUAS ORDENS DO DONO DO PRODUTO QUE ESTE ARQUIVO TRAVA:
//
//   30/07/2026 — "Somente a federação pode cancelar esse vínculo. Dojô
//     solicita, federação pode aceitar e posteriormente revogar."
//   31/07/2026 — "A INATIVAÇÃO É FEITA PELA PRÓPRIA FEDERAÇÃO."
//
// A segunda separou o que a primeira versão tinha juntado numa transação só.
// Hoje são DOIS ATOS, e este arquivo prova que o primeiro não faz o segundo:
//
//   (a) revogar zera companies.karate_dojo_linked_at e grava a trilha do ato
//       — e NÃO ENCOSTA em customers. Nenhum UPDATE, nenhum is_active,
//       nenhum snapshot 'inactivate_cascade';
//   (b) a inativação continua sendo cascadeInactivateDojo(), o "Suspender" de
//       karateDojos.js — caminho anterior a esta F7.4, não alterado por ela e
//       coberto pelos testes daquele arquivo;
//   (c) revogar NÃO devolve a gestão da ficha: karate_identity_managed_by e
//       karate_identity_dojo_id não são tocados por nada aqui. Quem devolve a
//       gestão é só a SAÍDA DO AURA (tests/integration/karateIdentityF74).
//
// E "os dados permanecem": nenhum DELETE, e fpkt_affiliation_id /
// affiliation_since ficam como histórico da filiação que existiu.
//
// ⚠️ MOCK POR SQL (mockImplementation despachando por regex), NUNCA fila
//    posicional de mockResolvedValueOnce nem client.query.mock.calls[N]: a
//    ordem interna da transação (lock → contagem → trilha → unlink) é detalhe
//    de implementação, e virar contrato de teste é o que já derrubou o CI
//    deste repo quatro vezes.
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

const url = `/api/v1/federation/${fedId}/affiliation-requests/revoke`;
const LINKED_AT = new Date('2026-07-01T12:00:00Z');

// role:'admin' (plataforma) passa em requireCompanyAccess sem SELECT de
// papel — as únicas queries são as do handler. `id:'staff1'` NÃO é uuid de
// propósito (ver o caso do actor_id).
const staffAuth = () => ({
  Authorization: `Bearer ${jwt.sign(
    { id: 'staff1', email: 'staff@fpkt.org.br', role: 'admin', type: 'access' },
    SECRET,
    { expiresIn: '1h' }
  )}`,
});

// ── Matchers por SQL ────────────────────────────────────────
const isCompanyLock = (s) => /FROM companies/.test(s) && /FOR UPDATE/.test(s);
const isActiveCount = (s) => /COUNT\(\*\)/i.test(s) && /FROM customers/.test(s);
const isRevokeEvent = (s) => /INSERT INTO karate_dojo_roster_events/.test(s) && /'affiliation_revoked'/.test(s);
const isCascadeEvent = (s) => /'inactivate_cascade'/.test(s);
const isUnlink = (s) => /UPDATE companies/.test(s) && /karate_dojo_linked_at = NULL/.test(s);
// Qualquer escrita em customers — é exatamente isto que a revogação deixou
// de fazer, então o matcher é propositalmente largo.
const isCustomerWrite = (s) => /UPDATE customers/i.test(s) || /DELETE FROM customers/i.test(s);

// Client de transação de mentira que despacha por SQL. Devolver um Error
// faz a query rejeitar (é assim que o 42P01 é simulado).
function mockTx(dispatch) {
  const client = {
    query: jest.fn((sql, params) => {
      const r = dispatch(String(sql), params);
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve(r || { rows: [] });
    }),
    release: jest.fn(),
  };
  db.connect.mockImplementation(() => client);
  return client;
}

// Transação feliz padrão: dojô filiado, com 7 praticantes ativos.
function mockRevokeTx({
  linkedAt = LINKED_AT,
  company = { id: dojoId, dojo_name: 'Dojô Kondei' },
  activePractitioners = 7,
  rosterFails = false,
  countFails = false,
} = {}) {
  return mockTx((s) => {
    if (isCompanyLock(s)) {
      if (!company) return { rows: [] };
      return { rows: [{ ...company, karate_dojo_linked_at: linkedAt }] };
    }
    if (isActiveCount(s)) {
      if (countFails) {
        const e = new Error('column "dojo_id" does not exist');
        e.code = '42703';
        return e;
      }
      return { rows: [{ active_practitioners: activePractitioners }] };
    }
    if (rosterFails && /INSERT INTO karate_dojo_roster_events/.test(s)) {
      const e = new Error('relation "karate_dojo_roster_events" does not exist');
      e.code = '42P01';
      return e;
    }
    if (isUnlink(s)) return { rows: [{ id: dojoId }] };
    return { rows: [] };
  });
}

const txSqls = (c) => c.query.mock.calls.map((x) => String(x[0]));
const txHit = (c, m) => txSqls(c).some((s) => (typeof m === 'function' ? m(s) : m.test(s)));
const txFind = (c, m) => c.query.mock.calls.find((x) => (typeof m === 'function' ? m(String(x[0])) : m.test(String(x[0]))));

afterEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
});

// ============================================================
// 1) VALIDAÇÃO — nada acontece sem motivo e sem alvo
// ============================================================
describe('F7.4 — revogar filiação: validação', () => {
  test('sem motivo → 422 REVOKE_REASON_REQUIRED e NENHUMA transação abre', async () => {
    mockRevokeTx();
    const res = await request(app).post(url).set(staffAuth()).send({ dojo_id: dojoId });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('REVOKE_REASON_REQUIRED');
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('motivo curto demais (< 5 caracteres) → 422, sem transação', async () => {
    mockRevokeTx();
    const res = await request(app).post(url).set(staffAuth()).send({ dojo_id: dojoId, reason: '  x  ' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('REVOKE_REASON_REQUIRED');
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('sem dojo_id → 422 VALIDATION_ERROR, sem transação', async () => {
    mockRevokeTx();
    const res = await request(app).post(url).set(staffAuth()).send({ reason: 'Dojô encerrou as atividades' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('sem token → 401 (revogar é ato da federação, nunca anônimo)', async () => {
    const res = await request(app).post(url).send({ dojo_id: dojoId, reason: 'qualquer motivo' });
    expect(res.status).toBe(401);
  });
});

// ============================================================
// 2) ESCOPO — só a federação dona do dojô revoga
// ============================================================
describe('F7.4 — revogar filiação: escopo e estado', () => {
  test('dojô de OUTRA federação (ou inexistente) → 404 NOT_FOUND + ROLLBACK', async () => {
    const tx = mockRevokeTx({ company: null });

    const res = await request(app).post(url).set(staffAuth())
      .send({ dojo_id: dojoId, reason: 'Dojô encerrou as atividades' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(txSqls(tx)).toContain('ROLLBACK');
    expect(txHit(tx, isUnlink)).toBe(false);
    expect(txHit(tx, isCustomerWrite)).toBe(false);
  });

  test('dojô JÁ desfiliado → 409 NAO_CONECTADO e nada é revogado duas vezes', async () => {
    const tx = mockRevokeTx({ linkedAt: null });

    const res = await request(app).post(url).set(staffAuth())
      .send({ dojo_id: dojoId, reason: 'Revogação em duplicidade' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NAO_CONECTADO');
    expect(txSqls(tx)).toContain('ROLLBACK');
    expect(txHit(tx, isUnlink)).toBe(false);
    expect(txHit(tx, isCustomerWrite)).toBe(false);
  });
});

// ============================================================
// 3) O ATO — revogar revoga, e SÓ isso
// ============================================================
describe('F7.4 — revogar filiação: o que a revogação faz', () => {
  test('feliz: 200 e vínculo zerado, tudo em UMA transação', async () => {
    const tx = mockRevokeTx();

    const res = await request(app).post(url).set(staffAuth())
      .send({ dojo_id: dojoId, reason: 'Dojô encerrou as atividades em 07/2026' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.revoked).toBe(true);
    expect(res.body.dojo_id).toBe(dojoId);
    expect(res.body.was_linked_at).toBe('2026-07-01T12:00:00.000Z');

    const all = txSqls(tx);
    expect(all).toContain('BEGIN');
    expect(all).toContain('COMMIT');
    expect(all).not.toContain('ROLLBACK');

    // O vínculo cai, escopado por federação + vertical.
    const unlink = txFind(tx, isUnlink);
    expect(String(unlink[0])).toContain("vertical = 'karate_dojo'");
    expect(unlink[1]).toEqual([dojoId, fedId]);
  });

  test('A CORREÇÃO DE 31/07: revogar NÃO INATIVA ninguém — customers não é tocado', async () => {
    // "A inativação é feita pela própria federação" (cascadeInactivateDojo,
    // o Suspender de karateDojos.js). Revogar é só revogar.
    const tx = mockRevokeTx();

    const res = await request(app).post(url).set(staffAuth())
      .send({ dojo_id: dojoId, reason: 'Dojô encerrou as atividades' });

    expect(res.status).toBe(200);
    expect(txHit(tx, isCustomerWrite)).toBe(false);
    expect(txHit(tx, /is_active = false/)).toBe(false);
    // E nem o snapshot: 'inactivate_cascade' é o contrato de quem de fato
    // inativa. Escrevê-lo aqui sujaria a restauração daquele caminho.
    expect(txHit(tx, isCascadeEvent)).toBe(false);
    // A resposta diz isso em voz alta, para não depender de documentação.
    expect(res.body.practitioners_changed).toBe(false);
  });

  test('revogar NÃO devolve a gestão de ficha nenhuma', async () => {
    // "o resto permanece igual" — o dojô desfiliado continua usando o Aura e
    // continua dono da identidade dos alunos dele.
    const tx = mockRevokeTx();

    const res = await request(app).post(url).set(staffAuth())
      .send({ dojo_id: dojoId, reason: 'Dojô encerrou as atividades' });

    expect(res.body.identity_management_changed).toBe(false);
    expect(txHit(tx, /karate_identity_managed_by/)).toBe(false);
    expect(txHit(tx, /karate_identity_dojo_id/)).toBe(false);
    expect(txHit(tx, /INSERT INTO karate_identity_audit/)).toBe(false);
  });

  test('"os dados permanecem": nenhum DELETE, e a filiação vira histórico', async () => {
    const tx = mockRevokeTx();

    await request(app).post(url).set(staffAuth())
      .send({ dojo_id: dojoId, reason: 'Dojô encerrou as atividades' });

    expect(txHit(tx, /DELETE FROM/i)).toBe(false);
    // O número de filiação e a data ficam onde estão: são o histórico.
    expect(txHit(tx, /fpkt_affiliation_id/)).toBe(false);
    expect(txHit(tx, /affiliation_since/)).toBe(false);
    // E o único UPDATE da transação inteira é o do vínculo.
    const updates = txSqls(tx).filter((s) => /\bUPDATE\s+\w+/i.test(s));
    expect(updates).toHaveLength(1);
    expect(isUnlink(updates[0])).toBe(true);
  });
});

// ============================================================
// 4) INFORMAÇÃO, NUNCA AÇÃO — a contagem que a federação usa para decidir
// ============================================================
describe('F7.4 — revogar filiação: quantos praticantes ativos sobraram', () => {
  test('a resposta informa active_practitioners, com o critério da federação', async () => {
    const tx = mockRevokeTx({ activePractitioners: 7 });

    const res = await request(app).post(url).set(staffAuth())
      .send({ dojo_id: dojoId, reason: 'Dojô encerrou as atividades' });

    expect(res.status).toBe(200);
    expect(res.body.active_practitioners).toBe(7);
    expect(res.body.message).toMatch(/7 praticante/);

    // Mesmo critério de karateDojos.js: is_active NULL conta como ativo.
    const cnt = txFind(tx, isActiveCount);
    expect(cnt).toBeDefined();
    expect(String(cnt[0])).toContain('COALESCE(is_active, true) = true');
    expect(cnt[1]).toEqual([dojoId]);
  });

  test('contagem indisponível (42703): revogação acontece e o campo vem null', async () => {
    // Informação nunca pode derrubar o ato.
    const tx = mockRevokeTx({ countFails: true });

    const res = await request(app).post(url).set(staffAuth())
      .send({ dojo_id: dojoId, reason: 'Dojô encerrou as atividades' });

    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);
    expect(res.body.active_practitioners).toBeNull();
    expect(txHit(tx, isUnlink)).toBe(true);
    expect(txSqls(tx)).toContain('COMMIT');
    expect(txSqls(tx)).not.toContain('ROLLBACK');
  });
});

// ============================================================
// 5) TRILHA — o ato, sem DDL
// ============================================================
describe('F7.4 — revogar filiação: trilha', () => {
  test('registra o ATO com motivo, quem, desde quando e quantos ativos ficaram', async () => {
    const tx = mockRevokeTx({ activePractitioners: 7 });

    await request(app).post(url).set(staffAuth())
      .send({ dojo_id: dojoId, reason: 'Sensei desligou-se da federação por escrito' });

    const ev = txFind(tx, isRevokeEvent);
    expect(ev).toBeDefined();
    expect(ev[1][0]).toBe(dojoId);
    expect(ev[1][1]).toBe(fedId);

    const payload = JSON.parse(ev[1][2])[0];
    expect(payload.reason).toMatch(/desligou-se da federação/i);
    expect(payload.was_linked_at).toBe('2026-07-01T12:00:00.000Z');
    expect(payload.active_practitioners).toBe(7);
    expect(payload.actor_id).toBe('staff1');

    // actor_id é coluna uuid: 'staff1' vira NULL em vez de estourar 22P02 e
    // derrubar a revogação por causa do log. O rastro humano fica no payload.
    expect(ev[1][3]).toBeNull();
  });

  test('migration 220 pendente (42P01): SAVEPOINT segura e a revogação acontece', async () => {
    const tx = mockRevokeTx({ rosterFails: true });

    const res = await request(app).post(url).set(staffAuth())
      .send({ dojo_id: dojoId, reason: 'Dojô encerrou as atividades' });

    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe(true);
    // Trilha indisponível não pode envenenar a transação: cada passo
    // best-effort roda em SAVEPOINT e volta com ROLLBACK TO SAVEPOINT
    // (armadilha tx-poison).
    expect(txHit(tx, /SAVEPOINT sp_affiliation_revoke/)).toBe(true);
    expect(txHit(tx, /ROLLBACK TO SAVEPOINT sp_affiliation_revoke/)).toBe(true);
    expect(txSqls(tx)).toContain('COMMIT');
    expect(txSqls(tx)).not.toContain('ROLLBACK');
    // E o núcleo aconteceu do mesmo jeito.
    expect(txHit(tx, isUnlink)).toBe(true);
  });
});
