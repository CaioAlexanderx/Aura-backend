// ============================================================
// AURA. — Remetente, Reply-To e cabeçalhos no mailer (tq-72, 21/10/2026)
//
//   - remetente padrão: MAIL_FROM > SMTP_FROM > "Caio Alexander, da Aura
//     <contato@getaura.com.br>"
//   - Reply-To padrão: MAIL_REPLY_TO > contato@getaura.com.br, em todo envio
//     que não passa replyTo
//   - opts.from por envio, só @getaura.com.br
//   - headers repassados (Resend: headers; SMTP: headers do nodemailer)
//   - relatório semanal sai como "Aura <contato@getaura.com.br>"
//   - nenhum log com o e-mail do destinatário; sendMail devolve o id
// ============================================================
'use strict';

const ENV = { ...process.env };

function carregarMailer(env = {}) {
  jest.resetModules();
  process.env = { ...ENV };
  delete process.env.MAIL_FROM;
  delete process.env.SMTP_FROM;
  delete process.env.MAIL_REPLY_TO;
  delete process.env.RESEND_API_KEY;
  delete process.env.SMTP_HOST;
  Object.assign(process.env, env);
  return require('../src/services/mailer');
}

function fetchFalso(id = 're_1') {
  const corpos = [];
  global.fetch = jest.fn(async (url, init) => {
    corpos.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ id }) };
  });
  return corpos;
}

let logs;
beforeEach(() => {
  logs = [];
  jest.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
  jest.spyOn(console, 'warn').mockImplementation((...a) => logs.push(a.join(' ')));
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...ENV };
});

describe('Resend', () => {
  test('padrões: remetente contato@ com nome, reply_to contato@, sem headers', async () => {
    const corpos = fetchFalso('re_42');
    const { sendMail } = carregarMailer({ RESEND_API_KEY: 'k' });
    const r = await sendMail({ to: 'cliente@exemplo.com', subject: 's', html: '<p>x</p>', text: 't' });

    expect(corpos[0].from).toBe('Caio Alexander, da Aura <contato@getaura.com.br>');
    expect(corpos[0].reply_to).toBe('contato@getaura.com.br');
    expect(corpos[0]).not.toHaveProperty('headers');
    expect(r.id).toBe('re_42');
  });

  test('replyTo e headers do envio são repassados', async () => {
    const corpos = fetchFalso();
    const { sendMail } = carregarMailer({ RESEND_API_KEY: 'k' });
    await sendMail({
      to: 'a@b.com', subject: 's', html: 'h', text: 't',
      replyTo: 'suporte@getaura.com.br',
      headers: { 'List-Unsubscribe': '<mailto:sair@getaura.com.br>', 'X-Ruim': 'a\r\nBcc: x@y.z' },
    });
    expect(corpos[0].reply_to).toBe('suporte@getaura.com.br');
    // Valor com quebra de linha (injeção de cabeçalho) fica de fora.
    expect(corpos[0].headers).toEqual({ 'List-Unsubscribe': '<mailto:sair@getaura.com.br>' });
  });

  test('MAIL_FROM e MAIL_REPLY_TO mandam; SMTP_FROM vale quando MAIL_FROM falta', async () => {
    let corpos = fetchFalso();
    let m = carregarMailer({ RESEND_API_KEY: 'k', MAIL_FROM: 'Aura <oi@getaura.com.br>', SMTP_FROM: 'X <noreply@getaura.com.br>', MAIL_REPLY_TO: 'resp@getaura.com.br' });
    await m.sendMail({ to: 'a@b.com', subject: 's', html: 'h', text: 't' });
    expect(corpos[0].from).toBe('Aura <oi@getaura.com.br>');
    expect(corpos[0].reply_to).toBe('resp@getaura.com.br');

    corpos = fetchFalso();
    m = carregarMailer({ RESEND_API_KEY: 'k', SMTP_FROM: 'X <noreply@getaura.com.br>' });
    await m.sendMail({ to: 'a@b.com', subject: 's', html: 'h', text: 't' });
    expect(corpos[0].from).toBe('X <noreply@getaura.com.br>');
  });

  test('opts.from: aceita @getaura.com.br, recusa outro domínio e quebra de linha', async () => {
    const corpos = fetchFalso();
    const { sendMail } = carregarMailer({ RESEND_API_KEY: 'k' });
    const base = { to: 'a@b.com', subject: 's', html: 'h', text: 't' };
    await sendMail({ ...base, from: 'Aura <contato@getaura.com.br>' });
    await sendMail({ ...base, from: 'avisos@GETAURA.com.br' });
    await sendMail({ ...base, from: 'Golpe <contato@getaura.com.br.evil.com>' });
    await sendMail({ ...base, from: 'Aura <x@outro.com>' });
    await sendMail({ ...base, from: 'Aura <contato@getaura.com.br>\r\nBcc: x@y.z' });
    await sendMail({ ...base, from: 'Sub <a@mail.getaura.com.br>' });

    const padrao = 'Caio Alexander, da Aura <contato@getaura.com.br>';
    expect(corpos.map((c) => c.from)).toEqual([
      'Aura <contato@getaura.com.br>',
      'avisos@GETAURA.com.br',
      padrao, padrao, padrao, padrao,
    ]);
  });

  test('log do envio tem o id e não o destinatário', async () => {
    fetchFalso('re_log');
    const { sendMail } = carregarMailer({ RESEND_API_KEY: 'k' });
    await sendMail({ to: 'segredo@exemplo.com', subject: 's', html: 'h', text: 't' });
    const tudo = logs.join('\n');
    expect(tudo).toContain('id=re_log');
    expect(tudo).not.toContain('segredo@exemplo.com');
  });

  test('relatório semanal sai como "Aura <contato@getaura.com.br>" com reply_to padrão', async () => {
    const corpos = fetchFalso('re_rel');
    const { sendWeeklyReport } = carregarMailer({ RESEND_API_KEY: 'k' });
    const r = await sendWeeklyReport(
      { name: 'Loja', email: 'dona@exemplo.com' },
      { revenue: 10, sales: 1, avg_ticket: 10, health_score: 80 },
      'https://app.getaura.com.br/relatorios/semanal/tok'
    );
    expect(corpos[0].from).toBe('Aura <contato@getaura.com.br>');
    expect(corpos[0].reply_to).toBe('contato@getaura.com.br');
    expect(corpos[0].to).toEqual(['dona@exemplo.com']);
    expect(corpos[0].html).toContain('href="https://app.getaura.com.br/relatorios/semanal/tok"');
    expect(r.id).toBe('re_rel');
  });
});

