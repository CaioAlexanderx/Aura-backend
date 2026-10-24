// ============================================================
// AURA. — Assinaturas da Asaas (tq-73, tq-79, tq-82a — 24/10/2026)
//
//   - webhook SUBSCRIPTION_*: grava em webhook_logs e no espelho, NUNCA
//     muda companies (nem billing_status, nem asaas_subscription_id);
//     reenvio do mesmo evento não grava de novo; sem segredo relê a Asaas e,
//     se a leitura falhar, não grava nada; sem empresa, só o espelho
//   - aviso de assinatura cancelada: flag padrão desligada; troca de plano e
//     Pix Automático (ações da Aura) não avisam; assinatura que não era a
//     atual não avisa; outra assinatura ativa na Asaas não avisa; Asaas fora
//     do ar adia; conta interna fica fora; avisa uma vez
//   - 2.6: valor exato da cobrança relida; sem leitura, com juros ou sem a
//     data nova, não envia
// ============================================================
'use strict';

jest.unmock('../src/services/assinaturasAsaas');

const express = require('express');
const request = require('supertest');

const SECRET = 'segredo-de-teste-asaas-abc123';
const EMP = 'aaaaaaaa-0000-4000-8000-000000000001';
const limpo = (s) => String(s).replace(/\s+/g, ' ').trim();

function buildApp({ secret = SECRET } = {}) {
  jest.resetModules();
  if (secret === null) delete process.env.ASAAS_WEBHOOK_SECRET;
  else process.env.ASAAS_WEBHOOK_SECRET = secret;
  jest.doMock('../src/config/database');
  jest.doMock('../src/services/asaasClient', () => ({ asaas: jest.fn() }));
  jest.doMock('../src/services/digitalOrderNotifications', () => ({ notifyPaymentConfirmed: jest.fn() }));
  const db = require('../src/config/database');
  const { asaas } = require('../src/services/asaasClient');
  const app = express();
  app.use(express.json());
  app.use('/webhooks/asaas', require('../src/routes/webhookAsaas'));
  return { app, db, asaas };
}

function ligarBanco(db, { empresa = { id: EMP, asaas_subscription_id: 'sub_1' }, jaRegistrado = false } = {}) {
  db.query.mockImplementation(async (sql) => {
    const s = limpo(sql);
    if (s.startsWith("SELECT 1 FROM webhook_logs WHERE provider = 'asaas' AND event LIKE")) {
      return { rows: jaRegistrado ? [{ '?column?': 1 }] : [] };
    }
    if (s.startsWith('SELECT id, asaas_subscription_id FROM companies')) return { rows: empresa ? [empresa] : [] };
    if (s.startsWith('INSERT INTO assinaturas_asaas')) return { rows: [{ asaas_subscription_id: 'sub_1' }] };
    return { rows: [], rowCount: 1 };
  });
  const achar = (re) => db.query.mock.calls.filter(([sql]) => re.test(limpo(sql)));
  return { achar };
}

const evento = (event, sub = {}, extra = {}) => ({
  id: 'evt_' + event.toLowerCase() + '_1', event, dateCreated: '2026-10-24 10:00:00',
  subscription: { object: 'subscription', id: 'sub_1', customer: 'cus_1', value: 169, nextDueDate: '2026-11-20',
    cycle: 'MONTHLY', billingType: 'PIX', deleted: false, status: 'ACTIVE', externalReference: EMP, ...sub },
  ...extra,
});
const enviar = (app, body, comToken = true) => {
  const r = request(app).post('/webhooks/asaas');
  return (comToken ? r.set('asaas-access-token', SECRET) : r).send(body);
};

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.ASAAS_WEBHOOK_SECRET;
});

