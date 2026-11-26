// ============================================================
// AURA. — Venda condicional (C1/C2) — Postgres real
// POST/GET /companies/:id/condicionais, GET /companies/:id/condicionais/:cid,
// GET /me/condicionais (routes/condicionais.js, routes/meCondicionais.js,
// services/condicional.js, services/listaDeCondicionais.js), migration 467.
//
// Requisitos provados aqui, no banco de verdade:
//   R1  guardar nao cria venda, lancamento, movimento de caixa nem de
//       estoque, e o estoque nao muda;
//   R2  cliente com nome e telefone valido, >= 1 peca, devolucao de hoje a
//       hoje + 30 (SP); sem data, o prazo padrao da loja;
//   R3  cada peca guardada conta 1 em "com clientes" e tira do livre;
//   R4  sem unidade livre: 409 com o numero da condicional que segura a peca
//       (tambem no produto compartilhado do grupo, e com a reserva do pedido);
//   R5  mesma Idempotency-Key devolve a mesma condicional (tambem em
//       paralelo); com outras pecas, 409;
//   R11 situacao derivada em SP, atrasadas primeiro, totalizador;
//   R14 consolidado das lojas do dono, com a loja em cada linha;
//   numeracao por loja sem repetir sob concorrencia; a ultima peca
//   disputada por duas condicionais ao mesmo tempo sai uma vez so;
//   preco do dia (promocao vigente conta) e termos copiados da loja.
//
// Fixtures com uuid proprio, apagadas no afterAll.
// ============================================================
'use strict';

jest.mock('../src/services/lojaEvents', () => ({ emit: jest.fn(), emitLojaEvent: jest.fn(async () => null) }));
// /me/condicionais chama requireAuth no proprio router: o usuario vem do app.
jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, _res, next) => next(),
  requireCompanyAccess: () => (req, _res, next) => next(),
  requirePlan: () => (req, _res, next) => next(),
  requireRole: () => (req, _res, next) => next(),
}));

const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');
const { hojeSP, somarDias } = require('../src/services/condicional');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

jest.setTimeout(60000);

const ID = {
  dono: uuid(), membro: uuid(), outroDono: uuid(),
  loja: uuid(), filial: uuid(), lista: uuid(), paralela: uuid(), semEstoque: uuid(), deFora: uuid(),
  vestido: uuid(), varM: uuid(), varG: uuid(), blusa: uuid(), ultima: uuid(), reservada: uuid(),
  servico: uuid(), compartilhada: uuid(), muito: uuid(), zerada: uuid(), daOutra: uuid(),
  cliente: uuid(), semTelefone: uuid(), daFilial: uuid(), clienteDeFora: uuid(),
  c18a: uuid(), c18b: uuid(),
};
const EMPRESAS = [ID.loja, ID.filial, ID.lista, ID.paralela, ID.semEstoque, ID.deFora, ID.c18a, ID.c18b];
const HOJE = hojeSP();
const dia = (n) => somarDias(HOJE, n);

let pool;
let app;
let usuario;
let seq = 0;
const q = (sql, params) => pool.query(sql, params);
const DONO = () => ({ id: ID.dono, role: 'client', is_staff: true });

