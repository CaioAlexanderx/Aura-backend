// ============================================================
// AURA. — O dinheiro do pedido de orcamento do Studio (p-185, 25/11/2026)
//
// Decisoes do Caio (D3 de 17/11 + 25/11), no MESMO formato do pedido
// guardado no Caixa (services/sinalDoPedido.js), sem regra nova de dinheiro:
//
//   1. APROVAR o orcamento (a lojista, no painel: /quotes/:qid/aprovar, e o
//      /convert do orcamento ja aceito, que tambem e ela quem toca) cria, na
//      MESMA transacao do pedido:
//        - a conta "Pedido a receber" pelo VALOR CHEIO (transactions income
//          'pending', chave pedido-areceber-<pedido>, ligada em
//          digital_orders.transaction_id): criarContaAReceber do sinal;
//        - o marco do SINAL (studio_payments kind 'deposit', 'pending'),
//          quando o orcamento tem sinal;
//        - o marco do SALDO (studio_payments kind 'balance', 'pending') pelo
//          valor cheio menos o sinal. Sinal 0: so o saldo, pelo total.
//      O aceite da cliente no link publico NAO lanca: so muda o status.
//   2. "Registrar Pix recebido" (POST /studio/payments/:pid/mark-paid) num
//      marco desse pedido lanca pelo caminho do sinal (lancarEntradaEBaixar):
//        - sinal: entrada 'confirmed' "Sinal de pedido" (pedido-sinal-<id>),
//          deposit_paid = TRUE;
//        - saldo: entrada 'confirmed' "Saldo de pedido" (pedido-saldo-<id>);
//        - nos dois a conta cai para o que falta; nada faltando, a conta vai
//          a 'cancelled' com a nota "Quitada pelo ...", como no sinal = total.
//      Pix sem taxa da maquininha (caiu na chave da loja); credito e debito,
//      se vierem, pela regra da venda (taxaDaMaquininha.js).
//   3. Cancelar o pedido (PATCH /orders/:oid/status 'cancelled') leva a conta
//      que ainda esta pendente e os marcos pendentes a 'cancelled'. O que ja
//      entrou fica: devolver e decisao da lojista, fora deste card.
//
// Nada disso e faturamento: o Faturamento (resultadoDoPeriodo.js) so le
// vendas, e o pedido de orcamento nao vira venda. A Receita do Painel e o DRE
// leem as entradas: sinal + saldo = valor cheio, uma vez so.
//
// Idempotencia: aprovar duas vezes nao chega aqui (o orcamento e travado com
// FOR UPDATE e o segundo toque devolve o pedido ja criado); a chave da conta
// e unica. Marcar pago: o pedido e o marco sao travados (FOR UPDATE), marco
// ja pago responde sem lancar, e cada entrada tem chave unica por pedido
// (um sinal e um saldo por pedido). A Idempotency-Key, quando vem, fica no
// marco (indice unico da 460): a mesma chave noutro marco da loja e 409.
//
// Multi-CNPJ: tudo pela company_id do pedido. O marco e o pedido sao lidos
// com company_id = loja do :id; marco de outra loja e 404.
//
// TRAVA (revisao de 25/11): nenhum lojista ve nada ate a virada (p-190), e o
// Studio de hoje segue em uso por loja real. Tudo acima so vale quando
// financeiroDoOrcamentoLigado(q, loja) e true: a empresa de teste
// (studio_settings.personalizados_teste, a mesma leitura do /auth/me) ou a
// env PERSONALIZADOS_FINANCEIRO_LIBERADO = 'true' (desligada por padrao; a
// virada liga). Desligada, aprovar, mark-paid, cancelar e a Producao fazem
// exatamente o que faziam antes.
// ============================================================
'use strict';

const sinalDoPedido = require('./sinalDoPedido');

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const brl = (n) => `R$ ${round2(n).toFixed(2).replace('.', ',')}`;

const NOTA = {
  sinal: 'Quitada pelo sinal do pedido',
  saldo: 'Quitada pelo saldo do pedido',
};

function erro(status, message, code, extra) {
  return Object.assign(new Error(message), { status, code, ...(extra || {}) });
}

/**
 * Forma do "Registrar Pix recebido". O app manda `method` no vocabulario do
 * Studio (pix/card/cash, migration 140); `forma` no do Caixa tambem vale.
 * Sem nada: Pix (e o nome do botao). 'card' = credito. 'other' nao tem
 * entrada certa no Financeiro: null (422).
 */
