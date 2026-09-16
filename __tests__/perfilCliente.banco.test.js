// ============================================================
// AURA CLIENTES — Fase 1 contra o Postgres real (migration 341)
//
// O que este arquivo cobre (o CI aplica todas as migrations antes):
//   1. paridade: public.aura_phone_e164_br == src/utils/phone.js em todos os
//      casos do helper, e md5('<tipo>:<id>')::uuid == derivedKey
//   2. colunas novas com os defaults certos, trigger do phone_e164 e
//      CHECKs de preferences / important_dates / merged_into_id
//   3. rodar a 341 de novo é inofensivo e o backfill preenche o que falta
//   4. o SQL da linha do tempo e do resumo roda no schema de verdade, e a
//      paginação por cursor percorre todos os eventos sem repetir nem pular
//   5. duplicados, tags e mesclagem de ponta a ponta (com o conflito de
//      unicidade do aniversário ficando na origem)
//
// Mesmo padrão de codigoDeAcessoManual.banco.test.js: uma transação só,
// revertida no afterAll, e o db mockado redirecionado para ela. Cada query
// roda num SAVEPOINT próprio (em série): o erro 42703/42P01 que o código
// trata de propósito não pode abortar a transação do arquivo.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');

const { companyRouter } = require('../src/routes/customerProfile');
const { toPhoneE164BR } = require('../src/utils/phone');
const timeline = require('../src/services/customerTimeline');
const saleNumber = require('../src/utils/saleNumber');
const TELEFONES = require('./helpers/telefonesPerfilCliente');

const CONN =
  process.env.SUPABASE_DB_URL ||
  'postgresql://aura_test:aura_test@localhost:5432/aura_test';

const MIGRATION_341 = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '341_perfil_do_cliente.sql'),
  'utf8'
);

let pool;
let client;
let db;

const userId = uuid();
const companyA = uuid();
const companyB = uuid();
const productId = uuid();
const variantId = uuid();

const app = express();
app.use(express.json());
app.use('/companies/:id/customers', (req, res, next) => { req.user = { id: userId, plan: 'essencial' }; next(); }, companyRouter);

// Fila: uma query (com seu savepoint) por vez na conexão da transação.
let fila = Promise.resolve();
let spSeq = 0;
function naFila(fn) {
  const p = fila.then(fn, fn);
  fila = p.catch(() => {});
  return p;
}
function consulta(sql, params) {
  return naFila(async () => {
    const sp = `q${++spSeq}`;
    await client.query(`SAVEPOINT ${sp}`);
    try {
      const r = await client.query(sql, params);
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      return r;
    } catch (e) {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      throw e;
    }
  });
}

// Conexão "de transação" para a mesclagem: BEGIN/COMMIT/ROLLBACK viram
// savepoint dentro da transação do arquivo.
function conexaoDeTransacao() {
  const nome = `merge_tx_${++spSeq}`;
  return {
    release: () => {},
    query: (sql, params) => {
      const s = String(sql).trim().toUpperCase();
      if (s === 'BEGIN') return client.query(`SAVEPOINT ${nome}`);
      if (s === 'COMMIT') return client.query(`RELEASE SAVEPOINT ${nome}`);
      if (s === 'ROLLBACK') return client.query(`ROLLBACK TO SAVEPOINT ${nome}`);
      return client.query(sql, params);
    },
  };
}

async function sql(text, params) {
  return (await client.query(text, params)).rows;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: CONN.replace('?family=4', '') });
  client = await pool.connect();
  await client.query('BEGIN');
  db = require('../src/config/database');

  await sql(
    `INSERT INTO users (id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Dona Fixture')`,
    [userId, `perfil-${userId}@example.test`]
  );
  await sql(
    `INSERT INTO companies (id, owner_id, legal_name, trade_name, plan)
     VALUES ($1, $3, 'Fixture A LTDA', 'Loja A', 'essencial'),
            ($2, $3, 'Fixture B LTDA', NULL, 'negocio')`,
    [companyA, companyB, userId]
  );
  await sql(`INSERT INTO products (id, company_id, name, price) VALUES ($1, $2, 'Vestido Midi', 200)`, [productId, companyA]);
  await sql(`INSERT INTO product_variants (id, product_id, sku_suffix) VALUES ($1, $2, 'AZ-M')`, [variantId, productId]);
  await sql(
    `INSERT INTO product_variant_values (variant_id, attribute_name, value)
     VALUES ($1, 'Cor', 'Azul'), ($1, 'Tamanho', 'M')`,
    [variantId]
  );
});

