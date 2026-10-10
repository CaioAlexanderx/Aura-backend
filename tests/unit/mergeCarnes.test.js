// ============================================================
// AURA. — Testes unitários: src/services/credit/mergeCarnes.js (10/10/2026)
//
// Motor puro de "juntar carnês": soma das origens, distribuição de centavos,
// total editado (desconto/acréscimo), origem sem carnê, nome do destino e as
// recusas de validação.
// ============================================================

const {
  computeMergePlan, mergedCarneName, normalizeAccountIds, resolveOrigins, validateTerms,
} = require('../../src/services/credit/mergeCarnes');
const { NO_ACCOUNT_KEY } = require('../../src/services/credit/carnePurchases');
const { MAX_INSTALLMENTS_CEILING } = require('../../src/services/credit/terms');

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const ALHEIO = 'cccccccc-3333-4333-8333-cccccccccccc';

const soma = (schedule) => Math.round(schedule.reduce((s, x) => s + x.amount_due, 0) * 100) / 100;

const origem = (key, name, open, extra = {}) => ({
  key, account_id: key === NO_ACCOUNT_KEY ? null : key, name,
  open_remaining: open, unscheduled: 0, date: '2026-09-13T15:00:00Z', ...extra,
});

describe('normalizeAccountIds', () => {
  test('aceita array ou texto separado por vírgula, sem repetidos', () => {
    expect(normalizeAccountIds([A, B, A])).toEqual([A, B]);
    expect(normalizeAccountIds(`${A}, ${B.toUpperCase()}`)).toEqual([A, B]);
  });

  test("grupo sem carnê: 'general', 'none' ou null no array", () => {
    expect(normalizeAccountIds([A, 'general'])).toEqual([A, 'general']);
    expect(normalizeAccountIds([A, 'none', null])).toEqual([A, 'general']);
    expect(normalizeAccountIds(`${A},GENERAL`)).toEqual([A, 'general']);
  });

  test('entrada torta vira lista vazia', () => {
    expect(normalizeAccountIds(undefined)).toEqual([]);
    expect(normalizeAccountIds({})).toEqual([]);
    expect(normalizeAccountIds('')).toEqual([]);
  });
});

describe('mergedCarneName', () => {
  const o = (key, date) => ({ key, date });
  test('dois dias: "Compras de 13/09 e 14/09", em ordem cronológica', () => {
    expect(mergedCarneName([o(B, '2026-09-14T15:00:00Z'), o(A, '2026-09-13T15:00:00Z')])).toBe('Compras de 13/09 e 14/09');
  });
  test('mesmo dia nas duas origens não repete', () => {
    expect(mergedCarneName([o(A, '2026-09-13T13:00:00Z'), o(B, '2026-09-13T18:00:00Z')])).toBe('Compras de 13/09');
  });
  test('três dias com vírgula; quatro ou mais vira intervalo', () => {
    const d = (n) => `2026-09-${n}T15:00:00Z`;
    expect(mergedCarneName([o('1', d(13)), o('2', d(14)), o('3', d(15))])).toBe('Compras de 13/09, 14/09 e 15/09');
    expect(mergedCarneName([o('1', d(13)), o('2', d(14)), o('3', d(15)), o('4', d(20))])).toBe('Compras de 13/09 a 20/09');
  });
  test('com o grupo sem carnê: "e anteriores"', () => {
    expect(mergedCarneName([o(A, '2026-09-13T15:00:00Z'), o(NO_ACCOUNT_KEY, null)])).toBe('Compras de 13/09 e anteriores');
  });
});

