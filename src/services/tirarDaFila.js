// ============================================================
// AURA. — Tirar da Fila de producao (Personalizados, C1 do QA de 26/11/2026)
//
// Tirar um pedido da Fila NAO apaga venda nem dinheiro: so grava em
// studio_fila_tirados (migration 471) que o pedido saiu, e a listagem
// GET /studio/orders deixa de devolve-lo. Devolver a Fila apaga a marca.
//
// Regra do dinheiro: pedido DIGITAL (de orcamento ou da loja online) com
// valor recebido (marcos de sinal/saldo pagos, ou Pix da loja confirmado)
// NAO sai da Fila: o certo e o cancelamento do pedido (que fecha a conta e,
// na loja online, avisa a cliente). Resposta 409 TEM_RECEBIMENTO. Venda do
// Caixa (pdv) e pedido de marketplace nao entram nessa regra: a venda e o
// dinheiro seguem onde estao (Caixa/Financeiro), e sair da Fila nao muda isso.
//
// Multi-CNPJ: toda consulta confere company_id.
// ============================================================
'use strict';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const PAGAMENTO_ENTROU = ['confirmed', 'paid', 'received'];

// Cache da existencia da tabela (deploy parcial: sem a 471 a Fila segue como antes).
let _checadoEm = 0;
let _existe = null;
async function temTabela(q) {
  const agora = Date.now();
  if (_existe !== null && (agora - _checadoEm) < 60000) return _existe;
  try {
    const r = await q.query(`SELECT to_regclass('public.studio_fila_tirados') AS t`);
    _existe = !!(r.rows[0] && r.rows[0].t);
  } catch (e) {
    _existe = false;
  }
  _checadoEm = agora;
  return _existe;
}
function _zerarCache() { _checadoEm = 0; _existe = null; }

/** Trecho de WHERE: so os que NAO foram tirados (alias da view; '' = sem alias). */
function semOsTirados(alias) {
  const a = alias ? `${alias}.` : '';
  return ` AND NOT EXISTS (SELECT 1 FROM studio_fila_tirados ft WHERE ft.company_id = ${a}company_id AND ft.order_id = ${a}id)`;
}
/** Trecho de WHERE: so os que foram tirados. */
function soOsTirados(alias) {
  const a = alias ? `${alias}.` : '';
  return ` AND EXISTS (SELECT 1 FROM studio_fila_tirados ft WHERE ft.company_id = ${a}company_id AND ft.order_id = ${a}id)`;
}

/**
 * Quanto ja entrou neste pedido digital: marcos de sinal/saldo pagos; sem
 * marcos, Pix da loja confirmado vale o total.
 * @returns {Promise<number>}
 */
async function recebidoDoPedidoDigital(q, companyId, digitalOrderId) {
  const { rows } = await q.query(
    `SELECT o.total::numeric AS total, o.payment_status::text AS payment_status,
            COALESCE((SELECT SUM(sp.amount) FROM studio_payments sp
                       WHERE sp.order_id = o.id AND sp.company_id = o.company_id
                         AND sp.status = 'paid'), 0)::numeric AS marcos_pagos
       FROM digital_orders o
      WHERE o.id = $1 AND o.company_id = $2`,
    [digitalOrderId, companyId]
  );
  const r = rows[0];
  if (!r) return 0;
  const marcos = round2(r.marcos_pagos);
  if (marcos > 0) return marcos;
  if (PAGAMENTO_ENTROU.includes(String(r.payment_status || '').toLowerCase())) return round2(r.total);
  return 0;
}

function erro(status, code, message, extra) {
  return Object.assign(new Error(message), { status, code, ...(extra || {}) });
}

