// ============================================================
// AURA. — Entrada de vários itens numa ida só (B2a, 17/11/2026)
//
// "Chegou mercadoria": POST /products/stock-receipts (src/routes/
// stockReceipts.js). Mesmo resultado que dar entrada produto a produto, em
// ordem, pelo caminho de um produto (darEntradaNoProduto, em
// entradaDeMercadoria.js): mesmo estoque, mesmo custo médio, mesmo
// cost_price, mesmo fornecedor principal, mesma última compra, um movimento
// por item (e por variante). A diferença é o número de idas ao banco.
//
// Por que não chamar darEntradaNoProduto num laço: cada ida ao banco custa
// ~125 ms em produção (backend nos EUA, banco em São Paulo; medido no p-141)
// e o caminho de um produto faz ~10 por produto. Uma nota de 300 linhas
// seriam ~3.000 idas, ~6 minutos com os produtos travados e o Caixa
// esperando. Aqui o número de idas é fixo (~17), seja 1 linha ou 300:
//   1. planejarEntradaEmLote (sem banco) aplica as linhas EM ORDEM sobre uma
//      cópia de cada produto travado, com as mesmas contas (calcularEntrada,
//      custoMedioPonderado) — o produto repetido em duas linhas soma duas
//      vezes, como duas entradas seguidas;
//   2. gravarEntradaEmLote grava o plano com UPDATE ... FROM unnest e
//      INSERT ... SELECT unnest, um comando por tabela.
// A equivalência com o caminho de um produto é provada em Postgres real
// (__tests__/stockReceipts.banco.test.js).
//
// Diferenças de propósito em relação a uma entrada de um produto:
//   - o movimento aponta para o cabeçalho (reference_id = stock_receipts.id);
//   - o código do fornecedor (supplier_code) da linha vai para
//     product_suppliers (o caminho de um produto não recebe código);
//   - quantidade com mais de 3 casas é arredondada para 3 antes de tudo
//     (é a precisão do estoque e do movimento, numeric(10,3)).
// ============================================================
'use strict';

const {
  calcularEntrada, falhaDeSchema, round,
} = require('./entradaDeMercadoria');

const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * Aplica as linhas em ordem sobre cópias dos produtos travados. Sem banco.
 *
 * @param produtos   Map product_id -> linha travada (id, company_id, name,
 *                   stock_qty, cost_price, weighted_avg_cost)
 * @param variantes  Map product_id -> [{ id, stock_qty }] (ativas, travadas)
 * @param linhas     [{ index, product_id, entrada (lerEntrada, grade já
 *                   conferida), supplierCode }]
 * @returns {
 *   porLinha:  [{ index, product_id, name, quantity, unit_cost, before, after }],
 *   estoqueProduto:  [{ id, q }]            soma por produto sem grade
 *   estoqueVariante: [{ id, q }]            soma por variante
 *   custo:     [{ id, avg, alvo }]          produtos com custo na entrada;
 *                                           alvo = médio a arredondar no
 *                                           cost_price (null = manter)
 *   produtos:  [{ id, company_id, ultimoCusto, codigo }]  um por produto
 *   movimentos: [{ product_id, q, c, variant_id }]         em ordem
 * }
 */
