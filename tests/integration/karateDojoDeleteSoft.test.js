// ============================================================
// COMPLIANCE — "EXCLUIR DOJÔ" É DESATIVAR. NADA É APAGADO.
//
// O QUE ESTE ARQUIVO CONGELA (é ESTA a asserção que impede a regressão)
//   DELETE /api/v1/federation/:id/dojos/:dojoId NÃO emite
//   `DELETE FROM companies` nem `DELETE FROM customers` em NENHUM caminho:
//   sem dependentes, com dependentes, com ?cascade=true, em dojô já inativo.
//   E não liga o escape hatch `SET LOCAL app.allow_transfer_purge` da
//   migration 221 — sem DELETE, não há trigger de imutabilidade para furar.
//
// POR QUE O TESTE ATRAVESSA O APP COMPOSTO (e não chama o handler direto)
//   Quem responde este DELETE é src/routes/karateIdentityGovernance.js,
//   montado ANTES de karateDojos.js em src/routes/index.js. Testar pelo app
//   inteiro faz da ORDEM DE MONTAGEM parte do contrato: se alguém reordenar
//   os router.use e o handler destrutivo antigo voltar a ser alcançado, os
//   casos abaixo ficam vermelhos na hora.
//
// ⚠️ MOCK POR SQL (matcher regex), NUNCA fila posicional. A ordem interna
//    (SELECT FOR UPDATE → contagem → UPDATE companies → snapshot → cascata →
//    devolução da gestão) é detalhe de implementação; virá-la contrato de
//    teste é o que já derrubou o CI deste repo em #421, #423 e #449.
//
// ⚠️ Ids de fixture são uuid hexadecimal VÁLIDO (mesmas constantes de
//    tests/integration/karateIdentityF74.test.js). Um 'r0000000-…' custou 13
//    testes vermelhos.
//
// ⚠️ _resetRemovalStampCache() no afterEach: HAS_REMOVAL_STAMP_COLS é estado
//    module-level. Sem o reset, o caso do 42703 decidiria o schema de todos
//    os casos seguintes (mesma armadilha do _resetSchemaCache da F7.1).
// ============================================================
'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db, deactivation;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  deactivation = require('../../src/services/karateDojoDeactivationService');
});

const SECRET = 'aura-test-secret-2026';
const fedId = 'fed00000-0000-0000-0000-000000000001';
const dojoId = 'd0000000-0000-0000-0000-000000000002';
const stu1 = 'c1000000-0000-0000-0000-00000000000c';
const stu2 = 'c2000000-0000-0000-0000-00000000000d';

const url = `/api/v1/federation/${fedId}/dojos/${dojoId}`;

// role:'admin' (plataforma) → requireCompanyAccess passa sem SELECT de papel.
// Mesma convenção de tests/integration/karateDojoGate.test.js.
const staffAuth = () => ({
  Authorization: `Bearer ${jwt.sign(
    { id: 'u1', email: 'staff@fpkt.org.br', role: 'admin', type: 'access' },
    SECRET,
    { expiresIn: '1h' }
  )}`,
});

// ── Matchers por SQL ────────────────────────────────────────
const matches = (m, s) => (typeof m === 'function' ? Boolean(m(s)) : m.test(s));
const txSqls = (client) => client.query.mock.calls.map((c) => String(c[0]));
const txHit = (client, m) => txSqls(client).some((s) => matches(m, s));
const txFind = (client, m) => client.query.mock.calls.find((c) => matches(m, String(c[0])));

// ⚠️ ESPECÍFICO DE PROPÓSITO: o candidatesSql da devolução da gestão também
// tem `LEFT JOIN companies` e `FOR UPDATE OF c` — um matcher frouxo
// (/FROM companies/ + /FOR UPDATE/) responderia a linha do dojô para AQUELA
// query e o teste passaria testando outra coisa.
const isDojoLookup = (s) => /SELECT id, name, is_active FROM companies/.test(s);
const isCounts = (s) => /::int AS practitioners/.test(s);
const isCompanyDeactivate = (s) => /UPDATE companies/.test(s) && /is_active = false/.test(s);
const isStampedUpdate = (s) => isCompanyDeactivate(s) && /removal_requested_at/.test(s);
const isRosterSnapshot = (s) => /SELECT id, is_active FROM customers/.test(s) && /dojo_id = \$1/.test(s);
const isRosterEvent = (s) => /INSERT INTO karate_dojo_roster_events/.test(s);
const isRosterDeactivate = (s) => /UPDATE customers/.test(s) && /is_active = false/.test(s);
const isCandidates = (s) => /FROM customers c/.test(s) && /c\.karate_identity_managed_by = 'dojo'/.test(s);
const isRelease = (s) => /UPDATE customers/.test(s) && /karate_identity_managed_by = 'federation'/.test(s);

// As proibições. São a razão de este arquivo existir.
const isCompanyDelete = (s) => /DELETE\s+FROM\s+companies/i.test(s);
const isCustomerDelete = (s) => /DELETE\s+FROM\s+customers/i.test(s);
const isAnyDelete = (s) => /DELETE\s+FROM\s+/i.test(s);
const isTransferPurge = (s) => /allow_transfer_purge/.test(s);

