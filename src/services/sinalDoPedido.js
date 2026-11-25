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
// O CAIXA (sessao, dinheiro esperado) e do card B4b: aqui o sinal em
// dinheiro so e registrado. O fechamento ainda nao le o sinal (fica em
// "outras entradas" ate o B4b), e nada chama esta rota antes do app de 02/12.
//
// Multi-CNPJ: tudo na company_id da loja do pedido (a do :id, conferida pelo
// requireCompanyAccess; o pedido e lido com company_id = $loja).
//
// p-185 (25/11/2026): o pedido de ORCAMENTO do Studio usa o mesmo caminho
// (services/financeiroDoOrcamento.js): a conta pelo valor cheio na aprovacao,
// o sinal pela mesma entrada, e o SALDO, que ali nao passa pelo Caixa, como
// a entrada 'confirmed' "Saldo de pedido" (chave pedido-saldo-<marco>), que
// abate a conta e a quita quando nada falta. Os passos 2 a 5 do sinal viraram lancarEntradaEBaixar, sem
// mudar o SQL nem a ordem do sinal do balcao.
// ============================================================
'use strict';

const { insertCardFeeExpense } = require('./taxaDaMaquininha');

const CATEGORIA_A_RECEBER = 'Pedido a receber';
const CATEGORIA_SINAL = 'Sinal de pedido';
const CHAVE_A_RECEBER = (orderId) => `pedido-areceber-${orderId}`;
const CHAVE_SINAL = (orderId) => `pedido-sinal-${orderId}`;
const CHAVE_TAXA_SINAL = (orderId) => `pedido-sinal-taxa-${orderId}`;
// p-185 (25/11/2026): o saldo do pedido de orcamento do Studio, recebido fora
// do Caixa ("Registrar Pix recebido"). Mesmo formato do sinal, mas a chave e
// a do MARCO de saldo (pedido-saldo-<marco>): o saldo pode vir em partes.
const CATEGORIA_SALDO = 'Saldo de pedido';
const CHAVE_SALDO = (orderId) => `pedido-saldo-${orderId}`;
const CHAVE_TAXA_SALDO = (orderId) => `pedido-saldo-taxa-${orderId}`;

const TIPOS = {
  sinal: { rotulo: 'Sinal', categoria: CATEGORIA_SINAL, chave: CHAVE_SINAL, chaveTaxa: CHAVE_TAXA_SINAL },
  saldo: { rotulo: 'Saldo', categoria: CATEGORIA_SALDO, chave: CHAVE_SALDO, chaveTaxa: CHAVE_TAXA_SALDO },
};

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
 * Baixa da conta a receber do pedido pelo que ja foi pago (`pago`, a soma).
 * A conta cai para o que falta (amount = falta; original_amount = valor
 * cheio). Nada faltando: 'cancelled' com a nota (amount nao pode ser 0).
 * Pedido sem conta (guardado antes do B4a, ou orcamento aprovado antes do
 * p-185) ganha a conta agora, pelo valor cheio, e baixa em seguida.
 */
async function baixarContaAReceber(client, { companyId, pedido, itens, userId, pago, nota }) {
  const total = round2(pedido.total);
  await criarContaAReceber(client, { companyId, pedido, itens, userId });
  const falta = round2(total - round2(pago));
  if (falta > 0) {
    await client.query(
      `UPDATE transactions
          SET amount = $1, original_amount = $2, updated_at = NOW()
        WHERE idempotency_key = $3 AND company_id = $4 AND status = 'pending'`,
      [falta, total, CHAVE_A_RECEBER(pedido.id), companyId]
    );
  } else {
    await client.query(
      `UPDATE transactions
          SET status = 'cancelled',
              notes = CASE WHEN COALESCE(notes, '') = '' THEN $1 ELSE notes || ' · ' || $1 END,
              updated_at = NOW()
        WHERE idempotency_key = $2 AND company_id = $3 AND status = 'pending'`,
      [nota, CHAVE_A_RECEBER(pedido.id), companyId]
    );
  }
  return Math.max(falta, 0);
}

/**
 * Abate `valor` da conta a receber pendente do pedido (p-185, orcamento).
 * A conta diz o que falta: amount cai para amount - valor e original_amount
 * guarda com quanto ela nasceu. Nada faltando: 'cancelled' com a nota.
 * Sem conta pendente: nada (devolve null). Dentro da transacao de quem chama,
 * com o pedido ja travado.
 */
