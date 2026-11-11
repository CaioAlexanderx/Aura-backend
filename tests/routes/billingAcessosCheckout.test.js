// ============================================================
// p-106 — acessos de funcionário escolhidos no checkout (11/11/2026)
//
// Banco de mentira com estado (companies, seat_passes, audit_log,
// webhook_logs) e Asaas de mentira. Cobre:
//   - sem extra_seats: valores e respostas iguais aos de hoje (snapshot);
//   - com extra_seats: plano + R$ 19 x (escolhidos + temporada), cupom só no plano;
//   - validação de 0 a 10;
//   - /subscribe não libera nada: guarda a pendência; o webhook libera;
//   - Pix não pago não libera; assinar de novo troca a pendência;
//   - passe de temporada preservado (nem apagado nem cobrado em dobro);
//   - assinatura ativa e em dia recusada (409 ASSINATURA_ATIVA);
//   - valor combinado ignora a quantidade.
// ============================================================
'use strict';

jest.mock('../../src/services/asaasClient', () => ({
  ...jest.requireActual('../../src/services/asaasClient'),
  asaas: jest.fn(),
}));

const request = require('supertest');
const jwt     = require('jsonwebtoken');

const WEBHOOK_SECRET = 'segredo-webhook-p106';
let app, db, asaas;
beforeAll(() => {
  process.env.ASAAS_WEBHOOK_SECRET = WEBHOOK_SECRET;
  ({ app } = require('../../src/index'));
  db = require('../../src/config/database');
  ({ asaas } = require('../../src/services/asaasClient'));
});
afterAll(() => { delete process.env.ASAAS_WEBHOOK_SECRET; });

