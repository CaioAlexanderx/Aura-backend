// ============================================================
// AURA. — Venda com menos idas ao banco (p-141 a p-144) — Postgres real
//
// O POST /pdv/sale tem dois caminhos (services/vendaRapida.js):
//   - "fila"   : o de sempre, uma consulta por vez (PDV_VENDA_CAMINHO=fila)
//   - "rapido" : o novo, com as mesmas regras em menos idas (padrao)
//
// Este arquivo prova, no Postgres de verdade, tres coisas:
//
//   1. IGUALDADE LINHA A LINHA. Cada cenario roda duas vezes, a partir do
//      MESMO banco (as fixtures sao apagadas e recriadas com os mesmos ids):
//      uma vez em cada caminho. Depois de cada rodada tira-se um retrato de
//      TODA tabela que tem company_id (mais sale_items, product_variants e
//      studio_composition_items) e da resposta HTTP. Os dois retratos tem de
//      ser identicos: sales, sale_items, estoque de produto e de variante,
//      stock_movements, sale_payments, transactions, crediario, cupom,
//      vendedora, cliente. So saem da comparacao os ids gerados na hora, as
//      colunas de data/hora (*_at) e o token de acompanhamento.
//
//   2. CONCORRENCIA. Duas vendas simultaneas do ultimo item: uma entra, a
//      outra recebe 409, e o estoque nunca fica negativo.
//
//   3. IDAS AO BANCO. O numero de consultas de cada cenario, nos dois
//      caminhos, lido da linha [pdv-sale-timing] (p-140).
//
// Como o vendas.idempotencia.banco: precisa de COMMIT de verdade, entao as
// fixtures usam uuid proprio e sao apagadas no fim.
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

jest.setTimeout(120000);

let pool;
let app;
let logSpy;

// ── Fixtures: ids fixos durante o arquivo ────────────────────
const ID = {
  dono: uuid(),
  matriz: uuid(), filial: uuid(), fora: uuid(),
  simples: uuid(), grade: uuid(), daFilial: uuid(), ultimo: uuid(), deFora: uuid(),
  promo: uuid(), perso: uuid(), inexistente: uuid(), servico: uuid(),
  varP: uuid(), varM: uuid(), varUltima: uuid(),
  vendedora: uuid(), vendedoraDeFora: uuid(),
  cliente: uuid(), clienteDeFora: uuid(),
  cupomDez: uuid(), cupomCinco: uuid(), cupomEsgotado: uuid(),
  sessao: uuid(), insumo: uuid(), composicao: uuid(),
  clienteBloqueada: uuid(), comanda: uuid(), orcamento: uuid(),
};
const NOME_DO_ID = new Map(Object.entries(ID).map(([nome, id]) => [id, `<${nome}>`]));
const EMPRESAS = [ID.matriz, ID.filial, ID.fora];

// Tabelas que recebem escrita DEPOIS da resposta, sem esperar (trial,
// passos do cadastro, avisos): nao fazem parte da transacao da venda.
const FORA_DO_RETRATO = /onboarding|notif|push|event|usage|trial|audit|_log|funnel|aviso/i;

let TABELAS = [];
let SQL_COM_LINHA = '';

async function descobrirTabelas() {
  const { rows } = await pool.query(
    `SELECT c.table_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'company_id'
        AND t.table_type = 'BASE TABLE'
      ORDER BY 1`
  );
  TABELAS = rows.map((r) => r.table_name);
  // Uma consulta diz quais dessas tabelas tem linha das empresas da fixture.
  SQL_COM_LINHA = TABELAS
    .map((t) => `SELECT '${t}' AS t WHERE EXISTS (SELECT 1 FROM "${t}" WHERE company_id = ANY($1))`)
    .join(' UNION ALL ');
}

async function tabelasComLinha() {
  const { rows } = await pool.query(SQL_COM_LINHA, [EMPRESAS]);
  return rows.map((r) => r.t);
}

const FILHAS = [
  ['sale_items', `sale_id IN (SELECT id FROM sales WHERE company_id = ANY($1))`],
  ['product_variants', `product_id IN (SELECT id FROM products WHERE company_id = ANY($1))`],
  ['studio_composition_items', `composition_id IN (SELECT id FROM studio_compositions WHERE company_id = ANY($1))`],
];

async function limpar() {
  // Varias passadas: a ordem das chaves estrangeiras se resolve sozinha.
  const comLinha = await tabelasComLinha();
  for (let passada = 0; passada < 6; passada++) {
    let falhou = false;
    for (const [tabela, onde] of FILHAS) {
      try { await pool.query(`DELETE FROM ${tabela} WHERE ${onde}`, [EMPRESAS]); } catch (_) { falhou = true; }
    }
    for (const tabela of comLinha) {
      try { await pool.query(`DELETE FROM "${tabela}" WHERE company_id = ANY($1)`, [EMPRESAS]); } catch (_) { falhou = true; }
    }
    try { await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [EMPRESAS]); } catch (_) { falhou = true; }
    if (!falhou) break;
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [ID.dono]).catch(() => {});
}

