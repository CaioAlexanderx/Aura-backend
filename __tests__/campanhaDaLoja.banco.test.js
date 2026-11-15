// ============================================================
// AURA. — Campanha de Black Friday da loja online (p-118, 14/11/2026)
// Postgres real, schema das migrations (inclui a 427 e a 451).
//
//   1. o resumo conta so o que a loja online mostra: oculta, sem saldo e
//      produto de outra empresa do grupo NAO compartilhado ficam de fora;
//      compartilhado do grupo entra, como na grade
//   2. variante com promocao propria entra com o preco base dela
//   3. agendada conta para ligar, vencida nao; "ate N%" arredonda para baixo
//   4. PUT liga/desliga e as chaves do payload da vitrine seguem
//
// Mesmo arreio do precoEfetivoLeitores.banco.test.js: uma transacao
// revertida no afterAll, fila unica, savepoint por consulta.
// ============================================================
'use strict';

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = req.user || { id: null }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let client;
let app;

const dono = uuid();
const matriz = uuid();
const filial = uuid();
const semPromo = uuid();
const ids = {};

let fila = Promise.resolve();
function naFila(fn) {
  const p = fila.then(fn);
  fila = p.catch(() => {});
  return p;
}
const q = (sql, params) => naFila(() => client.query(sql, params));

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  const db = require('../src/config/database');
  let qn = 0;
  db.query.mockImplementation((sql, params) => naFila(async () => {
    qn += 1;
    const sp = `q_${qn}`;
    await client.query(`SAVEPOINT ${sp}`);
    try {
      const r = await client.query(sql, params);
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      return r;
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      throw err;
    }
  }));

  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Campanha')`,
    [dono, `fixture-${dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES
             ($1, $4, 'Fixture Matriz LTDA', 'Matriz BF'), ($2, $4, 'Fixture Filial LTDA', 'Filial BF'),
             ($3, $4, 'Fixture Sem Promo LTDA', 'Sem Promo BF')`,
    [matriz, filial, semPromo, dono]);
  await q(`UPDATE companies SET billing_owner_company_id = $1 WHERE id = $2`, [matriz, filial]);

  const produto = async (chave, { empresa = matriz, price = 100, shared = false, estoque = 5, promo = null } = {}) => {
    const { rows: [r] } = await q(
      `INSERT INTO products (company_id, name, sku, price, cost_price, is_group_shared, is_active, stock_qty)
       VALUES ($1, $2, $3, $4, 10, $5, true, $6) RETURNING id`,
      [empresa, `Peca BF ${chave}`, `SKU-BF-${chave}-${uuid().slice(0, 8)}`, price, shared, estoque]
    );
    ids[chave] = r.id;
    if (promo) {
      await q(`UPDATE products SET promo_price = $2, promo_starts_at = NOW() + $3::interval, promo_ends_at = NOW() + $4::interval WHERE id = $1`,
        [r.id, promo[0], promo[1], promo[2]]);
    }
    return r.id;
  };
  // 139,90 -> 97,90 = 30,02%: "30".
  await produto('ativa', { price: 139.9, promo: [97.9, '-1 day', '7 days'] });
  // Ocultas e sem saldo: 90% de desconto que a loja nao mostra.
  await produto('oculta', { price: 100, promo: [10, '-1 day', '9 days'] });
  await produto('semSaldo', { price: 100, estoque: 0, promo: [10, '-1 day', '9 days'] });
  await produto('agendada', { price: 100, promo: [80, '2 days', '7 days'] });
  await produto('vencida', { price: 100, promo: [10, '-7 days', '-1 day'] });
  await produto('normal', { price: 50 });
  // Compartilhado pela filial: entra na loja da matriz (como na grade).
  await produto('doGrupo', { empresa: filial, shared: true, price: 100, promo: [65, '-1 day', '3 days'] });
  // Da filial e nao compartilhado: fica de fora.
  await produto('soDaFilial', { empresa: filial, price: 100, promo: [5, '-1 day', '3 days'] });
  // Variante com promocao propria: 200 -> 110 = 45%.
  const comVar = await produto('comVar', { price: 200 });
  await q(`INSERT INTO product_variants (product_id, sku_suffix, price_override, stock_qty, promo_price, promo_starts_at, promo_ends_at)
           VALUES ($1, 'G', NULL, 3, 110, NOW() - INTERVAL '1 day', NOW() + INTERVAL '5 days')`, [comVar]);
  // Variante sem saldo com promocao ainda maior: fora.
  await q(`INSERT INTO product_variants (product_id, sku_suffix, price_override, stock_qty, promo_price, promo_starts_at, promo_ends_at)
           VALUES ($1, 'P', NULL, 0, 20, NOW() - INTERVAL '1 day', NOW() + INTERVAL '5 days')`, [comVar]);

  // slug e hidden_product_ids (migration 119 da loja) existem em producao
  // mas nao tem .sql no repo; o schema do CI nasce sem elas. Criadas aqui,
  // dentro da transacao revertida (IF NOT EXISTS: em base completa, nada).
  await q(`ALTER TABLE digital_channel_config ADD COLUMN IF NOT EXISTS slug text`);
  await q(`ALTER TABLE digital_channel_config ADD COLUMN IF NOT EXISTS hidden_product_ids text[] DEFAULT '{}'`);
  await q(`INSERT INTO digital_channel_config (company_id, slug, is_published, site_name, hidden_product_ids)
           VALUES ($1, $2, true, 'Boutique BF', ARRAY[$3]::text[])`, [matriz, `bf-${matriz.slice(0, 8)}`, ids.oculta]);
  await q(`INSERT INTO digital_channel_config (company_id, slug, is_published)
           VALUES ($1, $2, true)`, [semPromo, `bf-${semPromo.slice(0, 8)}`]);

  app = express();
  app.use(express.json());
  app.use('/companies/:id/digital-channel/campanha', require('../src/routes/campanhaDaLoja'));
});

