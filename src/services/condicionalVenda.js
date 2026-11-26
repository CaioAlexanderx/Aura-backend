// ============================================================
// AURA. — Venda condicional: cobrar no Caixa (C11, 26/11/2026)
//
// POST /companies/:id/pdv/sale aceita, alem do corpo de sempre:
//   condicional_id        uuid da condicional (migration 467)
//   condicional_item_ids  [uuid] os itens que a venda cobra (um por peca)
// Sem condicional_id a venda e EXATAMENTE a de hoje: nada daqui roda.
//
// Na MESMA transacao da venda (routes/pdv.js, handleSale):
//   1. travar(): trava a condicional (FOR UPDATE) e depois TODOS os itens
//      dela (ORDER BY id, FOR UPDATE) - a ordem do contrato do C9, a mesma
//      de services/condicionalDecidir.js. Recusa 409 se a condicional nao
//      esta aberta (COND_FECHADA), se um item nao e dela (COND_ITEM_INVALIDO),
//      se ja foi cobrado ("Estas pecas ja foram cobradas na venda #N",
//      COND_JA_COBRADA, com venda_numero), se nao esta com_cliente/ficou
//      (COND_ITEM_SITUACAO) ou se o carrinho nao e o das pecas (422
//      COND_CARRINHO_DIFERENTE: produto/variante e quantidade, somados por
//      produto+variante).
//   2. a venda sai como sempre (estoque baixa UMA vez, pelo fluxo normal:
//      a condicional nunca baixou estoque). O preco e o que o carrinho
//      manda; o Caixa abre com o unit_price do item (decisao 1) e quem tem
//      permissao pode ajustar, como em qualquer venda.
//   3. gravar(): sales.condicional_id; cada item vira situacao='ficou' com
//      sale_id (decided_at/decided_by so se vazios); evento 'venda' por
//      item; a condicional encerra pela regra podeEncerrar (nenhuma peca
//      com_cliente ou 'ficou' sem venda) com o evento 'encerrada'
//      {motivo:'venda', com_venda:true}.
//
// Idempotencia: a Idempotency-Key da venda (mecanismo do pdv) devolve a
// mesma venda antes de chegar aqui. Outro aparelho com outra chave cobrando
// as mesmas pecas espera a trava da condicional, ve o sale_id e recebe 409
// com o numero da venda.
//
// Cancelar a venda (DELETE /pdv/sale/:id, POST /sales/:id/cancel e o caminho
// que cancela ao remover o ultimo item): voltarAoCancelar() solta o sale_id
// das pecas (continuam 'ficou', fora da loja, "Falta cobrar") e, se a
// condicional estava encerrada, reabre (evento 'reaberta'). Evento
// 'venda_cancelada' por peca (migration 469). Remover so um item de uma
// venda de varios NAO solta a peca: ela segue cobrada.
//
// Nada entra em Financeiro/caixa antes da venda (R1/R9): so isto, na venda.
// ============================================================
'use strict';

const { podeEncerrar } = require('./condicionalDecidir');
const { MAX_PECAS } = require('./condicional');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function falha(status, message, code, extra) {
  return Object.assign(new Error(message), { statusCode: status, code, extra: extra || undefined });
}

/** null = venda comum. { condId, itemIds } ou { erro: {status, code, message} }. */
function lerPedido(body) {
  const b = body || {};
  const bruto = b.condicional_id;
  if (bruto === undefined || bruto === null || bruto === '') return null;
  const condId = String(bruto).toLowerCase();
  if (!UUID_RE.test(condId)) {
    return { erro: { status: 422, code: 'COND_NAO_ENCONTRADA', message: 'Condicional não encontrada.' } };
  }
  const ids = b.condicional_item_ids;
  if (!Array.isArray(ids) || !ids.length) {
    return { erro: { status: 422, code: 'COND_ITENS_OBRIGATORIOS', message: 'Diga quais peças da condicional esta venda cobra.' } };
  }
  const itemIds = ids.map((x) => String(x).toLowerCase());
  if (itemIds.length > MAX_PECAS || itemIds.some((x) => !UUID_RE.test(x)) || new Set(itemIds).size !== itemIds.length) {
    return { erro: { status: 422, code: 'COND_ITENS_INVALIDOS', message: 'Peças da condicional inválidas.' } };
  }
  return { condId, itemIds };
}

