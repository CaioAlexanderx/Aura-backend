// ============================================================
// AURA. — Relatório de Produtos (p-114) — Postgres real
//
// Confere as três consultas contra o schema das migrations. Período 01/11 a
// 13/11/2026, hoje = 13/11. Grupo: Matriz (A) e Filial (B); C é de outro dono.
//
// Matriz:
//   Calça (custo 40, preço 100) com grade P/M/G e uma variante desativada X;
//     categoria Calças (filha de Roupas); marca "Marca Teste".
//   Vestido (custo 0 = sem custo), Serviço (unit 'srv'), Inativo (is_active false).
// Filial: Meia (compartilhada, custo 5) e Bolsa (só dela, custo 60).
// C: Caneca de Fora.
//
// Vendas:
//   S1  03/11 A  total 180 (desconto 20): Calça P 2 × 50 custo 40 + Vestido 1 × 100 → rateio 90/90
//   S2  05/11 A  cancelada: Calça M 5 → fora
//   S3  06/11 A  troca: Calça G 1 → fora
//   S4  07/11 A  Calça M 1 × 100, custo vazio → entra o custo de hoje (40)
//   S5  08/11 A  Calça X (desativada) 1 × 90 custo 40 → só no agrupar=produto
//   S6  09/11 A  Meia 4 × 20 custo 5
//   S7  10/11 B  Meia 6 × 20 custo 5 + Bolsa 1 × 150 custo 60
//   S8  31/10 23h30 em São Paulo (01/11 em UTC) A: Calça G 1 → fora do período,
//       mas é o último dia vendido da G
//   S9  05/11 C  Caneca de Fora 3 → nunca aparece
//   S10 13/11 23h30 em São Paulo (14/11 em UTC) A: Calça P 1 × 100 custo 40 → dentro
//
// Tudo numa transação revertida no afterAll (padrão dos *.banco).
// ============================================================
'use strict';

const { Pool } = require('pg');
const { v4: uuid } = require('uuid');
const R = require('../src/services/relatorioProdutos');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

const HOJE = '2026-11-13';

let pool;
let client;

const dono = uuid();
const outroDono = uuid();
const A = uuid();
const B = uuid();
const C = uuid();
const id = {};

