// ============================================================
// jobs/subscriptionDiscountJob — devolve o valor cheio e avisa o cliente.
//
// Cenario base (Pix, R$ 50 x 3 meses no Negocio, assinado em 15/09/2026):
//   mensalidades com desconto: 16/09, 16/10, 16/11 (R$ 119)
//   primeira cheia:            16/12 (R$ 169)   -> fronteira 06/12
// ============================================================
const {
  tickSubscriptionDiscounts,
  stripCouponFromDescription,
} = require('../../src/jobs/subscriptionDiscountJob');

// Meio-dia em Brasilia do dia pedido.
const at = (iso, hourBrt = 12) => Date.parse(iso + 'T00:00:00Z') + (hourBrt + 3) * 3600000;

const baseRow = (extra = {}) => ({
  id: 'd1',
  company_id: 'co1',
  code: 'NEGOCIO50',
  asaas_subscription_id: 'sub_1',
  company_subscription_id: 'sub_1',
  status: 'active',
  discount_amount: 50,
  months: 3,
  charged_upfront: 0,
  restore_target_value: null,
  first_full_due_date: '2026-12-16',
  plan: 'negocio',
  company_name: 'Loja da Ana',
  recipient_email: 'ana@loja.com',
  recipient_name: 'Ana Souza',
  ...extra,
});

const pay = (dueDate, value, status = 'PENDING', id = 'pay_' + dueDate) => ({ id, dueDate, value, status });