async function limpar() {
  const passos = [
    [`UPDATE sales SET condicional_id = NULL WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM condicionais WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM condicional_sequencias WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM digital_order_items WHERE order_id IN (SELECT id FROM digital_orders WHERE company_id = ANY($1))`, [EMPRESAS]],
    [`DELETE FROM digital_orders WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM sales WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM product_variants WHERE product_id IN (SELECT id FROM products WHERE company_id = ANY($1))`, [EMPRESAS]],
    [`DELETE FROM products WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM customers WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM company_members WHERE company_id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM companies WHERE id = ANY($1)`, [EMPRESAS]],
    [`DELETE FROM users WHERE id = ANY($1)`, [[ID.dono, ID.membro, ID.outroDono]]],
  ];
  for (const [sql, params] of passos) {
    try { await q(sql, params); } catch (_) { /* banco descartavel */ }
  }
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', ''), max: 12 });
  const db = require('../src/config/database');
  db.query.mockImplementation((sql, params) => pool.query(sql, params));
  db.connect.mockImplementation(() => pool.connect());

  await limpar();
  await q(`INSERT INTO users (id, email, password_hash, full_name) VALUES
             ($1, $2, 'x', 'Fixture Dono'), ($3, $4, 'x', 'Fixture Membro'), ($5, $6, 'x', 'Outro Dono')`,
  [ID.dono, `fixture-${ID.dono}@example.test`, ID.membro, `fixture-${ID.membro}@example.test`,
    ID.outroDono, `fixture-${ID.outroDono}@example.test`]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, is_primary) VALUES ($1, $2, 'Fixture Loja LTDA', 'Centro', true)`,
    [ID.loja, ID.dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name, billing_owner_company_id) VALUES ($1, $2, 'Fixture Filial LTDA', 'Shopping', $3)`,
    [ID.filial, ID.dono, ID.loja]);
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES
             ($1, $4, 'Fixture Lista', 'Lista'),
             ($2, $4, 'Fixture Paralela', 'Paralela'),
             ($3, $4, 'Fixture Sem Estoque', 'Sem Estoque')`,
  [ID.lista, ID.paralela, ID.semEstoque, ID.dono]);
  await q(`INSERT INTO companies (id, owner_id, legal_name) VALUES ($1, $2, 'Fixture De Fora')`, [ID.deFora, ID.outroDono]);
  // C18: duas lojas do outro dono, para a lista enriquecida e o consolidado.
  await q(`INSERT INTO companies (id, owner_id, legal_name, trade_name) VALUES ($1, $3, 'Fixture C18 A', 'C18 A'), ($2, $3, 'Fixture C18 B', 'C18 B')`,
    [ID.c18a, ID.c18b, ID.outroDono]);
  await q(`UPDATE companies SET pdv_settings = '{"allow_sale_without_stock": true}'::jsonb WHERE id = $1`, [ID.semEstoque]);
  // Membro: ve Vendas na Lista; na Paralela so o Caixa.
  await q(`INSERT INTO company_members (company_id, user_id, role_label, permissions, status, is_active) VALUES
             ($1, $3, 'vendedora', '{"vendas": true}'::jsonb, 'active', true),
             ($2, $3, 'vendedora', '{"pdv": true, "vendas": false}'::jsonb, 'active', true)`,
  [ID.lista, ID.paralela, ID.membro]);

  const produto = (id, empresa, nome, preco, estoque) =>
    q(`INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $2, $3, $4, $5)`, [id, empresa, nome, preco, estoque]);
  await produto(ID.vestido, ID.loja, 'Vestido Midi', 199.9, 0);
  await produto(ID.blusa, ID.loja, 'Blusa Linho', 99.9, 50);
  await produto(ID.ultima, ID.loja, 'Saia Unica', 149, 1);
  await produto(ID.reservada, ID.loja, 'Cinto Couro', 59.9, 1);
  await produto(ID.servico, ID.loja, 'Ajuste de barra', 20, 0);
  await produto(ID.compartilhada, ID.filial, 'Bolsa Compartilhada', 250, 1);
  await produto(ID.muito, ID.paralela, 'Meia', 10, 100);
  await produto(ID.zerada, ID.semEstoque, 'Peca sem saldo', 30, 0);
  await produto(ID.daOutra, ID.deFora, 'Produto de outro dono', 9, 9);
  await q(`UPDATE products SET unit = 'srv' WHERE id = $1`, [ID.servico]);
  await q(`UPDATE products SET is_group_shared = true WHERE id = $1`, [ID.compartilhada]);
  // Promocao vigente na blusa: o preco do dia e o "Por".
  await q(`UPDATE products SET promo_price = 79.9, promo_starts_at = NOW() - interval '1 day', promo_ends_at = NOW() + interval '1 day' WHERE id = $1`, [ID.blusa]);
  await q(`INSERT INTO product_variants (id, product_id, sku_suffix, stock_qty, price_override, color_name, is_active) VALUES
             ($1, $3, 'AZ-M', 2, NULL, 'Azul', true), ($2, $3, 'AZ-G', 1, 219.9, 'Azul', true)`,
  [ID.varM, ID.varG, ID.vestido]);
  await q(`INSERT INTO product_variant_values (variant_id, attribute_name, value) VALUES ($1, 'Tamanho', 'M'), ($2, 'Tamanho', 'G')`,
    [ID.varM, ID.varG]);

  await q(`INSERT INTO customers (id, company_id, name, phone) VALUES
             ($1, $4, 'Ana Souza', '(11) 98888-7777'), ($2, $4, 'Sem Telefone', NULL), ($3, $5, 'Bia da Filial', '11977776666')`,
  [ID.cliente, ID.semTelefone, ID.daFilial, ID.loja, ID.filial]);
  await q(`INSERT INTO customers (id, company_id, name, phone) VALUES ($1, $2, 'De Outro Dono', '11966665555')`, [ID.clienteDeFora, ID.deFora]);

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = usuario; next(); });
  app.use('/companies/:id/condicionais', require('../src/routes/condicionais'));
  app.use('/me', require('../src/routes/meCondicionais'));
});

beforeEach(() => {
  usuario = DONO();
  delete process.env.CONDICIONAL_LIBERADA;
});

afterAll(async () => {
  if (!pool) return;
  await limpar();
  await pool.end();
});

function chave() { seq += 1; return `teste-cond-${seq}-${uuid()}`; }

function guardar(empresa, body, k = chave()) {
  return request(app).post(`/companies/${empresa}/condicionais`).set('Idempotency-Key', k).send(body);
}

async function contarEfeitos() {
  const { rows } = await q(
    `SELECT (SELECT COUNT(*) FROM transactions WHERE company_id = ANY($1))::int AS transacoes,
            (SELECT COUNT(*) FROM sales WHERE company_id = ANY($1))::int AS vendas,
            (SELECT COUNT(*) FROM stock_movements WHERE company_id = ANY($1))::int AS movimentos,
            (SELECT COUNT(*) FROM caixa_movimentos WHERE company_id = ANY($1))::int AS caixa`,
    [EMPRESAS]);
  return rows[0];
}

async function estoques() {
  const { rows } = await q(
    `SELECT (SELECT stock_qty FROM product_variants WHERE id = $1)::numeric AS var_m,
            (SELECT stock_qty FROM products WHERE id = $2)::numeric AS blusa`,
    [ID.varM, ID.blusa]);
  return { var_m: Number(rows[0].var_m), blusa: Number(rows[0].blusa) };
}

describe('guardar (R1, R2, R3, preco do dia, termos)', () => {
  test('nasce aberta, com o preco do dia, sem venda, sem lancamento, sem caixa e sem baixa', async () => {
    await q(`UPDATE companies SET pdv_settings = '{"condicional_termos": "Devolver sem uso.\\nCom etiqueta.", "condicional_prazo_padrao": 5}'::jsonb WHERE id = $1`, [ID.loja]);
    const efeitosAntes = await contarEfeitos();
    const estoqueAntes = await estoques();
    const r = await guardar(ID.loja, {
      customer_id: ID.cliente,
      items: [{ product_id: ID.vestido, variant_id: ID.varM }, { product_id: ID.vestido, variant_id: ID.varG }, { product_id: ID.blusa }],
      seller_name: 'Carla', notes: 'Vai provar para o casamento',
    });
    expect(r.status).toBe(201);
    const c = r.body.condicional;
    expect(c).toMatchObject({
      status: 'aberta', situacao: 'com_cliente', parcial: false, numero: 1, numero_exibicao: 'C-0001',
      customer_id: ID.cliente, customer_name: 'Ana Souza', customer_phone: '11988887777',
      seller_name: 'Carla', notes: 'Vai provar para o casamento',
      due_date: dia(5), terms: 'Devolver sem uso.\nCom etiqueta.', created_by: ID.dono,
    });
    expect(r.body.avisos).toEqual([]);
    const [m, g, blusa] = c.items;
    expect(m).toMatchObject({ product_name: 'Vestido Midi', variant_label: 'AZ-M', color_name: 'Azul', size_label: 'M', unit_price: 199.9, situacao: 'com_cliente', sale_id: null });
    expect(g).toMatchObject({ size_label: 'G', unit_price: 219.9 });
    expect(blusa).toMatchObject({ variant_id: null, unit_price: 79.9, preco_hoje: 79.9, preco_mudou: false });
    expect(c.resumo).toMatchObject({ pecas: 3, com_cliente: 3, valor_total: 499.7, valor_com_cliente: 499.7 });
    expect(c.events.map((e) => e.tipo)).toEqual(['criada']);
    expect(c.events[0].dados).toMatchObject({ pecas: 3, total: 499.7 });

    expect(await contarEfeitos()).toEqual(efeitosAntes);
    expect(await estoques()).toEqual(estoqueAntes);
    const { rows: [s] } = await q(`SELECT COUNT(*)::int AS n FROM sales WHERE condicional_id = $1`, [c.id]);
    expect(s.n).toBe(0);
  });

  test('o termo copiado nao muda quando a loja muda o texto', async () => {
    const r = await guardar(ID.loja, { customer_id: ID.cliente, items: [{ product_id: ID.blusa }], due_date: HOJE });
    expect(r.status).toBe(201);
    await q(`UPDATE companies SET pdv_settings = '{"condicional_termos": "Texto novo"}'::jsonb WHERE id = $1`, [ID.loja]);
    const d = await request(app).get(`/companies/${ID.loja}/condicionais/${r.body.condicional.id}`);
    expect(d.body.condicional.terms).toBe('Devolver sem uso.\nCom etiqueta.');
    expect(d.body.condicional.situacao).toBe('vence_hoje');
    // Loja sem prazo gravado: 3 dias; sem texto: sem termos.
    await q(`UPDATE companies SET pdv_settings = '{}'::jsonb WHERE id = $1`, [ID.loja]);
    const r2 = await guardar(ID.loja, { customer_id: ID.cliente, items: [{ product_id: ID.blusa }] });
    expect(r2.body.condicional).toMatchObject({ due_date: dia(3), terms: null });
  });

  test('R2: telefone, data e cliente', async () => {
    const sem = await guardar(ID.loja, { customer_id: ID.semTelefone, items: [{ product_id: ID.blusa }] });
    expect(sem.status).toBe(422);
    expect(sem.body.code).toBe('COND_TELEFONE');
    // O telefone do corpo completa o cadastro sem telefone (e nao o altera).
    const com = await guardar(ID.loja, { customer_id: ID.semTelefone, customer_phone: '+55 21 3333-4444', items: [{ product_id: ID.blusa }] });
    expect(com.status).toBe(201);
    expect(com.body.condicional.customer_phone).toBe('2133334444');
    const { rows: [cli] } = await q(`SELECT phone FROM customers WHERE id = $1`, [ID.semTelefone]);
    expect(cli.phone).toBeNull();

    expect((await guardar(ID.loja, { customer_id: ID.cliente, items: [{ product_id: ID.blusa }], due_date: dia(-1) })).body.code).toBe('COND_DATA');
    expect((await guardar(ID.loja, { customer_id: ID.cliente, items: [{ product_id: ID.blusa }], due_date: dia(31) })).body.code).toBe('COND_DATA');
    expect((await guardar(ID.loja, { customer_id: ID.cliente, items: [{ product_id: ID.blusa }], due_date: dia(30) })).status).toBe(201);
    expect((await guardar(ID.loja, { customer_id: ID.cliente, items: [] })).body.code).toBe('COND_SEM_PECAS');
    expect((await guardar(ID.loja, { items: [{ product_id: ID.blusa }] })).body.code).toBe('COND_CLIENTE_OBRIGATORIO');
    // Cliente de outro dono: 404. Cliente da filial (mesmo dono): vale.
    expect((await guardar(ID.loja, { customer_id: ID.clienteDeFora, items: [{ product_id: ID.blusa }] })).status).toBe(404);
    expect((await guardar(ID.loja, { customer_id: ID.daFilial, items: [{ product_id: ID.blusa }] })).status).toBe(201);
  });

  test('so peca de prateleira, da loja, com a variante escolhida', async () => {
    const b = (items) => guardar(ID.loja, { customer_id: ID.cliente, items });
    expect((await b([{ product_id: ID.servico }])).body.code).toBe('COND_ITEM_NAO_PECA');
    expect((await b([{ product_id: ID.vestido }])).body.code).toBe('COND_VARIANTE_OBRIGATORIA');
    expect((await b([{ product_id: ID.daOutra }])).status).toBe(404);
    expect((await b([{ product_id: ID.blusa, variant_id: ID.varM }])).body.code).toBe('COND_ITEM_INVALIDO');
    expect((await b([{ product_id: ID.blusa, quantity: 2 }])).body.code).toBe('COND_QUANTIDADE');
  });
});

describe('livres = estoque − com clientes − reservado (R3, R4)', () => {
  test('a ultima unidade sai uma vez; a segunda recebe o numero de quem segura', async () => {
    const primeira = await guardar(ID.loja, { customer_id: ID.cliente, items: [{ product_id: ID.ultima }] });
    expect(primeira.status).toBe(201);
    const numero = primeira.body.condicional.numero_exibicao;
    const segunda = await guardar(ID.loja, { customer_id: ID.daFilial, items: [{ product_id: ID.ultima }] });
    expect(segunda.status).toBe(409);
    expect(segunda.body.code).toBe('COND_SEM_SALDO');
    expect(segunda.body.error).toContain(numero);
    expect(segunda.body.faltas[0]).toMatchObject({
      product_id: ID.ultima, estoque: 1, com_clientes: 1, reservado: 0, livre: 0, pedidas: 1,
      condicionais: [expect.objectContaining({ id: primeira.body.condicional.id, numero_exibicao: numero, customer_name: 'Ana Souza' })],
    });
    // Nada foi gravado na recusada.
    const { rows: [n] } = await q(
      `SELECT COUNT(*)::int AS n FROM condicional_itens i JOIN condicionais c ON c.id = i.condicional_id
        WHERE c.company_id = $1 AND i.product_id = $2`, [ID.loja, ID.ultima]);
    expect(n.n).toBe(1);
  });

  test('por variante: a M tem 2, a terceira M nao entra', async () => {
    // A primeira condicional do arquivo ja levou 1 M.
    const ok = await guardar(ID.loja, { customer_id: ID.cliente, items: [{ product_id: ID.vestido, variant_id: ID.varM }] });
    expect(ok.status).toBe(201);
    const nao = await guardar(ID.loja, { customer_id: ID.cliente, items: [{ product_id: ID.vestido, variant_id: ID.varM }] });
    expect(nao.status).toBe(409);
    expect(nao.body.faltas[0]).toMatchObject({ variant_id: ID.varM, estoque: 2, com_clientes: 2, livre: 0 });
    expect(nao.body.faltas[0].condicionais).toHaveLength(2);
  });

  test('peca que voltou ou condicional cancelada libera; ficou sem venda continua fora', async () => {
    const { rows: [i] } = await q(
      `SELECT i.id, i.condicional_id FROM condicional_itens i JOIN condicionais c ON c.id = i.condicional_id
        WHERE c.company_id = $1 AND i.product_id = $2`, [ID.loja, ID.ultima]);
    await q(`UPDATE condicional_itens SET situacao = 'ficou' WHERE id = $1`, [i.id]);
    expect((await guardar(ID.loja, { customer_id: ID.cliente, items: [{ product_id: ID.ultima }] })).status).toBe(409);
    await q(`UPDATE condicional_itens SET situacao = 'voltou' WHERE id = $1`, [i.id]);
    const r = await guardar(ID.loja, { customer_id: ID.cliente, items: [{ product_id: ID.ultima }] });
    expect(r.status).toBe(201);
    await q(`UPDATE condicionais SET status = 'cancelada', cancelled_at = NOW() WHERE id = $1`, [r.body.condicional.id]);
    expect((await guardar(ID.loja, { customer_id: ID.cliente, items: [{ product_id: ID.ultima }] })).status).toBe(201);
  });

  test('a reserva do pedido do balcao tambem tira do livre', async () => {
    const pedido = uuid();
    await q(`INSERT INTO digital_orders (id, company_id, order_number, customer_name, customer_phone, subtotal, total, status, origem, stock_deducted)
             VALUES ($1, $2, 'RS-COND-1', 'Cliente', '', 59.9, 59.9, 'confirmed', 'balcao', false)`, [pedido, ID.loja]);
    await q(`INSERT INTO digital_order_items (order_id, product_id, product_name, unit_price, quantity, subtotal)
             VALUES ($1, $2, 'Cinto Couro', 59.9, 1, 59.9)`, [pedido, ID.reservada]);
    const r = await guardar(ID.loja, { customer_id: ID.cliente, items: [{ product_id: ID.reservada }] });
    expect(r.status).toBe(409);
    expect(r.body.faltas[0]).toMatchObject({ reservado: 1, com_clientes: 0, livre: 0, condicionais: [] });
    expect(r.body.error).toMatch(/separada num pedido/);
  });

  test('produto compartilhado: a condicional da matriz segura o estoque unico da filial', async () => {
    const r = await guardar(ID.loja, { customer_id: ID.cliente, items: [{ product_id: ID.compartilhada }] });
    expect(r.status).toBe(201);
    const naFilial = await guardar(ID.filial, { customer_id: ID.daFilial, items: [{ product_id: ID.compartilhada }] });
    expect(naFilial.status).toBe(409);
    expect(naFilial.body.faltas[0].condicionais[0]).toMatchObject({ id: r.body.condicional.id, company_id: ID.loja });
  });

  test('"vender sem estoque" ligado: entra com o aviso', async () => {
    const r = await guardar(ID.semEstoque, { customer_id: ID.cliente, items: [{ product_id: ID.zerada }] });
    expect(r.status).toBe(201);
    expect(r.body.avisos[0]).toMatchObject({
      product_id: ID.zerada, estoque: 0, livre: 0,
      mensagem: 'Sem unidade livre. Entra mesmo assim porque sua loja vende sem estoque.',
    });
  });
});

describe('Idempotency-Key (R5) e concorrencia', () => {
  test('mesma chave: a mesma condicional; com outras pecas, 409', async () => {
    const k = chave();
    const corpo = { customer_id: ID.cliente, items: [{ product_id: ID.muito }, { product_id: ID.muito }] };
    const a = await guardar(ID.paralela, corpo, k);
    const b = await guardar(ID.paralela, corpo, k);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.condicional.id).toBe(a.body.condicional.id);
    const outra = await guardar(ID.paralela, { customer_id: ID.cliente, items: [{ product_id: ID.muito }] }, k);
    expect(outra.status).toBe(409);
    expect(outra.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', condicional_id: a.body.condicional.id });
  });

  test('uuid em maiusculas vale e a repeticao reconhece as mesmas pecas', async () => {
    const k = chave();
    const corpo = { customer_id: ID.cliente.toUpperCase(), items: [{ product_id: ID.muito.toUpperCase() }] };
    const a = await guardar(ID.paralela, corpo, k);
    expect(a.status).toBe(201);
    expect(a.body.condicional.items[0].product_id).toBe(ID.muito);
    expect(a.body.condicional.customer_id).toBe(ID.cliente);
    // Repeticao com o mesmo uuid em minusculas: as mesmas pecas, 200.
    const b = await guardar(ID.paralela, { customer_id: ID.cliente, items: [{ product_id: ID.muito }] }, k);
    expect(b.status).toBe(200);
    expect(b.body.condicional.id).toBe(a.body.condicional.id);
  });

  test('numero ja usado por fora da sequencia: acerta a sequencia e grava (nunca 500)', async () => {
    const { rows: [s] } = await q(`SELECT ultimo FROM condicional_sequencias WHERE company_id = $1`, [ID.loja]);
    // Uma condicional gravada sem passar pela sequencia (importacao, por exemplo).
    await q(`INSERT INTO condicionais (company_id, numero, customer_name, customer_phone, due_date, status)
             VALUES ($1, $2, 'Importada', '11900000000', CURRENT_DATE, 'encerrada')`, [ID.loja, s.ultimo + 1]);
    const r = await guardar(ID.loja, { customer_id: ID.cliente, items: [{ product_id: ID.blusa }] });
    expect(r.status).toBe(201);
    expect(r.body.condicional.numero).toBe(s.ultimo + 2);
    const { rows: [depois] } = await q(`SELECT ultimo FROM condicional_sequencias WHERE company_id = $1`, [ID.loja]);
    expect(depois.ultimo).toBe(s.ultimo + 2);
  });

  test('a mesma chave em paralelo grava uma so', async () => {
    const k = chave();
    const corpo = { customer_id: ID.cliente, items: [{ product_id: ID.muito }] };
    const rs = await Promise.all([1, 2, 3, 4].map(() => guardar(ID.paralela, corpo, k)));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 200, 201]);
    expect(new Set(rs.map((r) => r.body.condicional.id)).size).toBe(1);
    const { rows: [n] } = await q(`SELECT COUNT(*)::int AS n FROM condicionais WHERE company_id = $1 AND idempotency_key = $2`, [ID.paralela, k]);
    expect(n.n).toBe(1);
  });

  test('numeracao por loja nao repete sob concorrencia', async () => {
    const { rows: [antes] } = await q(`SELECT COALESCE(MAX(numero), 0)::int AS n FROM condicionais WHERE company_id = $1`, [ID.paralela]);
    const rs = await Promise.all(Array.from({ length: 8 }, () =>
      guardar(ID.paralela, { customer_id: ID.cliente, items: [{ product_id: ID.muito }] })));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    const numeros = rs.map((r) => r.body.condicional.numero).sort((x, y) => x - y);
    expect(numeros).toEqual(Array.from({ length: 8 }, (_, i) => antes.n + i + 1));
    // Outra loja tem a propria sequencia.
    const { rows: [l] } = await q(`SELECT MIN(numero)::int AS n FROM condicionais WHERE company_id = $1`, [ID.loja]);
    expect(l.n).toBe(1);
  });

  test('duas condicionais pela ultima peca ao mesmo tempo: uma entra, a outra 409', async () => {
    const peca = uuid();
    await q(`INSERT INTO products (id, company_id, name, price, stock_qty) VALUES ($1, $2, 'Peca disputada', 50, 1)`, [peca, ID.paralela]);
    const rs = await Promise.all([1, 2].map(() =>
      guardar(ID.paralela, { customer_id: ID.cliente, items: [{ product_id: peca }] })));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
  });
});

describe('lista, situacao e totalizador (R11)', () => {
  const L = {};
  async function direta({ numero, nome, telefone, cliente = null, due, status = 'aberta', itens }) {
    const id = uuid();
    await q(`INSERT INTO condicionais (id, company_id, numero, customer_id, customer_name, customer_phone, due_date, status, closed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, CASE WHEN $8 = 'encerrada' THEN NOW() END)`,
    [id, ID.lista, numero, cliente, nome, telefone, due, status]);
    for (const it of itens) {
      await q(`INSERT INTO condicional_itens (condicional_id, product_id, product_name, unit_price, situacao, sale_id)
               VALUES ($1, $2, $3, $4, $5, $6)`, [id, ID.muito, it.nome || 'Peca', it.preco, it.sit || 'com_cliente', it.venda || null]);
    }
    return id;
  }

  beforeAll(async () => {
    const venda = uuid();
    await q(`INSERT INTO sales (id, company_id, total_amount) VALUES ($1, $2, 100)`, [venda, ID.lista]);
    L.emDia = await direta({ numero: 1, nome: 'Clara', telefone: '11911110001', due: dia(2), itens: [{ preco: 100 }, { preco: 50, sit: 'voltou' }] });
    L.hoje = await direta({ numero: 2, nome: 'Duda', telefone: '11911110002', due: dia(0), itens: [{ preco: 80 }] });
    L.atrasada = await direta({ numero: 3, nome: 'Eva', telefone: '11911110003', cliente: ID.cliente, due: dia(-3), itens: [{ preco: 120 }, { preco: 30, sit: 'ficou' }] });
    L.muitoAtrasada = await direta({ numero: 4, nome: 'Fabi', telefone: '11911110004', cliente: ID.cliente, due: dia(-10), itens: [{ preco: 10, nome: 'Lenco Seda' }] });
    // Tudo decidido, peca que ficou sem venda, prazo ainda longe: vem logo
    // depois das atrasadas mesmo assim.
    L.aCobrar = await direta({ numero: 5, nome: 'Gabi', telefone: '11911110005', due: dia(4), itens: [{ preco: 40, sit: 'ficou' }] });
    L.concluida = await direta({ numero: 6, nome: 'Helo', telefone: '11911110006', due: dia(-1), status: 'encerrada', itens: [{ preco: 100, sit: 'ficou', venda }] });
    L.cancelada = await direta({ numero: 7, nome: 'Iara', telefone: '11911110007', due: dia(1), status: 'cancelada', itens: [{ preco: 999 }] });
  });

  const listar = (qs = '') => request(app).get(`/companies/${ID.lista}/condicionais${qs}`);
  const ids = (r) => r.body.condicionais.map((c) => c.id);

  test('padrao em_aberto: atrasadas, depois a cobrar, depois o prazo mais perto', async () => {
    const r = await listar();
    expect(r.status).toBe(200);
    expect(r.body.filtro).toBe('em_aberto');
    expect(ids(r)).toEqual([L.muitoAtrasada, L.atrasada, L.aCobrar, L.hoje, L.emDia]);
    const porId = Object.fromEntries(r.body.condicionais.map((c) => [c.id, c]));
    expect(porId[L.atrasada]).toMatchObject({ situacao: 'atrasada', parcial: true, dias_de_atraso: 3, numero_exibicao: 'C-0003', pecas: 2, pecas_com_cliente: 1, pecas_a_cobrar: 1, valor_com_cliente: 120, valor_a_cobrar: 30 });
    expect(porId[L.hoje].situacao).toBe('vence_hoje');
    expect(porId[L.emDia]).toMatchObject({ situacao: 'com_cliente', parcial: true, valor_com_cliente: 100, pecas_voltou: 1 });
    expect(porId[L.aCobrar]).toMatchObject({ situacao: 'a_cobrar', dias_de_atraso: 0 });
    expect(porId[L.muitoAtrasada].company_name).toBe('Lista');
  });

  test('totalizador das abertas e contagem dos chips', async () => {
    const r = await listar('?filtro=concluidas');
    // Ainda com a cliente: 100 + 80 + 120 + 10 = 310, em 4 pecas, com 3
    // clientes (Eva e Fabi sao o mesmo cadastro). A peca que "ficou" sem venda
    // (30 da Eva, 40 da Gabi) nao entra: vai em valor_a_cobrar.
    expect(r.body.totalizador).toEqual({ valor: 310, pecas: 4, clientes: 3, texto: 'R$ 310,00 em 4 peças com 3 clientes' });
    expect(r.body.valor_a_cobrar).toBe(70);
    expect(r.body.counts).toEqual({
      em_aberto: 5, com_cliente: 4, vence_hoje: 1, atrasadas: 2, a_cobrar: 1, concluidas: 1, canceladas: 1, todas: 7,
    });
    expect(ids(r)).toEqual([L.concluida]);
    expect(r.body.condicionais[0].situacao).toBe('concluida');
  });

  test('filtros e busca', async () => {
    expect(ids(await listar('?filtro=atrasadas'))).toEqual([L.muitoAtrasada, L.atrasada]);
    expect(ids(await listar('?filtro=vence_hoje'))).toEqual([L.hoje]);
    expect(ids(await listar('?filtro=a_cobrar'))).toEqual([L.aCobrar]);
    expect(ids(await listar('?filtro=com_cliente'))).toEqual([L.muitoAtrasada, L.atrasada, L.hoje, L.emDia]);
    expect(ids(await listar('?filtro=canceladas'))).toEqual([L.cancelada]);
    expect((await listar('?filtro=todas')).body.pagination.total).toBe(7);
    expect(ids(await listar('?filtro=todas&q=C-0003'))).toEqual([L.atrasada]);
    expect(ids(await listar('?filtro=todas&q=duda'))).toEqual([L.hoje]);
    expect(ids(await listar('?filtro=todas&q=lenco'))).toEqual([L.muitoAtrasada]);
    expect(ids(await listar('?filtro=todas&q=11110007'))).toEqual([L.cancelada]);
  });

  test('detalhe: valor_a_cobrar e o das pecas que ficaram sem venda', async () => {
    const d = await request(app).get(`/companies/${ID.lista}/condicionais/${L.atrasada}`);
    expect(d.body.condicional).toMatchObject({ situacao: 'atrasada', parcial: true });
    expect(d.body.condicional.resumo).toMatchObject({ com_cliente: 1, ficou: 1, a_cobrar: 1, valor_com_cliente: 120, valor_a_cobrar: 30 });
  });

  test('detalhe: preco de hoje ao lado do da retirada; de outra loja, 404', async () => {
    const r = await guardar(ID.loja, { customer_id: ID.cliente, items: [{ product_id: ID.blusa }] });
    await q(`UPDATE products SET promo_price = NULL, promo_starts_at = NULL, promo_ends_at = NULL WHERE id = $1`, [ID.blusa]);
    const d = await request(app).get(`/companies/${ID.loja}/condicionais/${r.body.condicional.id}`);
    expect(d.status).toBe(200);
    expect(d.body.condicional.items[0]).toMatchObject({ unit_price: 79.9, preco_hoje: 99.9, preco_mudou: true });
    expect((await request(app).get(`/companies/${ID.filial}/condicionais/${r.body.condicional.id}`)).status).toBe(404);
    expect((await request(app).get(`/companies/${ID.loja}/condicionais/nao-e-uuid`)).status).toBe(404);
  });
});

describe('lista enriquecida (C18)', () => {
  const C = {};
  const DONO2 = () => ({ id: ID.outroDono, role: 'client', is_staff: true });

  // `min` = minutos depois do inicio: controla a ordem de retirada.
  async function nova({ empresa = ID.c18a, numero, nome, due, status = 'aberta', itens }) {
    const id = uuid();
    await q(`INSERT INTO condicionais (id, company_id, numero, customer_name, customer_phone, due_date, status, closed_at)
             VALUES ($1, $2, $3, $4, '11922220000', $5::date, $6, CASE WHEN $6 = 'encerrada' THEN NOW() END)`,
    [id, empresa, numero, nome, due, status]);
    for (const it of itens) {
      await q(`INSERT INTO condicional_itens (condicional_id, product_id, product_name, color_name, size_label, unit_price, situacao, sale_id, added_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() - interval '1 day' + ($9 || ' minutes')::interval)`,
      [id, ID.muito, it.nome, it.cor || null, it.tam || null, it.preco, it.sit || 'com_cliente', it.venda || null, String(it.min || 0)]);
    }
    return id;
  }
  async function venda(empresa, condicionalId, total, minutosAtras, status = 'completed') {
    const id = uuid();
    await q(`INSERT INTO sales (id, company_id, total_amount, status, condicional_id, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW() - ($6 || ' minutes')::interval)`,
    [id, empresa, total, status, condicionalId, String(minutosAtras)]);
    const { rows } = await q(`SELECT sale_number FROM sales WHERE id = $1`, [id]);
    return { id, numero: Number(rows[0].sale_number) };
  }

  beforeAll(async () => {
    // Aberta parcial: peca com a cliente primeiro (por retirada), depois a que
    // ficou, depois a que voltou, mesmo tendo sido retirada antes.
    C.parcial = await nova({ numero: 1, nome: 'Ana', due: dia(-2), itens: [
      { nome: 'Blusa', preco: 50, sit: 'voltou', min: 1 },
      { nome: 'Saia', cor: 'Preta', tam: 'M', preco: 30, sit: 'ficou', min: 2 },
      { nome: 'Vestido', cor: 'Azul', tam: 'P', preco: 100, min: 3 },
      { nome: 'Cinto', preco: 20, min: 4 },
      { nome: 'Calca', preco: 70, sit: 'voltou_defeito', min: 0 },
    ] });
    C.hoje = await nova({ numero: 2, nome: 'Bia', due: dia(0), itens: [{ nome: 'Meia', preco: 80 }] });
    C.emDia = await nova({ numero: 3, nome: 'Cris', due: dia(5), itens: [
      { nome: 'Lenco', preco: 40, sit: 'ficou', min: 1 },
      { nome: 'Bolsa', preco: 60, min: 2 },
    ] });
    // Concluida: ordem so de retirada, sem agrupar por situacao.
    C.concluida = await nova({ numero: 4, nome: 'Duda', due: dia(-1), status: 'encerrada', itens: [
      { nome: 'Peca A', preco: 100, sit: 'ficou', min: 1 },
      { nome: 'Peca B', preco: 50, sit: 'ficou', min: 2 },
      { nome: 'Peca C', preco: 10, sit: 'voltou', min: 0 },
    ] });
    C.semVenda = await nova({ numero: 5, nome: 'Eva', due: dia(-1), status: 'encerrada', itens: [{ nome: 'Peca D', preco: 10, sit: 'voltou' }] });
    C.cancelada = await nova({ numero: 6, nome: 'Fabi', due: dia(1), status: 'cancelada', itens: [{ nome: 'Peca E', preco: 999 }] });
    await venda(ID.c18a, C.concluida, 100, 120);
    C.ultima = await venda(ID.c18a, C.concluida, 50, 60);
    await venda(ID.c18a, C.concluida, 999, 5, 'cancelled'); // a mais nova, mas cancelada
    // Loja B (consolidado): uma atrasada.
    C.deB = await nova({ empresa: ID.c18b, numero: 1, nome: 'Gabi', due: dia(-1), itens: [{ nome: 'Casaco', preco: 200 }] });
  });

  const listar = (qs = '') => request(app).get(`/companies/${ID.c18a}/condicionais${qs}`);
  const porId = (r) => Object.fromEntries(r.body.condicionais.map((c) => [c.id, c]));

  test('aberta parcial: resumo, primeiras pecas (com a cliente, ficou, voltou) e outras_pecas', async () => {
    usuario = DONO2();
    const r = await listar('?filtro=todas&limit=50');
    expect(r.status).toBe(200);
    const c = porId(r)[C.parcial];
    expect(c.resumo).toEqual({ com_cliente: 2, voltaram: 2, ficaram: 1, a_cobrar: 1, valor_com_cliente: 120, valor_a_cobrar: 30 });
    expect(c.primeiras_pecas).toEqual([
      { nome: 'Vestido', cor: 'Azul', tamanho: 'P' },
      { nome: 'Cinto', cor: null, tamanho: null },
    ]);
    expect(c.outras_pecas).toBe(3);
    // Campos antigos continuam.
    expect(c).toMatchObject({ pecas: 5, pecas_com_cliente: 2, pecas_a_cobrar: 1, valor_com_cliente: 120, primeira_peca: 'Calca' });
    expect(c.venda).toBeNull();
    expect(porId(r)[C.hoje].primeiras_pecas).toEqual([{ nome: 'Meia', cor: null, tamanho: null }]);
    expect(porId(r)[C.hoje].outras_pecas).toBe(0);
  });

  test('a peca com a cliente vem antes da que ficou, mesmo retirada depois', async () => {
    usuario = DONO2();
    const c = porId(await listar('?filtro=todas&limit=50'))[C.emDia];
    expect(c.primeiras_pecas.map((p) => p.nome)).toEqual(['Bolsa', 'Lenco']);
  });

  test('concluida: so ordem de retirada; venda somada (sem cancelada) com o numero da ultima', async () => {
    usuario = DONO2();
    const r = await listar('?filtro=concluidas');
    const c = porId(r)[C.concluida];
    expect(c.primeiras_pecas.map((p) => p.nome)).toEqual(['Peca C', 'Peca A']);
    expect(c.outras_pecas).toBe(1);
    expect(c.venda).toEqual({ numero: C.ultima.numero, valor: 150 });
    expect(porId(r)[C.semVenda].venda).toBeNull();
  });

  test('cancelada: ordem de retirada e sem venda', async () => {
    usuario = DONO2();
    const c = porId(await listar('?filtro=canceladas'))[C.cancelada];
    expect(c.primeiras_pecas.map((p) => p.nome)).toEqual(['Peca E']);
    expect(c.venda).toBeNull();
  });

  test('totais do topo: todas as abertas, independem de pagina e de filtro', async () => {
    usuario = DONO2();
    const esperado = {
      vence_hoje: { valor: 80, pecas: 1 },
      atrasadas: { valor: 120, pecas: 2 },
      a_cobrar: { valor: 70, pecas: 2 },
    };
    expect((await listar()).body.totais).toEqual(esperado);
    const pag = await listar('?limit=1&page=2');
    expect(pag.body.condicionais).toHaveLength(1);
    expect(pag.body.totais).toEqual(esperado);
    expect((await listar('?filtro=concluidas&limit=1')).body.totais).toEqual(esperado);
    expect((await listar('?filtro=canceladas')).body.totais).toEqual(esperado);
  });

  test('consolidado: totais somam as lojas; ?company_id= restringe', async () => {
    usuario = DONO2();
    const r = await request(app).get('/me/condicionais?filtro=concluidas&limit=1');
    expect(r.status).toBe(200);
    expect(r.body.totais).toEqual({
      vence_hoje: { valor: 80, pecas: 1 },
      atrasadas: { valor: 320, pecas: 3 },
      a_cobrar: { valor: 70, pecas: 2 },
    });
    const a = await request(app).get(`/me/condicionais?company_id=${ID.c18a}&limit=1`);
    expect(a.body.totais.atrasadas).toEqual({ valor: 120, pecas: 2 });
    const b = await request(app).get(`/me/condicionais?filtro=todas&company_id=${ID.c18b}`);
    expect(b.body.totais).toEqual({ vence_hoje: { valor: 0, pecas: 0 }, atrasadas: { valor: 200, pecas: 1 }, a_cobrar: { valor: 0, pecas: 0 } });
    const linhaB = b.body.condicionais.find((c) => c.id === C.deB);
    expect(linhaB.resumo).toMatchObject({ com_cliente: 1, valor_com_cliente: 200 });
    expect(linhaB.primeiras_pecas).toEqual([{ nome: 'Casaco', cor: null, tamanho: null }]);
  });
});

describe('GET /me/condicionais (R14)', () => {
  test('dono: as lojas dele, com a loja em cada linha; de outro dono nunca', async () => {
    const r = await request(app).get('/me/condicionais?filtro=todas&limit=100');
    expect(r.status).toBe(200);
    expect(r.body.company_count).toBe(5);
    const lojas = new Set(r.body.condicionais.map((c) => c.company_id));
    expect(lojas.has(ID.loja)).toBe(true);
    expect(lojas.has(ID.lista)).toBe(true);
    expect(lojas.has(ID.deFora)).toBe(false);
    expect(r.body.condicionais.every((c) => c.company_name)).toBe(true);
    const lista = r.body.por_empresa.find((e) => e.company_id === ID.lista);
    expect(lista).toMatchObject({ company_name: 'Lista', counts: expect.objectContaining({ todas: 7 }) });
  });

  test('?company_id= filtra; de loja de fora, 403', async () => {
    const r = await request(app).get(`/me/condicionais?company_id=${ID.lista}&filtro=atrasadas`);
    expect(r.body.condicionais.map((c) => c.company_id)).toEqual([ID.lista, ID.lista]);
    expect(r.body.filtered_company_id).toBe(ID.lista);
    expect((await request(app).get(`/me/condicionais?company_id=${ID.deFora}`)).status).toBe(403);
  });

  test('membro: so as lojas em que ve Vendas', async () => {
    usuario = { id: ID.membro, role: 'client', is_staff: true };
    const r = await request(app).get('/me/condicionais?filtro=todas');
    expect(r.body.company_count).toBe(1);
    expect(r.body.por_empresa.map((e) => e.company_id)).toEqual([ID.lista]);
    expect(r.body.condicionais.every((c) => c.company_id === ID.lista)).toBe(true);
  });
});

describe('trava CONDICIONAL_LIBERADA', () => {
  test('desligada: o lojista nao ve as rotas; ligada, ve', async () => {
    usuario = { id: ID.dono, role: 'client' };
    expect((await request(app).get(`/companies/${ID.lista}/condicionais`)).status).toBe(404);
    expect((await request(app).get('/me/condicionais')).status).toBe(404);
    expect((await guardar(ID.paralela, { customer_id: ID.cliente, items: [{ product_id: ID.muito }] })).status).toBe(404);
    process.env.CONDICIONAL_LIBERADA = 'true';
    expect((await request(app).get(`/companies/${ID.lista}/condicionais`)).status).toBe(200);
  });
});
