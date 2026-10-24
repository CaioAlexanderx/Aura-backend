// ============================================================
// AURA. — Excluir produto / variante nunca e negado — Postgres real
// (24/10/2026, regra do Caio: se a confirmacao apareceu e a lojista
// aceitou, o item sai)
//
// Caso real: loja com 3 itens de venda apontando para variantes nao
// conseguia excluir o produto. DELETE FROM products cascateia
// product_variants, sale_items.variant_id (FK sem acao) segurava a variante
// vendida e o retry antigo devolvia 409 "Tente desativa-lo".
//
// O que este arquivo cobre:
//   1. produto sem referencia exclui como antes (uma consulta, sem archived)
//   2. produto com variante vendida exclui; a venda continua legivel no
//      GET /pdv/sale/:id (nome do snapshot, preco, total)
//   3. produto preso por FK que nao aceita NULL (barber_stock_usage) e
//      ARQUIVADO: resposta de sucesso com archived, some do Estoque, e o
//      historico continua apontando para ele
//   4. variante vendida exclui; a venda continua legivel
//   5. variante presa por FK que nao aceita NULL e arquivada e some da lista
//   6. produto de outra loja continua 404
//
// Mesmo padrao de caixa.comandas.banco.test.js: tudo dentro de UMA
// transacao revertida no afterAll. Diferenca: db.query tambem roda dentro
// de SAVEPOINT, porque o DELETE simples do produto FALHA de proposito
// (23503) e, sem savepoint, abortaria a transacao do teste.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
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
const outraLoja = uuid();
const base = `/companies/${companyId}/products`;
const auth = { Authorization: `Bearer ${jwt.sign({ id: userId, role: 'client', plan: 'negocio', company: companyId }, 'aura-test-secret-2026', { expiresIn: '1h' })}` };

