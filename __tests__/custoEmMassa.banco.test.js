// ============================================================
// AURA. — Preencher custos em massa (migration 448) — Postgres real
//
// O que este arquivo trava:
//   1. lista dos sem custo: so da loja, sem servico/inativo; compartilhado
//      da propria loja com "vale nas N lojas"; o de outra loja nao entra;
//      faixa de preco das variantes; filtros, busca, paginacao, contagens
//   2. previa nao grava; gravar so muda products.cost_price (custo medio,
//      preco e estoque intactos), lote + itens com a origem de cada custo
//   3. produto que ganhou custo no meio do caminho fica com o custo novo e
//      volta em mudou_no_meio; produto de outra loja volta nao_encontrado
//   4. conferencia em rascunho: item sem custo no bipe passa a usar o custo
//      novo (valor das diferencas completo); conferencia aplicada nao muda;
//      filtro "desta conferencia"
//   5. desfazer: volta ao "sem custo"; o que mudou depois (entrada de
//      mercadoria) fica como esta; uma vez so; 7 dias; outra loja 404
//   6. historico (lista e detalhe) e "ultimo atalho" da loja
//   7. permissao: editar estoque E ver custo; os outros levam 403
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
let app;

const dono = uuid();
const consulta = uuid();     // estoque so consulta: nao edita nem ve custo
const semCusto = uuid();     // edita estoque, mas nao ve custo (painel desligado)
const comCusto = uuid();     // edita estoque e ve custo (custos: true)
const semEstoque = uuid();   // ve custo, mas estoque desligado
const usuarios = [dono, consulta, semCusto, comCusto, semEstoque];
const matriz = uuid();
const filial = uuid();
const deFora = uuid();
const empresas = [filial, deFora, matriz];

const q = (sql, params) => pool.query(sql, params);
const num = (v) => (v === null || v === undefined ? null : Number(v));

async function produto(companyId, nome, extra = {}) {
  const campos = { name: nome, price: 50, cost_price: null, weighted_avg_cost: null, stock_qty: 10, ...extra };
  const cols = Object.keys(campos);
  const { rows } = await q(
    `INSERT INTO products (company_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
    [companyId, ...Object.values(campos)]
  );
  return rows[0].id;
}
const linha = async (pid) => (await q(
  `SELECT price, cost_price, weighted_avg_cost, stock_qty FROM products WHERE id = $1`, [pid])).rows[0];

const base = (loja = matriz) => `/companies/${loja}/products/cost-fills`;
const http = (user = dono) => ({
  post: (url, body = {}) => request(app).post(url).set('x-user', user).send(body),
  put: (url, body) => request(app).put(url).set('x-user', user).send(body),
  get: (url) => request(app).get(url).set('x-user', user),
});
const gravar = (itens, extra = {}, user = dono, loja = matriz) =>
  http(user).post(base(loja), { itens, dry_run: false, ...extra });

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 6 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(async () => {
    const c = await pool.connect();
    return { query: (...a) => c.query(...a), release: (...a) => c.release(...a) };
  });

  for (const u of usuarios) {
    await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Custo')`, [u, `fixture-${u}@example.test`]);
  }
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES ($1, $2, 'Matriz Fixture', 'Loja Centro')`, [matriz, dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, billing_owner_company_id) VALUES ($1, $2, 'Filial Fixture', 'Loja Shopping', $3)`, [filial, dono, matriz]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Outra Fixture')`, [deFora, dono]);
  const membro = (user, label, perms) => q(
    `INSERT INTO company_members (company_id, user_id, role_label, status, is_active, permissions) VALUES ($1, $2, $3, 'active', true, $4)`,
    [matriz, user, label, JSON.stringify(perms)]);
  await membro(consulta, 'vendedor', { estoque_consulta: true, painel: false });
  await membro(semCusto, 'estoquista', { estoque: true, pdv: true, painel: false });
  await membro(comCusto, 'estoquista', { estoque: true, pdv: true, painel: false, custos: true });
  await membro(semEstoque, 'gerente', { estoque: false, financeiro: true });

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: req.headers['x-user'] || dono }; next(); });
  app.use('/companies/:id/products', require('../src/routes/productCostFills'));
  app.use('/companies/:id/estoque/conferencias', require('../src/routes/estoqueConferencias'));
});