function lerFormaDoMarco(body) {
  const b = body && typeof body === 'object' ? body : {};
  const bruto = b.forma ?? b.method;
  if (bruto === undefined || bruto === null || String(bruto).trim() === '') return 'pix';
  const f = String(bruto).trim().toLowerCase();
  if (f === 'card') return 'cartao';
  return sinalDoPedido.lerForma(f);
}

/**
 * A trava da frente. true quando a env PERSONALIZADOS_FINANCEIRO_LIBERADO e
 * 'true' (a virada) ou quando a loja e de teste
 * (studio_settings->>'personalizados_teste' = 'true', como em routes/auth.js).
 * Loja sem linha: false.
 */
async function financeiroDoOrcamentoLigado(q, companyId) {
  if (process.env.PERSONALIZADOS_FINANCEIRO_LIBERADO === 'true') return true;
  const { rows } = await q.query(
    `SELECT (COALESCE(studio_settings->>'personalizados_teste', '') = 'true') AS ligado
       FROM companies WHERE id = $1`,
    [companyId]
  );
  return !!(rows[0] && rows[0].ligado);
}

/** O pedido saiu de um orcamento da mesma loja? */
async function ePedidoDeOrcamento(q, companyId, orderId) {
  const { rows } = await q.query(
    `SELECT 1 FROM studio_quotes WHERE order_id = $1 AND company_id = $2 LIMIT 1`,
    [orderId, companyId]
  );
  return rows.length > 0;
}

/**
 * Item 1: conta a receber + marcos do sinal e do saldo. Dentro da transacao
 * da aprovacao, logo depois do pedido e dos itens. `sinalCombinado` =
 * studio_quotes.deposit_amount (limitado ao total).
 */
