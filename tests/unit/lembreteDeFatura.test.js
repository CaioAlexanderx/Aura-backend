// ============================================================
// services/lembreteDeFatura — lembrete de fatura agendado (migration 367).
//
// Cenário base: FPKT, fatura de R$ 169,00 que vence em 18/10/2026, aviso
// marcado para 16/10, com e-mail e alerta para a Aura.
//
// O que estes testes travam:
//   1. O banner só nasce quando a volta enxerga a linha (a consulta filtra
//      por notify_on <= hoje) e leva o QR Code e o copia e cola do Asaas.
//   2. Fatura já paga não gera banner; paga depois tira o banner do ar.
//   3. O e-mail sai uma vez, só com send_email, e é tentado de novo se falhar.
//   4. No dia do vencimento, a partir das 18h, fatura em aberto avisa a Aura
//      — uma vez por cobrança.
//   5. Asaas fora do ar não encerra nada: a linha fica para a próxima volta.
// ============================================================
const {
  tickLembretesDeFatura,
  montarLembrete,
  nomeDoPlano,
} = require('../../src/services/lembreteDeFatura');
const { dentroDoHorario } = require('../../src/jobs/lembreteDeFaturaJob');

// Hora de Brasília do dia pedido.
const at = (iso, hourBrt = 9) => Date.parse(iso + 'T00:00:00Z') + (hourBrt + 3) * 3600000;

const FPKT = '274994b3-6324-4e7b-942e-e6dd19666149';
const AURA = '645c1325-8865-48be-af6f-430d93fb2b6c';
const PIX = '00020101021226800014br.gov.bcb.pix2558pix.asaas.com/qr/cobv/abc5204000053039865802BR5909AURA LTDA6007Jacarei6304ABCD';
const QR = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const baseRow = (extra = {}) => ({
  id: 'r1',
  company_id: FPKT,
  asaas_payment_id: 'pay_siwzm4ng6oqzr88j',
  notify_on: '2026-10-16',
  due_date: '2026-10-18',
  send_email: true,
  alert_company_id: AURA,
  extra_note: null,
  notified_at: null,
  notification_id: null,
  email_sent_at: null,
  company_name: 'FPKT',
  ...extra,
});

const payment = (extra = {}) => ({
  id: 'pay_siwzm4ng6oqzr88j',
  status: 'PENDING',
  value: 169,
  dueDate: '2026-10-18',
  description: 'Aura Negocio',
  invoiceNumber: '900100200',
  invoiceUrl: 'https://www.asaas.com/i/siwzm4ng6oqzr88j',
  ...extra,
});

function makeDb(rows, { claim = true, existingBanner = null } = {}) {
  const writes = [];
  return {
    writes,
    query: jest.fn(async (sql, params) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('FROM invoice_reminders r JOIN companies')) return { rows, params };
      if (s.includes('FROM app_notifications WHERE dedupe_key')) return { rows: existingBanner ? [existingBanner] : [] };
      writes.push({ sql: s, params });
      if (s.includes('SET notified_at = NOW()')) return { rows: claim ? [{ id: params[0] }] : [] };
      return { rows: [], rowCount: 1 };
    }),
  };
}

function makeAsaas({ pay = payment(), pix = { payload: PIX, encodedImage: QR }, fail = false } = {}) {
  return jest.fn(async (method, path) => {
    if (fail) throw new Error('Asaas fora');
    if (method === 'GET' && path === '/payments/pay_siwzm4ng6oqzr88j') return pay;
    if (method === 'GET' && path === '/payments/pay_siwzm4ng6oqzr88j/pixQrCode') return pix;
    throw new Error('chamada inesperada ' + method + ' ' + path);
  });
}

const makeNotifications = (result = { id: 'n1' }) => ({ notifyCompany: jest.fn(async () => result) });

const makeEmailer = ({ sent = [{ email: 'fpkt@example.com' }], recipients } = {}) => ({
  listRecipients: jest.fn(async () => ({
    recipients: recipients || [
      { email: 'fpkt@example.com', selected: true },
      { email: 'membro@example.com', selected: false },
    ],
  })),
  sendNotificationEmails: jest.fn(async () => ({ sent, failed: [] })),
});

const wrote = (db, fragment) => db.writes.some((w) => w.sql.includes(fragment));
const outcome = (db) => {
  const w = db.writes.find((x) => x.sql.includes('SET outcome = $2'));
  return w ? w.params[1] : null;
};

async function run({ row = baseRow(), now = at('2026-10-16'), dbOpts, asaasOpts, notifications, emailer } = {}) {
  const deps = {
    db: makeDb(row ? [row] : [], dbOpts),
    asaas: makeAsaas(asaasOpts),
    notifications: notifications || makeNotifications(),
    emailer: emailer || makeEmailer(),
    now,
  };
  const summary = await tickLembretesDeFatura(deps);
  return { ...deps, summary };
}