const chaveDe = (pid, vid) => `${pid || ''}|${vid || ''}`;

function somar(lista) {
  const m = new Map();
  for (const x of lista) m.set(x.k, (m.get(x.k) || 0) + x.q);
  return m;
}

/** Itens do carrinho x pecas, somados por produto+variante. Linha sem produto nunca casa. */
function carrinhoConfere(items, escolhidos) {
  const doCarrinho = somar((items || []).map((i) => ({
    k: i && i.product_id ? chaveDe(i.product_id, i.variant_id) : 'sem-produto',
    q: Number(i && i.quantity),
  })));
  const dasPecas = somar(escolhidos.map((i) => ({ k: chaveDe(i.product_id, i.variant_id), q: 1 })));
  if (doCarrinho.size !== dasPecas.size) return false;
  for (const [k, q] of dasPecas) if (doCarrinho.get(k) !== q) return false;
  return true;
}

/** Dentro da transacao da venda, ANTES de gravar. Lanca erro (statusCode/code) para o 4xx. */
async function travar(client, { companyId, pedido, items }) {
  const { rows: [cond] } = await client.query(
    `SELECT id, numero, status FROM condicionais WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [pedido.condId, companyId]
  );
  if (!cond) throw falha(404, 'Condicional não encontrada.', 'COND_NAO_ENCONTRADA');
  const { rows: todos } = await client.query(
    `SELECT id, product_id, variant_id, situacao, sale_id, decided_at, decided_by
       FROM condicional_itens WHERE condicional_id = $1 ORDER BY id FOR UPDATE`,
    [cond.id]
  );
  const porId = new Map(todos.map((i) => [String(i.id).toLowerCase(), i]));
  const escolhidos = [];
  for (const id of pedido.itemIds) {
    const it = porId.get(id);
    if (!it) throw falha(409, 'Alguma das peças não é desta condicional.', 'COND_ITEM_INVALIDO');
    escolhidos.push(it);
  }
  const cobrada = escolhidos.find((i) => i.sale_id);
  if (cobrada) {
    const { rows: [v] } = await client.query(
      `SELECT sale_number FROM sales WHERE id = $1 AND company_id = $2`, [cobrada.sale_id, companyId]
    );
    const numero = v && v.sale_number != null ? Number(v.sale_number) : null;
    throw falha(409,
      numero != null ? `Estas peças já foram cobradas na venda #${numero}.` : 'Estas peças já foram cobradas em outra venda.',
      'COND_JA_COBRADA', { venda_numero: numero, sale_id: cobrada.sale_id });
  }
  if (cond.status !== 'aberta') {
    throw falha(409, cond.status === 'cancelada'
      ? 'Esta condicional foi cancelada e não muda mais.'
      : 'Esta condicional já foi concluída e não muda mais.', 'COND_FECHADA');
  }
  if (escolhidos.some((i) => i.situacao !== 'com_cliente' && i.situacao !== 'ficou')) {
    throw falha(409, 'Só dá para cobrar peça que está com a cliente ou que ficou.', 'COND_ITEM_SITUACAO');
  }
  if (!carrinhoConfere(items, escolhidos)) {
    throw falha(422, 'O carrinho não é o das peças da condicional.', 'COND_CARRINHO_DIFERENTE');
  }
  return { cond, todos, escolhidos };
}