const SECRET = 'aura-test-secret-2026';
const cid    = '6b1d2c3e-1111-4a2b-9c3d-000000000106';
const auth   = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'essencial' }, SECRET, { expiresIn: '1h' })}` };

const empresa = (extra = {}) => ({
  id: cid, plan: 'essencial', asaas_customer_id: 'cus_1', asaas_subscription_id: null,
  billing_status: 'trial', billing_cycle: 'monthly', last_payment_date: null, is_primary: false,
  extra_seats_granted: 0, vertical_active: null, cnpj: '11222333000181',
  custom_subscription_value: null, custom_subscription_plan: null,
  custom_subscription_cycle: null, custom_subscription_note: null,
  pending_extra_seats: null, pending_extra_seats_subscription_id: null,
  pending_extra_seats_payment_id: null, pending_extra_seats_at: null,
  ...extra,
});

const cupom = (extra = {}) => ({
  id: 'ac-1', code: 'BLACK50', type: 'promo', plan: null,
  discount_pct: 50, discount_value: 0, discount_months: 1, restrict_to_plan: false,
  trial_days: 0, max_uses: 10, uses: 0, expires_at: null, is_active: true, referrer_id: null,
  ...extra,
});

// passes: [{ qty, status, applied }]
function bancoDeMentira({ company = empresa(), passes = [], codes = {}, falharTemporada = null } = {}) {
  const estado = { company: { ...company }, passes: passes.map((p) => ({ ...p })), audit: [], logs: [], calls: [] };
  const temporadaAtiva = () => estado.passes
    .filter((p) => p.status === 'ativo' && p.applied).reduce((s, p) => s + p.qty, 0);

  db.query.mockImplementation(async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    estado.calls.push({ sql: s, params });
    const c = estado.company;
    if (s.includes('AS role')) return { rows: [{ role: 'owner' }] };
    if (s.includes('SELECT * FROM companies WHERE id')) return { rows: [{ ...c }] };
    if (s.includes('SELECT * FROM users WHERE id')) return { rows: [{ id: 'u1', email: 'dona@loja.com', full_name: 'Dona' }] };
    if (s.includes('FROM seat_passes WHERE company_id = $1 AND status = \'ativo\' AND applied_at IS NOT NULL')) {
      if (falharTemporada) throw falharTemporada;
      return { rows: [{ total: temporadaAtiva() }] };
    }
    if (s.includes('FROM access_codes WHERE code')) {
      const row = codes[params[0]];
      return { rows: row ? [row] : [] };
    }
    if (s.includes('FROM coupon_redemptions WHERE company_id')) return { rows: [] };
    if (s.includes('UPDATE access_codes SET uses = uses + 1')) return { rows: [{ uses: 1 }] };

    // /subscribe
    if (s.startsWith('UPDATE companies SET plan=$1, asaas_subscription_id=$2, billing_status=$3')) {
      Object.assign(c, { plan: params[0], asaas_subscription_id: params[1], billing_status: params[2], billing_cycle: params[3] });
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('UPDATE companies SET plan=$1, asaas_subscription_id=$2, billing_status=\'trial\'')) {
      Object.assign(c, { plan: params[0], asaas_subscription_id: params[1], billing_status: 'trial', billing_cycle: params[2] });
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('UPDATE companies SET plan=$1, asaas_pending_payment_id=$2')) {
      Object.assign(c, { plan: params[0], billing_status: params[2], billing_cycle: params[3] });
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('UPDATE companies SET pending_extra_seats = $2')) {
      Object.assign(c, {
        pending_extra_seats: params[1], pending_extra_seats_subscription_id: params[2],
        pending_extra_seats_payment_id: params[3], pending_extra_seats_at: params[1] === null ? null : 'agora',
      });
      return { rows: [], rowCount: 1 };
    }

    // webhook
    if (s.includes('FROM companies WHERE asaas_customer_id=$1 OR id=$2')) {
      return { rows: [{ id: c.id, plan: c.plan, billing_status: c.billing_status, is_primary: c.is_primary, asaas_subscription_id: c.asaas_subscription_id }] };
    }
    if (s.includes('SELECT 1 FROM webhook_logs')) {
      const achou = estado.logs.some((l) => l.event === params[0] && l.payload.id === params[1]);
      return { rows: achou ? [{ x: 1 }] : [] };
    }
    if (s.includes('INSERT INTO webhook_logs')) {
      estado.logs.push({ company_id: params[0], event: params[1], payload: JSON.parse(params[2]) });
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('UPDATE companies SET billing_status = $1,')) {
      c.billing_status = params[0];
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('WITH alvo AS')) {
      const [, payId, subId] = params;
      const casa = c.pending_extra_seats !== null && c.pending_extra_seats !== undefined && (
        (c.pending_extra_seats_payment_id && c.pending_extra_seats_payment_id === payId) ||
        (c.pending_extra_seats_subscription_id && c.pending_extra_seats_subscription_id === subId));
      if (!casa) return { rows: [] };
      const antes = c.extra_seats_granted;
      const pendente = c.pending_extra_seats;
      Object.assign(c, {
        extra_seats_granted: pendente + temporadaAtiva(),
        pending_extra_seats: null, pending_extra_seats_subscription_id: null,
        pending_extra_seats_payment_id: null, pending_extra_seats_at: null,
      });
      return { rows: [{ id: c.id, plan: c.plan, billing_cycle: c.billing_cycle, billing_status: c.billing_status,
        asaas_subscription_id: c.asaas_subscription_id, extra_seats_granted: c.extra_seats_granted, pendente, antes }] };
    }
    if (s.includes('INSERT INTO audit_log')) {
      estado.audit.push({ action: params[2], detail: params[3], metadata: JSON.parse(params[4]) });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return estado;
}

// Asaas: guarda as assinaturas criadas (valor) para o sync e o webhook lerem.
function asaasDeMentira({ cartao = 'CONFIRMED' } = {}) {
  const subs = {};
  let n = 0;
  asaas.mockImplementation(async (method, path, body) => {
    if (method === 'POST' && path === '/payments') return { id: 'pay_cartao', status: cartao };
    if (method === 'POST' && path === '/subscriptions') {
      n += 1;
      const id = 'sub_' + n;
      subs[id] = { id, value: body.value, billingType: body.billingType, status: 'ACTIVE', nextDueDate: body.nextDueDate };
      return { id, nextDueDate: body.nextDueDate };
    }
    if (method === 'GET' && /^\/subscriptions\/sub_\d+\/payments\?limit=1$/.test(path)) {
      return { data: [{ id: 'pay_pix_' + path.split('/')[2].slice(4) }] };
    }
    if (method === 'GET' && path.endsWith('/pixQrCode')) return { encodedImage: 'img', payload: 'pix-copia', expirationDate: 'x' };
    if (method === 'GET' && /^\/subscriptions\/[^/?]+\/payments/.test(path)) return { data: [] };
    if (method === 'GET' && /^\/subscriptions\/[^/?]+$/.test(path)) {
      const sub = subs[decodeURIComponent(path.split('/')[2])];
      return sub ? { ...sub } : { id: path.split('/')[2], status: 'ACTIVE', value: 0, billingType: 'PIX' };
    }
    if (method === 'GET' && path.startsWith('/payments?customer=')) return { data: [] };
    if (method === 'PUT' && path.startsWith('/subscriptions/')) {
      const sub = subs[path.split('/')[2]];
      if (sub) sub.value = body.value;
      return {};
    }
    if (method === 'PUT' || method === 'DELETE') return {};
    throw new Error('Asaas inesperado: ' + method + ' ' + path);
  });
  return subs;
}

const asaasCalls = (method, path) => asaas.mock.calls.filter((c) => c[0] === method && c[1] === path);
const subscribe = (body) => request(app).post(`/api/v1/companies/${cid}/billing/subscribe`).set(auth).send(body);
const quote = (qs) => request(app).get(`/api/v1/companies/${cid}/billing/quote?${qs}`).set(auth);
const validar = (body) => request(app).post(`/api/v1/companies/${cid}/billing/validate-coupon`).set(auth).send(body);
const webhook = (event, payment) => request(app).post('/api/v1/webhooks/asaas')
  .set('asaas-access-token', WEBHOOK_SECRET).send({ event, payment });
const pagamento = (extra) => ({
  id: 'pay_pix_1', customer: 'cus_1', subscription: 'sub_1', value: 127, billingType: 'PIX',
  status: 'RECEIVED', paymentDate: '2026-11-12', externalReference: cid, ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  asaas.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

// ── Sem extra_seats: igual a hoje ─────────────────────────────────────────
describe('sem extra_seats o checkout é o de hoje', () => {
  test('GET /quote: mesma resposta, com extra_seats_granted (que já inclui a temporada)', async () => {
    bancoDeMentira({ company: empresa({ extra_seats_granted: 3 }), passes: [{ qty: 1, status: 'ativo', applied: true }] });
    const res = await quote('plan=negocio&cycle=annual&billing_type=PIX');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      plan: 'negocio', cycle: 'annual', billing_type: 'PIX',
      value: 197.83, custom: false, table_value: 197.83, extra_seats: 3,
    });
  });

  test.each([
    ['essencial', 'monthly', 'PIX', 0, 89],
    ['negocio', 'monthly', 'PIX', 2, 207],
    ['negocio', 'annual', 'CREDIT_CARD', 1, 159.83],
    ['expansao', 'annual', 'PIX', 0, 224.17],
  ])('/subscribe %s %s %s com %i extra(s): R$ %d, sem pendência gravada', async (plan, cycle, bt, granted, esperado) => {
    const estado = bancoDeMentira({ company: empresa({ extra_seats_granted: granted }) });
    asaasDeMentira();
    const res = await subscribe({ plan, cycle, billing_type: bt, end_date: '2027-11-11', credit_card_token: 'tok' });
    expect([201, 202]).toContain(res.status);
    expect(res.body.value).toBe(esperado);
    expect(res.body.extra_seats).toBe(granted);
    expect(res.body).not.toHaveProperty('extra_seats_pending');
    expect(res.body).not.toHaveProperty('season_extra_seats');
    const [, , assinatura] = asaasCalls('POST', '/subscriptions')[0];
    expect(assinatura.value).toBe(esperado);
    expect(estado.calls.some((c) => c.sql.includes('pending_extra_seats'))).toBe(false);
    expect(estado.calls.some((c) => c.sql.includes('seat_passes'))).toBe(false);
    expect(estado.company.extra_seats_granted).toBe(granted);
  });

  test('/validate-coupon: mesma resposta de hoje (BLACK50 abate só o plano)', async () => {
    bancoDeMentira({ company: empresa({ extra_seats_granted: 1 }), codes: { BLACK50: cupom() } });
    const res = await validar({ code: 'BLACK50', plan: 'negocio', cycle: 'monthly', billing_type: 'PIX' });
    expect(res.body.valid).toBe(true);
    expect(res.body.recurring_value).toBe(188);
    expect(res.body.first_charge_value).toBe(103.5);
    expect(res.body.discount_amount).toBe(84.5);
    expect(res.body.extra_seats).toBe(1);
    expect(res.body).not.toHaveProperty('custom');
    expect(res.body).not.toHaveProperty('charged_extra_seats');
  });

  test('assinar de novo sem extra_seats limpa a pendência de uma assinatura apagada', async () => {
    const estado = bancoDeMentira({ company: empresa({ pending_extra_seats: 4, pending_extra_seats_subscription_id: 'sub_velha' }) });
    asaasDeMentira();
    const res = await subscribe({ plan: 'essencial', cycle: 'monthly', billing_type: 'PIX' });
    expect(res.status).toBe(201);
    expect(res.body.value).toBe(89);
    expect(estado.company.pending_extra_seats).toBeNull();
    expect(estado.company.pending_extra_seats_subscription_id).toBeNull();
  });
});

// ── Validação ─────────────────────────────────────────────────────────────
describe('extra_seats de 0 a 10', () => {
  test.each([[-1], [11], [2.5], ['abc'], [''], ['3.0'], [true], [[2]]])('%p → 400 sem tocar na Asaas', async (v) => {
    bancoDeMentira();
    asaasDeMentira();
    const res = await subscribe({ plan: 'negocio', cycle: 'monthly', billing_type: 'PIX', extra_seats: v });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('EXTRA_SEATS_INVALIDO');
    expect(asaas).not.toHaveBeenCalled();
  });

  test('quote e validate-coupon também validam', async () => {
    bancoDeMentira({ codes: { BLACK50: cupom() } });
    expect((await quote('plan=negocio&extra_seats=11')).status).toBe(400);
    expect((await validar({ code: 'BLACK50', plan: 'negocio', extra_seats: -2 })).status).toBe(400);
  });

  test.each([[0], [10], ['7']])('%p é aceito', async (v) => {
    bancoDeMentira();
    const res = await quote('plan=essencial&extra_seats=' + v);
    expect(res.status).toBe(200);
    expect(res.body.extra_seats).toBe(Number(v));
    expect(res.body.value).toBe(89 + 19 * Number(v));
  });
});

// ── Com extra_seats: valor certo ──────────────────────────────────────────
describe('com extra_seats o valor é plano + R$ 19 por acesso', () => {
  test('quote: Negócio mensal com 2 = 207; traz o que o seletor precisa', async () => {
    bancoDeMentira({ company: empresa({ extra_seats_granted: 1 }) });
    const res = await quote('plan=negocio&cycle=monthly&billing_type=PIX&extra_seats=2');
    expect(res.body).toEqual({
      plan: 'negocio', cycle: 'monthly', billing_type: 'PIX',
      value: 207, custom: false, table_value: 207,
      extra_seats: 2, season_extra_seats: 0, charged_extra_seats: 2, seat_price: 19,
      current_extra_seats: 1, pending_extra_seats: null, max_extra_seats: 10, plan_included_seats: 3,
    });
  });

  test('anual: o acesso fica em R$ 19 cheio (sem o desconto de ciclo)', async () => {
    bancoDeMentira();
    const res = await quote('plan=essencial&cycle=annual&extra_seats=3');
    expect(res.body.value).toBe(131.17); // 74,17 + 57
  });

  test('cupom BLACK50 abate só o plano: Negócio mensal + 2 → 1ª de 122,50, depois 207', async () => {
    bancoDeMentira({ codes: { BLACK50: cupom() } });
    const v = await validar({ code: 'BLACK50', plan: 'negocio', cycle: 'monthly', billing_type: 'PIX', extra_seats: 2 });
    expect(v.body).toMatchObject({
      valid: true, recurring_value: 207, first_charge_value: 122.5, discount_amount: 84.5,
      extra_seats: 2, charged_extra_seats: 2, custom: false,
    });

    asaasDeMentira();
    const res = await subscribe({ plan: 'negocio', cycle: 'monthly', billing_type: 'PIX', extra_seats: 2, access_code: 'BLACK50' });
    expect(res.status).toBe(201);
    expect(res.body.value).toBe(207);
    expect(res.body.charged_now).toBe(122.5);
    const [, , assinatura] = asaasCalls('POST', '/subscriptions')[0];
    expect(assinatura.value).toBe(207);
    expect(assinatura.description).toBe('Aura Negocio + 2 acesso(s) extra');
    const [, , ajuste] = asaasCalls('PUT', '/payments/pay_pix_1')[0];
    expect(ajuste.value).toBe(122.5);
  });

  test('cartão: 1ª cobrança e recorrência com os acessos escolhidos', async () => {
    bancoDeMentira({ company: empresa({ extra_seats_granted: 5 }) });
    asaasDeMentira();
    const res = await subscribe({ plan: 'essencial', cycle: 'monthly', billing_type: 'CREDIT_CARD', credit_card_token: 'tok', extra_seats: 1 });
    expect(res.status).toBe(201);
    expect(asaasCalls('POST', '/payments')[0][2].value).toBe(108);
    expect(asaasCalls('POST', '/subscriptions')[0][2].value).toBe(108);
    expect(res.body).toMatchObject({ extra_seats: 1, charged_extra_seats: 1, extra_seats_pending: true, custom: false });
  });

  test('extra_seats=0 reduz para só o plano', async () => {
    bancoDeMentira({ company: empresa({ extra_seats_granted: 2 }) });
    asaasDeMentira();
    const res = await subscribe({ plan: 'essencial', cycle: 'monthly', billing_type: 'PIX', extra_seats: 0 });
    expect(res.body.value).toBe(89);
  });
});

// ── Liberação só com pagamento confirmado ─────────────────────────────────
describe('os acessos só liberam com o pagamento confirmado', () => {
  test('Pix: /subscribe guarda a pendência; o webhook RECEIVED da assinatura libera, audita e confere a Asaas', async () => {
    const estado = bancoDeMentira();
    asaasDeMentira();
    const res = await subscribe({ plan: 'negocio', cycle: 'monthly', billing_type: 'PIX', extra_seats: 3 });
    expect(res.status).toBe(201);
    expect(res.body.value).toBe(226);
    expect(estado.company.extra_seats_granted).toBe(0);
    expect(estado.company.pending_extra_seats).toBe(3);
    expect(estado.company.pending_extra_seats_subscription_id).toBe('sub_1');
    expect(estado.company.pending_extra_seats_payment_id).toBe('pay_pix_1');

    const wh = await webhook('PAYMENT_RECEIVED', pagamento({ value: 226 }));
    expect(wh.status).toBe(200);
    expect(wh.body.extra_seats_applied).toBe(3);
    expect(estado.company.extra_seats_granted).toBe(3);
    expect(estado.company.pending_extra_seats).toBeNull();
    const aud = estado.audit.find((a) => a.action === 'billing.extra_seats_applied');
    expect(aud.metadata).toMatchObject({ pendente: 3, temporada: 0, extra_seats_granted: 3, sync: 'value_unchanged' });
    // valor certo: nenhum PUT de ajuste
    expect(asaasCalls('PUT', '/subscriptions/sub_1')).toHaveLength(0);
  });

  test('cartão aprovado na hora: /subscribe não libera; o PAYMENT_CONFIRMED da 1ª cobrança avulsa libera', async () => {
    const estado = bancoDeMentira();
    asaasDeMentira();
    await subscribe({ plan: 'essencial', cycle: 'monthly', billing_type: 'CREDIT_CARD', credit_card_token: 'tok', extra_seats: 2 });
    expect(estado.company.billing_status).toBe('active');
    expect(estado.company.extra_seats_granted).toBe(0);
    expect(estado.company.pending_extra_seats_payment_id).toBe('pay_cartao');

    await webhook('PAYMENT_CONFIRMED', pagamento({ id: 'pay_cartao', subscription: null, billingType: 'CREDIT_CARD', status: 'CONFIRMED' }));
    expect(estado.company.extra_seats_granted).toBe(2);
    expect(estado.company.pending_extra_seats).toBeNull();
  });

  test('o valor errado na Asaas é corrigido depois de liberar', async () => {
    const estado = bancoDeMentira();
    const subs = asaasDeMentira();
    await subscribe({ plan: 'negocio', cycle: 'monthly', billing_type: 'PIX', extra_seats: 1 });
    subs.sub_1.value = 169; // alguém mexeu na Asaas
    await webhook('PAYMENT_RECEIVED', pagamento());
    const [, , put] = asaasCalls('PUT', '/subscriptions/sub_1')[0];
    expect(put.value).toBe(188);
    expect(estado.audit.find((a) => a.action === 'billing.extra_seats_applied').metadata.sync).toBe('ajustado');
  });

  test('reenvio do mesmo webhook não aplica de novo', async () => {
    const estado = bancoDeMentira();
    asaasDeMentira();
    await subscribe({ plan: 'negocio', cycle: 'monthly', billing_type: 'PIX', extra_seats: 2 });
    await webhook('PAYMENT_RECEIVED', pagamento());
    estado.company.extra_seats_granted = 5; // Gestão Aura mudou depois
    const de = await webhook('PAYMENT_RECEIVED', pagamento());
    expect(de.body.duplicate).toBe(true);
    expect(estado.company.extra_seats_granted).toBe(5);
    expect(estado.audit.filter((a) => a.action === 'billing.extra_seats_applied')).toHaveLength(1);
  });

  test('evento que não é de pagamento (OVERDUE) não libera', async () => {
    const estado = bancoDeMentira();
    asaasDeMentira();
    await subscribe({ plan: 'negocio', cycle: 'monthly', billing_type: 'PIX', extra_seats: 2 });
    await webhook('PAYMENT_OVERDUE', pagamento({ status: 'OVERDUE', paymentDate: null }));
    expect(estado.company.extra_seats_granted).toBe(0);
    expect(estado.company.pending_extra_seats).toBe(2);
  });
});

// ── Pix gerado e não pago ─────────────────────────────────────────────────
describe('Pix não pago', () => {
  test('nunca vira acesso; assinar de novo troca a pendência e o Pix velho não libera', async () => {
    const estado = bancoDeMentira();
    asaasDeMentira();
    await subscribe({ plan: 'negocio', cycle: 'monthly', billing_type: 'PIX', extra_seats: 5 });
    expect(estado.company.pending_extra_seats).toBe(5);

    // volta ao checkout e assina de novo com 1: a assinatura velha é apagada
    const res = await subscribe({ plan: 'negocio', cycle: 'monthly', billing_type: 'PIX', extra_seats: 1 });
    expect(res.status).toBe(201);
    expect(asaasCalls('DELETE', '/subscriptions/sub_1')).toHaveLength(1);
    expect(estado.company.pending_extra_seats).toBe(1);
    expect(estado.company.pending_extra_seats_subscription_id).toBe('sub_2');

    // pagamento do Pix velho (se chegasse) não casa com a pendência nova
    await webhook('PAYMENT_RECEIVED', pagamento({ id: 'pay_pix_1', subscription: 'sub_1' }));
    expect(estado.company.extra_seats_granted).toBe(0);
    expect(estado.company.pending_extra_seats).toBe(1);

    await webhook('PAYMENT_RECEIVED', pagamento({ id: 'pay_pix_2', subscription: 'sub_2' }));
    expect(estado.company.extra_seats_granted).toBe(1);
  });
});

// ── Temporada ─────────────────────────────────────────────────────────────
describe('acessos de temporada', () => {
  test('somam por cima da escolha, uma vez só, e continuam depois da liberação', async () => {
    // 1 permanente + 2 de temporada aplicados = 3 em extra_seats_granted
    const estado = bancoDeMentira({
      company: empresa({ extra_seats_granted: 3, billing_status: 'overdue', asaas_subscription_id: 'sub_antiga' }),
      passes: [{ qty: 2, status: 'ativo', applied: true }, { qty: 4, status: 'ativo', applied: false }, { qty: 9, status: 'expirado', applied: true }],
    });
    asaasDeMentira();
    const q = await quote('plan=negocio&cycle=monthly&extra_seats=1');
    expect(q.body).toMatchObject({ value: 226, extra_seats: 1, season_extra_seats: 2, charged_extra_seats: 3, current_extra_seats: 1 });

    const res = await subscribe({ plan: 'negocio', cycle: 'monthly', billing_type: 'PIX', extra_seats: 4 });
    expect(res.body.value).toBe(169 + 19 * 6);
    expect(estado.company.extra_seats_granted).toBe(3); // nada muda antes do pagamento
    expect(estado.company.pending_extra_seats).toBe(4);

    await webhook('PAYMENT_RECEIVED', pagamento());
    expect(estado.company.extra_seats_granted).toBe(6); // 4 + 2 da temporada
    const aud = estado.audit.find((a) => a.action === 'billing.extra_seats_applied');
    expect(aud.metadata).toMatchObject({ pendente: 4, temporada: 2, extra_seats_granted_antes: 3 });
  });
});

// ── Assinatura ativa e em dia ─────────────────────────────────────────────
describe('loja com assinatura ativa e em dia', () => {
  const ativa = (extra) => empresa({
    plan: 'negocio', billing_status: 'active', asaas_subscription_id: 'sub_ativa', billing_cycle: 'monthly',
    extra_seats_granted: 1, ...extra,
  });

  test('mudar só os acessos no mesmo plano e ciclo: 409 ASSINATURA_ATIVA, nada na Asaas', async () => {
    const estado = bancoDeMentira({ company: ativa() });
    asaasDeMentira();
    const res = await subscribe({ plan: 'negocio', cycle: 'monthly', billing_type: 'PIX', extra_seats: 3 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ASSINATURA_ATIVA');
    expect(res.body.error).toMatch(/já está ativa e em dia/);
    expect(res.body.current_extra_seats).toBe(1);
    expect(asaas).not.toHaveBeenCalled();
    expect(estado.company.pending_extra_seats).toBeNull();
  });

  test('o passe de temporada não conta como mudança: granted 3 = 1 + 2 de temporada, escolher 1 segue', async () => {
    bancoDeMentira({ company: ativa({ extra_seats_granted: 3 }), passes: [{ qty: 2, status: 'ativo', applied: true }] });
    asaasDeMentira();
    const res = await subscribe({ plan: 'negocio', cycle: 'monthly', billing_type: 'PIX', extra_seats: 1 });
    expect(res.status).toBe(201);
    expect(res.body.value).toBe(226);
  });

  test('troca de plano segue o fluxo de hoje, com a pendência até o pagamento', async () => {
    const estado = bancoDeMentira({ company: ativa() });
    asaasDeMentira();
    const res = await subscribe({ plan: 'expansao', cycle: 'monthly', billing_type: 'PIX', extra_seats: 2 });
    expect(res.status).toBe(201);
    expect(res.body.value).toBe(307);
    expect(asaasCalls('DELETE', '/subscriptions/sub_ativa')).toHaveLength(1);
    expect(estado.company.extra_seats_granted).toBe(1);
    expect(estado.company.pending_extra_seats).toBe(2);
  });

  test('sem extra_seats a loja ativa assina como hoje', async () => {
    bancoDeMentira({ company: ativa() });
    asaasDeMentira();
    const res = await subscribe({ plan: 'negocio', cycle: 'monthly', billing_type: 'PIX' });
    expect(res.status).toBe(201);
    expect(res.body.value).toBe(188);
  });
});

// ── Valor combinado ───────────────────────────────────────────────────────
describe('valor combinado', () => {
  const combinado = (extra) => empresa({
    extra_seats_granted: 2, custom_subscription_value: '211.20',
    custom_subscription_plan: 'negocio', custom_subscription_cycle: 'annual', ...extra,
  });

  test('ignora extra_seats: cobra o combinado, custom=true e nenhuma pendência', async () => {
    const estado = bancoDeMentira({ company: combinado() });
    asaasDeMentira();
    const q = await quote('plan=negocio&cycle=annual&extra_seats=7');
    expect(q.body).toMatchObject({ value: 211.2, custom: true, extra_seats: 2, extra_seats_ignored: true });

    const res = await subscribe({ plan: 'negocio', cycle: 'annual', billing_type: 'PIX', end_date: '2027-11-11', extra_seats: 7 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ value: 211.2, custom: true, extra_seats: 2, extra_seats_ignored: true });
    expect(res.body).not.toHaveProperty('extra_seats_pending');
    expect(asaasCalls('POST', '/subscriptions')[0][2].value).toBe(211.2);
    expect(estado.company.pending_extra_seats).toBeNull();
    expect(estado.calls.some((c) => c.sql.includes('seat_passes'))).toBe(false);
  });

  test('validate-coupon com extra_seats devolve custom=true', async () => {
    bancoDeMentira({ company: combinado(), codes: { BLACK50: cupom() } });
    const v = await validar({ code: 'BLACK50', plan: 'negocio', cycle: 'annual', extra_seats: 4 });
    expect(v.body).toMatchObject({ valid: true, recurring_value: 211.2, custom: true, extra_seats_ignored: true });
  });

  test('plano/ciclo fora do combinado: a escolha vale normalmente', async () => {
    bancoDeMentira({ company: combinado() });
    const q = await quote('plan=negocio&cycle=monthly&extra_seats=1');
    expect(q.body).toMatchObject({ value: 188, custom: false, extra_seats: 1 });
  });
});

// ── Antes da migration 445 ────────────────────────────────────────────────
describe('defensivo antes da migration 445', () => {
  test('com extra_seats e sem a coluna: 503 antes de tocar na Asaas', async () => {
    const semColuna = empresa();
    delete semColuna.pending_extra_seats;
    delete semColuna.pending_extra_seats_subscription_id;
    delete semColuna.pending_extra_seats_payment_id;
    delete semColuna.pending_extra_seats_at;
    bancoDeMentira({ company: semColuna });
    asaasDeMentira();
    const res = await subscribe({ plan: 'negocio', cycle: 'monthly', billing_type: 'PIX', extra_seats: 2 });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('MIGRATION_PENDING');
    expect(asaas).not.toHaveBeenCalled();
  });

  test('sem seat_passes (42P01) a temporada conta 0', async () => {
    const e = new Error('relation "seat_passes" does not exist'); e.code = '42P01';
    bancoDeMentira({ falharTemporada: e });
    const q = await quote('plan=essencial&extra_seats=2');
    expect(q.body).toMatchObject({ value: 127, season_extra_seats: 0 });
  });
});