afterAll(async () => {
  await fila;
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

const rota = (cid) => `/companies/${cid}/digital-channel/campanha`;

/**
 * As chaves que buildStorefront acrescenta, com o resumo do banco de
 * verdade. (buildStorefront inteiro le colunas da loja que o schema do CI
 * nao tem; a ligacao dele esta provada em campanhaDaLoja.test.js.)
 */
async function payload(config) {
  const { listVisibilityWhere } = require('../src/services/storefrontBuilder');
  const { resumoDasPromocoes, chavesDoPayload } = require('../src/services/campanhaDaLoja');
  const resumo = await resumoDasPromocoes({ cid: config.company_id, visibilidade: listVisibilityWhere('$1') });
  return chavesDoPayload(config, resumo, config.site_name || 'Loja');
}

test('resumo: conta so o que a loja mostra; variante entra; arredonda para baixo', async () => {
  const res = await request(app).get(rota(matriz));
  expect(res.status).toBe(200);
  const { rows: [esperado] } = await q(
    `SELECT to_char((NOW() + INTERVAL '7 days' - INTERVAL '1 millisecond') AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS ate,
            to_char((NOW() + INTERVAL '2 days') AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS comeca`);
  expect(res.body.promocoes).toEqual({
    // ativa, doGrupo e comVar (pela variante)
    no_ar: 3,
    agendadas: 1,
    ate_pct: 45,
    ate_data: esperado.ate,
    comeca_em: esperado.comeca,
    // p-123a: oculta e semSaldo valem no Caixa, mas a loja nao mostra.
    // soDaFilial nao e visivel para a matriz (nao compartilhado): nao conta.
    fora_da_loja: 2,
  });

  const fora = await request(app).get(rota(matriz) + '/fora-da-loja');
  expect(fora.status).toBe(200);
  const motivo = Object.fromEntries(fora.body.produtos.map((p) => [p.id, p.motivo]));
  expect(motivo[ids.oculta]).toBe('fora_da_vitrine');
  expect(motivo[ids.semSaldo]).toBe('sem_estoque');
  expect(motivo[ids.ativa]).toBeUndefined();
  expect(motivo[ids.doGrupo]).toBeUndefined();
  expect(motivo[ids.soDaFilial]).toBeUndefined();
  expect(res.body).toMatchObject({ ativa: false, titulo: 'black_friday', pode_ligar: true, no_ar: false });
  expect(res.body.titulos[1].texto).toBe('Black Friday da Boutique BF');
});

test('ligar sem promocao: 409 BF_SEM_PROMOCAO e nada muda no banco', async () => {
  const res = await request(app).put(rota(semPromo)).send({ ativa: true });
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('BF_SEM_PROMOCAO');
  const { rows: [c] } = await q(`SELECT bf_ativa FROM digital_channel_config WHERE company_id = $1`, [semPromo]);
  expect(c.bf_ativa).toBe(false);
});

test('ligar com promocao: grava, e o payload da vitrine ganha a campanha', async () => {
  const res = await request(app).put(rota(matriz)).send({ ativa: true, titulo: 'black_friday_da_loja' });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ ativa: true, titulo: 'black_friday_da_loja', no_ar: true });

  const { rows: [config] } = await q(`SELECT * FROM digital_channel_config WHERE company_id = $1`, [matriz]);
  const out = await payload(config);
  expect(out.tem_promocao).toBe(true);
  expect(out.campanha).toEqual({
    ativa: true, titulo: 'Black Friday da Boutique BF', ate_pct: 45, ate_data: res.body.promocoes.ate_data,
  });

  // O titulo fora da lista nao entra nem pelo banco (CHECK da 451).
  await q('SAVEPOINT titulo_fora');
  await expect(q(`UPDATE digital_channel_config SET bf_titulo = 'saldao' WHERE company_id = $1`, [matriz]))
    .rejects.toThrow(/bf_titulo_check/);
  await q('ROLLBACK TO SAVEPOINT titulo_fora');
});