beforeEach(() => {
  db.query.mockImplementation((text, params) => consulta(text, params));
  db.connect.mockImplementation(async () => conexaoDeTransacao());
  timeline._resetCaches();
  saleNumber._resetCache();
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  if (pool) await pool.end();
});

async function novoCliente(companyId, over = {}) {
  const id = uuid();
  const c = { name: 'Cliente Fixture', phone: null, cpf_cnpj: null, ...over };
  await sql(
    `INSERT INTO customers (id, company_id, name, phone, cpf_cnpj) VALUES ($1, $2, $3, $4, $5)`,
    [id, companyId, c.name, c.phone, c.cpf_cnpj]
  );
  return id;
}

// ── 1. paridade ─────────────────────────────────────────────
describe('paridade JS x SQL', () => {
  it('aura_phone_e164_br concorda com toPhoneE164BR em todos os casos', async () => {
    for (const [entrada] of TELEFONES) {
      const [{ v }] = await sql('SELECT public.aura_phone_e164_br($1) AS v', [entrada]);
      expect({ entrada, v }).toEqual({ entrada, v: toPhoneE164BR(entrada) });
    }
  });

  it('chave derivada da linha do tempo bate com o md5 do banco', async () => {
    const id = uuid();
    const [{ k }] = await sql(`SELECT md5('cancelamento:' || $1::text)::uuid::text AS k`, [id]);
    expect(k).toBe(timeline.derivedKey('cancelamento', id));
  });
});

// ── 2. schema ───────────────────────────────────────────────
describe('colunas e trigger da 341', () => {
  it('defaults e phone_e164 mantido pelo trigger no INSERT e no UPDATE de phone', async () => {
    const id = await novoCliente(companyA, { phone: '(11) 8765-4321' });
    let [c] = await sql('SELECT tags, preferences, important_dates, phone_e164, merged_into_id FROM customers WHERE id = $1', [id]);
    expect(c).toEqual({ tags: [], preferences: {}, important_dates: [], phone_e164: '5511987654321', merged_into_id: null });

    await sql(`UPDATE customers SET phone = '21 3456-7890' WHERE id = $1`, [id]);
    [c] = await sql('SELECT phone_e164 FROM customers WHERE id = $1', [id]);
    expect(c.phone_e164).toBe('552134567890');

    await sql(`UPDATE customers SET phone = 'sem telefone' WHERE id = $1`, [id]);
    [c] = await sql('SELECT phone_e164 FROM customers WHERE id = $1', [id]);
    expect(c.phone_e164).toBeNull();
  });

  it('CHECKs recusam preferences não-objeto, datas não-array e mesclar em si mesmo', async () => {
    const id = await novoCliente(companyA);
    const erro = async (text, params) => {
      try {
        await consulta(text, params);
        return null;
      } catch (e) {
        return e.code;
      }
    };
    expect(await erro(`UPDATE customers SET preferences = '[]'::jsonb WHERE id = $1`, [id])).toBe('23514');
    expect(await erro(`UPDATE customers SET important_dates = '{}'::jsonb WHERE id = $1`, [id])).toBe('23514');
    expect(await erro(`UPDATE customers SET merged_into_id = id WHERE id = $1`, [id])).toBe('23514');
  });

  it('rodar a 341 de novo é inofensivo e o backfill preenche quem ficou sem', async () => {
    const id = await novoCliente(companyA, { phone: '11 98765-0000' });
    // UPDATE sem tocar em phone não dispara o trigger: simula linha antiga
    await sql('UPDATE customers SET phone_e164 = NULL WHERE id = $1', [id]);
    await client.query(MIGRATION_341);
    await client.query(MIGRATION_341);
    const [c] = await sql('SELECT phone_e164 FROM customers WHERE id = $1', [id]);
    expect(c.phone_e164).toBe('5511987650000');
    const [{ n }] = await sql(
      `SELECT COUNT(*)::int AS n FROM pg_trigger WHERE tgname = 'trg_customers_phone_e164' AND NOT tgisinternal`
    );
    expect(n).toBe(1);
  });
});