function makeDb(rows, { claimRestore = true, claimNotice = true } = {}) {
  const writes = [];
  return {
    writes,
    query: jest.fn(async (sql, params) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('FROM subscription_discounts d JOIN companies')) return { rows };
      writes.push({ sql: s, params });
      if (s.includes('SET restore_claimed_at = NOW(), restore_target_value')) {
        return { rows: claimRestore ? [{ id: params[0] }] : [] };
      }
      if (s.includes('SET notice_sent_at = NOW(), updated_at = NOW()')) {
        return { rows: claimNotice ? [{ id: params[0] }] : [] };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
}

function makeAsaas({ payments = [], sub = { value: 119, status: 'ACTIVE', description: 'Aura Negocio — cupom NEGOCIO50: R$ 50,00 de desconto nas 3 primeiras mensalidades' }, failPut = false } = {}) {
  return jest.fn(async (method, path, body) => {
    if (method === 'GET' && path.startsWith('/subscriptions/sub_1/payments')) return { data: payments };
    if (method === 'GET' && path === '/subscriptions/sub_1') return sub;
    if (method === 'PUT' && failPut) throw new Error('Asaas fora');
    if (method === 'PUT') return { ok: true, body };
    throw new Error('chamada inesperada ' + method + ' ' + path);
  });
}

const mailer = () => ({ sendDiscountEndingEmail: jest.fn(async () => ({ id: 'm1' })) });
const puts = (asaas) => asaas.mock.calls.filter((c) => c[0] === 'PUT');
const wrote = (db, fragment) => db.writes.some((w) => w.sql.includes(fragment));

describe('devolver o valor cheio', () => {
  test('cedo demais: nem consulta o Asaas', async () => {
    const db = makeDb([baseRow()]);
    const asaas = makeAsaas();
    const s = await tickSubscriptionDiscounts({ db, asaas, mailer: mailer(), now: at('2026-10-01') });
    expect(asaas).not.toHaveBeenCalled();
    expect(s).toMatchObject({ scanned: 1, restored: 0 });
  });

  test('ultima com desconto ainda nao nasceu: espera', async () => {
    const db = makeDb([baseRow()]);
    const asaas = makeAsaas({ payments: [pay('2026-09-16', 119, 'RECEIVED'), pay('2026-10-16', 119)] });
    const s = await tickSubscriptionDiscounts({ db, asaas, mailer: mailer(), now: at('2026-10-20') });
    expect(puts(asaas)).toHaveLength(0);
    expect(s.restored).toBe(0);
    expect(wrote(db, "status = 'restored'")).toBe(false);
  });

  test('a 3a com desconto nasceu: assinatura volta a 169 sem mexer nas pendentes e sem o cupom na descricao', async () => {
    const db = makeDb([baseRow()]);
    const asaas = makeAsaas({
      payments: [pay('2026-09-16', 119, 'RECEIVED'), pay('2026-10-16', 119, 'RECEIVED'), pay('2026-11-16', 119)],
    });
    const s = await tickSubscriptionDiscounts({ db, asaas, mailer: mailer(), now: at('2026-10-20') });

    expect(puts(asaas)).toEqual([
      ['PUT', '/subscriptions/sub_1', { value: 169, updatePendingPayments: false, description: 'Aura Negocio' }],
    ]);
    expect(s).toMatchObject({ restored: 1, fixedPayments: 0, noticed: 0 });
    const claim = db.writes.find((w) => w.sql.includes('restore_target_value = $2'));
    expect(claim.params).toEqual(['d1', 169]);
    expect(wrote(db, "status = 'restored'")).toBe(true);
  });

  test('cartao: a 1a foi avulsa, entao bastam 2 cobrancas na assinatura', async () => {
    // Assinado 15/09 no cartao: 15/09 (avulsa), 15/10, 15/11 com desconto; 15/12 cheia.
    const db = makeDb([baseRow({ charged_upfront: 1, first_full_due_date: '2026-12-15' })]);
    const asaas = makeAsaas({ payments: [pay('2026-10-15', 119, 'CONFIRMED'), pay('2026-11-15', 119)] });
    const s = await tickSubscriptionDiscounts({ db, asaas, mailer: mailer(), now: at('2026-10-20') });
    expect(s.restored).toBe(1);
    expect(puts(asaas)[0][2].value).toBe(169);
  });

  test('acesso extra concedido no meio: soma o desconto ao valor atual (138 -> 188)', async () => {
    const db = makeDb([baseRow()]);
    const asaas = makeAsaas({
      payments: [pay('2026-09-16', 119, 'RECEIVED'), pay('2026-10-16', 138, 'RECEIVED'), pay('2026-11-16', 138)],
      sub: { value: 138, status: 'ACTIVE', description: 'Aura Negocio + 1 acesso(s) extra — cupom NEGOCIO50: x' },
    });
    await tickSubscriptionDiscounts({ db, asaas, mailer: mailer(), now: at('2026-10-20') });
    expect(puts(asaas)[0][2]).toEqual({ value: 188, updatePendingPayments: false, description: 'Aura Negocio + 1 acesso(s) extra' });
  });

  test('rotina parada: a 1a cheia nasceu com desconto e falta tempo -> corrige a cobranca', async () => {
    const db = makeDb([baseRow()]);
    const asaas = makeAsaas({
      payments: [pay('2026-10-16', 119, 'RECEIVED'), pay('2026-11-16', 119), pay('2026-12-16', 119, 'PENDING', 'pay_cheia')],
    });
    const s = await tickSubscriptionDiscounts({ db, asaas, mailer: mailer(), now: at('2026-11-20') });
    expect(puts(asaas)).toEqual([
      ['PUT', '/subscriptions/sub_1', expect.objectContaining({ value: 169, updatePendingPayments: false })],
      ['PUT', '/payments/pay_cheia', { value: 169 }],
    ]);
    expect(s).toMatchObject({ restored: 1, fixedPayments: 1 });
  });

  test('rotina parada: a 1a cheia nasceu com desconto e vence em menos de 10 dias -> fica com desconto', async () => {
    const db = makeDb([baseRow()]);
    const asaas = makeAsaas({
      payments: [pay('2026-11-16', 119, 'RECEIVED'), pay('2026-12-16', 119, 'PENDING', 'pay_cheia')],
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await tickSubscriptionDiscounts({ db, asaas, mailer: mailer(), now: at('2026-12-10') });
    warn.mockRestore();
    expect(puts(asaas).map((c) => c[1])).toEqual(['/subscriptions/sub_1']);
    expect(s).toMatchObject({ restored: 1, fixedPayments: 0 });
  });

  test('rede de seguranca: 5 dias antes da fronteira devolve mesmo sem ver a 3a', async () => {
    const db = makeDb([baseRow()]);
    const asaas = makeAsaas({ payments: [pay('2026-10-16', 119, 'RECEIVED')] });
    const s = await tickSubscriptionDiscounts({ db, asaas, mailer: mailer(), now: at('2026-12-01') });
    expect(s.restored).toBe(1);
  });

  test('PUT ja aplicado numa rodada que caiu antes de gravar: nao soma o desconto de novo', async () => {
    const db = makeDb([baseRow({ restore_target_value: 169 })]);
    const asaas = makeAsaas({
      payments: [pay('2026-09-16', 119), pay('2026-10-16', 119), pay('2026-11-16', 119)],
      sub: { value: 169, status: 'ACTIVE', description: 'Aura Negocio' },
    });
    const s = await tickSubscriptionDiscounts({ db, asaas, mailer: mailer(), now: at('2026-10-20') });
    expect(puts(asaas)).toHaveLength(0);
    expect(s.restored).toBe(1);
  });

  test('outra rodada segurando a trava: nao faz PUT', async () => {
    const db = makeDb([baseRow()], { claimRestore: false });
    const asaas = makeAsaas({ payments: [pay('2026-09-16', 119), pay('2026-10-16', 119), pay('2026-11-16', 119)] });
    const s = await tickSubscriptionDiscounts({ db, asaas, mailer: mailer(), now: at('2026-10-20') });
    expect(puts(asaas)).toHaveLength(0);
    expect(s.restored).toBe(0);
  });

  test('PUT falhou: solta a trava para a proxima rodada', async () => {
    const db = makeDb([baseRow()]);
    const asaas = makeAsaas({ payments: [pay('2026-09-16', 119), pay('2026-10-16', 119), pay('2026-11-16', 119)], failPut: true });
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const s = await tickSubscriptionDiscounts({ db, asaas, mailer: mailer(), now: at('2026-10-20') });
    err.mockRestore();
    expect(s).toMatchObject({ restored: 0, failed: 1 });
    expect(wrote(db, 'SET restore_claimed_at = NULL, restore_target_value = NULL')).toBe(true);
    expect(wrote(db, "status = 'restored'")).toBe(false);
  });

  test('empresa ja esta em outra assinatura: desconto perdido, sem tocar no Asaas', async () => {
    const db = makeDb([baseRow({ company_subscription_id: 'sub_novo_anual' })]);
    const asaas = makeAsaas();
    const s = await tickSubscriptionDiscounts({ db, asaas, mailer: mailer(), now: at('2026-10-20') });
    expect(asaas).not.toHaveBeenCalled();
    expect(s.lost).toBe(1);
    expect(db.writes[0].params).toEqual(['d1', 'subscription_changed']);
  });

  test('assinatura apagada no Asaas: desconto perdido', async () => {
    const db = makeDb([baseRow()]);
    const asaas = makeAsaas({ payments: [pay('2026-11-16', 119)], sub: { deleted: true, value: 119, status: 'INACTIVE' } });
    const s = await tickSubscriptionDiscounts({ db, asaas, mailer: mailer(), now: at('2026-12-01') });
    expect(puts(asaas)).toHaveLength(0);
    expect(s.lost).toBe(1);
  });
});

describe('aviso ao cliente', () => {
  const restored = (extra) => baseRow({ status: 'restored', restore_target_value: 169, ...extra });
  const fullPayments = [pay('2026-11-16', 119, 'RECEIVED'), pay('2026-12-16', 169)];

  test('5 dias antes, em horario comercial: um e-mail com a data e os valores reais', async () => {
    const db = makeDb([restored()]);
    const asaas = makeAsaas({ payments: fullPayments });
    const m = mailer();
    const s = await tickSubscriptionDiscounts({ db, asaas, mailer: m, now: at('2026-12-11') });
    expect(s.noticed).toBe(1);
    expect(m.sendDiscountEndingEmail).toHaveBeenCalledWith('ana@loja.com', {
      firstName: 'Ana', companyName: 'Loja da Ana', planName: 'Negócio', months: 3,
      discountedValue: 119, fullValue: 169, dueDate: '2026-12-16',
    });
  });

  test('6 dias antes: ainda nao', async () => {
    const db = makeDb([restored()]);
    const m = mailer();
    await tickSubscriptionDiscounts({ db, asaas: makeAsaas({ payments: fullPayments }), mailer: m, now: at('2026-12-10') });
    expect(m.sendDiscountEndingEmail).not.toHaveBeenCalled();
  });

  test('fora do horario (22h): nao manda', async () => {
    const db = makeDb([restored()]);
    const asaas = makeAsaas({ payments: fullPayments });
    const m = mailer();
    await tickSubscriptionDiscounts({ db, asaas, mailer: m, now: at('2026-12-11', 22) });
    expect(m.sendDiscountEndingEmail).not.toHaveBeenCalled();
    expect(asaas).not.toHaveBeenCalled();
  });

  test('ainda active (valor cheio nao devolvido): nao promete o que nao e verdade', async () => {
    const db = makeDb([baseRow()], { claimRestore: false });
    const m = mailer();
    await tickSubscriptionDiscounts({
      db, asaas: makeAsaas({ payments: [pay('2026-11-16', 119), pay('2026-12-16', 119)] }), mailer: m, now: at('2026-12-11'),
    });
    expect(m.sendDiscountEndingEmail).not.toHaveBeenCalled();
  });

  test('rotina parada ate depois do vencimento: pula o aviso sem consultar o Asaas', async () => {
    const db = makeDb([restored()]);
    const asaas = makeAsaas();
    const m = mailer();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await tickSubscriptionDiscounts({ db, asaas, mailer: m, now: at('2026-12-20') });
    warn.mockRestore();
    expect(m.sendDiscountEndingEmail).not.toHaveBeenCalled();
    expect(asaas).not.toHaveBeenCalled();
    expect(s.noticeSkipped).toBe(1);
    expect(wrote(db, 'notice_skipped = true')).toBe(true);
  });

  test('outra rodada ja pegou o aviso: nao manda duas vezes', async () => {
    const db = makeDb([restored()], { claimNotice: false });
    const m = mailer();
    await tickSubscriptionDiscounts({ db, asaas: makeAsaas({ payments: fullPayments }), mailer: m, now: at('2026-12-11') });
    expect(m.sendDiscountEndingEmail).not.toHaveBeenCalled();
  });

  test('envio falhou: desfaz a trava para tentar de novo', async () => {
    const db = makeDb([restored()]);
    const m = { sendDiscountEndingEmail: jest.fn(async () => { throw new Error('Resend 500'); }) };
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const s = await tickSubscriptionDiscounts({ db, asaas: makeAsaas({ payments: fullPayments }), mailer: m, now: at('2026-12-11') });
    err.mockRestore();
    expect(s).toMatchObject({ noticed: 0, failed: 1 });
    expect(wrote(db, 'SET notice_sent_at = NULL')).toBe(true);
  });

  test('desconto concluido e empresa ja no anual: nao marca como perdido', async () => {
    const db = makeDb([restored({ company_subscription_id: 'sub_anual', first_full_due_date: '2026-12-16' })]);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const s = await tickSubscriptionDiscounts({ db, asaas: makeAsaas(), mailer: mailer(), now: at('2027-01-05') });
    warn.mockRestore();
    expect(s.lost).toBe(0);
    expect(wrote(db, "status = 'lost'")).toBe(false);
  });
});

test('stripCouponFromDescription', () => {
  expect(stripCouponFromDescription('Aura Negocio + 2 acesso(s) extra — cupom X: R$ 50,00 de desconto')).toBe('Aura Negocio + 2 acesso(s) extra');
  expect(stripCouponFromDescription('Aura Negocio')).toBe('Aura Negocio');
  expect(stripCouponFromDescription(null)).toBeUndefined();
});
