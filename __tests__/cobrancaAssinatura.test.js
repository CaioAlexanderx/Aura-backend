// ============================================================
// AURA. — Cobranças da assinatura: espelho, e-mails do webhook e datas do
// atraso (tq-74, tq-76, tq-84, tq-86 — 24/10/2026)
//
//   - recibo UM por cobrança: CONFIRMED e RECEIVED da mesma cobrança, e o
//     reenvio da Asaas, não mandam dois e-mails
//   - conta interna, sandbox, Karatê e inativa não recebem
//   - pagamento antigo (evento atrasado) não vira recibo
//   - estorno e contestação: um e-mail cada
//   - cartão recusado: 2.8 na primeira, nada na repetição; 2.8b depois da
//     nova tentativa da Aura
//   - datas do atraso (/auth/me): +7 e +14 do vencimento OVERDUE mais antigo
//   - email_log: reserva antes de enviar; falha pode ser tentada de novo
// ============================================================
'use strict';

const { criarBanco, criarEnvio } = require('./helpers/bancoDaCobranca');
const C = require('../src/services/cobrancaAssinatura');
const { enviarEmailRegistrado } = require('../src/services/emailLog');

const EMP = 'aaaaaaaa-0000-4000-8000-000000000001';
const DONO = 'bbbbbbbb-0000-4000-8000-000000000001';
const AGORA = Date.parse('2026-11-20T15:00:00Z'); // 12h em São Paulo
const ENV = {}; // interruptores no padrão (ligados; nova tentativa desligada)

function banco(extraEmpresa = {}, extraUsuario = {}) {
  return criarBanco({
    empresas: [{ id: EMP, owner_id: DONO, trade_name: 'Modas da Maria', email: 'loja@maria.com.br', ...extraEmpresa }],
    usuarios: [{ id: DONO, email: 'maria@exemplo.com', full_name: 'Maria Souza', ...extraUsuario }],
  });
}

const pagamento = (extra = {}) => ({
  id: 'pay_1', customer: 'cus_1', subscription: 'sub_1', value: 169, billingType: 'PIX',
  dueDate: '2026-11-20', paymentDate: '2026-11-20', status: 'RECEIVED',
  invoiceUrl: 'https://www.asaas.com/i/1', ...extra,
});

