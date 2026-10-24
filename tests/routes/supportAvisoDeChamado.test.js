// ============================================================
// AURA. -- Testes: chamado de suporte avisa a equipe (24/10/2026)
//
// POST /support/tickets e a resposta do cliente em
// POST /support/tickets/:tid/messages so gravavam no banco. Agora cada chamado
// novo e cada mensagem nova do cliente mandam (a) e-mail interno para
// CS_NOTIFY_EMAIL e (b) aviso no sino da empresa Aura, com idempotencia por
// chamado + mensagem. O aviso NUNCA muda a resposta da rota.
//
// Sem Postgres no CI: o banco e simulado por conteudo do SQL; e-mail e sino
// sao dobles (nada de Resend nem de banco de verdade).
// ============================================================
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../../src/services/emailLog', () => ({
  enviarEmailRegistrado: jest.fn(),
}));
jest.mock('../../src/services/appNotifications', () => ({
  notifyCompany: jest.fn(),
}));

let db;
let emailLog;
let notifications;
let router;
const SECRET = 'aura-test-secret-2026';
const CID = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const TID = 'eeeeeeee-0000-0000-0000-000000000001';
const MID = 'ffffffff-0000-0000-0000-000000000002';
const AURA = '645c1325-8865-48be-af6f-430d93fb2b6c';
const auth = { Authorization: `Bearer ${jwt.sign({ id: 'u1', role: 'client', plan: 'negocio' }, SECRET, { expiresIn: '1h' })}` };
const LINK = `https://app.getaura.com.br/gestao-aura?chamado=${TID}`;

const ticketRow = {
  id: TID, company_id: CID, user_id: 'u1', subject: 'Impressora nao imprime',
  category: 'suporte', priority: 'normal', status: 'aberto',
};

function bancoSimulado({ ticketExiste = true } = {}) {
  db.query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (/INSERT INTO support_tickets/.test(s)) return { rows: [ticketRow] };
    if (/INSERT INTO support_messages/.test(s)) return { rows: [{ id: MID, ticket_id: TID, message: 'texto' }] };
    if (/FROM support_tickets WHERE id/.test(s)) return { rows: ticketExiste ? [ticketRow] : [] };
    if (/UPDATE support_tickets/.test(s)) return { rows: [] };
    if (/FROM companies c/.test(s)) {
      return { rows: [{ loja: 'Loja da Vera', quem: 'Vera Lima', email: 'vera@example.com' }] };
    }
    return { rows: [] };
  });
}

// O aviso roda depois do res.json: solta o laco de eventos para ele terminar.
const esperarAvisos = () => new Promise((r) => setImmediate(() => setImmediate(r)));

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/companies/:id/support', router);
  return a;
}

beforeAll(() => {
  db = require('../../src/config/database');
  emailLog = require('../../src/services/emailLog');
  notifications = require('../../src/services/appNotifications');
  router = require('../../src/routes/support');
});

beforeEach(() => {
  jest.resetAllMocks();
  delete process.env.CS_NOTIFY_EMAIL;
  delete process.env.AURA_ALERTA_COMPANY_ID;
  delete process.env.APP_URL;
  bancoSimulado();
  emailLog.enviarEmailRegistrado.mockResolvedValue({ status: 'sent', id: 1 });
  notifications.notifyCompany.mockResolvedValue({ id: 'n1' });
});

