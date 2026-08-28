// ============================================================
// AURA. — Vinculo Transacao <-> Venda (mercadorias + vendedora)
//
// Quando uma transaction veio do PDV, sua idempotency_key tem
// formato "pdv-sale-{sale_uuid}". Esse arquivo expõe acoes
// extras pra editar a venda relacionada SEM quebrar o snapshot
// da transacao financeira.
//
// Rotas:
//   GET    /transactions/:tx_id/sale-details
//   POST   /transactions/:tx_id/sale-items           (adicionar produto - EXTRA C)
//   DELETE /transactions/:tx_id/sale-items/:item_id  (devolucao parcial)
//   PATCH  /transactions/:tx_id/seller               (mudar vendedora)
//
// 28/08/2026 — CREDIARIO (relato Eryca #1): "editar lancamento de venda nao
//   lista os produtos". A venda 100% fiada NAO gera 'pdv-sale-<id>' (pdv.js so
//   insere a receita quando cashAmount > 0); o unico lancamento dela e o
//   'A Receber' com chave 'pdv-credit-receivable-<saleId>' (ledger.js). O
//   extractSaleId antigo so casava 'pdv-sale-' -> has_sale=false -> a secao de
//   mercadorias sumia. Agora o vinculo cobre os dois formatos (incluindo o
//   saldo parcial 'pdv-credit-receivable-<saleId>-rest-<ts>').
//
//   Como o crediario tem ledger proprio (customer_credit_transactions +
//   credit_installments + credit_used), remover item NAO pode seguir o caminho
//   do dinheiro (deletar sale_item / mexer em transactions.amount na mao) —
//   isso deixaria divida e parcelas de pe. O DELETE delega ao motor oficial de
//   devolucao (services/credit/refund.js), o mesmo do botao "Devolver" do
//   detalhe da venda. Por simetria, adicionar produto fica BLOQUEADO no
//   crediario (nao existe motor de "aumentar a divida" pos-venda).
// ============================================================

const router = require('express').Router({ mergeParams: true });
const pool = require('../config/database');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');
const { refundCreditSale } = require('../services/credit/refund');
// Quais idempotency_key amarram um lancamento a uma venda — e de que origem
// ('pdv' = recebeu na hora / 'credit' = A Receber do crediario).
const { resolveSaleLink, extractSaleId } = require('../utils/saleLink');

// Quanto ja foi devolvido/trocado por item da venda (troca_returned_items).
// Best-effort: em deploy parcial a tabela pode nao existir (42P01) -> tudo 0.
async function returnedQtyBySaleItem(client, saleId) {
  try {
    const { rows } = await client.query(
      `SELECT tri.original_sale_item_id AS item_id,
              COALESCE(SUM(tri.quantity), 0)::numeric AS returned_qty
         FROM troca_returned_items tri
         JOIN sales ts ON ts.id = tri.troca_sale_id
        WHERE tri.original_sale_id = $1
          AND COALESCE(ts.status, 'completed') != 'cancelled'
        GROUP BY tri.original_sale_item_id`,
      [saleId]
    );
    return new Map(rows.map(function(r) {
      return [r.item_id, parseFloat(r.returned_qty) || 0];
    }));
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return new Map();
    throw e;
  }
}

