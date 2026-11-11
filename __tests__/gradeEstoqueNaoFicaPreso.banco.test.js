// ============================================================
// AURA. — Editar a grade não deixa estoque preso — Postgres real
// (10/11/2026)
//
// O PUT /variations desativava TODAS as variantes e criava todas de novo
// a cada Salvar. Na Finesse isso deixou 8.146 variantes inativas, 2.862
// com stock_qty > 0, e combinações que saíram da grade levando peças sem
// aviso. Agora:
//   1. o que continua na grade é atualizado na MESMA linha (mesmo id),
//      sem deixar inativa para trás, e price_override / promoção /
//      miniatura ficam;
//   2. tirar da grade algo com estoque responde 409 com mensagem gentil e
//      não grava nada; com confirmar_remocao_com_estoque sai, marcado com
//      deactivated_reason = 'removida_da_grade';
//   3. célula igual à matrix_lida mantém o estoque do banco (venda feita
//      com o editor aberto não volta para a prateleira);
//   4. o total do pai é a soma do que ficou gravado.
//
// Mesmo padrão de variante.nomeDaCor.banco.test.js: tudo dentro de UMA
// transação revertida no afterAll.
// ============================================================
'use strict';

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

const userId    = uuid();
const companyId = uuid();
const base = `/companies/${companyId}/products`;

async function q(sql, params) {
  return client.query(sql, params);
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  const db = require('../src/config/database');
  let qn = 0;
  let fila = Promise.resolve();
  async function noSavepoint(sql, params) {
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
  }
  db.query.mockImplementation((sql, params) => {
    const p = fila.then(() => noSavepoint(sql, params));
    fila = p.catch(() => {});
    return p;
  });
  let sp = 0;
  db.connect.mockImplementation(async () => ({
    query: (sql, params) => {
      const s = typeof sql === 'string' ? sql.trim().toUpperCase() : '';
      if (s === 'BEGIN')    { sp += 1; return client.query(`SAVEPOINT rota_${sp}`); }
      if (s === 'COMMIT')   { return client.query(`RELEASE SAVEPOINT rota_${sp}`); }
      if (s === 'ROLLBACK') { return client.query(`ROLLBACK TO SAVEPOINT rota_${sp}`); }
      return client.query(sql, params);
    },
    release: () => {},
  }));

  // O PUT lê products.color/size, colunas que o banco de produção tem e o
  // schema montado pelas migrations não. Só nesta transação.
  await q(`ALTER TABLE products ADD COLUMN IF NOT EXISTS color TEXT, ADD COLUMN IF NOT EXISTS size TEXT`);

  await q(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Grade')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await q(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES ($1, $2, 'Fixture Moda LTDA', 'Moda')`,
    [companyId, userId]
  );

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId, role: 'client', plan: 'negocio' }; next(); });
  app.use('/companies/:id/products', require('../src/routes/productsVariations'));
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

async function produto(nome) {
  const { rows } = await q(
    `INSERT INTO products (company_id, name, price, stock_qty) VALUES ($1, $2, 99.9, 0) RETURNING id`,
    [companyId, nome]
  );
  return rows[0].id;
}

async function variantes(pid) {
  const { rows } = await q(
    `SELECT pv.id, pv.is_active, pv.stock_qty::int AS stock, pv.deactivated_reason,
            MAX(pvv.value) FILTER (WHERE pvv.attribute_name = 'Cor') AS cor,
            MAX(pvv.value) FILTER (WHERE pvv.attribute_name = 'Tamanho') AS tamanho
       FROM product_variants pv
       LEFT JOIN product_variant_values pvv ON pvv.variant_id = pv.id
      WHERE pv.product_id = $1
      GROUP BY pv.id ORDER BY pv.is_active DESC, cor, tamanho`,
    [pid]
  );
  return rows;
}

function ativa(rows, cor, tam) {
  return rows.find((r) => r.is_active && (r.cor || null) === cor && (r.tamanho || null) === tam);
}

async function estoqueDoPai(pid) {
  const { rows } = await q('SELECT stock_qty::int AS s FROM products WHERE id = $1', [pid]);
  return rows[0].s;
}

