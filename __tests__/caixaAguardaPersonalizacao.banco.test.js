// ============================================================
// AURA. — Venda do Caixa com personalizável no Negócio (p-177, migration 456)
//
// O trigger trg_sales_studio_status passa a gravar
// 'awaiting_customization' em vez de 'pending_art' SÓ para a empresa com a
// frente Personalizados no Negócio (studio_enabled true e sem a vertical
// Studio). Tudo o mais é paridade com o que roda hoje em produção.
//
// Dois blocos:
//   1. texto: a 176 e a 208 são o retrato de produção; a 456 difere dele só
//      no valor do SET; nenhuma outra migration troca a função.
//   2. banco (CI): o trigger nas quatro situações + a folha "Recolher a
//      arte e o texto" de ponta a ponta (grava e move para pending_art, e
//      o pedido aparece na view studio_orders).
// Tudo numa transação revertida no fim. Sem Postgres local, o bloco 2 é
// pulado; no CI ele é obrigatório.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const raiz = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(raiz, rel), 'utf8').replace(/\r\n/g, '\n');

const RETRATO = ler('tests/fixtures/studio/fn_sales_studio_production_status.prod.sql');

/** O CREATE da função dentro de uma migration, até o $function$ final. */
function funcaoDaMigration(arquivo) {
  const sql = ler(arquivo);
  const m = sql.match(/CREATE OR REPLACE FUNCTION public\.fn_sales_studio_production_status\(\)[\s\S]*?\n\$function\$/);
  if (!m) throw new Error(`função não encontrada em ${arquivo}`);
  return m[0];
}
const normalizar = (s) => String(s).replace(/\s+/g, ' ').trim();

describe('fn_sales_studio_production_status · texto', () => {
  it.each(['migrations/176_studio_version_db_objects.sql', 'migrations/208_studio_visual_engine.sql'])(
    '%s é o retrato de produção', (arquivo) => {
      expect(normalizar(funcaoDaMigration(arquivo))).toBe(normalizar(RETRATO));
    }
  );

  it('a 456 só troca o valor do SET (o IF, o WHERE e o RETURN são os de produção)', () => {
    const nova = funcaoDaMigration('migrations/456_caixa_personalizado_aguarda_personalizacao.sql');
    const SET_ANTIGO = "SET studio_production_status = 'pending_art'";
    expect(RETRATO).toContain(SET_ANTIGO);
    const m = nova.match(/SET studio_production_status = CASE[\s\S]*?\n\s+END\n/);
    expect(m).not.toBeNull();
    expect(normalizar(nova.replace(m[0], SET_ANTIGO + '\n'))).toBe(normalizar(RETRATO));
    expect(m[0]).toMatch(/vertical_active::text IS DISTINCT FROM 'studio'/);
    expect(m[0]).toMatch(/pdv_settings->'studio_enabled' = 'true'::jsonb/);
    expect(m[0]).toMatch(/THEN 'awaiting_customization'\s+ELSE 'pending_art'/);
  });

  it('a 456 não recria o trigger nem mexe em outra função', () => {
    const sql = ler('migrations/456_caixa_personalizado_aguarda_personalizacao.sql').replace(/--[^\n]*/g, '');
    expect(sql).not.toMatch(/CREATE TRIGGER|DROP TRIGGER/i);
    expect((sql.match(/CREATE OR REPLACE FUNCTION/g) || []).length).toBe(1);
  });

  it('nenhuma migration depois da 456 troca a função', () => {
    const depois = fs.readdirSync(path.join(raiz, 'migrations'))
      .filter((f) => f.endsWith('.sql') && f > '456_' && f !== '456_caixa_personalizado_aguarda_personalizacao.sql')
      .filter((f) => /fn_sales_studio_production_status/.test(ler(`migrations/${f}`)));
    expect(depois).toEqual([]);
  });
});