async function semear({ settings = {}, caixaAberto = false, creditoDaCliente = 0 } = {}) {
  await limpar();
  const q = (sql, params) => pool.query(sql, params);
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Fixture Venda Rapida')`,
    [ID.dono, `fixture-${ID.dono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, pdv_settings) VALUES ($1, $2, 'Fixture Matriz', $3::jsonb)`,
    [ID.matriz, ID.dono, JSON.stringify(settings)]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, billing_owner_company_id) VALUES ($1, $2, 'Fixture Filial', $3)`,
    [ID.filial, ID.dono, ID.matriz]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture De Fora')`, [ID.fora, ID.dono]);

  const produto = (id, empresa, nome, preco, custo, estoque, extra = '') =>
    q(`INSERT INTO products (id, company_id, name, price, cost_price, stock_qty) VALUES ($1, $2, $3, $4, $5, $6)${extra}`,
      [id, empresa, nome, preco, custo, estoque]);
  await produto(ID.simples, ID.matriz, 'Caneca lisa', 10, 4, 20);
  await produto(ID.grade, ID.matriz, 'Camiseta basica', 25, 11.5, 0);
  await produto(ID.daFilial, ID.filial, 'Bone da filial', 7.5, 3, 7);
  await produto(ID.ultimo, ID.matriz, 'Ultima peca', 30, 12, 1);
  await produto(ID.deFora, ID.fora, 'Produto de outra empresa', 9, 2, 9);
  await produto(ID.promo, ID.matriz, 'Vestido em promocao', 100, 40, 6);
  await produto(ID.perso, ID.matriz, 'Caneca personalizada', 35, 9, 4);
  // INC-2026-11-18-02: servico (unit 'srv') nasce e fica com saldo 0.
  await produto(ID.servico, ID.matriz, 'Instalacao', 80, 0, 0);
  await q(`UPDATE products SET unit = 'srv' WHERE id = $1`, [ID.servico]);
  await q(`UPDATE products SET is_group_shared = true WHERE id = $1`, [ID.daFilial]);
  await q(`UPDATE products SET promo_price = 79.9, promo_starts_at = NOW() - INTERVAL '1 day',
             promo_ends_at = NOW() + INTERVAL '1 day' WHERE id = $1`, [ID.promo]);
  await q(`UPDATE products SET is_personalizable = true WHERE id = $1`, [ID.perso]);

  await q(`INSERT INTO product_variants (id, product_id, sku_suffix, stock_qty) VALUES
             ($1, $4, 'P', 5), ($2, $4, NULL, 0), ($3, $4, 'GG', 1)`,
    [ID.varP, ID.varM, ID.varUltima, ID.grade]);

  await q(`INSERT INTO studio_inputs (id, company_id, name, stock_qty) VALUES ($1, $2, 'Caneca branca', 50)`, [ID.insumo, ID.matriz]);
  await q(`INSERT INTO studio_compositions (id, company_id, product_id, is_active) VALUES ($1, $2, $3, true)`,
    [ID.composicao, ID.matriz, ID.perso]);
  await q(`INSERT INTO studio_composition_items (composition_id, input_id, qty_per_unit) VALUES ($1, $2, 1.5)`,
    [ID.composicao, ID.insumo]);

  await q(`INSERT INTO employees (id, company_id, name) VALUES ($1, $2, 'Bia'), ($3, $4, 'De Fora')`,
    [ID.vendedora, ID.matriz, ID.vendedoraDeFora, ID.fora]);
  await q(`INSERT INTO customers (id, company_id, name, phone) VALUES ($1, $2, 'Cliente Fixture', '11900000001'), ($3, $4, 'Cliente De Fora', NULL)`,
    [ID.cliente, ID.matriz, ID.clienteDeFora, ID.fora]);
  await q(`INSERT INTO coupons (id, company_id, code, discount_type, discount_value, is_active, max_uses, current_uses) VALUES
             ($1, $4, 'DEZ', 'percent', 10, true, NULL, 0),
             ($2, $4, 'CINCO', 'fixed', 5, true, 3, 1),
             ($3, $4, 'ESGOTADO', 'fixed', 5, true, 2, 2)`,
    [ID.cupomDez, ID.cupomCinco, ID.cupomEsgotado, ID.matriz]);
  await q(`INSERT INTO customers (id, company_id, name) VALUES ($1, $2, 'Cliente Bloqueada')`, [ID.clienteBloqueada, ID.matriz]);
  await q(`INSERT INTO customer_credit_profiles (company_id, customer_id, status, blocked_reason) VALUES ($1, $2, 'blocked', 'fixture')`,
    [ID.matriz, ID.clienteBloqueada]);
  await q(`INSERT INTO pdv_comandas (id, company_id, number, status) VALUES ($1, $2, 7, 'open')`, [ID.comanda, ID.matriz]);
  await q(`INSERT INTO pdv_comanda_items (comanda_id, company_id, product_id, name, quantity, unit_price) VALUES
             ($1, $2, $3, 'Caneca lisa', 2, 10), ($1, $2, NULL, 'Dose avulsa', 1, 18.5)`,
    [ID.comanda, ID.matriz, ID.simples]);
  await q(`INSERT INTO matcon_quotes (id, company_id, valid_until, customer_name, status) VALUES ($1, $2, CURRENT_DATE + 7, 'Cliente do Orcamento', 'open')`,
    [ID.orcamento, ID.matriz]);
  // INC-2026-11-17-03: credito a favor da cliente (o que a troca grava com
  // "Credito para"). So nos cenarios que pedem: os de antes semeiam o mesmo.
  if (creditoDaCliente > 0) {
    await q(`INSERT INTO customer_credit_transactions (company_id, customer_id, type, amount, payment_method, notes)
             VALUES ($1, $2, 'payment', $3, 'crediario_credito', 'Credito de troca (fixture)')`,
      [ID.matriz, ID.cliente, creditoDaCliente]);
  }
  if (caixaAberto) {
    await q(`INSERT INTO caixa_sessoes (id, company_id, opened_by, troco_inicial, status) VALUES ($1, $2, $3, 50, 'aberta')`,
      [ID.sessao, ID.matriz, ID.dono]);
  }
}

// ── Retrato do banco e da resposta, sem o que e gerado na hora ──
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Fora do retrato: datas/horas, tokens sorteados e contadores de sequencia.
const CHAVE_FORA = (k) => /_at$/.test(k) || /token/.test(k) || k === 'track_url'
  || k === 'idempotency_response' || k === 'seq';

function normalizar(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return v.replace(UUID_RE, (id) => NOME_DO_ID.get(id.toLowerCase()) || '<novo>');
  if (Array.isArray(v)) return v.map(normalizar);
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      if (CHAVE_FORA(k)) continue;
      out[k] = normalizar(v[k]);
    }
    return out;
  }
  return v;
}

