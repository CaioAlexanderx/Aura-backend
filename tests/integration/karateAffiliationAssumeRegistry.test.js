// ============================================================
// AURA DOJÔ — F11: O ACEITE APONTA QUAL REGISTRO FEDERATIVO É O DOJÔ
//
// ── O QUE ESTE ARQUIVO TRAVA ────────────────────────────────
// A FPKT tem 105 dojôs cadastrados como companies — o REGISTRO FEDERATIVO,
// com o código FPKT, a filiação e 9.840 praticantes pendurados (104 deles
// sem nenhum usuário: o owner é um user-sistema COMPARTILHADO). O sensei
// que assina a Aura NÃO cai nesse registro: ele cria uma conta nova e vazia
// pelo Sign Up e pede vínculo. No ACEITE, a federação aponta qual dos 105
// registros é ele — e a conta dele PASSA A SER aquela linha.
//
// Move-se o USUÁRIO, não os praticantes. Por isso a asserção mais importante
// deste arquivo é uma AUSÊNCIA: `customers` não é tocado em nenhum caminho.
//
// ── AS DUAS ARMADILHAS DO ACEITE COM APONTAMENTO ────────────
//   (a) quem recebe o número e o vínculo é o REGISTRO. Marcar a conta do
//       cadastro deixaria karate_dojo_linked_at numa company que o próprio
//       ato acabou de desativar;
//   (b) a checagem de número duplicado precisa EXCLUIR o registro: o número
//       digitado pela federação é, quase sempre, o que aquele registro já
//       tem — excluir a conta nova devolveria FPKT_NUMBER_TAKEN dele contra
//       ele mesmo. Há um teste só para isso, e o seu par sem apontamento.
//
// ⚠️ MOCK POR SQL (mockImplementation despachando por regex/âncora de
//    comentário), NUNCA fila posicional de mockResolvedValueOnce nem
//    client.query.mock.calls[N]: a ordem interna da transação é detalhe de
//    implementação e virar contrato de teste já derrubou este CI 4 vezes.
//
// ⚠️ E o mock é uma TABELINHA, não um "sim" com cara de query: as linhas de
//    companies/users moram num objeto indexado por id e o dispatcher aplica
//    o MESMO recorte do SQL (federação, número, id excluído) SOBRE O DADO
//    SIMULADO. Comparar com a constante do teste (`=== fedId`) faria o mock
//    concordar sozinho e o teste de escopo passaria verde sem testar nada.
// ============================================================
'use strict';

const request = require('supertest');
const jwt = require('jsonwebtoken');

let app, db, LOCKED;
beforeAll(() => {
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  // Senha travada do user-sistema — a mesma constante que o serviço usa
  // para responder "este registro ainda não tem usuário".
  ({ LOCKED_SYSTEM_PASSWORD: LOCKED } = require('../../src/services/karateDojoClaimService'));
});

const SECRET = 'aura-test-secret-2026';
const fedId = 'fed00000-0000-0000-0000-000000000001';
const outraFedId = 'fed00000-0000-0000-0000-0000000000ff';
const reqId = 'a0000000-0000-0000-0000-00000000000f';
// A conta que o sensei criou no Sign Up (vazia, descartável).
const contaNovaId = 'c0000000-0000-0000-0000-000000000001';
// Um dos 105 registros federativos preexistentes.
const registroId = 'r0000000-0000-0000-0000-000000000105';
const senseiUserId = 'u0000000-0000-0000-0000-000000000001';
const systemUserId = 'u0000000-0000-0000-0000-0000000000ff';

const approveUrl = `/api/v1/federation/${fedId}/affiliation-requests/${reqId}/approve`;
const LINKED_AT = new Date('2020-03-01T12:00:00Z');