describe('computeMergePlan', () => {
  test('total padrão = soma do que falta nas origens; delta zero', () => {
    const p = computeMergePlan({
      origins: [origem(A, 'Compra de 13/09', 200), origem(B, 'Compra de 14/09', 250, { date: '2026-09-14T15:00:00Z' })],
      installments: 3, firstDueDate: '2026-11-10',
    });
    expect(p.open_remaining).toBe(450);
    expect(p.target_total).toBe(450);
    expect(p.delta).toBe(0);
    expect(p.installments_count).toBe(3);
    expect(p.schedule.map(s => s.amount_due)).toEqual([150, 150, 150]);
    expect(p.schedule.map(s => s.due_date)).toEqual(['2026-11-10', '2026-12-10', '2027-01-10']);
    expect(p.name).toBe('Compras de 13/09 e 14/09');
    expect(p.origins).toEqual([
      { account_id: A, name: 'Compra de 13/09', open_remaining: 200, unscheduled: 0, remaining: 200 },
      { account_id: B, name: 'Compra de 14/09', open_remaining: 250, unscheduled: 0, remaining: 250 },
    ]);
  });

  test('centavos: floor por parcela, resto na última — a soma fecha', () => {
    const p = computeMergePlan({
      origins: [origem(A, 'A', 33.33), origem(B, 'B', 66.67)],
      installments: 3, firstDueDate: '2026-11-10',
    });
    expect(p.target_total).toBe(100);
    expect(p.schedule.map(s => s.amount_due)).toEqual([33.33, 33.33, 33.34]);
    expect(soma(p.schedule)).toBe(100);
  });

  test('total editado para menos = desconto (delta negativo)', () => {
    const p = computeMergePlan({
      origins: [origem(A, 'A', 200), origem(B, 'B', 250)],
      total: 400, installments: 4, firstDueDate: '2026-11-10',
    });
    expect(p.open_remaining).toBe(450);
    expect(p.target_total).toBe(400);
    expect(p.delta).toBe(-50);
    expect(soma(p.schedule)).toBe(400);
  });

  test('total editado para mais = acréscimo (delta positivo)', () => {
    const p = computeMergePlan({
      origins: [origem(A, 'A', 200), origem(B, 'B', 250)],
      total: 500, installments: 2, firstDueDate: '2026-11-10',
    });
    expect(p.delta).toBe(50);
    expect(p.schedule.map(s => s.amount_due)).toEqual([250, 250]);
  });

  test('origem sem carnê entra com parcelas abertas + saldo sem parcela; account_id nulo', () => {
    const p = computeMergePlan({
      origins: [
        origem(A, 'Compra de 13/09', 200),
        { key: NO_ACCOUNT_KEY, account_id: null, name: 'Compras anteriores', open_remaining: 40, unscheduled: 60, date: null },
      ],
      installments: 2, firstDueDate: '2026-11-10',
    });
    expect(p.open_remaining).toBe(300);
    expect(p.origins[1]).toEqual({ account_id: null, name: 'Compras anteriores', open_remaining: 40, unscheduled: 60, remaining: 100 });
    expect(p.name).toBe('Compras de 13/09 e anteriores');
  });

  test('intervalo semanal e nome informado; nome que colide ganha sufixo', () => {
    const p = computeMergePlan({
      origins: [origem(A, 'A', 100), origem(B, 'B', 100)],
      installments: 2, firstDueDate: '2026-11-02', periodUnit: 'week', periodCount: 2,
      name: '  Parcelamento de outubro ', existingNames: ['Parcelamento de outubro'],
    });
    expect(p.schedule.map(s => s.due_date)).toEqual(['2026-11-02', '2026-11-16']);
    expect(p.name).toBe('Parcelamento de outubro (2)');
  });
});

describe('validateTerms', () => {
  const recusa = (args) => { try { validateTerms(args); return null; } catch (e) { return e; } };
  test('parcelas fora de 1..teto, total <= 0 e data torta são 400 com código', () => {
    expect(recusa({ installments: 0 })).toMatchObject({ status: 400, code: 'INVALID_INSTALLMENTS' });
    expect(recusa({ installments: MAX_INSTALLMENTS_CEILING + 1 })).toMatchObject({ status: 400, code: 'INVALID_INSTALLMENTS' });
    expect(recusa({ installments: NaN })).toMatchObject({ status: 400, code: 'INVALID_INSTALLMENTS' });
    expect(recusa({ installments: 2, total: 0 })).toMatchObject({ status: 400, code: 'INVALID_TOTAL' });
    expect(recusa({ installments: 2, firstDueDate: '10/11/2026' })).toMatchObject({ status: 400, code: 'INVALID_FIRST_DUE_DATE' });
    expect(validateTerms({ installments: '3', total: null, firstDueDate: '2026-11-10' })).toBe(3);
  });
});

