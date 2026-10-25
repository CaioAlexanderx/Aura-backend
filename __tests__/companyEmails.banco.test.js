// ============================================================
// AURA. — Configurações > E-mails no Postgres de verdade (tq-87, tq-88,
// tq-90; migration 409; 24/10/2026)
//
// Rotas por empresa (só o dono), confirmação de endereço, scheduler
// (quem entra no relatório), "me enviar um agora" com limite, últimos
// e-mails e o webhook do Resend, tudo numa transação revertida no banco do
// CI. Mesmo padrão de emailsCobranca.banco.test.js: o db mockado do
// jest.setup é redirecionado para a conexão desta transação.
// ============================================================
'use strict';

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

jest.mock('../src/services/reportGenerator', () => {
  const real = jest.requireActual('../src/services/reportGenerator');
  return { ...real, generateReport: jest.fn(), generateConsolidatedReport: jest.fn() };
});

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';
const SECRET = 'aura-test-secret-2026';
const WHSEC = 'whsec_' + Buffer.from('segredo-de-teste-do-webhook-resend').toString('base64');

const ENV = { ...process.env };
let pool;
let client;
let app;
const P = require('../src/services/emailPreferencias');
const links = require('../src/services/emailLinks');
const reportGenerator = require('../src/services/reportGenerator');

const dono = uuid();
const vendedor = uuid();
const empresa = uuid();
const base = `/companies/${empresa}/emails`;
const token = (id) => ({ Authorization: `Bearer ${jwt.sign({ id, role: 'client', plan: 'negocio', company: empresa }, SECRET, { expiresIn: '1h' })}` });
const EMAIL_DONO = `dona-${dono.slice(0, 8)}@example.test`;

async function q(sql, params) { return client.query(sql, params); }

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');
  const db = require('../src/config/database');
  let fila = Promise.resolve();
  db.query.mockImplementation((sql, params) => {
    const p = fila.then(() => client.query(sql, params));
    fila = p.catch(() => {});
    return p;
  });

  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Maria Dona'), ($3, $4, 'x', 'Vendedor')`,
    [dono, EMAIL_DONO, vendedor, `vend-${vendedor.slice(0, 8)}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, email, plan, billing_status)
           VALUES ($1, $2, 'Modas Fixture LTDA', 'Modas Fixture', 'loja@example.test', 'negocio', 'active')`, [empresa, dono]);
  await q(`INSERT INTO company_members (company_id, user_id, role_label, status, is_active) VALUES ($1, $2, 'vendedor', 'active', true)`,
    [empresa, vendedor]);

  const { requireAuth, requireCompanyAccess } = require('../src/middleware/auth');
  app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(express.urlencoded({ extended: true }));
  app.use('/companies/:id/emails', requireAuth, requireCompanyAccess(), require('../src/routes/companyEmails'));
  app.use('/emails', require('../src/routes/emailPublico'));
  app.use('/webhooks/resend', require('../src/routes/webhookResend'));
});