async function acharNaFila(q, companyId, orderId) {
  const { rows } = await q.query(
    `SELECT id, source, digital_order_id FROM studio_orders WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [orderId, companyId]
  );
  if (!rows.length) throw erro(404, 'PEDIDO_NAO_ENCONTRADO', 'Pedido não encontrado');
  return rows[0];
}

async function exigirTabela(q) {
  if (!(await temTabela(q))) {
    throw erro(409, 'FILA_INDISPONIVEL', 'Tirar da fila ainda não está disponível neste ambiente.');
  }
}

/**
 * Tira o pedido da Fila. Idempotente: tirar de novo devolve ja_estava = true.
 * Pedido digital: a conferencia do recebimento e o INSERT da marca rodam com o
 * pedido travado (FOR UPDATE), na ordem pedido -> marca, a mesma da confirmacao
 * do pagamento (que apaga a marca): um Pix confirmado no meio nao deixa o
 * pedido pago escondido.
 * @returns {Promise<{ok: true, order_id: string, tirado_em: any, ja_estava: boolean}>}
 */
async function tirarDaFila(q, { companyId, orderId, userId, motivo }) {
  await exigirTabela(q);
  const head = await acharNaFila(q, companyId, orderId);
  const texto = motivo == null ? '' : String(motivo).trim().slice(0, 200);
  const digital = head.source === 'digital';
  const c = digital ? await q.connect() : q;
  try {
    if (digital) {
      await c.query('BEGIN');
      await c.query(
        `SELECT id FROM digital_orders WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [head.digital_order_id, companyId]
      );
      const recebido = await recebidoDoPedidoDigital(c, companyId, head.digital_order_id);
      if (recebido > 0) {
        await c.query('ROLLBACK');
        throw erro(409, 'TEM_RECEBIMENTO',
          'Este pedido já tem valor recebido. Para tirá-lo da fila, cancele o pedido.',
          { recebido });
      }
    }
    const ins = await c.query(
      `INSERT INTO studio_fila_tirados (order_id, company_id, tirado_por, motivo)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (order_id) DO NOTHING
       RETURNING tirado_em`,
      [orderId, companyId, userId || null, texto || null]
    );
    let r;
    if (ins.rows.length) {
      r = { ok: true, order_id: orderId, tirado_em: ins.rows[0].tirado_em, ja_estava: false };
    } else {
      const { rows } = await c.query(
        `SELECT tirado_em FROM studio_fila_tirados WHERE order_id = $1 AND company_id = $2`,
        [orderId, companyId]
      );
      r = { ok: true, order_id: orderId, tirado_em: rows[0] ? rows[0].tirado_em : null, ja_estava: true };
    }
    if (digital) await c.query('COMMIT');
    return r;
  } catch (e) {
    if (digital && !e.status) await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (digital) c.release();
  }
}

/**
 * Pagamento confirmado: o pedido volta a Fila. Dentro da transacao de quem
 * confirma, com o pedido ja travado. Sem a migration 471, nao faz nada (e nao
 * aborta a transacao). Nunca lanca por causa da tabela ausente.
 */
async function devolverNaConfirmacao(client, order) {
  if (!order || !order.id || !order.company_id) return false;
  if (!(await temTabela(client))) return false;
  const r = await client.query(
    `DELETE FROM studio_fila_tirados WHERE order_id = $1 AND company_id = $2`,
    [order.id, order.company_id]
  );
  return (r.rowCount || 0) > 0;
}

/**
 * Devolve o pedido a Fila. Idempotente: se nao estava fora, ja_estava = true.
 * @returns {Promise<{ok: true, order_id: string, na_fila: true, ja_estava: boolean}>}
 */
async function devolverAFila(q, { companyId, orderId }) {
  await exigirTabela(q);
  await acharNaFila(q, companyId, orderId);
  const del = await q.query(
    `DELETE FROM studio_fila_tirados WHERE order_id = $1 AND company_id = $2 RETURNING order_id`,
    [orderId, companyId]
  );
  return { ok: true, order_id: orderId, na_fila: true, ja_estava: del.rows.length === 0 };
}

/**
 * Soma `fila_recebido` (numero) e `fila_tem_recebimento` (boolean) a cada
 * pedido da listagem, para o app decidir entre "Tirar da fila" e o
 * cancelamento sem tentar e tomar 409. Pedido do Caixa/marketplace: 0 e false.
 * Nunca lanca: falha deixa 0 / false (o endpoint ainda confere).
 */
async function comRecebimento(q, companyId, orders) {
  const base = (o) => ({ ...o, fila_recebido: 0, fila_tem_recebimento: false });
  try {
    const ids = [...new Set(orders.filter((o) => o.source === 'digital' && o.digital_order_id)
      .map((o) => String(o.digital_order_id)))];
    if (!ids.length) return orders.map(base);
    const { rows } = await q.query(
      `SELECT o.id::text AS id, o.total::numeric AS total, o.payment_status::text AS payment_status,
              COALESCE((SELECT SUM(sp.amount) FROM studio_payments sp
                         WHERE sp.order_id = o.id AND sp.company_id = o.company_id
                           AND sp.status = 'paid'), 0)::numeric AS marcos_pagos
         FROM digital_orders o
        WHERE o.company_id = $1 AND o.id::text = ANY($2::text[])`,
      [companyId, ids]
    );
    const mapa = new Map(rows.map((r) => {
      const marcos = round2(r.marcos_pagos);
      const pago = PAGAMENTO_ENTROU.includes(String(r.payment_status || '').toLowerCase());
      return [r.id, marcos > 0 ? marcos : (pago ? round2(r.total) : 0)];
    }));
    return orders.map((o) => {
      const rec = o.source === 'digital' ? (mapa.get(String(o.digital_order_id)) || 0) : 0;
      return { ...o, fila_recebido: rec, fila_tem_recebimento: rec > 0 };
    });
  } catch (e) {
    console.error('[tirarDaFila] recebimento da lista:', e.message);
    return orders.map(base);
  }
}

module.exports = {
  temTabela, semOsTirados, soOsTirados, recebidoDoPedidoDigital,
  tirarDaFila, devolverAFila, devolverNaConfirmacao, comRecebimento, _zerarCache,
};
