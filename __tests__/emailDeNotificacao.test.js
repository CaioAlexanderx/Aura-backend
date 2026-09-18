// ============================================================
// E-mail de notificação de empresa específica (18/09/2026)
//
// Cobertura:
//  (1) destinatários: dono + empresa marcados e sem repetir; membros
//      desmarcados; empresa inexistente → 404.
//  (2) PIX: código inválido, valor e vencimento ruins → 400.
//  (3) montagem: QR Code vai como anexo cid e o <img> aponta pra ele;
//      sem PIX não há anexo; título/corpo escapados; botão só com http(s).
//  (4) envio: banner sem empresa → 400; endereço fora do cadastro → 400;
//      um e-mail por destinatário, cada um registrado; falha de um não
//      derruba o outro; tudo falhou → 502.
//  (5) lista: sem a tabela da migration 347 cai no formato antigo.
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: 'staff-1', role: 'admin' }; next(); },
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/mailer', () => {
  const actual = jest.requireActual('../src/services/mailer');
  return { ...actual, sendMail: jest.fn() };
});

const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');
const { sendMail } = require('../src/services/mailer');
const notificationEmail = require('../src/services/notificationEmail');
const { parsePix, buildNotificationEmail } = notificationEmail;

const COMPANY = '274994b3-6324-4e7b-942e-e6dd19666149';
const BANNER  = '8f6af433-9b4a-420f-82e2-ff157c2f5452';
const PIX = '00020101021226800014br.gov.bcb.pix2558pix.asaas.com/qr/cobv/2f87d4d0-3b19-4997-b90f-2627ff14b6bd5204000053039865802BR5909AURA LTDA6007Jacarei61081230581062070503***63048DA4';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/admin', require('../src/routes/adminNotifications'));
  return a;
}

const companyRow = {
  id: COMPANY, trade_name: 'FPKT', legal_name: 'Federação Paulista', vertical: 'karate_federation',
  company_email: 'Contato@FPKT.org.br', owner_email: 'contato@fpkt.org.br', owner_name: 'Dono',
};
const bannerRow = {
  id: BANNER, title: 'Lembrete de pagamento', body: 'Vence em 18/09.',
  cta_label: 'Abrir fatura', cta_url: 'https://www.asaas.com/i/x', target_company_id: COMPANY,
};

// Roteia o mock do banco pelo texto da query.
function dbRoutes(overrides = {}) {
  db.query.mockImplementation(async (sql) => {
    if (/FROM companies c/.test(sql))           return { rows: overrides.company === undefined ? [companyRow] : overrides.company };
    if (/FROM company_members m/.test(sql))     return { rows: overrides.members || [{ email: 'equipe@fpkt.org.br', full_name: 'Equipe' }] };
    if (/FROM app_notifications WHERE id/.test(sql)) return { rows: overrides.banner === undefined ? [bannerRow] : overrides.banner };
    if (/INSERT INTO app_notification_emails/.test(sql)) return { rows: [] };
    throw new Error('query inesperada: ' + sql.slice(0, 80));
  });
}

beforeEach(() => {
  db.query.mockReset();
  sendMail.mockReset();
  notificationEmail._resetForTests();
});

