// ============================================================
// AURA. — Conta a receber e sinal do pedido do balcao (B4a / p-62a, 17/11/2026)
//
// A regra do sinal, decidida pelo Caio em 17/11 (D-S1 opcao A, com os dois
// ajustes da Celia):
//
//   1. Pedido guardado gera uma conta a receber pelo VALOR CHEIO:
//      transactions income 'pending', categoria "Pedido a receber", chave
//      pedido-areceber-<pedido>, ligada em digital_orders.transaction_id.
//      NAO e faturamento: o Faturamento (resultadoDoPeriodo.js) so le vendas,
//      e a venda so nasce na conclusao (B5a), pelo valor cheio.
//   2. O sinal e a BAIXA PARCIAL dessa conta:
//      - a conta cai para o saldo (amount = saldo; original_amount = valor
//        cheio, a convencao da 362). Sinal igual ao total quita a conta
//        (status 'cancelled', nota "quitada pelo sinal"): amount nao pode
//        ser 0 e nada mais falta receber;
//      - nasce a entrada 'confirmed' "Sinal de pedido" (chave
//        pedido-sinal-<pedido>), SEM venda. E dinheiro que entrou: aparece
//        na Receita do Painel no dia do sinal. No DRE, "Sinal de pedido" e
//        receita de vendas (routes/dre.js), nao Adiantamento;
//      - o marco do sinal: studio_payments kind 'deposit', status 'paid'
//        (a tabela nao tem vertical) e digital_orders.deposit_paid = TRUE;
//      - taxa da maquininha no cartao, no debito e no Pix com taxa: a MESMA
//        regra da venda (taxaDaMaquininha.js), chave pedido-sinal-taxa-<pedido>.
//   3. Na conclusao (B5a, fora daqui) a venda leva o valor cheio e o
//      pdv-sale leva so o saldo: o Painel soma sinal + saldo = valor cheio
//      uma vez so.
//
// Um sinal por pedido (fase 1). Repetir com a mesma Idempotency-Key devolve
// o sinal ja registrado; outro sinal no mesmo pedido e 409. O resto se paga
// na conclusao.
//
// O CAIXA (B4b / p-62b): o sinal em DINHEIRO, com o caixa ligado
// (pdv_settings.caixa_enabled), exige caixa aberto: 409 CAIXA_REQUIRED, o
// mesmo codigo da venda, e nada e gravado. Com o caixa aberto ele vira o
// movimento 'sinal_pedido' da sessao (migration 461), que o fechamento soma
// no dinheiro da gaveta (services/caixaService.js). Pix e cartao nao exigem
// caixa: o fechamento os le pela chave pedido-sinal-<pedido> na janela da
// sessao. Com a chave desligada vale a regra da venda: havendo sessao aberta,
// o dinheiro entra nela; sem sessao, so e registrado. Nada chama esta rota antes do app de
// 02/12 (trava PEDIDO_LIBERADO).
//
// Multi-CNPJ: tudo na company_id da loja do pedido (a do :id, conferida pelo
// requireCompanyAccess; o pedido e lido com company_id = $loja).
// ============================================================
'use strict';

const { insertCardFeeExpense } = require('./taxaDaMaquininha');

const CATEGORIA_A_RECEBER = 'Pedido a receber';
const CATEGORIA_SINAL = 'Sinal de pedido';
const CHAVE_A_RECEBER = (orderId) => `pedido-areceber-${orderId}`;
const CHAVE_SINAL = (orderId) => `pedido-sinal-${orderId}`;
const CHAVE_TAXA_SINAL = (orderId) => `pedido-sinal-taxa-${orderId}`;

const ABERTOS = ['confirmed', 'preparing', 'ready'];
const SP_DATE_NOW = "(NOW() AT TIME ZONE 'America/Sao_Paulo')::date";