describe('montarLembrete', () => {
  const l = montarLembrete({ payment: payment(), pixCode: PIX, qrBase64: QR, extraNote: null });

  test('título, corpo e CTA com os dados da cobrança', () => {
    expect(l.title).toBe('Sua fatura Aura vence em 18/10');
    expect(l.resumo).toBe('Aura Negocio — R$ 169,00, vencimento 18/10/2026. Pague via Pix pelo QR Code ou pelo código copia e cola.');
    expect(l.body).toBe(l.resumo + '\n\nPIX copia e cola: ' + PIX);
    expect(l.ctaUrl).toBe('https://www.asaas.com/i/siwzm4ng6oqzr88j');
  });

  test('a peça leva o QR Code do Asaas, o copia e cola e o botão de copiar', () => {
    expect(l.htmlContent).toContain('src="data:image/png;base64,' + QR + '"');
    expect(l.htmlContent).toContain('<div class="code" id="pix">' + PIX + '</div>');
    expect(l.htmlContent).toContain('id="copy"');
    expect(l.htmlContent).toContain('R$&nbsp;169,00');
    expect(l.htmlContent).toContain('18/10/2026<small>domingo</small>');
    expect(l.htmlContent).toContain('fatura nº 900100200');
  });

  test('fica no ar até 2 dias depois do vencimento', () => {
    expect(l.expiresAt).toBe('2026-10-20T23:59:59-03:00');
  });

  test('a frase extra entra no corpo; o cupom sai do nome do plano', () => {
    const d = montarLembrete({
      payment: payment({ description: 'Aura Negocio — cupom VOULU119: R$ 50,00 de desconto nas 3 primeiras mensalidades', value: 119 }),
      pixCode: PIX, qrBase64: QR, extraNote: 'Um pagamento só cobre as duas empresas do grupo.',
    });
    expect(d.resumo).toBe('Aura Negocio — R$ 119,00, vencimento 18/10/2026. Pague via Pix pelo QR Code ou pelo código copia e cola. Um pagamento só cobre as duas empresas do grupo.');
    expect(nomeDoPlano('')).toBe('Assinatura Aura');
  });

  test('sem invoiceUrl o link sai do id da cobrança', () => {
    const d = montarLembrete({ payment: payment({ invoiceUrl: undefined }), pixCode: PIX, qrBase64: QR });
    expect(d.ctaUrl).toBe('https://www.asaas.com/i/siwzm4ng6oqzr88j');
  });
});