describe('fn_sales_studio_production_status · banco', () => {
  const CONN = process.env.SUPABASE_DB_URL || 'postgresql://aura_test:aura_test@localhost:5432/aura_test';
  let pool;
  let client;
  let temBanco = false;

  const userId = uuid();
  const semFrente = uuid();   // Negócio sem a frente (hoje: 46 empresas)
  const studio = uuid();      // vertical Studio (hoje: 6 empresas)
  const noNegocio = uuid();   // frente Personalizados no Negócio (hoje: nenhuma)
  const textoTrue = uuid();   // studio_enabled em texto, não booleano
  const prod = {};

  async function venda(companyId, produtos, extraCustomization = null) {
    const id = uuid();
    await client.query(
      `INSERT INTO sales (id, company_id, total_amount, discount_amount, payment_method, status)
       VALUES ($1, $2, 10, 0, 'dinheiro', 'completed')`,
      [id, companyId]
    );
    for (const p of produtos) {
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, unit_cost, discount, total_price, product_name_snapshot, customization)
         VALUES ($1, $2, 1, 10, 0, 0, 10, 'Peça', $3::jsonb)`,
        [id, p, extraCustomization ? JSON.stringify(extraCustomization) : null]
      );
    }
    return id;
  }
  const etapa = async (saleId) =>
    (await client.query('SELECT studio_production_status FROM sales WHERE id = $1', [saleId])).rows[0].studio_production_status;

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONN.replace('?family=4', ''), connectionTimeoutMillis: 3000 });
    try {
      client = await pool.connect();
      temBanco = true;
    } catch (err) {
      if (process.env.CI) throw err;
      return;
    }
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture p-177')`,
      [userId, `fixture-${userId}@example.test`]
    );
    await client.query(
      `INSERT INTO companies (id, owner_id, legal_name, vertical_active, pdv_settings) VALUES
         ($1, $5, 'Fixture Sem Frente', NULL, '{"studio_enabled": false}'::jsonb),
         ($2, $5, 'Fixture Studio', 'studio', '{"studio_enabled": true}'::jsonb),
         ($3, $5, 'Fixture Negocio Personalizados', NULL, '{"studio_enabled": true}'::jsonb),
         ($4, $5, 'Fixture Texto', NULL, '{"studio_enabled": "true"}'::jsonb)`,
      [semFrente, studio, noNegocio, textoTrue, userId]
    );
    const cfg = JSON.stringify({ fields: [{ id: 'nome', type: 'text', label: 'Nome' }] });
    for (const cid of [semFrente, studio, noNegocio, textoTrue]) {
      prod[cid] = { pers: uuid(), comum: uuid() };
      await client.query(
        `INSERT INTO products (id, company_id, name, price, stock_qty, is_personalizable, customization_config)
         VALUES ($1, $3, 'Caneca com nome', 30, 0, true, $4::jsonb),
                ($2, $3, 'Sacola', 5, 10, false, NULL)`,
        [prod[cid].pers, prod[cid].comum, cid, cfg]
      );
    }
  });

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    if (pool) await pool.end().catch(() => {});
  });

  it('o trigger existe em sale_items, AFTER INSERT, por linha', async () => {
    if (!temBanco) return;
    const r = await client.query(
      `SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t WHERE t.tgname = 'trg_sales_studio_status'`
    );
    expect(r.rows[0].def).toMatch(/AFTER INSERT ON public\.sale_items FOR EACH ROW EXECUTE FUNCTION fn_sales_studio_production_status\(\)/);
  });

  it('Negócio sem a frente: pending_art, como hoje', async () => {
    if (!temBanco) return;
    expect(await etapa(await venda(semFrente, [prod[semFrente].pers]))).toBe('pending_art');
  });

  it('vertical Studio: pending_art, como hoje', async () => {
    if (!temBanco) return;
    expect(await etapa(await venda(studio, [prod[studio].pers]))).toBe('pending_art');
  });

  it('frente Personalizados no Negócio: awaiting_customization', async () => {
    if (!temBanco) return;
    expect(await etapa(await venda(noNegocio, [prod[noNegocio].comum, prod[noNegocio].pers]))).toBe('awaiting_customization');
  });

  it('studio_enabled em texto não liga a frente: pending_art', async () => {
    if (!temBanco) return;
    expect(await etapa(await venda(textoTrue, [prod[textoTrue].pers]))).toBe('pending_art');
  });

  it('venda sem personalizável continua sem etapa, em qualquer empresa', async () => {
    if (!temBanco) return;
    for (const cid of [semFrente, studio, noNegocio]) {
      expect(await etapa(await venda(cid, [prod[cid].comum]))).toBeNull();
    }
  });

  it('etapa já gravada não é trocada por outro item', async () => {
    if (!temBanco) return;
    const id = await venda(noNegocio, [prod[noNegocio].pers]);
    await client.query(`UPDATE sales SET studio_production_status = 'in_production' WHERE id = $1`, [id]);
    await client.query(
      `INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, unit_cost, discount, total_price, product_name_snapshot)
       VALUES ($1, $2, 1, 30, 0, 0, 30, 'Caneca com nome')`,
      [id, prod[noNegocio].pers]
    );
    expect(await etapa(id)).toBe('in_production');
  });

  describe('folha "Recolher a arte e o texto", de ponta a ponta', () => {
    let app;
    beforeAll(() => {
      if (!temBanco) return;
      const express = require('express');
      const db = require('../src/config/database');
      let sp = 0;
      db.query.mockImplementation((sql, params) => client.query(sql, params));
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
      app = express();
      app.use(express.json());
      app.use('/companies/:id/studio', require('../src/routes/studioPersonalizacaoDoPedido'));
    });

    it('grava a arte e o texto e move para Aguardando arte; a view acompanha', async () => {
      if (!temBanco) return;
      const request = require('supertest');
      const id = await venda(noNegocio, [prod[noNegocio].comum, prod[noNegocio].pers]);
      const naView = async () => (await client.query(
        `SELECT studio_production_status, source FROM studio_orders WHERE id = $1 AND company_id = $2`, [id, noNegocio]
      )).rows[0];
      expect(await naView()).toEqual({ studio_production_status: 'awaiting_customization', source: 'pdv' });

      const folha = await request(app).get(`/companies/${noNegocio}/studio/orders/${id}/personalizacao`);
      expect(folha.status).toBe(200);
      const pers = folha.body.itens.find((i) => i.is_personalizable);
      expect(folha.body.faltam).toEqual([pers.id]);

      // sem a arte: 422 e nada muda
      const vazio = await request(app).post(`/companies/${noNegocio}/studio/orders/${id}/personalizacao`)
        .send({ itens: [{ id: pers.id, customization: { nome: '' } }] });
      expect(vazio.status).toBe(422);
      expect(await etapa(id)).toBe('awaiting_customization');

      const r = await request(app).post(`/companies/${noNegocio}/studio/orders/${id}/personalizacao`)
        .send({ itens: [{ id: pers.id, customization: { nome: 'Ana' } }] });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ studio_production_status: 'pending_art', avancou: true });
      expect(await naView()).toEqual({ studio_production_status: 'pending_art', source: 'pdv' });
      const gravado = await client.query(`SELECT customization FROM sale_items WHERE id = $1`, [pers.id]);
      expect(gravado.rows[0].customization).toEqual({ nome: 'Ana' });
    });

    it('pedido de outra empresa: 404', async () => {
      if (!temBanco) return;
      const request = require('supertest');
      const id = await venda(noNegocio, [prod[noNegocio].pers]);
      const r = await request(app).get(`/companies/${studio}/studio/orders/${id}/personalizacao`);
      expect(r.status).toBe(404);
    });
  });
});