async function produto(empresa, campos) {
  const cols = Object.keys(campos);
  const { rows } = await client.query(
    `INSERT INTO products (company_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
    [empresa, ...Object.values(campos)]
  );
  return rows[0].id;
}

async function variante(pid, tamanho, estoque, ativa = true) {
  const { rows } = await client.query(
    `INSERT INTO product_variants (product_id, sku_suffix, stock_qty, is_active) VALUES ($1, $2, $3, $4) RETURNING id`,
    [pid, tamanho, estoque, ativa]
  );
  await client.query(
    `INSERT INTO product_variant_values (variant_id, attribute_name, value) VALUES ($1, 'Tamanho', $2)`,
    [rows[0].id, tamanho]
  );
  return rows[0].id;
}

async function venda(empresa, { total, quando, status = 'completed', type = 'sale', itens }) {
  const sid = uuid();
  await client.query(
    `INSERT INTO sales (id, company_id, total_amount, payment_method, status, type, created_at)
     VALUES ($1, $2, $3, 'pix', $4, $5, $6::timestamptz)`,
    [sid, empresa, total, status, type, quando]
  );
  for (const it of itens) {
    await client.query(
      `INSERT INTO sale_items (id, sale_id, product_id, variant_id, quantity, unit_price, unit_cost, total_price, product_name_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'fixture')`,
      [uuid(), sid, it.produto, it.variante || null, it.qtd, it.preco, it.custo, it.qtd * it.preco]
    );
  }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');

  await client.query(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES
       ($1, $3, 'x', 'Dona Fixture'), ($2, $4, 'x', 'Outro Fixture')`,
    [dono, outroDono, `relprod-${dono.slice(0, 8)}@example.test`, `relprod-${outroDono.slice(0, 8)}@example.test`]
  );
  await client.query(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name, is_primary) VALUES
       ($1, $4, 'Matriz Fixture', 'Loja Matriz', true),
       ($2, $4, 'Filial Fixture', 'Loja Filial', false),
       ($3, $5, 'Outra Fixture', 'Loja de Fora', true)`,
    [A, B, C, dono, outroDono]
  );
  await client.query('UPDATE companies SET billing_owner_company_id = $1 WHERE id = $2', [A, B]);

  const { rows: [roupas] } = await client.query(
    `INSERT INTO product_categories (company_id, type, name) VALUES ($1, 'product', 'Roupas') RETURNING id`, [A]);
  const { rows: [calcas] } = await client.query(
    `INSERT INTO product_categories (company_id, type, name, parent_id) VALUES ($1, 'product', 'Calças', $2) RETURNING id`, [A, roupas.id]);
  id.roupas = roupas.id;
  id.calcas = calcas.id;

  id.calca = await produto(A, { name: 'Calça Fixture', sku: 'CFX', price: 100, cost_price: 40, stock_qty: 0, brand: 'Marca Teste', category: 'Roupas' });
  await client.query(`INSERT INTO product_category_links (product_id, category_id, is_primary) VALUES ($1, $2, true)`, [id.calca, calcas.id]);
  id.p = await variante(id.calca, 'P', 10);
  id.m = await variante(id.calca, 'M', 0);
  id.g = await variante(id.calca, 'G', 30);
  id.x = await variante(id.calca, 'X', 4, false);
  id.vestido = await produto(A, { name: 'Vestido Fixture', price: 150, cost_price: 0, stock_qty: 5, category: 'Roupas' });
  id.servico = await produto(A, { name: 'Ajuste Fixture', price: 30, cost_price: 5, stock_qty: 0, unit: 'srv' });
  id.inativo = await produto(A, { name: 'Inativo Fixture', price: 10, cost_price: 5, stock_qty: 2, is_active: false });
  id.meia = await produto(B, { name: 'Meia Fixture', price: 20, cost_price: 5, stock_qty: 100, is_group_shared: true });
  id.bolsa = await produto(B, { name: 'Bolsa Fixture', price: 150, cost_price: 60, stock_qty: 3 });
  id.caneca = await produto(C, { name: 'Caneca de Fora', price: 40, cost_price: 10, stock_qty: 9 });

  await venda(A, { total: 180, quando: '2026-11-03T14:00:00-03:00', itens: [
    { produto: id.calca, variante: id.p, qtd: 2, preco: 50, custo: 40 },
    { produto: id.vestido, qtd: 1, preco: 100, custo: 0 },
  ] });
  await venda(A, { total: 500, quando: '2026-11-05T10:00:00-03:00', status: 'cancelled', itens: [
    { produto: id.calca, variante: id.m, qtd: 5, preco: 100, custo: 40 },
  ] });
  await venda(A, { total: 100, quando: '2026-11-06T10:00:00-03:00', type: 'troca', itens: [
    { produto: id.calca, variante: id.g, qtd: 1, preco: 100, custo: 40 },
  ] });
  await venda(A, { total: 100, quando: '2026-11-07T10:00:00-03:00', itens: [
    { produto: id.calca, variante: id.m, qtd: 1, preco: 100, custo: null },
  ] });
  await venda(A, { total: 90, quando: '2026-11-08T10:00:00-03:00', itens: [
    { produto: id.calca, variante: id.x, qtd: 1, preco: 90, custo: 40 },
  ] });
  await venda(A, { total: 80, quando: '2026-11-09T10:00:00-03:00', itens: [
    { produto: id.meia, qtd: 4, preco: 20, custo: 5 },
  ] });
  await venda(B, { total: 270, quando: '2026-11-10T10:00:00-03:00', itens: [
    { produto: id.meia, qtd: 6, preco: 20, custo: 5 },
    { produto: id.bolsa, qtd: 1, preco: 150, custo: 60 },
  ] });
  await venda(A, { total: 100, quando: '2026-10-31T23:30:00-03:00', itens: [
    { produto: id.calca, variante: id.g, qtd: 1, preco: 100, custo: 40 },
  ] });
  await venda(C, { total: 120, quando: '2026-11-05T10:00:00-03:00', itens: [
    { produto: id.caneca, qtd: 3, preco: 40, custo: 10 },
  ] });
  await venda(A, { total: 100, quando: '2026-11-13T23:30:00-03:00', itens: [
    { produto: id.calca, variante: id.p, qtd: 1, preco: 100, custo: 40 },
  ] });
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

const NOV = { de: '2026-11-01', ate: HOJE };
const rodar = (query = {}, { empresas = [A], podeVerCusto = true } = {}) => R.relatorioProdutos({
  companyId: empresas[0],
  companyIds: empresas,
  parametros: R.normalizarParametros({ ...NOV, ...query }, { hoje: HOJE, podeVerCusto }),
  db: client,
});
const linha = (r, chave) => r.linhas.find((l) => l.chave === chave);

describe('relatório de Produtos — banco real', () => {
  test('item: grade, rateio do desconto, cancelada e troca fora, dia de São Paulo', async () => {
    const r = await rodar({ todas: '1' });
    expect(r.escopo).toBe('loja');
    expect(r.linhas.map((l) => l.nome_exibicao).sort()).toEqual([
      'Calça Fixture · G', 'Calça Fixture · M', 'Calça Fixture · P', 'Meia Fixture', 'Vestido Fixture',
    ]);
    expect(linha(r, `v:${id.p}`)).toMatchObject({
      variante: 'P', sku: 'CFX-P', estoque: 10, custo: 40, categoria: 'Calças', categoria_id: id.calcas, marca: 'Marca Teste',
      vendidos: 3, faturamento: 190, lucro: 70, margem: 36.8, ultima_venda: HOJE, dias_sem_vender: 0, media_diaria: 0.6,
    });
    expect(linha(r, `v:${id.p}`).dias_ate_acabar).toBeGreaterThan(0);
    // Venda sem custo gravado usa o custo de hoje.
    expect(linha(r, `v:${id.m}`)).toMatchObject({ estoque: 0, vendidos: 1, faturamento: 100, lucro: 60, margem: 60, dias_ate_acabar: 0 });
    // Só a troca e a venda de 31/10 (fora do período) — mas o último dia vendido é 31/10 em São Paulo.
    expect(linha(r, `v:${id.g}`)).toMatchObject({ vendidos: 0, faturamento: 0, ultima_venda: '2026-10-31', dias_sem_vender: 13 });
    expect(linha(r, `p:${id.vestido}`)).toMatchObject({ tem_custo: false, custo: null, lucro: null, faturamento: 90 });
    expect(linha(r, `p:${id.meia}`)).toMatchObject({
      compartilhado: true, loja: { company_id: B, nome: 'Loja Filial' }, vendidos: 4, faturamento: 80, lucro: 60,
      ultima_venda: '2026-11-10',
    });
    expect(r.totais).toMatchObject({ itens: 5, faturamento: 460, lucro: 190, margem: 51.4 });
    expect(r.cobertura_custo).toMatchObject({ com_custo: 4, sem_custo: 1, faturamento_sem_custo: 90 });
  });

  test('produto: soma as variantes, inclui a venda da variante desativada, margem pela soma', async () => {
    const r = await rodar({ agrupar: 'produto' });
    const calca = linha(r, `p:${id.calca}`);
    expect(calca).toMatchObject({
      variantes: 3, estoque: 40, vendidos: 5, faturamento: 380, lucro: 180, margem: 47.4,
      dias_ate_acabar: 0, primeiro_a_acabar: { variant_id: id.m, rotulo: 'M', dias: 0 },
    });
    // A soma por produto bate com as vendas da loja no período (180 + 100 + 90 + 80 + 100).
    expect(r.totais.faturamento).toBe(550);
  });

  test('grupo: a venda das duas lojas, cada produto uma vez, nada da loja de fora', async () => {
    const r = await rodar({ agrupar: 'produto', todas: '1' }, { empresas: [A, B] });
    expect(r.escopo).toBe('grupo');
    expect(linha(r, `p:${id.meia}`)).toMatchObject({ vendidos: 10, faturamento: 200, lucro: 150 });
    expect(linha(r, `p:${id.bolsa}`)).toMatchObject({ loja: { company_id: B }, vendidos: 1, lucro: 90 });
    expect(r.linhas.filter((l) => l.product_id === id.meia)).toHaveLength(1);
    expect(r.linhas.some((l) => l.product_id === id.caneca)).toBe(false);
    expect(r.totais.faturamento).toBe(820);
  });

  test('filtros no banco: categoria com subárvore, marca, busca, inativos e serviço fora', async () => {
    const nomes = async (q) => (await rodar({ agrupar: 'produto', ...q })).linhas.map((l) => l.nome).sort();
    expect(await nomes({ categoria: id.roupas })).toEqual(['Calça Fixture']);
    expect(await nomes({ categoria: id.calcas })).toEqual(['Calça Fixture']);
    // Pelo nome antigo (products.category): o vínculo primário reescreve o da Calça para 'Calças'
    // (trigger da migration 259); o Vestido continua só com o texto.
    expect(await nomes({ categoria: 'Roupas' })).toEqual(['Vestido Fixture']);
    expect(await nomes({ categoria: 'Calças' })).toEqual(['Calça Fixture']);
    expect(await nomes({ marca: 'marca teste' })).toEqual(['Calça Fixture']);
    expect(await nomes({ busca: 'vest' })).toEqual(['Vestido Fixture']);
    expect(await nomes({ busca: 'CFX' })).toEqual(['Calça Fixture']);
    expect(await nomes({ so_ativos: '0' })).toContain('Inativo Fixture');
    expect(await nomes({ so_ativos: '0' })).not.toContain('Ajuste Fixture');
  });

  test('quem não vê custo: os mesmos números de venda, custo em null', async () => {
    const r = await rodar({}, { podeVerCusto: false });
    expect(r.totais).toMatchObject({ faturamento: 460, lucro: null, margem: null, valor_estoque_custo: null });
    expect(r.linhas.every((l) => l.custo === null && l.lucro === null)).toBe(true);
  });
});