async function retrato() {
  const foto = {};
  const ler = async (tabela, onde) => {
    const { rows } = await pool.query(`SELECT to_jsonb(t) AS r FROM "${tabela}" t WHERE ${onde}`, [EMPRESAS]);
    if (!rows.length) return;
    foto[tabela] = rows.map((x) => JSON.stringify(normalizar(x.r))).sort();
  };
  for (const tabela of await tabelasComLinha()) {
    if (FORA_DO_RETRATO.test(tabela)) continue;
    await ler(tabela, 'company_id = ANY($1)');
  }
  for (const [tabela, onde] of FILHAS) await ler(tabela, onde);
  // O dia da venda (created_at sai do retrato por ser data/hora).
  const { rows: dias } = await pool.query(
    `SELECT (created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS dia FROM sales WHERE company_id = ANY($1) ORDER BY 1`,
    [EMPRESAS]
  );
  foto['sales.dia'] = dias.map((d) => d.dia);
  return foto;
}

// As tarefas sem espera da venda (trial, resposta guardada, avisos) terminam.
const assentar = () => new Promise((r) => setTimeout(r, 120));

const PREFIXO = '[pdv-sale-timing] ';
function ultimaLinhaDeTempo() {
  const linhas = logSpy.mock.calls.map((c) => String(c[0] || '')).filter((l) => l.startsWith(PREFIXO));
  return linhas.length ? JSON.parse(linhas[linhas.length - 1].slice(PREFIXO.length)) : null;
}

function usarCaminho(caminho) {
  if (caminho === 'fila') process.env.PDV_VENDA_CAMINHO = 'fila';
  else delete process.env.PDV_VENDA_CAMINHO;
}

function postar({ rota = 'sale', body, chave, empresa = ID.matriz }) {
  const r = request(app).post(`/companies/${empresa}/pdv/${rota}`);
  if (chave) r.set('Idempotency-Key', chave);
  return r.send(body);
}

/** Roda o cenario num caminho, a partir das fixtures recriadas. */
async function rodar(cenario, caminho) {
  await semear(cenario);
  usarCaminho(caminho);
  logSpy.mockClear();
  const respostas = [];
  for (const pedido of (cenario.pedidos || [cenario])) {
    const res = await postar(pedido);
    const body = normalizar(res.body);
    // A releitura dos itens do caminho de sempre nao tem ORDER BY (a ordem e
    // a que o banco devolver). Aqui os itens sao comparados como conjunto; a
    // ordem do caminho novo (a do carrinho) tem teste proprio la embaixo.
    const ordemDosItens = body && body.sale && Array.isArray(body.sale.items)
      ? body.sale.items.map((i) => `${i.product_id}|${i.variant_id}|${i.quantity}|${i.unit_price}`)
      : null;
    if (ordemDosItens) body.sale.items = body.sale.items.map((i) => JSON.stringify(i)).sort();
    respostas.push({ status: res.status, body, ordemDosItens });
  }
  const tempo = ultimaLinhaDeTempo();
  await assentar();
  return { respostas, foto: await retrato(), tempo };
}