beforeEach(() => {
  process.env = { ...ENV };
  delete process.env.RESEND_API_KEY;
  delete process.env.SMTP_HOST;
  delete process.env.RESEND_WEBHOOK_SECRET;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  process.env = { ...ENV };
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

describe('rotas por empresa (só o dono)', () => {
  test('funcionário recebe 403; sem login 401', async () => {
    expect((await request(app).get(base).set(token(vendedor))).status).toBe(403);
    expect((await request(app).put(base).set(token(vendedor)).send({ novidades: { ligado: false } })).status).toBe(403);
    expect((await request(app).get(base)).status).toBe(401);
  });

  test('GET sem linha nenhuma: os padrões do Caio e o e-mail do dono como principal', async () => {
    const r = await request(app).get(base).set(token(dono));
    expect(r.status).toBe(200);
    expect(r.body.enderecos).toEqual([expect.objectContaining({ id: null, email: EMAIL_DONO, principal: true, confirmado: true })]);
    expect(r.body.preferencias.relatorio).toMatchObject({ ligado: true, explicito: false, dia: 1, hora: 8, versao: 'completa', destinatarios: null, destinatarios_efetivos: [EMAIL_DONO] });
    expect(r.body.preferencias.relatorio.blocos).toEqual([...P.BLOCOS]);
    for (const t of ['ajuda', 'acompanhamento', 'novidades']) expect(r.body.preferencias[t].ligado).toBe(true);
    expect(r.body.preferencias.pedido_loja).toMatchObject({ ligado: true, pedido_destino: 'equipe', pedido_destino_escolhido: false });
    expect(r.body.sempre_enviamos).toEqual(['cobranca', 'seguranca']);
    expect(r.body.blocos_do_plano).toEqual([...P.BLOCOS]);
    expect(r.body.limites).toEqual({ enderecos_extras: 5, relatorio_agora_por_dia: 3 });
  });

  test('PUT inválido: 400 e nada grava', async () => {
    for (const corpo of [{ relatorio: { dia: 9 } }, { cobranca: { ligado: false } }, { relatorio: { destinatarios: ['estranho@x.test'] } }]) {
      expect((await request(app).put(base).set(token(dono)).send(corpo)).status).toBe(400);
    }
    const { rows } = await q('SELECT 1 FROM company_email_prefs WHERE company_id = $1', [empresa]);
    expect(rows).toHaveLength(0);
  });

  test('PUT grava só o que mudou; desligar o relatório espelha weekly_report_enabled; tipoLigado vale na hora', async () => {
    let r = await request(app).put(base).set(token(dono)).send({
      relatorio: { dia: 5, hora: 18, blocos: ['vendas', 'clientes'] },
      novidades: { ligado: false },
    });
    expect(r.status).toBe(200);
    expect(r.body.preferencias.relatorio).toMatchObject({ ligado: true, explicito: true, dia: 5, hora: 18, blocos: ['vendas', 'clientes'] });
    expect(r.body.preferencias.novidades.ligado).toBe(false);
    const db = require('../src/config/database');
    expect(await P.tipoLigado(db, empresa, 'novidades')).toBe(false);
    expect(await P.tipoLigado(db, empresa, 'acompanhamento')).toBe(true);
    expect(await P.tipoLigado(db, empresa, 'cobranca')).toBe(true);

    r = await request(app).put(base).set(token(dono)).send({ relatorio: { ligado: false } });
    expect(r.body.preferencias.relatorio).toMatchObject({ ligado: false, dia: 5, hora: 18 });
    const { rows: [c] } = await q('SELECT weekly_report_enabled FROM companies WHERE id = $1', [empresa]);
    expect(c.weekly_report_enabled).toBe(false);
    r = await request(app).put(base).set(token(dono)).send({ relatorio: { ligado: true } });
    expect(r.body.preferencias.relatorio.ligado).toBe(true);
    const { rows: [c2] } = await q('SELECT weekly_report_enabled FROM companies WHERE id = $1', [empresa]);
    expect(c2.weekly_report_enabled).toBe(true);
  });
});

describe('endereços extras', () => {
  let enderecoId;

  test('POST manda o link (email_log) e o extra só recebe depois de confirmar', async () => {
    expect((await request(app).post(`${base}/enderecos`).set(token(dono)).send({ email: 'nao-e-email' })).status).toBe(400);
    expect((await request(app).post(`${base}/enderecos`).set(token(dono)).send({ email: EMAIL_DONO.toUpperCase() })).body.code).toBe('EMAIL_PRINCIPAL');

    const r = await request(app).post(`${base}/enderecos`).set(token(dono)).send({ email: 'Financeiro@Fixture.test' });
    expect(r.status).toBe(201);
    expect(r.body.endereco).toMatchObject({ email: 'financeiro@fixture.test', confirmado: false });
    expect(r.body.confirmacao).toBe('sent');
    enderecoId = r.body.endereco.id;
    const { rows: log } = await q(`SELECT status, tipo, destinatario, chave_idempotencia FROM email_log WHERE company_id = $1 AND tipo = 'confirmacao_endereco'`, [empresa]);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: 'sent', destinatario: 'financeiro@fixture.test' });

    // De novo na mesma hora: não manda outro.
    const r2 = await request(app).post(`${base}/enderecos`).set(token(dono)).send({ email: 'financeiro@fixture.test' });
    expect(r2.body.confirmacao).toBe('duplicate');

    const db = require('../src/config/database');
    expect(await P.destinatariosDoTipo(db, empresa, 'relatorio')).toEqual([EMAIL_DONO]);
  });

  test('marcar destinatário desconhecido falha; marcar o extra (ainda sem confirmar) é aceito', async () => {
    expect((await request(app).put(base).set(token(dono)).send({ relatorio: { destinatarios: ['outro@x.test'] } })).status).toBe(400);
    const r = await request(app).put(base).set(token(dono)).send({ relatorio: { destinatarios: [EMAIL_DONO, 'financeiro@fixture.test'] } });
    expect(r.status).toBe(200);
    expect(r.body.preferencias.relatorio.destinatarios_efetivos).toEqual([EMAIL_DONO]);
  });

  test('GET público de confirmação confirma; o extra passa a receber', async () => {
    const t = links.tokenConfirmacao({ enderecoId, companyId: empresa, email: 'financeiro@fixture.test' });
    const r = await request(app).get('/emails/confirmar/' + t);
    expect(r.status).toBe(200);
    expect(r.text).toContain('da Modas Fixture');
    const db = require('../src/config/database');
    expect(await P.destinatariosDoTipo(db, empresa, 'relatorio')).toEqual([EMAIL_DONO, 'financeiro@fixture.test']);
    const g = await request(app).get(base).set(token(dono));
    expect(g.body.enderecos[1]).toMatchObject({ email: 'financeiro@fixture.test', confirmado: true });
  });

  test('pedido novo: "só os e-mails da tela" usa os confirmados marcados; sem escolha, a equipe', async () => {
    const db = require('../src/config/database');
    expect(await P.destinoDoPedido(db, empresa)).toEqual({ ligado: true, destino: 'equipe', emails: null });
    await request(app).put(base).set(token(dono)).send({ pedido_loja: { pedido_destino: 'enderecos', destinatarios: ['financeiro@fixture.test'] } });
    expect(await P.destinoDoPedido(db, empresa)).toEqual({ ligado: true, destino: 'enderecos', emails: ['financeiro@fixture.test'] });
    await request(app).put(base).set(token(dono)).send({ pedido_loja: { ligado: false } });
    expect((await P.destinoDoPedido(db, empresa)).ligado).toBe(false);
    await request(app).put(base).set(token(dono)).send({ pedido_loja: { ligado: true, pedido_destino: 'equipe', destinatarios: null } });
  });

  test('DELETE remove (o link antigo deixa de valer); de novo dá 404', async () => {
    const t = links.tokenConfirmacao({ enderecoId, companyId: empresa, email: 'financeiro@fixture.test' });
    expect((await request(app).delete(`${base}/enderecos/${enderecoId}`).set(token(dono))).status).toBe(200);
    expect((await request(app).delete(`${base}/enderecos/${enderecoId}`).set(token(dono))).status).toBe(404);
    expect((await request(app).get('/emails/confirmar/' + t)).status).toBe(404);
    const db = require('../src/config/database');
    expect(await P.destinatariosDoTipo(db, empresa, 'relatorio')).toEqual([EMAIL_DONO]);
  });
});