describe('POST /support/tickets', () => {
  const corpo = { subject: 'Impressora nao imprime', message: 'Desde hoje cedo nada sai da etiqueta.' };
  const criar = () => request(app()).post(`/api/v1/companies/${CID}/support/tickets`).set(auth);

  test('chamado novo: 1 e-mail interno e 1 aviso no sino da Aura', async () => {
    const res = await criar().send(corpo);
    await esperarAvisos();
    expect(res.status).toBe(201);
    expect(res.body.ticket.id).toBe(TID);

    expect(emailLog.enviarEmailRegistrado).toHaveBeenCalledTimes(1);
    const mail = emailLog.enviarEmailRegistrado.mock.calls[0][0];
    expect(mail.to).toBe('contato@getaura.com.br');
    expect(mail.chave).toBe(`chamado:${TID}:${MID}`);
    expect(mail.tipo).toBe('chamado_novo_interno');
    expect(mail.replyTo).toBe('vera@example.com');
    expect(mail.subject).toBe('Chamado novo: Impressora nao imprime — Loja da Vera');
    // loja, quem abriu, assunto, mensagem e link do chamado
    for (const trecho of ['Loja da Vera', 'Vera Lima', 'vera@example.com', 'Impressora nao imprime', 'Desde hoje cedo nada sai da etiqueta.', LINK]) {
      expect(mail.html).toContain(trecho);
      expect(mail.text).toContain(trecho);
    }

    expect(notifications.notifyCompany).toHaveBeenCalledTimes(1);
    const [empresa, aviso] = notifications.notifyCompany.mock.calls[0];
    expect(empresa).toBe(AURA);
    expect(aviso.title).toBe('Chamado novo: Loja da Vera');
    expect(aviso.body).toContain('Vera Lima');
    expect(aviso.body).toContain('Desde hoje cedo');
    expect(aviso.ctaUrl).toBe(LINK);
    expect(aviso.dedupeKey).toBe(`chamado:${TID}:${MID}`);
  });

  test('CS_NOTIFY_EMAIL e AURA_ALERTA_COMPANY_ID mudam os destinos', async () => {
    process.env.CS_NOTIFY_EMAIL = 'cs@getaura.com.br';
    process.env.AURA_ALERTA_COMPANY_ID = 'bbbbbbbb-1111-2222-3333-444444444444';
    await criar().send(corpo);
    await esperarAvisos();
    expect(emailLog.enviarEmailRegistrado.mock.calls[0][0].to).toBe('cs@getaura.com.br');
    expect(notifications.notifyCompany.mock.calls[0][0]).toBe('bbbbbbbb-1111-2222-3333-444444444444');
  });

  test('mensagem do cliente com HTML sai escapada no e-mail', async () => {
    await criar().send({ subject: 'Teste', message: '<script>alert(1)</script>' });
    await esperarAvisos();
    const { html } = emailLog.enviarEmailRegistrado.mock.calls[0][0];
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('o aviso falhando no sino nao muda a resposta 201 (e o e-mail sai igual)', async () => {
    notifications.notifyCompany.mockRejectedValue(new Error('banco do sino fora'));
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await criar().send(corpo);
    await esperarAvisos();
    expect(res.status).toBe(201);
    expect(res.body.ticket.id).toBe(TID);
    expect(emailLog.enviarEmailRegistrado).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('sino falhou'));
    log.mockRestore();
  });

  test('o e-mail lancando erro nao muda a resposta 201 e o sino sai igual', async () => {
    emailLog.enviarEmailRegistrado.mockRejectedValue(new Error('Resend fora'));
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await criar().send(corpo);
    await esperarAvisos();
    expect(res.status).toBe(201);
    expect(notifications.notifyCompany).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  test('e-mail que volta failed so vai ao log; a resposta continua 201', async () => {
    emailLog.enviarEmailRegistrado.mockResolvedValue({ status: 'failed', error: 'Resend 500' });
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await criar().send(corpo);
    await esperarAvisos();
    expect(res.status).toBe(201);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('e-mail não saiu'));
    log.mockRestore();
  });

  test('falha ao ler loja e autor nao impede o aviso', async () => {
    db.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (/INSERT INTO support_tickets/.test(s)) return { rows: [ticketRow] };
      if (/INSERT INTO support_messages/.test(s)) return { rows: [{ id: MID }] };
      if (/FROM companies c/.test(s)) throw new Error('timeout');
      return { rows: [] };
    });
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await criar().send(corpo);
    await esperarAvisos();
    expect(res.status).toBe(201);
    expect(emailLog.enviarEmailRegistrado).toHaveBeenCalledTimes(1);
    expect(notifications.notifyCompany).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  test('sem assunto ou mensagem: 400 e ninguem e avisado', async () => {
    const res = await criar().send({ subject: 'x' });
    await esperarAvisos();
    expect(res.status).toBe(400);
    expect(emailLog.enviarEmailRegistrado).not.toHaveBeenCalled();
    expect(notifications.notifyCompany).not.toHaveBeenCalled();
  });
});

describe('POST /support/tickets/:tid/messages', () => {
  const responder = () => request(app()).post(`/api/v1/companies/${CID}/support/tickets/${TID}/messages`).set(auth);

  test('mensagem nova do cliente: 1 e-mail e 1 aviso, com chave por chamado + mensagem', async () => {
    const res = await responder().send({ message: 'Ainda nao resolveu.' });
    await esperarAvisos();
    expect(res.status).toBe(201);
    expect(emailLog.enviarEmailRegistrado).toHaveBeenCalledTimes(1);
    const mail = emailLog.enviarEmailRegistrado.mock.calls[0][0];
    expect(mail.tipo).toBe('chamado_mensagem_interno');
    expect(mail.chave).toBe(`chamado:${TID}:${MID}`);
    expect(mail.subject).toBe('Nova mensagem no chamado: Impressora nao imprime — Loja da Vera');
    expect(mail.html).toContain('Ainda nao resolveu.');
    expect(mail.html).toContain(LINK);
    expect(notifications.notifyCompany).toHaveBeenCalledTimes(1);
    expect(notifications.notifyCompany.mock.calls[0][1].title).toBe('Nova mensagem no chamado: Loja da Vera');
    expect(notifications.notifyCompany.mock.calls[0][1].dedupeKey).toBe(`chamado:${TID}:${MID}`);
  });

  test('aviso falhando nao muda a resposta 201', async () => {
    emailLog.enviarEmailRegistrado.mockRejectedValue(new Error('x'));
    notifications.notifyCompany.mockRejectedValue(new Error('y'));
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await responder().send({ message: 'Oi' });
    await esperarAvisos();
    expect(res.status).toBe(201);
    log.mockRestore();
  });

  test('chamado de outra empresa: 404 e ninguem e avisado', async () => {
    bancoSimulado({ ticketExiste: false });
    const res = await responder().send({ message: 'Oi' });
    await esperarAvisos();
    expect(res.status).toBe(404);
    expect(emailLog.enviarEmailRegistrado).not.toHaveBeenCalled();
    expect(notifications.notifyCompany).not.toHaveBeenCalled();
  });
});
