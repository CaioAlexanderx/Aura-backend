// ============================================================
// POST /webhooks/asaas — reenvio seguro e cobrança criada (14/10/2026, t3-02)
//
// 1. last_payment_date nunca regride: o caso de 19/05 do Davi (R$ 140,83,
//    Pix) chegando hoje não pode apagar o pagamento de 24/09.
// 2. Reenvio de PAYMENT_RECEIVED/CONFIRMED/CREATED do mesmo pagamento não
//    repete efeito (nem companies, nem webhook_logs).
// 3. PAYMENT_CREATED fica registrado (o "a receber" da Financeiro) sem tocar
//    em companies; PAYMENT_OVERDUE e PAYMENT_DELETED seguem como antes.
//
// O banco de mentira guarda a empresa e os logs e interpreta a expressão de
// last_payment_date do UPDATE (só as duas formas conhecidas): com a forma
// antiga (COALESCE) o teste do Davi falha.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const SECRET = 'segredo-de-teste-asaas-abc123';
const DAVI = 'dddddddd-0000-4000-8000-000000000001';

function buildApp({ secret = SECRET } = {}) {
  jest.resetModules();
  if (secret === null) delete process.env.ASAAS_WEBHOOK_SECRET;
  else process.env.ASAAS_WEBHOOK_SECRET = secret;
  jest.doMock('../src/config/database');
  jest.doMock('../src/services/asaasClient', () => ({ asaas: jest.fn() }));
  jest.doMock('../src/services/digitalOrderNotifications', () => ({
    notifyPaymentConfirmed: jest.fn().mockResolvedValue(undefined),
  }));
  const db = require('../src/config/database');
  const { asaas } = require('../src/services/asaasClient');
  const app = express();
  app.use(express.json());
  app.use('/webhooks/asaas', require('../src/routes/webhookAsaas'));
  return { app, db, asaas };
}

const GREATEST = 'CASE WHEN $2 THEN GREATEST($3::date, last_payment_date) ELSE last_payment_date END';
const COALESCE_ANTIGO = 'CASE WHEN $2 THEN COALESCE($3, last_payment_date) ELSE last_payment_date END';