// Forma do Caixa -> studio_payments.method (140) e base da taxa.
const FORMAS = {
  dinheiro: { method: 'cash', taxa: null, rotulo: 'dinheiro' },
  pix:      { method: 'pix',  taxa: 'pix', rotulo: 'Pix' },
  cartao:   { method: 'card', taxa: 'cartao', rotulo: 'cartão de crédito' },
  debito:   { method: 'card', taxa: 'debito', rotulo: 'cartão de débito' },
};
// Apelidos que o app ou outro cliente pode mandar.
const APELIDOS = { credito: 'cartao', cartao_credito: 'cartao', cartao_debito: 'debito', cash: 'dinheiro' };

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function erro(status, message, code, extra) {
  return Object.assign(new Error(message), { status, code, ...(extra || {}) });
}

function lerForma(raw) {
  const f = String(raw == null ? '' : raw).trim().toLowerCase();
  const forma = APELIDOS[f] || f;
  return FORMAS[forma] ? forma : null;
}

/**
 * Le o sinal do corpo, sem banco. `raw` = { amount, method } (ou valor/forma).
 * Devolve { dados: {valor, forma} }, { dados: null } (sem sinal) ou
 * { erro: {status, code, message} }. `total` e o total do pedido.
 */
function lerSinal(raw, total, { obrigatorio = false } = {}) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const bruto = b.amount ?? b.valor;
  if (bruto === undefined || bruto === null || bruto === '' || Number(bruto) === 0) {
    if (obrigatorio) return { erro: { status: 422, code: 'PEDIDO_SINAL_VALOR', message: 'Informe o valor do sinal.' } };
    return { dados: null };
  }
  const valor = Number(bruto);
  if (!Number.isFinite(valor) || valor < 0) {
    return { erro: { status: 422, code: 'PEDIDO_SINAL_VALOR', message: 'Valor do sinal inválido.' } };
  }
  const v = round2(valor);
  if (v > round2(total) + 0.004) {
    return {
      erro: {
        status: 422, code: 'PEDIDO_SINAL_MAIOR',
        message: `O sinal (R$ ${v.toFixed(2).replace('.', ',')}) passou do valor do pedido (R$ ${round2(total).toFixed(2).replace('.', ',')}).`,
      },
    };
  }
  const forma = lerForma(b.method ?? b.forma);
  if (!forma) {
    return { erro: { status: 422, code: 'PEDIDO_SINAL_FORMA', message: 'Escolha como a cliente pagou o sinal: dinheiro, Pix, crédito ou débito.' } };
  }
  return { dados: { valor: v, forma } };
}

function resumoDosItens(itens) {
  const nomes = (itens || []).map((i) => i && (i.nome || i.product_name)).filter(Boolean);
  const tres = nomes.slice(0, 3).join(', ');
  return nomes.length > 3 ? `${tres} e mais ${nomes.length - 3}` : tres;
}

/**
 * Conta a receber do pedido, pelo valor cheio. Dentro da transacao de quem
 * chama. Idempotente pela chave (ON CONFLICT DO NOTHING): chamar de novo nao
 * duplica. Pedido de valor 0 nao tem conta (transactions.amount > 0).
 * Devolve o id do lancamento (ou null).
 */
