// ============================================================
// AURA DOJÔ — F7.4: quando o dojô SAI DO AURA, a gestão volta para a federação
//
// O QUE ESTE ARQUIVO TRAVA
//   1. tabela-verdade de "o dojô saiu do Aura?" — TRÊS pernas: company
//      apagada, company inativada, vertical karate_dojo desligada
//   2. o que NÃO é saída (correções do dono do produto, 30/07/2026):
//      desfiliação da federação e inadimplência com a Aura
//   3. dojô sem Aura → a ficha volta a aceitar escrita da federação NA HORA
//      (sem depender de job) e a trilha registra a devolução (action='release')
//   4. dojô VIVO → continua 409 IDENTITY_MANAGED_BY_DOJO (a F7.3 não afrouxou)
//   5. retomada MANUAL em lote (com motivo obrigatório)
//   6. regularização em lote com ?dry_run=1 (relatório sem escrever)
//   7. DELETE de praticante AVISA e nunca bloqueia
//   8. o caminho das 15.488 fichas geridas pela federação: ZERO query nova
//
// A REVOGAÇÃO da filiação (a outra metade da correção — inativar os
// praticantes do dojô desfiliado na visão da federação) tem arquivo próprio:
// tests/integration/karateAffiliationRevoke.test.js. Ela não mora aqui de
// propósito: revogar NÃO mexe na gestão da ficha, que é o assunto deste
// arquivo.
//
// ⚠️ MOCK POR SQL (matcher regex/função), NUNCA fila posicional. A ordem
//    interna (SELECT do dono → BEGIN → UPDATE → trilha → COMMIT) é detalhe de
//    implementação; virar contrato de teste é o que já derrubou o CI deste
//    repo em #421, #423 e #449 — qualquer query nova entra na frente e
//    desloca mockResolvedValueOnce/mock.calls[N] de quem veio antes.
//
// ⚠️ guard._resetDojoStateCache() em afterEach: HAS_DOJO_STATE_COLS é estado
//    module-level e, sem o reset, o caso do 42703 decidiria o schema de todos
//    os casos seguintes (mesma armadilha do _resetSchemaCache da F7.1).
// ============================================================
'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db, guard, exitState;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  guard = require('../../src/services/karateIdentityWriteGuard');
  exitState = require('../../src/services/karateDojoExitState');
});

const SECRET = 'aura-test-secret-2026';
const fedId = 'fed00000-0000-0000-0000-000000000001';
const dojoId = 'd0000000-0000-0000-0000-000000000002';
const pid = 'c1000000-0000-0000-0000-00000000000c';
const pid2 = 'c2000000-0000-0000-0000-00000000000d';

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
const sqls = () => db.query.mock.calls.map((c) => String(c[0]));
const hitSql = (m) => sqls().some((s) => matches(m, s));

const isOwnerRead = (s) => /FROM customers c/.test(s) && /WHERE c\.id = \$1/.test(s);
const isCandidates = (s) => /FROM customers c/.test(s) && /c\.karate_identity_managed_by = 'dojo'/.test(s);
const isRelease = (s) => /UPDATE customers/.test(s) && /karate_identity_managed_by = 'federation'/.test(s);
const isAudit = (s) => /INSERT INTO karate_identity_audit/.test(s);
const isRosterEvent = (s) => /INSERT INTO karate_dojo_roster_events/.test(s);
const isPractitionerLock = (s) => /FROM customers WHERE id = \$1 AND federation_id = \$2 FOR UPDATE/.test(s);
const isCount = (s) => /COUNT\(\*\)::int AS c/.test(s);
const isCustomerDelete = (s) => /DELETE FROM customers/.test(s);