// ── 3/4. linha do tempo e resumo ────────────────────────────
describe('linha do tempo no schema real', () => {
  let cid;
  const ts = (d) => `2026-0${d}`;

  beforeAll(async () => {
    cid = await novoCliente(companyA, { name: 'Marina Costa', phone: '11 97777-6666' });
    const s1 = uuid();
    const s2 = uuid();
    const s3 = uuid();
    const s4 = uuid();
    await sql(
      `INSERT INTO sales (id, company_id, customer_id, total_amount, discount_amount, payment_method, seller_name, created_at)
       VALUES ($1, $3, $4, 200, 0, 'pix', 'Bia', '${ts(1)}-10T12:00:00Z'),
              ($2, $3, $4, 150, 15, 'cartao_credito', NULL, '${ts(2)}-10T12:00:00Z')`,
      [s1, s2, companyA, cid]
    );
    await sql(
      `INSERT INTO sales (id, company_id, customer_id, total_amount, type, exchange_of_sale_id, created_at)
       VALUES ($1, $2, $3, 220, 'troca', $4, '${ts(3)}-10T12:00:00Z')`,
      [s3, companyA, cid, s1]
    );
    await sql(
      `INSERT INTO sales (id, company_id, customer_id, total_amount, coupon_code, discount_amount, created_at)
       VALUES ($1, $2, $3, 90, 'VOLTA10', 10, '${ts(4)}-10T12:00:00Z')`,
      [s4, companyA, cid]
    );
    await sql(`UPDATE sales SET status = 'cancelled', cancelled_at = '${ts(5)}-01T12:00:00Z' WHERE id = $1`, [s2]);
    await sql(
      `INSERT INTO sale_items (sale_id, product_id, variant_id, quantity, unit_price, total_price)
       VALUES ($1, $2, $3, 1, 200, 200), ($4, $2, NULL, 1, 220, 220)`,
      [s1, productId, variantId, s3]
    );
    await sql(
      `INSERT INTO troca_returned_items (troca_sale_id, original_sale_id, product_id, variant_id, quantity, unit_price)
       VALUES ($1, $2, $3, $4, 1, 200)`,
      [s3, s1, productId, variantId]
    );
    await sql(
      `INSERT INTO coupons (company_id, code, discount_type, discount_value, customer_id, source, created_at)
       VALUES ($1, 'VOLTA10', 'percent', 10, $2, 'reactivation', '${ts(3)}-20T12:00:00Z')`,
      [companyA, cid]
    );
    await sql(
      `INSERT INTO purchase_reviews (company_id, sale_id, customer_id, rating, comment, responded_at)
       VALUES ($1, $2, $3, 5, 'Amei', '${ts(1)}-15T12:00:00Z')`,
      [companyA, s1, cid]
    );
    await sql(
      `INSERT INTO customer_notes (company_id, customer_id, author_id, body, created_at)
       VALUES ($1, $2, $3, 'Veste M', '${ts(1)}-10T12:00:00Z')`, // mesmo instante da compra 1
      [companyA, cid, userId]
    );
    // eventos da Loja B (Negócio) — não aparecem na timeline da Loja A
    await sql(
      `INSERT INTO customer_credit_transactions (company_id, customer_id, type, amount, payment_method)
       VALUES ($1, $2, 'payment', 50, 'pix')`,
      [companyB, cid]
    );
  });

  async function todasAsPaginas(companyId, limit, extra = '') {
    const eventos = [];
    let cursor = null;
    for (let i = 0; i < 20; i++) {
      const q = `limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${extra}`;
      const res = await request(app).get(`/companies/${companyId}/customers/${cid}/timeline?${q}`);
      expect(res.status).toBe(200);
      eventos.push(...res.body.events);
      cursor = res.body.next_cursor;
      if (!cursor) return { eventos, ultima: res.body };
    }
    throw new Error('paginação não terminou');
  }

  it('monta os eventos da Loja A em ordem e pagina sem repetir nem pular', async () => {
    const inteira = await todasAsPaginas(companyA, 100);
    // Mesmo instante (compra + cupom usado; compra + nota) desempata pela
    // chave derivada: aqui só se confere o conjunto de cada instante.
    const porInstante = {};
    for (const e of inteira.eventos) {
      const rotulo = `${e.type}${e.meta.action ? ':' + e.meta.action : ''}`;
      (porInstante[e.at.slice(0, 10)] = porInstante[e.at.slice(0, 10)] || []).push(rotulo);
    }
    for (const k of Object.keys(porInstante)) porInstante[k].sort();
    expect(porInstante).toEqual({
      '2026-05-01': ['cancelamento'],
      '2026-04-10': ['compra', 'cupom:usado'],
      '2026-03-20': ['cupom:gerado'],
      '2026-03-10': ['troca'],
      '2026-02-10': ['compra'],
      '2026-01-15': ['avaliacao'],
      '2026-01-10': ['compra', 'nota'],
    });
    expect(inteira.eventos).toHaveLength(9);
    const cancelada = inteira.eventos.find(e => e.type === 'compra' && e.amount === 150);
    expect(cancelada.meta.status).toBe('cancelled');
    const usado = inteira.eventos.find(e => e.meta.action === 'usado');
    expect(usado).toMatchObject({ title: 'Cupom VOLTA10 usado', amount: 10 });
    const compra1 = inteira.eventos.find(e => e.type === 'compra' && e.amount === 200);
    expect(compra1.meta.items).toEqual([expect.objectContaining({ product_name: 'Vestido Midi', variant: 'Azul / M' })]);
    expect(compra1.meta.sale_number).toEqual(expect.any(Number));
    expect(compra1.meta.seller_name).toBe('Bia');
    expect(compra1.company_name).toBe('Loja A');
    const troca = inteira.eventos.find(e => e.type === 'troca');
    expect(troca.amount).toBeNull();
    expect(troca.meta.returned_items).toEqual([expect.objectContaining({ variant: 'Azul / M', quantity: 1 })]);
    const cancel = inteira.eventos.find(e => e.type === 'cancelamento');
    expect(cancel.at).toBe('2026-05-01T12:00:00.000Z');
    expect(inteira.ultima.locked_types).toEqual(['crediario', 'mensagem']);
    // ordem decrescente
    const ats = inteira.eventos.map(e => e.at);
    expect([...ats].sort().reverse()).toEqual(ats);

    for (const limit of [1, 2, 4]) {
      const paginada = await todasAsPaginas(companyA, limit);
      expect(paginada.eventos.map(e => e.id)).toEqual(inteira.eventos.map(e => e.id));
    }
  });

  it('Loja B é Negócio: crediário aparece com o nome legal quando não há fantasia', async () => {
    const { eventos, ultima } = await todasAsPaginas(companyB, 10);
    expect(ultima.locked_types).toEqual([]);
    expect(eventos).toEqual([
      expect.objectContaining({ type: 'crediario', amount: -50, company_name: 'Fixture B LTDA' }),
    ]);
  });

  it('resumo: receita sem troca e sem cancelada', async () => {
    const res = await request(app).get(`/companies/${companyA}/customers/${cid}/summary`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      purchases_count: 2,
      total_spent: 290,
      avg_ticket: 145,
      exchanges_count: 1,
      first_purchase_at: '2026-01-10T12:00:00.000Z',
      last_purchase_at: '2026-04-10T12:00:00.000Z',
      avg_days_between_purchases: 90,
      credit_balance: null,
      credit_locked: true,
      rating_avg: 5,
      ratings_count: 1,
    });
    expect(res.body.days_since_last_purchase).toEqual(expect.any(Number));

    const resB = await request(app).get(`/companies/${companyB}/customers/${cid}/summary`);
    expect(resB.body).toMatchObject({ purchases_count: 0, credit_balance: -50, credit_locked: false });
  });
});