async function criarContaAReceber(client, { companyId, pedido, itens, userId }) {
  const total = round2(pedido.total);
  if (!(total > 0)) return null;
  const resumo = resumoDosItens(itens);
  const descricao = `Pedido ${pedido.order_number} a receber${resumo ? ` - ${resumo}` : ''}`.slice(0, 500);
  const vencimento = pedido.promised_date ? '$5::date' : SP_DATE_NOW;
  const params = [companyId, total, descricao, userId || null];
  if (pedido.promised_date) params.push(pedido.promised_date);
  params.push(CHAVE_A_RECEBER(pedido.id));
  const pChave = `$${params.length}`;
  await client.query(
    `INSERT INTO transactions
       (company_id, type, status, amount, description, category, due_date, created_by, idempotency_key)
     VALUES ($1, 'income', 'pending', $2, $3, '${CATEGORIA_A_RECEBER}', ${vencimento}, $4, ${pChave})
     ON CONFLICT (idempotency_key) DO NOTHING`,
    params
  );
  const { rows } = await client.query(
    `SELECT id FROM transactions WHERE idempotency_key = $1 AND company_id = $2`,
    [CHAVE_A_RECEBER(pedido.id), companyId]
  );
  const txId = rows[0] ? rows[0].id : null;
  if (txId) {
    await client.query(
      `UPDATE digital_orders SET transaction_id = $1 WHERE id = $2 AND company_id = $3 AND transaction_id IS NULL`,
      [txId, pedido.id, companyId]
    );
  }
  return txId;
}

/** Sinal ja pago do pedido (o de studio_payments), ou null. */
async function lerSinalPago(q, orderId) {
  const { rows } = await q.query(
    `SELECT id, amount, forma, method, idempotency_key, paid_at
       FROM studio_payments
      WHERE order_id = $1 AND kind = 'deposit' AND status = 'paid'
      ORDER BY paid_at NULLS LAST, created_at
      LIMIT 1`,
    [orderId]
  );
  return rows[0] || null;
}

function apresentarSinal(sp) {
  if (!sp) return null;
  const forma = sp.forma || ({ cash: 'dinheiro', pix: 'pix', card: 'cartao' }[sp.method] || null);
  return {
    valor: Number(sp.amount),
    forma,
    forma_rotulo: forma && FORMAS[forma] ? FORMAS[forma].rotulo : null,
    pago_em: sp.paid_at || null,
  };
}

/**
 * B4b: a sessao de caixa que recebe o sinal em dinheiro. A MESMA regra da
 * venda (routes/pdv.js): a sessao aberta da loja recebe o dinheiro mesmo com
 * a chave caixa_enabled desligada (a venda grava sale_payments.sessao_id
 * assim); a chave so decide se a falta de sessao e 409.
 *   { ligado, sessaoId }: ligado = caixa_enabled; sessaoId = a aberta ou null.
 *   Ligado e sem sessao: quem chama responde 409. Desligado e sem sessao: o
 *   sinal so e registrado (nao ha gaveta).
 * Sem o "fail-open" da venda: um erro de banco derruba o sinal (nada e
 * gravado) em vez de deixar o dinheiro fora da gaveta.
 */
async function sessaoDoCaixa(client, companyId) {
  const { rows } = await client.query(
    `SELECT c.pdv_settings,
            (SELECT s.id FROM caixa_sessoes s WHERE s.company_id = c.id AND s.status = 'aberta' LIMIT 1) AS sessao_id
       FROM companies c WHERE c.id = $1`,
    [companyId]
  );
  const r = rows[0] || {};
  return { ligado: !!(r.pdv_settings && r.pdv_settings.caixa_enabled), sessaoId: r.sessao_id || null };
}

/**
 * Registra o sinal num pedido JA TRAVADO (SELECT ... FOR UPDATE) pela
 * transacao de quem chama. `pedido` = linha de digital_orders (id,
 * order_number, total, promised_date). Nao confere situacao nem sinal
 * anterior: quem chama confere.
 */
