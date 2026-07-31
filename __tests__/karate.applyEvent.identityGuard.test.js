// ============================================================
// AURA KARATÊ — F7.3-A: o MOTOR DE SYNC LEGADO respeita o marcador
//
// Alvo: upsertPractitioner (via applyEvent) em
// src/services/karateApplyEvent.js.
//
// ── POR QUE ESTE ARQUIVO EXISTE ─────────────────────────────
// Das cinco portas por onde a federação reescrevia a PESSOA, esta era a
// mais silenciosa: sem tela, sem ator humano, disparada por um webhook.
// practitioner_added casava por CPF e sobrescrevia
// name/rg/birth_date/email/phone por COALESCE — inclusive numa ficha já
// ADOTADA por um dojô (customers.karate_identity_managed_by = 'dojo').
// O sensei corrigia, o sync subia, e no dia seguinte um evento antigo da
// fila desfazia tudo sem ninguém ver.
//
// ── O QUE ESTE ARQUIVO TRAVA ────────────────────────────────
//   1. ficha do dojô → só dojo_id é escrito (o vínculo é da federação);
//      a PESSOA fica de fora e o resultado DECLARA identity_skipped;
//   2. o evento DRENA (ok/applied) em vez de falhar: re-tentar para
//      sempre um payload que nunca vai ganhar autorização seria ruído
//      permanente no painel de sync;
//   3. ficha da federação → o UPDATE completo de sempre, intacto;
//   4. sem match por CPF → o FPKT_NUMBER_REQUIRED da H1/H2 continua de pé;
//   5. sem a migration 262 (42703) → degrada para o caminho normal DENTRO
//      de um SAVEPOINT, sem envenenar a transação do runner.
//
// ── ESTILO DE MOCK ──────────────────────────────────────────
// Despacho por TEXTO do SQL (regex). A guarda acrescentou TRÊS queries no
// meio de upsertPractitioner (SAVEPOINT + SELECT do dono + RELEASE): com
// fila posicional (o makeMockClient de karate.trackK.test.js) toda
// resposta seguinte andaria um degrau.
// ============================================================
'use strict';

const { applyEvent } = require('../src/services/karateApplyEvent');

const FED = 'fed-0000-0000-0000-000000000001';
const DOJO = 'dojo-0000-0000-0000-000000000001';
const IDENTITY_DOJO = 'dojo-0000-0000-0000-000000000009';
const IDENTITY_DOJO_NAME = 'Dojô Kondei Brasil';
const CUSTOMER_ID = 'cust-0000-0000-0000-000000000001';

function ev(overrides = {}) {
  return {
    id: 'evt-1',
    connection_id: 'conn-1',
    federation_id: FED,
    dojo_id: DOJO,
    direction: 'dojo_to_fed',
    status: 'pending',
    attempts: 0,
    ...overrides,
  };
}

// Payload que TENTA reescrever a pessoa inteira.
function practitionerAdded(overrides = {}) {
  return ev({
    event_type: 'practitioner_added',
    payload: {
      event_uid: 'U1',
      full_name: 'Nome Que Veio Do Evento',
      cpf: '123.456.789-09',
      rg: '99.999.999-9',
      birth_date: '1998-03-04',
      email: 'evento@x.com',
      phone: '11912345678',
      ...overrides,
    },
  });
}

// Linha do OWNER_SQL da guarda (karateIdentityWriteGuard.OWNER_SQL).
function ownerRow(managedBy) {
  return {
    id: CUSTOMER_ID,
    practitioner_label: 'Ana Preta',
    fpkt_number: 'FPKT-001',
    federation_id: FED,
    karate_identity_managed_by: managedBy,
    karate_identity_dojo_id: managedBy === 'dojo' ? IDENTITY_DOJO : null,
    identity_dojo_name: managedBy === 'dojo' ? IDENTITY_DOJO_NAME : null,
  };
}

