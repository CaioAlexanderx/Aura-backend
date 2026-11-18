// ============================================================
// AURA. — Exceção do Karatê nos e-mails de cobrança (18/11/2026)
//
// Decisão do Caio: a empresa do Karatê que paga a assinatura recebe SÓ três
// e-mails (recibo, lembrete de 2 dias e "vence hoje"), e só com a exceção
// ligada pela equipe: linha em company_notification_prefs com
// event_type = 'cobranca_karate' e enabled = true.
//
//   - Karatê sem a linha (ou com a linha desligada): nada sai, como antes
//   - Karatê com a linha: os três saem; atraso 1/3/7, pausa do Caixa,
//     estorno, contestação, cartão recusado (2.8 e 2.8b), nova data e
//     assinatura cancelada NÃO saem
//   - os outros filtros (inativa, sandbox, is_staff) continuam valendo
//   - loja comum: nenhuma consulta nova
//   - o lojista (tela de preferências e descadastro público) não liga a
//     exceção
// ============================================================
'use strict';

const { criarBanco, criarEnvio } = require('./helpers/bancoDaCobranca');
const C = require('../src/services/cobrancaAssinatura');
const R = require('../src/services/reguaDeCobranca');
const P = require('../src/services/emailPreferencias');
const lojaEvents = require('../src/services/lojaEvents');

const EMP = 'aaaaaaaa-0000-4000-8000-000000000001';
const OUTRA = 'aaaaaaaa-0000-4000-8000-000000000002';
const DONO = 'bbbbbbbb-0000-4000-8000-000000000001';
const ENV = {};
const AGORA = Date.parse('2026-11-20T15:00:00Z'); // 12h em São Paulo
const as930 = (iso) => Date.parse(iso + 'T12:30:00Z');

const EXCECAO = { company_id: EMP, event_type: 'cobranca_karate', enabled: true };
const FEDERACAO = { vertical: 'karate_federation' };

function banco({ empresa = FEDERACAO, usuario = {}, cobrancas = [], prefs = [] } = {}) {
  return criarBanco({
    empresas: [{ id: EMP, owner_id: DONO, trade_name: 'Federação Teste', email: 'contato@federacao.test', asaas_customer_id: 'cus_1', ...empresa }],
    usuarios: [{ id: DONO, email: 'presidente@federacao.test', full_name: 'Ana Lima', ...usuario }],
    cobrancas,
    notificationPrefs: prefs,
  });
}

const consultouExcecao = (db) => db.consultas.some((s) => s.includes('company_notification_prefs'));

// ── Webhook ─────────────────────────────────────────────────────
const pagamento = (extra = {}) => ({
  id: 'pay_1', customer: 'cus_1', subscription: 'sub_1', value: 149, netValue: 140.5, billingType: 'PIX',
  dueDate: '2026-11-20', paymentDate: '2026-11-20', status: 'RECEIVED',
  invoiceUrl: 'https://www.asaas.com/i/1', ...extra,
});

function evento(db, enviar, event, payment, extra = {}) {
  return C.aoEventoDaAssinatura({
    db, enviar, asaas: jest.fn().mockRejectedValue(new Error('sem asaas no teste')),
    event, payment, company: { id: EMP }, now: AGORA, env: ENV, ...extra,
  });
}

// ── Régua ───────────────────────────────────────────────────────
const cobranca = (extra) => ({
  asaas_payment_id: 'pay_1', company_id: EMP, status: 'PENDING', due_date: '2026-11-20',
  valor: 149, billing_type: 'PIX', invoice_url: 'https://www.asaas.com/i/1', ...extra,
});
const pg = (extra) => ({ id: 'pay_1', customer: 'cus_1', status: 'PENDING', value: 149, netValue: 140.5, billingType: 'PIX', dueDate: '2026-11-20', invoiceUrl: 'https://www.asaas.com/i/1', ...extra });