async function registrarSinal(client, { companyId, pedido, itens, valor, forma, chave, userId }) {
  const total = round2(pedido.total);
  const v = round2(valor);
  if (!(v > 0) || v > total + 0.004) {
    throw erro(422, 'O sinal passou do valor do pedido.', 'PEDIDO_SINAL_MAIOR');
  }
  const f = FORMAS[forma];
  if (!f) throw erro(422, 'Forma do sinal inválida.', 'PEDIDO_SINAL_FORMA');
  const resumo = resumoDosItens(itens);

  // 0. B4b: sinal em dinheiro com o caixa ligado exige caixa aberto (409 da
  //    venda), antes de gravar qualquer coisa.
  let sessaoId = null;
  if (forma === 'dinheiro') {
    const caixa = await sessaoDoCaixa(client, companyId);
    if (caixa.ligado && !caixa.sessaoId) {
      throw erro(409, 'Abra o caixa antes de receber o sinal em dinheiro.', 'CAIXA_REQUIRED');
    }
    sessaoId = caixa.sessaoId;
  }

  // 1. O marco do sinal.
  const { rows: [marco] } = await client.query(
    `INSERT INTO studio_payments (company_id, order_id, kind, amount, status, method, forma, paid_at, idempotency_key)
     VALUES ($1, $2, 'deposit', $3, 'paid', $4, $5, NOW(), $6)
     RETURNING paid_at`,
    [companyId, pedido.id, v, f.method, forma, chave || null]
  );

  // 2. A entrada do dinheiro, sem venda.
  const descricao = `Sinal do pedido ${pedido.order_number}${resumo ? ` - ${resumo}` : ''} (${f.rotulo})`.slice(0, 500);
  await client.query(
    `INSERT INTO transactions
       (company_id, type, status, amount, description, category, due_date, paid_at, created_by, idempotency_key)
     VALUES ($1, 'income', 'confirmed', $2, $3, '${CATEGORIA_SINAL}', ${SP_DATE_NOW}, NOW(), $4, $5)`,
    [companyId, v, descricao, userId || null, CHAVE_SINAL(pedido.id)]
  );

  // 2b. B4b: o dinheiro do sinal entra na gaveta da sessao aberta.
  if (sessaoId) {
    await client.query(
      `INSERT INTO caixa_movimentos (company_id, sessao_id, tipo, valor, motivo, created_by)
       VALUES ($1, $2, 'sinal_pedido', $3, $4, $5)`,
      [companyId, sessaoId, v, `Sinal do pedido ${pedido.order_number}`.slice(0, 200), userId || null]
    );
  }

  // 3. Baixa parcial da conta a receber. Pedido guardado antes deste card
  //    (sem conta) ganha a conta agora, pelo valor cheio, e baixa em seguida.
  await criarContaAReceber(client, { companyId, pedido, itens, userId });
  const saldo = round2(total - v);
  if (saldo > 0) {
    await client.query(
      `UPDATE transactions
          SET amount = $1, original_amount = $2, updated_at = NOW()
        WHERE idempotency_key = $3 AND company_id = $4 AND status = 'pending'`,
      [saldo, total, CHAVE_A_RECEBER(pedido.id), companyId]
    );
  } else {
    await client.query(
      `UPDATE transactions
          SET status = 'cancelled',
              notes = CASE WHEN COALESCE(notes, '') = '' THEN $1 ELSE notes || ' · ' || $1 END,
              updated_at = NOW()
        WHERE idempotency_key = $2 AND company_id = $3 AND status = 'pending'`,
      ['Quitada pelo sinal do pedido', CHAVE_A_RECEBER(pedido.id), companyId]
    );
  }

  // 4. O pedido sabe que o sinal foi pago.
  await client.query(
    `UPDATE digital_orders SET deposit_paid = TRUE, updated_at = NOW() WHERE id = $1 AND company_id = $2`,
    [pedido.id, companyId]
  );

  // 5. Taxa da maquininha (D-S1): mesma regra e mesmas aliquotas da venda.
  let taxa = null;
  if (f.taxa) {
    taxa = await insertCardFeeExpense(client, {
      companyId,
      saleId: null,
      chave: CHAVE_TAXA_SINAL(pedido.id),
      cardBase: { [f.taxa]: v },
      createdBy: userId || null,
      itemsSummary: `Sinal do pedido ${pedido.order_number}`,
    });
  }
  return { valor: v, forma, saldo, taxa, pago_em: marco ? marco.paid_at : null, movimento_caixa: !!sessaoId };
}