// ── Fábricas de linha ───────────────────────────────────────
// Estado do dojô como o dojoStateSelect('d') devolve (prefixo identity_dojo_).
// São QUATRO colunas: id, is_active, vertical, vertical_active. Não há
// billing_status, trial_ends_at, is_staff nem karate_dojo_linked_at — as duas
// pernas que dependiam delas foram removidas por correção do dono do produto
// (ver o describe "o que NÃO é saída").
function dojoState(over = {}) {
  return {
    identity_dojo_company_id: dojoId,
    identity_dojo_is_active: true,
    identity_dojo_vertical: 'karate_dojo',
    identity_dojo_vertical_active: 'karate_dojo',
    identity_dojo_state_loaded: true,
    ...over,
  };
}

// Linha do OWNER_SQL da guarda.
function ownerRow(over = {}, stateOver = {}) {
  return {
    id: pid,
    practitioner_label: 'João Praticante',
    fpkt_number: 'FPKT-4321',
    federation_id: fedId,
    karate_identity_managed_by: 'dojo',
    karate_identity_dojo_id: dojoId,
    identity_dojo_name: 'Dojô Kondei',
    ...dojoState(stateOver),
    ...over,
  };
}

// Linha do candidatesSql do serviço de devolução.
function candidateRow(over = {}, stateOver = {}) {
  return {
    practitioner_id: pid,
    practitioner_label: 'João Praticante',
    fpkt_number: 'FPKT-4321',
    federation_id: fedId,
    dojo_id: dojoId,
    dojo_name: 'Dojô Kondei',
    ...dojoState(stateOver),
    ...over,
  };
}

// Client de transação de mentira que despacha por SQL.
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

const txSqls = (client) => client.query.mock.calls.map((c) => String(c[0]));
const txHit = (client, m) => txSqls(client).some((s) => matches(m, s));
const txFind = (client, m) => client.query.mock.calls.find((c) => matches(m, String(c[0])));

// Transação padrão da devolução: UPDATE devolve a linha, trilha aceita.
function mockReleaseTx({ rows = [candidateRow()], auditFails = false } = {}) {
  return mockTx((s) => {
    if (isCandidates(s)) return { rows };
    if (isRelease(s)) {
      return {
        rows: [{
          id: pid,
          name: 'João Praticante',
          karate_registration_number: 'FPKT-4321',
          federation_id: fedId,
        }],
      };
    }
    if (auditFails && isAudit(s)) {
      const e = new Error('relation "karate_identity_audit" does not exist');
      e.code = '42P01';
      return e;
    }
    return { rows: [] };
  });
}

afterEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
  guard._resetDojoStateCache();
});

// ============================================================
// 1) A TABELA-VERDADE DE "O DOJÔ SAIU DO AURA?"
// ============================================================
describe('F7.4 — o que conta como "o dojô saiu do Aura"', () => {
  const evalRow = (over) => exitState.evaluateDojoExitFromRow(dojoState(over));

  test('dojô normal e ativo → NÃO saiu', () => {
    expect(evalRow({}).exited).toBe(false);
  });

  test('company inativada (is_active=false) → saiu', () => {
    const e = evalRow({ identity_dojo_is_active: false });
    expect(e.exited).toBe(true);
    expect(e.reason).toBe(exitState.EXIT_REASONS.COMPANY_INACTIVE);
  });

  test('vertical desligada (vertical_active <> karate_dojo) → saiu', () => {
    const e = evalRow({ identity_dojo_vertical_active: 'varejo' });
    expect(e.exited).toBe(true);
    expect(e.reason).toBe(exitState.EXIT_REASONS.VERTICAL_OFF);
  });

  test('vertical_active NULL é dado FALTANTE, não desligamento → NÃO saiu', () => {
    expect(evalRow({ identity_dojo_vertical_active: null }).exited).toBe(false);
  });

  test('company apagada (LEFT JOIN sem linha) → saiu', () => {
    const e = evalRow({ identity_dojo_company_id: null });
    expect(e.exited).toBe(true);
    expect(e.reason).toBe(exitState.EXIT_REASONS.COMPANY_MISSING);
  });

  test('linha SEM o estado do dojô: "não sei" NUNCA vira "saiu"', () => {
    const e = exitState.evaluateDojoExitFromRow({ id: pid });
    expect(e.known).toBe(false);
    expect(e.exited).toBe(false);
  });
});