// ── Client de transação de mentira que despacha por SQL ─────
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

// Cenário padrão: dojô ATIVO, com histórico pesado (praticantes, graduações,
// transferências) — exatamente o caso que antes exigia ?cascade=true.
function scenario({
  dojo = { id: dojoId, name: 'Dojô Kondei', is_active: true },
  counts = {
    practitioners: 47, annuities: 12, transactions: 30,
    belt_history: 188, transfers: 4, connections: 1,
  },
  roster = [{ id: stu1, is_active: true }, { id: stu2, is_active: false }],
  adopted = [],
  stampFails = false,
} = {}) {
  db.query.mockResolvedValue({ rows: [] });
  return mockTx((s) => {
    if (isCandidates(s)) return { rows: adopted };
    if (isDojoLookup(s)) return { rows: dojo ? [dojo] : [] };
    if (isCounts(s)) return { rows: [counts] };
    if (isStampedUpdate(s)) {
      if (stampFails) {
        const e = new Error('column "removal_requested_at" of relation "companies" does not exist');
        e.code = '42703';
        return e;
      }
      return { rows: [{ id: dojoId, name: dojo.name, is_active: false, removal_requested_at: '2026-08-11T12:00:00.000Z' }] };
    }
    if (isCompanyDeactivate(s)) return { rows: [{ id: dojoId, name: dojo.name, is_active: false }] };
    if (isRosterSnapshot(s)) return { rows: roster };
    if (isRelease(s)) {
      return { rows: [{ id: stu1, name: 'João Praticante', karate_registration_number: 'FPKT-4321', federation_id: fedId }] };
    }
    return { rows: [] };
  });
}

function adoptedRow(over = {}) {
  return {
    practitioner_id: stu1,
    practitioner_label: 'João Praticante',
    fpkt_number: 'FPKT-4321',
    federation_id: fedId,
    dojo_id: dojoId,
    dojo_name: 'Dojô Kondei',
    identity_dojo_company_id: dojoId,
    identity_dojo_is_active: false,
    identity_dojo_vertical: 'karate_dojo',
    identity_dojo_vertical_active: 'karate_dojo',
    identity_dojo_state_loaded: true,
    ...over,
  };
}

afterEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
  deactivation._resetRemovalStampCache();
});

// ============================================================
// 1) A REGRA CONGELADA: NENHUM DELETE, EM CAMINHO NENHUM
// ============================================================
describe('DELETE de dojô — nada é apagado', () => {
  test('com histórico e SEM cascade: desativa, e nenhum DELETE é emitido', async () => {
    const tx = scenario();

    const res = await request(app).delete(url).set(staffAuth());

    expect(res.status).toBe(200);
    expect(res.body.deactivated).toBe(true);
    expect(res.body.deleted).toBe(false);
    expect(res.body.is_active).toBe(false);

    expect(txHit(tx, isCompanyDelete)).toBe(false);
    expect(txHit(tx, isCustomerDelete)).toBe(false);
    expect(txHit(tx, isAnyDelete)).toBe(false);
    expect(txHit(tx, isTransferPurge)).toBe(false);
    expect(txHit(tx, isCompanyDeactivate)).toBe(true);
  });

  test('com ?cascade=true (o caminho que apagava tudo): continua sem nenhum DELETE', async () => {
    const tx = scenario();

    const res = await request(app).delete(`${url}?cascade=true`).set(staffAuth());

    expect(res.status).toBe(200);
    expect(res.body.deactivated).toBe(true);
    expect(res.body.cascade_requested).toBe(true);
    expect(res.body.cascade_ignored).toBe(true);

    expect(txHit(tx, isCompanyDelete)).toBe(false);
    expect(txHit(tx, isCustomerDelete)).toBe(false);
    expect(txHit(tx, isAnyDelete)).toBe(false);
    expect(txHit(tx, isTransferPurge)).toBe(false);
  });

  test('sem nenhum dependente (o antigo hard delete direto): também só desativa', async () => {
    const tx = scenario({
      counts: { practitioners: 0, annuities: 0, transactions: 0, belt_history: 0, transfers: 0, connections: 0 },
      roster: [],
    });

    const res = await request(app).delete(url).set(staffAuth());

    expect(res.status).toBe(200);
    expect(res.body.deactivated).toBe(true);
    expect(res.body.deleted).toBe(false);
    expect(txHit(tx, isAnyDelete)).toBe(false);
  });

  test('as graduações não são tocadas: nenhuma escrita em karate_belt_history', async () => {
    const tx = scenario();
    await request(app).delete(`${url}?cascade=true`).set(staffAuth());
    expect(txHit(tx, /karate_belt_history/)).toBe(false);
  });
});

