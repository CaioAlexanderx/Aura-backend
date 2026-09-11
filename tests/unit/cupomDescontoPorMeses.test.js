// ============================================================
// Cupom com desconto por varios meses (migration 326) — regras puras:
// valor abatido, plano/ciclo, datas, validacao do cupom, criacao no painel
// e o ajuste que protege o desconto quando alguem recalcula a assinatura.
// ============================================================
const db = require('../../src/config/database');
const {
  getCouponDiscountAmount,
  getFirstChargeValue,
  getTotalValue,
} = require('../../src/services/billingPricing');
const { validateCoupon, checkCouponFits } = require('../../src/services/checkoutCoupon');
const {
  addMonthsIso,
  slotBoundary,
  todayBrt,
  getSyncAdjustment,
  discountTableReady,
  _resetTableReadyCache,
} = require('../../src/services/subscriptionDiscount');
const { validateCreate } = require('../../src/routes/adminAccessCodes');

beforeEach(() => {
  db.query.mockReset();
  _resetTableReadyCache();
});

describe('getCouponDiscountAmount', () => {
  test('R$ 50 no Negocio mensal abate 50 (169 -> 119)', () => {
    const off = getCouponDiscountAmount('negocio', 'monthly', 'PIX', { discountValue: 50 });
    expect(off).toBe(50);
    expect(getTotalValue('negocio', 'monthly', 'PIX', 0) - off).toBe(119);
  });

  test('acesso extra nao recebe desconto: 169 + 19 - 50 = 138', () => {
    const off = getCouponDiscountAmount('negocio', 'monthly', 'PIX', { discountValue: 50 });
    expect(getTotalValue('negocio', 'monthly', 'PIX', 1) - off).toBe(138);
  });

  test('desconto em reais nunca passa do valor do plano', () => {
    expect(getCouponDiscountAmount('essencial', 'monthly', 'PIX', { discountValue: 500 })).toBe(89);
  });

  test('percentual bate centavo a centavo com a 1a cobranca de sempre', () => {
    for (const plan of ['essencial', 'negocio', 'expansao']) {
      for (const cycle of ['monthly', 'annual']) {
        for (const seats of [0, 1, 3]) {
          for (const pct of [5, 20, 33, 50, 99]) {
            const off = getCouponDiscountAmount(plan, cycle, 'PIX', { discountPct: pct });
            const total = getTotalValue(plan, cycle, 'PIX', seats);
            const expected = getFirstChargeValue(plan, cycle, 'PIX', seats, pct);
            expect(Math.round((total - off) * 100) / 100).toBe(expected);
          }
        }
      }
    }
  });

  test('sem desconto abate 0; plano invalido devolve null', () => {
    expect(getCouponDiscountAmount('negocio', 'monthly', 'PIX', {})).toBe(0);
    expect(getCouponDiscountAmount('nao-existe', 'monthly', 'PIX', { discountValue: 50 })).toBeNull();
  });
});

describe('checkCouponFits', () => {
  const recorrente = { plan: 'negocio', restrict_to_plan: true, discount_months: 3 };

  test('cupom preso ao Negocio recusa outro plano', () => {
    expect(checkCouponFits(recorrente, { plan: 'essencial', cycle: 'monthly' })).toMatch(/só para o plano Negócio/);
    expect(checkCouponFits(recorrente, { plan: 'negocio', cycle: 'monthly' })).toBeNull();
  });

  test('desconto de varios meses recusa o anual', () => {
    expect(checkCouponFits(recorrente, { plan: 'negocio', cycle: 'annual' })).toMatch(/só no plano mensal/);
  });

  test('cupom antigo (sem trava, 1 mes) segue valendo em qualquer plano e ciclo', () => {
    const ref = { plan: 'essencial', restrict_to_plan: false, discount_months: 1 };
    expect(checkCouponFits(ref, { plan: 'expansao', cycle: 'annual' })).toBeNull();
  });
});