function asaasCom({ pagamentos = {}, pagar } = {}) {
  return jest.fn(async (metodo, caminho) => {
    if (metodo === 'GET' && caminho.startsWith('/payments?')) return { data: [], hasMore: false };
    if (/\/pixQrCode$/.test(caminho)) return { payload: 'PIXCOPIAECOLA' };
    let m = /^\/payments\/([^/]+)\/payWithCreditCard$/.exec(caminho);
    if (m) return pagar(m[1]);
    m = /^\/payments\/([^/?]+)$/.exec(caminho);
    if (m && pagamentos[m[1]]) return pagamentos[m[1]];
    throw new Error('caminho inesperado ' + caminho);
  });
}

function notificacoes() {
  const avisos = [];
  return { avisos, notifyCompany: jest.fn(async (cid, payload) => { avisos.push({ cid, ...payload }); return { id: 'n' }; }) };
}

async function rodar(db, asaas, dia) {
  const { enviar, enviados } = criarEnvio();
  const notifications = notificacoes();
  await R.tickDiarioDaRegua({ db, asaas, notifications, enviar, now: as930(dia), env: ENV });
  return { enviados, notifications };
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('recibo do Karatê (webhook)', () => {
  test.each([
    ['federação', { vertical: 'karate_federation' }],
    ['dojô', { vertical: 'karate_dojo' }],
    ['vertical_active do Karatê', { vertical: null, vertical_active: 'karate_federation' }],
  ])('%s sem a exceção: nada sai (como antes)', async (_n, empresa) => {
    const db = banco({ empresa });
    const { enviar, enviados } = criarEnvio();
    const r = await evento(db, enviar, 'PAYMENT_RECEIVED', pagamento());
    expect(enviados).toHaveLength(0);
    expect(r.email).toBe('fora');
  });

  test('exceção desligada (enabled = false) ou de outra empresa: nada sai', async () => {
    for (const prefs of [[{ ...EXCECAO, enabled: false }], [{ ...EXCECAO, company_id: OUTRA }], [{ ...EXCECAO, event_type: 'loja_pedido_pago' }]]) {
      const db = banco({ prefs });
      const { enviar, enviados } = criarEnvio();
      await evento(db, enviar, 'PAYMENT_RECEIVED', pagamento());
      expect(enviados).toHaveLength(0);
    }
  });

  test('com a exceção: o recibo sai, uma vez, com o valor da cobrança (nunca netValue)', async () => {
    const db = banco({ prefs: [EXCECAO] });
    const { enviar, enviados } = criarEnvio();
    await evento(db, enviar, 'PAYMENT_CONFIRMED', pagamento({ status: 'CONFIRMED' }), { nextDue: '2026-12-20' });
    await evento(db, enviar, 'PAYMENT_RECEIVED', pagamento());
    expect(enviados).toHaveLength(1);
    expect(enviados[0].to).toBe('presidente@federacao.test');
    expect(enviados[0].subject).toBe('Recebi seu pagamento, obrigado!');
    expect(enviados[0].text).toContain('149,00');
    expect(enviados[0].text).not.toContain('140,50');
    expect(db.emailLog[0]).toMatchObject({ tipo: 'cobranca_pagamento_confirmado', chave_idempotencia: 'pagamento-confirmado:pay_1' });
  });

  test('com a exceção: estorno, contestação e cartão recusado NÃO saem, sem consulta a mais', async () => {
    const db = banco({ prefs: [EXCECAO] });
    const { enviar, enviados } = criarEnvio();
    await evento(db, enviar, 'PAYMENT_REFUNDED', pagamento({ status: 'REFUNDED' }));
    await evento(db, enviar, 'PAYMENT_CHARGEBACK_REQUESTED', pagamento({ id: 'pay_2', status: 'CHARGEBACK_REQUESTED' }));
    const recusa = pagamento({
      id: 'pay_3', status: 'PENDING', paymentDate: null, billingType: 'CREDIT_CARD',
      creditCard: { creditCardNumber: '4821', creditCardToken: 'tok' },
    });
    const r = await evento(db, enviar, 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', recusa);
    db.cobrancas.find((c) => c.asaas_payment_id === 'pay_3').retentativa_em = new Date();
    await evento(db, enviar, 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED', recusa); // seria o 2.8b
    expect(enviados).toHaveLength(0);
    expect(r.email).toBe('fora');
    expect(consultouExcecao(db)).toBe(false);
  });

  test.each([
    ['conta interna (is_staff)', {}, { is_staff: true }],
    ['sandbox', { is_sandbox: true }, {}],
    ['inativa', { is_active: false }, {}],
  ])('com a exceção, %s continua fora', async (_n, empresa, usuario) => {
    const db = banco({ empresa: { ...FEDERACAO, ...empresa }, usuario, prefs: [EXCECAO] });
    const { enviar, enviados } = criarEnvio();
    await evento(db, enviar, 'PAYMENT_RECEIVED', pagamento());
    expect(enviados).toHaveLength(0);
  });

  test('loja comum: recebe como sempre e não consulta a exceção', async () => {
    const db = banco({ empresa: { vertical: null } });
    const { enviar, enviados } = criarEnvio();
    await evento(db, enviar, 'PAYMENT_RECEIVED', pagamento());
    expect(enviados).toHaveLength(1);
    expect(consultouExcecao(db)).toBe(false);
  });
});

describe('destinatarioDaEmpresa por tipo', () => {
  const FORA = [
    undefined, null, 'cobranca_atraso_1', 'cobranca_atraso_3', 'cobranca_atraso_7',
    'cobranca_caixa_pausa_em_3', 'cobranca_caixa_pausado', 'cobranca_estorno', 'cobranca_contestacao',
    'cobranca_cartao_recusado', 'cobranca_cartao_recusado_2', 'cobranca_nova_data',
    'cobranca_assinatura_cancelada', 'cobranca_karate',
  ];

  test.each(FORA)('Karatê com a exceção, tipo %s: null', async (tipo) => {
    const db = banco({ prefs: [EXCECAO] });
    expect(await C.destinatarioDaEmpresa(db, EMP, { tipo })).toBeNull();
  });

  test('sem opções (chamada antiga): Karatê fica fora mesmo com a exceção', async () => {
    const db = banco({ prefs: [EXCECAO] });
    expect(await C.destinatarioDaEmpresa(db, EMP)).toBeNull();
  });

  test.each(C.TIPOS_DO_KARATE)('Karatê com a exceção, tipo %s: o dono', async (tipo) => {
    const db = banco({ prefs: [EXCECAO] });
    expect(await C.destinatarioDaEmpresa(db, EMP, { tipo })).toMatchObject({ companyId: EMP, email: 'presidente@federacao.test' });
  });

  test('são exatamente os três tipos pedidos', () => {
    expect([...C.TIPOS_DO_KARATE].sort()).toEqual(['cobranca_lembrete_2_dias', 'cobranca_pagamento_confirmado', 'cobranca_vence_hoje']);
  });

  test('sem a tabela (42P01) ou com falha na leitura: fora', async () => {
    for (const erro of [Object.assign(new Error('relation does not exist'), { code: '42P01' }), new Error('timeout')]) {
      const db = banco({ prefs: [EXCECAO] });
      const original = db.query.getMockImplementation();
      db.query.mockImplementation(async (sql, p) => {
        if (String(sql).includes('company_notification_prefs')) throw erro;
        return original(sql, p);
      });
      expect(await C.destinatarioDaEmpresa(db, EMP, { tipo: 'cobranca_vence_hoje' })).toBeNull();
    }
  });

  test('nova data combinada (2.6): Karatê com a exceção fica fora', async () => {
    const db = banco({ prefs: [EXCECAO] });
    const asaas = jest.fn(async (_m, caminho) => (/pixQrCode$/.test(caminho)
      ? { payload: 'PIX' }
      : { id: 'pay_1', status: 'PENDING', value: 149, dueDate: '2026-11-25' }));
    const { enviar, enviados } = criarEnvio();
    const r = await C.enviarNovaDataCombinada({ db, asaas, enviar, companyId: EMP, paymentId: 'pay_1', novaData: '2026-11-25', now: AGORA, env: ENV });
    expect(r.status).toBe('fora');
    expect(enviados).toHaveLength(0);
  });
});

describe('régua do Karatê', () => {
  test('sem a exceção: nem o lembrete de 2 dias nem o "vence hoje"', async () => {
    for (const dia of ['2026-11-18', '2026-11-20']) {
      const db = banco({ cobrancas: [cobranca()] });
      expect((await rodar(db, asaasCom({ pagamentos: { pay_1: pg() } }), dia)).enviados).toHaveLength(0);
    }
  });

  test('com a exceção: lembrete de 2 dias e "vence hoje", com o valor relido na Asaas', async () => {
    const db = banco({ cobrancas: [cobranca()], prefs: [EXCECAO] });
    const asaas = asaasCom({ pagamentos: { pay_1: pg() } });
    const a = await rodar(db, asaas, '2026-11-18');
    const b = await rodar(db, asaas, '2026-11-20');
    expect(a.enviados.map((e) => e.subject)).toEqual(['Sua mensalidade da Aura vence sexta-feira']);
    expect(b.enviados.map((e) => e.subject)).toEqual(['Hoje vence a mensalidade da Aura']);
    expect(a.enviados[0].text).toContain('149,00');
    expect(a.enviados[0].text).not.toContain('140,50');
    expect(db.emailLog.map((l) => l.tipo)).toEqual(['cobranca_lembrete_2_dias', 'cobranca_vence_hoje']);
  });

  test.each(['2026-10-21', '2026-10-23', '2026-10-27', '2026-10-31', '2026-11-03'])(
    'com a exceção, atraso/pausa em %s: nada sai, nem o aviso interno, sem consulta a mais',
    async (dia) => {
      const db = banco({
        empresa: { ...FEDERACAO, billing_status: 'overdue' },
        cobrancas: [cobranca({ status: 'OVERDUE', due_date: '2026-10-20' })],
        prefs: [EXCECAO],
      });
      const { enviados, notifications } = await rodar(db, asaasCom({ pagamentos: { pay_1: pg({ status: 'OVERDUE', dueDate: '2026-10-20' }) } }), dia);
      expect(enviados).toHaveLength(0);
      expect(notifications.avisos).toHaveLength(0);
      expect(consultouExcecao(db)).toBe(false);
    }
  );

  test('com a exceção, nova tentativa do cartão recusada: o 2.8b não sai', async () => {
    const agora = Date.parse('2026-11-21T15:00:00Z');
    const db = banco({
      cobrancas: [cobranca({ billing_type: 'CREDIT_CARD', cartao_final: '4821', cartao_recusado_em: new Date(agora - 25 * 3600000) })],
      prefs: [EXCECAO],
    });
    const pagar = jest.fn(async () => { throw new Error('recusado'); });
    const asaas = asaasCom({ pagamentos: { pay_1: pg({ billingType: 'CREDIT_CARD', creditCard: { creditCardNumber: '4821', creditCardToken: 'tok_1' } }) }, pagar });
    const { enviar, enviados } = criarEnvio();
    await R.tickRetentativas({ db, asaas, enviar, now: agora, env: { ASAAS_RETENTATIVA_CARTAO_ENABLED: 'true' } });
    expect(pagar).toHaveBeenCalledTimes(1);
    expect(enviados).toHaveLength(0);
  });

  test('loja comum: lembrete sai sem consultar a exceção', async () => {
    const db = banco({ empresa: { vertical: null }, cobrancas: [cobranca()] });
    const { enviados } = await rodar(db, asaasCom({ pagamentos: { pay_1: pg() } }), '2026-11-18');
    expect(enviados).toHaveLength(1);
    expect(consultouExcecao(db)).toBe(false);
  });
});

describe('o lojista não liga a exceção', () => {
  test('tela de E-mails (company_email_prefs): tipo desconhecido', () => {
    expect(P.tipoValido(C.EXCECAO_KARATE)).toBe(false);
    expect(P.validarMudancas({ [C.EXCECAO_KARATE]: { ligado: true } }, new Set())).toMatchObject({ ok: false, codigo: 'TIPO_DESCONHECIDO' });
  });

  test('preferências de notificação (company_notification_prefs): fora da taxonomia', () => {
    expect(lojaEvents.isPrefKey(C.EXCECAO_KARATE)).toBe(false);
  });

  test('descadastro público: tipo desconhecido não grava nada', async () => {
    const db = { query: jest.fn() };
    expect(await P.desligarTipoDeEmail(db, EMP, C.EXCECAO_KARATE)).toEqual({ ok: false, desligadas: [], jaEstava: false });
    expect(db.query).not.toHaveBeenCalled();
  });
});