async function abaterContaAReceber(client, { companyId, orderId, valor, nota }) {
  const { rows: [c] } = await client.query(
    `SELECT id, amount FROM transactions
      WHERE idempotency_key = $1 AND company_id = $2 AND status = 'pending'
      FOR UPDATE`,
    [CHAVE_A_RECEBER(orderId), companyId]
  );
  if (!c) return null;
  const falta = round2(Number(c.amount) - round2(valor));
  if (falta > 0) {
    await client.query(
      `UPDATE transactions
          SET amount = $1, original_amount = COALESCE(original_amount, $2), updated_at = NOW()
        WHERE id = $3 AND company_id = $4`,
      [falta, round2(c.amount), c.id, companyId]
    );
  } else {
    await client.query(
      `UPDATE transactions
          SET status = 'cancelled',
              notes = CASE WHEN COALESCE(notes, '') = '' THEN $1 ELSE notes || ' · ' || $1 END,
              updated_at = NOW()
        WHERE id = $2 AND company_id = $3`,
      [nota, c.id, companyId]
    );
  }
  return Math.max(falta, 0);
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

  // 1. O marco do sinal.
  const { rows: [marco] } = await client.query(
    `INSERT INTO studio_payments (company_id, order_id, kind, amount, status, method, forma, paid_at, idempotency_key)
     VALUES ($1, $2, 'deposit', $3, 'paid', $4, $5, NOW(), $6)
     RETURNING paid_at`,
    [companyId, pedido.id, v, f.method, forma, chave || null]
  );

  // 2. A entrada do dinheiro, sem venda. 3. Baixa parcial da conta a
  //    receber (sinal igual ao total quita: 'cancelled', com nota). 4. O
  //    pedido sabe que o sinal foi pago. 5. Taxa da maquininha. A mesma
  //    ordem e o mesmo SQL de antes: o p-185 so tirou os passos para uma
  //    funcao, para o orcamento lancar pelo mesmo caminho.
  const taxa = await lancarEntradaEBaixar(client, {
    companyId, pedido, itens, valor: v, forma, userId, tipo: 'sinal',
    pago: v, nota: 'Quitada pelo sinal do pedido',
  });
  const saldo = round2(total - v);
  return { valor: v, forma, saldo, taxa, pago_em: marco ? marco.paid_at : null };
}

/**
 * Passos 2 a 5 do sinal, na ordem de sempre: a entrada 'confirmed' do
 * dinheiro (sem venda), a baixa da conta a receber, deposit_paid (so no
 * sinal) e a taxa da maquininha pela regra da venda (D-S1). Dentro da
 * transacao de quem chama, com o pedido ja travado. Usado pelo sinal do
 * balcao e pelos marcos do orcamento (services/financeiroDoOrcamento.js).
 *   tipo 'sinal': "Sinal de pedido", chave pedido-sinal-<pedido>
 *   tipo 'saldo': "Saldo de pedido", chave pedido-saldo-<chaveId> (p-185: o
 *                 saldo do orcamento nao passa pelo Caixa)
 * A chave e unica em transactions: a mesma entrada nao entra duas vezes.
 * `pago` = soma ja paga contando esta; `nota` = a da conta quitada.
 * `abater` (orcamento, p-185): em vez de recalcular pelo total, abate `valor`
 * do que a conta diz que falta (abaterContaAReceber); a conta ja existe.
 * `chaveId`: o id da chave da entrada e da taxa (padrao: o pedido). O saldo
 * do orcamento usa o id do MARCO (pedido-saldo-<marco>): mais de um marco de
 * saldo por pedido, cada um com a sua entrada.
 * `semTaxa`: o Pix que caiu direto na chave da loja ("Registrar Pix
 * recebido", decisao do Caio 25/11) nao passa pela maquininha.
 * Devolve a taxa (ou null).
 */
async function lancarEntradaEBaixar(client, {
  companyId, pedido, itens, valor, forma, userId, tipo, pago, nota, semTaxa = false, abater = false, chaveId,
}) {
  const v = round2(valor);
  const t = TIPOS[tipo];
  const idDaChave = chaveId || pedido.id;
  const f = FORMAS[forma];
  const resumo = resumoDosItens(itens);
  const descricao = `${t.rotulo} do pedido ${pedido.order_number}${resumo ? ` - ${resumo}` : ''} (${f.rotulo})`.slice(0, 500);
  await client.query(
    `INSERT INTO transactions
       (company_id, type, status, amount, description, category, due_date, paid_at, created_by, idempotency_key)
     VALUES ($1, 'income', 'confirmed', $2, $3, '${t.categoria}', ${SP_DATE_NOW}, NOW(), $4, $5)`,
    [companyId, v, descricao, userId || null, t.chave(idDaChave)]
  );
  if (abater) await abaterContaAReceber(client, { companyId, orderId: pedido.id, valor: v, nota });
  else await baixarContaAReceber(client, { companyId, pedido, itens, userId, pago, nota });
  if (tipo === 'sinal') {
    await client.query(
      `UPDATE digital_orders SET deposit_paid = TRUE, updated_at = NOW() WHERE id = $1 AND company_id = $2`,
      [pedido.id, companyId]
    );
  }
  let taxa = null;
  if (f.taxa && !semTaxa) {
    taxa = await insertCardFeeExpense(client, {
      companyId,
      saleId: null,
      chave: t.chaveTaxa(idDaChave),
      cardBase: { [f.taxa]: v },
      createdBy: userId || null,
      itemsSummary: `${t.rotulo} do pedido ${pedido.order_number}`,
    });
  }
  return taxa;
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
  CATEGORIA_SALDO,
  CHAVE_SALDO,
  CHAVE_TAXA_SALDO,
  FORMAS,
  lerForma,
  lerSinal,
  criarContaAReceber,
  registrarSinal,
  lancarEntradaEBaixar,
  baixarContaAReceber,
  abaterContaAReceber,
  receberSinal,
  lerSinalPago,
  apresentarSinal,
  resumoDosItens,
};