afterAll(async () => {
  if (!pool) return;
  // logAuditAction roda sem await depois da resposta.
  await new Promise((r) => setTimeout(r, 200));
  const limpar = [
    `DELETE FROM product_cost_fills WHERE company_id = ANY($1)`,
    `DELETE FROM stock_counts WHERE company_id = ANY($1)`,
    `DELETE FROM stock_movements WHERE company_id = ANY($1)`,
    `DELETE FROM product_variants WHERE product_id IN (SELECT id FROM products WHERE company_id = ANY($1))`,
    `DELETE FROM products WHERE company_id = ANY($1)`,
    `DELETE FROM company_members WHERE company_id = ANY($1)`,
    `DELETE FROM audit_log WHERE company_id = ANY($1)`,
  ];
  for (const sql of limpar) {
    try { await q(sql, [empresas]); } catch (e) { /* banco de CI e descartavel */ }
  }
  for (const id of empresas) {
    try { await q(`DELETE FROM companies WHERE id = $1`, [id]); } catch (e) { /* idem */ }
  }
  try { await q(`DELETE FROM users WHERE id = ANY($1)`, [usuarios]); } catch (e) { /* idem */ }
  await pool.end();
});

const ids = {};

describe('lista dos sem custo', () => {
  test('so da loja; compartilhado da propria loja com N lojas; faixa das variantes; filtros', async () => {
    ids.caneca = await produto(matriz, 'Caneca ceramica', { price: 39.9 });
    ids.vela = await produto(matriz, 'Vela lavanda', { price: 49.9, cost_price: 0 });
    ids.bolsa = await produto(matriz, 'Bolsa tote', { price: 89.9, is_group_shared: true });
    ids.vestido = await produto(matriz, 'Vestido midi', { price: 189.9 });
    ids.kit = await produto(matriz, 'Kit presente', { price: 0 });
    ids.comCusto = await produto(matriz, 'Ja tem custo', { cost_price: 20 });
    ids.comMedio = await produto(matriz, 'Ja tem medio', { weighted_avg_cost: 18.5 });
    ids.servico = await produto(matriz, 'Ajuste de barra', { unit: 'srv' });
    ids.inativo = await produto(matriz, 'Inativo', { is_active: false });
    ids.daFilial = await produto(filial, 'Compartilhado da filial', { is_group_shared: true });
    ids.deFora = await produto(deFora, 'De outra loja');
    await q(`INSERT INTO product_variants (product_id, sku_suffix, price_override, stock_qty) VALUES ($1, 'P', NULL, 1), ($1, 'G', 199.9, 1)`, [ids.vestido]);

    const r = await http().get(`${base()}/pendentes`);
    expect(r.status).toBe(200);
    expect(r.body.itens.map((i) => i.nome)).toEqual(['Bolsa tote', 'Caneca ceramica', 'Kit presente', 'Vela lavanda', 'Vestido midi']);
    expect(r.body.total).toBe(5);
    expect(r.body.contagens).toEqual({ todos: 5, desta_conferencia: null, sem_preco: 1, produtos: 7 });
    expect(r.body.lojas_do_grupo).toBe(2);
    expect(r.body.ultimo_atalho).toBeNull();
    const porNome = Object.fromEntries(r.body.itens.map((i) => [i.nome, i]));
    expect(porNome['Bolsa tote']).toMatchObject({ compartilhado: true, lojas: 2, preco: 89.9 });
    expect(porNome['Caneca ceramica']).toMatchObject({ compartilhado: false, lojas: 1, variantes: 0, preco_min: null });
    expect(porNome['Vestido midi']).toMatchObject({ variantes: 2, preco_min: 189.9, preco_max: 199.9 });
    expect(porNome['Kit presente'].preco).toBeNull();

    const sp = await http().get(`${base()}/pendentes?filtro=sem_preco`);
    expect(sp.body.itens.map((i) => i.nome)).toEqual(['Kit presente']);
    const b = await http().get(`${base()}/pendentes?busca=${encodeURIComponent('cerâ')}`);
    expect(b.status).toBe(200);
    const b2 = await http().get(`${base()}/pendentes?busca=caneca`);
    expect(b2.body.itens.map((i) => i.nome)).toEqual(['Caneca ceramica']);
    expect(b2.body.total).toBe(1);
    const pag = await http().get(`${base()}/pendentes?limit=2&offset=4`);
    expect(pag.body.itens.map((i) => i.nome)).toEqual(['Vestido midi']);
    expect(pag.body.total).toBe(5);

    const c = await http().get(`${base()}/contagem`);
    expect(c.body).toEqual({ todos: 5, desta_conferencia: null, sem_preco: 1, produtos: 7 });
  });
});