describe('scheduler: quem entra no relatório', () => {
  const ids = {};
  beforeAll(async () => {
    const staff = uuid();
    await q(`INSERT INTO users (id, email, password_hash, full_name, is_staff) VALUES ($1, $2, 'x', 'Staff', true)`, [staff, `staff-${staff.slice(0, 8)}@example.test`]);
    const casos = [
      ['trialVigente', dono, `billing_status = 'trial', trial_ends_at = NOW() + interval '3 days'`],
      ['trialVencido', dono, `billing_status = 'trial', trial_ends_at = NOW() - interval '1 day'`],
      ['atraso', dono, `billing_status = 'overdue'`],
      ['cancelada', dono, `billing_status = 'cancelled'`],
      ['sandbox', dono, `billing_status = 'active', is_sandbox = true`],
      ['inativa', dono, `billing_status = 'active', is_active = false`],
      ['karate', dono, `billing_status = 'active', vertical = 'karate_dojo'`],
      ['internaSemLinha', staff, `billing_status = 'active'`],
      ['internaLigada', staff, `billing_status = 'active'`],
      ['descadastrada', dono, `billing_status = 'active'`],
    ];
    for (const [nome, owner, set] of casos) {
      ids[nome] = uuid();
      await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, $3)`, [ids[nome], owner, 'Fixture ' + nome]);
      await q(`UPDATE companies SET ${set} WHERE id = $1`, [ids[nome]]);
    }
    await q(`INSERT INTO company_email_prefs (company_id, tipo, ligado) VALUES ($1, 'relatorio', true), ($2, 'relatorio', false)`,
      [ids.internaLigada, ids.descadastrada]);
  });

  test('teste vigente e ativa entram; vencido, atraso, cancelada, sandbox, inativa, Karatê, interna sem linha e descadastrada não', async () => {
    const { empresasElegiveis } = require('../src/jobs/reportScheduler');
    const rows = await empresasElegiveis();
    const dentro = new Set(rows.map((r) => r.id));
    expect(dentro.has(empresa)).toBe(true);
    expect(dentro.has(ids.trialVigente)).toBe(true);
    expect(dentro.has(ids.internaLigada)).toBe(true);
    for (const fora of ['trialVencido', 'atraso', 'cancelada', 'sandbox', 'inativa', 'karate', 'internaSemLinha', 'descadastrada']) {
      expect([fora, dentro.has(ids[fora])]).toEqual([fora, false]);
    }
  });

  test('kill switch RELATORIO_PADRAO_LIGADO=false: só quem tem linha ligada', async () => {
    const { empresasElegiveis } = require('../src/jobs/reportScheduler');
    const rows = await empresasElegiveis({ env: { RELATORIO_PADRAO_LIGADO: 'false' } });
    const dentro = new Set(rows.map((r) => r.id));
    expect(dentro.has(ids.trialVigente)).toBe(false);
    expect(dentro.has(empresa)).toBe(true); // linha explícita ligada (PUT acima)
    expect(dentro.has(ids.internaLigada)).toBe(true);
  });

  test('multi-CNPJ: as empresas do mesmo dono viram um grupo consolidado, com a primária decidindo dia e hora', async () => {
    const { getEligibleOwnerGroups } = require('../src/jobs/reportScheduler');
    await q('UPDATE companies SET is_primary = true WHERE id = $1', [empresa]);
    const grupos = await getEligibleOwnerGroups();
    const g = grupos.find((x) => x.owner_id === dono);
    expect(g.primary.id).toBe(empresa);
    expect(g.all.map((c) => c.id).sort()).toEqual([empresa, ids.trialVigente].sort());
    expect(g.config).toMatchObject({ dia: 5, hora: 18 });
  });
});

describe('scheduler: conta "Não quer" fora do relatório (tq-110)', () => {
  const dono2 = uuid();
  const dono3 = uuid();
  const e = {};

  async function nota(cid, autor, resultado, motivo, minutosAtras) {
    await q(
      `INSERT INTO company_admin_notes (company_id, author_user_id, body, canal, resultado, motivo, created_at)
       VALUES ($1, $2, 'fixture', 'whatsapp', $3, $4, NOW() - ($5 || ' minutes')::interval)`,
      [cid, autor, resultado, motivo, String(minutosAtras)]
    );
  }

  beforeAll(async () => {
    await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Dono Dois'), ($3, $4, 'x', 'Dono Tres')`,
      [dono2, `dono2-${dono2.slice(0, 8)}@example.test`, dono3, `dono3-${dono3.slice(0, 8)}@example.test`]);
    const casos = [
      ['matrizMarcada', dono2, true], ['filialLimpa', dono2, false], ['filialDesmarcada', dono2, false],
      ['soMarcadaA', dono3, true], ['soMarcadaB', dono3, false],
    ];
    for (const [nome, owner, primaria] of casos) {
      e[nome] = uuid();
      await q(`INSERT INTO companies (id, owner_id, legal_name, billing_status, is_primary) VALUES ($1, $2, $3, 'active', $4)`,
        [e[nome], owner, 'Fixture ' + nome, primaria]);
    }
    await nota(e.matrizMarcada, dono2, 'nao_quer', 'preco_plano', 60);
    await nota(e.filialDesmarcada, dono2, 'nao_quer', 'preco_plano', 60);
    await nota(e.filialDesmarcada, dono2, 'quer_assinar', null, 10);
    await nota(e.soMarcadaA, dono3, 'nao_quer', 'concorrente', 60);
    await nota(e.soMarcadaB, dono3, 'nao_quer', 'atrito_produto', 30);
  });

  test('a marcada sai; nota posterior "quer_assinar" volta; no consolidado ela sai do grupo; todas marcadas, nada sai', async () => {
    const { empresasElegiveis, getEligibleOwnerGroups } = require('../src/jobs/reportScheduler');
    const dentro = new Set((await empresasElegiveis()).map((r) => r.id));
    expect(dentro.has(e.matrizMarcada)).toBe(false);
    expect(dentro.has(e.filialLimpa)).toBe(true);
    expect(dentro.has(e.filialDesmarcada)).toBe(true);
    expect(dentro.has(e.soMarcadaA)).toBe(false);
    expect(dentro.has(e.soMarcadaB)).toBe(false);

    const grupos = await getEligibleOwnerGroups();
    const g2 = grupos.find((x) => x.owner_id === dono2);
    expect(g2.all.map((x) => x.id).sort()).toEqual([e.filialLimpa, e.filialDesmarcada].sort());
    expect(g2.primary.id).not.toBe(e.matrizMarcada);
    expect(grupos.find((x) => x.owner_id === dono3)).toBeUndefined();
  });
});