// ── Despacho de mock por SQL (nunca por posição) ────────────
// A primeira regex que casar com o texto do SQL responde;
// SAVEPOINT/RELEASE/ROLLBACK e qualquer query nova caem no fallback sem
// deslocar mais nada. Uma resposta pode ser função — inclusive uma que
// devolve Promise.reject (erro de schema).
function makeClient(routes = [], fallback = { rows: [] }) {
  const query = jest.fn().mockImplementation((sql, params) => {
    const text = typeof sql === 'string' ? sql : '';
    for (const [pattern, reply] of routes) {
      if (pattern.test(text)) {
        return Promise.resolve(typeof reply === 'function' ? reply(text, params) : reply);
      }
    }
    return Promise.resolve(fallback);
  });
  return { query };
}

function sqlList(mockFn) {
  return mockFn.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
}

function callsMatching(mockFn, pattern) {
  return mockFn.mock.calls.filter((c) => typeof c[0] === 'string' && pattern.test(c[0]));
}

// Rotas comuns: claim na trilha de dedupe + o lookup por CPF acha a ficha.
// `ownerReply` é o único ponto que cada cenário customiza.
function routesWithMatch(ownerReply) {
  return [
    [/INSERT\s+INTO\s+karate_sync_applied/i, { rows: [{ id: 'applied-1' }] }],
    // OWNER_SQL da guarda — precisa vir ANTES de qualquer regex ampla de
    // SELECT em customers.
    [/AS\s+practitioner_label/i, ownerReply],
    // lookup por CPF do próprio upsertPractitioner
    [/SELECT\s+id\s+FROM\s+customers/i, { rows: [{ id: CUSTOMER_ID }] }],
  ];
}

function schemaError(code) {
  const e = new Error('column c.karate_identity_managed_by does not exist');
  e.code = code;
  return e;
}

