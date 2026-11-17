// ============================================================
// AURA. — Loja comum e produto personalizavel, no Postgres de verdade
// (p-179, loja unica 3.2a, 17/11/2026). Schema das migrations.
//
//   1. o personalizavel com configurador entra na grade, na contagem e na
//      URL propria com saldo 0; o de prateleira continua saindo sem saldo,
//      com variante ou sem;
//   2. a excecao do EM_ESTOQUE so muda a resposta do personalizavel: em
//      todo produto das lojas do teste, o fragmento novo e o de antes so
//      discordam nos personalizaveis com configurador;
//   3. tem_personalizavel: verdadeiro so com personalizavel ativo e
//      visivel na vitrine; loja sem personalizavel (ou so com o oculto)
//      fica sem;
//   4. "Ultimas unidades" nao pega o personalizavel de saldo 0.
//
// Mesmo arreio do campanhaDaLoja.banco.test.js: uma transacao revertida no
// afterAll, fila unica, savepoint por consulta.
// ============================================================
'use strict';

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

let pool;
let client;

const dono = uuid();
const mista = uuid();
const comum = uuid();
const soOculto = uuid();
const ids = {};

let fila = Promise.resolve();
function naFila(fn) {
  const p = fila.then(fn);
  fila = p.catch(() => {});
  return p;
}
const q = (sql, params) => naFila(() => client.query(sql, params));

// O EM_ESTOQUE de origin/main ate o p-179, copiado aqui de proposito: e a
// regra contra a qual o fragmento novo e comparado produto a produto.
const EM_ESTOQUE_ANTES = `(
  CASE WHEN EXISTS (
    SELECT 1 FROM product_variants v
     WHERE v.product_id = products.id AND v.is_active = true
  )
  THEN EXISTS (
    SELECT 1 FROM product_variants v
     WHERE v.product_id = products.id AND v.is_active = true AND v.stock_qty > 0
  )
  ELSE products.stock_qty > 0
  END
)`;

const CONFIG = JSON.stringify({ fields: [{ id: 'nome', type: 'text', label: 'Nome', required: true }] });

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

  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Personalizavel')`,
    [dono, `fixture-${dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES
             ($1, $4, 'Fixture Mista LTDA', 'Mista'), ($2, $4, 'Fixture Comum LTDA', 'Comum'),
             ($3, $4, 'Fixture So Oculto LTDA', 'So Oculto')`,
    [mista, comum, soOculto, dono]);

  const produto = async (chave, { empresa = mista, estoque = 5, personalizavel = false, config = null, ativo = true, minimo = null } = {}) => {
    const { rows: [r] } = await q(
      `INSERT INTO products (company_id, name, sku, price, cost_price, is_active, stock_qty, stock_min,
                             is_personalizable, customization_config)
       VALUES ($1, $2, $3, 50, 10, $4, $5, $6, $7, $8::jsonb) RETURNING id`,
      [empresa, `Peca P179 ${chave}`, `SKU-P179-${chave}-${uuid().slice(0, 8)}`, ativo, estoque, minimo,
        personalizavel, config]
    );
    ids[chave] = r.id;
    return r.id;
  };
  const variante = (produtoId, sku, estoque) => q(
    `INSERT INTO product_variants (product_id, sku_suffix, stock_qty) VALUES ($1, $2, $3)`,
    [produtoId, sku, estoque]);

  // Loja mista: prateleira e personalizavel.
  await produto('comSaldo');
  await produto('semSaldo', { estoque: 0 });
  await produto('ultima', { estoque: 1 });
  await variante(await produto('varSemSaldo', { estoque: 0 }), 'P', 0);
  await variante(await produto('varComSaldo', { estoque: 0 }), 'M', 2);
  await produto('caneca', { estoque: 0, personalizavel: true, config: CONFIG });
  // Personalizavel com variante zerada: tambem nao confere estoque.
  await variante(await produto('camiseta', { estoque: 0, personalizavel: true, config: CONFIG }), 'G', 0);
  // Marcado sem configurador, ou configurador sem a marca: prateleira.
  await produto('semConfig', { estoque: 0, personalizavel: true, config: null });
  await produto('soConfig', { estoque: 0, personalizavel: false, config: CONFIG });
  await produto('inativo', { estoque: 0, personalizavel: true, config: CONFIG, ativo: false });
  await produto('oculto', { estoque: 0, personalizavel: true, config: CONFIG });

  // Loja comum: so prateleira.
  await produto('comumComSaldo', { empresa: comum });
  await produto('comumSemSaldo', { empresa: comum, estoque: 0 });
  await variante(await produto('comumVarSemSaldo', { empresa: comum, estoque: 3 }), 'U', 0);

  // Loja cujo unico personalizavel esta oculto na vitrine.
  await produto('comumDoOculto', { empresa: soOculto });
  await produto('soOcultoPers', { empresa: soOculto, estoque: 0, personalizavel: true, config: CONFIG });

  // slug e hidden_product_ids (migration 119 da loja) existem em producao
  // mas nao tem .sql no repo; o schema do CI nasce sem elas. Criadas aqui,
  // dentro da transacao revertida (IF NOT EXISTS: em base completa, nada).
  await q(`ALTER TABLE digital_channel_config ADD COLUMN IF NOT EXISTS slug text`);
  await q(`ALTER TABLE digital_channel_config ADD COLUMN IF NOT EXISTS hidden_product_ids text[] DEFAULT '{}'`);
  await q(`INSERT INTO digital_channel_config (company_id, slug, is_published, hidden_product_ids)
           VALUES ($1, $2, true, ARRAY[$3]::text[])`, [mista, `p179-${mista.slice(0, 8)}`, ids.oculto]);
  await q(`INSERT INTO digital_channel_config (company_id, slug, is_published)
           VALUES ($1, $2, true)`, [comum, `p179-${comum.slice(0, 8)}`]);
  await q(`INSERT INTO digital_channel_config (company_id, slug, is_published, hidden_product_ids)
           VALUES ($1, $2, true, ARRAY[$3]::text[])`, [soOculto, `p179-${soOculto.slice(0, 8)}`, ids.soOcultoPers]);
});

