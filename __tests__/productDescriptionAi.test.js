// ============================================================
// AURA. — Geração de descrição por IA (F0 → F1, migration 287)
//
// O que estes testes provam:
//   1. Produtos são EMPACOTADOS (20 por request) — a decisão de custo que
//      sustenta o orçamento da fase. Um produto por request custaria ~7x.
//   2. Id que o modelo devolve mas não foi pedido é DESCARTADO (alucinação).
//   3. Um lote que quebra não derruba os outros — trabalho em massa.
//   4. Resposta truncada (max_tokens) vira erro nomeado, não crash de JSON.
//   5. approve é o ÚNICO caminho que escreve em products.description;
//      reject não toca no produto.
//
// O cliente Claude é INJETADO (opts.call) — nenhum teste toca a rede.
// db.query vem do mock GLOBAL (tests/jest.setup.js).
// ============================================================
'use strict';

const express = require('express');
const request = require('supertest');

const { generateDescriptions, PACK_SIZE } = require('../src/services/productDescriptionAi');

const CID = 'company-davi-1';

function produtos(n, prefix = 'p') {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    name: `Bota Cano Curto ${i}`,
    brand: 'Ramarim',
    category: 'Feminino',
  }));
}

// Cliente Claude falso: devolve uma descrição por produto recebido.
function fakeCall(overrides = {}) {
  const calls = [];
  const fn = async ({ messages }) => {
    const enviados = JSON.parse(String(messages[0].content).replace(/^Produtos:\n/, ''));
    calls.push(enviados);
    if (overrides.impl) return overrides.impl(enviados, calls.length);
    return {
      text: JSON.stringify(enviados.map(p => ({ id: p.id, description: `Descricao de ${p.nome}.` }))),
      inputTokens: 100, outputTokens: 200, stopReason: 'end_turn', model: 'claude-sonnet-5',
    };
  };
  fn.calls = calls;
  return fn;
}

describe('serviço de geração de descrição', () => {
  test('empacota 20 produtos por request — 45 produtos viram 3 chamadas', async () => {
    const call = fakeCall();
    const { results, errors } = await generateDescriptions(produtos(45), { call });

    expect(PACK_SIZE).toBe(20);
    expect(call.calls).toHaveLength(3);
    expect(call.calls[0]).toHaveLength(20);
    expect(call.calls[1]).toHaveLength(20);
    expect(call.calls[2]).toHaveLength(5);
    expect(results).toHaveLength(45);
    expect(errors).toHaveLength(0);
  });

  test('não envia preço nem estoque para o modelo', async () => {
    const call = fakeCall();
    await generateDescriptions(
      [{ id: 'p-1', name: 'Bota', price: 199.9, stock_qty: 12, cost_price: 80 }],
      { call }
    );
    const enviado = call.calls[0][0];
    expect(enviado).toHaveProperty('nome');
    expect(enviado).not.toHaveProperty('price');
    expect(enviado).not.toHaveProperty('stock_qty');
    expect(enviado).not.toHaveProperty('cost_price');
  });

  test('id que não foi pedido é descartado', async () => {
    const call = fakeCall({
      impl: (enviados) => ({
        text: JSON.stringify([
          { id: enviados[0].id, description: 'Texto legitimo.' },
          { id: 'produto-que-nao-existe', description: 'Alucinacao.' },
        ]),
        inputTokens: 10, outputTokens: 20, stopReason: 'end_turn', model: 'claude-sonnet-5',
      }),
    });

    const { results } = await generateDescriptions(produtos(2), { call });
    expect(results).toHaveLength(1);
    expect(results[0].product_id).toBe('p-0');
    expect(results.map(r => r.product_id)).not.toContain('produto-que-nao-existe');
  });

  test('lote que quebra não derruba os outros', async () => {
    const call = fakeCall({
      impl: (enviados, nth) => {
        if (nth === 2) throw new Error('timeout da API');
        return {
          text: JSON.stringify(enviados.map(p => ({ id: p.id, description: 'ok.' }))),
          inputTokens: 10, outputTokens: 20, stopReason: 'end_turn', model: 'claude-sonnet-5',
        };
      },
    });

    const { results, errors } = await generateDescriptions(produtos(45), { call });
    expect(results).toHaveLength(25);            // lotes 1 e 3
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toMatch(/timeout/);
    expect(errors[0].product_ids).toHaveLength(20);
  });

  test('resposta truncada vira erro nomeado, não crash de JSON', async () => {
    const call = fakeCall({
      impl: () => ({
        text: '[{"id":"p-0","description":"comeco do texto que fo',
        inputTokens: 10, outputTokens: 8000, stopReason: 'max_tokens', model: 'claude-sonnet-5',
      }),
    });

    const { results, errors } = await generateDescriptions(produtos(3), { call });
    expect(results).toHaveLength(0);
    expect(errors[0].error).toMatch(/truncada/);
  });

  test('descrição vazia é resposta válida e não vira rascunho', async () => {
    const call = fakeCall({
      impl: (enviados) => ({
        text: JSON.stringify([
          { id: enviados[0].id, description: '' },
          { id: enviados[1].id, description: 'Texto bom.' },
        ]),
        inputTokens: 10, outputTokens: 20, stopReason: 'end_turn', model: 'claude-sonnet-5',
      }),
    });

    const { results } = await generateDescriptions(produtos(2), { call });
    expect(results).toHaveLength(1);
    expect(results[0].product_id).toBe('p-1');
  });
});