async function q(sql, params) {
  return client.query(sql, params);
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  const db = require('../src/config/database');
  // Em fila: o GET da listagem dispara duas consultas juntas (Promise.all)
  // e os savepoints de uma nao podem se misturar com os da outra.
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

  // O GET da listagem do Estoque le color/size/ncm, colunas que o banco de
  // producao tem e o schema montado pelas migrations nao. So para esta
  // transacao (some no ROLLBACK).
  await q(`ALTER TABLE products ADD COLUMN IF NOT EXISTS color TEXT, ADD COLUMN IF NOT EXISTS size TEXT, ADD COLUMN IF NOT EXISTS ncm TEXT`);

  await q(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Excluir')`,
    [userId, `fixture-${userId}@example.test`]
  );
  await q(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name)
     VALUES ($1, $3, 'Fixture Doce Encanto LTDA', 'Doce Encanto'), ($2, $3, 'Fixture Outra Loja', NULL)`,
    [companyId, outraLoja, userId]
  );

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId, role: 'client', plan: 'negocio' }; next(); });
  // Mesma ordem do private.js: ./products antes de ./variants.
  app.use('/companies/:id/products', require('../src/routes/products'));
  app.use('/companies/:id/products/:pid/variants', require('../src/routes/variants'));
  app.use('/companies/:id/pdv', require('../src/routes/pdv'));
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

async function produto(nome, empresa = companyId) {
  const { rows } = await q(
    `INSERT INTO products (company_id, name, price, stock_qty) VALUES ($1, $2, 89.9, 5) RETURNING id`,
    [empresa, nome]
  );
  return rows[0].id;
}

async function variante(pid, sufixo) {
  const { rows } = await q(
    `INSERT INTO product_variants (product_id, sku_suffix, stock_qty) VALUES ($1, $2, 3) RETURNING id`,
    [pid, sufixo]
  );
  return rows[0].id;
}

// Venda como o Caixa grava: snapshot "Produto (variante)", preco e total.
async function vender(pid, vid, snapshot, qtd = 2, preco = 89.9) {
  const saleId = uuid();
  await q(`INSERT INTO sales (id, company_id, total_amount) VALUES ($1, $2, $3)`, [saleId, companyId, qtd * preco]);
  const { rows } = await q(
    `INSERT INTO sale_items (sale_id, product_id, variant_id, quantity, unit_price, unit_cost, total_price, product_name_snapshot)
     VALUES ($1, $2, $3, $4, $5, 40, $6, $7) RETURNING id`,
    [saleId, pid, vid, qtd, preco, qtd * preco, snapshot]
  );
  return { saleId, itemId: rows[0].id };
}

async function existe(tabela, id) {
  const { rows } = await q(`SELECT is_active FROM ${tabela} WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function deleteSimplesFalha(pid) {
  await q('SAVEPOINT prova');
  try {
    await q('DELETE FROM products WHERE id = $1', [pid]);
    await q('ROLLBACK TO SAVEPOINT prova');
    return null;
  } catch (err) {
    await q('ROLLBACK TO SAVEPOINT prova');
    return err.code;
  } finally {
    await q('RELEASE SAVEPOINT prova');
  }
}

describe('DELETE /products/:pid — exclusao confirmada nunca e negada', () => {
  test('1. produto sem referencia exclui como antes', async () => {
    const pid = await produto('Fixture Brigadeiro');
    const res = await request(app).delete(`${base}/${pid}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: pid, name: 'Fixture Brigadeiro' });
    expect(await existe('products', pid)).toBeNull();
  });

  test('2. produto com variante vendida exclui e a venda continua legivel', async () => {
    const pid = await produto('Fixture Vestido Midi');
    const rosaM = await variante(pid, 'ROSA-M');
    const azulP = await variante(pid, 'AZUL-P');
    const venda = await vender(pid, rosaM, 'Fixture Vestido Midi (Rosa / M)');
    await q(`INSERT INTO digital_channel_config (company_id, hero_product_id) VALUES ($1, $2)`, [companyId, pid]);

    // O caso real se reproduz neste banco: o DELETE puro esbarra na FK.
    expect(await deleteSimplesFalha(pid)).toBe('23503');

    const res = await request(app).delete(`${base}/${pid}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: pid, name: 'Fixture Vestido Midi' });

    expect(await existe('products', pid)).toBeNull();
    expect(await existe('product_variants', rosaM)).toBeNull();
    expect(await existe('product_variants', azulP)).toBeNull();
    const { rows: hero } = await q(`SELECT hero_product_id FROM digital_channel_config WHERE company_id = $1`, [companyId]);
    expect(hero[0].hero_product_id).toBeNull();

    const { rows: [item] } = await q(`SELECT * FROM sale_items WHERE id = $1`, [venda.itemId]);
    expect(item).toMatchObject({ product_id: null, variant_id: null, product_name_snapshot: 'Fixture Vestido Midi (Rosa / M)' });
    expect(parseFloat(item.unit_price)).toBe(89.9);
    expect(parseFloat(item.total_price)).toBe(179.8);

    // A tela de detalhe da venda continua mostrando o que foi vendido.
    const det = await request(app).get(`/companies/${companyId}/pdv/sale/${venda.saleId}`);
    expect(det.status).toBe(200);
    expect(det.body.items).toHaveLength(1);
    expect(det.body.items[0]).toMatchObject({ product_name: 'Fixture Vestido Midi (Rosa / M)', quantity: '2.000' });
    expect(parseFloat(det.body.items[0].unit_price)).toBe(89.9);
    expect(parseFloat(det.body.items[0].total_price)).toBe(179.8);
  });

  test('3. FK que nao aceita NULL: produto e arquivado, sai das listas, historico intacto', async () => {
    const pid = await produto('Fixture Pomada Barbearia');
    const venda = await vender(pid, null, 'Fixture Pomada Barbearia', 1, 35);
    await q(
      `INSERT INTO barber_stock_usage (company_id, product_id, quantity_used, unit) VALUES ($1, $2, 1, 'un')`,
      [companyId, pid]
    );

    const res = await request(app).delete(`${base}/${pid}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, archived: true, id: pid, name: 'Fixture Pomada Barbearia' });

    expect(await existe('products', pid)).toEqual({ is_active: false });
    // As anulacoes foram desfeitas: o historico continua ligado ao produto.
    const { rows: [item] } = await q(`SELECT product_id FROM sale_items WHERE id = $1`, [venda.itemId]);
    expect(item.product_id).toBe(pid);

    const lista = await request(app).get(base);
    expect(lista.status).toBe(200);
    expect(lista.body.products.map((p) => p.id)).not.toContain(pid);

    // Excluir de novo o arquivado tambem e sucesso (nunca 409).
    const denovo = await request(app).delete(`${base}/${pid}`);
    expect(denovo.status).toBe(200);
    expect(denovo.body).toMatchObject({ deleted: true, archived: true });
  });

  test('6. produto de outra loja continua 404', async () => {
    const pid = await produto('Fixture Produto Alheio', outraLoja);
    const res = await request(app).delete(`${base}/${pid}`);
    expect(res.status).toBe(404);
    expect(await existe('products', pid)).toEqual({ is_active: true });
  });
});

describe('DELETE /products/:pid/variants/:vid — mesma regra', () => {
  test('4. variante vendida exclui e a venda continua legivel', async () => {
    const pid = await produto('Fixture Blusa');
    const preta = await variante(pid, 'PRETA-G');
    const branca = await variante(pid, 'BRANCA-G');
    const venda = await vender(pid, preta, 'Fixture Blusa (Preta / G)', 1, 59.9);

    const res = await request(app).delete(`${base}/${pid}/variants/${preta}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message: 'Variante removida', deleted: true });
    expect(res.body.archived).toBeUndefined();

    expect(await existe('product_variants', preta)).toBeNull();
    expect(await existe('product_variants', branca)).toEqual({ is_active: true });
    const { rows: [item] } = await q(`SELECT * FROM sale_items WHERE id = $1`, [venda.itemId]);
    expect(item).toMatchObject({ product_id: pid, variant_id: null, product_name_snapshot: 'Fixture Blusa (Preta / G)' });

    const det = await request(app).get(`/companies/${companyId}/pdv/sale/${venda.saleId}`);
    expect(det.body.items[0].product_name).toBe('Fixture Blusa');
    expect(det.body.items[0].product_name_snapshot).toBe('Fixture Blusa (Preta / G)');
  });

  test('5. FK que nao aceita NULL: variante e arquivada e some da lista de variantes', async () => {
    const pid = await produto('Fixture Saia');
    const verde = await variante(pid, 'VERDE-P');
    // Tabela de teste (some no ROLLBACK do afterAll): referencia obrigatoria.
    await q(`CREATE TABLE fixture_ref_variante (id serial PRIMARY KEY, variant_id uuid NOT NULL REFERENCES product_variants(id))`);
    await q(`INSERT INTO fixture_ref_variante (variant_id) VALUES ($1)`, [verde]);

    const res = await request(app).delete(`${base}/${pid}/variants/${verde}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message: 'Variante removida', deleted: true, archived: true });
    expect(await existe('product_variants', verde)).toEqual({ is_active: false });

    const lista = await request(app).get(`${base}/${pid}/variants`);
    expect(lista.status).toBe(200);
    expect(lista.body.variants.map((v) => v.id)).not.toContain(verde);
  });

  test('variante que nao existe continua 404', async () => {
    const pid = await produto('Fixture Short');
    const res = await request(app).delete(`${base}/${pid}/variants/${uuid()}`).set(auth);
    expect(res.status).toBe(404);
  });
});