// ============================================================
// 2) O QUE **NÃO** É SAÍDA — as duas correções do dono do produto
// ============================================================
// Estes casos não descrevem comportamento novo: eles TRAVAM a remoção de duas
// pernas que este PR chegou a ter. Sem eles, reintroduzir "desfiliou logo
// saiu" ou "não pagou logo saiu" passaria no CI sem ninguém ver.
describe('F7.4 — o que NÃO é saída (correções do dono do produto, 30/07/2026)', () => {
  test('DESFILIAÇÃO não é saída: o dojô desfiliado continua dono da identidade dos alunos dele', () => {
    // "Sobre desconectar da federação, a única ação seria inativar os
    //  praticantes do dojô desfiliado na visão da federação, o resto
    //  permanece igual." Mesmo que a linha traga a coluna do vínculo zerada,
    //  a avaliação não pode enxergar saída nenhuma.
    const e = exitState.evaluateDojoExitFromRow(
      dojoState({ identity_dojo_linked_at: null, karate_dojo_linked_at: null })
    );
    expect(e.exited).toBe(false);
    expect(exitState.EXIT_REASONS.UNLINKED_FROM_FEDERATION).toBeUndefined();
  });

  test('INADIMPLÊNCIA não é saída, com gate ligado ou desligado', () => {
    // "Não vamos criar gate por inadimplência. Teoricamente, se a federação
    //  aceitar o vínculo, entendemos que o dojô está autorizado a se filiar."
    process.env.DOJO_GATE_ENABLED = 'true';
    try {
      const e = exitState.evaluateDojoExitFromRow(
        dojoState({
          identity_dojo_billing_status: 'overdue',
          identity_dojo_trial_ends_at: '2020-01-01',
          identity_dojo_is_staff: false,
        })
      );
      expect(e.exited).toBe(false);
      expect(exitState.EXIT_REASONS.BILLING_BLOCKED).toBeUndefined();
    } finally {
      delete process.env.DOJO_GATE_ENABLED;
    }
  });

  test('o estado lido do dojô tem SÓ as colunas das três pernas', () => {
    // Nenhuma coluna de cobrança e nenhuma coluna de vínculo entram no
    // SELECT — coluna que ninguém avalia não vira 42703 de ninguém.
    const cols = exitState.DOJO_STATE_FIELDS.map((f) => f.col);
    expect(cols).toEqual(['id', 'is_active', 'vertical', 'vertical_active']);
    const frag = exitState.dojoStateSelect('d');
    expect(frag).not.toMatch(/billing_status|trial_ends_at|is_staff|karate_dojo_linked_at/);
    expect(Object.values(exitState.EXIT_REASONS).sort())
      .toEqual(['company_inactive', 'company_missing', 'vertical_off']);
  });
});