// ── 5. duplicados, tags e mesclagem ─────────────────────────
describe('duplicados e mesclagem no schema real', () => {
  let alvo;
  let origem;

  beforeAll(async () => {
    alvo = await novoCliente(companyA, { name: 'Joana Prado', phone: '(31) 99888-7777' });
    origem = await novoCliente(companyA, { name: 'Joana P.', phone: '31 9888-7777', cpf_cnpj: '529.982.247-25' });
    await sql(`UPDATE customers SET tags = '{VIP}', marketing_opt_out = false WHERE id = $1`, [alvo]);
    await sql(`UPDATE customers SET tags = '{vip,Noiva}', marketing_opt_out = true, email = 'joana@x.test' WHERE id = $1`, [origem]);
    await sql(`INSERT INTO sales (company_id, customer_id, total_amount) VALUES ($1, $2, 80)`, [companyA, origem]);
    await sql(`INSERT INTO customer_notes (company_id, customer_id, body) VALUES ($1, $2, 'nota da origem')`, [companyA, origem]);
    await sql(
      `INSERT INTO customer_credit_transactions (company_id, customer_id, type, amount) VALUES ($1, $2, 'debit', 30)`,
      [companyA, origem]
    );
    // um aniversário por ano: o da origem não cabe no alvo
    await sql(
      `INSERT INTO birthday_messages_sent (company_id, customer_id, birthday_year) VALUES ($1, $2, 2026), ($1, $3, 2026)`,
      [companyA, alvo, origem]
    );
  });

  it('duplicados acha o par pelo telefone (com e sem o nono dígito)', async () => {
    const res = await request(app).get(`/companies/${companyA}/customers/duplicates`);
    expect(res.status).toBe(200);
    const grupo = res.body.groups.find(g => g.customers.some(c => c.id === alvo));
    expect(grupo).toMatchObject({ strength: 'forte', reasons: ['phone'] });
    expect(grupo.customers.map(c => c.id).sort()).toEqual([alvo, origem].sort());
  });

  it('tags lista a base do dono', async () => {
    const res = await request(app).get(`/companies/${companyB}/customers/tags`);
    expect(res.status).toBe(200);
    // 'VIP' e 'vip' são a mesma tag na contagem
    const vip = res.body.tags.filter(t => t.tag.toLowerCase() === 'vip');
    expect(vip).toEqual([{ tag: expect.stringMatching(/^vip$/i), count: 2 }]);
    expect(res.body.tags).toEqual(expect.arrayContaining([{ tag: 'Noiva', count: 1 }]));
  });

  it('preview e mesclagem de ponta a ponta', async () => {
    const prev = await request(app).post(`/companies/${companyA}/customers/${alvo}/merge/preview`).send({ source_id: origem });
    expect(prev.status).toBe(200);
    expect(prev.body.moves).toEqual(expect.arrayContaining([
      { table: 'sales', label: 'vendas', rows: 1 },
      { table: 'customer_credit_transactions', label: 'lancamentos do crediario', rows: 1 },
    ]));
    // customer_consent_events chega com a migration 340 (PR #713)
    const [{ consent }] = await sql(`SELECT to_regclass('public.customer_consent_events') IS NOT NULL AS consent`);
    if (consent) expect(prev.body.skipped_tables).not.toContain('customer_consent_events');
    else expect(prev.body.skipped_tables).toContain('customer_consent_events');

    const res = await request(app).post(`/companies/${companyA}/customers/${alvo}/merge`)
      .send({ source_id: origem, fields: { name: 'target' } });
    expect(res.status).toBe(200);
    expect(res.body.kept).toEqual([
      { table: 'birthday_messages_sent', label: 'mensagens de aniversario', rows: 1, reason: 'conflito_de_unicidade' },
    ]);
    expect(res.body.target).toMatchObject({
      name: 'Joana Prado', email: 'joana@x.test', cpf_cnpj: '529.982.247-25',
      tags: ['VIP', 'Noiva'], marketing_opt_out: true, total_purchases: 1, is_active: true,
    });

    const [src] = await sql('SELECT merged_into_id, is_active FROM customers WHERE id = $1', [origem]);
    expect(src).toEqual({ merged_into_id: alvo, is_active: false });
    const [{ n: vendas }] = await sql('SELECT COUNT(*)::int AS n FROM sales WHERE customer_id = $1', [alvo]);
    expect(vendas).toBe(1);
    const [{ n: cred }] = await sql('SELECT COUNT(*)::int AS n FROM customer_credit_transactions WHERE customer_id = $1', [alvo]);
    expect(cred).toBe(1);
    const [{ n: bday }] = await sql('SELECT COUNT(*)::int AS n FROM birthday_messages_sent WHERE customer_id = $1', [origem]);
    expect(bday).toBe(1);
    const notas = await sql('SELECT kind, body FROM customer_notes WHERE customer_id = $1 ORDER BY created_at, kind', [alvo]);
    expect(notas.map(x => x.kind).sort()).toEqual(['manual', 'merge']);

    // depois da mesclagem o par some dos duplicados e a origem não mescla de novo
    const dupl = await request(app).get(`/companies/${companyA}/customers/duplicates`);
    expect(dupl.body.groups.some(g => g.customers.some(c => c.id === origem))).toBe(false);
    const again = await request(app).post(`/companies/${companyA}/customers/${alvo}/merge`).send({ source_id: origem });
    expect(again.status).toBe(409);

    // a nota automática aparece na linha do tempo e não se apaga
    const tl = await request(app).get(`/companies/${companyA}/customers/${alvo}/timeline?types=nota`);
    const auto = tl.body.events.find(e => e.meta.kind === 'merge');
    expect(auto.title).toBe('Cadastros mesclados');
    const del = await request(app).delete(`/companies/${companyA}/customers/${alvo}/notes/${auto.meta.note_id}`);
    expect(del.status).toBe(409);
  });
});