afterAll(async () => {
  await fila;
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

const nomes = (lista) => lista.map((p) => Object.keys(ids).find((k) => ids[k] === p.id)).sort();

async function grade(cid) {
  const { listVisibilityWhere } = require('../src/services/storefrontBuilder');
  const { paginaDoCatalogo } = require('../src/services/catalogoPaginado');
  return paginaDoCatalogo({ cid, visibilityWhere: listVisibilityWhere('$1'), limit: 60 });
}

test('grade: o personalizavel com configurador entra com saldo 0; a prateleira, como sempre', async () => {
  const r = await grade(mista);
  expect(nomes(r.produtos)).toEqual(['camiseta', 'caneca', 'comSaldo', 'ultima', 'varComSaldo']);
  expect(r.total).toBe(5);
});

test('loja comum: a grade e a de antes', async () => {
  const r = await grade(comum);
  expect(nomes(r.produtos)).toEqual(['comumComSaldo']);
  expect(r.total).toBe(1);
});

test('a excecao so muda a resposta dos personalizaveis com configurador', async () => {
  const { EM_ESTOQUE } = require('../src/services/catalogoPaginado');
  const { rows } = await q(
    `SELECT id, ${EM_ESTOQUE} AS agora, ${EM_ESTOQUE_ANTES} AS antes
       FROM products WHERE company_id = ANY($1::uuid[])`,
    [[mista, comum, soOculto]]);
  expect(rows.length).toBe(Object.keys(ids).length);
  const mudaram = rows.filter((r) => r.agora !== r.antes);
  expect(nomes(mudaram)).toEqual(['camiseta', 'caneca', 'inativo', 'oculto', 'soOcultoPers']);
  // Mudou so num sentido: de "sem estoque" para "na loja".
  mudaram.forEach((r) => expect([r.antes, r.agora]).toEqual([false, true]));
});

test('tem_personalizavel: so com personalizavel ativo e visivel; na mesma consulta da contagem', async () => {
  const { contarProdutosDaLoja } = require('../src/services/storefrontBuilder');
  // A contagem nunca olhou NA_VITRINE (o oculto conta, como antes); o
  // tem_personalizavel olha.
  expect(await contarProdutosDaLoja(mista, false)).toEqual({ total: 6, temPersonalizavel: true });
  expect(await contarProdutosDaLoja(comum, false)).toEqual({ total: 1, temPersonalizavel: false });
  expect(await contarProdutosDaLoja(soOculto, false)).toEqual({ total: 2, temPersonalizavel: false });
  // Loja que exige foto: o personalizavel sem foto nao liga nada.
  expect(await contarProdutosDaLoja(mista, true)).toEqual({ total: 0, temPersonalizavel: false });
});

test('URL propria: abre o personalizavel sem saldo; a prateleira sem saldo segue fora', async () => {
  const { produtoPublicoPorId } = require('../src/services/storefrontBuilder');
  const abrir = (id, cid = mista) => produtoPublicoPorId({ cid, id, exigeFoto: false, mostrarPrecos: true });
  expect((await abrir(ids.caneca)).id).toBe(ids.caneca);
  expect(await abrir(ids.semSaldo)).toBeNull();
  expect(await abrir(ids.semConfig)).toBeNull();
  expect(await abrir(ids.oculto)).toBeNull();
  expect(await abrir(ids.comumSemSaldo, comum)).toBeNull();
  expect((await abrir(ids.comumComSaldo, comum)).id).toBe(ids.comumComSaldo);
});

test('"Ultimas unidades" nao pega o personalizavel de saldo 0', async () => {
  const { listVisibilityWhere } = require('../src/services/storefrontBuilder');
  const { ultimasUnidades } = require('../src/services/homeDaLoja');
  const rows = await ultimasUnidades({ cid: mista, visibilityWhere: listVisibilityWhere('$1'), exigeFoto: false });
  expect(nomes(rows)).toEqual(['ultima']);
});
