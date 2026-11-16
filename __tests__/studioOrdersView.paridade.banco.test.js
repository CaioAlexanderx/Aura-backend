// ============================================================
// AURA. — View studio_orders: paridade entre produção e repositório (p-126)
//
// A view é a única fonte do quadro de Produção (une digital_orders, sales e
// marketplace_orders). Ela está versionada em
// migrations/208_studio_visual_engine.sql, mas com a guarda "se já existe,
// mantida como está em prod": nada garantia que a definição do repositório
// continuasse igual à de produção.
//
// O retrato de produção (pg_get_viewdef e information_schema, só leitura,
// 16/11/2026) fica em tests/fixtures/studio/. Este arquivo acusa diferença em
// três pontos:
//   1. texto: a definição da migration 208 contra o retrato de produção;
//   2. banco do CI: as colunas da view (nome, ordem e tipo) contra o retrato;
//   3. banco do CI: a definição que o Postgres devolve contra o retrato.
//
// A comparação ignora só o que não muda o resultado: espaços, casts para
// ::text e ::character varying (a 208 põe ::text nos status por causa do
// drift enum/varchar entre CI e produção) e o "AS nome" redundante.
//
// Quem mudar a view de propósito: escreva uma migration nova, aplique em
// produção e atualize os dois arquivos do retrato no mesmo PR.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const raiz = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(raiz, rel), 'utf8');

const RETRATO_DEF = ler('tests/fixtures/studio/studio_orders.prod.viewdef.sql');
const RETRATO_COLUNAS = JSON.parse(ler('tests/fixtures/studio/studio_orders.prod.colunas.json'));

/** Tira da definição tudo o que não muda o resultado da view. */
function normalizar(def) {
  return String(def)
    .replace(/--[^\n]*/g, '')
    .replace(/::text\b/g, '')
    .replace(/::character varying\b/g, '')
    .replace(/\b(\w+)\.(\w+)\s+AS\s+\2\b/g, '$1.$2')
    .replace(/;\s*$/, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** O SELECT da view dentro da migration 208. */
function definicaoDaMigration() {
  const sql = ler('migrations/208_studio_visual_engine.sql');
  const m = sql.match(/CREATE VIEW studio_orders AS\s*\n([\s\S]*?)\n\$v\$;/);
  if (!m) throw new Error('CREATE VIEW studio_orders não encontrado na migration 208');
  return m[1];
}

describe('studio_orders · texto da migration 208 contra o retrato de produção', () => {
  it('a definição do repositório é a de produção', () => {
    expect(normalizar(definicaoDaMigration())).toBe(normalizar(RETRATO_DEF));
  });

  it('o retrato une as três origens, nesta ordem', () => {
    const origens = [...RETRATO_DEF.matchAll(/'(\w+)'::text AS source/g)].map((m) => m[1]);
    expect(origens).toEqual(['digital', 'pdv', 'marketplace']);
  });

  it('a comparação acusa mudança de filtro, de coluna e de origem', () => {
    const base = normalizar(RETRATO_DEF);
    const semFiltro = RETRATO_DEF.replace("WHERE d.vertical = 'studio'::text", 'WHERE true');
    const outraColuna = RETRATO_DEF.replace('cu.phone AS customer_phone', 'cu.email AS customer_phone');
    const semCancelado = RETRATO_DEF.replace(" <> 'cancelled'::text", " <> 'x'::text");
    const semMarketplace = RETRATO_DEF.split('UNION ALL').slice(0, 2).join('UNION ALL');
    for (const mudada of [semFiltro, outraColuna, semCancelado, semMarketplace]) {
      expect(mudada).not.toBe(RETRATO_DEF);
      expect(normalizar(mudada)).not.toBe(base);
    }
  });

  it('a comparação ignora só cast de texto, espaço e alias redundante', () => {
    expect(normalizar('SELECT d.status::text AS status,\n  d.id')).toBe(normalizar('select d.status, d.id;'));
    expect(normalizar('SELECT d.total::numeric(12,2) AS total_amount'))
      .not.toBe(normalizar('SELECT d.total AS total_amount'));
  });
});

describe('studio_orders · banco com as migrations aplicadas contra o retrato de produção', () => {
  const CONN =
    process.env.SUPABASE_DB_URL ||
    'postgresql://aura_test:aura_test@localhost:5432/aura_test';
  let pool;
  let temBanco = false;

  beforeAll(async () => {
    pool = new Pool({ connectionString: CONN.replace('?family=4', ''), connectionTimeoutMillis: 3000 });
    try {
      await pool.query('SELECT 1');
      temBanco = true;
    } catch (err) {
      // Sem Postgres local a conferência do banco é pulada; no CI o serviço
      // existe e ela é obrigatória.
      if (process.env.CI) throw err;
    }
  });

  afterAll(async () => {
    if (pool) await pool.end().catch(() => {});
  });

  it('a view existe depois das migrations', async () => {
    if (!temBanco) return;
    const r = await pool.query("SELECT to_regclass('public.studio_orders') AS v");
    expect(r.rows[0].v).not.toBeNull();
  });

  it('as colunas têm o nome, a ordem e o tipo de produção', async () => {
    if (!temBanco) return;
    const r = await pool.query(
      `SELECT column_name, udt_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'studio_orders'
        ORDER BY ordinal_position`
    );
    expect(r.rows.map((c) => [c.column_name, c.udt_name])).toEqual(RETRATO_COLUNAS);
  });

  it('a definição que o Postgres devolve é a de produção', async () => {
    if (!temBanco) return;
    const r = await pool.query("SELECT pg_get_viewdef('public.studio_orders'::regclass, true) AS def");
    expect(normalizar(r.rows[0].def)).toBe(normalizar(RETRATO_DEF));
  });
});
