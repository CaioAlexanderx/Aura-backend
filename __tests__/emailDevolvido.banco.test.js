// ============================================================
// AURA. — E-mail que volta (18/11/2026) — Postgres real
//
// As três leituras de services/emailDevolvido.js contra a email_log de
// verdade (migration 407):
//   1. enderecosDevolvidos: devolução PERMANENTE suprime; temporária não;
//      e-mail entregue depois da devolução derruba a supressão; linha com
//      vários destinatários não conta;
//   2. devolucaoDaVerificacao: olha o ÚLTIMO e-mail de confirmação que saiu
//      (status 'sent'): permanente, temporária ou nada;
//   3. alertasDeVerificacaoDevolvida: cadastro de até 7 dias, dono sem
//      confirmar, último e-mail de confirmação voltou. Fora quem confirmou,
//      quem é antigo, quem reenviou e recebeu, conta de teste e dojô.
//
// Tudo dentro de UMA transação revertida no afterAll (mesmo padrão de
// limpezaPendentes.banco.test.js).
// ============================================================
'use strict';

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let client;
let dev;

const tag = uuid().slice(0, 8);
const HOJE = '2026-11-18';
const DIAS = (n) => new Date(Date.parse('2026-11-18T15:00:00Z') - n * 86400000).toISOString();

const end = (n) => `${n}-${tag}@exemplo.com.br`;
const PERM = end('perm');
const TEMP = end('temp');
const VOLTOU_A_RECEBER = end('voltou');
const MULTI_A = end('multia');
const MULTI_B = end('multib');

async function log({ tipo = 'verificacao_email', para, status = 'sent', criado, bounced = null, bounceType = null, delivered = null }) {
  await client.query(
    `INSERT INTO email_log (tipo, destinatario, status, created_at, sent_at, bounced_at, delivered_at, metadata)
     VALUES ($1, $2, $3, $4, $4, $5, $6, $7::jsonb)`,
    [tipo, para, status, criado, bounced, delivered,
      JSON.stringify(bounceType ? { bounce: { type: bounceType, subType: 'General' } } : {})]
  );
}

function caso(nome, extra = {}) {
  return {
    nome, user: uuid(), company: uuid(), email: end(`loja-${nome}`),
    verificado: false, criadoHa: 2, empresa: {}, ...extra,
  };
}
const L = {
  alvo: caso('alvo'),                                      // alerta
  temporaria: caso('temporaria'),                          // alerta (temporária também)
  confirmou: caso('confirmou', { verificado: true }),      // fora
  antiga: caso('antiga', { criadoHa: 9 }),                 // fora (mais de 7 dias)
  reenviou: caso('reenviou'),                              // fora (o último saiu e não voltou)
  sandbox: caso('sandbox', { empresa: { is_sandbox: true } }),
  dojo: caso('dojo', { empresa: { vertical: 'karate_dojo' } }),
  semDevolucao: caso('semdevolucao'),                      // fora
};

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => client.query(sql, params));
  dev = require('../src/services/emailDevolvido');

  // 1. Endereços soltos.
  await log({ para: PERM, criado: DIAS(3), bounced: DIAS(3), bounceType: 'Permanent' });
  await log({ para: TEMP, criado: DIAS(3), bounced: DIAS(3), bounceType: 'Transient' });
  await log({ para: VOLTOU_A_RECEBER, criado: DIAS(5), bounced: DIAS(5), bounceType: 'Permanent' });
  await log({ tipo: 'redefinicao_senha', para: VOLTOU_A_RECEBER, criado: DIAS(1), delivered: DIAS(1) });
  await log({ tipo: 'relatorio_semanal', para: `${MULTI_A}, ${MULTI_B}`, criado: DIAS(2), bounced: DIAS(2), bounceType: 'Permanent' });

  // 3. Lojas.
  for (const c of Object.values(L)) {
    await client.query(
      `INSERT INTO users (id, email, password_hash, full_name, email_verified, is_staff, phone, created_at)
       VALUES ($1, $2, 'x', $3, $4, false, '(11) 98765-4321', $5)`,
      [c.user, c.email, `Pessoa ${c.nome}`, c.verificado, DIAS(c.criadoHa)]
    );
    await client.query(
      `INSERT INTO companies (id, owner_id, legal_name, email, billing_status, is_sandbox, vertical, created_at)
       VALUES ($1, $2, $3, $4, 'trial', $5, $6, $7)`,
      [c.company, c.user, `Loja ${c.nome}`, c.email, c.empresa.is_sandbox === true, c.empresa.vertical || null, DIAS(c.criadoHa)]
    );
  }
  const volta = (c, tipo = 'Permanent') => log({ para: c.email, criado: DIAS(c.criadoHa), bounced: DIAS(c.criadoHa), bounceType: tipo });
  await volta(L.alvo);
  await volta(L.temporaria, 'Transient');
  await volta(L.confirmou);
  await volta(L.antiga);
  await volta(L.reenviou, 'Transient');
  await log({ para: L.reenviou.email, criado: DIAS(1) }); // reenvio que saiu e não voltou
  await volta(L.sandbox);
  await volta(L.dojo);
  await log({ para: L.semDevolucao.email, criado: DIAS(2), delivered: DIAS(2) });
});