describe('publicar o banner no dia marcado', () => {
  test('a consulta só traz linha em andamento cujo dia de aviso chegou (dia de São Paulo)', async () => {
    // 15/10 às 23h de Brasília já é dia 16 em UTC: o dia que vale é o 15.
    const { db, asaas, summary } = await run({ row: null, now: at('2026-10-15', 23) });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql.replace(/\s+/g, ' ')).toContain('WHERE r.outcome IS NULL AND r.notify_on <= $1::date');
    expect(params).toEqual(['2026-10-15']);
    expect(asaas).not.toHaveBeenCalled();
    expect(summary.vistos).toBe(0);
  });

  test('publica para a empresa com o Pix da cobrança e guarda o id do banner', async () => {
    const { db, notifications, summary } = await run();
    expect(notifications.notifyCompany).toHaveBeenCalledTimes(1);
    const [companyId, p] = notifications.notifyCompany.mock.calls[0];
    expect(companyId).toBe(FPKT);
    expect(p.title).toBe('Sua fatura Aura vence em 18/10');
    expect(p.htmlContent).toContain(QR);
    expect(p.body).toContain(PIX);
    expect(p.dedupeKey).toBe('fatura-aura:pay_siwzm4ng6oqzr88j:' + FPKT);
    expect(p.expiresAt).toBe('2026-10-20T23:59:59-03:00');
    expect(db.writes.find((w) => w.sql.includes('SET notification_id = $2')).params).toEqual(['r1', 'n1']);
    expect(summary.publicados).toBe(1);
    expect(outcome(db)).toBeNull();
  });

  test('sem a imagem do Asaas o QR Code é gerado do copia e cola', async () => {
    const { notifications } = await run({ asaasOpts: { pix: { payload: PIX } } });
    const html = notifications.notifyCompany.mock.calls[0][1].htmlContent;
    expect(html).toMatch(/src="data:image\/png;base64,iVBOR[A-Za-z0-9+/=]{200,}"/);
  });

  test('outra volta já reservou: não publica de novo', async () => {
    const { notifications, emailer } = await run({ dbOpts: { claim: false } });
    expect(notifications.notifyCompany).not.toHaveBeenCalled();
    expect(emailer.sendNotificationEmails).not.toHaveBeenCalled();
  });

  test('banner não criado: desfaz a reserva e conta a falha', async () => {
    const { db, summary } = await run({ notifications: makeNotifications(null) });
    expect(wrote(db, 'SET notified_at = NULL')).toBe(true);
    expect(summary).toMatchObject({ publicados: 0, falhas: 1 });
  });

  test('chave já existente (volta anterior caiu no meio): reaproveita o banner', async () => {
    const { db, summary } = await run({
      notifications: makeNotifications(null),
      dbOpts: { existingBanner: { id: 'n-antigo' } },
    });
    expect(db.writes.find((w) => w.sql.includes('SET notification_id = $2')).params).toEqual(['r1', 'n-antigo']);
    expect(wrote(db, 'SET notified_at = NULL')).toBe(false);
    expect(summary.falhas).toBe(0);
  });

  test('Asaas sem Pix para a cobrança: nada publicado, fica para a próxima volta', async () => {
    const { db, notifications, summary } = await run({ asaasOpts: { pix: {} } });
    expect(notifications.notifyCompany).not.toHaveBeenCalled();
    expect(wrote(db, 'SET notified_at = NOW()')).toBe(false);
    expect(summary.falhas).toBe(1);
  });

  test('Asaas fora do ar: nada é gravado', async () => {
    const { db, summary } = await run({ asaasOpts: { fail: true } });
    expect(db.writes).toHaveLength(0);
    expect(summary.falhas).toBe(1);
  });

  test('vencimento prorrogado no Asaas corrige a agenda', async () => {
    const { db, notifications } = await run({ asaasOpts: { pay: payment({ dueDate: '2026-10-25' }) } });
    expect(db.writes.find((w) => w.sql.includes('SET due_date = $2')).params).toEqual(['r1', '2026-10-25']);
    expect(notifications.notifyCompany.mock.calls[0][1].title).toBe('Sua fatura Aura vence em 25/10');
  });
});

describe('e-mail', () => {
  test('com send_email sai para os endereços marcados do cadastro, com o bloco Pix', async () => {
    const { db, emailer, summary } = await run();
    const arg = emailer.sendNotificationEmails.mock.calls[0][0];
    expect(arg.recipients).toEqual(['fpkt@example.com']);
    expect(arg.subject).toBe('Sua fatura Aura vence em 18/10');
    expect(arg.pix).toEqual({ code: PIX, amount: 169, dueDate: '2026-10-18' });
    // No e-mail o código tem bloco próprio: o texto vai sem ele.
    expect(arg.notification.body).not.toContain(PIX);
    expect(arg.notification).toMatchObject({ id: 'n1', target_company_id: FPKT });
    expect(wrote(db, 'SET email_sent_at = NOW()')).toBe(true);
    expect(summary.emails).toBe(1);
  });

  test('sem send_email não manda nada', async () => {
    const { emailer } = await run({ row: baseRow({ send_email: false }) });
    expect(emailer.listRecipients).not.toHaveBeenCalled();
    expect(emailer.sendNotificationEmails).not.toHaveBeenCalled();
  });

  test('falha no envio não desfaz o banner nem marca o e-mail como enviado', async () => {
    const { db, summary } = await run({ emailer: makeEmailer({ sent: [] }) });
    expect(summary.publicados).toBe(1);
    expect(wrote(db, 'SET email_sent_at = NOW()')).toBe(false);
    expect(wrote(db, 'SET notified_at = NULL')).toBe(false);
  });

  test('banner já no ar e e-mail pendente: a volta seguinte tenta de novo, sem novo banner', async () => {
    const { db, notifications, emailer } = await run({
      row: baseRow({ notified_at: new Date(), notification_id: 'n1' }),
      now: at('2026-10-17'),
    });
    expect(notifications.notifyCompany).not.toHaveBeenCalled();
    expect(emailer.sendNotificationEmails).toHaveBeenCalledTimes(1);
    expect(wrote(db, 'SET email_sent_at = NOW()')).toBe(true);
  });

  test('e-mail já enviado não se repete', async () => {
    const { emailer } = await run({
      row: baseRow({ notified_at: new Date(), notification_id: 'n1', email_sent_at: new Date() }),
      now: at('2026-10-17'),
    });
    expect(emailer.sendNotificationEmails).not.toHaveBeenCalled();
  });
});

