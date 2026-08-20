// ============================================================
// AURA KARATÊ — F2-sync (follow-up Onda 1 do QA do Dojô)
//
// O evento annuity_paid do sync passa a liquidar a(s) PARCELA(s) do período
// pelo MESMO primitivo do /confirm (ledger karate_annuity_payments +
// amount_paid), deixando syncAnnuityHeaderRollup DERIVAR o header. Testa, de
// ponta a ponta e SEM mockar a lógica de negócio (computeDistribution /
// writeDistribution / syncAnnuityHeaderRollup são REAIS):
//
//   Tarefa 1 — fonte única = parcela; header é projeção.
//   Tarefa 2 — park-and-replay (pagamento antes da cobrança nascer).
//   Tarefa 3 — invariante do guardrail: header 'paid' ⇒ TODAS as parcelas
//              pagas (nunca marca 'paid' um pagamento parcial).
// ============================================================
'use strict';

const { applyEvent } = require('../../src/services/karateApplyEvent');
const { createFakeClient, round2 } = require('../helpers/fakeSyncAnnuityDb');

const FED = 'fed-1';
const DOJO = 'dojo-1';
const ANNUITY = 'ann-1';

function ev(overrides = {}) {
  return {
    id: 'evt-1',
    connection_id: 'conn-1',
    federation_id: FED,
    dojo_id: DOJO,
    direction: 'dojo_to_fed',
    event_type: 'annuity_paid',
    status: 'pending',
    attempts: 0,
    ...overrides,
  };
}

function header(overrides = {}) {
  return {
    id: ANNUITY, dojo_id: DOJO, federation_id: FED, reference_period: '2026',
    status: 'pending', paid_at: null, amount: 0, due_date: null,
    payment_method: null, transaction_id: null, ...overrides,
  };
}

function inst(overrides = {}) {
  return {
    id: 'inst-1', annuity_id: ANNUITY, federation_id: FED, seq: 1,
    amount: 500, amount_paid: 0, status: 'pending', due_date: '2026-05-31',
    kind: 'anuidade', payment_method: null, paid_at: null, transaction_id: null,
    ...overrides,
  };
}

// Invariante do guardrail (Tarefa 3): nenhum header 'paid' com parcela não paga.
function guardrailHolds(state) {
  const h = state.header;
  if (!h || h.status !== 'paid') return true;
  return state.installments
    .filter((i) => String(i.annuity_id) === String(h.id))
    .every((i) => i.status === 'paid');
}

describe('F2-sync — Tarefa 1: liquida a PARCELA, header é projeção', () => {
  test('amount cheio → parcela paga, ledger gravado, header DERIVA paid', async () => {
    const state = { header: header(), installments: [inst()], payments: [] };
    const client = createFakeClient(state);

    const res = await applyEvent(client, ev({
      payload: { event_uid: 'U1', reference_period: '2026', amount: 500, paid_at: '2026-05-10' },
    }));

    expect(res.ok).toBe(true);
    expect(res.kind).toBe('annuity');
    expect(res.settled).toBe(true);
    // parcela é a fonte de verdade
    expect(state.installments[0].status).toBe('paid');
    expect(round2(state.installments[0].amount_paid)).toBe(500);
    // ledger tem a baixa (o summary/extrato leem daqui)
    expect(state.payments).toHaveLength(1);
    expect(round2(state.payments[0].amount)).toBe(500);
    // header é DERIVADO pelo rollup
    expect(state.header.status).toBe('paid');
    expect(state.header.paid_at).toBeTruthy();
    expect(guardrailHolds(state)).toBe(true);
  });

  test('sem amount → liquida o SALDO EM ABERTO inteiro', async () => {
    const state = {
      header: header(),
      installments: [
        inst({ id: 'i1', seq: 1, amount: 280, due_date: '2026-05-31' }),
        inst({ id: 'i2', seq: 2, amount: 280, due_date: '2026-11-30' }),
      ],
      payments: [],
    };
    const client = createFakeClient(state);

    const res = await applyEvent(client, ev({
      payload: { event_uid: 'U2', reference_period: '2026' }, // sem amount
    }));

    expect(res.settled).toBe(true);
    expect(state.installments.every((i) => i.status === 'paid')).toBe(true);
    expect(state.header.status).toBe('paid');
    expect(state.payments).toHaveLength(2);
    expect(guardrailHolds(state)).toBe(true);
  });

  test('amount que EXCEDE o saldo → capado (não lança), header paid', async () => {
    const state = { header: header(), installments: [inst({ amount: 500 })], payments: [] };
    const client = createFakeClient(state);

    const res = await applyEvent(client, ev({
      payload: { event_uid: 'U3', reference_period: '2026', amount: 999 },
    }));

    expect(res.ok).toBe(true);
    expect(res.settled).toBe(true);
    // capa ao saldo: aplica 500, não 999
    expect(round2(state.installments[0].amount_paid)).toBe(500);
    expect(round2(state.payments[0].amount)).toBe(500);
    expect(state.header.status).toBe('paid');
    expect(guardrailHolds(state)).toBe(true);
  });
});