async function lancarAprovacao(client, { companyId, orderId, sinalCombinado, userId }) {
  const { rows: [pedido] } = await client.query(
    `SELECT id, order_number, total, promised_date::text AS promised_date
       FROM digital_orders WHERE id = $1 AND company_id = $2`,
    [orderId, companyId]
  );
  const total = round2(pedido ? pedido.total : 0);
  if (!pedido || !(total > 0)) return { conta_id: null, sinal_id: null, saldo_id: null };

  const { rows: itens } = await client.query(
    `SELECT product_name FROM digital_order_items WHERE order_id = $1 ORDER BY id`, [orderId]);
  const contaId = await sinalDoPedido.criarContaAReceber(client, { companyId, pedido, itens, userId });

  const sinal = Math.min(round2(Math.max(Number(sinalCombinado) || 0, 0)), total);
  const saldo = round2(total - sinal);
  const marco = async (kind, amount) => {
    const { rows: [m] } = await client.query(
      `INSERT INTO studio_payments (company_id, order_id, kind, amount, status)
       VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
      [companyId, orderId, kind, amount]
    );
    return m.id;
  };
  const sinalId = sinal > 0 ? await marco('deposit', sinal) : null;
  const saldoId = saldo > 0 ? await marco('balance', saldo) : null;
  return { conta_id: contaId, sinal_id: sinalId, saldo_id: saldoId };
}

/**
 * Item 2: marca o marco como pago e lanca. Devolve
 * { repetido, payment, tipo, taxa, falta_receber }. Lanca erro com .status.
 * Quem chama ja sabe que o pedido e de orcamento (ePedidoDeOrcamento).
 */
async function receberMarco(db, { companyId, paymentId, body, chave, userId }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [ref] } = await client.query(
      `SELECT order_id FROM studio_payments WHERE id = $1 AND company_id = $2`, [paymentId, companyId]);
    if (!ref) throw erro(404, 'Pagamento não encontrado', 'PAGAMENTO_NAO_ENCONTRADO');

    // Trava o pedido antes do marco: sinal e saldo do mesmo pedido mexem na
    // mesma conta a receber e esperam um pelo outro.
    const { rows: [pedido] } = await client.query(
      `SELECT id, order_number, origem, status::text AS status, total, promised_date::text AS promised_date
         FROM digital_orders WHERE id = $1 AND company_id = $2
         FOR UPDATE`,
      [ref.order_id, companyId]
    );
    if (!pedido) throw erro(404, 'Pagamento não encontrado', 'PAGAMENTO_NAO_ENCONTRADO');
    if (pedido.origem === 'balcao') {
      throw erro(409, 'Este pedido foi guardado no Caixa. O sinal dele se registra pelo pedido, no Caixa.', 'PEDIDO_DO_BALCAO');
    }
    const { rows: [marco] } = await client.query(
      `SELECT * FROM studio_payments WHERE id = $1 AND company_id = $2 FOR UPDATE`, [paymentId, companyId]);

    if (marco.status === 'paid') {
      await client.query('ROLLBACK');
      return { repetido: true, payment: marco, tipo: marco.kind === 'deposit' ? 'sinal' : 'saldo', taxa: 0, falta_receber: null };
    }
    if (marco.status === 'cancelled') {
      throw erro(409, 'Este pagamento foi cancelado.', 'PAGAMENTO_CANCELADO');
    }
    if (pedido.status === 'cancelled') {
      throw erro(409, 'Este pedido foi cancelado.', 'PEDIDO_FECHADO', { status_atual: pedido.status });
    }

    const tipo = marco.kind === 'deposit' ? 'sinal' : 'saldo';
    const { rows: pagos } = await client.query(
      `SELECT kind, amount FROM studio_payments
        WHERE order_id = $1 AND company_id = $2 AND status = 'paid'`,
      [pedido.id, companyId]
    );
    // Um sinal e um saldo por pedido: a entrada de cada um tem chave unica.
    if (pagos.some((p) => (p.kind === 'deposit') === (tipo === 'sinal'))) {
      throw erro(409,
        tipo === 'sinal' ? 'O sinal deste pedido já foi recebido.' : 'O saldo deste pedido já foi recebido.',
        tipo === 'sinal' ? 'PEDIDO_SINAL_JA_PAGO' : 'PEDIDO_SALDO_JA_PAGO');
    }
    const valor = round2(marco.amount);
    const total = round2(pedido.total);
    const pagoAntes = round2(pagos.reduce((a, p) => a + Number(p.amount || 0), 0));
    if (!(valor > 0)) throw erro(422, 'Valor do pagamento inválido.', 'PEDIDO_PAGAMENTO_VALOR');
    if (pagoAntes + valor > total + 0.004) {
      throw erro(422,
        `Este pagamento (${brl(valor)}) passa do que falta receber do pedido (${brl(Math.max(total - pagoAntes, 0))}).`,
        'PEDIDO_PAGAMENTO_MAIOR');
    }
    const forma = lerFormaDoMarco(body);
    if (!forma) {
      throw erro(422, 'Escolha como a cliente pagou: Pix, dinheiro, crédito ou débito.', 'PEDIDO_SINAL_FORMA');
    }

    const { rows: itens } = await client.query(
      `SELECT product_name FROM digital_order_items WHERE order_id = $1 ORDER BY id`, [pedido.id]);
    const { rows: [pago] } = await client.query(
      `UPDATE studio_payments
          SET status = 'paid', paid_at = NOW(), method = $1, forma = $2,
              idempotency_key = COALESCE($3, idempotency_key), updated_at = NOW()
        WHERE id = $4 AND company_id = $5
        RETURNING *`,
      [sinalDoPedido.FORMAS[forma].method, forma, chave || null, paymentId, companyId]
    );
    const taxa = await sinalDoPedido.lancarEntradaEBaixar(client, {
      companyId, pedido, itens, valor, forma, userId, tipo,
      pago: pagoAntes + valor, nota: NOTA[tipo], semTaxa: forma === 'pix',
    });
    await client.query('COMMIT');
    return {
      repetido: false,
      payment: pago,
      tipo,
      taxa: taxa ? taxa.fee : 0,
      falta_receber: round2(Math.max(total - pagoAntes - valor, 0)),
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e && e.code === '23505') {
      // A mesma Idempotency-Key noutro marco da loja (indice da 460), ou a
      // entrada desse tipo ja lancada para o pedido (chave de transactions).
      throw erro(409, 'Esse pagamento já foi registrado. Atualize a tela para ver.', 'IDEMPOTENCY_KEY_REUSED');
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Item 3: pedido de orcamento cancelado. A conta ainda pendente e os marcos
 * pendentes vao a 'cancelled'. O que ja entrou fica. Nunca lanca.
 * Trava desligada: nada (como antes).
 */
async function fecharNoCancelamento(q, { companyId, orderId }) {
  try {
    if (!(await financeiroDoOrcamentoLigado(q, companyId))) return false;
    if (!(await ePedidoDeOrcamento(q, companyId, orderId))) return false;
    await q.query(
      `UPDATE transactions
          SET status = 'cancelled',
              notes = CASE WHEN COALESCE(notes, '') = '' THEN $1 ELSE notes || ' · ' || $1 END,
              updated_at = NOW()
        WHERE idempotency_key = $2 AND company_id = $3 AND status = 'pending'`,
      ['Pedido cancelado', sinalDoPedido.CHAVE_A_RECEBER(orderId), companyId]
    );
    await q.query(
      `UPDATE studio_payments SET status = 'cancelled', updated_at = NOW()
        WHERE order_id = $1 AND company_id = $2 AND status = 'pending'`,
      [orderId, companyId]
    );
    return true;
  } catch (e) {
    console.error('[financeiroDoOrcamento] cancelamento: a conta do pedido ficou pendente', orderId, e.message);
    return false;
  }
}

/**
 * Item 4: o que falta receber de cada pedido de orcamento, para a Producao
 * mostrar "Falta receber R$ X" ao entregar. Map(orderId -> campos).
 * Pedido que nao saiu de orcamento nao entra no mapa.
 *   orcamento_recebido             soma dos marcos pagos (sinal + saldo)
 *   orcamento_falta_receber        total do pedido menos o recebido (0 no
 *                                  pedido cancelado)
 *   orcamento_pagamentos_pendentes [{ id, kind, amount }] marcos pendentes,
 *                                  o id e o do mark-paid
 * Pedido aprovado antes do p-185 pode ter falta maior que a soma dos marcos
 * pendentes (nao tem o marco do saldo): o app cria o marco que falta pelo
 * POST /studio/orders/:oid/payments e marca pago.
 */
async function faltaReceberDosPedidos(q, companyId, orderIds) {
  const ids = [...new Set((orderIds || []).filter(Boolean).map(String))];
  const mapa = new Map();
  if (!ids.length) return mapa;
  const { rows } = await q.query(
    `SELECT o.id::text AS order_id, o.total::numeric AS total, o.status::text AS status,
            COALESCE((SELECT SUM(sp.amount) FROM studio_payments sp
                       WHERE sp.order_id = o.id AND sp.company_id = o.company_id AND sp.status = 'paid'), 0)::numeric AS recebido,
            COALESCE((SELECT json_agg(json_build_object('id', sp.id, 'kind', sp.kind, 'amount', sp.amount) ORDER BY sp.created_at)
                        FROM studio_payments sp
                       WHERE sp.order_id = o.id AND sp.company_id = o.company_id AND sp.status = 'pending'), '[]'::json) AS pendentes
       FROM digital_orders o
      WHERE o.company_id = $1
        AND o.id::text = ANY($2::text[])
        AND EXISTS (SELECT 1 FROM studio_quotes sq WHERE sq.order_id = o.id AND sq.company_id = o.company_id)`,
    [companyId, ids]
  );
  for (const r of rows) {
    const cancelado = r.status === 'cancelled';
    const recebido = round2(r.recebido);
    mapa.set(r.order_id, {
      orcamento_recebido: recebido,
      orcamento_falta_receber: cancelado ? 0 : round2(Math.max(Number(r.total) - recebido, 0)),
      orcamento_pagamentos_pendentes: cancelado ? [] : (r.pendentes || []).map((p) => ({
        id: p.id, kind: p.kind, amount: round2(p.amount),
      })),
    });
  }
  return mapa;
}

const NULL_FALTA = { orcamento_recebido: null, orcamento_falta_receber: null, orcamento_pagamentos_pendentes: null };

/**
 * Soma os campos do item 4 a cada pedido da lista. Nunca lanca.
 * Trava desligada: a lista volta como veio (sem os campos, como antes).
 */
async function comFaltaReceber(q, companyId, orders, idDoPedido) {
  try {
    if (!(await financeiroDoOrcamentoLigado(q, companyId))) return orders;
    const mapa = await faltaReceberDosPedidos(q, companyId, orders.map(idDoPedido));
    return orders.map((o) => {
      const id = idDoPedido(o);
      return { ...o, ...((id && mapa.get(String(id))) || NULL_FALTA) };
    });
  } catch (e) {
    console.error('[financeiroDoOrcamento] falta receber:', e.message);
    return orders.map((o) => ({ ...o, ...NULL_FALTA }));
  }
}

module.exports = {
  NOTA,
  NULL_FALTA,
  financeiroDoOrcamentoLigado,
  lerFormaDoMarco,
  ePedidoDeOrcamento,
  lancarAprovacao,
  receberMarco,
  fecharNoCancelamento,
  faltaReceberDosPedidos,
  comFaltaReceber,
};