function planejarEntradaEmLote({ produtos, variantes, linhas }) {
  const estado = new Map();
  const ordem = [];
  const estadoDe = (pid) => {
    if (!estado.has(pid)) {
      const p = produtos.get(pid);
      estado.set(pid, {
        produto: {
          id: p.id, company_id: p.company_id, name: p.name,
          stock_qty: num(p.stock_qty) || 0,
          weighted_avg_cost: num(p.weighted_avg_cost),
          cost_price: num(p.cost_price),
        },
        variantes: (variantes.get(pid) || []).map((v) => ({ id: v.id, stock_qty: num(v.stock_qty) || 0 })),
        somaProduto: 0,
        somaVariante: new Map(),
        teveCusto: false,
        alvo: null,
        ultimoCusto: null,
        codigo: null,
      });
      ordem.push(pid);
    }
    return estado.get(pid);
  };

  const porLinha = [];
  const movimentos = [];
  for (const linha of linhas) {
    const st = estadoDe(linha.product_id);
    const { entrada } = linha;
    const { temGrade, estoqueAntes, custoAntes, custoDepois } = calcularEntrada({
      produto: st.produto, variantes: st.variantes, entrada,
    });

    if (temGrade) {
      for (const it of entrada.itens) {
        const v = st.variantes.find((x) => x.id === it.variant_id);
        v.stock_qty = round(v.stock_qty + it.quantidade, 3);
        st.somaVariante.set(it.variant_id, round((st.somaVariante.get(it.variant_id) || 0) + it.quantidade, 3));
      }
    } else {
      st.produto.stock_qty = round(st.produto.stock_qty + entrada.total, 3);
      st.somaProduto = round(st.somaProduto + entrada.total, 3);
    }

    if (entrada.custoUnitario) {
      st.teveCusto = true;
      st.produto.weighted_avg_cost = custoDepois;
      if (entrada.atualizarCusto) {
        st.alvo = custoDepois;
        st.produto.cost_price = round(custoDepois, 2);
      }
      st.ultimoCusto = entrada.custoUnitario;
    }
    if (linha.supplierCode) st.codigo = linha.supplierCode;

    for (const it of entrada.itens) {
      movimentos.push({ product_id: st.produto.id, q: it.quantidade, c: entrada.custoUnitario, variant_id: it.variant_id });
    }

    porLinha.push({
      index: linha.index,
      product_id: st.produto.id,
      name: st.produto.name,
      quantity: entrada.total,
      unit_cost: entrada.custoUnitario,
      before: { stock_qty: estoqueAntes, avg_cost: custoAntes },
      after: { stock_qty: round(estoqueAntes + entrada.total, 3), avg_cost: custoDepois },
    });
  }

  const estoqueProduto = [];
  const estoqueVariante = [];
  const custo = [];
  const resumo = [];
  for (const pid of ordem) {
    const st = estado.get(pid);
    if (st.somaProduto) estoqueProduto.push({ id: pid, q: st.somaProduto });
    for (const [id, q] of st.somaVariante) estoqueVariante.push({ id, q });
    if (st.teveCusto) custo.push({ id: pid, avg: st.produto.weighted_avg_cost, alvo: st.alvo });
    resumo.push({ id: pid, company_id: st.produto.company_id, ultimoCusto: st.ultimoCusto, codigo: st.codigo });
  }

  return { porLinha, estoqueProduto, estoqueVariante, custo, produtos: resumo, movimentos };
}

/**
 * Grava o plano, dentro da transação de quem chama (produtos e variantes já
 * travados). Um comando por tabela, qualquer que seja o número de linhas.
 *
 * @param client     conexão com a transação aberta
 * @param cid        loja que recebeu (vai no movimento)
 * @param plano      resultado de planejarEntradaEmLote
 * @param fornecedor { id, name, cnpj, phone } ou null
 * @param nota       número da nota (vira 'NF <n>' no movimento) ou null
 * @param receiptId  stock_receipts.id (reference_id do movimento)
 */
