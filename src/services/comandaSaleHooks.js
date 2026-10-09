// ============================================================
// AURA. — Comandas do Caixa: ganchos da venda (migration 368)
//
// A comanda fecha quando a venda que a cobra e gravada. O Caixa manda
// POST /pdv/sale com `comanda_id`; afterSaleInsert roda DENTRO da transacao
// da venda:
//   - comanda de outra loja / inexistente -> 404 COMANDA_NOT_FOUND
//   - comanda que nao esta aberta          -> 409 COMANDA_NOT_OPEN
//   (os dois revertem a venda inteira: cobrar duas vezes a mesma comanda e
//    pior do que pedir para abrir de novo)
//   - fecha a comanda (status, closed_at, sale_id, taxa aplicada) e grava
//     sales.comanda_id.
//   Sem comanda_id: retorna null SEM tocar o banco (venda comum igual).
//
// afterSaleCancel: a venda foi cancelada -> a comanda volta a ficar aberta,
// para cobrar de novo. Se o mesmo numero ja foi reaberto nesse meio tempo,
// ela vira 'cancelled' (o indice parcial so admite uma aberta por numero).
//
// Deploy parcial (42P01/42703 — migration 368 ainda nao aplicada): venda
// sem comanda_id nunca chega aqui; com comanda_id e sem a tabela, 409
// COMANDA_UNAVAILABLE. O cancelamento so sonda a tabela (cache module-level).
// ============================================================
'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function erro(statusCode, code, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  e.code = code;
  return e;
}

let _tabelaExiste = null;
let _tabelaCheckedAt = 0;

async function tabelaExiste(q) {
  const now = Date.now();
  if (_tabelaExiste === true) return true;
  if (_tabelaExiste === false && (now - _tabelaCheckedAt) < 60000) return false;
  try {
    const r = await q.query("SELECT to_regclass('public.pdv_comandas') IS NOT NULL AS ok");
    _tabelaExiste = !!(r && r.rows && r.rows[0] && r.rows[0].ok);
  } catch (e) {
    _tabelaExiste = false;
  }
  _tabelaCheckedAt = now;
  return _tabelaExiste;
}

function _resetCache() { _tabelaExiste = null; _tabelaCheckedAt = 0; }

/**
 * @returns {Promise<null | {comanda_id: string, comanda_number: number}>}
 */
async function afterSaleInsert(client, { companyId, sale, body }) {
  const comandaId = body && body.comanda_id ? String(body.comanda_id) : null;
  if (!comandaId) return null;
  if (!UUID_RE.test(comandaId)) {
    throw erro(400, 'COMANDA_INVALID', 'Comanda inválida. Abra a comanda de novo pelo Caixa.');
  }
  if (!(await tabelaExiste(client))) {
    throw erro(409, 'COMANDA_UNAVAILABLE', 'As comandas ainda não estão disponíveis. Tente de novo em instantes.');
  }

  const { rows } = await client.query(
    `SELECT id, number, status FROM pdv_comandas
      WHERE id = $1 AND company_id = $2
      FOR UPDATE`,
    [comandaId, companyId]
  );
  if (!rows.length) throw erro(404, 'COMANDA_NOT_FOUND', 'Comanda não encontrada nesta loja.');
  const comanda = rows[0];
  if (comanda.status !== 'open') {
    throw erro(409, 'COMANDA_NOT_OPEN', `A comanda ${comanda.number} já foi fechada. Confira em Vendas antes de cobrar de novo.`);
  }

  let pct = Number(body.comanda_service_fee_pct);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) pct = 0;

  await client.query(
    `UPDATE pdv_comandas
        SET status = 'closed', closed_at = NOW(), sale_id = $1, service_fee_pct = $2
      WHERE id = $3`,
    [sale.id, pct, comanda.id]
  );
  await client.query(
    'UPDATE sales SET comanda_id = $1 WHERE id = $2 AND company_id = $3',
    [comanda.id, sale.id, companyId]
  );
  return { comanda_id: comanda.id, comanda_number: Number(comanda.number) };
}

/**
 * @returns {Promise<{comandas_reopened: number}>}
 */
async function afterSaleCancel(client, { companyId, saleId }) {
  const vazio = { comandas_reopened: 0 };
  if (!saleId) return vazio;
  if (!(await tabelaExiste(client))) return vazio;

  const { rows } = await client.query(
    `SELECT id, number FROM pdv_comandas
      WHERE sale_id = $1 AND company_id = $2 AND status = 'closed'
      FOR UPDATE`,
    [saleId, companyId]
  );
  let reopened = 0;
  for (const c of rows) {
    const { rows: outra } = await client.query(
      `SELECT 1 FROM pdv_comandas
        WHERE company_id = $1 AND number = $2 AND status = 'open' AND id <> $3
        LIMIT 1`,
      [companyId, c.number, c.id]
    );
    if (outra.length) {
      // O numero ja esta em uso de novo: esta nao pode voltar a ficar aberta.
      await client.query(
        `UPDATE pdv_comandas SET status = 'cancelled', sale_id = NULL WHERE id = $1`, [c.id]
      );
    } else {
      await client.query(
        `UPDATE pdv_comandas SET status = 'open', closed_at = NULL, sale_id = NULL, service_fee_pct = 0 WHERE id = $1`,
        [c.id]
      );
      reopened += 1;
    }
  }
  return { comandas_reopened: reopened };
}

module.exports = { afterSaleInsert, afterSaleCancel, tabelaExiste, _resetCache };