/** Dentro da transacao, depois do INSERT da venda. Devolve o resumo para a resposta. */
async function gravar(client, { companyId, userId, sale, ctx }) {
  const { cond, todos, escolhidos } = ctx;
  const ids = escolhidos.map((i) => i.id);
  await client.query(`UPDATE sales SET condicional_id = $1 WHERE id = $2 AND company_id = $3`, [cond.id, sale.id, companyId]);
  sale.condicional_id = cond.id;
  await client.query(
    `UPDATE condicional_itens
        SET situacao = 'ficou', sale_id = $1,
            decided_at = COALESCE(decided_at, NOW()), decided_by = COALESCE(decided_by, $2)
      WHERE id = ANY($3::uuid[])`,
    [sale.id, userId || null, ids]
  );
  for (const it of escolhidos) {
    await client.query(
      `INSERT INTO condicional_eventos (condicional_id, company_id, tipo, item_id, dados, user_id, created_at)
       VALUES ($1, $2, 'venda', $3, $4::jsonb, $5, clock_timestamp())`,
      [cond.id, companyId, it.id, JSON.stringify({
        op: 'cobrar_no_caixa', sale_id: sale.id, sale_number: sale.sale_number != null ? Number(sale.sale_number) : null,
        situacao_anterior: it.situacao,
      }), userId || null]
    );
  }
  const depois = todos.map((i) => (ids.includes(i.id) ? { ...i, situacao: 'ficou', sale_id: sale.id } : i));
  let encerrada = false;
  if (podeEncerrar(depois)) {
    await client.query(
      `UPDATE condicionais SET status = 'encerrada', closed_at = NOW(), updated_at = NOW() WHERE id = $1`, [cond.id]
    );
    await client.query(
      `INSERT INTO condicional_eventos (condicional_id, company_id, tipo, dados, user_id, created_at)
       VALUES ($1, $2, 'encerrada', $3::jsonb, $4, clock_timestamp())`,
      [cond.id, companyId, JSON.stringify({ op: 'cobrar_no_caixa', motivo: 'venda', com_venda: true, sale_id: sale.id }), userId || null]
    );
    encerrada = true;
  } else {
    await client.query(`UPDATE condicionais SET updated_at = NOW() WHERE id = $1`, [cond.id]);
  }
  return { id: cond.id, numero: Number(cond.numero), itens: ids.length, encerrada };
}

/**
 * Venda cancelada: as pecas dela voltam a 'ficou' sem sale_id e a condicional
 * reabre se estava encerrada. Venda comum: uma consulta e nada mais.
 */
async function voltarAoCancelar(client, { companyId, saleId, userId }) {
  const { rows: ligados } = await client.query(
    `SELECT DISTINCT ci.condicional_id FROM condicional_itens ci
       JOIN condicionais c ON c.id = ci.condicional_id
      WHERE ci.sale_id = $1 AND c.company_id = $2`,
    [saleId, companyId]
  );
  if (!ligados.length) return null;
  const condId = ligados[0].condicional_id;
  const { rows: [cond] } = await client.query(
    `SELECT id, status FROM condicionais WHERE id = $1 AND company_id = $2 FOR UPDATE`, [condId, companyId]
  );
  if (!cond) return null;
  const { rows: itens } = await client.query(
    `SELECT id, sale_id FROM condicional_itens WHERE condicional_id = $1 ORDER BY id FOR UPDATE`, [condId]
  );
  const soltos = itens.filter((i) => String(i.sale_id) === String(saleId));
  if (!soltos.length) return null;
  await client.query(
    `UPDATE condicional_itens SET sale_id = NULL WHERE condicional_id = $1 AND sale_id = $2`, [condId, saleId]
  );
  for (const it of soltos) {
    await client.query(
      `INSERT INTO condicional_eventos (condicional_id, company_id, tipo, item_id, dados, user_id, created_at)
       VALUES ($1, $2, 'venda_cancelada', $3, $4::jsonb, $5, clock_timestamp())`,
      [condId, companyId, it.id, JSON.stringify({ op: 'cancelar_venda', sale_id: saleId }), userId || null]
    );
  }
  let reabriu = false;
  if (cond.status === 'encerrada') {
    await client.query(
      `UPDATE condicionais SET status = 'aberta', closed_at = NULL, updated_at = NOW() WHERE id = $1`, [condId]
    );
    await client.query(
      `INSERT INTO condicional_eventos (condicional_id, company_id, tipo, dados, user_id, created_at)
       VALUES ($1, $2, 'reaberta', $3::jsonb, $4, clock_timestamp())`,
      [condId, companyId, JSON.stringify({ op: 'cancelar_venda', motivo: 'venda_cancelada', sale_id: saleId }), userId || null]
    );
    reabriu = true;
  } else {
    await client.query(`UPDATE condicionais SET updated_at = NOW() WHERE id = $1`, [condId]);
  }
  return { condicional_id: condId, pecas: soltos.length, reabriu };
}

module.exports = { lerPedido, travar, gravar, voltarAoCancelar, carrinhoConfere };
