// ============================================================
// AURA. — Saldo do WhatsApp (migration 472) — Postgres real
// services/waSaldo.js + services/waOutbox.js (reserva na transacao do
// enfileirar) + routes/whatsappSaldo.js.
//
// Provado no banco de verdade:
//   - corrida: reservas simultaneas nunca gastam a mesma mensagem;
//   - esgotado: sem saldo nao enfileira e grava o motivo;
//   - saldo do teste (20/5): uma vez so, nao renova, so depois da 1a venda;
//   - virada do mes no fuso de Sao Paulo;
//   - devolver (falha de vez) e idempotente;
//   - numero em atencao recusa novidades e deixa avisos passar;
//   - na duvida bloqueia; trava desligada nao barra.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, _res, next) => next(),
  requireCompanyAccess: () => (req, _res, next) => next(),
  requirePlan: () => (req, _res, next) => next(),
  requireRole: () => (req, _res, next) => next(),
}));

const CONN = process.env.SUPABASE_DB_URL || 'postgresql://aura_test:aura_test@localhost:5432/aura_test';
jest.setTimeout(60000);

const ID = {
  dono: uuid(), negocio: uuid(), essencial: uuid(), addon: uuid(), corrida: uuid(),
  atencao: uuid(), fila: uuid(), virada: uuid(),
  semVenda: uuid(), puro: uuid(), assinou: uuid(),
};
const EMPRESAS = [ID.negocio, ID.essencial, ID.addon, ID.corrida, ID.atencao, ID.fila, ID.virada,
  ID.semVenda, ID.puro, ID.assinou];

let pool;
let waSaldo;
let waOutbox;
const q = (sql, params) => pool.query(sql, params);

async function limpar() {
  for (const sql of [
    'DELETE FROM wa_saldo_lancamentos WHERE company_id = ANY($1)',
    'DELETE FROM wa_outbox WHERE company_id = ANY($1)',
    'DELETE FROM wa_templates WHERE company_id = ANY($1)',
    'DELETE FROM company_addons WHERE company_id = ANY($1)',
    'DELETE FROM companies WHERE id = ANY($1)',
  ]) {
    try { await q(sql, [EMPRESAS]); } catch (_) { /* banco descartavel */ }
  }
  try { await q('DELETE FROM users WHERE id = $1', [ID.dono]); } catch (_) { /* idem */ }
}

// Reserva avulsa com chave propria (cada chamada gasta uma).
let seq = 0;
const reservar = (companyId, bucket, extra = {}) =>
  waSaldo.reservarAvulso({ companyId, bucket, refKey: `teste:${++seq}:${uuid()}`, ...extra });