async function gravarEntradaEmLote(client, { cid, plano, fornecedor, nota, receiptId }) {
  const ids = (xs) => xs.map((x) => x.id);

  // 1. estoque
  if (plano.estoqueProduto.length) {
    await client.query(
      `UPDATE products p SET stock_qty = p.stock_qty + u.q, updated_at = NOW()
         FROM unnest($1::uuid[], $2::numeric[]) AS u(id, q)
        WHERE p.id = u.id`,
      [ids(plano.estoqueProduto), plano.estoqueProduto.map((x) => x.q)]
    );
  }
  if (plano.estoqueVariante.length) {
    await client.query(
      `UPDATE product_variants v SET stock_qty = v.stock_qty + u.q, updated_at = NOW()
         FROM unnest($1::uuid[], $2::numeric[]) AS u(id, q)
        WHERE v.id = u.id`,
      [ids(plano.estoqueVariante), plano.estoqueVariante.map((x) => x.q)]
    );
  }

  // 2. custo médio (só os produtos com custo na entrada)
  if (plano.custo.length) {
    await client.query(
      `UPDATE products p
          SET weighted_avg_cost = u.avg,
              cost_price = CASE WHEN u.alvo IS NOT NULL THEN ROUND(u.alvo, 2) ELSE p.cost_price END,
              updated_at = NOW()
         FROM unnest($1::uuid[], $2::numeric[], $3::numeric[]) AS u(id, avg, alvo)
        WHERE p.id = u.id`,
      [ids(plano.custo), plano.custo.map((x) => x.avg), plano.custo.map((x) => x.alvo)]
    );
  }

  const todos = ids(plano.produtos);
  if (fornecedor && todos.length) {
    // 3. última compra (colunas da 354; base sem elas segue sem)
    await client.query('SAVEPOINT ultima_compra');
    try {
      await client.query(
        `UPDATE products p
            SET last_supplier_name = $3, last_supplier_cnpj = $4, last_supplier_phone = $5,
                last_purchase_unit_cost = COALESCE(u.c, p.last_purchase_unit_cost),
                last_purchase_at = NOW()
           FROM unnest($1::uuid[], $2::numeric[]) AS u(id, c)
          WHERE p.id = u.id`,
        [todos, plano.produtos.map((x) => x.ultimoCusto), fornecedor.name, fornecedor.cnpj || null, fornecedor.phone || null]
      );
      await client.query('RELEASE SAVEPOINT ultima_compra');
    } catch (e) {
      if (!falhaDeSchema(e)) throw e;
      await client.query('ROLLBACK TO SAVEPOINT ultima_compra');
    }

    // 4. custo e código daquele fornecedor; o primeiro fornecedor vira o principal
    await client.query(
      `INSERT INTO product_suppliers (company_id, product_id, supplier_id, cost, supplier_code, is_main, last_purchase_at)
       SELECT u.company_id, u.id, $1, u.c, u.codigo,
              NOT EXISTS (SELECT 1 FROM product_suppliers x WHERE x.product_id = u.id AND x.is_main), NOW()
         FROM unnest($2::uuid[], $3::uuid[], $4::numeric[], $5::text[]) AS u(id, company_id, c, codigo)
       ON CONFLICT (product_id, supplier_id) DO UPDATE
         SET cost = COALESCE(EXCLUDED.cost, product_suppliers.cost),
             supplier_code = COALESCE(EXCLUDED.supplier_code, product_suppliers.supplier_code),
             last_purchase_at = NOW(), updated_at = NOW()`,
      [fornecedor.id, todos, plano.produtos.map((x) => x.company_id),
        plano.produtos.map((x) => x.ultimoCusto), plano.produtos.map((x) => x.codigo)]
    );

    // products.supplier_id espelha o principal (o mesmo de espelharPrincipal)
    await client.query(
      `UPDATE products p
          SET supplier_id = s.id, supplier_name = s.name, supplier_cnpj = s.cnpj, updated_at = NOW()
         FROM product_suppliers ps JOIN suppliers s ON s.id = ps.supplier_id
        WHERE p.id = ANY($1::uuid[]) AND ps.product_id = p.id AND ps.is_main
          AND p.supplier_id IS DISTINCT FROM s.id`,
      [todos]
    );
    await client.query(
      `UPDATE products p SET supplier_id = NULL, supplier_name = NULL, supplier_cnpj = NULL, updated_at = NOW()
        WHERE p.id = ANY($1::uuid[]) AND p.supplier_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM product_suppliers x WHERE x.product_id = p.id AND x.is_main)`,
      [todos]
    );
  }

  // 5. movimentos, na ordem das linhas
  if (plano.movimentos.length) {
    const m = plano.movimentos;
    await client.query(
      `INSERT INTO stock_movements
         (product_id, company_id, type, quantity, reference_type, reference_id, notes, supplier_id, unit_cost, variant_id)
       SELECT u.product_id, $1, 'in', u.q, 'entrada', $2, $3, $4, u.c, u.variant_id
         FROM unnest($5::uuid[], $6::numeric[], $7::numeric[], $8::uuid[]) WITH ORDINALITY
              AS u(product_id, q, c, variant_id, ord)
        ORDER BY u.ord`,
      [cid, receiptId, nota ? `NF ${nota}` : null, fornecedor ? fornecedor.id : null,
        m.map((x) => x.product_id), m.map((x) => x.q), m.map((x) => x.c), m.map((x) => x.variant_id)]
    );
  }
}

module.exports = { planejarEntradaEmLote, gravarEntradaEmLote };
