// ============================================================
// AURA. — Régua de cobrança (tq-77, tq-78, tq-84, tq-93 — 24/10/2026)
//
//   - lembrete 2 dias antes e no dia; cartão não recebe; pago não recebe;
//     duas voltas não repetem; lembrete antigo com e-mail fica fora
//   - atraso nos dias 1, 3 (com aviso interno), 7, 11 e 14; nos outros
//     dias nada; nada retroativo (dia 20 não manda o do dia 7); recuperação
//     de 1 dia; empresa que deixou de estar 'overdue' não recebe
//   - VALOR NO E-MAIL: sempre o da cobrança relida na Asaas (cupom aparece
//     com o valor menor; vencida com juros mostra o mesmo valor do Pix);
//     leitura que falha não manda valor inventado
//   - nova tentativa no cartão: só com a flag; uma vez; aprovada não manda
//     2.8b; recusada manda
// ============================================================
'use strict';

const { criarBanco, criarEnvio } = require('./helpers/bancoDaCobranca');
const R = require('../src/services/reguaDeCobranca');
const { valorParaEmail } = require('../src/services/emailsCobranca');

const EMP = 'aaaaaaaa-0000-4000-8000-000000000001';
const DONO = 'bbbbbbbb-0000-4000-8000-000000000001';
const ENV = {};

// 9h30 em São Paulo do dia `iso`.
const as930 = (iso) => Date.parse(iso + 'T12:30:00Z');

function banco({ empresa = {}, usuario = {}, cobrancas = [], lembretesAntigos = [] } = {}) {
  return criarBanco({
    empresas: [{ id: EMP, owner_id: DONO, trade_name: 'Modas da Maria', asaas_customer_id: 'cus_1', ...empresa }],
    usuarios: [{ id: DONO, email: 'maria@exemplo.com', full_name: 'Maria Souza', ...usuario }],
    cobrancas,
    lembretesAntigos,
  });
}

const cobranca = (extra) => ({
  asaas_payment_id: 'pay_1', company_id: EMP, status: 'PENDING', due_date: '2026-11-20',
  valor: 169, billing_type: 'PIX', invoice_url: 'https://www.asaas.com/i/1', ...extra,
});

// Asaas falsa: GET /payments (lista), GET /payments/:id, GET .../pixQrCode,
// POST .../payWithCreditCard.
function asaasCom({ pagamentos = {}, lista = [], pix = 'PIXCOPIAECOLA', pagar } = {}) {
  return jest.fn(async (metodo, caminho) => {
    if (metodo === 'GET' && caminho.startsWith('/payments?')) return { data: lista, hasMore: false };
    let m = /^\/payments\/([^/]+)\/pixQrCode$/.exec(caminho);
    if (m) {
      if (pix instanceof Error) throw pix;
      return { payload: pix, encodedImage: 'AAAA' };
    }
    m = /^\/payments\/([^/]+)\/payWithCreditCard$/.exec(caminho);
    if (m) return pagar(m[1]);
    m = /^\/payments\/([^/?]+)$/.exec(caminho);
    if (m) {
      const p = pagamentos[m[1]];
      if (p instanceof Error) throw p;
      if (!p) throw new Error('Asaas error 404');
      return p;
    }
    throw new Error('caminho inesperado ' + caminho);
  });
}

const pg = (extra) => ({ id: 'pay_1', customer: 'cus_1', status: 'PENDING', value: 169, billingType: 'PIX', dueDate: '2026-11-20', invoiceUrl: 'https://www.asaas.com/i/1', ...extra });

function notificacoes() {
  const avisos = [];
  return { avisos, notifyCompany: jest.fn(async (cid, payload) => { avisos.push({ cid, ...payload }); return { id: 'n' + avisos.length }; }) };
}

