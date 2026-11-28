// ============================================================
// AURA. — Saldo da Aurinha (migration 472) — Postgres real
// services/waSaldoAurinha.js + services/hubWhatsapp.avaliarConversa.
//
// Provado no banco de verdade:
//   - cada conversa nova atendida gasta 1; a mesma conversa nao gasta de
//     novo dentro de 24 h, e gasta de novo depois;
//   - mensagens ao mesmo tempo na mesma conversa gastam 1 so;
//   - esgotou: a Aurinha NAO responde, nada entra na fila e a conversa
//     fica com a lojista (precisa_humano); a mensagem do cliente segue
//     gravada na caixa;
//   - Aurinha que nao respondeu devolve a conversa;
//   - a propria Aura (AURA_COMPANY_ID) nunca e barrada.
// ============================================================
'use strict';

// A Aurinha fica atras da trava AURINHA_WA_LIBERADA (28/11/2026): aqui ela esta ligada.
process.env.AURINHA_WA_LIBERADA = '1';

jest.mock('../src/services/aurinhaAgent', () => ({
  responderSuporte: jest.fn(async () => ({ texto: 'Oi! Aqui e a Aurinha.' })),
}));

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN = process.env.SUPABASE_DB_URL || 'postgresql://aura_test:aura_test@localhost:5432/aura_test';
jest.setTimeout(60000);

const ID = { dono: uuid(), loja: uuid(), cheia: uuid(), hub: uuid(), aura: uuid() };
const EMPRESAS = [ID.loja, ID.cheia, ID.hub, ID.aura];

let pool;
let waSaldo;
let aurinha;
let hubWhatsapp;
const q = (sql, params) => pool.query(sql, params);

async function limpar() {
  for (const sql of [
    'DELETE FROM hub_agent_events WHERE company_id = ANY($1)',
    'DELETE FROM hub_messages WHERE company_id = ANY($1)',
    'DELETE FROM wa_outbox WHERE company_id = ANY($1)',
    'DELETE FROM hub_conversations WHERE company_id = ANY($1)',
    'DELETE FROM wa_saldo_lancamentos WHERE company_id = ANY($1)',
    'DELETE FROM companies WHERE id = ANY($1)',
  ]) {
    try { await q(sql, [EMPRESAS]); } catch (_) { /* banco descartavel */ }
  }
  try { await q('DELETE FROM users WHERE id = $1', [ID.dono]); } catch (_) { /* idem */ }
}

