// ============================================================
// AURA VENDAS — remover item que ja tinha voltado parcialmente numa TROCA
//
// O BUG (ramo 'pdv' do DELETE /transactions/:tx_id/sale-items/:item_id)
//   A troca NAO encolhe a venda original: ela grava troca_returned_items e
//   ancora uma venda type='troca', deixando sale_items.quantity intacto. Logo
//   sale_items.quantity e a quantidade VENDIDA, nao a que sobrou com o cliente.
//   O DELETE creditava item.quantity no estoque e descontava item.total_price
//   cheio — num item de 3 com 1 ja trocado, devolvia 3 unidades em vez de 2.
//   Estoque inflando em silencio, uma unidade por troca, e a receita da venda
//   caindo duas vezes (aqui e no returned_value da troca).
//
//   O caso "100% ja devolvido" ja estava barrado desde 28/08/2026: o GET
//   /sale-details devolve returned_quantity/available_quantity e a tela
//   desabilita o botao com available_quantity = 0. O PARCIAL passava reto.
//
// A DECISAO sobre apagar o sale_item
//   Com devolucao anterior a linha NAO some, ela ENCOLHE pra parte trocada.
//   sales.total_amount e recalculado por SUM(sale_items.total_price); apagar a
//   linha inteira tiraria da receita tambem a parte trocada, que ja e abatida
//   no returned_value da venda de troca — a loja perderia o mesmo valor duas
//   vezes. Alem disso troca_returned_items.original_sale_item_id e ON DELETE
//   SET NULL: apagar levaria junto a guarda anti-dupla-devolucao. Encolhida, a
//   linha fica com quantity == returned_quantity, entao o proprio GET passa a
//   devolver available_quantity = 0 e a tela nao oferece remover de novo.
//
//   SEM devolucao anterior (o caso comum) nada muda: apaga a linha, cancela a
//   venda se era a ultima e some com a tx de receita. Os testes abaixo prendem
//   os DOIS lados.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const express = require('express');
const request = require('supertest');

const db = require('../src/config/database');

const COMPANY = 'company-uuid-devolucao';
const SALE_ID = '223b1c59-1770-47c0-a90d-6dcb036d0f7b';
const TX_ID = 'tx-uuid-receita';
const ITEM_ID = 'item-uuid-vestido';
const OUTRO_ITEM = 'item-uuid-bolsa';
const PRODUTO = 'produto-uuid-vestido';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies/:id', require('../src/routes/transactionSale'));
  // Mesmo tradutor de AppError -> status do src/app.js.
  app.use(function(err, req, res, next) { // eslint-disable-line no-unused-vars
    res.status(err.statusCode || err.status || 500).json({ error: err.message });
  });
  return app;
}