function evento(db, enviar, event, payment, extra = {}) {
  return C.aoEventoDaAssinatura({
    db, enviar, asaas: jest.fn().mockRejectedValue(new Error('sem asaas no teste')),
    event, payment, company: { id: EMP }, now: AGORA, env: ENV, ...extra,
  });
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('recibo (2.7)', () => {
  test('CONFIRMED + RECEIVED + reenvio da mesma cobrança: um e-mail só', async () => {
    const db = banco();
    const { enviar, enviados } = criarEnvio();
    await evento(db, enviar, 'PAYMENT_CONFIRMED', pagamento({ status: 'CONFIRMED' }), { nextDue: '2026-12-20' });
    await evento(db, enviar, 'PAYMENT_RECEIVED', pagamento());
    await evento(db, enviar, 'PAYMENT_RECEIVED', pagamento());
    expect(enviados).toHaveLength(1);
    expect(enviados[0].to).toBe('maria@exemplo.com');
    expect(enviados[0].subject).toBe('Recebi seu pagamento, obrigado!');
    expect(enviados[0].text).toContain('Próximo vencimento: 20/12/2026');
    expect(db.emailLog).toHaveLength(1);
    expect(db.emailLog[0]).toMatchObject({ chave_idempotencia: 'pagamento-confirmado:pay_1', status: 'sent', company_id: EMP });
    expect(db.cobrancas[0].status).toBe('PAID');
  });

  test.each([
    ['conta interna (is_staff)', {}, { is_staff: true }],
    ['e-mail @getaura.com.br', {}, { email: 'caio@getaura.com.br' }],
    ['empresa sandbox', { is_sandbox: true }, {}],
    ['empresa inativa', { is_active: false }, {}],
    ['dojô do Karatê', { vertical: 'karate_dojo' }, {}],
    ['federação do Karatê', { vertical: 'karate_federation' }, {}],
  ])('%s: não recebe', async (_n, empresa, usuario) => {
    const db = banco(empresa, usuario);
    const { enviar, enviados } = criarEnvio();
    const r = await evento(db, enviar, 'PAYMENT_RECEIVED', pagamento());
    expect(enviados).toHaveLength(0);
    expect(r.email).toBe('fora');
  });

  test('pagamento antigo (evento atrasado/reenviado de semanas atrás): sem recibo', async () => {
    const db = banco();
    const { enviar, enviados } = criarEnvio();
    await evento(db, enviar, 'PAYMENT_RECEIVED', pagamento({ paymentDate: '2026-10-20', dueDate: '2026-10-20' }));
    expect(enviados).toHaveLength(0);
    expect(db.cobrancas[0].status).toBe('PAID'); // o espelho registra mesmo assim
  });

  test('sem dono com e-mail, vai ao e-mail da empresa', async () => {
    const db = banco({}, { email: null });
    const { enviar, enviados } = criarEnvio();
    await evento(db, enviar, 'PAYMENT_RECEIVED', pagamento());
    expect(enviados[0].to).toBe('loja@maria.com.br');
  });

  test('EMAILS_COBRANCA_ENABLED=false ou EMAILS_CICLO_ENABLED=false: espelho sim, e-mail não', async () => {
    for (const env of [{ EMAILS_COBRANCA_ENABLED: 'false' }, { EMAILS_CICLO_ENABLED: '0' }]) {
      const db = banco();
      const { enviar, enviados } = criarEnvio();
      await evento(db, enviar, 'PAYMENT_RECEIVED', pagamento(), { env });
      expect(enviados).toHaveLength(0);
      expect(db.cobrancas).toHaveLength(1);
    }
  });
});

describe('estorno e contestação', () => {
  test('um e-mail cada, mesmo com reenvio', async () => {
    const db = banco();
    const { enviar, enviados } = criarEnvio();
    await evento(db, enviar, 'PAYMENT_REFUNDED', pagamento({ status: 'REFUNDED', paymentDate: '2026-11-01' }));
    await evento(db, enviar, 'PAYMENT_REFUNDED', pagamento({ status: 'REFUNDED', paymentDate: '2026-11-01' }));
    await evento(db, enviar, 'PAYMENT_CHARGEBACK_REQUESTED', pagamento({ id: 'pay_2', status: 'CHARGEBACK_REQUESTED' }));
    expect(enviados.map((e) => e.subject)).toEqual([
      'Estorno da mensalidade da Aura',
      'Recebi um aviso de contestação da mensalidade da Aura',
    ]);
  });

  test('cobrança estornada não volta a PAID com RECEIVED reenviado depois', async () => {
    const db = banco();
    const { enviar } = criarEnvio();
    await evento(db, enviar, 'PAYMENT_REFUNDED', pagamento({ status: 'REFUNDED' }));
    await evento(db, enviar, 'PAYMENT_RECEIVED', pagamento());
    expect(db.cobrancas[0].status).toBe('REFUNDED');
  });
});

describe('cartão recusado (tq-84)', () => {
  const recusa = (extra = {}) => pagamento({
    status: 'PENDING', paymentDate: null, billingType: 'CREDIT_CARD',
    creditCard: { creditCardNumber: '4821', creditCardBrand: 'VISA', creditCardToken: 'tok' }, ...extra,
  });

  test('primeira recusa: 2.8 (sem prometer nova tentativa com a flag desligada); repetição: nada', async () => {
    const db = banco();
    const { enviar, enviados } = criarEnvio();
    await evento(db, enviar, 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', recusa());
    await evento(db, enviar, 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', recusa());
    expect(enviados).toHaveLength(1);
    expect(enviados[0].subject).toBe('O cartão não passou na mensalidade da Aura');
    expect(enviados[0].text).toContain('no cartão final 4821');
    expect(enviados[0].text).not.toMatch(/tentar de novo amanhã/);
    expect(db.cobrancas[0].cartao_recusado_em).toBeTruthy();
    expect(db.cobrancas[0].status).toBe('PENDING');
  });

  test('com ASAAS_RETENTATIVA_CARTAO_ENABLED, o 2.8 promete a nova tentativa', async () => {
    const db = banco();
    const { enviar, enviados } = criarEnvio();
    await evento(db, enviar, 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', recusa(), { env: { ASAAS_RETENTATIVA_CARTAO_ENABLED: 'true' } });
    expect(enviados[0].text).toContain('Vou tentar de novo amanhã, uma única vez.');
  });

  test('recusa depois da nova tentativa da Aura: 2.8b, uma vez', async () => {
    const db = banco();
    const { enviar, enviados } = criarEnvio();
    await evento(db, enviar, 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', recusa());
    db.cobrancas[0].retentativa_em = new Date();
    await evento(db, enviar, 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', recusa());
    await evento(db, enviar, 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', recusa());
    expect(enviados.map((e) => e.subject)).toEqual([
      'O cartão não passou na mensalidade da Aura',
      'O cartão não passou de novo na mensalidade da Aura',
    ]);
  });
});

describe('espelho e datas do atraso (tq-86)', () => {
  test('OVERDUE grava a cobrança; CREATED de outra entra como PENDING', async () => {
    const db = banco();
    const { enviar, enviados } = criarEnvio();
    await evento(db, enviar, 'PAYMENT_OVERDUE', pagamento({ id: 'pay_v', status: 'OVERDUE', paymentDate: null, dueDate: '2026-10-20' }));
    await evento(db, enviar, 'PAYMENT_CREATED', pagamento({ id: 'pay_n', status: 'PENDING', paymentDate: null, dueDate: '2026-11-20' }));
    expect(enviados).toHaveLength(0); // atraso e lembrete saem pelo job, não pelo webhook
    expect(db.cobrancas.map((c) => [c.asaas_payment_id, c.status])).toEqual([['pay_v', 'OVERDUE'], ['pay_n', 'PENDING']]);
  });

  test('datasDaPausa: +7 telas, +14 Caixa', () => {
    expect(C.datasDaPausa('2026-10-20')).toEqual({
      billing_overdue_since: '2026-10-20',
      billing_pause_screens_on: '2026-10-27',
      billing_pause_caixa_on: '2026-11-03',
    });
    expect(C.datasDaPausa(null)).toEqual({ billing_overdue_since: null, billing_pause_screens_on: null, billing_pause_caixa_on: null });
  });

  test('datasDoAtraso: vencimento OVERDUE mais antigo; fora de overdue tudo null sem consultar', async () => {
    const db = banco({ billing_status: 'overdue' });
    db.cobrancas.push(
      { asaas_payment_id: 'p1', company_id: EMP, status: 'OVERDUE', due_date: '2026-10-20' },
      { asaas_payment_id: 'p2', company_id: EMP, status: 'OVERDUE', due_date: '2026-09-20' },
      { asaas_payment_id: 'p3', company_id: EMP, status: 'PAID', due_date: '2026-08-20' },
    );
    expect(await C.datasDoAtraso({ db, companyId: EMP, billingStatus: 'overdue', now: AGORA })).toMatchObject({
      billing_overdue_since: '2026-09-20', billing_pause_screens_on: '2026-09-27', billing_pause_caixa_on: '2026-10-04',
    });
    const antes = db.query.mock.calls.length;
    expect((await C.datasDoAtraso({ db, companyId: EMP, billingStatus: 'active', now: AGORA })).billing_overdue_since).toBeNull();
    expect(db.query.mock.calls.length).toBe(antes);
  });

  test('filial herda as datas da matriz (billing_owner_company_id)', async () => {
    const FILIAL = 'aaaaaaaa-0000-4000-8000-000000000002';
    const db = banco({ billing_status: 'overdue' });
    db.empresas.push({ id: FILIAL, owner_id: DONO, billing_owner_company_id: EMP, billing_status: 'overdue' });
    db.cobrancas.push({ asaas_payment_id: 'p1', company_id: EMP, status: 'OVERDUE', due_date: '2026-10-20' });
    expect((await C.datasDoAtraso({ db, companyId: FILIAL, billingStatus: 'overdue', now: AGORA })).billing_overdue_since).toBe('2026-10-20');
  });

  test('sem linha no espelho: usa next_billing_date da pagadora se já passou', async () => {
    const db = banco({ billing_status: 'overdue', next_billing_date: '2026-10-20' });
    expect((await C.datasDoAtraso({ db, companyId: EMP, billingStatus: 'overdue', now: AGORA })).billing_overdue_since).toBe('2026-10-20');
    const db2 = banco({ billing_status: 'overdue', next_billing_date: '2026-12-20' });
    expect((await C.datasDoAtraso({ db: db2, companyId: EMP, billingStatus: 'overdue', now: AGORA })).billing_overdue_since).toBeNull();
  });

  test('erro no banco: tudo null, nunca lança', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('caiu')) };
    expect(await C.datasDoAtraso({ db, companyId: EMP, billingStatus: 'overdue' })).toEqual(C.datasDaPausa(null));
  });
});

describe('email_log (tq-74)', () => {
  const base = { chave: 'k:1', tipo: 't', to: 'a@b.com', subject: 's', html: 'h', text: 't' };

  test('reserva antes de enviar; segunda chamada com a mesma chave não envia', async () => {
    const db = banco();
    const { enviar, enviados } = criarEnvio();
    expect((await enviarEmailRegistrado({ db, enviar, ...base })).status).toBe('sent');
    expect((await enviarEmailRegistrado({ db, enviar, ...base })).status).toBe('duplicate');
    expect(enviados).toHaveLength(1);
    expect(enviados[0]._registrado).toBe(true); // o sendMail não grava de novo
    expect(db.emailLog[0]).toMatchObject({ status: 'sent', resend_id: 're_1' });
  });

  test('falha do provedor vira failed e pode ser tentada de novo (até 3)', async () => {
    const db = banco();
    const enviar = jest.fn().mockRejectedValue(new Error('Resend API 500'));
    expect((await enviarEmailRegistrado({ db, enviar, ...base })).status).toBe('failed');
    expect(db.emailLog[0]).toMatchObject({ status: 'failed', erro: 'Resend API 500' });
    await enviarEmailRegistrado({ db, enviar, ...base });
    await enviarEmailRegistrado({ db, enviar, ...base });
    expect((await enviarEmailRegistrado({ db, enviar, ...base })).status).toBe('duplicate');
    expect(enviar).toHaveBeenCalledTimes(3);
  });

  test('sem a tabela (migration 407 pendente): não envia', async () => {
    const db = { query: jest.fn().mockRejectedValue(Object.assign(new Error('relation "email_log" does not exist'), { code: '42P01' })) };
    const { enviar } = criarEnvio();
    expect((await enviarEmailRegistrado({ db, enviar, ...base })).status).toBe('sem_registro');
    expect(enviar).not.toHaveBeenCalled();
  });
});