test('desligada: o payload volta a ter so o tem_promocao; loja sem promocao, nenhuma chave', async () => {
  const res = await request(app).put(rota(matriz)).send({ ativa: false });
  expect(res.status).toBe(200);
  const { rows: [config] } = await q(`SELECT * FROM digital_channel_config WHERE company_id = $1`, [matriz]);
  const out = await payload(config);
  expect(out.tem_promocao).toBe(true);
  expect(out).not.toHaveProperty('campanha');

  const { rows: [vazia] } = await q(`SELECT * FROM digital_channel_config WHERE company_id = $1`, [semPromo]);
  const outVazia = await payload(vazia);
  expect(outVazia).not.toHaveProperty('tem_promocao');
  expect(outVazia).not.toHaveProperty('campanha');
});

// p-122 (migration 453): o texto escrito pela loja grava normalizado, vale
// no payload e o banco segura o tamanho.
test('texto da faixa: grava, sai no payload e o CHECK segura o tamanho', async () => {
  const res = await request(app).put(rota(matriz)).send({ ativa: true, titulo_texto: '  Semana   Aurora ', frase_texto: 'Só até domingo.' });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ titulo_texto: 'Semana Aurora', frase_texto: 'Só até domingo.', titulo_final: 'Semana Aurora' });
  const { rows: [config] } = await q('SELECT * FROM digital_channel_config WHERE company_id = $1', [matriz]);
  const out = await payload(config);
  expect(out.campanha).toMatchObject({ titulo: 'Semana Aurora', frase: 'Só até domingo.' });

  expect((await request(app).put(rota(matriz)).send({ titulo_texto: 'Tudo 70% OFF' })).status).toBe(422);

  await q('SAVEPOINT texto_longo');
  await expect(q('UPDATE digital_channel_config SET bf_titulo_texto = $2 WHERE company_id = $1', [matriz, 'W'.repeat(29)]))
    .rejects.toThrow();
  await q('ROLLBACK TO SAVEPOINT texto_longo');

  // null volta a opcao pronta
  const limpo = await request(app).put(rota(matriz)).send({ titulo_texto: null, frase_texto: '' });
  expect(limpo.body).toMatchObject({ titulo_texto: null, frase_texto: null, titulo_final: 'Black Friday da Boutique BF' });
});