// GET /transactions/:tx_id/sale-details
// Retorna { has_sale, sale, items, customer, seller, available_employees }
// Se transaction nao for de venda, has_sale=false.
router.get('/transactions/:tx_id/sale-details', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const txId = req.params.tx_id;

  const txRes = await pool.query(
    `SELECT id, idempotency_key, employee_id, employee_name, amount, description
     FROM transactions WHERE id = $1 AND company_id = $2`,
    [txId, companyId]
  );
  if (!txRes.rows.length) throw new AppError('Lancamento nao encontrado', 404);
  const tx = txRes.rows[0];
  const link = resolveSaleLink(tx.idempotency_key);
  const saleId = link ? link.saleId : null;

  // Lista de funcionarios pra dropdown (ativos)
  const empRes = await pool.query(
    `SELECT id, name FROM employees WHERE company_id = $1 AND COALESCE(is_active, true) = true
     ORDER BY name`,
    [companyId]
  );
  const availableEmployees = empRes.rows;

  if (!saleId) {
    // Transacao nao vinculada a venda — so retorna info de funcionario
    return res.json({
      has_sale: false,
      transaction: {
        id: tx.id,
        amount: parseFloat(tx.amount),
        description: tx.description,
        employee_id: tx.employee_id,
        employee_name: tx.employee_name,
      },
      available_employees: availableEmployees,
    });
  }

  // Busca venda + itens + customer + seller
  const saleRes = await pool.query(
    `SELECT s.id, s.total_amount, s.discount_amount, s.payment_method, s.status,
            s.cancelled_at, s.created_at,
            s.customer_id, c.name AS customer_name, c.phone AS customer_phone,
            s.seller_id, s.seller_name, s.employee_id
     FROM sales s
     LEFT JOIN customers c ON c.id = s.customer_id
     WHERE s.id = $1 AND s.company_id = $2`,
    [saleId, companyId]
  );
  if (!saleRes.rows.length) {
    // Venda foi deletada mas transacao continua — comporta como sem venda
    return res.json({
      has_sale: false,
      transaction: {
        id: tx.id,
        amount: parseFloat(tx.amount),
        description: tx.description,
        employee_id: tx.employee_id,
        employee_name: tx.employee_name,
      },
      available_employees: availableEmployees,
    });
  }
  const sale = saleRes.rows[0];

  const itemsRes = await pool.query(
    `SELECT si.id, si.product_id, si.variant_id, si.quantity,
            si.unit_price, si.discount, si.total_price,
            si.product_name_snapshot,
            p.name AS product_name, p.image_url
     FROM sale_items si
     LEFT JOIN products p ON p.id = si.product_id
     WHERE si.sale_id = $1
     ORDER BY si.id`,
    [saleId]
  );

  // 28/08/2026: no crediario a devolucao NAO apaga o sale_item — ela grava um
  // troca_returned_items e ancora uma venda type='devolucao'. Sem expor isso, a
  // tela mostraria o item como se ainda estivesse na venda e ofereceria
  // "remover" de novo (o motor barra com DOUBLE_RETURN_BLOCKED).
  const returnedMap = await returnedQtyBySaleItem(pool, saleId);
  const isCredit = link.source === 'credit';

  res.json({
    has_sale: true,
    // Fonte do vinculo: 'pdv' (receita em dinheiro) ou 'credit' (A Receber).
    // O front usa pra trocar o texto da devolucao e esconder "adicionar produto".
    sale_source: link.source,
    transaction: {
      id: tx.id,
      amount: parseFloat(tx.amount),
      description: tx.description,
      employee_id: tx.employee_id,
      employee_name: tx.employee_name,
    },
    sale: {
      id: sale.id,
      total_amount: parseFloat(sale.total_amount),
      discount_amount: parseFloat(sale.discount_amount || 0),
      payment_method: sale.payment_method,
      status: sale.status,
      cancelled_at: sale.cancelled_at,
      created_at: sale.created_at,
      is_credit: isCredit,
      // No crediario a venda continua inteira; quem some e a divida.
      can_add_items: !isCredit,
    },
    customer: sale.customer_id ? {
      id: sale.customer_id,
      name: sale.customer_name,
      phone: sale.customer_phone,
    } : null,
    seller: {
      id: sale.seller_id || sale.employee_id,
      name: sale.seller_name,
    },
    items: itemsRes.rows.map(function(r) {
      const qty = parseFloat(r.quantity);
      const returnedQty = returnedMap.get(r.id) || 0;
      return {
        id: r.id,
        product_id: r.product_id,
        variant_id: r.variant_id,
        quantity: qty,
        unit_price: parseFloat(r.unit_price),
        discount: parseFloat(r.discount || 0),
        total_price: parseFloat(r.total_price),
        product_name: r.product_name || r.product_name_snapshot || 'Item',
        image_url: r.image_url,
        returned_quantity: returnedQty,
        available_quantity: Math.max(0, parseFloat((qty - returnedQty).toFixed(3))),
      };
    }),
    available_employees: availableEmployees,
  });
}));