function bancoDeMentira(db, { empresa = null, logs = [], falharChecagem = false } = {}) {
  const estado = { empresa: empresa && { ...empresa }, logs: logs.map((l) => ({ ...l })), updates: 0 };
  db.query.mockImplementation(async (sql, params) => {
    if (/FROM companies WHERE asaas_customer_id/i.test(sql)) {
      return { rows: estado.empresa ? [{ ...estado.empresa }] : [] };
    }
    if (/SELECT last_payment_date::text AS last_payment_text FROM companies WHERE id/i.test(sql)) {
      return { rows: estado.empresa ? [{ last_payment_text: estado.empresa.last_payment_date }] : [] };
    }
    if (/SELECT 1 FROM webhook_logs/i.test(sql)) {
      if (falharChecagem) throw new Error('conexão caiu');
      // params: evento, pay_, só log com loja?, exige status de pago?, status pagos
      const [ev, id, comEmpresa, exigePago, pagos] = params;
      const achou = estado.logs.some((l) => l.event === ev && l.payload.id === id
        && (!comEmpresa || l.company_id != null) && (!exigePago || pagos.includes(l.payload.status)));
      return { rows: achou ? [{ '?column?': 1 }] : [] };
    }
    if (/INSERT INTO webhook_logs/i.test(sql)) {
      estado.logs.push({ company_id: params[0], event: params[1], payload: JSON.parse(params[2]) });
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE\s+companies\s+SET billing_status\s+= \$1,/i.test(sql)) {
      const expr = (sql.match(/last_payment_date = (.*?),\s*\n/) || [])[1];
      const [status, pago, data, proxima] = params;
      let nova = estado.empresa.last_payment_date;
      if (expr === GREATEST) {
        if (pago) nova = [data, nova].filter(Boolean).sort().pop() || null;
      } else if (expr === COALESCE_ANTIGO) {
        if (pago) nova = data || nova;
      } else {
        throw new Error('expressão de last_payment_date desconhecida no teste: ' + expr);
      }
      Object.assign(estado.empresa, {
        billing_status: status, last_payment_date: nova,
        next_billing_date: proxima || estado.empresa.next_billing_date,
      });
      estado.updates += 1;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return estado;
}

const davi = (extra) => ({
  id: DAVI, plan: 'negocio', billing_status: 'active', is_primary: false, asaas_subscription_id: 'sub_davi',
  last_payment_date: '2026-09-24', next_billing_date: '2026-10-24', ...extra,
});
// Fatura 813708772: R$ 140,83 por Pix em 19/05, sem externalReference.
const pagamento1905 = (extra) => ({
  id: 'pay_813708772', customer: 'cus_davi', subscription: 'sub_davi', value: 140.83, billingType: 'PIX',
  dueDate: '2026-05-18', paymentDate: '2026-05-19', status: 'RECEIVED', externalReference: null, ...extra,
});
const enviar = (app, body) => request(app).post('/webhooks/asaas').set('asaas-access-token', SECRET).send(body);
const assinaturaAsaas = (asaas) => asaas.mockImplementation(async (m, caminho) => {
  if (caminho.startsWith('/subscriptions/') && caminho.includes('/payments')) return { data: [] };
  if (caminho.startsWith('/subscriptions/')) return { id: 'sub_davi', status: 'ACTIVE', nextDueDate: '2026-10-24' };
  return undefined;
});

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.ASAAS_WEBHOOK_SECRET;
  jest.restoreAllMocks();
  jest.resetModules();
});

describe('last_payment_date nunca regride (caso Davi, 19/05)', () => {
  test('o recebimento de 19/05 chegando agora não apaga o de 24/09, mas fica registrado', async () => {
    const { app, db, asaas } = buildApp();
    const estado = bancoDeMentira(db, { empresa: davi() });
    assinaturaAsaas(asaas);

    const res = await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamento1905() });

    expect(res.body).toMatchObject({ handled: true, status: 'active' });
    expect(estado.empresa.last_payment_date).toBe('2026-09-24');
    expect(estado.logs).toHaveLength(1);
    expect(estado.logs[0]).toMatchObject({ company_id: DAVI, event: 'PAYMENT_RECEIVED' });
    expect(estado.logs[0].payload).toMatchObject({ id: 'pay_813708772', value: 140.83, paymentDate: '2026-05-19' });
  });

  test('pagamento mais novo continua avançando a data', async () => {
    const { app, db, asaas } = buildApp();
    const estado = bancoDeMentira(db, { empresa: davi() });
    assinaturaAsaas(asaas);
    await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamento1905({ id: 'pay_out', dueDate: '2026-10-24', paymentDate: '2026-10-14' }) });
    expect(estado.empresa.last_payment_date).toBe('2026-10-14');
  });

  test('empresa sem data nenhuma recebe a do pagamento; pagamento sem data não apaga a que existe', async () => {
    const { app, db, asaas } = buildApp();
    const estado = bancoDeMentira(db, { empresa: davi({ last_payment_date: null }) });
    assinaturaAsaas(asaas);
    await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamento1905() });
    expect(estado.empresa.last_payment_date).toBe('2026-05-19');

    const b = buildApp();
    const e2 = bancoDeMentira(b.db, { empresa: davi() });
    assinaturaAsaas(b.asaas);
    await enviar(b.app, { event: 'PAYMENT_CONFIRMED', payment: pagamento1905({ id: 'pay_cartao', paymentDate: null }) });
    expect(e2.empresa.last_payment_date).toBe('2026-09-24');
  });

  test('o UPDATE usa GREATEST com o parâmetro tipado como data', async () => {
    const { app, db, asaas } = buildApp();
    bancoDeMentira(db, { empresa: davi() });
    assinaturaAsaas(asaas);
    await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamento1905({ id: 'pay_out', paymentDate: '2026-10-14' }) });
    const [sql] = db.query.mock.calls.find(([s]) => /UPDATE\s+companies\s+SET billing_status/i.test(s));
    expect(sql).toContain(GREATEST);
    expect(sql).not.toContain('COALESCE($3, last_payment_date)');
  });
});