// ── Cenarios ─────────────────────────────────────────────────
const item = (product_id, quantity, unit_price, extra = {}) => ({ product_id, quantity, unit_price, ...extra });
const amanha = () => {
  const d = new Date(Date.now() + 5 * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
};

const TAXA = { card_fee_enabled: true, card_fee_credit_pct: 3, card_fee_debit_pct: 1.5, card_fee_pix_pct: 1 };

const CENARIOS = [
  { nome: '1 item, PIX', status: 201,
    body: { items: [item(ID.simples, 1, 10)], payment_method: 'pix' } },

  { nome: '3 itens, vendedora e cliente (simples, variante, compartilhado do grupo)', status: 201,
    body: {
      items: [item(ID.simples, 2, 10), item(ID.grade, 1, 25, { variant_id: ID.varP }), item(ID.daFilial, 3, 7.5)],
      payment_method: 'dinheiro', employee_id: ID.vendedora, customer_id: ID.cliente, seller_name: 'Bia',
    } },

  { nome: 'crediario em 3 parcelas', status: 201,
    body: {
      items: [item(ID.simples, 3, 10), item(ID.ultimo, 1, 30)],
      payment_method: 'crediario', customer_id: ID.cliente, installments: 3,
    } },

  { nome: 'crediario parcial + dinheiro, com vendedora e cupom fixo', status: 201,
    body: {
      items: [item(ID.simples, 4, 10)], customer_id: ID.cliente, employee_id: ID.vendedora, coupon_code: 'cinco',
      payments: [{ method: 'crediario', value: 20 }, { method: 'dinheiro', value: 15 }],
    } },

  { nome: 'caixa aberto, 3 formas de pagamento, taxa da maquininha, cupom, desconto manual e do item', status: 201,
    settings: { caixa_enabled: true, ...TAXA }, caixaAberto: true,
    body: {
      items: [item(ID.simples, 2, 10, { item_discount: 1 }), item(ID.grade, 1, 25, { variant_id: ID.varP })],
      coupon_code: 'DEZ', discount_type: 'fixed', discount_value: 2,
      payments: [{ method: 'pix', value: 10 }, { method: 'cartao', value: 15 }, { method: 'debito', value: 12.6 }],
      notes: 'observacao da venda',
    } },

  { nome: 'PIX com taxa da maquininha ligada, sem controle de caixa', status: 201,
    settings: { ...TAXA },
    body: { items: [item(ID.simples, 5, 10)], payment_method: 'pix' } },

  { nome: 'vender sem estoque ligado: o saldo para em zero', status: 201,
    settings: { allow_sale_without_stock: true },
    body: {
      items: [item(ID.ultimo, 3, 30), item(ID.grade, 2, 25, { variant_id: ID.varM })],
      payment_method: 'dinheiro',
    } },

  // INC-2026-11-18-02: servico com saldo 0 e "vender sem estoque" desligado.
  { nome: 'servico com saldo zero, sem a chave: entra, sem baixa nem movimento do servico', status: 201,
    body: { items: [item(ID.servico, 1, 80), item(ID.simples, 1, 10)], payment_method: 'pix' } },

  { nome: 'venda retroativa (sale_date): nao confere o estoque', status: 201,
    body: { items: [item(ID.ultimo, 5, 30), item(ID.simples, 1, 10)], payment_method: 'cartao', sale_date: '2026-10-05' } },

  { nome: 'item avulso, produto de outra empresa e variante que nao e do produto', status: 201,
    body: {
      items: [
        { quantity: 1, unit_price: 12, product_name_snapshot: 'Servico avulso' },
        item(ID.deFora, 2, 9),
        item(ID.simples, 1, 10, { variant_id: ID.varP }),
        item(ID.simples, 1, 10, { product_name_snapshot: 'Nome que o app mandou' }),
      ],
      payment_method: 'dinheiro',
    } },

  { nome: 'o mesmo produto e a mesma variante em duas linhas', status: 201,
    body: {
      items: [
        item(ID.simples, 2, 10), item(ID.grade, 2, 25, { variant_id: ID.varP }),
        item(ID.simples, 3, 9.5), item(ID.grade, 3, 25, { variant_id: ID.varP }),
      ],
      payment_method: 'debito',
    } },

  { nome: 'duas linhas do mesmo produto que juntas passam do saldo, sem a chave: passam, saldo zero', status: 201,
    body: { items: [item(ID.ultimo, 1, 30), item(ID.ultimo, 1, 30)], payment_method: 'dinheiro' } },

  { nome: 'venda com sinal e cliente novo', status: 201, rota: 'sale-com-sinal',
    body: {
      items: [item(ID.simples, 3, 10)], sinal: { method: 'pix', amount: 10 }, saldo_due_date: amanha(),
      customer: { name: 'Cliente Novo', phone: '11900000002' },
    } },

  { nome: 'venda comum com cliente novo (inline) e prazo prometido', status: 201,
    body: {
      items: [item(ID.simples, 1, 10)], payment_method: 'dinheiro',
      customer: { name: 'Outra Cliente', phone: '11900000003' }, promised_date: '2027-01-15',
    } },

  { nome: 'produto em promocao e produto personalizavel (insumos do Studio)', status: 201,
    body: { items: [item(ID.promo, 1, 79.9), item(ID.perso, 2, 35)], payment_method: 'pix' } },

  { nome: 'filial vende o proprio produto compartilhado e o da matriz nao compartilhado', status: 201,
    empresa: ID.filial,
    body: { items: [item(ID.daFilial, 1, 7.5), item(ID.simples, 1, 10)], payment_method: 'dinheiro' } },

  { nome: 'com Idempotency-Key, e a repeticao da mesma chave', status: 201,
    pedidos: [
      { body: { items: [item(ID.simples, 2, 10)], payment_method: 'pix' }, chave: 'chave-fixture-0001' },
      { body: { items: [item(ID.simples, 2, 10)], payment_method: 'pix' }, chave: 'chave-fixture-0001' },
      { body: { items: [item(ID.simples, 7, 10)], payment_method: 'pix' }, chave: 'chave-fixture-0001' },
    ],
    statusDeCada: [201, 201, 409] },

  { nome: 'quantidade fracionada e em texto; nome com aspas, virgula, chaves, barra e acento', status: 201,
    body: {
      items: [
        item(ID.simples, '2', '10.00'),
        { quantity: 0.375, unit_price: 19.9, product_name_snapshot: 'Queijo "da Ana", {meia cura} \ NULL ção' },
        item(ID.daFilial, 1.5, 7.5, { product_name_snapshot: "Boné d'água; DROP TABLE" }),
      ],
      payment_method: 'pix',
    } },

  { nome: 'linha repetida com quantidade negativa (o caminho novo grava linha a linha)', status: 201,
    settings: { allow_sale_without_stock: true },
    body: { items: [item(ID.ultimo, 5, 30), item(ID.ultimo, -3, 30), item(ID.simples, 1, 10)], payment_method: 'dinheiro' } },

  { nome: 'id de produto em maiusculas (o caminho novo le item a item)', status: 201,
    body: { items: [item(ID.promo.toUpperCase(), 1, 79.9), item(ID.simples, 1, 10)], payment_method: 'pix' } },

  { nome: 'venda com frete e endereco de entrega, e tomador da NFS-e', status: 201,
    body: {
      items: [item(ID.simples, 1, 10), { quantity: 1, unit_price: 15, product_name_snapshot: 'Frete' }],
      payment_method: 'pix', customer_id: ID.cliente, delivery_check: true,
      delivery_address: { name: 'Quem recebe', phone: '11900000009', street: 'Rua das Fixtures', number: '10', city: 'Jacarei', state: 'SP', zip_code: '12300000' },
      nfse_tomador: { doc: '529.982.247-25', nome: 'Tomador Fixture' },
    } },

  { nome: 'venda que cobra uma comanda', status: 201,
    body: {
      items: [item(ID.simples, 2, 10), { quantity: 1, unit_price: 18.5, product_name_snapshot: 'Dose avulsa' }],
      payment_method: 'pix', comanda_id: ID.comanda,
    } },

  { nome: 'venda que nasce de um orcamento do Matcon', status: 201,
    body: { items: [item(ID.simples, 2, 10)], payment_method: 'pix', customer_id: ID.cliente, quote_id: ID.orcamento } },

  { nome: 'so itens avulsos, com vendedora (nenhum produto para ler)', status: 201,
    body: { items: [{ quantity: 2, unit_price: 12, product_name_snapshot: 'Servico' }], payment_method: 'dinheiro', employee_id: ID.vendedora } },

  { nome: 'venda de valor zero (desconto de 100%)', status: 201,
    body: { items: [item(ID.simples, 1, 10)], payment_method: 'pix', discount_type: 'percent', discount_value: 100 } },

  // INC-2026-11-17-03: credito da cliente abatido na venda.
  { nome: 'credito da cliente + PIX, com caixa aberto e taxa da maquininha', status: 201,
    settings: { caixa_enabled: true, ...TAXA }, caixaAberto: true, creditoDaCliente: 50,
    body: {
      items: [item(ID.simples, 3, 10), item(ID.grade, 1, 25, { variant_id: ID.varP })], customer_id: ID.cliente,
      payment_method: 'pix', payments: [{ method: 'credito_cliente', value: 20 }, { method: 'pix', value: 35 }],
    } },
  { nome: 'venda inteira no credito da cliente', status: 201, creditoDaCliente: 50,
    body: { items: [item(ID.simples, 4, 10)], customer_id: ID.cliente, payment_method: 'credito_cliente' } },
  { nome: 'credito da cliente + crediario parcelado', status: 201, creditoDaCliente: 50,
    body: {
      items: [item(ID.simples, 3, 10), item(ID.ultimo, 1, 30)], customer_id: ID.cliente, installments: 2,
      payment_method: 'crediario', payments: [{ method: 'credito_cliente', value: 50 }, { method: 'crediario', value: 10 }],
    } },

  // ── Recusas: mesma mensagem, mesmo codigo, nada gravado ──
  { nome: 'recusa: credito da cliente maior que o saldo', status: 422, creditoDaCliente: 50,
    body: { items: [item(ID.simples, 6, 10)], customer_id: ID.cliente, payment_method: 'credito_cliente' } },
  // J (17/11): crediario com credito de troca sobrando e recusado ate usar o credito.
  { nome: 'recusa: crediario com credito da cliente sobrando', status: 422, creditoDaCliente: 50,
    body: { items: [item(ID.simples, 3, 10)], customer_id: ID.cliente, payment_method: 'crediario' } },
  { nome: 'recusa: credito da cliente com pagamentos que nao fecham', status: 422, creditoDaCliente: 50,
    body: {
      items: [item(ID.simples, 3, 10)], customer_id: ID.cliente,
      payment_method: 'pix', payments: [{ method: 'credito_cliente', value: 10 }, { method: 'pix', value: 30 }],
    } },
  { nome: 'recusa: crediario de cliente com credito bloqueado (422, nada gravado)', status: 422,
    body: { items: [item(ID.simples, 1, 10)], payment_method: 'crediario', customer_id: ID.clienteBloqueada } },
  { nome: 'recusa: comanda que nao existe (a venda inteira volta)', statusDeCada: null, status: 404,
    body: { items: [item(ID.simples, 2, 10)], payment_method: 'pix', comanda_id: ID.inexistente } },
  { nome: 'recusa: so itens avulsos com vendedora de outra empresa', status: 400,
    body: { items: [{ quantity: 2, unit_price: 12, product_name_snapshot: 'Servico' }], payment_method: 'dinheiro', employee_id: ID.vendedoraDeFora } },
  { nome: 'recusa: estoque insuficiente (produto simples)', status: 409,
    body: { items: [item(ID.ultimo, 2, 30)], payment_method: 'pix' } },
  { nome: 'recusa: estoque insuficiente na variante com sufixo', status: 409,
    body: { items: [item(ID.grade, 9, 25, { variant_id: ID.varP })], payment_method: 'pix' } },
  { nome: 'recusa: estoque insuficiente na variante sem sufixo', status: 409,
    body: { items: [item(ID.grade, 1, 25, { variant_id: ID.varM })], payment_method: 'pix' } },
  { nome: 'recusa: o segundo item sem saldo (o primeiro tem)', status: 409,
    body: { items: [item(ID.simples, 1, 10), item(ID.ultimo, 2, 30), item(ID.grade, 1, 25, { variant_id: ID.varM })], payment_method: 'pix' } },
  { nome: 'recusa: caixa obrigatorio e fechado', status: 409, settings: { caixa_enabled: true },
    body: { items: [item(ID.simples, 1, 10)], payment_method: 'pix' } },
  { nome: 'recusa: cupom que nao existe', status: 400,
    body: { items: [item(ID.simples, 1, 10)], payment_method: 'pix', coupon_code: 'NAOEXISTE' } },
  { nome: 'recusa: cupom esgotado', status: 400,
    body: { items: [item(ID.simples, 1, 10)], payment_method: 'pix', coupon_code: 'ESGOTADO' } },
  { nome: 'recusa: vendedora de outra empresa', status: 400,
    body: { items: [item(ID.simples, 1, 10)], payment_method: 'pix', employee_id: ID.vendedoraDeFora } },
  { nome: 'recusa: cliente de outro dono... do mesmo dono vale; id inexistente e 404', status: 404,
    body: { items: [item(ID.simples, 1, 10)], payment_method: 'pix', customer_id: ID.inexistente } },
  { nome: 'recusa: produto que nao existe (500, nada gravado)', status: 500,
    body: { items: [item(ID.simples, 1, 10), item(ID.inexistente, 1, 10)], payment_method: 'pix' } },
  { nome: 'recusa: product_id que nao e uuid (500, nada gravado)', status: 500,
    body: { items: [item(ID.simples, 1, 10), item('abc', 1, 10)], payment_method: 'pix' } },
  { nome: 'recusa: sem saldo no primeiro item e uuid invalido no segundo (409 do primeiro)', status: 409,
    body: { items: [item(ID.ultimo, 2, 30), item('abc', 1, 10)], payment_method: 'pix' } },
  { nome: 'recusa: desconto manual invalido', status: 400,
    body: { items: [item(ID.simples, 1, 10)], payment_method: 'pix', discount_type: 'percent', discount_value: 150 } },
];

const IDAS = [];

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 8 });

  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());
  require('../src/services/vendaIdempotente')._resetCache();

  // Colunas que existem em producao e que a venda grava, mas que nenhuma
  // migration do repositorio cria: employees.total_sales/total_revenue (venda
  // com vendedora) e sales.is_installment/total_installments/
  // credit_plan_snapshot (crediario com parcelas). No banco
  // descartavel do teste elas nascem aqui, com o tipo e o padrao de producao.
  await pool.query(
    `ALTER TABLE employees ADD COLUMN IF NOT EXISTS total_sales INTEGER DEFAULT 0,
                           ADD COLUMN IF NOT EXISTS total_revenue NUMERIC(12,2) DEFAULT 0`
  );
  await pool.query(
    `ALTER TABLE sales ADD COLUMN IF NOT EXISTS is_installment BOOLEAN DEFAULT false,
                       ADD COLUMN IF NOT EXISTS total_installments INTEGER,
                       ADD COLUMN IF NOT EXISTS credit_plan_snapshot JSONB`
  );

  await descobrirTabelas();

  app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: ID.dono }; next(); });
  app.use('/companies/:id/pdv', require('../src/routes/pdv'));

  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(async () => {
  delete process.env.PDV_VENDA_CAMINHO;
  if (IDAS.length) {
    const linhas = IDAS.map((i) => `  ${String(i.fila).padStart(3)} -> ${String(i.rapido).padStart(3)}  ${i.nome}`);
    process.stdout.write(`\n[idas ao banco na transacao da venda: fila -> rapido]\n${linhas.join('\n')}\n`);
  }
  jest.restoreAllMocks();
  if (!pool) return;
  await assentar();
  await limpar();
  await pool.end();
});