describe('datas', () => {
  test('mesmo dia N meses depois; fim de mes cai no ultimo dia', () => {
    expect(addMonthsIso('2026-09-16', 3)).toBe('2026-12-16');
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsIso('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonthsIso('2026-12-15', 2)).toBe('2027-02-15');
  });

  test('fronteira fica 10 dias antes da 1a cheia', () => {
    expect(slotBoundary('2026-12-16')).toBe('2026-12-06');
  });

  test('hoje em Brasilia vira o dia 3h depois de UTC', () => {
    expect(todayBrt(Date.parse('2026-09-12T02:00:00Z'))).toBe('2026-09-11');
    expect(todayBrt(Date.parse('2026-09-12T03:00:00Z'))).toBe('2026-09-12');
  });
});

describe('validateCoupon — campos novos', () => {
  const base = {
    id: 'ac1', code: 'NEGOCIO50', type: 'promo', plan: 'negocio',
    discount_pct: 0, trial_days: 0, max_uses: 10, uses: 0,
    expires_at: null, is_active: true, referrer_id: null,
  };

  function arrange(row) {
    db.query
      .mockResolvedValueOnce({ rows: [row] })   // access_codes
      .mockResolvedValueOnce({ rows: [] });     // coupon_redemptions
  }

  test('R$ 50 por 3 meses preso ao Negocio', async () => {
    arrange({ ...base, discount_value: '50.00', discount_months: 3, restrict_to_plan: true });
    const c = await validateCoupon('negocio50', 'co1');
    expect(c).toMatchObject({
      valid: true, code: 'NEGOCIO50', discount_value: 50, discount_months: 3,
      plan: 'negocio', restrict_to_plan: true, trial_days: 0,
    });
  });

  test('cupom anterior a migration (sem as colunas) vira 1 mes, sem trava', async () => {
    arrange({ ...base, discount_pct: 20 });
    const c = await validateCoupon('REF', 'co1');
    expect(c).toMatchObject({ valid: true, discount_pct: 20, discount_value: 0, discount_months: 1, restrict_to_plan: false });
  });

  test.each([
    ['percentual e reais juntos', { discount_pct: 10, discount_value: 50 }],
    ['varios meses com dias gratis', { discount_value: 50, discount_months: 3, trial_days: 7 }],
  ])('recusa %s', async (_, extra) => {
    arrange({ ...base, ...extra });
    const c = await validateCoupon('X', 'co1');
    expect(c.valid).toBe(false);
    expect(c.error).toMatch(/invalida/);
  });
});

describe('validateCreate (painel)', () => {
  const ok = { code: 'negocio50', type: 'promo', plan: 'negocio' };

  test('aceita R$ 50 por 3 meses preso ao plano', () => {
    const p = validateCreate({ ...ok, discount_value: 50, discount_months: 3, restrict_to_plan: true, max_uses: 20 });
    expect(p).toMatchObject({ code: 'NEGOCIO50', discount_value: 50, discount_months: 3, restrict_to_plan: true, discount_pct: 0 });
  });

  test('sem os campos novos fica como antes', () => {
    expect(validateCreate({ ...ok, discount_pct: 20 })).toMatchObject({ discount_value: 0, discount_months: 1, restrict_to_plan: false });
  });

  test.each([
    ['percentual e reais juntos', { discount_pct: 10, discount_value: 50 }, /OU em reais/],
    ['varios meses sem desconto', { discount_months: 3 }, /precisa de discount_pct ou discount_value/],
    ['varios meses com dias gratis', { discount_value: 50, discount_months: 3, trial_days: 7 }, /nao combina com dias gratis/],
    ['mais de 24 meses', { discount_value: 50, discount_months: 25 }, /entre 1 e 24/],
    ['reais negativo', { discount_value: -1 }, /discount_value/],
    ['trava de plano que nao e booleano', { discount_value: 50, restrict_to_plan: 'sim' }, /restrict_to_plan/],
  ])('recusa %s', (_, extra, msg) => {
    expect(() => validateCreate({ ...ok, ...extra })).toThrow(msg);
  });
});

describe('getSyncAdjustment (acesso extra / multi-CNPJ)', () => {
  test('desconto ativo: abate e nao mexe nas cobrancas ja geradas', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'd1', status: 'active', discount_amount: 50 }] });
    await expect(getSyncAdjustment(db, 'co1', 'sub_1')).resolves.toEqual({ discountAmount: 50, updatePendingPayments: false });
    expect(db.query.mock.calls[0][1]).toEqual(['co1', 'sub_1']);
  });

  test('valor ja devolvido mas mensalidade com desconto por vencer: nao abate, nao mexe nas pendentes', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'd1', status: 'restored', discount_amount: 50 }] });
    await expect(getSyncAdjustment(db, 'co1', 'sub_1')).resolves.toEqual({ discountAmount: 0, updatePendingPayments: false });
  });

  test('sem desconto (ou tabela ainda inexistente): comportamento de sempre', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(getSyncAdjustment(db, 'co1', 'sub_1')).resolves.toEqual({ discountAmount: 0, updatePendingPayments: true });
    db.query.mockRejectedValueOnce(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    await expect(getSyncAdjustment(db, 'co1', 'sub_1')).resolves.toEqual({ discountAmount: 0, updatePendingPayments: true });
  });
});

describe('discountTableReady', () => {
  test('42P01 = nao pronta (e pergunta de novo); depois de pronta nao consulta mais', async () => {
    db.query.mockRejectedValueOnce(Object.assign(new Error('nope'), { code: '42P01' }));
    await expect(discountTableReady(db)).resolves.toBe(false);
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(discountTableReady(db)).resolves.toBe(true);
    await expect(discountTableReady(db)).resolves.toBe(true);
    expect(db.query).toHaveBeenCalledTimes(2);
  });
});