describe('reenvio do mesmo pagamento não repete efeito', () => {
  test('PAYMENT_RECEIVED de 19/05 já registrado: não toca em companies nem grava outra linha', async () => {
    const { app, db, asaas } = buildApp();
    const estado = bancoDeMentira(db, {
      empresa: davi({ billing_status: 'overdue' }),
      logs: [{ company_id: DAVI, event: 'PAYMENT_RECEIVED', payload: pagamento1905() }],
    });
    assinaturaAsaas(asaas);

    const res = await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamento1905() });

    expect(res.body).toEqual({ received: true, handled: false, duplicate: true, event: 'PAYMENT_RECEIVED' });
    expect(estado.updates).toBe(0);
    expect(estado.empresa).toMatchObject({ billing_status: 'overdue', last_payment_date: '2026-09-24' });
    expect(estado.logs).toHaveLength(1);
    expect(asaas).not.toHaveBeenCalled();
  });

  test('mandar duas vezes seguidas: efeito e linha uma vez só', async () => {
    const { app, db, asaas } = buildApp();
    const estado = bancoDeMentira(db, { empresa: davi() });
    assinaturaAsaas(asaas);
    const novo = pagamento1905({ id: 'pay_novo', paymentDate: '2026-10-14' });
    await enviar(app, { event: 'PAYMENT_RECEIVED', payment: novo });
    const r2 = await enviar(app, { event: 'PAYMENT_RECEIVED', payment: novo });
    expect(r2.body.duplicate).toBe(true);
    expect(estado.updates).toBe(1);
    expect(estado.logs.filter((l) => l.payload.id === 'pay_novo')).toHaveLength(1);
  });

  test('CONFIRMED e depois RECEIVED do mesmo pagamento (cartão) são eventos diferentes: os dois valem', async () => {
    const { app, db, asaas } = buildApp();
    const estado = bancoDeMentira(db, { empresa: davi() });
    assinaturaAsaas(asaas);
    const cartao = pagamento1905({ id: 'pay_cartao', billingType: 'CREDIT_CARD', paymentDate: '2026-10-14' });
    await enviar(app, { event: 'PAYMENT_CONFIRMED', payment: cartao });
    await enviar(app, { event: 'PAYMENT_RECEIVED', payment: cartao });
    await enviar(app, { event: 'PAYMENT_CONFIRMED', payment: cartao });
    expect(estado.logs.map((l) => l.event)).toEqual(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED']);
    expect(estado.updates).toBe(2);
  });

  test('pagamento sem loja reenviado também não duplica a linha', async () => {
    const { app, db } = buildApp();
    const estado = bancoDeMentira(db, { empresa: null });
    const orfao = pagamento1905({ id: 'pay_orfao', customer: 'cus_orfao' });
    await enviar(app, { event: 'PAYMENT_RECEIVED', payment: orfao });
    await enviar(app, { event: 'PAYMENT_RECEIVED', payment: orfao });
    expect(estado.logs).toHaveLength(1);
    expect(estado.logs[0].company_id).toBeNull();
  });

  test('se a checagem de reenvio falhar, o evento é processado como antes', async () => {
    const { app, db, asaas } = buildApp();
    const estado = bancoDeMentira(db, { empresa: davi(), falharChecagem: true });
    assinaturaAsaas(asaas);
    const res = await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamento1905({ id: 'pay_x', paymentDate: '2026-10-14' }) });
    expect(res.body.handled).toBe(true);
    expect(estado.empresa.last_payment_date).toBe('2026-10-14');
  });
});