describe('rotas de revisão — só o approve publica', () => {
  let app, db;

  beforeEach(() => {
    jest.resetModules();
    db = require('../src/config/database');
    db.query.mockReset();
    app = express();
    app.use(express.json());
    // Em private.js o router está atrás de requireAuth/requireCompanyAccess, que
    // populam req.user. Sem isso o requirePlan da geração/aprovação responde 401
    // antes de qualquer lógica — o stub abaixo reproduz o estado real.
    app.use((req, _res, next) => { req.user = { id: 'user-1', plan: 'negocio' }; next(); });
    app.use('/companies/:id/products', require('../src/routes/productDescriptions'));
  });

  function isSelectDraft(sql) { return /SELECT[\s\S]*FROM product_description_drafts/i.test(sql); }
  function isUpdateProduct(sql) { return /UPDATE products SET description/i.test(sql); }

  test('approve escreve em products.description dentro de transação', async () => {
    const seen = [];
    const clientQuery = jest.fn(async (sql) => {
      seen.push(String(sql));
      if (isSelectDraft(sql)) return { rows: [{ id: 'd-1', product_id: 'p-1', draft: 'Texto revisado.' }] };
      return { rows: [], rowCount: 1 };
    });
    db.connect.mockReturnValue({ query: clientQuery, release: jest.fn() });

    const res = await request(app).post(`/companies/${CID}/products/descriptions/drafts/d-1/approve`);

    expect(res.status).toBe(200);
    expect(res.body.product_id).toBe('p-1');
    expect(seen.some(s => /^BEGIN/.test(s))).toBe(true);
    expect(seen.some(s => /^COMMIT/.test(s))).toBe(true);
    expect(seen.some(isUpdateProduct)).toBe(true);
    // Trava de concorrência: dois cliques não podem publicar duas vezes.
    expect(seen.find(isSelectDraft)).toMatch(/FOR UPDATE/);
  });

  test('approve de rascunho já revisado é 404 e não escreve no produto', async () => {
    const seen = [];
    const clientQuery = jest.fn(async (sql) => {
      seen.push(String(sql));
      if (isSelectDraft(sql)) return { rows: [] };   // já aprovado/rejeitado
      return { rows: [], rowCount: 0 };
    });
    db.connect.mockReturnValue({ query: clientQuery, release: jest.fn() });

    const res = await request(app).post(`/companies/${CID}/products/descriptions/drafts/d-1/approve`);

    expect(res.status).toBe(404);
    expect(seen.some(isUpdateProduct)).toBe(false);
    expect(seen.some(s => /^ROLLBACK/.test(s))).toBe(true);
  });

  test('reject não toca em products', async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 1 });

    const res = await request(app).post(`/companies/${CID}/products/descriptions/drafts/d-1/reject`);

    expect(res.status).toBe(200);
    expect(res.body.rejected).toBe(true);
    const sqls = db.query.mock.calls.map(c => String(c[0]));
    expect(sqls.some(isUpdateProduct)).toBe(false);
    expect(sqls.some(s => /UPDATE product_description_drafts/i.test(s))).toBe(true);
  });

  test('coverage devolve o buraco do catálogo e sobrevive sem a migration 287', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/FROM product_description_drafts/i.test(sql)) {
        const e = new Error('relation does not exist'); e.code = '42P01'; throw e;
      }
      return { rows: [{ total: 1434, com_descricao: 0, com_foto: 147 }] };
    });

    const res = await request(app).get(`/companies/${CID}/products/descriptions/coverage`);

    expect(res.status).toBe(200);
    expect(res.body.sem_descricao).toBe(1434);
    expect(res.body.pct_descricao).toBe(0);
    expect(res.body.pct_foto).toBe(10.3);          // o número real da Davi
    expect(res.body.rascunhos_pendentes).toBe(0);
  });

  test('sem a migration 287, listar rascunhos é 503 nomeado (não 500)', async () => {
    db.query.mockImplementation(async () => {
      const e = new Error('relation does not exist'); e.code = '42P01'; throw e;
    });

    const res = await request(app).get(`/companies/${CID}/products/descriptions/drafts`);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('MIGRATION_287_PENDENTE');
  });
});
