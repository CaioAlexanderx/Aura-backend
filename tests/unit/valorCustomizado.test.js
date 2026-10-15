// ============================================================
// Valor customizado por empresa (migration 386) — regras puras e o sync.
//
//   - billingPricing.valorDaAssinatura / getCustomSubscription / customMatches
//   - getCouponDiscountAmount com baseValue (e sem: byte a byte como antes)
//   - seatSubscription.syncSubscriptionSeatValue NAO faz PUT quando o valor
//     combinado casa o plano/ciclo da assinatura (e le o banco quando o
//     chamador passa o objeto parcial da empresa)
//   - seatPass.classificarSync: valor_customizado nao e' 'ok' (nada cobrado)
// ============================================================
jest.mock('../../src/services/asaasClient', () => ({
  ...jest.requireActual('../../src/services/asaasClient'),
  asaas: jest.fn(),
}));

const db = require('../../src/config/database');
const { asaas } = require('../../src/services/asaasClient');
const {
  valorDaAssinatura,
  getCustomSubscription,
  customMatches,
  getCouponDiscountAmount,
  getTotalValue,
  MIN_CHARGE_BRL,
} = require('../../src/services/billingPricing');
const { syncSubscriptionSeatValue } = require('../../src/services/seatSubscription');
const seatPass = require('../../src/services/seatPass');

const combinado = (extra = {}) => ({
  custom_subscription_value: '211.20',
  custom_subscription_plan: 'negocio',
  custom_subscription_cycle: 'annual',
  custom_subscription_note: 'Fechado por telefone',
  ...extra,
});

describe('getCustomSubscription', () => {
  test('NUMERIC do driver (string) vira numero com 2 casas', () => {
    expect(getCustomSubscription(combinado())).toEqual({
      value: 211.2, plan: 'negocio', cycle: 'annual', note: 'Fechado por telefone',
    });
  });

  test.each([[null], [undefined], [''], ['0'], ['-5'], ['abc']])('valor %p = sem valor combinado', (v) => {
    expect(getCustomSubscription({ custom_subscription_value: v })).toBeNull();
  });

  test('empresa ausente ou sem as colunas = sem valor combinado', () => {
    expect(getCustomSubscription(null)).toBeNull();
    expect(getCustomSubscription({ plan: 'negocio' })).toBeNull();
  });
});

describe('valorDaAssinatura', () => {
  test('plano e ciclo batem: o combinado (ja inclui acessos extras), com a tabela ao lado', () => {
    const v = valorDaAssinatura(combinado(), 'negocio', 'annual', 'PIX', 2);
    expect(v).toEqual({ value: 211.2, custom: true, table_value: 178.83, note: 'Fechado por telefone' });
    expect(v.table_value).toBe(getTotalValue('negocio', 'annual', 'PIX', 2));
  });

  test('independe da forma de pagamento', () => {
    expect(valorDaAssinatura(combinado(), 'negocio', 'annual', 'CREDIT_CARD', 0).value).toBe(211.2);
    expect(valorDaAssinatura(combinado(), 'negocio', 'annual', 'PIX', 0).value).toBe(211.2);
  });

  test('outro ciclo ou outro plano: tabela normal, custom=false, sem nota', () => {
    for (const [plan, cycle] of [['negocio', 'monthly'], ['expansao', 'annual'], ['essencial', 'monthly']]) {
      const v = valorDaAssinatura(combinado(), plan, cycle, 'PIX', 1);
      expect(v.custom).toBe(false);
      expect(v.value).toBe(getTotalValue(plan, cycle, 'PIX', 1));
      expect(v.note).toBeNull();
    }
  });

  test('sem valor combinado: identico a getTotalValue em todas as combinacoes', () => {
    const semValor = { custom_subscription_value: null, plan: 'negocio' };
    for (const plan of ['essencial', 'negocio', 'expansao']) {
      for (const cycle of ['monthly', 'annual']) {
        for (const seats of [0, 1, 3]) {
          expect(valorDaAssinatura(semValor, plan, cycle, 'PIX', seats).value).toBe(getTotalValue(plan, cycle, 'PIX', seats));
          expect(valorDaAssinatura(null, plan, cycle, 'CREDIT_CARD', seats).value).toBe(getTotalValue(plan, cycle, 'CREDIT_CARD', seats));
        }
      }
    }
  });

  test('plano invalido devolve null (como getTotalValue)', () => {
    expect(valorDaAssinatura(combinado(), 'ouro', 'annual', 'PIX', 0)).toBeNull();
  });

  test('combinado sem plano ou ciclo gravado nunca casa', () => {
    expect(customMatches(getCustomSubscription({ custom_subscription_value: '99' }), 'negocio', 'annual')).toBe(false);
    expect(customMatches(null, 'negocio', 'annual')).toBe(false);
  });

  test('ciclo ausente conta como mensal', () => {
    const c = getCustomSubscription(combinado({ custom_subscription_cycle: 'monthly' }));
    expect(customMatches(c, 'negocio', undefined)).toBe(true);
  });
});