// POST /transactions/:tx_id/sale-items
// Body: { product_id, variant_id?, quantity, unit_price?, product_name_snapshot? }
//
// Adiciona um produto a uma venda existente (EXTRA C):
//   1. Valida produto + variant pertencem a empresa
//   2. Valida estoque disponivel
//   3. Decrementa estoque (variant tem prioridade sobre product)
//   4. INSERT em sale_items
//   5. Soma sales.total_amount
//   6. Soma transactions.amount
// Tudo atomico.
//
// Se venda esta cancelada (status='cancelled'), bloqueia.
router.post('/transactions/:tx_id/sale-items', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const txId = req.params.tx_id;
  const { product_id, variant_id, quantity, unit_price, product_name_snapshot } = req.body || {};

  // Validacoes basicas
  if (!product_id) throw new AppError('product_id e obrigatorio', 400);
  const qty = parseFloat(quantity);
  if (!qty || qty <= 0) throw new AppError('quantity deve ser maior que zero', 400);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Carrega transaction + valida vinculo com venda
    const txRes = await client.query(
      `SELECT id, idempotency_key, amount FROM transactions
       WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [txId, companyId]
    );
    if (!txRes.rows.length) throw new AppError('Lancamento nao encontrado', 404);
    const tx = txRes.rows[0];
    const link = resolveSaleLink(tx.idempotency_key);
    if (!link) throw new AppError('Lancamento nao esta vinculado a uma venda', 400);
    const saleId = link.saleId;

    // 28/08/2026: somar item na mao aqui aumentaria a receita/recebivel SEM
    // aumentar o debit do ledger nem as parcelas — a divida do cliente ficaria
    // menor que a venda. Nao existe motor de "acrescimo pos-venda" no crediario;
    // o caminho e lancar uma venda nova.
    if (link.source === 'credit') {
      throw new AppError(
        'Venda no crediario nao aceita produto novo depois de fechada — ' +
        'a divida e as parcelas ja foram geradas. Lance uma venda nova pro cliente.',
        400
      );
    }

    // 2. Carrega venda + valida nao cancelada
    const saleRes = await client.query(
      `SELECT id, total_amount, status FROM sales
       WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [saleId, companyId]
    );
    if (!saleRes.rows.length) throw new AppError('Venda nao encontrada', 404);
    if (saleRes.rows[0].status === 'cancelled') {
      throw new AppError('Nao eh possivel adicionar items a uma venda cancelada', 400);
    }

    // 3. Carrega produto + valida pertence a empresa
    const prodRes = await client.query(
      'SELECT id, name, price, stock_qty FROM products WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [product_id, companyId]
    );
    if (!prodRes.rows.length) throw new AppError('Produto nao encontrado', 404);
    const product = prodRes.rows[0];

    // 4. Se variant_id, valida pertence ao produto + tem estoque
    let variant = null;
    let effectivePrice = parseFloat(unit_price || product.price);
    let displayName = product_name_snapshot || product.name;

    if (variant_id) {
      const varRes = await client.query(
        `SELECT id, sku_suffix, price_override, stock_qty, is_active
         FROM product_variants WHERE id = $1 AND product_id = $2 FOR UPDATE`,
        [variant_id, product_id]
      );
      if (!varRes.rows.length) throw new AppError('Variante nao encontrada', 404);
      if (varRes.rows[0].is_active === false) throw new AppError('Variante inativa', 400);
      variant = varRes.rows[0];
      const varStock = parseFloat(variant.stock_qty || 0);
      if (varStock < qty) {
        throw new AppError('Estoque insuficiente. Disponivel: ' + varStock + ' un', 400);
      }
      // Sobrescreve preco se cliente nao mandou e variant tem override
      if (unit_price == null && variant.price_override != null) {
        effectivePrice = parseFloat(variant.price_override);
      }
    } else {
      // Validacao de estoque do produto (so se nao for variante, ja que produto pai pode ser ignorado)
      const prodStock = parseFloat(product.stock_qty || 0);
      if (prodStock < qty) {
        throw new AppError('Estoque insuficiente. Disponivel: ' + prodStock + ' un', 400);
      }
    }

    if (!effectivePrice || effectivePrice < 0) {
      throw new AppError('unit_price invalido', 400);
    }

    const itemTotal = parseFloat((qty * effectivePrice).toFixed(2));

    // 5. Decrementa estoque (variant tem prioridade)
    if (variant) {
      await client.query(
        `UPDATE product_variants SET stock_qty = COALESCE(stock_qty, 0) - $1, updated_at = NOW()
         WHERE id = $2`,
        [qty, variant_id]
      );
    } else {
      await client.query(
        `UPDATE products SET stock_qty = COALESCE(stock_qty, 0) - $1, updated_at = NOW()
         WHERE id = $2 AND company_id = $3`,
        [qty, product_id, companyId]
      );
    }

    // 6. INSERT no sale_items
    const newItemRes = await client.query(
      `INSERT INTO sale_items (
         sale_id, product_id, variant_id, quantity, unit_price,
         discount, total_price, product_name_snapshot, item_discount
       ) VALUES ($1, $2, $3, $4, $5, 0, $6, $7, 0)
       RETURNING id, product_id, variant_id, quantity, unit_price, discount, total_price, product_name_snapshot`,
      [saleId, product_id, variant_id || null, qty, effectivePrice, itemTotal, displayName]
    );
    const newItem = newItemRes.rows[0];

    // 7. Soma no sales.total_amount
    const newSaleTotal = parseFloat(saleRes.rows[0].total_amount) + itemTotal;
    await client.query(
      'UPDATE sales SET total_amount = $1, updated_at = NOW() WHERE id = $2',
      [newSaleTotal, saleId]
    );

    // 8. Soma na transactions.amount
    const newTxAmount = parseFloat(tx.amount) + itemTotal;
    await client.query(
      'UPDATE transactions SET amount = $1, updated_at = NOW() WHERE id = $2',
      [newTxAmount, txId]
    );

    await client.query('COMMIT');
    res.status(201).json({
      ok: true,
      item: {
        id: newItem.id,
        product_id: newItem.product_id,
        variant_id: newItem.variant_id,
        quantity: parseFloat(newItem.quantity),
        unit_price: parseFloat(newItem.unit_price),
        discount: parseFloat(newItem.discount || 0),
        total_price: parseFloat(newItem.total_price),
        product_name: displayName,
      },
      new_sale_total: newSaleTotal,
      new_tx_amount: newTxAmount,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// DELETE /transactions/:tx_id/sale-items/:item_id
// Devolucao parcial:
//   1. Devolve quantidade ao stock (product ou variant)
//   2. Reduz sales.total_amount
//   3. Reduz transactions.amount (ou DELETE se for o último item)
//   4. Cria nova transaction tipo 'expense' categoria 'devolucao'
//      como contrapartida (auditoria) — APENAS quando ainda restam itens.
//      Se foi o último item, a venda inteira é cancelada e a tx de receita
//      é removida (mesmo fluxo de POST /sales/:sale_id/cancel) — não precisa
//      de espelho de devolução porque a receita já some.
// Tudo numa unica transacao SQL pra atomicidade.
router.delete('/transactions/:tx_id/sale-items/:item_id', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const txId = req.params.tx_id;
  const itemId = req.params.item_id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Carrega transaction + valida vinculo com venda
    const txRes = await client.query(
      `SELECT id, idempotency_key, amount, description
       FROM transactions WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [txId, companyId]
    );
    if (!txRes.rows.length) throw new AppError('Lancamento nao encontrado', 404);
    const tx = txRes.rows[0];
    const link = resolveSaleLink(tx.idempotency_key);
    if (!link) throw new AppError('Lancamento nao esta vinculado a uma venda', 400);
    const saleId = link.saleId;

    // 2. Carrega item da venda + valida pertence a essa venda + empresa
    //
    // 28/08/2026: era `FOR UPDATE` puro num LEFT JOIN products — Postgres
    // recusa com 0A000 ("FOR UPDATE cannot be applied to the nullable side of
    // an outer join"), entao TODA remocao de item explodia em 500, crediario ou
    // nao. Trava so as tabelas do lado interno (si, s), que sao as que mudam.
    const itemRes = await client.query(
      `SELECT si.id, si.sale_id, si.product_id, si.variant_id,
              si.quantity, si.total_price, si.product_name_snapshot,
              p.name AS product_name
       FROM sale_items si
       LEFT JOIN products p ON p.id = si.product_id
       JOIN sales s ON s.id = si.sale_id
       WHERE si.id = $1 AND s.id = $2 AND s.company_id = $3 FOR UPDATE OF si, s`,
      [itemId, saleId, companyId]
    );
    if (!itemRes.rows.length) throw new AppError('Item nao encontrado nessa venda', 404);
    const item = itemRes.rows[0];
    const itemTotal = parseFloat(item.total_price);
    const itemQty = parseFloat(item.quantity);
    const itemName = item.product_name || item.product_name_snapshot || 'Item';

    // 2b. CREDIARIO: delega ao motor oficial de devolucao.
    //
    // Apagar o sale_item aqui deixaria o debit do ledger, as parcelas e o
    // credit_used intactos — o cliente continuaria devendo por um produto que
    // voltou pra prateleira. refundCreditSale faz o certo: repoe estoque, grava
    // troca_returned_items (guarda anti-dupla-devolucao), lanca 'refund' no
    // ledger, abate as ultimas parcelas abertas e reduz o 'A Receber'.
    if (link.source === 'credit') {
      const returnedMap = await returnedQtyBySaleItem(client, saleId);
      const already = returnedMap.get(item.id) || 0;
      const remaining = parseFloat((itemQty - already).toFixed(3));
      if (remaining <= 0) {
        throw new AppError('Esse produto ja foi devolvido por inteiro.', 409);
      }

      let refund;
      try {
        refund = await refundCreditSale(client, {
          companyId: companyId,
          saleId: saleId,
          items: [{ sale_item_id: item.id, quantity: remaining }],
          reason: 'Devolucao pela edicao do lancamento',
          createdBy: req.user?.id || null,
        });
      } catch (e) {
        // O motor usa err(status, body); traduz pro AppError do resto da rota.
        if (e.isRefundError) throw new AppError(e.body?.error || 'Erro na devolucao', e.status || 400);
        throw e;
      }

      // Recebivel depois do abatimento (o motor pode ter zerado/apagado a linha).
      const afterTx = await client.query(
        'SELECT amount FROM transactions WHERE id = $1 AND company_id = $2',
        [txId, companyId]
      );
      const newTxAmount = afterTx.rows.length ? parseFloat(afterTx.rows[0].amount) : 0;

      const saleAfter = await client.query(
        'SELECT total_amount FROM sales WHERE id = $1', [saleId]
      );

      await client.query('COMMIT');
      return res.json({
        ok: true,
        mode: 'credit_refund',
        removed_item: { id: itemId, name: itemName, quantity: remaining, refund_amount: refund.refund_value },
        // A venda no crediario nao encolhe: o valor devolvido vira devolucao
        // ancorada (sales type='devolucao') + abatimento das parcelas.
        new_sale_total: parseFloat(saleAfter.rows[0]?.total_amount || 0),
        new_tx_amount: newTxAmount,
        tx_removed: afterTx.rows.length === 0,
        sale_cancelled: false,
        credit_refund: {
          devolucao_sale_id: refund.devolucao_sale_id,
          refund_value: refund.refund_value,
          abated_installments: refund.abated_installments,
          credit_generated: refund.credit_generated,
          new_balance: refund.new_balance,
        },
      });
    }

    // 3. Devolve estoque (variant tem prioridade)
    if (item.variant_id) {
      await client.query(
        `UPDATE product_variants SET stock_qty = COALESCE(stock_qty, 0) + $1, updated_at = NOW()
         WHERE id = $2`,
        [itemQty, item.variant_id]
      );
    } else if (item.product_id) {
      await client.query(
        `UPDATE products SET stock_qty = COALESCE(stock_qty, 0) + $1, updated_at = NOW()
         WHERE id = $2 AND company_id = $3`,
        [itemQty, item.product_id, companyId]
      );
    }

    // 4. Remove o item da venda
    await client.query('DELETE FROM sale_items WHERE id = $1', [itemId]);

    // 5. Verifica quantos items restaram
    const remainingRes = await client.query(
      'SELECT COUNT(*)::int AS n, COALESCE(SUM(total_price), 0) AS new_total FROM sale_items WHERE sale_id = $1',
      [saleId]
    );
    const remaining = remainingRes.rows[0];
    const newTotal = parseFloat(remaining.new_total);
    const isLastItem = remaining.n === 0;

    if (isLastItem) {
      // Sem itens restantes: cancela a venda inteira (mesmo fluxo do
      // POST /sales/:sale_id/cancel — receita sai do financeiro).
      await client.query(
        `UPDATE sales SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [saleId]
      );
    } else {
      // Atualiza total da venda
      await client.query(
        'UPDATE sales SET total_amount = $1, updated_at = NOW() WHERE id = $2',
        [newTotal, saleId]
      );
    }

    // 6. Ajusta transaction de receita.
    //    - Último item: DELETE (UPDATE amount=0 violaria CHECK amount > 0).
    //      Receita some do financeiro junto com o cancelamento da venda.
    //    - Ainda há itens: UPDATE pra novo total. Mantém a tx de receita ativa.
    const newTxAmount = parseFloat(tx.amount) - itemTotal;
    let txRemoved = false;

    if (isLastItem || newTxAmount <= 0) {
      await client.query('DELETE FROM transactions WHERE id = $1', [txId]);
      txRemoved = true;
    } else {
      await client.query(
        'UPDATE transactions SET amount = $1, updated_at = NOW() WHERE id = $2',
        [newTxAmount, txId]
      );
    }

    // 7. Cria transacao espelho de "devolucao" (categoria devolucao) APENAS
    //    quando ainda há itens na venda — registra a saída de caixa pra
    //    auditoria do refund parcial. Quando é o último item, a venda
    //    inteira foi cancelada e a tx de receita removida; criar mirror aqui
    //    duplicaria a baixa.
    if (!isLastItem) {
      const refundDesc = 'Devolucao: ' + itemName + ' (qty ' + itemQty + ')';
      await client.query(
        `INSERT INTO transactions (
           company_id, type, status, amount, description, category, due_date,
           paid_at, idempotency_key, created_at, updated_at, created_by
         ) VALUES (
           $1, 'expense', 'confirmed', $2, $3, 'devolucao',
           (NOW() AT TIME ZONE 'America/Sao_Paulo')::date,
           NOW(), $4, NOW(), NOW(), $5
         )`,
        [
          companyId,
          itemTotal,
          refundDesc,
          'refund-' + saleId + '-' + itemId,
          req.user?.id || null,
        ]
      );
    }

    await client.query('COMMIT');
    res.json({
      ok: true,
      removed_item: { id: itemId, name: itemName, quantity: itemQty, refund_amount: itemTotal },
      new_sale_total: newTotal,
      new_tx_amount: txRemoved ? 0 : Math.max(0, newTxAmount),
      tx_removed: txRemoved,
      sale_cancelled: isLastItem,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// PATCH /transactions/:tx_id/seller
// Body: { employee_id: string | null, employee_name?: string }
// Atualiza vendedora na transaction E na sale vinculada (se houver).
//
// NOTA (24/04): sales tem duas colunas pra vendedor com semantica diferente:
//   - sales.employee_id  -> FK employees.id  (funcionaria atribuida, p/ comissao)
//   - sales.seller_id    -> FK users.id      (usuario com login que CRIOU a venda)
// Aqui so mexemos em employee_id + seller_name. O seller_id original (quem
// processou no caixa) fica intacto. Setar seller_id = employee.id viola FK
// quando a funcionaria nao e um usuario do sistema — que e o caso normal.
router.patch('/transactions/:tx_id/seller', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const txId = req.params.tx_id;
  const { employee_id, employee_name } = req.body || {};

  // Valida funcionario (se nao for null)
  let resolvedName = employee_name || null;
  if (employee_id) {
    const empRes = await pool.query(
      'SELECT id, name FROM employees WHERE id = $1 AND company_id = $2',
      [employee_id, companyId]
    );
    if (!empRes.rows.length) throw new AppError('Funcionario nao encontrado', 404);
    resolvedName = empRes.rows[0].name;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const txRes = await client.query(
      `UPDATE transactions
       SET employee_id = $1, employee_name = $2, updated_at = NOW()
       WHERE id = $3 AND company_id = $4
       RETURNING id, idempotency_key, employee_id, employee_name`,
      [employee_id || null, resolvedName, txId, companyId]
    );
    if (!txRes.rows.length) throw new AppError('Lancamento nao encontrado', 404);

    // Sincroniza com a venda se vinculada.
    // NAO mexer em seller_id — FK aponta pra users, nao employees.
    const saleId = extractSaleId(txRes.rows[0].idempotency_key);
    if (saleId) {
      await client.query(
        `UPDATE sales
         SET employee_id = $1, seller_name = $2, updated_at = NOW()
         WHERE id = $3 AND company_id = $4`,
        [employee_id || null, resolvedName, saleId, companyId]
      );
    }

    await client.query('COMMIT');
    res.json({
      ok: true,
      transaction: txRes.rows[0],
      synced_to_sale: !!saleId,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

module.exports = router;
