// ============================================================
// AURA KARATÊ — Track K (sync real / applyEvent)
// Testa o núcleo PURO (decideMutation, buildDedupeKey) e o applyEvent
// DB-facing via mock client sequencial (sem Postgres real).
// Estilo: __tests__/karate.trackI.test.js (motor puro) +
//         tests/unit/creditUnify.test.js (makeMockClient).
// ============================================================
'use strict';

const {
  decideMutation,
  buildDedupeKey,
  externalIdentity,
  digits,
  applyEvent,
} = require('../src/services/karateApplyEvent');

// ── helpers ─────────────────────────────────────────────────
const FED = 'fed-0000-0000-0000-000000000001';
const DOJO = 'dojo-0000-0000-0000-000000000001';

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

// mock client sequencial: responde rows[call] na ordem das queries.
function makeMockClient(responses = []) {
  let call = 0;
  const query = jest.fn().mockImplementation(() => {
    const res = responses[call] ?? { rows: [] };
    call++;
    return Promise.resolve(res);
  });
  return { query };
}

// client que simula schema ausente (42P01) na 1ª query (claimApplied).
function makeMissingSchemaClient() {
  const query = jest.fn().mockImplementation(() => {
    const e = new Error('relation "karate_sync_applied" does not exist');
    e.code = '42P01';
    return Promise.reject(e);
  });
  return { query };
}

// ════════════════════════════════════════════════════════════
// NÚCLEO PURO — decideMutation
// ════════════════════════════════════════════════════════════
describe('decideMutation — por tipo de evento', () => {
  it('practitioner_added válido → kind practitioner com dados normalizados', () => {
    const d = decideMutation(ev({
      event_type: 'practitioner_added',
      payload: { full_name: ' João Silva ', cpf: '123.456.789-00', email: 'j@x.com' },
    }));
    expect(d.kind).toBe('practitioner');
    expect(d.data.full_name).toBe('João Silva');
    expect(d.data.cpf).toBe('12345678900');
    expect(d.data.email).toBe('j@x.com');
  });

  it('attendance válido → kind attendance', () => {
    const d = decideMutation(ev({
      event_type: 'attendance',
      payload: { cpf: '111', session_date: '2026-06-10', present: false },
    }));
    expect(d.kind).toBe('attendance');
    expect(d.data.session_date).toBe('2026-06-10');
    expect(d.data.present).toBe(false);
  });

  it('annuity_paid válido → kind annuity', () => {
    const d = decideMutation(ev({
      event_type: 'annuity_paid',
      payload: { reference_period: '2026', amount: 120, paid_at: '2026-06-01' },
    }));
    expect(d.kind).toBe('annuity');
    expect(d.data.reference_period).toBe('2026');
    expect(d.data.amount).toBe(120);
  });

  it('tipo conhecido mas não consumido (exam_result) → parked', () => {
    const d = decideMutation(ev({ event_type: 'exam_result', payload: { x: 1 } }));
    expect(d.kind).toBe('parked');
  });

  it('handshake → parked (não é consumido na Track K)', () => {
    const d = decideMutation(ev({ event_type: 'handshake', payload: null }));
    expect(d.kind).toBe('parked');
  });

  it('direction fed_to_dojo → ignored', () => {
    const d = decideMutation(ev({
      event_type: 'practitioner_added', direction: 'fed_to_dojo',
      payload: { full_name: 'X' },
    }));
    expect(d.kind).toBe('ignored');
  });

  it('sem event_type → ignored', () => {
    expect(decideMutation(ev({ payload: {} })).kind).toBe('ignored');
  });
});