describe('fatura paga', () => {
  test('paga antes do dia do aviso: encerra sem banner e sem e-mail', async () => {
    const { db, notifications, emailer, summary } = await run({ asaasOpts: { pay: payment({ status: 'RECEIVED' }) } });
    expect(notifications.notifyCompany).not.toHaveBeenCalled();
    expect(emailer.sendNotificationEmails).not.toHaveBeenCalled();
    expect(outcome(db)).toBe('paid');
    expect(summary.pagos).toBe(1);
  });

  test('paga depois do aviso: o banner sai do ar', async () => {
    const { db } = await run({
      row: baseRow({ notified_at: new Date(), notification_id: 'n1', email_sent_at: new Date() }),
      now: at('2026-10-17'),
      asaasOpts: { pay: payment({ status: 'CONFIRMED' }) },
    });
    const off = db.writes.find((w) => w.sql.includes('UPDATE app_notifications SET is_active = false'));
    expect(off.params).toEqual(['n1']);
    expect(outcome(db)).toBe('paid');
  });

  test('cobrança removida no Asaas: encerra sem avisar ninguém', async () => {
    const { db, notifications } = await run({ asaasOpts: { pay: payment({ deleted: true }) } });
    expect(notifications.notifyCompany).not.toHaveBeenCalled();
    expect(outcome(db)).toBe('gone');
  });
});

describe('alerta de pagamento não recebido', () => {
  const noAr = () => baseRow({ notified_at: new Date(), notification_id: 'n1', email_sent_at: new Date() });

  test('dia do vencimento antes das 18h: ainda não avisa', async () => {
    const { db, notifications } = await run({ row: noAr(), now: at('2026-10-18', 17) });
    expect(notifications.notifyCompany).not.toHaveBeenCalled();
    expect(outcome(db)).toBeNull();
  });

  test('dia do vencimento a partir das 18h, em aberto: avisa a Aura e encerra', async () => {
    const { db, notifications, summary } = await run({ row: noAr(), now: at('2026-10-18', 18) });
    expect(notifications.notifyCompany).toHaveBeenCalledTimes(1);
    const [companyId, p] = notifications.notifyCompany.mock.calls[0];
    expect(companyId).toBe(AURA);
    expect(p.title).toBe('Pagamento não recebido: FPKT');
    expect(p.body).toBe('A fatura de R$ 169,00 (Aura Negocio) vence hoje, 18/10/2026, e o pagamento ainda não entrou no Asaas.');
    expect(p.dedupeKey).toBe('fatura-aura-nao-paga:pay_siwzm4ng6oqzr88j');
    expect(p.ctaUrl).toBe('https://www.asaas.com/i/siwzm4ng6oqzr88j');
    expect(outcome(db)).toBe('unpaid_alerted');
    expect(summary.alertas).toBe(1);
  });

  test('paga no dia: às 18h não há alerta', async () => {
    const { db, notifications } = await run({
      row: noAr(), now: at('2026-10-18', 18), asaasOpts: { pay: payment({ status: 'RECEIVED' }) },
    });
    expect(notifications.notifyCompany).not.toHaveBeenCalled();
    expect(outcome(db)).toBe('paid');
  });

  test('rotina parada no dia do vencimento: avisa na primeira volta do dia seguinte', async () => {
    const { notifications } = await run({ row: noAr(), now: at('2026-10-19', 8) });
    expect(notifications.notifyCompany).toHaveBeenCalledTimes(1);
    expect(notifications.notifyCompany.mock.calls[0][1].body)
      .toBe('A fatura de R$ 169,00 (Aura Negocio) venceu em 18/10/2026 e o pagamento ainda não entrou no Asaas.');
  });

  test('segunda linha da mesma cobrança (grupo): a chave repetida não conta como alerta novo', async () => {
    const { db, summary } = await run({
      row: noAr(), now: at('2026-10-18', 18), notifications: makeNotifications(null),
    });
    expect(summary.alertas).toBe(0);
    expect(outcome(db)).toBe('unpaid_alerted');
  });

  test('sem empresa de alerta: encerra em silêncio', async () => {
    const { db, notifications } = await run({
      row: { ...noAr(), alert_company_id: null }, now: at('2026-10-18', 18),
    });
    expect(notifications.notifyCompany).not.toHaveBeenCalled();
    expect(outcome(db)).toBe('unpaid');
  });
});

describe('horário do agendador', () => {
  test('roda das 8h às 20h de Brasília', () => {
    expect(dentroDoHorario(at('2026-10-16', 7))).toBe(false);
    expect(dentroDoHorario(at('2026-10-16', 8))).toBe(true);
    expect(dentroDoHorario(at('2026-10-16', 19))).toBe(true);
    expect(dentroDoHorario(at('2026-10-16', 20))).toBe(false);
  });
});