// role:'admin' (plataforma) passa em requireCompanyAccess sem SELECT de
// papel — as únicas queries são as do handler. `id:'staff1'` NÃO é uuid de
// propósito (ver a asserção de actor_id na trilha).
const staffAuth = () => ({
  Authorization: `Bearer ${jwt.sign(
    { id: 'staff1', email: 'staff@fpkt.org.br', role: 'admin', type: 'access' },
    SECRET,
    { expiresIn: '1h' }
  )}`,
});

function pgErr(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ── Matchers por SQL ────────────────────────────────────────
const isRequestLock = (s) => /FROM karate_affiliation_requests/.test(s) && /FOR UPDATE/.test(s);
const isDupCheck = (s) => /SELECT id FROM companies/.test(s) && /fpkt_affiliation_id/.test(s);
const isLinkUpdate = (s) => /UPDATE companies/.test(s) && /karate_dojo_linked_at = COALESCE/.test(s);
const isRequestApproved = (s) => /UPDATE karate_affiliation_requests/.test(s) && /'approved'/.test(s);
const isOwnerTransfer = (s) => /assumption:owner-transfer/.test(s);
const isMemberOwner = (s) => /assumption:member-owner/.test(s);
const isDiscard = (s) => /assumption:discard/.test(s);
const isRosterEvent = (s) => /assumption:roster-event/.test(s);
const isTrail = (s) => /assumption:trail/.test(s);
const anyAssumption = (s) => /assumption:/.test(s);
// Propositalmente largo: NENHUMA escrita nem leitura de customers acontece
// neste fluxo. Os praticantes já estão no registro.
const touchesCustomers = (s) => /\bcustomers\b/i.test(s);

// Client de transação de mentira que despacha por SQL. Devolver um Error
// faz a query rejeitar (é assim que 42P01/23505 são simulados).
function mockTx(dispatch) {
  const client = {
    query: jest.fn((sql, params) => {
      const r = dispatch(String(sql), params || []);
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve(r || { rows: [] });
    }),
    release: jest.fn(),
  };
  db.connect.mockImplementation(() => client);
  return client;
}

// ── O MUNDO SIMULADO ────────────────────────────────────────
// Duas linhas de companies e duas de users, indexadas por id. O dispatcher
// consulta ESTA tabelinha; nenhuma decisão de escopo é tomada comparando
// com as constantes do teste.
function makeWorld(over) {
  const o = Object.assign(
    {
      requestStatus: 'pending',
      registro: {
        id: registroId,
        owner_id: systemUserId,
        vertical: 'karate_dojo',
        federation_id: fedId,
        is_active: true,
        company_name: 'Associação Areikan de Karatê',
        karate_dojo_linked_at: LINKED_AT,
        fpkt_affiliation_id: 'FPKT-007',
      },
      contaNova: {
        id: contaNovaId,
        owner_id: senseiUserId,
        vertical: 'karate_dojo',
        federation_id: fedId,
        is_active: true,
        company_name: 'Dojô do Sensei (conta nova)',
        karate_dojo_linked_at: null,
        fpkt_affiliation_id: null,
      },
      systemHash: null, // null = LOCKED (preenchido abaixo)
      senseiHash: '$2b$12$hashdeverdadedosensei',
      realMembers: 0,
      moved: {},        // { tabela: linhas reapontadas }
      singleCounts: {}, // { tabela: { had, moved } }
      moveFails: null,  // { table, error }
      trailFails: false,
    },
    over || {}
  );
  o.users = {
    [systemUserId]: { id: systemUserId, password_hash: o.systemHash || LOCKED },
    [senseiUserId]: { id: senseiUserId, password_hash: o.senseiHash },
  };
  return o;
}

function mockApproveTx(o) {
  const companies = {};
  if (o.registro) companies[o.registro.id] = o.registro;
  if (o.contaNova) companies[o.contaNova.id] = o.contaNova;

  return mockTx((s, p) => {
    // ── assunção (âncoras de comentário do serviço) ──
    if (/assumption:target-lock/.test(s) || /assumption:requester-lock/.test(s)) {
      const row = companies[p[0]];
      return { rows: row ? [row] : [] };
    }
    if (/assumption:target-owner/.test(s) || /assumption:requester-owner/.test(s)) {
      const u = o.users[p[0]];
      return { rows: u ? [u] : [] };
    }
    if (/assumption:target-members/.test(s)) {
      return { rows: [{ real_members: o.realMembers }] };
    }
    if (isOwnerTransfer(s)) {
      // Reproduz o WHERE do UPDATE (id + federação + vertical) sobre o dado.
      const row = companies[p[1]];
      const ok = row && String(row.federation_id) === String(p[2]) && row.vertical === 'karate_dojo';
      return { rows: ok ? [{ id: row.id, owner_id: p[0] }] : [] };
    }
    const single = s.match(/assumption:single-count (\w+)/);
    if (single) {
      const cfg = o.singleCounts[single[1]] || {};
      return { rows: [{ n: cfg.had || 0 }] };
    }
    const singleMove = s.match(/assumption:single (\w+)/);
    if (singleMove) {
      const cfg = o.singleCounts[singleMove[1]] || {};
      return { rows: [], rowCount: cfg.moved || 0 };
    }
    const mv = s.match(/assumption:move (\w+)/);
    if (mv) {
      if (o.moveFails && o.moveFails.table === mv[1]) return o.moveFails.error;
      return { rows: [], rowCount: o.moved[mv[1]] || 0 };
    }
    if (isDiscard(s)) {
      // `id <> $2` é a paranoia que impede desativar o próprio registro.
      const ok = String(p[0]) !== String(p[1]);
      return { rows: ok ? [{ id: p[0] }] : [] };
    }
    if (isRosterEvent(s)) return { rows: [{ id: 'ev-1' }] };
    if (isTrail(s)) {
      if (o.trailFails) {
        return pgErr('42P01', 'relation "karate_dojo_registry_assumptions" does not exist');
      }
      return { rows: [{ id: 'trail-1' }] };
    }

    // ── aceite ──
    if (isRequestLock(s)) {
      return { rows: [{ id: reqId, dojo_id: contaNovaId, status: o.requestStatus }] };
    }
    if (isDupCheck(s)) {
      // Mesmo recorte do SQL, aplicado ao DADO: federação da linha, número
      // da linha, e o id excluído que o serviço mandou.
      const [fed, numero, excluido] = p;
      const hit = Object.keys(companies)
        .map((k) => companies[k])
        .find(
          (c) =>
            String(c.federation_id) === String(fed) &&
            c.fpkt_affiliation_id === numero &&
            String(c.id) !== String(excluido)
        );
      return { rows: hit ? [{ id: hit.id }] : [] };
    }
    if (isLinkUpdate(s)) {
      const row = companies[p[1]];
      if (!row || String(row.federation_id) !== String(p[2])) return { rows: [] };
      return {
        rows: [{
          id: row.id,
          // COALESCE: quem já era filiado mantém a data original.
          karate_dojo_linked_at: row.karate_dojo_linked_at || new Date('2026-08-11T12:00:00Z'),
          fpkt_affiliation_id: p[0],
        }],
      };
    }
    if (/UPDATE karate_affiliation_requests/.test(s)) return { rows: [{ id: reqId }] };
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
// 1) SEM APONTAMENTO — o aceite de sempre, byte por byte
// ============================================================
describe('F11 — aceite SEM apontamento: o dojô genuinamente novo', () => {
  test('nenhuma query de assunção roda, e quem fica filiado é a conta que pediu', async () => {
    const tx = mockApproveTx(makeWorld());

    const res = await request(app).post(approveUrl).set(staffAuth())
      .send({ fpkt_number: 'FPKT-999' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.dojo_id).toBe(contaNovaId);
    expect(res.body.fpkt_affiliation_id).toBe('FPKT-999');
    // Nada de assunção no corpo: o contrato antigo não ganhou campo nenhum.
    expect(res.body.assumption).toBeUndefined();
    expect(res.body.requester_company_id).toBeUndefined();

    expect(txHit(tx, anyAssumption)).toBe(false);
    expect(txHit(tx, isDiscard)).toBe(false);
    expect(txHit(tx, touchesCustomers)).toBe(false);

    const link = txFind(tx, isLinkUpdate);
    expect(link[1]).toEqual(['FPKT-999', contaNovaId, fedId]);

    const all = txSqls(tx);
    expect(all).toContain('BEGIN');
    expect(all).toContain('COMMIT');
    expect(all).not.toContain('ROLLBACK');
  });

  test('e a migration 275 continua irrelevante para este caminho', async () => {
    // trailFails simula a 275 ausente: sem apontamento a trilha nem é
    // chamada, então o aceite não tem como depender dela.
    const tx = mockApproveTx(makeWorld({ trailFails: true }));

    const res = await request(app).post(approveUrl).set(staffAuth())
      .send({ fpkt_number: 'FPKT-999' });

    expect(res.status).toBe(200);
    expect(txHit(tx, isTrail)).toBe(false);
    expect(txSqls(tx)).toContain('COMMIT');
  });

  test('sem apontar, o número do registro colide — é o sintoma de que faltou apontar', async () => {
    const tx = mockApproveTx(makeWorld());

    const res = await request(app).post(approveUrl).set(staffAuth())
      .send({ fpkt_number: 'FPKT-007' }); // o número que o REGISTRO já tem

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FPKT_NUMBER_TAKEN');
    expect(txHit(tx, isLinkUpdate)).toBe(false);
    expect(txSqls(tx)).toContain('ROLLBACK');
  });
});

// ============================================================
// 2) COM APONTAMENTO — a conta PASSA A SER o registro
// ============================================================
describe('F11 — aceite COM apontamento: a assunção do registro', () => {
  test('feliz: o usuário se move, o trabalho vai junto, a conta do cadastro é DESATIVADA', async () => {
    const tx = mockApproveTx(makeWorld({
      moved: { karate_dojo_students: 12, karate_dojo_classes: 3 },
      // O registro já tem a config dele: a dele vence, a da conta nova fica.
      singleCounts: { karate_dojo_reminder_config: { had: 1, moved: 0 } },
    }));

    const res = await request(app).post(approveUrl).set(staffAuth())
      .send({ fpkt_number: 'FPKT-007', target_company_id: registroId });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // (a) O DOJÔ QUE SAI FILIADO É O REGISTRO — não a conta que pediu.
    expect(res.body.dojo_id).toBe(registroId);
    expect(res.body.requester_company_id).toBe(contaNovaId);
    const link = txFind(tx, isLinkUpdate);
    expect(link[1]).toEqual(['FPKT-007', registroId, fedId]);
    // COALESCE: o registro já era filiado desde 2020 e continua sendo.
    expect(res.body.linked_at).toBe('2020-03-01T12:00:00.000Z');

    // (b) O USUÁRIO SE MOVE — uma linha, não dez mil.
    const own = txFind(tx, isOwnerTransfer);
    expect(own[1]).toEqual([senseiUserId, registroId, fedId]);
    const member = txFind(tx, isMemberOwner);
    expect(member[1]).toEqual([registroId, senseiUserId]);

    // (c) O trabalho do sensei é REAPONTADO (não copiado, não perdido).
    expect(res.body.assumption.migrated.karate_dojo_students).toBe(12);
    expect(res.body.assumption.migrated.karate_dojo_classes).toBe(3);
    expect(res.body.assumption.migrated_rows).toBe(16); // 12 + 3 + 1 config
    expect(res.body.assumption.from_company_was_empty).toBe(false);
    // A config que não migrou é DECLARADA, não some em silêncio.
    expect(res.body.assumption.kept_at_source.karate_dojo_reminder_config).toBe(1);

    // (d) A conta do cadastro é DESATIVADA, nunca apagada.
    const off = txFind(tx, isDiscard);
    expect(String(off[0])).toContain('is_active = false');
    expect(off[1]).toEqual([contaNovaId, registroId]);
    expect(res.body.assumption.from_company_discarded).toBe(true);
    expect(txHit(tx, /DELETE FROM/i)).toBe(false);

    // (e) OS PRATICANTES NÃO SE MOVEM. Esta ausência é a regra inteira.
    expect(txHit(tx, touchesCustomers)).toBe(false);

    // (f) O pedido vira approved com quem/quando, e tudo numa transação só.
    const mark = txFind(tx, isRequestApproved);
    expect(mark[1]).toEqual(['staff1', reqId]);
    const all = txSqls(tx);
    expect(all).toContain('BEGIN');
    expect(all).toContain('COMMIT');
    expect(all).not.toContain('ROLLBACK');
  });

  test('a checagem de número duplicado EXCLUI o registro (senão ele colidiria consigo mesmo)', async () => {
    const tx = mockApproveTx(makeWorld());

    const res = await request(app).post(approveUrl).set(staffAuth())
      .send({ fpkt_number: 'FPKT-007', target_company_id: registroId });

    expect(res.status).toBe(200);
    const dup = txFind(tx, isDupCheck);
    expect(dup[1]).toEqual([fedId, 'FPKT-007', registroId]);
  });

  test('conta do sensei VAZIA: nada a migrar, e ela é desativada do mesmo jeito', async () => {
    const tx = mockApproveTx(makeWorld());

    const res = await request(app).post(approveUrl).set(staffAuth())
      .send({ fpkt_number: 'FPKT-007', target_company_id: registroId });

    expect(res.status).toBe(200);
    expect(res.body.assumption.from_company_was_empty).toBe(true);
    expect(res.body.assumption.migrated_rows).toBe(0);
    expect(res.body.assumption.from_company_discarded).toBe(true);
    expect(txHit(tx, isDiscard)).toBe(true);
  });

  test('a trilha registra de onde para onde, por quem e o quê', async () => {
    const tx = mockApproveTx(makeWorld({ moved: { karate_dojo_students: 5 } }));

    const res = await request(app).post(approveUrl).set(staffAuth())
      .send({ fpkt_number: 'FPKT-007', target_company_id: registroId });

    expect(res.status).toBe(200);
    expect(res.body.assumption.trail_persisted).toBe(true);

    const ev = txFind(tx, isRosterEvent);
    expect(ev[1][0]).toBe(registroId); // o evento mora no registro
    expect(ev[1][1]).toBe(fedId);
    const payload = JSON.parse(ev[1][2])[0];
    expect(payload.from_company_id).toBe(contaNovaId);
    expect(payload.to_company_id).toBe(registroId);
    expect(payload.user_id).toBe(senseiUserId);
    expect(payload.actor_id).toBe('staff1');
    expect(payload.fpkt_affiliation_id).toBe('FPKT-007');

    const trail = txFind(tx, isTrail);
    expect(trail[1][0]).toBe(reqId);
    expect(trail[1][1]).toBe(fedId);
    expect(trail[1][2]).toBe(contaNovaId);
    expect(trail[1][3]).toBe(registroId);
    expect(trail[1][4]).toBe(senseiUserId);
    // actor_id é coluna uuid: 'staff1' vira NULL em vez de estourar 22P02 e
    // derrubar o aceite por causa do log. O rastro humano fica em actor_ref.
    expect(trail[1][5]).toBeNull();
    expect(trail[1][6]).toBe('staff1');
    expect(JSON.parse(trail[1][9]).migrated.karate_dojo_students).toBe(5);
  });

  test('migration 275 NÃO aplicada (42P01): o aceite acontece e o rastro fica na 220', async () => {
    const tx = mockApproveTx(makeWorld({ trailFails: true }));

    const res = await request(app).post(approveUrl).set(staffAuth())
      .send({ fpkt_number: 'FPKT-007', target_company_id: registroId });

    expect(res.status).toBe(200);
    expect(res.body.assumption.assumed).toBe(true);
    expect(res.body.assumption.trail_persisted).toBe(false);
    // Trilha indisponível não pode envenenar a transação: cada passo
    // best-effort roda em SAVEPOINT (armadilha tx-poison).
    expect(txHit(tx, /SAVEPOINT sp_registry_assumption/)).toBe(true);
    expect(txHit(tx, /ROLLBACK TO SAVEPOINT sp_registry_assumption/)).toBe(true);
    expect(txSqls(tx)).toContain('COMMIT');
    expect(txSqls(tx)).not.toContain('ROLLBACK');
    // E o evento da 220 (que está aplicada) foi escrito do mesmo jeito.
    expect(txHit(tx, isRosterEvent)).toBe(true);
  });
});

// ============================================================
// 3) VALIDAÇÃO DO REGISTRO APONTADO — as três perguntas
// ============================================================
describe('F11 — o registro apontado precisa ser desta federação, ser dojô e não ter dono', () => {
  test('registro de OUTRA federação → 404 TARGET_NOT_FOUND (não vaza que ele existe)', async () => {
    // O escopo é decidido pelo campo do DADO simulado, não por comparação
    // com a constante do teste: aqui a linha simplesmente é de outra fed.
    const w = makeWorld();
    w.registro.federation_id = outraFedId;
    const tx = mockApproveTx(w);

    const res = await request(app).post(approveUrl).set(staffAuth())
      .send({ fpkt_number: 'FPKT-007', target_company_id: registroId });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TARGET_NOT_FOUND');
    expect(txHit(tx, isOwnerTransfer)).toBe(false);
    expect(txHit(tx, isDiscard)).toBe(false);
    expect(txHit(tx, isLinkUpdate)).toBe(false);
    expect(txSqls(tx)).toContain('ROLLBACK');
    expect(txSqls(tx)).not.toContain('COMMIT');
  });

  test('empresa apontada não é dojô → 422 TARGET_NOT_DOJO', async () => {
    const w = makeWorld();
    w.registro.vertical = 'retail';
    const tx = mockApproveTx(w);

    const res = await request(app).post(approveUrl).set(staffAuth())
      .send({ fpkt_number: 'FPKT-007', target_company_id: registroId });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TARGET_NOT_DOJO');
    expect(txHit(tx, isOwnerTransfer)).toBe(false);
    expect(txSqls(tx)).toContain('ROLLBACK');
  });

  test('registro DESATIVADO → 409 TARGET_INACTIVE', async () => {
    const w = makeWorld();
    w.registro.is_active = false;
    const tx = mockApproveTx(w);

    const res = await request(app).post(approveUrl).set(staffAuth())
      .send({ fpkt_number: 'FPKT-007', target_company_id: registroId });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TARGET_INACTIVE');
    expect(txHit(tx, isOwnerTransfer)).toBe(false);
  });

  test('registro que JÁ TEM dono real → 409 TARGET_ALREADY_CLAIMED (seria tomar a conta de alguém)', async () => {
    // O owner do registro não é mais o user-sistema: alguém já reclamou.
    const tx = mockApproveTx(makeWorld({ systemHash: '$2b$12$hashdeoutrosensei' }));

    const res = await request(app).post(approveUrl).set(staffAuth())
      .send({ fpkt_number: 'FPKT-007', target_company_id: registroId });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TARGET_ALREADY_CLAIMED');
    expect(txHit(tx, isOwnerTransfer)).toBe(false);
    expect(txHit(tx, isDiscard)).toBe(false);
    expect(txSqls(tx)).toContain('ROLLBACK');
    expect(txSqls(tx)).not.toContain('COMMIT');
  });

  test('registro com MEMBRO real ativo → 409 TARGET_ALREADY_CLAIMED (owner de sistema não basta)', async () => {
    const tx = mockApproveTx(makeWorld({ realMembers: 1 }));

    const res = await request(app).post(approveUrl).set(staffAuth())
      .send({ fpkt_number: 'FPKT-007', target_company_id: registroId });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TARGET_ALREADY_CLAIMED');
    expect(txHit(tx, isOwnerTransfer)).toBe(false);
  });

  test('a conta que pediu é ela própria um registro (owner de sistema) → 422 REQUESTER_IS_SYSTEM_OWNED', async () => {
    // Sem sensei de verdade não há quem assumir o registro apontado.
    const w = makeWorld();
    w.contaNova.owner_id = systemUserId;
    const tx = mockApproveTx(w);

    const res = await request(app).post(approveUrl).set(staffAuth())
      .send({ fpkt_number: 'FPKT-007', target_company_id: registroId });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('REQUESTER_IS_SYSTEM_OWNED');
    expect(txHit(tx, isOwnerTransfer)).toBe(false);
    expect(txSqls(tx)).toContain('ROLLBACK');
  });
});

// ============================================================
// 4) ENTRADA MALFORMADA E ESTADO — nada acontece pela metade
// ============================================================
describe('F11 — apontamento inválido e pedido já resolvido', () => {
  test('target_company_id que não é uuid → 422 antes de abrir transação (não vira 22P02)', async () => {
    mockApproveTx(makeWorld());

    const res = await request(app).post(approveUrl).set(staffAuth())
      .send({ fpkt_number: 'FPKT-007', target_company_id: 'o-dojo-do-joao' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TARGET_COMPANY_INVALID');
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('apontar a PRÓPRIA conta que pediu → 422 TARGET_IS_REQUESTER, sem migrar nada', async () => {
    const tx = mockApproveTx(makeWorld());

    const res = await request(app).post(approveUrl).set(staffAuth())
      .send({ fpkt_number: 'FPKT-999', target_company_id: contaNovaId });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TARGET_IS_REQUESTER');
    expect(txHit(tx, anyAssumption)).toBe(false);
    expect(txHit(tx, isLinkUpdate)).toBe(false);
    expect(txSqls(tx)).toContain('ROLLBACK');
  });

  test('pedido JÁ RESOLVIDO → 409 e NENHUMA assunção acontece', async () => {
    const tx = mockApproveTx(makeWorld({ requestStatus: 'approved' }));

    const res = await request(app).post(approveUrl).set(staffAuth())
      .send({ fpkt_number: 'FPKT-007', target_company_id: registroId });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('JA_RESOLVIDA');
    // A primeira camada de idempotência: reexecutar não reassume nada.
    expect(txHit(tx, anyAssumption)).toBe(false);
    expect(txSqls(tx)).toContain('ROLLBACK');
  });

  test('colisão de unicidade na migração → 409 MIGRACAO_COLIDIU (e não "número em uso")', async () => {
    const err = pgErr('23505', 'duplicate key value violates unique constraint "uq_kds_dojo_cpf"');
    err.constraint = 'uq_kds_dojo_cpf';
    const tx = mockApproveTx(makeWorld({
      moveFails: { table: 'karate_dojo_students', error: err },
    }));

    const res = await request(app).post(approveUrl).set(staffAuth())
      .send({ fpkt_number: 'FPKT-007', target_company_id: registroId });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('MIGRACAO_COLIDIU');
    expect(res.body.error).toMatch(/karate_dojo_students/);
    // Nada pela metade: o vínculo não foi marcado e a conta não foi descartada.
    expect(txHit(tx, isLinkUpdate)).toBe(false);
    expect(txHit(tx, isDiscard)).toBe(false);
    expect(txSqls(tx)).toContain('ROLLBACK');
    expect(txSqls(tx)).not.toContain('COMMIT');
  });
});