describe('decideMutation — payloads malformados → invalid', () => {
  it('practitioner_added sem full_name', () => {
    const d = decideMutation(ev({ event_type: 'practitioner_added', payload: { cpf: '1' } }));
    expect(d.kind).toBe('invalid');
  });
  it('attendance sem session_date', () => {
    const d = decideMutation(ev({ event_type: 'attendance', payload: { cpf: '1' } }));
    expect(d.kind).toBe('invalid');
  });
  it('attendance com session_date em formato errado', () => {
    const d = decideMutation(ev({ event_type: 'attendance', payload: { cpf: '1', session_date: '10/06/2026' } }));
    expect(d.kind).toBe('invalid');
  });
  it('annuity_paid sem reference_period', () => {
    const d = decideMutation(ev({ event_type: 'annuity_paid', payload: { amount: 1 } }));
    expect(d.kind).toBe('invalid');
  });
  it('annuity_paid com amount negativo', () => {
    const d = decideMutation(ev({ event_type: 'annuity_paid', payload: { reference_period: '2026', amount: -5 } }));
    expect(d.kind).toBe('invalid');
  });
  it('payload não-objeto (array) num tipo consumido', () => {
    const d = decideMutation(ev({ event_type: 'practitioner_added', payload: [1, 2] }));
    expect(d.kind).toBe('invalid');
  });
});

// ════════════════════════════════════════════════════════════
// NÚCLEO PURO — buildDedupeKey / externalIdentity
// ════════════════════════════════════════════════════════════
describe('buildDedupeKey — estável e discriminante', () => {
  it('event_uid tem precedência e é estável entre re-entregas (linhas diferentes)', () => {
    const a = buildDedupeKey(ev({ id: 'row-A', event_type: 'attendance', payload: { event_uid: 'U1', cpf: '1', session_date: '2026-06-10' } }));
    const b = buildDedupeKey(ev({ id: 'row-B', event_type: 'attendance', payload: { event_uid: 'U1', cpf: '1', session_date: '2026-06-10' } }));
    expect(a).toBe(b); // mesma chave → dedupe apesar de id de linha diferente
  });

  it('chave natural difere por fato (datas diferentes)', () => {
    const d1 = buildDedupeKey(ev({ event_type: 'attendance', payload: { cpf: '1', session_date: '2026-06-10' } }));
    const d2 = buildDedupeKey(ev({ event_type: 'attendance', payload: { cpf: '1', session_date: '2026-06-11' } }));
    expect(d1).not.toBe(d2);
  });

  it('practitioner usa external_id ou cpf como identidade', () => {
    expect(externalIdentity(ev({ event_type: 'practitioner_added', payload: { external_id: 'P9' } }))).toBe('ext:P9');
    expect(externalIdentity(ev({ event_type: 'practitioner_added', payload: { cpf: '123.456' } }))).toBe('cpf:123456');
  });

  it('null quando não há identidade dedupável', () => {
    expect(buildDedupeKey(ev({ event_type: 'practitioner_added', payload: { full_name: 'X' } }))).toBeNull();
  });

  it('chave varia por federação (mesmo fato, federações distintas)', () => {
    const base = { event_type: 'annuity_paid', payload: { reference_period: '2026' } };
    const k1 = buildDedupeKey(ev({ ...base, federation_id: 'F1' }));
    const k2 = buildDedupeKey(ev({ ...base, federation_id: 'F2' }));
    expect(k1).not.toBe(k2);
  });
});