const PRETO = { hex: '#000000', name: 'Preto' };
const AZUL = { hex: '#3B82F6', name: 'Azul' };

describe('salvar de novo a mesma grade', () => {
  let pid;
  let antes;
  beforeAll(async () => {
    pid = await produto('Vestido Midi');
    await request(app).put(`${base}/${pid}/variations`).send({
      colors: [PRETO, AZUL], sizes: ['P', 'M'],
      matrix: { '#000000|P': 3, '#000000|M': 2, '#3B82F6|P': 1, '#3B82F6|M': 0 },
      barcodes: {},
    }).expect(200);
    antes = await variantes(pid);
  });

  test('não cria inativa e mantém os mesmos ids', async () => {
    await request(app).put(`${base}/${pid}/variations`).send({
      colors: [PRETO, AZUL], sizes: ['P', 'M'],
      matrix: { '#000000|P': 3, '#000000|M': 5, '#3B82F6|P': 1, '#3B82F6|M': 0 },
      barcodes: {},
    }).expect(200);
    const depois = await variantes(pid);
    expect(depois).toHaveLength(4);
    expect(depois.every((r) => r.is_active)).toBe(true);
    expect(depois.map((r) => r.id).sort()).toEqual(antes.map((r) => r.id).sort());
    expect(ativa(depois, '#000000', 'M').stock).toBe(5);
    expect(await estoqueDoPai(pid)).toBe(9);
  });

  test('preço próprio e foto da variante ficam', async () => {
    const v = ativa(await variantes(pid), '#000000', 'P');
    await q(`UPDATE product_variants SET price_override = 120, image_url = 'https://x/p.jpg', image_thumb_url = 'https://x/p_t.jpg' WHERE id = $1`, [v.id]);
    await request(app).put(`${base}/${pid}/variations`).send({
      colors: [PRETO, AZUL], sizes: ['P', 'M'],
      matrix: { '#000000|P': 4, '#000000|M': 5, '#3B82F6|P': 1, '#3B82F6|M': 0 },
      barcodes: {},
    }).expect(200);
    const { rows } = await q('SELECT stock_qty::int AS s, price_override::float AS po, image_url, image_thumb_url FROM product_variants WHERE id = $1', [v.id]);
    expect(rows[0]).toEqual({ s: 4, po: 120, image_url: 'https://x/p.jpg', image_thumb_url: 'https://x/p_t.jpg' });
  });

  test('hex em minúsculas é a mesma cor', async () => {
    await request(app).put(`${base}/${pid}/variations`).send({
      colors: [{ hex: '#3b82f6', name: 'Azul' }, PRETO], sizes: ['P', 'M'],
      matrix: { '#3b82f6|P': 1, '#3b82f6|M': 0, '#000000|P': 4, '#000000|M': 5 },
      barcodes: {},
    }).expect(200);
    const depois = await variantes(pid);
    expect(depois.filter((r) => !r.is_active)).toEqual([]);
  });
});

describe('adicionar tamanho', () => {
  test('cria só o novo; o estoque das outras fica', async () => {
    const pid = await produto('Saia');
    await request(app).put(`${base}/${pid}/variations`).send({
      colors: [PRETO], sizes: ['P'], matrix: { '#000000|P': 6 }, barcodes: {},
    }).expect(200);
    await request(app).put(`${base}/${pid}/variations`).send({
      colors: [PRETO], sizes: ['P', 'G'], matrix: { '#000000|P': 6, '#000000|G': 2 }, barcodes: {},
    }).expect(200);
    const rows = await variantes(pid);
    expect(rows).toHaveLength(2);
    expect(ativa(rows, '#000000', 'P').stock).toBe(6);
    expect(ativa(rows, '#000000', 'G').stock).toBe(2);
    expect(await estoqueDoPai(pid)).toBe(8);
  });
});