describe('PAYMENT_CREATED registrado; OVERDUE e DELETED como antes', () => {
  const criada = (extra) => pagamento1905({ id: 'pay_nov', status: 'PENDING', dueDate: '2026-11-24', paymentDate: null, ...extra });

  test('cobrança criada vai para webhook_logs e não muda a empresa', async () => {
    const { app, db, asaas } = buildApp();
    const estado = bancoDeMentira(db, { empresa: davi() });
    const res = await enviar(app, { event: 'PAYMENT_CREATED', payment: criada() });
    expect(res.body).toMatchObject({ handled: true, status_changed: false, event_neutral: 'PAYMENT_CREATED', status: 'active' });
    expect(estado.updates).toBe(0);
    expect(estado.logs).toEqual([expect.objectContaining({ company_id: DAVI, event: 'PAYMENT_CREATED' })]);
    expect(estado.logs[0].payload).toMatchObject({ id: 'pay_nov', value: 140.83, dueDate: '2026-11-24' });
    expect(asaas).not.toHaveBeenCalled();
  });

  test('cobrança criada reenviada não duplica; sem loja não é gravada', async () => {
    const { app, db } = buildApp();
    const estado = bancoDeMentira(db, { empresa: davi() });
    await enviar(app, { event: 'PAYMENT_CREATED', payment: criada() });
    const r2 = await enviar(app, { event: 'PAYMENT_CREATED', payment: criada() });
    expect(r2.body.duplicate).toBe(true);
    expect(estado.logs).toHaveLength(1);

    const b = buildApp();
    const semLoja = bancoDeMentira(b.db, { empresa: null });
    const r3 = await enviar(b.app, { event: 'PAYMENT_CREATED', payment: criada({ customer: 'cus_orfao' }) });
    expect(r3.body).toEqual({ received: true, company_found: false, logged: false });
    expect(semLoja.logs).toEqual([]);
  });

  test('PAYMENT_OVERDUE repetido continua sendo processado e gravado (sem checagem de reenvio)', async () => {
    const { app, db } = buildApp();
    const estado = bancoDeMentira(db, { empresa: davi() });
    const vencida = criada({ id: 'pay_v', status: 'OVERDUE' });
    await enviar(app, { event: 'PAYMENT_OVERDUE', payment: vencida });
    await enviar(app, { event: 'PAYMENT_OVERDUE', payment: vencida });
    expect(estado.updates).toBe(2);
    expect(estado.empresa).toMatchObject({ billing_status: 'overdue', last_payment_date: '2026-09-24' });
    expect(estado.logs.filter((l) => l.event === 'PAYMENT_OVERDUE')).toHaveLength(2);
    expect(db.query.mock.calls.some(([s]) => /SELECT 1 FROM webhook_logs/.test(s))).toBe(false);
  });

  test('PAYMENT_DELETED segue neutro e gravado a cada vez', async () => {
    const { app, db } = buildApp();
    const estado = bancoDeMentira(db, { empresa: davi() });
    await enviar(app, { event: 'PAYMENT_DELETED', payment: criada({ deleted: true }) });
    await enviar(app, { event: 'PAYMENT_DELETED', payment: criada({ deleted: true }) });
    expect(estado.updates).toBe(0);
    expect(estado.logs.filter((l) => l.event === 'PAYMENT_DELETED')).toHaveLength(2);
  });

  test('sem segredo: PAYMENT_CREATED só é gravado se a Asaas confirma a cobrança pendente', async () => {
    const { app, db, asaas } = buildApp({ secret: null });
    const estado = bancoDeMentira(db, { empresa: davi() });
    asaas.mockResolvedValueOnce(criada());
    await request(app).post('/webhooks/asaas').send({ event: 'PAYMENT_CREATED', payment: { id: 'pay_nov' } });
    expect(estado.logs.map((l) => l.event)).toEqual(['PAYMENT_CREATED']);
    expect(estado.updates).toBe(0);

    asaas.mockRejectedValueOnce(new Error('Asaas error 404'));
    await request(app).post('/webhooks/asaas').send({ event: 'PAYMENT_CREATED', payment: { id: 'pay_falso' } });
    expect(estado.logs).toHaveLength(1);
  });
});