describe('digits', () => {
  it('extrai só dígitos', () => {
    expect(digits('123.456.789-00')).toBe('12345678900');
    expect(digits('   ')).toBeNull();
    expect(digits(null)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════
// DB-FACING — applyEvent (mock client)
// ════════════════════════════════════════════════════════════
describe('applyEvent — aplicação idempotente', () => {
  beforeEach(() => jest.clearAllMocks());

  it('practitioner novo (sem match por CPF): NÃO inventa número FPKT — falha explícita, não recuperável (H2)', async () => {
    // (14/07/2026 — H2) O contrato de practitioner_added nunca carrega
    // número FPKT (ver karateApplyEvent.js, cabeçalho + comentário em
    // upsertPractitioner). Antes desta mudança, uma criação nova (sem
    // match por CPF) chamava nextPractitionerRegistrationNumber e
    // inventava um número — mesma classe de bug do quick-add do portal
    // do sensei, agora fechada. Sequência real (2 queries antes de
    // lançar o erro):
    //   0: INSERT karate_sync_applied … ON CONFLICT DO NOTHING RETURNING id  (claimApplied)
    //   1: SELECT customers WHERE cpf …                                       (upsertPractitioner — CPF lookup, não acha)
    // upsertPractitioner lança sem rodar nenhum INSERT em customers.
    const client = makeMockClient([
      { rows: [{ id: 'applied-1' }] },   // 0: claimApplied → claimed
      { rows: [] },                      // 1: SELECT customer por cpf → não existe
    ]);
    let threw = null;
    try {
      await applyEvent(client, ev({
        event_type: 'practitioner_added',
        payload: { event_uid: 'U1', full_name: 'Maria', cpf: '999' },
      }));
    } catch (e) { threw = e; }
    expect(threw).not.toBeNull();
    expect(threw.recoverable).toBe(false);
    expect(threw.message).toMatch(/número de matrícula FPKT/i);
    // só claim + CPF lookup rodaram — nenhum INSERT em customers foi tentado
    expect(client.query).toHaveBeenCalledTimes(2);
    const allSql = client.query.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : '')).join('\n');
    expect(allSql).not.toMatch(/INSERT INTO customers/i);
  });

  it('evento DUPLICADO: claim não retorna linha → no-op, NÃO muta', async () => {
    const client = makeMockClient([
      { rows: [] }, // claimApplied → ON CONFLICT DO NOTHING → sem linha = já aplicado
    ]);
    const res = await applyEvent(client, ev({
      event_type: 'practitioner_added',
      payload: { event_uid: 'U1', full_name: 'Maria', cpf: '999' },
    }));
    expect(res.ok).toBe(true);
    expect(res.applied).toBe(false);
    expect(res.duplicate).toBe(true);
    // só a query de claim rodou — nenhuma mutação
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('attendance: resolve praticante por cpf + UPSERT karate_attendance', async () => {
    const client = makeMockClient([
      { rows: [{ id: 'applied-2' }] },  // claim
      { rows: [{ id: 'cust-7' }] },     // resolvePractitionerId por cpf
      { rows: [{ id: 'att-1' }] },      // INSERT karate_attendance
      { rows: [] },                     // tag
    ]);
    const res = await applyEvent(client, ev({
      event_type: 'attendance',
      payload: { event_uid: 'A1', cpf: '999', session_date: '2026-06-10' },
    }));
    expect(res.ok).toBe(true);
    expect(res.applied).toBe(true);
    expect(res.kind).toBe('attendance');
    expect(res.targetId).toBe('att-1');
  });

  it('attendance com praticante inexistente → recuperável (ok=false p/ re-tentar)', async () => {
    const client = makeMockClient([
      { rows: [{ id: 'applied-3' }] },  // claim
      { rows: [] },                     // resolvePractitionerId → vazio
    ]);
    let threw = null;
    try {
      await applyEvent(client, ev({
        event_type: 'attendance',
        payload: { event_uid: 'A2', cpf: '404', session_date: '2026-06-10' },
      }));
    } catch (e) { threw = e; }
    expect(threw).not.toBeNull();
    expect(threw.recoverable).toBe(true);
  });

  // (F2-sync) annuity_paid agora LIQUIDA A PARCELA pelo primitivo do ledger e
  // deixa o header ser derivado — ver cobertura de ponta a ponta em
  // tests/integration/karateSyncAnnuitySettle.test.js. Aqui asseguramos só a
  // orquestração via mock sequencial. Sequência de queries:
  //   0: claim INSERT karate_sync_applied … RETURNING id
  //   1: SELECT id FROM karate_dojo_annuity_history (lookup do header)
  //   2: SELECT … karate_annuity_installments … FOR UPDATE (settlePeriodOnClient)
  //   3: UPDATE karate_annuity_installments (writeDistribution — baixa da parcela)
  //   4: INSERT karate_annuity_payments (writeDistribution — ledger)
  //   5: SELECT * karate_annuity_installments ORDER BY seq (rollup getInstallments)
  //   6: UPDATE karate_dojo_annuity_history … RETURNING * (rollup do header)
  //   7: UPDATE karate_sync_applied (tag)
  it('annuity_paid: liquida a parcela do período (ledger + rollup do header)', async () => {
    const client = makeMockClient([
      { rows: [{ id: 'applied-4' }] },                                   // 0 claim
      { rows: [{ id: 'ann-1' }] },                                       // 1 header lookup
      { rows: [{ id: 'inst-1', annuity_id: 'ann-1', federation_id: FED, seq: 1, amount: 100, amount_paid: 0, status: 'pending', due_date: '2026-05-31', kind: 'anuidade' }] }, // 2 FOR UPDATE
      { rows: [] },                                                      // 3 UPDATE parcela
      { rows: [] },                                                      // 4 INSERT ledger
      { rows: [{ id: 'inst-1', annuity_id: 'ann-1', seq: 1, amount: 100, amount_paid: 100, status: 'paid', due_date: '2026-05-31', paid_at: '2026-06-01' }] }, // 5 rollup getInstallments
      { rows: [{ id: 'ann-1', status: 'paid' }] },                       // 6 rollup UPDATE header
      { rows: [] },                                                      // 7 tag
    ]);
    const res = await applyEvent(client, ev({
      event_type: 'annuity_paid',
      payload: { event_uid: 'N1', reference_period: '2026', amount: 100 },
    }));
    expect(res.ok).toBe(true);
    expect(res.kind).toBe('annuity');
    expect(res.settled).toBe(true);
    expect(res.targetId).toBe('ann-1');
  });

  it('annuity_paid sem cobrança prévia: HOLD (park-and-replay, NÃO drena)', async () => {
    const client = makeMockClient([
      { rows: [{ id: 'applied-5' }] },  // claim
      { rows: [] },                     // header lookup → cobrança não existe
    ]);
    const res = await applyEvent(client, ev({
      event_type: 'annuity_paid',
      payload: { event_uid: 'N2', reference_period: '2099' },
    }));
    // NÃO drena: o runner/engine faz ROLLBACK e mantém pending até a cobrança nascer.
    expect(res.ok).toBe(false);
    expect(res.hold).toBe(true);
    expect(res.applied).toBe(false);
  });

  it('tipo parked: reivindica + tag, sem mutar dados de negócio', async () => {
    const client = makeMockClient([
      { rows: [{ id: 'applied-6' }] },  // claim (identidade = row:id)
      { rows: [] },                     // tag
    ]);
    const res = await applyEvent(client, ev({ id: 'evt-park', event_type: 'transfer', payload: { foo: 1 } }));
    expect(res.ok).toBe(true);
    expect(res.parked).toBe(true);
    expect(client.query).toHaveBeenCalledTimes(2); // claim + tag, nenhuma mutação
  });

  it('payload inválido → ok=true (drena) mas applied=false, sem tocar a trilha', async () => {
    const client = makeMockClient([]);
    const res = await applyEvent(client, ev({ event_type: 'practitioner_added', payload: { cpf: '1' } }));
    expect(res.ok).toBe(true);
    expect(res.invalid).toBe(true);
    expect(client.query).not.toHaveBeenCalled(); // nem chega a reivindicar
  });

  it('ignored (fed_to_dojo) → ok=true sem nenhuma query', async () => {
    const client = makeMockClient([]);
    const res = await applyEvent(client, ev({
      event_type: 'attendance', direction: 'fed_to_dojo',
      payload: { cpf: '1', session_date: '2026-06-10' },
    }));
    expect(res.ok).toBe(true);
    expect(res.ignored).toBe(true);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('schema ausente (42P01 no claim) → deferred (não drena)', async () => {
    const client = makeMissingSchemaClient();
    const res = await applyEvent(client, ev({
      event_type: 'annuity_paid', payload: { event_uid: 'N9', reference_period: '2026' },
    }));
    expect(res.ok).toBe(false);
    expect(res.deferred).toBe(true);
  });
});