describe('webhook SUBSCRIPTION_* (tq-73)', () => {
  test.each(['SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED'])('%s: registra e espelha, NÃO toca em companies', async (ev) => {
    const { app, db } = buildApp();
    const { achar } = ligarBanco(db);
    const r = await enviar(app, evento(ev, ev === 'SUBSCRIPTION_DELETED' ? { deleted: true } : { status: 'INACTIVE' }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ handled: true, subscription_event: ev, status_changed: false, encerrada: true, company_found: true });
    expect(achar(/^UPDATE companies/)).toHaveLength(0);
    const espelho = achar(/^INSERT INTO assinaturas_asaas/);
    expect(espelho).toHaveLength(1);
    const p = espelho[0][1];
    expect(p[0]).toBe('sub_1');
    expect(p[3]).toBe(ev === 'SUBSCRIPTION_DELETED' ? 'DELETED' : 'INACTIVE');
    expect(p[11]).toBe(true);  // encerrou
    expect(p[12]).toBe(true);  // era a atual da empresa
    const logs = achar(/^INSERT INTO webhook_logs/);
    expect(logs).toHaveLength(1);
    expect(logs[0][1][1]).toBe(ev);
    expect(JSON.parse(logs[0][1][2])).toMatchObject({ dedupe_key: `evt:evt_${ev.toLowerCase()}_1`, subscription: { id: 'sub_1' } });
  });

  test('CREATED e UPDATED: registram sem encerrar', async () => {
    for (const ev of ['SUBSCRIPTION_CREATED', 'SUBSCRIPTION_UPDATED']) {
      const { app, db } = buildApp();
      const { achar } = ligarBanco(db);
      const r = await enviar(app, evento(ev));
      expect(r.body).toMatchObject({ handled: true, encerrada: false });
      expect(achar(/^INSERT INTO assinaturas_asaas/)[0][1][11]).toBe(false);
      expect(achar(/^UPDATE companies/)).toHaveLength(0);
    }
  });

  test('reenvio do mesmo evento: não grava de novo', async () => {
    const { app, db } = buildApp();
    const { achar } = ligarBanco(db, { jaRegistrado: true });
    const r = await enviar(app, evento('SUBSCRIPTION_DELETED', { deleted: true }));
    expect(r.body).toMatchObject({ duplicate: true });
    expect(achar(/^INSERT INTO/)).toHaveLength(0);
  });

  test('sem o id do evento, a chave é evento + assinatura + data', async () => {
    const A = require('../src/services/assinaturasAsaas');
    expect(A.chaveDoEvento({ event: 'SUBSCRIPTION_UPDATED', dateCreated: '2026-10-24 10:00:00' }, { id: 'sub_9' }))
      .toBe('SUBSCRIPTION_UPDATED:sub_9:2026-10-24 10:00:00');
  });

  test('sem empresa: só o espelho, nada em webhook_logs (a lista de pagamentos sem loja não ganha assinatura)', async () => {
    const { app, db } = buildApp();
    const { achar } = ligarBanco(db, { empresa: null });
    const r = await enviar(app, evento('SUBSCRIPTION_CREATED', { externalReference: null }));
    expect(r.body).toMatchObject({ handled: true, company_found: false });
    expect(achar(/^INSERT INTO assinaturas_asaas/)).toHaveLength(1);
    expect(achar(/^INSERT INTO webhook_logs/)).toHaveLength(0);
  });

  test('token inválido: 401, nada gravado', async () => {
    const { app, db } = buildApp();
    ligarBanco(db);
    const r = await request(app).post('/webhooks/asaas').set('asaas-access-token', 'errado-errado-errado-errado-x').send(evento('SUBSCRIPTION_DELETED'));
    expect(r.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('sem segredo: relê a assinatura na Asaas e grava só o que ela devolve', async () => {
    const { app, db, asaas } = buildApp({ secret: null });
    const { achar } = ligarBanco(db);
    asaas.mockResolvedValue({ id: 'sub_1', customer: 'cus_1', status: 'ACTIVE', deleted: false, value: 169 });
    // O corpo diz "apagada"; a Asaas diz que está ativa: não encerra.
    const r = await enviar(app, evento('SUBSCRIPTION_DELETED', { deleted: true }), false);
    expect(asaas).toHaveBeenCalledWith('GET', '/subscriptions/sub_1');
    expect(r.body).toMatchObject({ handled: true, encerrada: false });
    expect(achar(/^INSERT INTO assinaturas_asaas/)[0][1][3]).toBe('ACTIVE');
    expect(achar(/^UPDATE companies/)).toHaveLength(0);
  });

  test('sem segredo e sem releitura: evento ignorado, zero gravação', async () => {
    const { app, db, asaas } = buildApp({ secret: null });
    ligarBanco(db);
    asaas.mockRejectedValue(new Error('Asaas error 404'));
    const r = await enviar(app, evento('SUBSCRIPTION_DELETED', { deleted: true }), false);
    expect(r.body).toMatchObject({ handled: false, reason: 'no_secret_reverification_failed' });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('PAYMENT_* segue pelo caminho de antes (não passa pelo serviço de assinatura)', async () => {
    const { app, db } = buildApp();
    ligarBanco(db, { empresa: null });
    const r = await enviar(app, { event: 'PAYMENT_CREATED', payment: { id: 'pay_1', customer: 'cus_x', status: 'PENDING' } });
    expect(r.body).toMatchObject({ company_found: false, logged: false });
  });
});

describe('marcarEncerramentoPedido', () => {
  const A = require('../src/services/assinaturasAsaas');

  test('grava quem pediu, antes do DELETE; motivo desconhecido não grava', async () => {
    const db = { query: jest.fn(async () => ({ rows: [] })) };
    expect(await A.marcarEncerramentoPedido(db, 'sub_1', { companyId: EMP, motivo: 'troca_de_plano' })).toBe(true);
    expect(db.query.mock.calls[0][1]).toEqual(['sub_1', EMP, 'troca_de_plano']);
    expect(await A.marcarEncerramentoPedido(db, 'sub_1', { motivo: 'qualquer' })).toBe(false);
    expect(await A.marcarEncerramentoPedido(db, null, { motivo: 'pix_automatico' })).toBe(false);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('nunca lança (sem a tabela, a troca de plano segue)', async () => {
    const db = { query: jest.fn(async () => { const e = new Error('no table'); e.code = '42P01'; throw e; }) };
    expect(await A.marcarEncerramentoPedido(db, 'sub_1', { motivo: 'cliente_no_app' })).toBe(false);
  });
});

describe('aviso de assinatura cancelada (tq-79)', () => {
  const A = require('../src/services/assinaturasAsaas');
  const AGORA = Date.parse('2026-10-24T15:00:00Z');
  const LIGADO = { EMAIL_ASSINATURA_CANCELADA_ENABLED: 'true' };

  function cenario({ linha = {}, pixAuto = false, dono = {}, chaves = new Set() } = {}) {
    const decisoes = [];
    const l = {
      asaas_subscription_id: 'sub_1', company_id: EMP, encerrada_em: '2026-10-24T10:00:00Z',
      era_atual_no_encerramento: true, encerramento_pedido_por: null, evento_de_encerramento: 'SUBSCRIPTION_DELETED',
      assinatura_atual: 'sub_1', asaas_customer_id: 'cus_1', billing_status: 'active', vertical: 'negocio', vertical_active: null,
      ...linha,
    };
    const db = {
      query: jest.fn(async (sql, params) => {
        const s = limpo(sql);
        if (s.startsWith('SELECT a.asaas_subscription_id')) return { rows: [l] };
        if (s.startsWith('UPDATE assinaturas_asaas SET aviso_decidido_em')) { decisoes.push(params[1]); return { rowCount: 1 }; }
        if (s.startsWith('SELECT 1 FROM pix_automatico_autorizacoes')) return { rows: pixAuto ? [{}] : [] };
        if (s.includes('FROM companies c LEFT JOIN users u ON u.id = c.owner_id')) {
          return { rows: [{ id: EMP, loja: 'Modas da Maria', company_email: null, is_active: true, is_sandbox: false, vertical: 'negocio', user_id: 'u1', user_email: 'maria@exemplo.com', full_name: 'Maria Souza', is_staff: false, ...dono }] };
        }
        if (s.startsWith('INSERT INTO email_log')) {
          if (chaves.has(params[0])) return { rows: [] };
          chaves.add(params[0]);
          return { rows: [{ id: 'log1' }] };
        }
        if (s.startsWith('UPDATE email_log')) return { rowCount: 1 };
        throw new Error('SQL inesperado: ' + s.slice(0, 80));
      }),
    };
    return { db, decisoes, chaves };
  }

  const asaasCom = ({ sub = { id: 'sub_1', deleted: true, status: 'INACTIVE' }, outras = [] } = {}) => jest.fn(async (m, caminho) => {
    if (caminho === '/subscriptions/sub_1') { if (sub instanceof Error) throw sub; return sub; }
    if (caminho.startsWith('/subscriptions?customer=cus_1&status=ACTIVE')) { if (outras instanceof Error) throw outras; return { data: outras }; }
    throw new Error('caminho inesperado ' + caminho);
  });

  test('padrão DESLIGADO: nem consulta', async () => {
    const { db } = cenario();
    expect(await A.avisosDeCancelamento({ db, asaas: asaasCom(), env: {}, now: AGORA })).toEqual({ desligado: true });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('cancelada de verdade: avisa uma vez, com o Caixa no varejo', async () => {
    const chaves = new Set();
    const enviarMail = jest.fn(async () => ({ id: 're_1' }));
    let c = cenario({ chaves });
    expect(await A.avisosDeCancelamento({ db: c.db, asaas: asaasCom(), enviar: enviarMail, env: LIGADO, now: AGORA })).toEqual({ sent: 1 });
    expect(c.decisoes).toEqual(['enviado']);
    const m = enviarMail.mock.calls[0][0];
    expect(m.subject).toBe('A assinatura da Aura foi cancelada');
    expect(m.text).toContain('e o Caixa segue funcionando para você vender.');
    c = cenario({ chaves });
    expect(await A.avisosDeCancelamento({ db: c.db, asaas: asaasCom(), enviar: enviarMail, env: LIGADO, now: AGORA })).toEqual({ duplicate: 1 });
    expect(enviarMail).toHaveBeenCalledTimes(1);
    expect([...chaves]).toEqual(['assinatura-cancelada:sub_1']);
  });

  test.each([
    ['troca de plano (marca da Aura)', { linha: { encerramento_pedido_por: 'troca_de_plano' } }, 'pela_aura'],
    ['migração para o Pix Automático (marca)', { linha: { encerramento_pedido_por: 'pix_automatico' } }, 'pela_aura'],
    ['migração para o Pix Automático (assinatura antiga da autorização)', { pixAuto: true }, 'pela_aura'],
    ['a empresa já aponta para outra assinatura', { linha: { assinatura_atual: 'sub_2' } }, 'nao_era_a_atual'],
    ['coluna zerada sem ser o cliente no app', { linha: { assinatura_atual: null } }, 'nao_era_a_atual'],
    ['conta interna', { dono: { user_email: 'caio@getaura.com.br' } }, 'fora'],
  ])('%s: não avisa', async (_, opts, resultado) => {
    const { db, decisoes } = cenario(opts);
    const enviarMail = jest.fn();
    const asaas = asaasCom();
    const r = await A.avisosDeCancelamento({ db, asaas, enviar: enviarMail, env: LIGADO, now: AGORA });
    expect(r).toEqual({ [resultado]: 1 });
    expect(decisoes).toEqual([resultado]);
    expect(enviarMail).not.toHaveBeenCalled();
  });

  test('cliente cancelou no app (coluna zerada pelo /billing/cancel): avisa', async () => {
    const { db } = cenario({ linha: { assinatura_atual: null, encerramento_pedido_por: 'cliente_no_app', billing_status: 'cancelled' } });
    const enviarMail = jest.fn(async () => ({ id: 're_1' }));
    expect(await A.avisosDeCancelamento({ db, asaas: asaasCom(), enviar: enviarMail, env: LIGADO, now: AGORA })).toEqual({ sent: 1 });
    expect(enviarMail.mock.calls[0][0].text).toContain('o Caixa segue');
  });

  test('relendo a Asaas: outra assinatura ativa ou a mesma reativada não avisa', async () => {
    let c = cenario();
    expect(await A.avisosDeCancelamento({ db: c.db, asaas: asaasCom({ outras: [{ id: 'sub_2', status: 'ACTIVE' }] }), enviar: jest.fn(), env: LIGADO, now: AGORA }))
      .toEqual({ outra_ativa: 1 });
    c = cenario();
    expect(await A.avisosDeCancelamento({ db: c.db, asaas: asaasCom({ sub: { id: 'sub_1', deleted: false, status: 'ACTIVE' } }), enviar: jest.fn(), env: LIGADO, now: AGORA }))
      .toEqual({ ativa: 1 });
  });

  test('Asaas fora do ar: não decide, tenta na próxima volta', async () => {
    const { db, decisoes } = cenario();
    const err = new Error('timeout');
    const r = await A.avisosDeCancelamento({ db, asaas: asaasCom({ outras: err }), enviar: jest.fn(), env: LIGADO, now: AGORA });
    expect(r).toEqual({ asaas_indisponivel: 1 });
    expect(decisoes).toEqual([]);
  });

  test('assinatura removida de vez (404 no GET): segue para a lista do cliente e avisa', async () => {
    const e404 = Object.assign(new Error('Asaas error 404'), { asaasStatus: 404 });
    const { db } = cenario();
    const enviarMail = jest.fn(async () => ({ id: 're_1' }));
    expect(await A.avisosDeCancelamento({ db, asaas: asaasCom({ sub: e404 }), enviar: enviarMail, env: LIGADO, now: AGORA })).toEqual({ sent: 1 });
  });

  test('em atraso ou fora do varejo: sem a frase do Caixa', () => {
    expect(A.caixaSegue({ billing_status: 'overdue', vertical_active: null })).toBe(false);
    expect(A.caixaSegue({ billing_status: 'active', vertical_active: 'odonto' })).toBe(false);
    expect(A.caixaSegue({ billing_status: 'active', vertical_active: null })).toBe(true);
  });

  test('janela: 2 h de espera e nada com mais de 26 h', async () => {
    const { db } = cenario();
    await A.avisosDeCancelamento({ db, asaas: asaasCom(), enviar: jest.fn(async () => ({})), env: LIGADO, now: AGORA });
    const [, params] = db.query.mock.calls[0];
    expect(params).toEqual([new Date(AGORA - 2 * 3600000).toISOString(), new Date(AGORA - 26 * 3600000).toISOString()]);
  });
});

describe('2.6 nova data combinada (tq-82a)', () => {
  const C = require('../src/services/cobrancaAssinatura');
  const AGORA = Date.parse('2026-10-24T15:00:00Z');

  function dbFalso(chaves = new Set()) {
    return {
      query: jest.fn(async (sql, params) => {
        const s = limpo(sql);
        if (s.includes('FROM companies c LEFT JOIN users u ON u.id = c.owner_id')) {
          return { rows: [{ id: EMP, loja: 'Modas da Maria', is_active: true, is_sandbox: false, user_id: 'u1', user_email: 'maria@exemplo.com', full_name: 'Maria', is_staff: false }] };
        }
        if (s.startsWith('INSERT INTO email_log')) {
          if (chaves.has(params[0])) return { rows: [] };
          chaves.add(params[0]);
          return { rows: [{ id: 'l' }] };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
  }
  const pagamento = (extra) => ({ id: 'pay_1', status: 'PENDING', dueDate: '2026-10-27', value: 119, interestValue: 0, invoiceUrl: 'https://www.asaas.com/i/1', ...extra });
  const asaasCom = (p) => jest.fn(async (m, caminho) => {
    if (caminho === '/payments/pay_1') { if (p instanceof Error) throw p; return p; }
    if (caminho === '/payments/pay_1/pixQrCode') return { payload: '00020126PIXNOVO' };
    throw new Error('?');
  });

  test('valor exato da cobrança relida (cupom: R$ 119, não o preço do plano), uma vez', async () => {
    const chaves = new Set();
    const enviarMail = jest.fn(async () => ({ id: 're' }));
    const args = { db: dbFalso(chaves), asaas: asaasCom(pagamento()), enviar: enviarMail, companyId: EMP, paymentId: 'pay_1', novaData: '2026-10-27', now: AGORA, env: {} };
    expect(await C.enviarNovaDataCombinada(args)).toEqual({ status: 'sent' });
    expect(await C.enviarNovaDataCombinada({ ...args, db: dbFalso(chaves) })).toEqual({ status: 'duplicate' });
    expect(enviarMail).toHaveBeenCalledTimes(1);
    expect(enviarMail.mock.calls[0][0].text).toContain('O valor continua R$ 119,00, sem custo a mais.');
    expect(enviarMail.mock.calls[0][0].text).toContain('Pix copia e cola: 00020126PIXNOVO');
    expect([...chaves]).toEqual(['nova-data:pay_1:2026-10-27']);
  });

  test.each([
    ['leitura da Asaas falha', new Error('timeout'), 'cobranca_indisponivel'],
    ['vencimento ainda não mudou', pagamento({ dueDate: '2026-10-20' }), 'vencimento_nao_mudou'],
    ['com multa e juros ("sem custo a mais" seria mentira)', pagamento({ interestValue: 3.71 }), 'com_multa_ou_juros'],
    ['desconto ainda válido (o Pix pode cobrar menos)', pagamento({ discount: { value: 10 } }), 'valor_indisponivel'],
    ['já paga', pagamento({ status: 'RECEIVED' }), 'nao_esta_em_aberto'],
  ])('%s: não envia', async (_, p, motivo) => {
    const enviarMail = jest.fn();
    const r = await C.enviarNovaDataCombinada({ db: dbFalso(), asaas: asaasCom(p), enviar: enviarMail, companyId: EMP, paymentId: 'pay_1', novaData: '2026-10-27', now: AGORA, env: {} });
    expect(r).toEqual({ status: 'nao_enviado', motivo });
    expect(enviarMail).not.toHaveBeenCalled();
  });
});