describe('igualdade linha a linha: caminho de sempre x caminho novo', () => {
  test.each(CENARIOS.map((c) => [c.nome, c]))('%s', async (_nome, cenario) => {
    const fila = await rodar(cenario, 'fila');
    const rapido = await rodar(cenario, 'rapido');

    // O cenario faz o que diz (nos dois caminhos).
    const esperados = cenario.statusDeCada || [cenario.status];
    expect(fila.respostas.map((r) => r.status)).toEqual(esperados);
    expect(rapido.respostas.map((r) => r.status)).toEqual(esperados);

    // Resposta HTTP identica, campo a campo.
    const semOrdem = (rs) => rs.map(({ status, body }) => ({ status, body }));
    expect(semOrdem(rapido.respostas)).toEqual(semOrdem(fila.respostas));

    // Banco identico, tabela a tabela, linha a linha.
    expect(Object.keys(rapido.foto).sort()).toEqual(Object.keys(fila.foto).sort());
    for (const tabela of Object.keys(fila.foto)) {
      expect({ tabela, linhas: rapido.foto[tabela] }).toEqual({ tabela, linhas: fila.foto[tabela] });
    }

    if (cenario.status === 201 && fila.tempo && rapido.tempo) {
      IDAS.push({ nome: cenario.nome, fila: fila.tempo.queries_tx + fila.tempo.queries_pos, rapido: rapido.tempo.queries_tx + rapido.tempo.queries_pos });
    }
  });

  test('o retrato enxerga a venda: as tabelas do nucleo aparecem nele', async () => {
    const r = await rodar(CENARIOS[1], 'rapido');
    for (const tabela of ['sales', 'sale_items', 'products', 'product_variants', 'stock_movements', 'sale_payments', 'transactions', 'employees', 'customers']) {
      expect(Object.keys(r.foto)).toContain(tabela);
    }
    expect(r.foto.sale_items).toHaveLength(3);
    expect(r.foto.stock_movements).toHaveLength(3);
    // O estoque baixou de verdade: 20 - 2, variante 5 - 1, filial 7 - 3.
    const estoque = async (tabela, id) => Number((await pool.query(`SELECT stock_qty FROM ${tabela} WHERE id = $1`, [id])).rows[0].stock_qty);
    expect(await estoque('products', ID.simples)).toBe(18);
    expect(await estoque('product_variants', ID.varP)).toBe(4);
    expect(await estoque('products', ID.daFilial)).toBe(4);
  });
});