describe('"me enviar um agora"', () => {
  test('manda para o dono, não conta como envio da semana e para no terceiro do dia', async () => {
    reportGenerator.generateReport.mockResolvedValue({
      skipped: false, deliveryId: null,
      company: { id: empresa, name: 'Modas Fixture', recipient_email: EMAIL_DONO },
      kpis: { revenue: 10, sales: 1, avg_ticket: 10, health_score: 50 },
      reportUrl: 'https://app.getaura.com.br/relatorios/semanal/tok',
    });
    for (let i = 1; i <= 3; i++) {
      const r = await request(app).post(`${base}/relatorio/enviar-agora`).set(token(dono));
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, para: EMAIL_DONO, restantes: 3 - i });
    }
    const r4 = await request(app).post(`${base}/relatorio/enviar-agora`).set(token(dono));
    expect(r4.status).toBe(429);
    expect(r4.body.code).toBe('LIMITE_DIARIO');
    // tq-85: com a config do relatório da empresa (versão e blocos).
    expect(reportGenerator.generateReport).toHaveBeenCalledWith(empresa, 'weekly', null, {
      destinatarios: [EMAIL_DONO], semEntrega: true, config: expect.objectContaining({ versao: 'completa' }),
    });
    const { rows } = await q(`SELECT count(*)::int AS n FROM email_log WHERE company_id = $1 AND chave_idempotencia LIKE 'relatorio-agora:%' AND status = 'sent'`, [empresa]);
    expect(rows[0].n).toBe(3);
    expect((await request(app).post(`${base}/relatorio/enviar-agora`).set(token(vendedor))).status).toBe(403);
  });
});