afterAll(async () => {
  if (client) { await client.query('ROLLBACK'); client.release(); }
  if (pool) await pool.end();
});

describe('enderecosDevolvidos', () => {
  test('permanente suprime; temporária não; maiúsculas não importam', async () => {
    const db = require('../src/config/database');
    const s = await dev.enderecosDevolvidos(db, [PERM.toUpperCase(), TEMP]);
    expect([...s]).toEqual([PERM]);
  });

  test('e-mail entregue depois da devolução derruba a supressão', async () => {
    const db = require('../src/config/database');
    expect((await dev.enderecosDevolvidos(db, VOLTOU_A_RECEBER)).size).toBe(0);
  });

  test('linha com vários destinatários não conta', async () => {
    const db = require('../src/config/database');
    expect((await dev.enderecosDevolvidos(db, [MULTI_A, MULTI_B])).size).toBe(0);
  });

  test('filtrarDestinatarios: tira só o devolvido e mantém o formato', async () => {
    const db = require('../src/config/database');
    expect(await dev.filtrarDestinatarios(db, [PERM, TEMP])).toEqual({ to: [TEMP], suprimidos: [PERM], vazio: false });
    expect(await dev.filtrarDestinatarios(db, PERM)).toEqual({ to: null, suprimidos: [PERM], vazio: true });
  });
});

describe('devolucaoDaVerificacao', () => {
  test('permanente, temporária e nada', async () => {
    const db = require('../src/config/database');
    expect(await dev.devolucaoDaVerificacao(db, L.alvo.email)).toMatchObject({ tipo: 'permanente' });
    expect(await dev.devolucaoDaVerificacao(db, L.temporaria.email)).toMatchObject({ tipo: 'temporaria' });
    expect(await dev.devolucaoDaVerificacao(db, L.semDevolucao.email)).toBeNull();
  });

  test('vale o último e-mail que saiu: reenvio que não voltou zera o sinal', async () => {
    const db = require('../src/config/database');
    expect(await dev.devolucaoDaVerificacao(db, L.reenviou.email)).toBeNull();
  });
});

describe('alertasDeVerificacaoDevolvida', () => {
  test('só os cadastros de 7 dias sem confirmar cujo último e-mail voltou', async () => {
    const db = require('../src/config/database');
    const alertas = await dev.alertasDeVerificacaoDevolvida({ db, hoje: HOJE });
    const nossos = alertas.filter((a) => Object.values(L).some((c) => c.company === a.company_id));
    expect(nossos.map((a) => a.company_id).sort()).toEqual([L.alvo.company, L.temporaria.company].sort());
    const a = nossos.find((x) => x.company_id === L.alvo.company);
    expect(a).toEqual({
      tipo: 'verificacao_devolvida',
      chave: L.alvo.company,
      company_id: L.alvo.company,
      titulo: 'Loja alvo: e-mail de confirmação voltou',
      detalhe: 'Cadastro de 16/11 · não confirmou · falar no WhatsApp',
      verbo: 'Falar',
      bloco: 'cadastros',
      link: 'https://wa.me/5511987654321',
    });
  });
});