async function rodar(db, asaas, dia, extra = {}) {
  const { enviar, enviados } = extra.envio || criarEnvio();
  const notifications = extra.notifications || notificacoes();
  const s = await R.tickDiarioDaRegua({ db, asaas, notifications, enviar, now: as930(dia), env: extra.env || ENV });
  return { s, enviados, notifications };
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('lembretes (tq-77)', () => {
  test('2 dias antes: 2.1 com o Pix; segunda volta não repete', async () => {
    const db = banco({ cobrancas: [cobranca()] });
    const asaas = asaasCom({ pagamentos: { pay_1: pg() } });
    const envio = criarEnvio();
    await rodar(db, asaas, '2026-11-18', { envio });
    await rodar(db, asaas, '2026-11-18', { envio });
    expect(envio.enviados).toHaveLength(1);
    expect(envio.enviados[0].subject).toBe('Sua mensalidade da Aura vence sexta-feira');
    expect(envio.enviados[0].text).toContain('Pix copia e cola: PIXCOPIAECOLA');
    expect(envio.enviados[0].html).toContain('/emails/pix-qr/');
    expect(db.emailLog[0].chave_idempotencia).toBe('lembrete-2-dias:pay_1');
  });

  test('no dia: 2.2 só se ainda não pagou', async () => {
    const db = banco({ cobrancas: [cobranca()] });
    let { enviados } = await rodar(db, asaasCom({ pagamentos: { pay_1: pg() } }), '2026-11-20');
    expect(enviados.map((e) => e.subject)).toEqual(['Hoje vence a mensalidade da Aura']);

    const db2 = banco({ cobrancas: [cobranca()] });
    ({ enviados } = await rodar(db2, asaasCom({ pagamentos: { pay_1: pg({ status: 'RECEIVED' }) } }), '2026-11-20'));
    expect(enviados).toHaveLength(0);
    expect(db2.cobrancas[0].status).toBe('PAID');
  });

  test('cartão não recebe lembrete (nem no espelho, nem pela Asaas)', async () => {
    let db = banco({ cobrancas: [cobranca({ billing_type: 'CREDIT_CARD' })] });
    expect((await rodar(db, asaasCom({ pagamentos: { pay_1: pg({ billingType: 'CREDIT_CARD' }) } }), '2026-11-18')).enviados).toHaveLength(0);
    db = banco({ cobrancas: [cobranca({ billing_type: null })] });
    expect((await rodar(db, asaasCom({ pagamentos: { pay_1: pg({ billingType: 'CREDIT_CARD' }) } }), '2026-11-18')).enviados).toHaveLength(0);
  });

  test('Pix indisponível: sai com o link da fatura, sem bloco de Pix', async () => {
    const db = banco({ cobrancas: [cobranca()] });
    const { enviados } = await rodar(db, asaasCom({ pagamentos: { pay_1: pg() }, pix: new Error('500') }), '2026-11-18');
    expect(enviados).toHaveLength(1);
    expect(enviados[0].text).not.toContain('Pix copia e cola');
    expect(enviados[0].text).toContain('Abrir a fatura: https://www.asaas.com/i/1');
  });

  test('cobrança com e-mail pelo lembrete antigo (invoice_reminders.send_email) fica fora', async () => {
    const db = banco({ cobrancas: [cobranca()], lembretesAntigos: ['pay_1'] });
    expect((await rodar(db, asaasCom({ pagamentos: { pay_1: pg() } }), '2026-11-18')).enviados).toHaveLength(0);
  });

  test('varredura: cobrança pendente que só existe na Asaas entra no espelho e recebe', async () => {
    const db = banco();
    const asaas = asaasCom({ pagamentos: { pay_1: pg() }, lista: [pg(), pg({ id: 'pay_x', externalReference: 'digital-order-1', customer: 'cus_1' })] });
    const { enviados, s } = await rodar(db, asaas, '2026-11-18');
    expect(s.varridas).toBe(1);
    expect(db.cobrancas.map((c) => c.asaas_payment_id)).toEqual(['pay_1']);
    expect(enviados).toHaveLength(1);
  });

  test('conta interna e sandbox: nada', async () => {
    for (const cfg of [{ usuario: { is_staff: true } }, { empresa: { is_sandbox: true } }, { usuario: { email: 'x@getaura.com.br' } }]) {
      const db = banco({ ...cfg, cobrancas: [cobranca()] });
      expect((await rodar(db, asaasCom({ pagamentos: { pay_1: pg() } }), '2026-11-18')).enviados).toHaveLength(0);
    }
  });
});

describe('atraso (tq-78, tq-93)', () => {
  const vencida = () => cobranca({ status: 'OVERDUE', due_date: '2026-10-20' });
  const pVencida = (extra) => pg({ status: 'OVERDUE', dueDate: '2026-10-20', ...extra });

  test.each([
    ['2026-10-21', 'A mensalidade da Aura de 20/10 ainda está em aberto'],
    ['2026-10-22', 'A mensalidade da Aura de 20/10 ainda está em aberto'], // recuperação de 1 dia
    ['2026-10-23', 'Sobre a mensalidade da Aura: posso ajudar?'],
    ['2026-10-27', 'Preciso falar com você sobre a mensalidade da Aura'],
    ['2026-10-31', 'Seu Caixa da Aura pausa em 3 dias'],
    ['2026-11-01', 'Seu Caixa da Aura pausa em 2 dias'],
    ['2026-11-03', 'O Caixa da Aura está pausado'],
  ])('%s: %s', async (dia, assunto) => {
    const db = banco({ empresa: { billing_status: 'overdue' }, cobrancas: [vencida()] });
    const { enviados } = await rodar(db, asaasCom({ pagamentos: { pay_1: pVencida() } }), dia);
    expect(enviados.map((e) => e.subject)).toEqual([assunto]);
  });

  test.each(['2026-10-25', '2026-10-26', '2026-10-29', '2026-11-04', '2026-11-09'])('%s: nada (fora da régua / retroativo)', async (dia) => {
    const db = banco({ empresa: { billing_status: 'overdue' }, cobrancas: [vencida()] });
    expect((await rodar(db, asaasCom({ pagamentos: { pay_1: pVencida() } }), dia)).enviados).toHaveLength(0);
  });

  test('dia 3: aviso no sino interno da Aura, uma vez, para a empresa da equipe', async () => {
    const db = banco({ empresa: { billing_status: 'overdue' }, cobrancas: [vencida()] });
    const { notifications } = await rodar(db, asaasCom({ pagamentos: { pay_1: pVencida() } }), '2026-10-23');
    expect(notifications.avisos).toHaveLength(1);
    expect(notifications.avisos[0]).toMatchObject({
      cid: R.ALERTA_COMPANY_ID_PADRAO,
      title: 'Mensalidade em atraso há 3 dias: Modas da Maria',
      dedupeKey: 'atraso-3-dias:pay_1',
    });
  });

  test('textos com as datas das pausas (+7 telas, +14 Caixa)', async () => {
    const db = banco({ empresa: { billing_status: 'overdue' }, cobrancas: [vencida()] });
    const a = asaasCom({ pagamentos: { pay_1: pVencida() } });
    const t3 = (await rodar(db, a, '2026-10-23')).enviados[0].text;
    expect(t3).toContain('a partir de 27/10 o acesso às outras telas fica pausado');
    const t7 = (await rodar(db, a, '2026-10-27')).enviados[0].text;
    expect(t7).toContain('vender até 03/11');
    const t11 = (await rodar(db, a, '2026-10-31')).enviados[0].text;
    expect(t11).toContain('se o pagamento não entrar até 03/11, ele para nesse dia');
  });

  test('empresa que não está mais overdue (pagou outra cobrança): nada', async () => {
    const db = banco({ empresa: { billing_status: 'active' }, cobrancas: [vencida()] });
    expect((await rodar(db, asaasCom({ pagamentos: { pay_1: pVencida() } }), '2026-10-21')).enviados).toHaveLength(0);
  });

  test('cobrança paga na Asaas sem webhook: não cobra e corrige o espelho', async () => {
    const db = banco({ empresa: { billing_status: 'overdue' }, cobrancas: [vencida()] });
    const { enviados } = await rodar(db, asaasCom({ pagamentos: { pay_1: pVencida({ status: 'RECEIVED' }) } }), '2026-10-23');
    expect(enviados).toHaveLength(0);
    expect(db.cobrancas[0].status).toBe('PAID');
  });

  test('duas cobranças vencidas: a régua segue a mais antiga, um e-mail', async () => {
    const db = banco({
      empresa: { billing_status: 'overdue' },
      cobrancas: [vencida(), cobranca({ asaas_payment_id: 'pay_2', status: 'OVERDUE', due_date: '2026-10-22' })],
    });
    const { enviados } = await rodar(db, asaasCom({ pagamentos: { pay_1: pVencida(), pay_2: pVencida({ id: 'pay_2' }) } }), '2026-10-23');
    expect(enviados).toHaveLength(1);
    expect(db.emailLog[0].chave_idempotencia).toBe('atraso-3:pay_1');
  });

  test('EMAILS_COBRANCA_ENABLED=false: nada', async () => {
    const db = banco({ empresa: { billing_status: 'overdue' }, cobrancas: [vencida()] });
    const { enviados, notifications } = await rodar(db, asaasCom({ pagamentos: { pay_1: pVencida() } }), '2026-10-23', { env: { EMAILS_COBRANCA_ENABLED: 'false' } });
    expect(enviados).toHaveLength(0);
    expect(notifications.avisos).toHaveLength(0);
  });
});

describe('valor no e-mail (regra do Caio, 24/10)', () => {
  test('cobrança com cupom: o valor da cobrança (menor que o plano), não o preço do plano', async () => {
    // O espelho guardou 169 (valor antigo); a Asaas diz 119 hoje (cupom).
    const db = banco({ cobrancas: [cobranca({ valor: 169 })] });
    const { enviados } = await rodar(db, asaasCom({ pagamentos: { pay_1: pg({ value: 119, netValue: 116.01 }) } }), '2026-11-18');
    expect(enviados[0].text).toContain('de R$ 119,00, vence');
    expect(enviados[0].text).not.toContain('169');
    expect(enviados[0].text).not.toContain('116,01'); // nunca netValue
  });

  test('vencida com juros e multa: mostra value + interestValue, o que o Pix cobra hoje', async () => {
    const db = banco({ empresa: { billing_status: 'overdue' }, cobrancas: [cobranca({ status: 'OVERDUE', due_date: '2026-10-20' })] });
    const p = pg({ status: 'OVERDUE', dueDate: '2026-10-20', value: 169, interestValue: 3.71, fine: { value: 2 }, interest: { value: 1 } });
    const { enviados } = await rodar(db, asaasCom({ pagamentos: { pay_1: p } }), '2026-10-21');
    expect(enviados[0].text).toContain('R$ 172,71 (valor de hoje, já com multa e juros)');
    expect(enviados[0].text).not.toContain('R$ 169,00');
  });

  test('desconto antecipado ainda válido: sem número (o Pix pode cobrar menos)', async () => {
    const db = banco({ cobrancas: [cobranca()] });
    const { enviados } = await rodar(db, asaasCom({ pagamentos: { pay_1: pg({ discount: { value: 10, type: 'FIXED', dueDateLimitDays: 0 } }) } }), '2026-11-18');
    expect(enviados).toHaveLength(1);
    expect(enviados[0].text).not.toMatch(/R\$/);
    expect(enviados[0].text).toContain('a mensalidade da Modas da Maria na Aura vence sexta-feira');
  });

  test('leitura da cobrança na Asaas falha: não envia e registra o adiamento no email_log', async () => {
    const db = banco({ empresa: { billing_status: 'overdue' }, cobrancas: [cobranca({ status: 'OVERDUE', due_date: '2026-10-20', valor: 169 })] });
    const { enviados, s } = await rodar(db, asaasCom({ pagamentos: { pay_1: new Error('Asaas error 503') } }), '2026-10-21');
    expect(enviados).toHaveLength(0);
    expect(s.adiados).toBe(1);
    expect(db.emailLog[0]).toMatchObject({ chave_idempotencia: 'atraso-1:pay_1', status: 'failed' });
    expect(db.emailLog[0].erro).toMatch(/^adiado: valor da cobrança indisponível/);
    // No dia seguinte (recuperação), com a Asaas de volta, sai com o valor dela.
    const { enviados: depois } = await rodar(db, asaasCom({ pagamentos: { pay_1: pg({ status: 'OVERDUE', dueDate: '2026-10-20', value: 99.5 }) } }), '2026-10-22');
    expect(depois).toHaveLength(1);
    expect(depois[0].text).toContain('R$ 99,50');
  });

  test('valorParaEmail: centavos exatos, nunca netValue', () => {
    expect(valorParaEmail({ value: 84.5, netValue: 81.1 })).toEqual({ valor: 84.5, comJuros: false });
    expect(valorParaEmail({ value: 0.1, interestValue: 0.2, status: 'OVERDUE' })).toEqual({ valor: 0.3, comJuros: true });
    expect(valorParaEmail({ value: 172.71, originalValue: 169 }, { situacao: 'paga' })).toEqual({ valor: 172.71, comJuros: true });
    expect(valorParaEmail({ value: 'x' })).toBeNull();
    expect(valorParaEmail(null)).toBeNull();
    // desconto: vencida ignora (o desconto já não vale); em dia, sem número
    expect(valorParaEmail({ value: 169, discount: { value: 10 }, dueDate: '2026-10-20' }, { hoje: '2026-10-21' })).toEqual({ valor: 169, comJuros: false });
    expect(valorParaEmail({ value: 169, discount: { value: 10 }, dueDate: '2026-11-20' }, { hoje: '2026-11-18' })).toBeNull();
  });
});

describe('nova tentativa no cartão (tq-84)', () => {
  const recusada = (horasAtras, extra = {}) => cobranca({
    billing_type: 'CREDIT_CARD', cartao_final: '4821',
    cartao_recusado_em: new Date(Date.parse('2026-11-21T15:00:00Z') - horasAtras * 3600000), ...extra,
  });
  const AGORA = Date.parse('2026-11-21T15:00:00Z');
  const pCartao = (extra) => pg({ billingType: 'CREDIT_CARD', creditCard: { creditCardNumber: '4821', creditCardToken: 'tok_1' }, ...extra });
  const LIGADA = { ASAAS_RETENTATIVA_CARTAO_ENABLED: 'true' };

  test('desligada (padrão): não cobra', async () => {
    const db = banco({ cobrancas: [recusada(25)] });
    const pagar = jest.fn();
    const r = await R.tickRetentativas({ db, asaas: asaasCom({ pagamentos: { pay_1: pCartao() }, pagar }), enviar: criarEnvio().enviar, now: AGORA, env: ENV });
    expect(pagar).not.toHaveBeenCalled();
    expect(r.retentativas).toBe(0);
  });

  test('ligada: antes de 24 h não cobra; depois cobra UMA vez com o token da cobrança', async () => {
    const db = banco({ cobrancas: [recusada(10)] });
    const pagar = jest.fn(async () => ({ status: 'CONFIRMED' }));
    const asaas = asaasCom({ pagamentos: { pay_1: pCartao() }, pagar });
    const { enviar, enviados } = criarEnvio();
    await R.tickRetentativas({ db, asaas, enviar, now: AGORA, env: LIGADA });
    expect(pagar).not.toHaveBeenCalled();
    db.cobrancas[0].cartao_recusado_em = new Date(AGORA - 25 * 3600000);
    await R.tickRetentativas({ db, asaas, enviar, now: AGORA, env: LIGADA });
    await R.tickRetentativas({ db, asaas, enviar, now: AGORA, env: LIGADA });
    expect(pagar).toHaveBeenCalledTimes(1);
    expect(asaas).toHaveBeenCalledWith('POST', '/payments/pay_1/payWithCreditCard', { creditCardToken: 'tok_1' });
    expect(db.cobrancas[0].retentativa_resultado).toBe('aprovada');
    expect(enviados).toHaveLength(0);
  });

  test('ligada: recusada de novo manda 2.8b uma vez', async () => {
    const db = banco({ cobrancas: [recusada(25)] });
    const pagar = jest.fn(async () => { throw new Error('Asaas error 400: Transação não autorizada'); });
    const { enviar, enviados } = criarEnvio();
    await R.tickRetentativas({ db, asaas: asaasCom({ pagamentos: { pay_1: pCartao() }, pagar }), enviar, now: AGORA, env: LIGADA });
    expect(db.cobrancas[0].retentativa_resultado).toBe('recusada');
    expect(enviados.map((e) => e.subject)).toEqual(['O cartão não passou de novo na mensalidade da Aura']);
    expect(enviados[0].text).toContain('o cartão final 4821');
  });

  test('ligada: já paga não cobra; sem token não cobra; recusa de mais de 72 h não cobra', async () => {
    for (const [linha, pagamento] of [
      [recusada(25), pCartao({ status: 'RECEIVED' })],
      [recusada(25), pg({ billingType: 'CREDIT_CARD' })],
      [recusada(80), pCartao()],
    ]) {
      const db = banco({ cobrancas: [linha] });
      const pagar = jest.fn();
      await R.tickRetentativas({ db, asaas: asaasCom({ pagamentos: { pay_1: pagamento }, pagar }), enviar: criarEnvio().enviar, now: AGORA, env: LIGADA });
      expect(pagar).not.toHaveBeenCalled();
    }
  });

  test('ligada: leitura da cobrança falha antes de cobrar — devolve a reserva', async () => {
    const db = banco({ cobrancas: [recusada(25)] });
    const pagar = jest.fn();
    await R.tickRetentativas({ db, asaas: asaasCom({ pagamentos: { pay_1: new Error('503') }, pagar }), enviar: criarEnvio().enviar, now: AGORA, env: LIGADA });
    expect(pagar).not.toHaveBeenCalled();
    expect(db.cobrancas[0].retentativa_em).toBeNull();
  });
});

describe('etapas', () => {
  test('etapaDoAtraso e etapaDoLembrete', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((d) => (R.etapaDoAtraso(d) || {}).chave || '-'))
      .toEqual(['-', 'atraso-1', 'atraso-1', 'atraso-3', 'atraso-3', '-', '-', 'atraso-7', 'atraso-7', '-', '-', 'caixa-pausa-3', 'caixa-pausa-3', '-', 'caixa-pausado', '-']);
    expect([3, 2, 1, 0, -1].map((d) => (R.etapaDoLembrete(d) || {}).chave || '-'))
      .toEqual(['-', 'lembrete-2-dias', 'lembrete-2-dias', 'vence-hoje', '-']);
  });
});