describe('revisão de 14/10: chave de reenvio e pagamento antigo', () => {
  test('log antigo com status OVERDUE e evento PAYMENT_RECEIVED não bloqueia o pagamento real', async () => {
    const { app, db, asaas } = buildApp();
    const estado = bancoDeMentira(db, {
      empresa: davi({ billing_status: 'overdue' }),
      logs: [{ company_id: DAVI, event: 'PAYMENT_RECEIVED', payload: pagamento1905({ id: 'pay_real', status: 'OVERDUE', paymentDate: null }) }],
    });
    assinaturaAsaas(asaas);
    const res = await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamento1905({ id: 'pay_real', paymentDate: '2026-10-14' }) });
    expect(res.body).toMatchObject({ handled: true, status: 'active' });
    expect(estado.updates).toBe(1);
    expect(estado.empresa).toMatchObject({ billing_status: 'active', last_payment_date: '2026-10-14' });
    expect(estado.logs).toHaveLength(2);
  });

  test('órfão já gravado (company_id nulo) não bloqueia o reenvio depois que a loja é vinculada', async () => {
    const { app, db, asaas } = buildApp();
    const estado = bancoDeMentira(db, {
      empresa: davi(),
      logs: [{ company_id: null, event: 'PAYMENT_RECEIVED', payload: pagamento1905({ id: 'pay_orf', paymentDate: '2026-10-14' }) }],
    });
    assinaturaAsaas(asaas);
    const res = await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamento1905({ id: 'pay_orf', paymentDate: '2026-10-14' }) });
    expect(res.body.duplicate).toBeUndefined();
    expect(estado.updates).toBe(1);
    expect(estado.logs.filter((l) => l.company_id === DAVI)).toHaveLength(1);
  });

  test('caso Davi: loja overdue com último pagamento em 24/09 recebendo o de 19/05 continua overdue', async () => {
    const { app, db, asaas } = buildApp();
    const estado = bancoDeMentira(db, { empresa: davi({ billing_status: 'overdue', is_primary: true }) });
    assinaturaAsaas(asaas);

    const res = await enviar(app, { event: 'PAYMENT_RECEIVED', payment: pagamento1905() });

    expect(res.body).toEqual({ received: true, handled: true, status_changed: false, status: 'overdue', old_payment: true });
    expect(estado.empresa).toMatchObject({ billing_status: 'overdue', last_payment_date: '2026-09-24' });
    expect(estado.updates).toBe(0);
    expect(db.query.mock.calls.some(([s]) => /billing_owner_company_id/i.test(s))).toBe(false); // não propaga
    expect(estado.logs).toEqual([expect.objectContaining({ company_id: DAVI, event: 'PAYMENT_RECEIVED' })]);
    expect(asaas).not.toHaveBeenCalled();
  });

  test('fluxo normal intacto: overdue recebendo pagamento novo vira active; loja sem data também', async () => {
    const a = buildApp();
    const e1 = bancoDeMentira(a.db, { empresa: davi({ billing_status: 'overdue' }) });
    assinaturaAsaas(a.asaas);
    await enviar(a.app, { event: 'PAYMENT_RECEIVED', payment: pagamento1905({ id: 'pay_n', paymentDate: '2026-09-24' }) });
    expect(e1.empresa.billing_status).toBe('active'); // mesma data do último: não é antigo

    const b = buildApp();
    const e2 = bancoDeMentira(b.db, { empresa: davi({ billing_status: 'overdue', last_payment_date: null }) });
    assinaturaAsaas(b.asaas);
    await enviar(b.app, { event: 'PAYMENT_RECEIVED', payment: pagamento1905() });
    expect(e2.empresa).toMatchObject({ billing_status: 'active', last_payment_date: '2026-05-19' });
  });
});