describe('gravar', () => {
  test('previa nao grava; gravar so muda cost_price; lote e itens com a origem', async () => {
    const itens = [
      { product_id: ids.caneca, custo: '18,00', origem: 'digitado' },
      { product_id: ids.vela, custo: 27.72, origem: 'sugerido' },
      { product_id: ids.bolsa, custo: 44.95, origem: 'sugerido' },
    ];
    const prev = await http().post(base(), { itens, atalho: { modo: 'markup', percentual: 80 } });
    expect(prev.status).toBe(200);
    expect(prev.body).toMatchObject({ dry_run: true, fill_id: null });
    expect(prev.body.resumo).toMatchObject({ gravar: 3, digitados: 1, sugeridos: 2, compartilhados: 1, lojas_do_grupo: 2 });
    expect(num((await linha(ids.caneca)).cost_price)).toBeNull();

    const antes = await linha(ids.bolsa);
    const r = await gravar(itens, { atalho: { modo: 'markup', percentual: 80 } });
    expect(r.status).toBe(200);
    expect(r.body.fill_id).toEqual(expect.any(String));
    expect(r.body.resumo).toMatchObject({ gravar: 3, mudou_no_meio: 0 });
    expect(r.body.itens.find((i) => i.product_id === ids.bolsa)).toMatchObject({ status: 'grava', lojas: 2, custo_depois: 44.95 });
    expect(r.body.itens[0]).not.toHaveProperty('_custoCentavos');
    ids.fill1 = r.body.fill_id;

    expect(num((await linha(ids.caneca)).cost_price)).toBe(18);
    expect(num((await linha(ids.vela)).cost_price)).toBe(27.72);
    const depois = await linha(ids.bolsa);
    expect(num(depois.cost_price)).toBe(44.95);
    expect(depois.weighted_avg_cost).toBeNull();
    expect(depois.price).toBe(antes.price);
    expect(depois.stock_qty).toBe(antes.stock_qty);

    const { rows: [lote] } = await q(`SELECT * FROM product_cost_fills WHERE id = $1`, [ids.fill1]);
    expect(lote).toMatchObject({ company_id: matriz, user_id: dono, shortcut_mode: 'markup', products_count: 3, typed_count: 1, suggested_count: 2, group_shared_count: 1 });
    expect(num(lote.shortcut_percent)).toBe(80);
    const { rows: its } = await q(`SELECT product_id, origin, cost_before, cost_after FROM product_cost_fill_items WHERE fill_id = $1`, [ids.fill1]);
    expect(its).toHaveLength(3);
    expect(its.find((i) => i.product_id === ids.vela)).toMatchObject({ origin: 'sugerido', cost_before: '0.00', cost_after: '27.72' });
    expect(its.find((i) => i.product_id === ids.caneca).cost_before).toBeNull();

    await new Promise((res) => setTimeout(res, 100));
    const { rows: aud } = await q(`SELECT action FROM audit_log WHERE company_id = $1 AND action = 'products.cost_filled'`, [matriz]);
    expect(aud.length).toBeGreaterThanOrEqual(1);

    // a lista nao tem mais os tres e lembra o ultimo atalho
    const l = await http().get(`${base()}/pendentes`);
    expect(l.body.itens.map((i) => i.nome)).toEqual(['Kit presente', 'Vestido midi']);
    expect(l.body.ultimo_atalho).toEqual({ modo: 'markup', percentual: 80 });
  });

  test('mudou no meio do caminho fica com o custo novo; outra loja e servico ficam fora', async () => {
    const p1 = await produto(matriz, 'Necessaire', { price: 59.9 });
    const p2 = await produto(matriz, 'Brinco argola', { price: 34.9 });
    // entrada de mercadoria entre abrir a lista e gravar
    await q(`UPDATE products SET weighted_avg_cost = 21.5, cost_price = 21.5 WHERE id = $1`, [p1]);
    const r = await gravar([
      { product_id: p1, custo: 25 },
      { product_id: p2, custo: 15 },
      { product_id: ids.daFilial, custo: 10 },
      { product_id: ids.deFora, custo: 10 },
      { product_id: ids.servico, custo: 10 },
    ]);
    expect(r.status).toBe(200);
    expect(r.body.resumo).toMatchObject({ gravar: 1, mudou_no_meio: 1, nao_encontrados: 2, servicos: 1 });
    expect(r.body.itens.find((i) => i.product_id === p1)).toMatchObject({ status: 'mudou_no_meio', custo_atual: 21.5 });
    expect(r.body.itens.find((i) => i.product_id === ids.daFilial).status).toBe('nao_encontrado');
    expect(num((await linha(p1)).cost_price)).toBe(21.5);
    expect(num((await linha(p2)).cost_price)).toBe(15);
    expect(num((await linha(ids.daFilial)).cost_price)).toBeNull();
    expect(num((await linha(ids.deFora)).cost_price)).toBeNull();
    const { rows: [lote] } = await q(`SELECT changed_midway_count, products_count FROM product_cost_fills WHERE id = $1`, [r.body.fill_id]);
    expect(lote).toMatchObject({ changed_midway_count: 1, products_count: 1 });
  });

  test('nada para gravar: 200 sem lote', async () => {
    const r = await gravar([{ product_id: ids.deFora, custo: 10 }]);
    expect(r.status).toBe(200);
    expect(r.body.fill_id).toBeNull();
    expect(r.body.resumo.gravar).toBe(0);
  });

  test('validacao: custo zero, repetido e sugerido sem atalho', async () => {
    let r = await gravar([{ product_id: ids.kit, custo: 0 }]);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('CUSTO_INVALIDO');
    r = await gravar([{ product_id: ids.kit, custo: 1 }, { product_id: ids.kit, custo: 2 }]);
    expect(r.body.code).toBe('PRODUTO_REPETIDO');
    r = await gravar([{ product_id: ids.kit, custo: 1, origem: 'sugerido' }]);
    expect(r.body.code).toBe('ATALHO_OBRIGATORIO');
  });
});