// Banco de mentira com estado: os asserts olham o ESTADO final (estoque, linha
// da venda, lancamentos), nao a string do SQL — SQL equivalente reescrito nao
// deve reprovar o teste, comportamento errado deve.
//
// itens: [{ id, quantity, unit_price, total_price, discount }]
// devolvidos: { [sale_item_id]: quantidade ja devolvida em troca }
// trocaTabelaAusente: simula deploy parcial (42P01 em troca_returned_items)
function mockDb({
  itens = [{ id: ITEM_ID, quantity: 3, unit_price: 100, total_price: 300, discount: 0 }],
  devolvidos = {},
  txAmount = 300,
  estoqueInicial = 10,
  trocaTabelaAusente = false,
} = {}) {
  const estado = {
    saleItems: itens.map((i) => Object.assign({}, i)),
    stock: estoqueInicial,
    stockVariante: estoqueInicial,
    txAmount: txAmount,
    txExiste: true,
    saleTotal: itens.reduce((s, i) => s + i.total_price, 0),
    saleCancelada: false,
    espelhos: [],
    apagouItem: false,
    encolheuItem: false,
  };

  const client = {
    query: (sql, params) => {
      const s = String(sql);
      const p = params || [];

      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(s)) return Promise.resolve({ rows: [] });

      // Ancorado no SELECT: 'DELETE FROM transactions WHERE id = $1' tambem casa
      // o trecho e cairia aqui, mascarando a remocao da receita.
      if (/^\s*SELECT[\s\S]*FROM transactions WHERE id = \$1/.test(s)) {
        if (!estado.txExiste) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [{
          id: TX_ID,
          idempotency_key: 'pdv-sale-' + SALE_ID,
          amount: estado.txAmount,
          description: 'Venda PDV',
        }] });
      }

      if (/FROM sale_items si/.test(s)) {
        const it = estado.saleItems.find((i) => i.id === p[0]);
        if (!it) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [{
          id: it.id,
          sale_id: SALE_ID,
          product_id: PRODUTO,
          variant_id: null,
          quantity: it.quantity,
          total_price: it.total_price,
          product_name_snapshot: 'Vestido Midi',
          product_name: 'Vestido Midi',
        }] });
      }

      if (/FROM troca_returned_items tri/.test(s)) {
        if (trocaTabelaAusente) {
          const e = new Error('relation "troca_returned_items" does not exist');
          e.code = '42P01';
          return Promise.reject(e);
        }
        return Promise.resolve({ rows: Object.keys(devolvidos).map((itemId) => ({
          item_id: itemId,
          returned_qty: devolvidos[itemId],
        })) });
      }

      if (/UPDATE products SET stock_qty/.test(s)) {
        estado.stock += parseFloat(p[0]);
        return Promise.resolve({ rows: [] });
      }
      if (/UPDATE product_variants SET stock_qty/.test(s)) {
        estado.stockVariante += parseFloat(p[0]);
        return Promise.resolve({ rows: [] });
      }

      if (/UPDATE sale_items/.test(s)) {
        estado.encolheuItem = true;
        const it = estado.saleItems.find((i) => i.id === p[3]);
        it.quantity = parseFloat(p[0]);
        it.total_price = parseFloat(p[1]);
        it.discount = Math.round((it.discount || 0) * parseFloat(p[2]) * 100) / 100;
        return Promise.resolve({ rows: [] });
      }
      if (/DELETE FROM sale_items/.test(s)) {
        estado.apagouItem = true;
        estado.saleItems = estado.saleItems.filter((i) => i.id !== p[0]);
        return Promise.resolve({ rows: [] });
      }

      if (/COUNT\(\*\)::int AS n/.test(s)) {
        return Promise.resolve({ rows: [{
          n: estado.saleItems.length,
          new_total: estado.saleItems.reduce((acc, i) => acc + i.total_price, 0),
        }] });
      }

      if (/UPDATE sales SET status = 'cancelled'/.test(s)) {
        estado.saleCancelada = true;
        return Promise.resolve({ rows: [] });
      }
      if (/UPDATE sales SET total_amount/.test(s)) {
        estado.saleTotal = parseFloat(p[0]);
        return Promise.resolve({ rows: [] });
      }

      if (/DELETE FROM transactions/.test(s)) {
        estado.txExiste = false;
        return Promise.resolve({ rows: [] });
      }
      if (/UPDATE transactions SET amount/.test(s)) {
        estado.txAmount = parseFloat(p[0]);
        return Promise.resolve({ rows: [] });
      }

      if (/INSERT INTO transactions/i.test(s)) {
        estado.espelhos.push({ amount: parseFloat(p[1]), description: p[2], key: p[3] });
        return Promise.resolve({ rows: [] });
      }

      return Promise.resolve({ rows: [] });
    },
    release: () => {},
  };

  db.connect.mockImplementation(() => Promise.resolve(client));
  db.query.mockImplementation(() => Promise.resolve({ rows: [] }));
  return estado;
}