describe('remover cor/tamanho com estoque', () => {
  let pid;
  beforeAll(async () => {
    pid = await produto('Blusa');
    await request(app).put(`${base}/${pid}/variations`).send({
      colors: [PRETO, AZUL], sizes: ['P'],
      matrix: { '#000000|P': 3, '#3B82F6|P': 2 }, barcodes: {},
    }).expect(200);
  });

  test('sem confirmação: 409 com a mensagem e nada muda', async () => {
    const r = await request(app).put(`${base}/${pid}/variations`).send({
      colors: [PRETO], sizes: ['P'], matrix: { '#000000|P': 3 }, barcodes: {},
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('GRADE_REMOCAO_COM_ESTOQUE');
    expect(r.body.error).toBe('Azul · P ainda tem 2 peças. Zere o estoque ou transfira antes de remover.');
    expect(r.body.removidas).toEqual([
      { key: '#3B82F6|P', color_hex: '#3B82F6', color_name: 'Azul', size: 'P', stock: 2 },
    ]);
    const rows = await variantes(pid);
    expect(rows.filter((x) => x.is_active)).toHaveLength(2);
    expect(await estoqueDoPai(pid)).toBe(5);
  });

  test('com confirmação: sai marcada como removida da grade', async () => {
    await request(app).put(`${base}/${pid}/variations`).send({
      colors: [PRETO], sizes: ['P'], matrix: { '#000000|P': 3 }, barcodes: {},
      confirmar_remocao_com_estoque: true,
    }).expect(200);
    const rows = await variantes(pid);
    const fora = rows.filter((x) => !x.is_active);
    expect(fora).toHaveLength(1);
    expect(fora[0]).toMatchObject({ cor: '#3B82F6', tamanho: 'P', deactivated_reason: 'removida_da_grade' });
    expect(ativa(rows, '#000000', 'P').stock).toBe(3);
    expect(await estoqueDoPai(pid)).toBe(3);
  });

  test('sem estoque sai sem perguntar', async () => {
    const outro = await produto('Top');
    await request(app).put(`${base}/${outro}/variations`).send({
      colors: [], sizes: ['P', 'M'], matrix: { '|P': 1, '|M': 0 }, barcodes: {},
    }).expect(200);
    await request(app).put(`${base}/${outro}/variations`).send({
      colors: [], sizes: ['P'], matrix: { '|P': 1 }, barcodes: {},
    }).expect(200);
    const rows = await variantes(outro);
    expect(rows.filter((x) => x.is_active).map((x) => x.tamanho)).toEqual(['P']);
  });
});

describe('venda com o editor aberto', () => {
  test('célula intocada (igual à matrix_lida) fica com o estoque do banco', async () => {
    const pid = await produto('Calça');
    await request(app).put(`${base}/${pid}/variations`).send({
      colors: [], sizes: ['38', '40'], matrix: { '|38': 3, '|40': 1 }, barcodes: {},
    }).expect(200);
    // O editor leu 38=3 e 40=1. No Caixa, vendeu uma 38 (banco: 2).
    const v38 = ativa(await variantes(pid), null, '38');
    await q('UPDATE product_variants SET stock_qty = 2 WHERE id = $1', [v38.id]);
    // A lojista só mexeu no 40 e salvou com o 38=3 ainda na tela.
    await request(app).put(`${base}/${pid}/variations`).send({
      colors: [], sizes: ['38', '40'], matrix: { '|38': 3, '|40': 4 }, barcodes: {},
      matrix_lida: { '|38': 3, '|40': 1 },
    }).expect(200);
    const rows = await variantes(pid);
    expect(ativa(rows, null, '38').stock).toBe(2);
    expect(ativa(rows, null, '40').stock).toBe(4);
    expect(await estoqueDoPai(pid)).toBe(6);
  });
});

describe('cliente antigo sem barcodes no corpo', () => {
  test('o código de barras gravado fica', async () => {
    const pid = await produto('Meia');
    await request(app).put(`${base}/${pid}/variations`).send({
      colors: [], sizes: ['U'], matrix: { '|U': 2 }, barcodes: { '|U': '7890000000017' },
    }).expect(200);
    await request(app).put(`${base}/${pid}/variations`).send({
      colors: [], sizes: ['U'], matrix: { '|U': 3 },
    }).expect(200);
    const { rows } = await q('SELECT barcode FROM product_variants WHERE product_id = $1 AND is_active', [pid]);
    expect(rows).toEqual([{ barcode: '7890000000017' }]);
  });
});