// ── (1) destinatários ────────────────────────────────────────
describe('GET /admin/notifications/recipients', () => {
  test('dono e empresa com o mesmo e-mail viram uma linha marcada; membro entra desmarcado', async () => {
    dbRoutes();
    const r = await request(app()).get('/admin/notifications/recipients').query({ company_id: COMPANY });
    expect(r.status).toBe(200);
    expect(r.body.company).toEqual({ id: COMPANY, name: 'FPKT', legal_name: 'Federação Paulista', vertical: 'karate_federation' });
    expect(r.body.recipients).toEqual([
      { email: 'contato@fpkt.org.br', sources: ['owner', 'company'], name: 'Dono', selected: true },
      { email: 'equipe@fpkt.org.br', sources: ['member'], name: 'Equipe', selected: false },
    ]);
  });

  test('empresa inexistente → 404; id malformado → 400 sem ir ao banco', async () => {
    dbRoutes({ company: [] });
    expect((await request(app()).get('/admin/notifications/recipients').query({ company_id: COMPANY })).status).toBe(404);
    db.query.mockClear();
    expect((await request(app()).get('/admin/notifications/recipients').query({ company_id: 'x' })).status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ── (2) PIX ──────────────────────────────────────────────────
describe('parsePix', () => {
  test('vazio = sem bloco PIX', () => {
    expect(parsePix(undefined)).toEqual({ pix: null });
    expect(parsePix({ code: '', amount: '', due_date: '' })).toEqual({ pix: null });
  });
  test('válido é normalizado', () => {
    expect(parsePix({ code: PIX, amount: 169, due_date: '2026-09-18' }))
      .toEqual({ pix: { code: PIX, amount: 169, dueDate: '2026-09-18' } });
  });
  test('erros de preenchimento', () => {
    expect(parsePix({ amount: 169 }).error).toMatch(/copia e cola/);
    expect(parsePix({ code: 'abc' }).error).toMatch(/inválido/);
    expect(parsePix({ code: PIX, amount: -1 }).error).toMatch(/Valor/);
    expect(parsePix({ code: PIX, due_date: '18/09/2026' }).error).toMatch(/AAAA-MM-DD/);
  });
});

// ── (3) montagem ─────────────────────────────────────────────
describe('buildNotificationEmail', () => {
  test('com PIX: QR como anexo cid, valor e vencimento formatados, código no texto', async () => {
    const e = await buildNotificationEmail({
      title: 'Lembrete', body: 'Linha 1\nLinha 2', ctaLabel: 'Abrir fatura', ctaUrl: 'https://x.com/i',
      pix: { code: PIX, amount: 1169, dueDate: '2026-09-18' },
    });
    expect(e.attachments).toHaveLength(1);
    expect(e.attachments[0].cid).toBe('pix-qrcode');
    expect(e.attachments[0].content.slice(0, 8).toString('hex')).toBe('89504e470d0a1a0a'); // PNG
    expect(e.html).toContain('src="cid:pix-qrcode"');
    expect(e.html).toContain('R$ 1.169,00');
    expect(e.html).toContain('18/09/2026');
    expect(e.html).toContain('Linha 1<br>Linha 2');
    expect(e.html).toContain('href="https://x.com/i"');
    expect(e.text).toContain('PIX copia e cola: ' + PIX);
  });

  test('sem PIX não há anexo; HTML do título é escapado; link não-http some', async () => {
    const e = await buildNotificationEmail({ title: '<b>oi</b>', ctaLabel: 'Ver', ctaUrl: 'javascript:alert(1)' });
    expect(e.attachments).toEqual([]);
    expect(e.html).toContain('&lt;b&gt;oi&lt;/b&gt;');
    expect(e.html).not.toContain('javascript:');
    expect(e.html).not.toContain('cid:');
  });
});

// ── (4) envio ────────────────────────────────────────────────
describe('POST /admin/notifications/banners/:nid/email', () => {
  const url = `/admin/notifications/banners/${BANNER}/email`;

  test('envia um e-mail por destinatário e registra cada envio', async () => {
    dbRoutes();
    sendMail.mockResolvedValueOnce({ id: 're_1' }).mockResolvedValueOnce({ id: 're_2' });
    const r = await request(app()).post(url).send({
      recipients: ['Contato@FPKT.org.br', 'equipe@fpkt.org.br'],
      subject: 'Lembrete: vence 18/09',
      pix: { code: PIX, amount: 169, due_date: '2026-09-18' },
    });
    expect(r.status).toBe(200);
    expect(r.body.sent.map((s) => s.email)).toEqual(['contato@fpkt.org.br', 'equipe@fpkt.org.br']);
    expect(sendMail).toHaveBeenCalledTimes(2);
    const first = sendMail.mock.calls[0][0];
    expect(first.to).toBe('contato@fpkt.org.br');
    expect(first.subject).toBe('Lembrete: vence 18/09');
    expect(first.attachments[0].cid).toBe('pix-qrcode');

    const logs = db.query.mock.calls.filter(([sql]) => /INSERT INTO app_notification_emails/.test(sql));
    expect(logs).toHaveLength(2);
    expect(logs[0][1]).toEqual([BANNER, COMPANY, 'contato@fpkt.org.br', 'Lembrete: vence 18/09', 'sent', 're_1', null, 'staff-1']);
  });

  test('assunto vazio usa o título do banner', async () => {
    dbRoutes();
    sendMail.mockResolvedValue({ id: 're_1' });
    await request(app()).post(url).send({ recipients: ['contato@fpkt.org.br'] });
    expect(sendMail.mock.calls[0][0].subject).toBe('Lembrete de pagamento');
  });

  test('falha de um destinatário não derruba o outro; tudo falhou → 502', async () => {
    dbRoutes();
    sendMail.mockRejectedValueOnce(new Error('Resend API 422')).mockResolvedValueOnce({ id: 're_2' });
    const r = await request(app()).post(url).send({ recipients: ['contato@fpkt.org.br', 'equipe@fpkt.org.br'] });
    expect(r.status).toBe(200);
    expect(r.body.failed).toEqual([{ email: 'contato@fpkt.org.br', error: 'Resend API 422' }]);
    expect(r.body.sent).toHaveLength(1);

    sendMail.mockReset();
    sendMail.mockRejectedValue(new Error('fora do ar'));
    const r2 = await request(app()).post(url).send({ recipients: ['contato@fpkt.org.br'] });
    expect(r2.status).toBe(502);
  });

  test('endereço fora do cadastro da empresa → 400 e nada é enviado', async () => {
    dbRoutes();
    const r = await request(app()).post(url).send({ recipients: ['alguem@gmail.com'] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('DESTINATARIO_FORA_DA_EMPRESA');
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('banner para todos (sem empresa) → 400', async () => {
    dbRoutes({ banner: [{ ...bannerRow, target_company_id: null }] });
    const r = await request(app()).post(url).send({ recipients: ['contato@fpkt.org.br'] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('BANNER_SEM_EMPRESA');
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('sem destinatário, PIX inválido ou banner inexistente', async () => {
    dbRoutes();
    expect((await request(app()).post(url).send({ recipients: [] })).status).toBe(400);
    expect((await request(app()).post(url).send({ recipients: ['contato@fpkt.org.br'], pix: { code: 'x' } })).status).toBe(400);
    dbRoutes({ banner: [] });
    expect((await request(app()).post(url).send({ recipients: ['contato@fpkt.org.br'] })).status).toBe(404);
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('sem a tabela de registro (migration 347) o e-mail sai mesmo assim', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/INSERT INTO app_notification_emails/.test(sql)) { const e = new Error('relation does not exist'); e.code = '42P01'; throw e; }
      if (/FROM companies c/.test(sql)) return { rows: [companyRow] };
      if (/FROM company_members m/.test(sql)) return { rows: [] };
      return { rows: [bannerRow] };
    });
    sendMail.mockResolvedValue({ id: 're_1' });
    const r = await request(app()).post(url).send({ recipients: ['contato@fpkt.org.br'] });
    expect(r.status).toBe(200);
    expect(r.body.sent).toHaveLength(1);
  });
});

// ── (5) lista ────────────────────────────────────────────────
describe('GET /admin/notifications/banners', () => {
  test('traz last_emailed_at; sem a tabela, cai no formato antigo', async () => {
    db.query.mockImplementationOnce(async (sql) => {
      expect(sql).toContain('last_emailed_at');
      const e = new Error('relation does not exist'); e.code = '42P01'; throw e;
    }).mockImplementationOnce(async (sql) => {
      expect(sql).not.toContain('app_notification_emails');
      return { rows: [{ id: BANNER }] };
    });
    const r = await request(app()).get('/admin/notifications/banners');
    expect(r.status).toBe(200);
    expect(r.body.banners).toEqual([{ id: BANNER }]);
  });
});