/**
 * POST /pedidos/:oid/sinal. Devolve { status: 201|200, repetido, sinal }.
 * Lanca erro com .status para a rota responder.
 */
async function receberSinal(db, { companyId, orderId, body, chave, userId }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, order_number, origem, status::text AS status, total, promised_date::text AS promised_date
         FROM digital_orders WHERE id = $1 AND company_id = $2
         FOR UPDATE`,
      [orderId, companyId]
    );
    const pedido = rows[0];
    if (!pedido || pedido.origem !== 'balcao') throw erro(404, 'Pedido não encontrado.', 'PEDIDO_NAO_ENCONTRADO');

    const ja = await lerSinalPago(client, orderId);
    if (ja) {
      await client.query('ROLLBACK');
      if (chave && ja.idempotency_key === chave) return { status: 200, repetido: true, sinal: apresentarSinal(ja) };
      throw erro(409,
        `Este pedido já tem sinal de R$ ${Number(ja.amount).toFixed(2).replace('.', ',')}. O que falta se paga na conclusão, no Caixa.`,
        'PEDIDO_SINAL_JA_PAGO');
    }
    if (!ABERTOS.includes(pedido.status)) {
      throw erro(409,
        pedido.status === 'cancelled' ? 'Este pedido foi cancelado.' : 'Este pedido já foi concluído.',
        'PEDIDO_FECHADO', { status_atual: pedido.status });
    }

    const lido = lerSinal(body, pedido.total, { obrigatorio: true });
    if (lido.erro) throw erro(lido.erro.status, lido.erro.message, lido.erro.code);

    const { rows: itens } = await client.query(
      `SELECT product_name FROM digital_order_items WHERE order_id = $1 ORDER BY id`, [orderId]);
    const r = await registrarSinal(client, {
      companyId, pedido, itens, valor: lido.dados.valor, forma: lido.dados.forma, chave, userId,
    });
    await client.query('COMMIT');
    return {
      status: 201,
      repetido: false,
      sinal: { valor: r.valor, forma: r.forma, forma_rotulo: FORMAS[r.forma].rotulo, pago_em: r.pago_em },
      taxa: r.taxa ? r.taxa.fee : 0,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    // A mesma chave usada em OUTRO pedido da loja (indice unico da 460).
    if (e && e.code === '23505' && /idempotency_key/.test(String(e.constraint || ''))) {
      throw erro(409, 'Essa tentativa já registrou um sinal em outro pedido. Toque de novo para registrar este.', 'IDEMPOTENCY_KEY_REUSED');
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Acrescenta ao pedido apresentado (pedidoBalcao.apresentarPedido) o sinal
 * pago, o que falta e a forma do sinal. `sinal_pago` e a soma dos sinais
 * pagos, a mesma conta da lista (listaDePedidos.js).
 */
async function comSinal(q, pedido) {
  if (!pedido) return pedido;
  const { rows } = await q.query(
    `SELECT COALESCE(SUM(amount), 0) AS v FROM studio_payments
      WHERE order_id = $1 AND kind = 'deposit' AND status = 'paid'`, [pedido.id]);
  const pago = round2(Number(rows[0] && rows[0].v) || 0);
  pedido.sinal_pago = pago;
  pedido.falta = round2(Math.max(Number(pedido.total) - pago, 0));
  pedido.sinal = pago > 0 ? apresentarSinal(await lerSinalPago(q, pedido.id)) : null;
  return pedido;
}

module.exports = {
  comSinal,
  CATEGORIA_A_RECEBER,
  CATEGORIA_SINAL,
  CHAVE_A_RECEBER,
  CHAVE_SINAL,
  CHAVE_TAXA_SINAL,
  FORMAS,
  lerForma,
  lerSinal,
  criarContaAReceber,
  registrarSinal,
  receberSinal,
  lerSinalPago,
  apresentarSinal,
  sessaoDoCaixa,
  resumoDosItens,
};