describe('conferencia de estoque', () => {
  test('rascunho passa a contar o custo novo; aplicada nao muda; filtro desta conferencia', async () => {
    const cam = await produto(matriz, 'Camiseta basica', { price: 59.9, stock_qty: 10 });
    const meia = await produto(matriz, 'Kit meias', { price: 29.9, stock_qty: 5 });
    const conf = (await http().post(`/companies/${matriz}/estoque/conferencias`, { escopo: { tipo: 'loja_toda' } })).body.conferencia;
    const outra = (await http().post(`/companies/${matriz}/estoque/conferencias`, { escopo: { tipo: 'loja_toda' } })).body.conferencia;
    const bipe = (c, pid, qtd) => http().put(`/companies/${matriz}/estoque/conferencias/${c}/itens`, { product_id: pid, quantidade: qtd, modo: 'definir' });
    expect((await bipe(conf.id, cam, 7)).status).toBe(200);    // faltam 3
    expect((await bipe(conf.id, meia, 5)).status).toBe(200);   // bate: nao entra no filtro
    expect((await bipe(outra.id, cam, 10)).status).toBe(200);
    expect((await http().post(`/companies/${matriz}/estoque/conferencias/${outra.id}/aplicar`, {})).status).toBe(200);

    let d = await http().get(`/companies/${matriz}/estoque/conferencias/${conf.id}/diferencas`);
    expect(d.body.resumo.itens_sem_custo).toBe(1);

    const f = await http().get(`${base()}/pendentes?filtro=conferencia&count_id=${conf.id}`);
    expect(f.status).toBe(200);
    expect(f.body.itens.map((i) => i.nome)).toEqual(['Camiseta basica']);
    expect(f.body.contagens.desta_conferencia).toBe(1);

    const r = await gravar([{ product_id: cam, custo: 29.95 }, { product_id: meia, custo: 12 }], { count_id: conf.id });
    expect(r.status).toBe(200);
    expect(r.body.itens_de_conferencia_atualizados).toBe(2);
    ids.fillConf = r.body.fill_id;
    ids.cam = cam;
    ids.conf = conf.id;
    ids.outra = outra.id;

    d = await http().get(`/companies/${matriz}/estoque/conferencias/${conf.id}/diferencas`);
    expect(d.body.resumo).toMatchObject({ itens_sem_custo: 0, valor_faltam: 89.85 });
    const { rows: [aplicada] } = await q(`SELECT custo_no_bipe FROM stock_count_items WHERE stock_count_id = $1`, [outra.id]);
    expect(aplicada.custo_no_bipe).toBeNull();

    const h = await http().get(`${base()}/${ids.fillConf}`);
    expect(h.body.conferencia).toEqual({ id: conf.id, numero: conf.numero });
  });
});