// ============================================================
// 3) A GUARDA: dojô que saiu libera NA HORA e devolve a gestão
// ============================================================
describe('F7.4 — a guarda de escrita da identidade', () => {
  const call = (extra = {}) => guard.assertIdentityWriteAllowed({
    runner: db,
    practitionerId: pid,
    columns: ['name', 'cpf_cnpj'],
    channel: guard.CHANNELS.FEDERATION_ADMIN,
    canOverride: true,
    body: {},
    actor: { userId: null, label: 'staff@fpkt.org.br' },
    ...extra,
  });

  test('dojô SEM AURA (inativado): a escrita da federação é LIBERADA na hora', async () => {
    db.query.mockImplementation((s) => (isOwnerRead(String(s))
      ? Promise.resolve({ rows: [ownerRow({}, { identity_dojo_is_active: false })] })
      : Promise.resolve({ rows: [] })));
    const tx = mockReleaseTx();

    const out = await call();

    expect(out.blocked).toBe(false);
    expect(out.managedBy).toBe('federation');
    expect(out.dojoExit.reason).toBe(exitState.EXIT_REASONS.COMPANY_INACTIVE);
    expect(out.previousDojo).toEqual({ id: dojoId, name: 'Dojô Kondei' });
    expect(out.identityReturned).toBe(true);
    expect(tx).toBeDefined();
  });

  test('dojô DESFILIADO mas VIVO no Aura: continua 409 — desfiliar não devolve gestão', async () => {
    db.query.mockImplementation((s) => (isOwnerRead(String(s))
      ? Promise.resolve({ rows: [ownerRow({}, { identity_dojo_linked_at: null })] })
      : Promise.resolve({ rows: [] })));

    await expect(call()).rejects.toMatchObject({
      status: 409,
      code: guard.CODE_BLOCKED,
      identity_managed_by: 'dojo',
    });
    expect(db.connect).not.toHaveBeenCalled();
    expect(hitSql(isRelease)).toBe(false);
  });

  test('a devolução escreve as DUAS colunas juntas e confere o dono no WHERE', async () => {
    db.query.mockImplementation((s) => (isOwnerRead(String(s))
      ? Promise.resolve({ rows: [ownerRow({}, { identity_dojo_company_id: null })] })
      : Promise.resolve({ rows: [] })));
    const tx = mockReleaseTx();

    await call();

    const upd = txFind(tx, isRelease);
    expect(upd).toBeDefined();
    // O CHECK customers_karate_identity_coherent (262) proíbe zerar só uma.
    expect(String(upd[0])).toContain("karate_identity_managed_by = 'federation'");
    expect(String(upd[0])).toContain('karate_identity_dojo_id = NULL');
    // Última linha de defesa: só devolve a ficha DESTE dojô.
    expect(String(upd[0])).toContain('AND karate_identity_dojo_id = $2');
    expect(upd[1]).toEqual([pid, dojoId]);
  });

  test('a trilha registra a devolução: action=release, source=sync_job', async () => {
    db.query.mockImplementation((s) => (isOwnerRead(String(s))
      ? Promise.resolve({ rows: [ownerRow({}, { identity_dojo_vertical_active: 'varejo' })] })
      : Promise.resolve({ rows: [] })));
    const tx = mockReleaseTx();

    await call();

    const audit = txFind(tx, isAudit);
    expect(audit).toBeDefined();
    const params = audit[1];
    expect(params[7]).toBe('release');    // action — dentro do CHECK da 263
    expect(params[8]).toBe('sync_job');   // source — devolução automática
    expect(params[2]).toBe(pid);
    const changes = JSON.parse(params[9]);
    expect(changes[0].field).toBe('karate_identity_managed_by');
    expect(changes[0].federation_before).toBe('dojo');
    expect(changes[0].federation_after).toBe('federation');
  });

  test('sem a 263 a trilha cai em roster_events — e a devolução acontece assim mesmo', async () => {
    db.query.mockImplementation((s) => (isOwnerRead(String(s))
      ? Promise.resolve({ rows: [ownerRow({}, { identity_dojo_is_active: false })] })
      : Promise.resolve({ rows: [] })));
    const tx = mockReleaseTx({ auditFails: true });

    const out = await call();

    expect(out.blocked).toBe(false);
    expect(txHit(tx, isRosterEvent)).toBe(true);
  });

  test('dojô VIVO: continua 409 IDENTITY_MANAGED_BY_DOJO e NENHUMA transação abre', async () => {
    db.query.mockImplementation((s) => (isOwnerRead(String(s))
      ? Promise.resolve({ rows: [ownerRow()] })
      : Promise.resolve({ rows: [] })));

    await expect(call()).rejects.toMatchObject({
      status: 409,
      code: guard.CODE_BLOCKED,
      identity_managed_by: 'dojo',
    });
    expect(db.connect).not.toHaveBeenCalled();
    expect(hitSql(isRelease)).toBe(false);
  });

  test('AS 15.488 DA FEDERAÇÃO: uma query só, nenhuma escrita, nenhuma transação', async () => {
    db.query.mockImplementation((s) => (isOwnerRead(String(s))
      ? Promise.resolve({ rows: [ownerRow({ karate_identity_managed_by: 'federation', karate_identity_dojo_id: null })] })
      : Promise.resolve({ rows: [] })));

    const out = await call();

    expect(out.blocked).toBe(false);
    expect(out.managedBy).toBe('federation');
    expect(db.query).toHaveBeenCalledTimes(1); // exatamente a leitura do dono
    expect(db.connect).not.toHaveBeenCalled();
    expect(hitSql(isRelease)).toBe(false);
  });

  test('escrita SEM campo de identidade (matrícula, papéis) não vai ao banco', async () => {
    db.query.mockImplementation(() => Promise.resolve({ rows: [] }));

    const out = await guard.assertIdentityWriteAllowed({
      runner: db,
      practitionerId: pid,
      columns: ['karate_registration_number', 'is_active', 'dojo_id'],
      channel: guard.CHANNELS.FEDERATION_ADMIN,
      canOverride: true,
      body: {},
    });

    expect(out.blocked).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('42703 nas colunas de estado: cai para a leitura F7.3 e NÃO libera por engano', async () => {
    let first = true;
    db.query.mockImplementation((s) => {
      const sql = String(s);
      if (!isOwnerRead(sql)) return Promise.resolve({ rows: [] });
      if (first && /identity_dojo_state_loaded/.test(sql)) {
        first = false;
        const e = new Error('column d.vertical_active does not exist');
        e.code = '42703';
        return Promise.reject(e);
      }
      // Forma legada (F7.3): sem o estado do dojô.
      return Promise.resolve({
        rows: [{
          id: pid,
          practitioner_label: 'João Praticante',
          fpkt_number: 'FPKT-4321',
          federation_id: fedId,
          karate_identity_managed_by: 'dojo',
          karate_identity_dojo_id: dojoId,
          identity_dojo_name: 'Dojô Kondei',
        }],
      });
    });

    await expect(call()).rejects.toMatchObject({ status: 409, code: guard.CODE_BLOCKED });
    expect(db.connect).not.toHaveBeenCalled();
  });
});

// ============================================================
// 4) RETOMADA MANUAL EM LOTE (a federação retoma o dojô inteiro)
// ============================================================
describe('F7.4 — retomada manual pela federação', () => {
  const url = `/api/v1/federation/${fedId}/dojos/${dojoId}/identity/reclaim`;

  test('sem motivo → 422 RECLAIM_REASON_REQUIRED (e nada é escrito)', async () => {
    mockReleaseTx();
    const res = await request(app).post(url).set(staffAuth()).send({});
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('RECLAIM_REASON_REQUIRED');
  });

  test('com motivo → devolve TODAS as fichas do dojô, com trilha manual', async () => {
    const tx = mockTx((s) => {
      if (isCandidates(s)) {
        return { rows: [candidateRow(), candidateRow({ practitioner_id: pid2, practitioner_label: 'Maria' })] };
      }
      if (isRelease(s)) {
        return { rows: [{ id: pid, name: 'João Praticante', karate_registration_number: 'FPKT-4321', federation_id: fedId }] };
      }
      return { rows: [] };
    });

    const res = await request(app)
      .post(url)
      .set(staffAuth())
      .send({ reason: 'Dojô sumiu; sensei não responde há 3 meses' });

    expect(res.status).toBe(200);
    expect(res.body.reclaimed).toBe(true);
    expect(res.body.count).toBe(2);

    const audit = txFind(tx, isAudit);
    expect(audit[1][7]).toBe('release');
    expect(audit[1][8]).toBe('federation_admin'); // retomada MANUAL
    expect(JSON.parse(audit[1][9])[0].reason).toContain('sumiu');
  });

  test('a retomada NÃO apaga nada: só as duas colunas de gestão são escritas', async () => {
    const tx = mockTx((s) => {
      if (isCandidates(s)) return { rows: [candidateRow()] };
      if (isRelease(s)) return { rows: [{ id: pid, name: 'João', karate_registration_number: 'FPKT-4321', federation_id: fedId }] };
      return { rows: [] };
    });

    await request(app).post(url).set(staffAuth()).send({ reason: 'retomada de gestão' });

    expect(txHit(tx, /DELETE FROM/i)).toBe(false);
    expect(txHit(tx, /UPDATE karate_dojo_students/)).toBe(false);
  });
});

// ============================================================
// 5) REGULARIZAÇÃO EM LOTE (?dry_run=1 não escreve)
// ============================================================
describe('F7.4 — regularização em lote', () => {
  test('dry_run devolve o relatório e NÃO abre transação', async () => {
    db.query.mockImplementation((s) => (isCandidates(String(s))
      ? Promise.resolve({
          rows: [
            candidateRow({ practitioner_id: pid }, { identity_dojo_is_active: false }),
            candidateRow({ practitioner_id: pid2 }), // dojô vivo: fica como está
          ],
        })
      : Promise.resolve({ rows: [] })));

    const res = await request(app)
      .post(`/api/v1/federation/${fedId}/identity/regularize?dry_run=1`)
      .set(staffAuth())
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.dry_run).toBe(true);
    expect(res.body.checked).toBe(2);
    expect(res.body.candidates).toBe(1);
    expect(res.body.still_managed).toBe(1);
    expect(res.body.count).toBe(0);
    expect(db.connect).not.toHaveBeenCalled();
  });
});

// ============================================================
// 6) DELETE DE PRATICANTE: AVISA, NUNCA BLOQUEIA
// ============================================================
describe('F7.4 — DELETE de praticante com ficha adotada', () => {
  const url = `/api/v1/federation/${fedId}/practitioners/${pid}`;

  function mockDeleteTx() {
    return mockTx((s) => {
      if (isPractitionerLock(s)) return { rows: [{ id: pid, name: 'João Praticante' }] };
      if (isCount(s)) return { rows: [{ c: 0 }] };
      if (isCustomerDelete(s)) return { rows: [] };
      return { rows: [] };
    });
  }

  test('dojô ATIVO: exclui (não bloqueia) e a resposta AVISA', async () => {
    db.query.mockImplementation((s) => (isOwnerRead(String(s))
      ? Promise.resolve({ rows: [ownerRow()] })
      : Promise.resolve({ rows: [] })));
    mockDeleteTx();

    const res = await request(app).delete(url).set(staffAuth());

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true); // premissa 2: a federação remove dados
    expect(res.body.identity_notice).toBeDefined();
    expect(res.body.identity_notice.was_managed_by_dojo).toBe(true);
    expect(res.body.identity_notice.dojo_active).toBe(true);
    expect(res.body.identity_notice.dojo).toEqual({ id: dojoId, name: 'Dojô Kondei' });
    expect(res.body.identity_notice.student_link).toMatch(/aluno do dojô NÃO foi apagado/i);
    // O aviso é só aviso: o interceptador não escreve nada.
    expect(hitSql(isRelease)).toBe(false);
  });

  test('dojô que JÁ tinha saído: avisa que a gestão já era da federação', async () => {
    db.query.mockImplementation((s) => (isOwnerRead(String(s))
      ? Promise.resolve({ rows: [ownerRow({}, { identity_dojo_is_active: false })] })
      : Promise.resolve({ rows: [] })));
    mockDeleteTx();

    const res = await request(app).delete(url).set(staffAuth());

    expect(res.status).toBe(200);
    expect(res.body.identity_notice.dojo_active).toBe(false);
    expect(res.body.identity_notice.dojo_exit_reason).toBe(exitState.EXIT_REASONS.COMPANY_INACTIVE);
  });

  test('ficha da FEDERAÇÃO (as 15.488): resposta idêntica à de sempre, sem aviso', async () => {
    db.query.mockImplementation((s) => (isOwnerRead(String(s))
      ? Promise.resolve({ rows: [ownerRow({ karate_identity_managed_by: 'federation', karate_identity_dojo_id: null })] })
      : Promise.resolve({ rows: [] })));
    mockDeleteTx();

    const res = await request(app).delete(url).set(staffAuth());

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.identity_notice).toBeUndefined();
  });
});