const consumos = async (companyId, bucket) => {
  const { rows } = await q(
    `SELECT COUNT(*)::int AS n FROM wa_saldo_lancamentos WHERE company_id = $1 AND bucket = $2 AND kind = 'consumo'`,
    [companyId, bucket]
  );
  return rows[0].n;
};

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 12 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());
  process.env.WA_SALDO_ATIVO = '1';
  delete process.env.AURA_COMPANY_ID;
  waSaldo = require('../src/services/waSaldo');
  waOutbox = require('../src/services/waOutbox');

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Saldo')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  const loja = (id, nome, plan) =>
    q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, plan) VALUES ($1, $2, $3, $3, $4)`,
      [id, ID.dono, nome, plan]);
  await loja(ID.negocio, 'Saldo Negocio', 'negocio');
  // Teste (trial) com a 1a venda feita: 20 avisos e 5 novidades, uma vez so.
  await loja(ID.essencial, 'Saldo Teste', 'negocio');
  await q(`UPDATE companies SET trial_ends_at = '2100-01-01', trial_started_by_sale_at = NOW() WHERE id = $1`, [ID.essencial]);
  // Teste ainda sem venda: o WhatsApp nao esta liberado.
  await loja(ID.semVenda, 'Saldo Teste Sem Venda', 'negocio');
  await q(`UPDATE companies SET trial_ends_at = '2100-01-01' WHERE id = $1`, [ID.semVenda]);
  // Essencial pago, sem teste: nenhum saldo (os 14 dias entram na B2).
  await loja(ID.puro, 'Saldo Essencial', 'essencial');
  // Assinou o Negocio no meio do teste: passa para a franquia do Negocio.
  await loja(ID.assinou, 'Saldo Assinou', 'negocio');
  await q(`UPDATE companies SET trial_ends_at = '2100-01-01', trial_started_by_sale_at = NOW(), asaas_subscription_id = 'sub_teste' WHERE id = $1`, [ID.assinou]);
  await loja(ID.addon, 'Saldo Addon', 'essencial');
  await loja(ID.corrida, 'Saldo Corrida', 'negocio');
  await loja(ID.atencao, 'Saldo Atencao', 'negocio');
  await loja(ID.fila, 'Saldo Fila', 'negocio');
  await loja(ID.virada, 'Saldo Virada', 'negocio');
  await q(`INSERT INTO company_addons (company_id, addon_key, status, price_cents) VALUES ($1, 'whatsapp_auto', 'active', 2900)`, [ID.addon]);
  // Cota excepcional: a corrida precisa de um saldo pequeno e exato.
  await q(`UPDATE companies SET wa_marketing_quota = 5 WHERE id = $1`, [ID.corrida]);
  await q(`UPDATE companies SET wa_quality_rating = 'RED' WHERE id = $1`, [ID.atencao]);
});

afterAll(async () => {
  await limpar();
  await pool.end();
});

describe('helpers do mes (Sao Paulo)', () => {
  test('periodo e renovacao viram as 03:00 UTC (00:00 de Sao Paulo)', () => {
    expect(waSaldo.periodoDe(new Date('2026-12-01T02:59:59Z'))).toBe('2026-11-01');
    expect(waSaldo.periodoDe(new Date('2026-12-01T03:00:00Z'))).toBe('2026-12-01');
    expect(waSaldo.renovaEmDe(new Date('2026-11-15T12:00:00Z'))).toBe('2026-12-01');
    expect(waSaldo.renovaEmDe(new Date('2026-12-15T12:00:00Z'))).toBe('2027-01-01');
  });
});

describe('franquias por plano', () => {
  test('Negocio: 10 novidades, 100 avisos, 80 Aurinha por mes', async () => {
    const s = await waSaldo.getSaldos(ID.negocio);
    expect(s.plano).toEqual({ renova: true, origem: 'plano' });
    expect(s.saldos.novidades).toMatchObject({ total: 10, usado: 0, restante: 10, esgotado: false, baixo: false });
    expect(s.saldos.avisos).toMatchObject({ total: 100, restante: 100 });
    expect(s.saldos.aurinha).toMatchObject({ total: 80, restante: 80 });
    expect(s.saldos.avisos.fontes).toEqual([
      expect.objectContaining({ fonte: 'franquia', total: 100, renova_em: s.renova_em }),
    ]);
    expect(s.saldos.avisos.pacote).toEqual({ qty: 200, preco_centavos: 1900 });
  });

  test('Essencial com o add-on de R$ 29: o mesmo do Negocio', async () => {
    const s = await waSaldo.getSaldos(ID.addon);
    expect(s.plano).toEqual({ renova: true, origem: 'addon' });
    expect([s.saldos.novidades.total, s.saldos.avisos.total, s.saldos.aurinha.total]).toEqual([10, 100, 80]);
  });

  test('Teste com a 1a venda feita: 5 novidades e 20 avisos, sem Aurinha, sem renovar', async () => {
    const s = await waSaldo.getSaldos(ID.essencial);
    expect(s.plano).toEqual({ renova: false, origem: 'teste' });
    expect(s.liberacao).toMatchObject({ liberado: true, fase: 'teste' });
    expect([s.saldos.novidades.total, s.saldos.avisos.total, s.saldos.aurinha.total]).toEqual([5, 20, 0]);
    expect(s.saldos.avisos.fontes).toEqual([
      expect.objectContaining({ fonte: 'boas_vindas', total: 20, renova_em: null }),
    ]);
    expect(s.saldos.avisos.renova_em).toBeNull();
  });

  test('Teste antes da 1a venda: nao liberado e sem saldo', async () => {
    const s = await waSaldo.getSaldos(ID.semVenda);
    expect(s.liberacao).toMatchObject({ liberado: false, fase: 'teste_aguardando_venda' });
    expect(s.saldos.avisos.total).toBe(0);
    expect(await reservar(ID.semVenda, 'avisos')).toMatchObject({ ok: false, code: 'SALDO_ESGOTADO' });
  });

  test('Essencial pago sem teste: fechado, sem saldo', async () => {
    const s = await waSaldo.getSaldos(ID.puro);
    expect(s.plano).toEqual({ renova: false, origem: 'essencial' });
    expect(s.liberacao).toMatchObject({ liberado: false, fase: 'fechado' });
    expect(s.saldos.avisos.total).toBe(0);
  });

  test('Assinou o Negocio no teste: passa na hora para 100 avisos e 10 novidades', async () => {
    const s = await waSaldo.getSaldos(ID.assinou);
    expect(s.plano).toEqual({ renova: true, origem: 'plano' });
    expect(s.liberacao).toMatchObject({ liberado: true, fase: 'plano' });
    expect([s.saldos.novidades.total, s.saldos.avisos.total]).toEqual([10, 100]);
  });
});

describe('reservar', () => {
  test('esgotado: a 11a novidade do Negocio recusa com SALDO_ESGOTADO', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await reservar(ID.negocio, 'novidades');
      expect(r).toMatchObject({ ok: true, fonte: 'franquia' });
    }
    const r = await reservar(ID.negocio, 'novidades');
    expect(r).toMatchObject({ ok: false, code: 'SALDO_ESGOTADO', restante: 0 });
    expect(r.renova_em).toMatch(/^\d{4}-\d{2}-01$/);
    const s = await waSaldo.getSaldos(ID.negocio);
    expect(s.saldos.novidades).toMatchObject({ usado: 10, restante: 0, esgotado: true, baixo: false });
    // os outros dois saldos nao foram tocados
    expect(s.saldos.avisos.usado).toBe(0);
  });

  test('flag de 20%: baixo so quando sobra pouco, mas ainda sobra', async () => {
    const empresa = ID.addon;
    for (let i = 0; i < 80; i++) await q(
      `INSERT INTO wa_saldo_lancamentos (company_id, bucket, kind, fonte, qty, periodo, ref_key)
       VALUES ($1, 'avisos', 'consumo', 'franquia', -1, $2, $3)`,
      [empresa, waSaldo.periodoDe(), `seed:${uuid()}`]);
    let s = await waSaldo.getSaldos(empresa);
    expect(s.saldos.avisos).toMatchObject({ restante: 20, baixo: true, esgotado: false });
    expect(s.saldos.avisos.aviso_chave).toBe(`avisos:${waSaldo.periodoDe().slice(0, 7)}`);
    const r = await reservar(empresa, 'avisos');
    expect(r).toMatchObject({ ok: true, restante: 19, baixo: true });
    s = await waSaldo.getSaldos(empresa);
    expect(s.saldos.avisos.restante).toBe(19);
  });

  test('corrida: 10 reservas ao mesmo tempo sobre 5 mensagens gastam exatamente 5', async () => {
    const resultados = await Promise.all(Array.from({ length: 10 }, () => reservar(ID.corrida, 'novidades')));
    expect(resultados.filter((r) => r.ok)).toHaveLength(5);
    expect(resultados.filter((r) => !r.ok).every((r) => r.code === 'SALDO_ESGOTADO')).toBe(true);
    expect(await consumos(ID.corrida, 'novidades')).toBe(5);
  });

  test('a mesma refKey nao gasta duas vezes (retry)', async () => {
    const refKey = `retry:${uuid()}`;
    const a = await waSaldo.reservarAvulso({ companyId: ID.fila, bucket: 'aurinha', refKey });
    const b = await waSaldo.reservarAvulso({ companyId: ID.fila, bucket: 'aurinha', refKey });
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: true, jaReservado: true });
    expect(await consumos(ID.fila, 'aurinha')).toBe(1);
  });

  test('saldo do teste: os 20 avisos acabam e nao voltam no mes seguinte', async () => {
    for (let i = 0; i < 20; i++) {
      const r = await reservar(ID.essencial, 'avisos');
      expect(r).toMatchObject({ ok: true, fonte: 'boas_vindas' });
    }
    expect(await reservar(ID.essencial, 'avisos')).toMatchObject({ ok: false, code: 'SALDO_ESGOTADO', renova_em: null });
    const emDezembro = new Date('2099-12-15T12:00:00Z');
    const r = await waSaldo.reservarAvulso({
      companyId: ID.essencial, bucket: 'avisos', refKey: `mes-seguinte:${uuid()}`, agora: emDezembro,
    });
    expect(r).toMatchObject({ ok: false, code: 'SALDO_ESGOTADO' });
    const { rows } = await q(
      `SELECT COUNT(*)::int AS n FROM wa_saldo_lancamentos
        WHERE company_id = $1 AND bucket = 'avisos' AND kind = 'boas_vindas'`, [ID.essencial]);
    expect(rows[0].n).toBe(1);
  });

  test('virada do mes: o saldo volta as 00:00 de Sao Paulo, nao as 00:00 UTC', async () => {
    const ultimoMinuto = new Date('2099-03-01T02:59:00Z'); // 28/02 23:59 em SP
    const primeiroMinuto = new Date('2099-03-01T03:00:00Z'); // 01/03 00:00 em SP
    for (let i = 0; i < 10; i++) {
      const r = await waSaldo.reservarAvulso({
        companyId: ID.virada, bucket: 'novidades', refKey: `virada:${i}:${uuid()}`, agora: ultimoMinuto,
      });
      expect(r.ok).toBe(true);
    }
    const antes = await waSaldo.reservarAvulso({
      companyId: ID.virada, bucket: 'novidades', refKey: `virada:x:${uuid()}`, agora: ultimoMinuto,
    });
    expect(antes).toMatchObject({ ok: false, code: 'SALDO_ESGOTADO' });
    const depois = await waSaldo.reservarAvulso({
      companyId: ID.virada, bucket: 'novidades', refKey: `virada:y:${uuid()}`, agora: primeiroMinuto,
    });
    expect(depois).toMatchObject({ ok: true, fonte: 'franquia', restante: 9 });
  });

  test('o pacote comprado entra depois da franquia e nao vence', async () => {
    await q(`INSERT INTO wa_saldo_lancamentos (company_id, bucket, kind, fonte, qty, ref_key)
             VALUES ($1, 'novidades', 'pacote', 'pacote', 100, $2)`, [ID.negocio, `pacote:${uuid()}`]);
    const r = await reservar(ID.negocio, 'novidades');
    expect(r).toMatchObject({ ok: true, fonte: 'pacote', restante: 99 });
    // no mes seguinte a franquia volta e e gasta antes do pacote
    const prox = await waSaldo.reservarAvulso({
      companyId: ID.negocio, bucket: 'novidades', refKey: `prox:${uuid()}`, agora: new Date('2099-06-10T12:00:00Z'),
    });
    expect(prox).toMatchObject({ ok: true, fonte: 'franquia' });
  });

  test('numero em atencao: novidades recusa, avisos e Aurinha seguem', async () => {
    expect(await reservar(ID.atencao, 'novidades')).toMatchObject({ ok: false, code: 'NUMERO_EM_ATENCAO' });
    expect(await reservar(ID.atencao, 'avisos')).toMatchObject({ ok: true });
    expect(await reservar(ID.atencao, 'aurinha')).toMatchObject({ ok: true });
    const s = await waSaldo.getSaldos(ID.atencao);
    expect(s.numero).toEqual({ em_atencao: true, motivo: 'QUALIDADE' });
    expect(s.saldos.novidades.bloqueado_por).toBe('NUMERO_EM_ATENCAO');
    expect(s.saldos.avisos.bloqueado_por).toBeNull();
  });

  test('na duvida bloqueia: empresa inexistente, bucket invalido, fora de transacao', async () => {
    expect(await reservar(uuid(), 'avisos')).toMatchObject({ ok: false, code: 'SALDO_INDISPONIVEL' });
    expect(await reservar(ID.negocio, 'outro')).toMatchObject({ ok: false, code: 'SALDO_INDISPONIVEL' });
    const db = require('../src/config/database');
    expect(await waSaldo.reservar(db, { companyId: ID.negocio, bucket: 'avisos', refKey: 'x' }))
      .toMatchObject({ ok: false, code: 'SALDO_INDISPONIVEL', motivo: 'SEM_TRANSACAO' });
  });

  test('sem a trava ligada nao barra nada nem grava', async () => {
    process.env.WA_SALDO_ATIVO = '0';
    try {
      const r = await reservar(ID.corrida, 'novidades');
      expect(r).toEqual({ ok: true, modo: 'desligado' });
    } finally { process.env.WA_SALDO_ATIVO = '1'; }
  });
});

describe('devolver', () => {
  test('estorna uma vez so, mesmo chamado de novo', async () => {
    const outboxId = uuid();
    const r = await waSaldo.reservarAvulso({
      companyId: ID.fila, bucket: 'avisos', refKey: `outbox:${outboxId}`, outboxId,
    });
    expect(r.ok).toBe(true);
    const antes = (await waSaldo.getSaldos(ID.fila)).saldos.avisos.restante;
    expect(await waSaldo.devolver({ outboxId })).toEqual({ devolvido: true });
    expect(await waSaldo.devolver({ outboxId })).toEqual({ devolvido: false });
    const depois = (await waSaldo.getSaldos(ID.fila)).saldos.avisos.restante;
    expect(depois).toBe(antes + 1);
  });

  test('sem reserva nao ha o que devolver', async () => {
    expect(await waSaldo.devolver({ outboxId: uuid() })).toEqual({ devolvido: false });
  });
});

describe('enfileirar com reserva na mesma transacao (waOutbox.enqueue)', () => {
  const phone = (n) => `5511988${String(n).padStart(6, '0')}`;

  beforeAll(async () => {
    await q(`INSERT INTO wa_templates (company_id, name, language, status) VALUES ($1, 'parcela_lembrete', 'pt_BR', 'APPROVED')
             ON CONFLICT DO NOTHING`, [ID.fila]);
    // deixa 1 aviso: 99 ja gastos no mes
    await q(`INSERT INTO wa_saldo_lancamentos (company_id, bucket, kind, fonte, qty, periodo, ref_key)
             SELECT $1, 'avisos', 'consumo', 'franquia', -1, $2::date, 'seed-fila:' || g
               FROM generate_series(1, 99) g`, [ID.fila, waSaldo.periodoDe()]);
  });

  const enfileirar = (n, extra = {}) => waOutbox.enqueue({
    companyId: ID.fila, toPhone: phone(n), kind: 'template', templateName: 'parcela_lembrete',
    sourceType: 'crediario', sourceId: `p-${n}`, ...extra,
  });

  test('duas ao mesmo tempo com 1 aviso sobrando: uma entra, a outra fica SALDO_ESGOTADO', async () => {
    const antes = (await waSaldo.getSaldos(ID.fila)).saldos.avisos.restante;
    expect(antes).toBe(1); // 100 de franquia, 99 gastos
    const sobra = antes;
    const rs = await Promise.all(Array.from({ length: sobra + 3 }, (_, i) => enfileirar(100 + i)));
    const entraram = rs.filter((r) => r.queued);
    const recusadas = rs.filter((r) => !r.queued);
    expect(entraram).toHaveLength(sobra);
    expect(recusadas.every((r) => r.reason === 'SALDO_ESGOTADO' && r.status === 'skipped')).toBe(true);
    const { rows } = await q(
      `SELECT status, skip_reason, COUNT(*)::int AS n FROM wa_outbox
        WHERE company_id = $1 AND source_type = 'crediario' GROUP BY status, skip_reason`, [ID.fila]);
    expect(rows.find((r) => r.status === 'pending').n).toBe(sobra);
    expect(rows.find((r) => r.skip_reason === 'SALDO_ESGOTADO').n).toBe(3);
    expect((await waSaldo.getSaldos(ID.fila)).saldos.avisos.restante).toBe(0);
  });

  test('o que fica na fila tem o debito ligado ao outbox; pulado no despacho devolve', async () => {
    const { rows } = await q(
      `SELECT o.id FROM wa_outbox o JOIN wa_saldo_lancamentos l ON l.outbox_id = o.id AND l.kind = 'consumo'
        WHERE o.company_id = $1 AND o.status = 'pending' LIMIT 1`, [ID.fila]);
    expect(rows).toHaveLength(1);
    await q(`UPDATE wa_outbox SET status = 'failed' WHERE id = $1`, [rows[0].id]);
    // markRow e o caminho do dispatcher; chamamos o servico igual a ele
    expect(await waSaldo.devolver({ outboxId: rows[0].id })).toEqual({ devolvido: true });
    expect((await waSaldo.getSaldos(ID.fila)).saldos.avisos.restante).toBe(1);
  });

  test('dedupe_key repetida nao gasta saldo', async () => {
    const antes = (await waSaldo.getSaldos(ID.fila)).saldos.avisos.restante;
    const a = await enfileirar(300, { dedupeKey: `d:${uuid()}` });
    expect(a.queued).toBe(true);
    const meio = (await waSaldo.getSaldos(ID.fila)).saldos.avisos.restante;
    expect(meio).toBe(antes - 1);
    const dedupeKey = (await q(`SELECT dedupe_key FROM wa_outbox WHERE id = $1`, [a.id])).rows[0].dedupe_key;
    const b = await enfileirar(300, { dedupeKey });
    expect(b).toMatchObject({ queued: false, reason: 'DUPLICADO' });
    expect((await waSaldo.getSaldos(ID.fila)).saldos.avisos.restante).toBe(meio);
  });

  test('texto nao gasta saldo; template de TESTE gasta (a Meta cobra o teste igual)', async () => {
    const antes = await consumos(ID.fila, 'avisos');
    await enfileirar(400, { kind: 'text', templateName: null, textBody: 'oi' }); // janela fechada -> skipped, sem reserva
    expect(await consumos(ID.fila, 'avisos')).toBe(antes);
    await q(`INSERT INTO wa_saldo_lancamentos (company_id, bucket, kind, fonte, qty, ref_key)
             VALUES ($1, 'avisos', 'pacote', 'pacote', 5, $2)`, [ID.fila, `pacote-teste:${uuid()}`]);
    const t = await enfileirar(401, { sourceType: 'teste' });
    expect(t.queued).toBe(true);
    expect(await consumos(ID.fila, 'avisos')).toBe(antes + 1);
  });
});

describe('GET /companies/:id/whatsapp/saldo', () => {
  const app = express();
  app.use('/companies/:id', require('../src/routes/whatsappSaldo'));

  test('devolve os tres saldos com total, usado, restante e as flags', async () => {
    const res = await request(app).get(`/companies/${ID.negocio}/whatsapp/saldo`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ativo: true, fuso: 'America/Sao_Paulo', plano: { renova: true } });
    for (const b of ['novidades', 'avisos', 'aurinha']) {
      expect(res.body.saldos[b]).toEqual(expect.objectContaining({
        bucket: b, total: expect.any(Number), usado: expect.any(Number), restante: expect.any(Number),
        baixo: expect.any(Boolean), esgotado: expect.any(Boolean), fontes: expect.any(Array),
        aviso_chave: expect.any(String),
      }));
    }
  });

  test('empresa que nao existe: erro, nunca saldo inventado', async () => {
    const res = await request(app).get(`/companies/${uuid()}/whatsapp/saldo`);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('SALDO_INDISPONIVEL');
  });
});