// ============================================================
// 2) 409 HAS_HISTORY SAIU — desativar não precisa mais de confirmação
// ============================================================
describe('DELETE de dojô — o 409 HAS_HISTORY não existe mais', () => {
  test('dojô cheio de histórico e sem cascade devolve 200, não 409', async () => {
    scenario();
    const res = await request(app).delete(url).set(staffAuth());
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('DEACTIVATED');
  });

  test('mas o counts continua na resposta (é o que a UI usava no 409)', async () => {
    scenario();
    const res = await request(app).delete(url).set(staffAuth());
    expect(res.body.counts.practitioners).toBe(47);
    expect(res.body.counts.belt_history).toBe(188);
  });
});

// ============================================================
// 3) A CASCATA É A MESMA DO PATCH is_active=false (e por isso é reversível)
// ============================================================
describe('DELETE de dojô — cascata dojô→praticantes', () => {
  test('desativa (nunca apaga) os praticantes e grava o snapshot da reativação', async () => {
    const tx = scenario();

    const res = await request(app).delete(url).set(staffAuth());

    expect(txHit(tx, isRosterDeactivate)).toBe(true);
    expect(txHit(tx, isCustomerDelete)).toBe(false);

    // Só quem estava ATIVO entra no snapshot — é o que a reativação restaura.
    const ev = txFind(tx, isRosterEvent);
    expect(ev).toBeDefined();
    expect(JSON.parse(ev[1][2])).toEqual([{ student_id: stu1, was_active: true }]);
    expect(res.body.roster_cascade.affected_count).toBe(1);
  });

  test('a resposta ensina o caminho de volta (PATCH is_active:true)', async () => {
    scenario();
    const res = await request(app).delete(url).set(staffAuth());
    expect(res.body.reactivate.method).toBe('PATCH');
    expect(res.body.reactivate.body).toEqual({ is_active: true });
    expect(res.body.reactivate.path).toContain(`/dojos/${dojoId}`);
  });

  test('dojô JÁ inativo: 200 idempotente, sem novo snapshot (não zera a reativação)', async () => {
    const tx = scenario({ dojo: { id: dojoId, name: 'Dojô Kondei', is_active: false } });

    const res = await request(app).delete(url).set(staffAuth());

    expect(res.status).toBe(200);
    expect(res.body.already_inactive).toBe(true);
    expect(txHit(tx, isRosterEvent)).toBe(false);
    expect(txHit(tx, isRosterDeactivate)).toBe(false);
    expect(txHit(tx, isAnyDelete)).toBe(false);
  });
});

// ============================================================
// 4) ESCOPO E RETENÇÃO
// ============================================================
describe('DELETE de dojô — escopo, retenção e ator', () => {
  test('dojô de outra federação (ou inexistente) → 404 e nada é escrito', async () => {
    const tx = scenario({ dojo: null });

    const res = await request(app).delete(url).set(staffAuth());

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(txHit(tx, isCompanyDeactivate)).toBe(false);
    expect(txHit(tx, isCandidates)).toBe(false); // 404 não devolve gestão de ninguém
  });

  test('dojoId fora do formato uuid → 422 (não chega a abrir transação)', async () => {
    scenario();
    const res = await request(app)
      .delete(`/api/v1/federation/${fedId}/dojos/nao-e-uuid`)
      .set(staffAuth());
    expect(res.status).toBe(422);
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('carimba quem pediu e devolve o prazo dos termos de uso', async () => {
    const tx = scenario();

    const res = await request(app).delete(url).set(staffAuth());

    expect(res.body.retention.policy_days).toBe(60);
    expect(res.body.retention.removal_requested_at).toBe('2026-08-11T12:00:00.000Z');
    const stamp = txFind(tx, isStampedUpdate);
    expect(stamp[1][2]).toBe('u1'); // ator vem do token, nunca do corpo
  });

  test('migration 277 pendente (42703): desativa do mesmo jeito, só sem carimbo', async () => {
    const tx = scenario({ stampFails: true });

    const res = await request(app).delete(url).set(staffAuth());

    expect(res.status).toBe(200);
    expect(res.body.deactivated).toBe(true);
    expect(res.body.retention.removal_requested_at).toBeNull();
    expect(txHit(tx, isCompanyDeactivate)).toBe(true);
    expect(txHit(tx, isAnyDelete)).toBe(false);
  });
});

// ============================================================
// 5) A GESTÃO DA FICHA VOLTA PARA A FEDERAÇÃO — DEPOIS, E SEM APAGAR
// ============================================================
describe('DELETE de dojô — devolução da gestão das fichas (premissa 3)', () => {
  test('fichas adotadas voltam para a federação e a resposta diz quantas', async () => {
    const tx = scenario({ adopted: [adoptedRow()] });

    const res = await request(app).delete(url).set(staffAuth());

    expect(res.status).toBe(200);
    expect(res.body.identity_released.count).toBe(1);
    expect(txHit(tx, isRelease)).toBe(true);
    expect(txHit(tx, isAnyDelete)).toBe(false);
  });

  test('dojô sem ficha adotada: resposta sem identity_released, e nada é escrito à toa', async () => {
    const tx = scenario({ adopted: [] });

    const res = await request(app).delete(url).set(staffAuth());

    expect(res.status).toBe(200);
    expect(res.body.identity_released).toBeUndefined();
    expect(txHit(tx, isRelease)).toBe(false);
  });
});