describe('getCouponDiscountAmount com baseValue', () => {
  test('sem baseValue: igual a antes', () => {
    expect(getCouponDiscountAmount('negocio', 'annual', 'PIX', { discountPct: 10 })).toBe(14.08);
    expect(getCouponDiscountAmount('negocio', 'monthly', 'PIX', { discountValue: 50 })).toBe(50);
  });

  test('com baseValue o percentual incide sobre o valor combinado', () => {
    expect(getCouponDiscountAmount('negocio', 'annual', 'PIX', { discountPct: 10, baseValue: 211.2 })).toBe(21.12);
  });

  test('desconto em reais nunca passa do valor combinado', () => {
    expect(getCouponDiscountAmount('negocio', 'annual', 'PIX', { discountValue: 500, baseValue: 211.2 })).toBe(211.2);
    expect(getCouponDiscountAmount('negocio', 'annual', 'PIX', { discountValue: 50, baseValue: 211.2 })).toBe(50);
  });

  test('baseValue invalido (0, null, NaN) cai no valor de tabela', () => {
    for (const baseValue of [0, null, NaN, -3]) {
      expect(getCouponDiscountAmount('negocio', 'annual', 'PIX', { discountPct: 10, baseValue })).toBe(14.08);
    }
  });
});

describe('syncSubscriptionSeatValue com valor combinado', () => {
  beforeEach(() => {
    asaas.mockReset();
    db.query.mockReset();
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const empresa = (extra = {}) => ({
    id: 'c1', plan: 'negocio', billing_cycle: 'annual', billing_status: 'active',
    asaas_subscription_id: 'sub_1', extra_seats_granted: 1, ...extra,
  });

  test('objeto completo (colunas presentes): pula, sem PUT, sem GET na Asaas, sem ler o banco', async () => {
    const r = await syncSubscriptionSeatValue(empresa(combinado()));

    expect(r).toMatchObject({ updated: false, skipped: 'valor_customizado', value: 211.2, subscriptionId: 'sub_1' });
    expect(asaas).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('objeto parcial (como o PATCH /extra-seats e o /resync passam): le as colunas e pula', async () => {
    db.query.mockResolvedValueOnce({ rows: [{
      custom_subscription_value: '211.20', custom_subscription_plan: 'negocio', custom_subscription_cycle: 'annual',
    }] });

    const r = await syncSubscriptionSeatValue(empresa());

    expect(r.skipped).toBe('valor_customizado');
    expect(asaas).not.toHaveBeenCalled();
    expect(db.query.mock.calls[0][0]).toContain('custom_subscription_value');
    expect(db.query.mock.calls[0][1]).toEqual(['c1']);
  });

  test('assinatura em outro plano/ciclo que o combinado: sync normal (PUT na tabela)', async () => {
    db.query.mockResolvedValue({ rows: [] }); // subscription_discounts: nenhum
    asaas.mockImplementation(async (method) => {
      if (method === 'GET') return { status: 'ACTIVE', billingType: 'PIX', value: 140.83, description: 'Aura Negocio (Anual)' };
      return { ok: true };
    });

    const r = await syncSubscriptionSeatValue(empresa(combinado({ custom_subscription_cycle: 'monthly' })));

    expect(r.updated).toBe(true);
    expect(r.value).toBe(getTotalValue('negocio', 'annual', 'PIX', 1));
    const put = asaas.mock.calls.find((c) => c[0] === 'PUT');
    expect(put[2].value).toBe(159.83);
  });

  test('coluna ausente (42703, antes da migration): segue o sync normal', async () => {
    const err = new Error('column "custom_subscription_value" does not exist');
    err.code = '42703';
    db.query.mockRejectedValueOnce(err).mockResolvedValue({ rows: [] });
    asaas.mockImplementation(async (method) => {
      if (method === 'GET') return { status: 'ACTIVE', billingType: 'PIX', value: 140.83 };
      return { ok: true };
    });

    const r = await syncSubscriptionSeatValue(empresa());

    expect(r.updated).toBe(true);
    expect(asaas.mock.calls.some((c) => c[0] === 'PUT')).toBe(true);
  });

  test('sem assinatura / cancelada seguem com o motivo de sempre (antes do valor combinado)', async () => {
    expect((await syncSubscriptionSeatValue(empresa({ asaas_subscription_id: null, ...combinado() }))).skipped).toBe('no_subscription');
    expect((await syncSubscriptionSeatValue(empresa({ billing_status: 'cancelled', ...combinado() }))).skipped).toBe('cancelled');
  });
});

describe('seatPass com valor combinado (banco de mentira)', () => {
  // Responde por pedaco do SQL. `combinadoNoBanco`: o que companies devolve
  // para a consulta das colunas custom_subscription_*.
  function fakeDb({ combinadoNoBanco = null, aplicar = null } = {}) {
    const log = [];
    return {
      log,
      query: jest.fn(async (sql, params) => {
        const s = String(sql).replace(/\s+/g, ' ');
        log.push({ sql: s, params });
        if (s.includes('FROM companies c JOIN companies o')) {
          return { rows: [{
            id: 'c1', plan: 'negocio', billing_cycle: 'annual', billing_status: 'active',
            asaas_subscription_id: 'sub_1', extra_seats_granted: 0,
          }] };
        }
        if (s.includes('custom_subscription_value') && s.includes('FROM companies WHERE id')) {
          return { rows: combinadoNoBanco ? [combinadoNoBanco] : [] };
        }
        if (s.includes('FROM seat_passes WHERE company_id')) return { rows: [] };
        if (s.includes('SUM(qty)')) return { rows: [{ total: 0 }] };
        if (s.includes('SET extra_seats_granted = COALESCE') && aplicar) return { rows: [aplicar] };
        if (s.includes('SET extra_seats_granted = GREATEST')) {
          return { rows: [{ pass_id: 'p1', id: 'c1', plan: 'negocio', billing_cycle: 'annual', billing_status: 'active', asaas_subscription_id: 'sub_1', extra_seats_granted: 0 }] };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
  }
  const COMB = { custom_subscription_value: '211.20', custom_subscription_plan: 'negocio', custom_subscription_cycle: 'annual' };

  test('valor_customizado nao conta como ajuste feito (nenhum assento e cobrado por cima)', () => {
    expect(seatPass.classificarSync({ updated: false, skipped: 'valor_customizado' })).toBe('indisponivel');
  });

  test('contratar (loja, antes de 01/11): 409 VALOR_CUSTOMIZADO e nenhum passe e criado', async () => {
    const fake = fakeDb({ combinadoNoBanco: COMB });
    const sync = jest.fn();

    await expect(seatPass.contratar(
      { companyId: 'c1', qty: 1, source: 'loja', userId: 'u1' },
      { db: fake, sync, hoje: '2026-10-14' }
    )).rejects.toMatchObject({ status: 409, code: 'VALOR_CUSTOMIZADO' });

    expect(fake.log.some((c) => c.sql.includes('INSERT INTO seat_passes'))).toBe(false);
    expect(sync).not.toHaveBeenCalled();
  });

  test('contratar (admin) com valor combinado tambem recusa', async () => {
    const fake = fakeDb({ combinadoNoBanco: COMB });
    await expect(seatPass.contratar(
      { companyId: 'c1', qty: 1, source: 'admin', userId: 'u1' },
      { db: fake, sync: jest.fn(), hoje: '2026-11-10' }
    )).rejects.toMatchObject({ code: 'VALOR_CUSTOMIZADO' });
  });

  test('combinado de OUTRO plano/ciclo nao bloqueia: segue ate a insercao do passe', async () => {
    const fake = fakeDb({ combinadoNoBanco: { ...COMB, custom_subscription_cycle: 'monthly' } });
    await seatPass.contratar(
      { companyId: 'c1', qty: 1, source: 'loja', userId: 'u1' },
      { db: fake, sync: jest.fn(), hoje: '2026-10-14' }
    ).catch(() => {});
    expect(fake.log.some((c) => c.sql.includes('INSERT INTO seat_passes'))).toBe(true);
  });

  test('estado: pode_contratar false com motivo valor_customizado', async () => {
    const fake = fakeDb({ combinadoNoBanco: COMB });
    const e = await seatPass.estado('c1', {}, { db: fake, hoje: '2026-11-10' });
    expect(e.pode_contratar).toBe(false);
    expect(e.motivo_bloqueio).toBe('valor_customizado');
  });

  test('estado sem valor combinado: pode_contratar como sempre', async () => {
    const fake = fakeDb();
    const e = await seatPass.estado('c1', {}, { db: fake, hoje: '2026-11-10' });
    expect(e.pode_contratar).toBe(true);
    expect(e.motivo_bloqueio).toBeNull();
  });

  test('aplicarPasse (job em 01/11): se o sync pula por valor combinado, o passe e cancelado sem cobrar', async () => {
    const fake = fakeDb({
      aplicar: { pass_id: 'p1', qty: 1, cortesia: false, id: 'c1', plan: 'negocio', billing_cycle: 'annual', billing_status: 'active', asaas_subscription_id: 'sub_1', extra_seats_granted: 1 },
    });
    const sync = jest.fn(async () => ({ updated: false, skipped: 'valor_customizado', value: 211.2 }));

    const r = await seatPass.aplicarPasse('p1', { cancelarSeFalhar: false }, { db: fake, sync });

    expect(r).toMatchObject({ aplicado: false, motivo: 'valor_customizado', cancelado: true });
    const desfazer = fake.log.find((c) => c.sql.includes('SET extra_seats_granted = GREATEST'));
    expect(desfazer.params).toEqual(['p1', true, 'valor_customizado']);
  });

  test('o minimo do provedor continua exportado para o admin validar', () => {
    expect(MIN_CHARGE_BRL).toBe(5);
  });
});