describe('últimos e-mails e webhook do Resend', () => {
  const ids = {};
  beforeAll(async () => {
    const ins = async (nome, campos) => {
      const { rows } = await q(
        `INSERT INTO email_log (company_id, tipo, assunto, destinatario, status, resend_id, sent_at, delivered_at, bounced_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8) RETURNING id`,
        [empresa, campos.tipo || 'cobranca_vence_hoje', campos.assunto || nome, EMAIL_DONO, campos.status || 'sent',
          campos.resend_id || null, campos.delivered_at || null, campos.bounced_at || null]
      );
      ids[nome] = rows[0].id;
    };
    await ins('entregue', { resend_id: 're_entregue', delivered_at: new Date() });
    await ins('devolvido', { resend_id: 're_devolvido', bounced_at: new Date() });
    await ins('falhou', { status: 'failed' });
    await ins('reservado', { status: 'reserved' });
    await ins('cliente', { tipo: 'pedido_status_cliente' });
    await ins('webhook', { resend_id: 're_webhook', tipo: 'acompanhamento_sumiu' });
    await q(`UPDATE email_log SET created_at = NOW() - interval '31 days' WHERE id = $1`, [ids.falhou]);
  });

  test('sem o webhook ligado nunca mostra Entregue; reservado, e-mail ao cliente final e mais de 30 dias ficam fora', async () => {
    const r = await request(app).get(`${base}/ultimos`).set(token(dono));
    expect(r.status).toBe(200);
    expect(r.body.webhook_ligado).toBe(false);
    const porAssunto = Object.fromEntries(r.body.emails.map((e) => [e.assunto, e.situacao]));
    expect(porAssunto.entregue).toBe('enviado');
    expect(porAssunto.devolvido).toBe('devolvido');
    expect(porAssunto.falhou).toBeUndefined();
    expect(porAssunto.reservado).toBeUndefined();
    expect(porAssunto.cliente).toBeUndefined();
    expect(r.body.emails.every((e) => e.situacao !== 'entregue')).toBe(true);
  });

  function assinado(corpo, { ts = Math.floor(Date.now() / 1000), id = 'msg_' + uuid(), segredo = WHSEC } = {}) {
    const chave = Buffer.from(segredo.replace(/^whsec_/, ''), 'base64');
    const sig = crypto.createHmac('sha256', chave).update(`${id}.${ts}.${corpo}`).digest('base64');
    return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}`, 'Content-Type': 'application/json' };
  }
  const evento = (type, email_id, extra = {}) => JSON.stringify({
    type, created_at: '2026-10-24T20:00:00.000Z',
    data: { email_id, to: [EMAIL_DONO], subject: 'x', created_at: '2026-10-24T19:59:59.000Z', ...extra },
  });

  test('sem RESEND_WEBHOOK_SECRET: 503, nada muda', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const corpo = evento('email.delivered', 're_webhook');
    const r = await request(app).post('/webhooks/resend').set(assinado(corpo)).send(corpo);
    expect(r.status).toBe(503);
    const { rows } = await q('SELECT delivered_at FROM email_log WHERE id = $1', [ids.webhook]);
    expect(rows[0].delivered_at).toBeNull();
  });

  test('assinatura inválida, timestamp velho e corpo alterado: 401, nada muda', async () => {
    process.env.RESEND_WEBHOOK_SECRET = WHSEC;
    const corpo = evento('email.delivered', 're_webhook');
    const outro = 'whsec_' + Buffer.from('outro-segredo').toString('base64');
    const casos = [
      [assinado(corpo, { segredo: outro }), corpo],
      [assinado(corpo, { ts: Math.floor(Date.now() / 1000) - 600 }), corpo],
      [assinado(corpo), evento('email.delivered', 're_entregue')],
    ];
    for (const [cab, enviado] of casos) {
      const r = await request(app).post('/webhooks/resend').set(cab).send(enviado);
      expect(r.status).toBe(401);
    }
    const { rows } = await q('SELECT delivered_at FROM email_log WHERE id = $1', [ids.webhook]);
    expect(rows[0].delivered_at).toBeNull();
  });

  test('válido: sent, delivered (repetido não muda), bounced; Entregue aparece com o webhook ligado', async () => {
    process.env.RESEND_WEBHOOK_SECRET = WHSEC;
    const enviar = async (corpo) => request(app).post('/webhooks/resend').set(assinado(corpo)).send(corpo);
    expect((await enviar(evento('email.sent', 're_webhook'))).status).toBe(200);
    expect((await enviar(evento('email.delivered', 're_webhook'))).status).toBe(200);
    const { rows: [a] } = await q('SELECT delivered_at, last_event FROM email_log WHERE id = $1', [ids.webhook]);
    expect(a.last_event).toBe('email.delivered');
    expect(a.delivered_at.toISOString()).toBe('2026-10-24T20:00:00.000Z');

    // Repetido (o Resend reenvia) e "sent" atrasado: nada muda.
    expect((await enviar(evento('email.delivered', 're_webhook').replace('20:00:00', '21:00:00'))).status).toBe(200);
    expect((await enviar(evento('email.sent', 're_webhook'))).status).toBe(200);
    const { rows: [b] } = await q('SELECT delivered_at, last_event FROM email_log WHERE id = $1', [ids.webhook]);
    expect(b.delivered_at.toISOString()).toBe('2026-10-24T20:00:00.000Z');
    expect(b.last_event).toBe('email.delivered');

    expect((await enviar(evento('email.bounced', 're_entregue', { bounce: { type: 'Permanent', subType: 'Suppressed', message: 'x' } }))).status).toBe(200);
    const { rows: [c] } = await q('SELECT bounced_at, metadata FROM email_log WHERE id = $1', [ids.entregue]);
    expect(c.bounced_at).toBeInstanceOf(Date);
    expect(c.metadata.bounce).toEqual({ type: 'Permanent', subType: 'Suppressed' });

    // Evento de outro tipo ou de e-mail que não é nosso: 200, sem efeito.
    expect((await enviar(evento('email.opened', 're_webhook'))).body).toEqual({ ok: true, tratado: false });
    expect((await enviar(evento('email.delivered', 're_nao_existe'))).status).toBe(200);

    const r = await request(app).get(`${base}/ultimos`).set(token(dono));
    const porAssunto = Object.fromEntries(r.body.emails.map((e) => [e.assunto, e.situacao]));
    expect(r.body.webhook_ligado).toBe(true);
    expect(porAssunto.webhook).toBe('entregue');
    expect(porAssunto.entregue).toBe('devolvido');
  });

  test('complained: desliga novidades e acompanhamento da empresa; repetido não grava de novo', async () => {
    process.env.RESEND_WEBHOOK_SECRET = WHSEC;
    await q(`DELETE FROM company_email_prefs WHERE company_id = $1 AND tipo IN ('novidades', 'acompanhamento')`, [empresa]);
    const corpo = evento('email.complained', 're_webhook');
    expect((await request(app).post('/webhooks/resend').set(assinado(corpo)).send(corpo)).status).toBe(200);
    const db = require('../src/config/database');
    expect(await P.tipoLigado(db, empresa, 'novidades')).toBe(false);
    expect(await P.tipoLigado(db, empresa, 'acompanhamento')).toBe(false);
    expect(await P.tipoLigado(db, empresa, 'relatorio')).toBe(true);
    const { rows: pr } = await q(`SELECT tipo, origem FROM company_email_prefs WHERE company_id = $1 AND tipo IN ('novidades', 'acompanhamento') ORDER BY tipo`, [empresa]);
    expect(pr).toEqual([{ tipo: 'acompanhamento', origem: 'reclamacao' }, { tipo: 'novidades', origem: 'reclamacao' }]);
    const conta = async () => (await q(`SELECT count(*)::int AS n FROM audit_log WHERE company_id = $1 AND action = 'email.descadastro'`, [empresa])).rows[0].n;
    const antes = await conta();
    expect((await request(app).post('/webhooks/resend').set(assinado(corpo)).send(corpo)).status).toBe(200);
    expect(await conta()).toBe(antes);
    const { rows: [l] } = await q('SELECT complained_at, last_event FROM email_log WHERE id = $1', [ids.webhook]);
    expect(l.complained_at).toBeInstanceOf(Date);
    expect(l.last_event).toBe('email.complained');
  });
});