describe('F2-sync — Tarefa 3: pagamento PARCIAL nunca marca paid', () => {
  test('amount < saldo → parcela partial, header DERIVA pending (não paid)', async () => {
    const state = { header: header(), installments: [inst({ amount: 500 })], payments: [] };
    const client = createFakeClient(state);

    const res = await applyEvent(client, ev({
      payload: { event_uid: 'P1', reference_period: '2026', amount: 300 },
    }));

    expect(res.ok).toBe(true);
    expect(res.settled).toBe(true); // aplicou valor
    expect(state.installments[0].status).toBe('partial');
    expect(round2(state.installments[0].amount_paid)).toBe(300);
    // header NÃO vira paid — invariante do guardrail preservada
    expect(state.header.status).toBe('pending');
    expect(guardrailHolds(state)).toBe(true);
  });

  test('multi-parcela: paga só a 1ª (FIFO) → header pending, 2ª segue aberta', async () => {
    const state = {
      header: header(),
      installments: [
        inst({ id: 'i1', seq: 1, amount: 150, due_date: '2026-02-28' }),
        inst({ id: 'i2', seq: 2, amount: 150, due_date: '2026-05-31' }),
        inst({ id: 'i3', seq: 3, amount: 150, due_date: '2026-08-31' }),
        inst({ id: 'i4', seq: 4, amount: 150, due_date: '2026-11-30' }),
      ],
      payments: [],
    };
    const client = createFakeClient(state);

    await applyEvent(client, ev({
      payload: { event_uid: 'P2', reference_period: '2026', amount: 150 },
    }));

    const byId = Object.fromEntries(state.installments.map((i) => [i.id, i]));
    expect(byId.i1.status).toBe('paid'); // mais antiga primeiro (FIFO)
    expect(byId.i2.status).toBe('pending');
    expect(state.header.status).toBe('pending');
    expect(guardrailHolds(state)).toBe(true);
  });
});

describe('F2-sync — Tarefa 2: park-and-replay', () => {
  test('cobrança ainda não existe → HOLD (não drena, não aplica nada)', async () => {
    const state = { header: null, installments: [], payments: [] };
    const client = createFakeClient(state);

    const res = await applyEvent(client, ev({
      payload: { event_uid: 'K1', reference_period: '2026', amount: 500 },
    }));

    expect(res.ok).toBe(false);
    expect(res.hold).toBe(true);
    expect(res.applied).toBe(false);
    expect(state.payments).toHaveLength(0);
  });

  test('replay: cobrança nasce depois → aplica de verdade', async () => {
    const state = { header: null, installments: [], payments: [], claims: [] };
    const client = createFakeClient(state);

    // 1ª passada: sem cobrança → HOLD. Na produção o runner faz ROLLBACK,
    // desfazendo o claim; simulamos isso limpando state.claims.
    const first = await applyEvent(client, ev({
      payload: { event_uid: 'K2', reference_period: '2026', amount: 500 },
    }));
    expect(first.hold).toBe(true);
    state.claims = []; // ROLLBACK do runner desfez o claim

    // Cobrança nasce (federação lança /charge)
    state.header = header();
    state.installments = [inst()];

    // 2ª passada (mesmo evento): agora aplica.
    const second = await applyEvent(client, ev({
      payload: { event_uid: 'K2', reference_period: '2026', amount: 500 },
    }));
    expect(second.ok).toBe(true);
    expect(second.settled).toBe(true);
    expect(state.installments[0].status).toBe('paid');
    expect(state.header.status).toBe('paid');
    expect(guardrailHolds(state)).toBe(true);
  });
});

describe('F2-sync — idempotência (claim de karate_sync_applied)', () => {
  test('mesmo evento aplicado 2x → 2ª é no-op (sem dupla baixa)', async () => {
    const state = { header: header(), installments: [inst()], payments: [], claims: [] };
    const client = createFakeClient(state);

    const first = await applyEvent(client, ev({
      payload: { event_uid: 'D1', reference_period: '2026', amount: 500 },
    }));
    expect(first.settled).toBe(true);
    expect(state.payments).toHaveLength(1);

    const second = await applyEvent(client, ev({
      payload: { event_uid: 'D1', reference_period: '2026', amount: 500 },
    }));
    expect(second.duplicate).toBe(true);
    expect(second.applied).toBe(false);
    // NÃO gravou uma 2ª baixa
    expect(state.payments).toHaveLength(1);
    expect(round2(state.installments[0].amount_paid)).toBe(500);
    expect(guardrailHolds(state)).toBe(true);
  });

  test('anuidade já quitada → settled=false (no-op idempotente), header segue paid', async () => {
    const state = {
      header: header({ status: 'paid', paid_at: '2026-05-01' }),
      installments: [inst({ status: 'paid', amount_paid: 500, paid_at: '2026-05-01' })],
      payments: [],
    };
    const client = createFakeClient(state);

    const res = await applyEvent(client, ev({
      payload: { event_uid: 'Q1', reference_period: '2026', amount: 500 },
    }));

    expect(res.ok).toBe(true);
    expect(res.settled).toBe(false); // nada a aplicar
    expect(state.payments).toHaveLength(0);
    expect(state.header.status).toBe('paid');
    expect(guardrailHolds(state)).toBe(true);
  });
});