const restante = async (companyId) => (await waSaldo.getSaldos(companyId)).saldos.aurinha.restante;
let seqTel = 0;
const novaConversa = async (companyId) => {
  const id = uuid();
  seqTel += 1;
  await q(
    `INSERT INTO hub_conversations (id, company_id, channel, external_id, status, last_inbound_at, aguardando_resposta_desde)
     VALUES ($1, $2, 'whatsapp', $3, 'ia', NOW(), NOW())`,
    [id, companyId, `5511977${String(seqTel).padStart(6, '0')}`]
  );
  return id;
};

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 12 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());
  process.env.WA_SALDO_ATIVO = '1';
  delete process.env.AURA_COMPANY_ID;
  waSaldo = require('../src/services/waSaldo');
  aurinha = require('../src/services/waSaldoAurinha');
  hubWhatsapp = require('../src/services/hubWhatsapp');

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Aurinha')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  for (const [id, nome] of [[ID.loja, 'Aurinha Loja'], [ID.cheia, 'Aurinha Cheia'], [ID.hub, 'Aurinha Hub'], [ID.aura, 'Aurinha Aura']]) {
    await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, plan) VALUES ($1, $2, $3, $3, 'negocio')`,
      [id, ID.dono, nome]);
  }
  // as 80 conversas do mes ja foram atendidas
  await q(`INSERT INTO wa_saldo_lancamentos (company_id, bucket, kind, fonte, qty, periodo, ref_key)
           SELECT $1, 'aurinha', 'consumo', 'franquia', -1, $2::date, 'seed-cheia:' || g
             FROM generate_series(1, 80) g`, [ID.cheia, waSaldo.periodoDe()]);
});

afterAll(async () => {
  delete process.env.AURA_COMPANY_ID;
  await limpar();
  await pool.end();
});

describe('atender: o que gasta', () => {
  test('conversa nova gasta 1; a mesma conversa dentro de 24 h nao gasta de novo', async () => {
    const conv = uuid();
    const a = await aurinha.atender({ companyId: ID.loja, conversationId: conv });
    expect(a).toMatchObject({ ok: true, reservou: true, fonte: 'franquia', restante: 79 });
    const b = await aurinha.atender({ companyId: ID.loja, conversationId: conv });
    expect(b).toEqual({ ok: true, jaContada: true });
    expect(await restante(ID.loja)).toBe(79);
  });

  test('passadas 24 h o cliente volta e e uma conversa nova: gasta mais 1', async () => {
    const conv = uuid();
    const t0 = new Date();
    await aurinha.atender({ companyId: ID.loja, conversationId: conv, agora: t0 });
    const antes = await restante(ID.loja);
    const dentro = await aurinha.atender({ companyId: ID.loja, conversationId: conv, agora: new Date(t0.getTime() + 23 * 3600000) });
    expect(dentro.jaContada).toBe(true);
    const fora = await aurinha.atender({ companyId: ID.loja, conversationId: conv, agora: new Date(t0.getTime() + 25 * 3600000) });
    expect(fora.reservou).toBe(true);
    expect(await restante(ID.loja)).toBe(antes - 1);
  });

  test('mensagens da mesma conversa ao mesmo tempo gastam 1 so', async () => {
    const conv = uuid();
    const antes = await restante(ID.loja);
    const rs = await Promise.all(Array.from({ length: 6 }, () => aurinha.atender({ companyId: ID.loja, conversationId: conv })));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(rs.filter((r) => r.reservou)).toHaveLength(1);
    expect(await restante(ID.loja)).toBe(antes - 1);
  });

  test('a Aurinha nao respondeu: devolve a conversa e ela volta a poder ser cobrada', async () => {
    const conv = uuid();
    const antes = await restante(ID.loja);
    const cobranca = await aurinha.atender({ companyId: ID.loja, conversationId: conv });
    expect(await restante(ID.loja)).toBe(antes - 1);
    expect(await aurinha.devolver(ID.loja, cobranca)).toEqual({ devolvido: true });
    expect(await aurinha.devolver(ID.loja, cobranca)).toEqual({ devolvido: false });
    expect(await restante(ID.loja)).toBe(antes);
    const deNovo = await aurinha.atender({ companyId: ID.loja, conversationId: conv });
    expect(deNovo.reservou).toBe(true);
  });

  test('conversa ja contada nao tem o que devolver', async () => {
    expect(await aurinha.devolver(ID.loja, { ok: true, jaContada: true })).toEqual({ devolvido: false });
  });
});

describe('atender: esgotou', () => {
  test('80 de 80: a conversa nova nao e atendida (SALDO_ESGOTADO) e nada e gasto', async () => {
    expect(await restante(ID.cheia)).toBe(0);
    const r = await aurinha.atender({ companyId: ID.cheia, conversationId: uuid() });
    expect(r).toMatchObject({ ok: false, code: 'SALDO_ESGOTADO', restante: 0 });
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM wa_saldo_lancamentos WHERE company_id = $1 AND kind = 'consumo'`, [ID.cheia]);
    expect(rows[0].n).toBe(80);
  });

  test('sem a trava ligada responde como sempre', async () => {
    process.env.WA_SALDO_ATIVO = '0';
    try {
      expect(await aurinha.atender({ companyId: ID.cheia, conversationId: uuid() })).toEqual({ ok: true, modo: 'desligado' });
    } finally { process.env.WA_SALDO_ATIVO = '1'; }
  });

  test('a propria Aura nunca e barrada', async () => {
    process.env.AURA_COMPANY_ID = ID.aura;
    try {
      await q(`INSERT INTO wa_saldo_lancamentos (company_id, bucket, kind, fonte, qty, periodo, ref_key)
               SELECT $1, 'aurinha', 'consumo', 'franquia', -1, $2::date, 'seed-aura:' || g
                 FROM generate_series(1, 80) g`, [ID.aura, waSaldo.periodoDe()]);
      expect(await aurinha.atender({ companyId: ID.aura, conversationId: uuid() })).toEqual({ ok: true, isento: true });
    } finally { delete process.env.AURA_COMPANY_ID; }
  });
});

describe('hubWhatsapp.avaliarConversa com o saldo', () => {
  const config = { ativo: true, espera_minutos: 0 };
  const avaliar = async (companyId, convId) => {
    const { rows } = await q(
      `SELECT id, company_id, external_id, status, last_inbound_at, ultima_mensagem_humana_em, aguardando_resposta_desde
         FROM hub_conversations WHERE id = $1`, [convId]);
    return hubWhatsapp.avaliarConversa(rows[0], { companyId, plantao: config }, { agora: new Date(Date.now() + 60000) });
  };

  test('com saldo: responde, enfileira e gasta 1 conversa', async () => {
    const conv = await novaConversa(ID.hub);
    const antes = await restante(ID.hub);
    const r = await avaliar(ID.hub, conv);
    expect(r).toMatchObject({ respondeu: true, enfileirada: true });
    expect(await restante(ID.hub)).toBe(antes - 1);
  });

  test('sem saldo: nao responde, nada entra na fila e a conversa fica com a lojista', async () => {
    const conv = await novaConversa(ID.cheia);
    const r = await avaliar(ID.cheia, conv);
    expect(r).toMatchObject({ respondeu: false, motivo: 'AURINHA_SEM_SALDO', codigo: 'SALDO_ESGOTADO' });
    const fila = await q(`SELECT COUNT(*)::int AS n FROM wa_outbox WHERE hub_conversation_id = $1`, [conv]);
    expect(fila.rows[0].n).toBe(0);
    const c = await q(`SELECT status, handoff_reason, aguardando_resposta_desde FROM hub_conversations WHERE id = $1`, [conv]);
    expect(c.rows[0].status).toBe('precisa_humano');
    expect(c.rows[0].handoff_reason).toMatch(/Saldo da Aurinha/);
    expect(c.rows[0].aguardando_resposta_desde).toBeNull();
  });

  test('a Aurinha sem nada a dizer devolve a conversa', async () => {
    const { responderSuporte } = require('../src/services/aurinhaAgent');
    responderSuporte.mockResolvedValueOnce({ texto: null });
    const conv = await novaConversa(ID.hub);
    const antes = await restante(ID.hub);
    const r = await avaliar(ID.hub, conv);
    expect(r).toMatchObject({ respondeu: false, motivo: 'SEM_RESPOSTA' });
    expect(await restante(ID.hub)).toBe(antes);
  });
});