// ── Concorrencia ─────────────────────────────────────────────
const contar = async (tabela, onde = 'company_id = ANY($1)') =>
  (await pool.query(`SELECT COUNT(*)::int AS n FROM ${tabela} WHERE ${onde}`, [EMPRESAS])).rows[0].n;
const saldo = async (tabela, id) =>
  Number((await pool.query(`SELECT stock_qty FROM ${tabela} WHERE id = $1`, [id])).rows[0].stock_qty);

// INC-2026-11-18-02: servico (unit 'srv') nunca e barrado nem baixado por saldo.
describe('servico nao tem saldo (os dois caminhos)', () => {
  test.each(['fila', 'rapido'])('%s: entra com saldo zero, sem baixa nem stock_movements do servico', async (caminho) => {
    const c = CENARIOS.find((x) => x.nome.startsWith('servico com saldo zero'));
    const r = await rodar(c, caminho);
    expect(r.respostas[0].status).toBe(201);
    expect(await saldo('products', ID.servico)).toBe(0);
    expect(await saldo('products', ID.simples)).toBe(19);
    expect(await contar('stock_movements', `company_id = ANY($1) AND product_id = '${ID.servico}'`)).toBe(0);
    expect(await contar('stock_movements', `company_id = ANY($1) AND product_id = '${ID.simples}'`)).toBe(1);
    expect(await contar('sale_items', `${FILHAS[0][1]} AND product_id = '${ID.servico}'`)).toBe(1);
  });

  test('produto comum com saldo zero, sem a chave, segue 409 (os dois caminhos)', async () => {
    for (const caminho of ['fila', 'rapido']) {
      const r = await rodar({ body: { items: [item(ID.servico, 1, 80), item(ID.grade, 1, 25, { variant_id: ID.varM })], payment_method: 'pix' } }, caminho);
      expect(r.respostas[0].status).toBe(409);
      expect(await contar('sales')).toBe(0);
    }
  });
});