describe('desfazer', () => {
  test('volta ao sem custo; o que mudou depois fica; conferencia volta sem custo; uma vez so', async () => {
    // entrada de mercadoria depois do preenchimento: a vela ganhou custo medio
    await q(`UPDATE products SET weighted_avg_cost = 30, cost_price = 30 WHERE id = $1`, [ids.vela]);
    const r = await http().post(`${base()}/${ids.fill1}/undo`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ desfeitos: 2, mudaram_depois: 1 });
    expect(r.body.mudou_depois).toEqual([
      expect.objectContaining({ product_id: ids.vela, custo_gravado: 27.72, custo_agora: 30, motivo: 'mudou' }),
    ]);
    expect(num((await linha(ids.caneca)).cost_price)).toBeNull();
    expect(num((await linha(ids.bolsa)).cost_price)).toBeNull();
    expect(num((await linha(ids.vela)).cost_price)).toBe(30);

    const again = await http().post(`${base()}/${ids.fill1}/undo`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('JA_DESFEITO');

    const det = await http().get(`${base()}/${ids.fill1}`);
    expect(det.body).toMatchObject({ pode_desfazer: false, desfeitos: 2, mudaram_depois: 1, atalho: { modo: 'markup', percentual: 80 } });
    expect(det.body.itens.find((i) => i.product_id === ids.vela)).toMatchObject({ desfazer: 'mudou_depois', custo_agora: 30 });

    // conferencia em rascunho volta a ficar sem custo no bipe
    const u = await http().post(`${base()}/${ids.fillConf}/undo`);
    expect(u.body.desfeitos).toBe(2);
    const d = await http().get(`/companies/${matriz}/estoque/conferencias/${ids.conf}/diferencas`);
    expect(d.body.resumo.itens_sem_custo).toBe(1);
  });

  test('prazo de 7 dias e lote de outra loja', async () => {
    const p = await produto(matriz, 'Lenco seda', { price: 79.9 });
    const r = await gravar([{ product_id: p, custo: 40 }]);
    await q(`UPDATE product_cost_fills SET undo_deadline = NOW() - INTERVAL '1 minute' WHERE id = $1`, [r.body.fill_id]);
    const e = await http().post(`${base()}/${r.body.fill_id}/undo`);
    expect(e.status).toBe(410);
    expect(e.body.code).toBe('PRAZO_ENCERRADO');
    expect(num((await linha(p)).cost_price)).toBe(40);

    const fora = await http().post(`${base(filial)}/${r.body.fill_id}/undo`);
    expect(fora.status).toBe(404);
    const det = await http().get(`${base(filial)}/${r.body.fill_id}`);
    expect(det.status).toBe(404);
  });

  test('historico da loja, mais recente primeiro', async () => {
    const r = await http().get(base());
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(r.body.preenchimentos.length);
    expect(r.body.preenchimentos.length).toBeGreaterThanOrEqual(4);
    const um = r.body.preenchimentos.find((x) => x.id === ids.fill1);
    expect(um).toMatchObject({ produtos: 3, digitados: 1, sugeridos: 2, por: { id: dono, nome: 'Fixture Custo' }, pode_desfazer: false });
    expect(um.desfeito_em).toEqual(expect.any(String));
    const datas = r.body.preenchimentos.map((x) => new Date(x.criado_em).getTime());
    expect([...datas].sort((a, b) => b - a)).toEqual(datas);
    expect((await http().get(base(filial))).body.total).toBe(0);
  });
});

describe('permissao', () => {
  test('so quem edita o estoque e ve custo', async () => {
    for (const u of [consulta, semCusto, semEstoque]) {
      const r = await http(u).get(`${base()}/pendentes`);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('SEM_PERMISSAO_DE_CUSTO');
      const w = await gravar([{ product_id: ids.kit, custo: 5 }], {}, u);
      expect(w.status).toBe(403);
    }
    expect(num((await linha(ids.kit)).cost_price)).toBeNull();
    const ok = await http(comCusto).get(`${base()}/pendentes`);
    expect(ok.status).toBe(200);
    // membro da matriz nao e membro da filial
    expect((await http(comCusto).get(`${base(filial)}/pendentes`)).status).toBe(403);
  });
});