describe('SMTP (nodemailer)', () => {
  test('from, replyTo e headers vão ao nodemailer; devolve id = messageId', async () => {
    const enviados = [];
    jest.doMock('nodemailer', () => ({
      createTransport: () => ({
        sendMail: async (m) => { enviados.push(m); return { messageId: '<abc@smtp>', accepted: [m.to] }; },
      }),
    }));
    const { sendMail } = carregarMailer({ SMTP_HOST: 'smtp.exemplo' });
    const r = await sendMail({
      to: 'a@b.com', subject: 's', html: 'h', text: 't',
      from: 'Aura <x@hacker.com>',
      headers: { 'X-Aura-Envio': 'relatorio' },
    });
    expect(enviados[0].from).toBe('Caio Alexander, da Aura <contato@getaura.com.br>');
    expect(enviados[0].replyTo).toBe('contato@getaura.com.br');
    expect(enviados[0].headers).toEqual({ 'X-Aura-Envio': 'relatorio' });
    expect(r.id).toBe('<abc@smtp>');
    expect(r.messageId).toBe('<abc@smtp>');
    jest.dontMock('nodemailer');
  });
});

describe('dev (sem RESEND_API_KEY nem SMTP_HOST)', () => {
  test('devolve id dev-... e o log não traz o destinatário', async () => {
    const { sendMail } = carregarMailer();
    const r = await sendMail({ to: 'segredo@exemplo.com', subject: 'Assunto', text: 'link https://x.y/z' });
    expect(r.id).toMatch(/^dev-\d+$/);
    const tudo = logs.join('\n');
    expect(tudo).toContain(r.id);
    expect(tudo).not.toContain('segredo@exemplo.com');
  });
});