function removerItem(itemId) {
  return request(buildApp())
    .delete(`/companies/${COMPANY}/transactions/${TX_ID}/sale-items/${itemId || ITEM_ID}`)
    .send({});
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('DELETE sale-item — parte do item ja voltou numa troca', () => {
  it('devolve ao estoque so o que ainda estava com o cliente (2 de 3, nao 3)', async () => {
    // Vestido: vendidos 3 a R$ 100. O cliente trocou 1 semana passada.
    const estado = mockDb({ devolvidos: { [ITEM_ID]: 1 } });

    const res = await removerItem();

    expect(res.status).toBe(200);
    // O bug creditava 3 -> 13. O certo e 12.
    expect(estado.stock).toBe(12);
    expect(res.body.removed_item.quantity).toBe(2);
    expect(res.body.removed_item.returned_before).toBe(1);
  });

  it('o valor devolvido e proporcional, nao o total_price cheio', async () => {
    const estado = mockDb({ devolvidos: { [ITEM_ID]: 1 } });

    const res = await removerItem();

    expect(res.body.removed_item.refund_amount).toBe(200);
    // Espelho de devolucao (saida de caixa) segue o mesmo valor.
    expect(estado.espelhos).toHaveLength(1);
    expect(estado.espelhos[0].amount).toBe(200);
    expect(estado.espelhos[0].description).toContain('qty 2');
    // Receita cai 200, nao 300: os outros 100 ja sao abatidos no
    // returned_value da venda de troca.
    expect(estado.txAmount).toBe(100);
    expect(res.body.new_tx_amount).toBe(100);
  });

  it('encolhe o sale_item em vez de apagar, e a venda nao e cancelada', async () => {
    const estado = mockDb({ devolvidos: { [ITEM_ID]: 1 } });

    const res = await removerItem();

    expect(estado.apagouItem).toBe(false);
    expect(estado.encolheuItem).toBe(true);
    // A linha passa a valer exatamente a parte trocada: quantity ==
    // returned_quantity -> o GET devolve available_quantity 0 e a tela para de
    // oferecer remover.
    expect(estado.saleItems).toHaveLength(1);
    expect(estado.saleItems[0].quantity).toBe(1);
    expect(estado.saleItems[0].total_price).toBe(100);
    expect(estado.saleTotal).toBe(100);
    expect(estado.saleCancelada).toBe(false);
    expect(res.body.sale_cancelled).toBe(false);
    expect(res.body.new_sale_total).toBe(100);
  });

  it('o que sobra na venda mais o devolvido fecha o total original (sem centavo perdido)', async () => {
    // 3 x R$ 33,3333: o proporcional nao fecha em conta redonda.
    const estado = mockDb({
      itens: [{ id: ITEM_ID, quantity: 3, unit_price: 33.34, total_price: 100, discount: 0 }],
      devolvidos: { [ITEM_ID]: 1 },
      txAmount: 100,
    });

    const res = await removerItem();

    expect(res.body.removed_item.refund_amount).toBe(66.67);
    expect(estado.saleItems[0].total_price).toBe(33.33);
    expect(estado.saleItems[0].total_price + res.body.removed_item.refund_amount).toBe(100);
  });

  it('desconto da linha encolhe junto, proporcional ao que ficou', async () => {
    const estado = mockDb({
      itens: [{ id: ITEM_ID, quantity: 4, unit_price: 100, total_price: 360, discount: 40 }],
      devolvidos: { [ITEM_ID]: 1 },
      txAmount: 360,
    });

    await removerItem();

    // 1 de 4 permanece na venda -> 25% do desconto da linha.
    expect(estado.saleItems[0].discount).toBe(10);
  });

  it('bloqueia com 409 quando o item ja voltou por inteiro, sem tocar no estoque', async () => {
    const estado = mockDb({ devolvidos: { [ITEM_ID]: 3 } });

    const res = await removerItem();

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/ja foi devolvido/i);
    expect(estado.stock).toBe(10);
    expect(estado.apagouItem).toBe(false);
    expect(estado.encolheuItem).toBe(false);
    expect(estado.espelhos).toHaveLength(0);
  });

  it('a devolucao de OUTRO item da venda nao contamina o item removido', async () => {
    const estado = mockDb({
      itens: [
        { id: ITEM_ID, quantity: 3, unit_price: 100, total_price: 300, discount: 0 },
        { id: OUTRO_ITEM, quantity: 2, unit_price: 50, total_price: 100, discount: 0 },
      ],
      devolvidos: { [OUTRO_ITEM]: 2 },
      txAmount: 400,
    });

    const res = await removerItem();

    expect(estado.stock).toBe(13);
    expect(res.body.removed_item.refund_amount).toBe(300);
    expect(estado.apagouItem).toBe(true);
  });
});

describe('DELETE sale-item — sem devolucao anterior nada muda', () => {
  it('apaga a linha, devolve tudo ao estoque e cancela a venda do ultimo item', async () => {
    const estado = mockDb({ devolvidos: {} });

    const res = await removerItem();

    expect(res.status).toBe(200);
    expect(estado.stock).toBe(13);
    expect(estado.apagouItem).toBe(true);
    expect(estado.encolheuItem).toBe(false);
    expect(estado.saleCancelada).toBe(true);
    expect(res.body.sale_cancelled).toBe(true);
    // Ultimo item: a receita some inteira e NAO ha espelho (duplicaria a baixa).
    expect(estado.txExiste).toBe(false);
    expect(res.body.tx_removed).toBe(true);
    expect(estado.espelhos).toHaveLength(0);
    expect(res.body.removed_item.quantity).toBe(3);
    expect(res.body.removed_item.refund_amount).toBe(300);
    expect(res.body.removed_item.returned_before).toBe(0);
  });

  it('sobrando item, reduz venda e receita pelo valor cheio da linha', async () => {
    const estado = mockDb({
      itens: [
        { id: ITEM_ID, quantity: 3, unit_price: 100, total_price: 300, discount: 0 },
        { id: OUTRO_ITEM, quantity: 2, unit_price: 50, total_price: 100, discount: 0 },
      ],
      txAmount: 400,
    });

    await removerItem();

    expect(estado.saleTotal).toBe(100);
    expect(estado.txAmount).toBe(100);
    expect(estado.espelhos[0].amount).toBe(300);
  });

  it('tabela de troca ausente (deploy parcial) cai no comportamento antigo, nao em 500', async () => {
    // returnedQtyBySaleItem engole 42P01 e devolve mapa vazio.
    const estado = mockDb({ trocaTabelaAusente: true });

    const res = await removerItem();

    expect(res.status).toBe(200);
    expect(estado.stock).toBe(13);
    expect(estado.apagouItem).toBe(true);
  });
});