// A guarda e o motor avisam no log quando pulam/degradam — comportamento
// desejado, mas não precisa poluir a saída do CI.
let warnSpy;
beforeAll(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterAll(() => { warnSpy.mockRestore(); });
beforeEach(() => jest.clearAllMocks());

// ════════════════════════════════════════════════════════════
// FICHA MANTIDA POR DOJÔ — a PESSOA não é sobrescrita
// ════════════════════════════════════════════════════════════
describe('practitioner_added em ficha managed_by=dojo', () => {
  it('NÃO escreve name/rg/birth_date/email/phone — só dojo_id, que é da federação', async () => {
    const client = makeClient(routesWithMatch({ rows: [ownerRow('dojo')] }));

    await applyEvent(client, practitionerAdded());

    const updates = callsMatching(client.query, /UPDATE\s+customers\s+SET/i);
    expect(updates).toHaveLength(1);

    const sql = updates[0][0];
    expect(sql).not.toMatch(/\bname\s*=/i);
    expect(sql).not.toMatch(/\brg\s*=/i);
    expect(sql).not.toMatch(/\bbirth_date\s*=/i);
    expect(sql).not.toMatch(/\bemail\s*=/i);
    expect(sql).not.toMatch(/\bphone\s*=/i);

    // O que a federação EMITE continua sendo aplicado: onde a pessoa treina.
    expect(sql).toMatch(/dojo_id\s*=\s*COALESCE/i);
    expect(updates[0][1]).toEqual([CUSTOMER_ID, DOJO]);
  });

  it('resultado DECLARA identity_skipped:true + identity_dojo_id (pular em silêncio não vale)', async () => {
    const client = makeClient(routesWithMatch({ rows: [ownerRow('dojo')] }));

    const res = await applyEvent(client, practitionerAdded());

    expect(res.kind).toBe('practitioner');
    expect(res.identity_skipped).toBe(true);
    expect(res.identity_dojo_id).toBe(IDENTITY_DOJO);
    expect(res.created).toBe(false);
    expect(res.targetId).toBe(CUSTOMER_ID);
    expect(res.detail).toMatch(/identidade não sobrescrita/i);
  });

  it('o evento DRENA (ok:true, applied:true) — não vira erro nem fica re-tentando para sempre', async () => {
    const client = makeClient(routesWithMatch({ rows: [ownerRow('dojo')] }));

    const res = await applyEvent(client, practitionerAdded());

    expect(res.ok).toBe(true);
    expect(res.applied).toBe(true);
    expect(res.deferred).toBeUndefined();
    expect(res.invalid).toBeUndefined();
  });

  it('a leitura do marcador roda em SAVEPOINT e é solta com RELEASE (nunca ROLLBACK nu)', async () => {
    const client = makeClient(routesWithMatch({ rows: [ownerRow('dojo')] }));

    await applyEvent(client, practitionerAdded());

    const all = sqlList(client.query);
    expect(all.some((s) => /^\s*SAVEPOINT sp_identity_guard\s*$/.test(s))).toBe(true);
    expect(all.some((s) => /RELEASE SAVEPOINT sp_identity_guard/.test(s))).toBe(true);
    // Um ROLLBACK nu aqui desfaria a transação inteira do runner.
    expect(all.some((s) => /^\s*ROLLBACK\s*;?\s*$/i.test(s))).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════
// FICHA DA FEDERAÇÃO — comportamento de sempre, intacto
// ════════════════════════════════════════════════════════════
describe('practitioner_added em ficha managed_by=federation', () => {
  it('o UPDATE completo de sempre roda (name/rg/birth_date/email/phone por COALESCE)', async () => {
    const client = makeClient(routesWithMatch({ rows: [ownerRow('federation')] }));

    await applyEvent(client, practitionerAdded());

    const updates = callsMatching(client.query, /UPDATE\s+customers\s+SET/i);
    expect(updates).toHaveLength(1);

    const sql = updates[0][0];
    expect(sql).toMatch(/name\s*=\s*COALESCE/i);
    expect(sql).toMatch(/rg\s*=\s*COALESCE/i);
    expect(sql).toMatch(/birth_date\s*=\s*COALESCE/i);
    expect(sql).toMatch(/email\s*=\s*COALESCE/i);
    expect(sql).toMatch(/phone\s*=\s*COALESCE/i);
    expect(sql).toMatch(/dojo_id\s*=\s*COALESCE/i);

    // Ordem dos parâmetros preservada: [id, nome, rg, nascimento, email, telefone, dojo]
    expect(updates[0][1]).toEqual([
      CUSTOMER_ID,
      'Nome Que Veio Do Evento',
      '99.999.999-9',
      '1998-03-04',
      'evento@x.com',
      '11912345678',
      DOJO,
    ]);
  });

  it('identity_skipped é false e identity_dojo_id é null', async () => {
    const client = makeClient(routesWithMatch({ rows: [ownerRow('federation')] }));

    const res = await applyEvent(client, practitionerAdded());

    expect(res.ok).toBe(true);
    expect(res.applied).toBe(true);
    expect(res.identity_skipped).toBe(false);
    expect(res.identity_dojo_id).toBeNull();
    expect(res.detail).toBeUndefined();
  });

  it('praticante que a guarda não encontra (0 linhas) também segue o caminho normal', async () => {
    const client = makeClient(routesWithMatch({ rows: [] }));

    const res = await applyEvent(client, practitionerAdded());

    expect(res.identity_skipped).toBe(false);
    const sql = callsMatching(client.query, /UPDATE\s+customers\s+SET/i)[0][0];
    expect(sql).toMatch(/name\s*=\s*COALESCE/i);
  });
});

// ════════════════════════════════════════════════════════════
// SEM MATCH POR CPF — a regra H1/H2 continua de pé
// ════════════════════════════════════════════════════════════
describe('practitioner_added sem correspondência por CPF (H1/H2)', () => {
  it('lança FPKT_NUMBER_REQUIRED, não recuperável, sem inventar número', async () => {
    const client = makeClient([
      [/INSERT\s+INTO\s+karate_sync_applied/i, { rows: [{ id: 'applied-1' }] }],
      [/SELECT\s+id\s+FROM\s+customers/i, { rows: [] }], // não achou por CPF
    ]);

    let threw = null;
    try {
      await applyEvent(client, practitionerAdded());
    } catch (e) { threw = e; }

    expect(threw).not.toBeNull();
    expect(threw.code).toBe('FPKT_NUMBER_REQUIRED');
    expect(threw.recoverable).toBe(false);
    expect(threw.message).toMatch(/número de matrícula FPKT/i);
  });

  it('não toca customers e nem consulta a guarda (não há ficha sobre a qual perguntar)', async () => {
    const client = makeClient([
      [/INSERT\s+INTO\s+karate_sync_applied/i, { rows: [{ id: 'applied-1' }] }],
      [/SELECT\s+id\s+FROM\s+customers/i, { rows: [] }],
    ]);

    try { await applyEvent(client, practitionerAdded()); } catch (_) { /* esperado */ }

    expect(callsMatching(client.query, /UPDATE\s+customers/i)).toHaveLength(0);
    expect(callsMatching(client.query, /INSERT\s+INTO\s+customers/i)).toHaveLength(0);
    expect(callsMatching(client.query, /AS\s+practitioner_label/i)).toHaveLength(0);
    expect(callsMatching(client.query, /SAVEPOINT sp_identity_guard/)).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════
// MIGRATION 262 PENDENTE — degrada sem envenenar a transação
// ════════════════════════════════════════════════════════════
describe('42703 na leitura do marcador (migration 262 pendente)', () => {
  it('degrada para o caminho normal: o UPDATE completo roda', async () => {
    const client = makeClient(routesWithMatch(() => Promise.reject(schemaError('42703'))));

    const res = await applyEvent(client, practitionerAdded());

    expect(res.ok).toBe(true);
    expect(res.applied).toBe(true);
    expect(res.identity_skipped).toBe(false);

    const updates = callsMatching(client.query, /UPDATE\s+customers\s+SET/i);
    expect(updates).toHaveLength(1);
    expect(updates[0][0]).toMatch(/name\s*=\s*COALESCE/i);
    expect(updates[0][0]).toMatch(/birth_date\s*=\s*COALESCE/i);
  });

  it('emite SAVEPOINT + ROLLBACK TO SAVEPOINT e NENHUM ROLLBACK nu (tx do runner intacta)', async () => {
    const client = makeClient(routesWithMatch(() => Promise.reject(schemaError('42703'))));

    await applyEvent(client, practitionerAdded());

    // Asserção pelo TEXTO do SQL — nunca por posição na fila.
    const all = sqlList(client.query);
    expect(all.some((s) => /^\s*SAVEPOINT sp_identity_guard\s*$/.test(s))).toBe(true);
    expect(all.some((s) => /ROLLBACK TO SAVEPOINT sp_identity_guard/.test(s))).toBe(true);
    expect(all.some((s) => /^\s*ROLLBACK\s*;?\s*$/i.test(s))).toBe(false);
    expect(all.some((s) => /^\s*COMMIT\s*;?\s*$/i.test(s))).toBe(false);
  });

  it('42P01 (tabela companies ausente no JOIN) degrada do mesmo jeito', async () => {
    const client = makeClient(routesWithMatch(() => Promise.reject(schemaError('42P01'))));

    const res = await applyEvent(client, practitionerAdded());

    expect(res.ok).toBe(true);
    expect(res.identity_skipped).toBe(false);
    expect(callsMatching(client.query, /UPDATE\s+customers\s+SET/i)[0][0]).toMatch(/name\s*=\s*COALESCE/i);
  });
});