describe('concorrencia: vendas simultaneas do ultimo item (caminho novo)', () => {
  beforeEach(() => usarCaminho('rapido'));

  test.each([
    ['produto simples', () => item(ID.ultimo, 1, 30), 'products', () => ID.ultimo,
      'Estoque insuficiente para "Ultima peca". Disponivel: 0'],
    ['variacao', () => item(ID.grade, 1, 25, { variant_id: ID.varUltima }), 'product_variants', () => ID.varUltima,
      'Estoque insuficiente para "Camiseta basica (GG)". Disponivel: 0'],
  ])('%s: uma entra, a outra recebe 409, e o saldo fica em zero', async (_nome, oItem, tabela, oId, mensagem) => {
    for (let rodada = 0; rodada < 4; rodada++) {
      await semear();
      const body = { items: [oItem()], payment_method: 'pix' };
      const [a, b] = await Promise.all([postar({ body }), postar({ body })]);

      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const recusada = a.status === 409 ? a : b;
      expect(recusada.body.error).toBe(mensagem);
      expect(await saldo(tabela, oId())).toBe(0);
      expect(await contar('sales')).toBe(1);
      expect(await contar('sale_items', FILHAS[0][1])).toBe(1);
      expect(await contar('stock_movements')).toBe(1);
      expect(await contar('sale_payments')).toBe(1);
      expect(await contar('transactions')).toBe(1);
      await assentar();
    }
  });

  test('cinco vendas de uma vez do ultimo item: so uma entra, quatro recebem 409', async () => {
    await semear();
    const body = { items: [item(ID.simples, 1, 10), item(ID.ultimo, 1, 30)], payment_method: 'dinheiro' };
    const respostas = await Promise.all([1, 2, 3, 4, 5].map(() => postar({ body })));
    expect(respostas.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(await saldo('products', ID.ultimo)).toBe(0);
    // O outro item do carrinho so baixou na venda que entrou.
    expect(await saldo('products', ID.simples)).toBe(19);
    expect(await contar('sales')).toBe(1);
    await assentar();
  });

  test('com "vender sem estoque" ligado: as duas entram e o saldo para em zero, nunca negativo', async () => {
    await semear({ settings: { allow_sale_without_stock: true } });
    const body = { items: [item(ID.ultimo, 1, 30), item(ID.grade, 1, 25, { variant_id: ID.varUltima })], payment_method: 'pix' };
    const [a, b] = await Promise.all([postar({ body }), postar({ body })]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await saldo('products', ID.ultimo)).toBe(0);
    expect(await saldo('product_variants', ID.varUltima)).toBe(0);
    expect(await contar('sales')).toBe(2);
    await assentar();
  });

  test('saldo que da para todas: todas entram e a baixa soma certo', async () => {
    await semear();
    const body = { items: [item(ID.simples, 2, 10), item(ID.grade, 1, 25, { variant_id: ID.varP })], payment_method: 'pix' };
    const respostas = await Promise.all([1, 2, 3, 4].map(() => postar({ body })));
    expect(respostas.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(await saldo('products', ID.simples)).toBe(12);
    expect(await saldo('product_variants', ID.varP)).toBe(1);
    await assentar();
  });

  test('carrinhos com os mesmos itens em ordem trocada, ao mesmo tempo: todos entram (sem deadlock)', async () => {
    for (let rodada = 0; rodada < 3; rodada++) {
      await semear();
      const ida = [item(ID.simples, 1, 10), item(ID.grade, 1, 25, { variant_id: ID.varP }), item(ID.daFilial, 1, 7.5), item(ID.promo, 1, 79.9)];
      const volta = [...ida].reverse();
      const respostas = await Promise.all([ida, volta, ida, volta].map((items) => postar({ body: { items, payment_method: 'pix' } })));
      expect(respostas.map((r) => r.status)).toEqual([201, 201, 201, 201]);
      expect(await saldo('products', ID.simples)).toBe(16);
      expect(await saldo('product_variants', ID.varP)).toBe(1);
      expect(await saldo('products', ID.daFilial)).toBe(3);
      expect(await saldo('products', ID.promo)).toBe(2);
      await assentar();
    }
  });
});

// >>> p-143
// ── Resposta pelo RETURNING (p-143) ──────────────────────────
describe('caminho novo: resposta pelo comando que gravou os itens', () => {
  const cenario = (nome) => CENARIOS.find((c) => c.nome.startsWith(nome));

  test('os itens da resposta vem na ordem do carrinho', async () => {
    for (const nome of ['3 itens', 'item avulso', 'o mesmo produto', 'quantidade fracionada']) {
      const c = cenario(nome);
      const r = await rodar(c, 'rapido');
      const pedido = c.body.items.map((i) =>
        `${i.product_id || null}|${i.variant_id || null}|${Number(i.quantity).toFixed(3)}|${Number(i.unit_price).toFixed(2)}`
          .replace(UUID_RE, (id) => NOME_DO_ID.get(id.toLowerCase()) || '<novo>'));
      expect(r.respostas[0].status).toBe(201);
      expect(r.respostas[0].ordemDosItens).toEqual(pedido);
    }
  });

  test('o numero de idas nao cresce com o numero de itens', async () => {
    const com = async (n) => {
      const items = Array.from({ length: n }, (_, i) => (i % 2 ? item(ID.simples, 1, 10) : item(ID.daFilial, 0.5, 7.5)));
      const r = await rodar({ body: { items, payment_method: 'pix' } }, 'rapido');
      expect(r.respostas[0].status).toBe(201);
      return r.tempo.queries_tx + r.tempo.queries_pos;
    };
    expect(await com(8)).toBe(await com(1));
  });

  test('PDV_VENDA_CAMINHO=fila volta ao caminho de sempre', async () => {
    const r = await rodar(cenario('1 item, PIX'), 'fila');
    expect(r.respostas[0].status).toBe(201);
    expect(r.tempo.caminho).toBe('fila');
    expect(r.tempo.queries_tx + r.tempo.queries_pos).toBeGreaterThanOrEqual(14);
  });
});
// <<< p-143

// >>> p-144
// ── Abertura em um envio (p-144) ─────────────────────────────
describe('caminho novo: abertura da transacao em um envio', () => {
  const vendaRapida = require('../src/services/vendaRapida');
  const body = () => ({ items: [item(ID.ultimo, 1, 30)], payment_method: 'pix' });

  beforeEach(() => { usarCaminho('rapido'); vendaRapida._resetarParaTeste(); });
  afterAll(() => vendaRapida._resetarParaTeste());

  const cenario = (nome) => CENARIOS.find((c) => c.nome.startsWith(nome));

  // O que o card promete, contado na linha [pdv-sale-timing] (consultas do
  // handleSale: da abertura ao COMMIT, mais as de depois do COMMIT).
  test.each([
    ['1 item, PIX', 6],
    ['3 itens, vendedora e cliente', 7],
    ['o mesmo produto e a mesma variante em duas linhas', 6],
    ['caixa aberto, 3 formas de pagamento', 8],
    // J (17/11): +1 ida so na venda no crediario (o credito da cliente que sobra).
    ['crediario em 3 parcelas', 22],
  ])('%s: no maximo %i idas', async (nome, teto) => {
    const r = await rodar(cenario(nome), 'rapido');
    expect(r.respostas[0].status).toBe(201);
    expect(r.tempo.caminho).toBe('rapido');
    expect(r.tempo.queries_tx + r.tempo.queries_pos).toBeLessThanOrEqual(teto);
  });

  test('BEGIN, trava, busca da chave e configuracao da loja vao num envio so', async () => {
    await semear();
    logSpy.mockClear();
    const res = await postar({ body: body(), chave: 'chave-abertura-0001' });
    expect(res.status).toBe(201);
    const t = ultimaLinhaDeTempo();
    expect(t.abertura).toBe('um_envio');
    // Com a chave de idempotencia a venda de 1 item no PIX continua em 6 idas.
    expect(t.queries_tx + t.queries_pos).toBeLessThanOrEqual(6);
    await assentar();
  });

  test('mesma chave em duas requisicoes simultaneas do ULTIMO item: uma venda, as duas recebem 201 (repeticao, nao 409)', async () => {
    for (let rodada = 0; rodada < 4; rodada++) {
      await semear();
      const chave = `chave-corrida-${rodada}-0001`;
      const [a, b] = await Promise.all([postar({ body: body(), chave }), postar({ body: body(), chave })]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body.sale.id).toBe(b.body.sale.id);
      expect([a.body.idempotent_replay, b.body.idempotent_replay].filter(Boolean)).toHaveLength(1);
      expect(await contar('sales')).toBe(1);
      expect(await saldo('products', ID.ultimo)).toBe(0);
      expect(await contar('stock_movements')).toBe(1);
      expect(await contar('transactions')).toBe(1);
      await assentar();
    }
  });

  test('a mesma chave depois: devolve a venda, sem gravar; com outros itens, 409 da chave', async () => {
    await semear();
    const chave = 'chave-repeticao-0001';
    const primeira = await postar({ body: body(), chave });
    await assentar();
    const repeticao = await postar({ body: body(), chave });
    const outra = await postar({ body: { items: [item(ID.simples, 1, 10)], payment_method: 'pix' }, chave });
    expect([primeira.status, repeticao.status, outra.status]).toEqual([201, 201, 409]);
    expect(repeticao.body.idempotent_replay).toBe(true);
    expect(repeticao.body.sale.id).toBe(primeira.body.sale.id);
    expect(outra.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await contar('sales')).toBe(1);
    expect(await saldo('products', ID.simples)).toBe(20);
  });

  test('se o envio unico falhar, a venda abre pelo caminho de sempre: sai igual e a chave continua valendo', async () => {
    await semear();
    const db = require('../src/config/database');
    // A conexao desta venda recusa o envio com varios comandos DEPOIS de o
    // BEGIN ter entrado (o pior caso: sobra uma transacao aberta e abortada).
    db.connect.mockImplementationOnce(async () => {
      const real = await pool.connect();
      const falha = Object.create(real);
      falha.query = (sql, ...resto) => (typeof sql === 'string' && /^BEGIN;/.test(sql)
        ? real.query('BEGIN; SELECT 1/0')
        : real.query(sql, ...resto));
      falha.release = () => real.release();
      return falha;
    });
    logSpy.mockClear();
    const chave = 'chave-reserva-0001';
    const res = await postar({ body: body(), chave });
    expect(res.status).toBe(201);
    expect(ultimaLinhaDeTempo().abertura).toBe('fila');
    expect(await contar('sales')).toBe(1);
    expect(await saldo('products', ID.ultimo)).toBe(0);
    await assentar();

    // Enquanto a pausa dura, as proximas vendas nem tentam o envio unico.
    logSpy.mockClear();
    const repeticao = await postar({ body: body(), chave });
    expect(repeticao.status).toBe(201);
    expect(repeticao.body.idempotent_replay).toBe(true);
    expect(await contar('sales')).toBe(1);

    // Passada a pausa, volta ao envio unico.
    vendaRapida._resetarParaTeste();
    logSpy.mockClear();
    const nova = await postar({ body: { items: [item(ID.simples, 1, 10)], payment_method: 'pix' } });
    expect(nova.status).toBe(201);
    expect(ultimaLinhaDeTempo().abertura).toBe('um_envio');
    await assentar();
  });

  test('caixa obrigatorio: sessao aberta entra no pagamento; fechada recusa antes de ler os produtos', async () => {
    await semear({ settings: { caixa_enabled: true }, caixaAberto: true });
    const aberta = await postar({ body: body() });
    expect(aberta.status).toBe(201);
    const { rows } = await pool.query(`SELECT sessao_id FROM sale_payments WHERE sale_id = $1`, [aberta.body.sale.id]);
    expect(rows).toEqual([{ sessao_id: ID.sessao }]);
    await assentar();

    await semear({ settings: { caixa_enabled: true } });
    logSpy.mockClear();
    const fechada = await postar({ body: body() });
    expect(fechada.status).toBe(409);
    expect(fechada.body).toEqual({ error: 'Abra o caixa antes de finalizar a venda.', code: 'CAIXA_REQUIRED' });
    // Abertura + ROLLBACK: nenhuma outra consulta.
    expect(ultimaLinhaDeTempo().queries_tx).toBe(2);
  });
});
// <<< p-144