describe('resolveOrigins — recusas com erro claro', () => {
  const ctx = (over = {}) => ({
    accounts: [
      { id: A, name: 'Compra de 13/09', status: 'open', created_at: '2026-09-13T15:00:00Z' },
      { id: B, name: 'Compra de 14/09', status: 'open', created_at: '2026-09-14T15:00:00Z' },
    ],
    installments: [
      { id: 'i1', account_id: A, amount_due: '200.00', covered_amount: '0', status: 'pending', due_date: '2026-10-13' },
      { id: 'i2', account_id: B, amount_due: '250.00', covered_amount: '0', status: 'pending', due_date: '2026-10-14' },
    ],
    debits: [
      { id: 'd1', account_id: A, amount: '200.00', created_at: '2026-09-13T15:00:00Z' },
      { id: 'd2', account_id: B, amount: '250.00', created_at: '2026-09-14T15:00:00Z' },
    ],
    refundsByGroup: {}, ledgerBalance: 450, ...over,
  });
  const recusa = (c, ids) => { try { resolveOrigins(c, ids); return null; } catch (e) { return e; } };

  test('menos de duas origens: 400 MERGE_NEEDS_TWO', () => {
    expect(recusa(ctx(), [A])).toMatchObject({ status: 400, code: 'MERGE_NEEDS_TWO' });
    expect(recusa(ctx(), [A, A])).toMatchObject({ status: 400, code: 'MERGE_NEEDS_TWO' });
    expect(recusa(ctx(), [])).toMatchObject({ status: 400, code: 'MERGE_NEEDS_TWO' });
  });

  test('carnê de outro cliente/empresa (fora do contexto) ou id torto: 404', () => {
    expect(recusa(ctx(), [A, ALHEIO])).toMatchObject({ status: 404, code: 'CREDIT_ACCOUNT_NOT_FOUND' });
    expect(recusa(ctx(), [A, 'nao-e-uuid'])).toMatchObject({ status: 404, code: 'CREDIT_ACCOUNT_NOT_FOUND' });
  });

  test('carnê já fechado, cancelado ou já juntado: 409 com o nome', () => {
    for (const fechado of [{ status: 'closed' }, { status: 'cancelled' }, { status: 'open', merged_into_account_id: ALHEIO }]) {
      const c = ctx();
      Object.assign(c.accounts[1], fechado);
      const e = recusa(c, [A, B]);
      expect(e).toMatchObject({ status: 409, code: 'CREDIT_ACCOUNT_CLOSED' });
      expect(e.message).toContain('Compra de 14/09');
    }
  });

  test('nada em aberto nas origens: 422 NOTHING_OPEN', () => {
    const c = ctx({ ledgerBalance: 0 });
    for (const i of c.installments) { i.status = 'paid'; i.covered_amount = i.amount_due; }
    expect(recusa(c, [A, B])).toMatchObject({ status: 422, code: 'NOTHING_OPEN' });
  });

  test('origens válidas: o que falta de cada uma, o dia da compra e os nomes livres', () => {
    const c = ctx();
    c.accounts.push({ id: ALHEIO, name: 'Compras de 13/09 e 14/09', status: 'open', created_at: '2026-09-30T15:00:00Z' });
    const r = resolveOrigins(c, [B, A]);
    expect(r.origins.map(o => [o.key, o.open_remaining, o.unscheduled])).toEqual([[B, 250, 0], [A, 200, 0]]);
    expect(new Date(r.origins[1].date).toISOString()).toBe('2026-09-13T15:00:00.000Z');
    // Nome de carnê que NÃO está sendo juntado conta para a colisão.
    expect(r.existingNames).toEqual(['Compras de 13/09 e 14/09']);
    expect(computeMergePlan({ origins: r.origins, installments: 2, existingNames: r.existingNames }).name)
      .toBe('Compras de 13/09 e 14/09 (2)');
  });

  test("'general' vira a origem sem carnê, com parcela aberta e saldo sem parcela", () => {
    const c = ctx({ ledgerBalance: 450 + 40 + 60 });
    c.installments.push({ id: 'i3', account_id: null, amount_due: '90.00', covered_amount: '50.00', status: 'pending', due_date: '2026-10-01' });
    c.debits.push({ id: 'd3', account_id: null, amount: '150.00', created_at: '2026-08-01T15:00:00Z' });
    const r = resolveOrigins(c, [A, 'general']);
    expect(r.origins[1]).toMatchObject({ key: NO_ACCOUNT_KEY, account_id: null, open_remaining: 40, unscheduled: 60 });
  });
});
