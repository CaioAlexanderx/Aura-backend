// ============================================================
// AURA. — Comandas do Caixa: ganchos da venda (migrations 368 e 392)
//
// O Caixa manda POST /pdv/sale com `comanda_id`; afterSaleInsert roda DENTRO
// da transacao da venda:
//   - comanda de outra loja / inexistente -> 404 COMANDA_NOT_FOUND
//   - comanda que nao esta aberta          -> 409 COMANDA_NOT_OPEN
//   (os dois revertem a venda inteira: cobrar duas vezes a mesma comanda e
//    pior do que pedir para abrir de novo)
//   Sem comanda_id: retorna null SEM tocar o banco (venda comum igual).
//
// FECHAMENTO PARCIAL (392, card tc-04, 17/10/2026): a venda pode levar
// `comanda_item_ids` (os itens cobrados) e, para cobrar so parte de uma
// linha, `comanda_item_qty` ({id: quantidade}).
//   - sem comanda_item_ids: cobra TODOS os itens pendentes e fecha a
//     comanda (o comportamento de antes);
//   - com comanda_item_ids: so esses itens ficam ligados a venda
//     (pdv_comanda_items.sale_id). Linha cobrada em parte e dividida: a
//     original fica com o que sobra (pendente) e nasce uma linha com a parte
//     cobrada, ligada a venda. A comanda fecha quando nao sobra item
//     pendente; senao continua aberta e a resposta leva comanda_open: true.
//   - item que ja foi cobrado (ou tirado da comanda) -> 409, a venda inteira
//     volta. A trava e a da linha da comanda (FOR UPDATE) mais a dos itens
//     pendentes: duas vendas da mesma comanda acontecem uma depois da outra,
//     e a segunda ja enxerga o item cobrado pela primeira.
//
// afterSaleCancel: a venda foi cancelada -> os itens dela voltam a ficar
// pendentes (sale_id NULL) e a comanda que estava fechada volta a ficar
// aberta, para cobrar de novo. Se o mesmo numero ja foi reaberto nesse meio
// tempo, ela vira 'cancelled' (o indice parcial so admite uma aberta por
// numero) — regra da 368, mantida.
//
// Deploy parcial:
//   - sem a 368 (42P01): venda sem comanda_id nunca chega aqui; com
//     comanda_id, 409 COMANDA_UNAVAILABLE.
//   - sem a 392 (coluna sale_id nos itens): sem comanda_item_ids (ou com
//     todos os itens inteiros) fecha a comanda inteira como antes; cobranca
//     parcial responde 409 COMANDA_PARCIAL_UNAVAILABLE.
//   As duas sondagens tem cache module-level ("existe" fica; "nao existe" e
//   reperguntado depois de 60 s).
// ============================================================
'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ITENS_COBRADOS = 500;

const round3 = (n) => Math.round(n * 1000) / 1000;

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

// pdv_comanda_items.sale_id (392) existe?
let _temItemVenda = null;
let _itemVendaCheckedAt = 0;

async function temItemVenda(q) {
  if (_temItemVenda === true) return true;
  const now = Date.now();
  if (_temItemVenda === false && (now - _itemVendaCheckedAt) < 60000) return false;
  try {
    const r = await q.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'pdv_comanda_items'
            AND column_name = 'sale_id'
       ) AS item_venda`
    );
    _temItemVenda = !!(r && r.rows && r.rows[0] && r.rows[0].item_venda);
  } catch (e) {
    _temItemVenda = false;
  }
  _itemVendaCheckedAt = now;
  return _temItemVenda;
}

function _resetCache() {
  _tabelaExiste = null; _tabelaCheckedAt = 0;
  _temItemVenda = null; _itemVendaCheckedAt = 0;
}

/**
 * Le `comanda_item_ids` / `comanda_item_qty` do corpo da venda.
 * @returns {null | Array<{id: string, quantity: number|null}>} null = todos
 *   os pendentes (campo ausente). quantity null = a linha inteira.
 */
function itensCobrados(body) {
  const raw = body ? body.comanda_item_ids : undefined;
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw erro(400, 'COMANDA_ITEMS_INVALID', 'Marque pelo menos um item da comanda para cobrar.');
  }
  if (raw.length > MAX_ITENS_COBRADOS) {
    throw erro(400, 'COMANDA_ITEMS_INVALID', `Cobre até ${MAX_ITENS_COBRADOS} itens por vez.`);
  }
  const qtds = body.comanda_item_qty && typeof body.comanda_item_qty === 'object' && !Array.isArray(body.comanda_item_qty)
    ? body.comanda_item_qty
    : {};
  const vistos = new Set();
  const out = [];
  for (const v of raw) {
    const id = typeof v === 'string' ? v.trim().toLowerCase() : '';
    if (!UUID_RE.test(id)) {
      throw erro(400, 'COMANDA_ITEMS_INVALID', 'Item da comanda inválido. Abra a comanda de novo pelo Caixa.');
    }
    if (vistos.has(id)) {
      throw erro(400, 'COMANDA_ITEMS_INVALID', 'O mesmo item da comanda veio duas vezes na venda.');
    }
    vistos.add(id);
    let quantity = null;
    const q = qtds[id] !== undefined ? qtds[id] : qtds[v];
    if (q !== undefined && q !== null) {
      quantity = round3(Number(q));
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw erro(400, 'COMANDA_ITEMS_INVALID', 'Quantidade inválida para um item da comanda.');
      }
    }
    out.push({ id, quantity });
  }
  return out;
}

async function fecharComanda(client, { comandaId, saleId, pct }) {
  await client.query(
    `UPDATE pdv_comandas
        SET status = 'closed', closed_at = NOW(), sale_id = $1, service_fee_pct = $2
      WHERE id = $3`,
    [saleId, pct, comandaId]
  );
}

async function ligarVenda(client, { comandaId, saleId, companyId }) {
  await client.query(
    'UPDATE sales SET comanda_id = $1 WHERE id = $2 AND company_id = $3',
    [comandaId, saleId, companyId]
  );
}

/**
 * @returns {Promise<null | {comanda_id: string, comanda_number: number, comanda_open?: true}>}
 */
async function afterSaleInsert(client, { companyId, sale, body }) {
  const comandaId = body && body.comanda_id ? String(body.comanda_id) : null;
  if (!comandaId) return null;
  if (!UUID_RE.test(comandaId)) {
    throw erro(400, 'COMANDA_INVALID', 'Comanda inválida. Abra a comanda de novo pelo Caixa.');
  }
  const pedidos = itensCobrados(body);
  if (!(await tabelaExiste(client))) {
    throw erro(409, 'COMANDA_UNAVAILABLE', 'As comandas ainda não estão disponíveis. Tente de novo em instantes.');
  }
  const comItemVenda = await temItemVenda(client);

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
  const resposta = { comanda_id: comanda.id, comanda_number: Number(comanda.number) };

  // ── Sem a 392: so a comanda inteira ───────────────────────────
  if (!comItemVenda) {
    if (pedidos) {
      const { rows: todos } = await client.query(
        'SELECT id, quantity FROM pdv_comanda_items WHERE comanda_id = $1',
        [comanda.id]
      );
      const qtdPorId = new Map(todos.map((r) => [String(r.id).toLowerCase(), round3(Number(r.quantity))]));
      const inteira = pedidos.length === todos.length && pedidos.every(
        (p) => qtdPorId.has(p.id) && (p.quantity == null || p.quantity >= qtdPorId.get(p.id))
      );
      if (!inteira) {
        throw erro(409, 'COMANDA_PARCIAL_UNAVAILABLE', 'Cobrar só parte da comanda ainda não está disponível. Cobre a comanda inteira ou tente de novo em instantes.');
      }
    }
    await fecharComanda(client, { comandaId: comanda.id, saleId: sale.id, pct });
    await ligarVenda(client, { comandaId: comanda.id, saleId: sale.id, companyId });
    return resposta;
  }

  // ── Com a 392 ─────────────────────────────────────────────────
  // Os pendentes, travados. A linha da comanda ja serializa as vendas; esta
  // trava cobre quem mexe no item sem passar pela comanda (tirar item).
  const { rows: pendentes } = await client.query(
    `SELECT id, quantity FROM pdv_comanda_items
      WHERE comanda_id = $1 AND sale_id IS NULL
      ORDER BY seq ASC
      FOR UPDATE`,
    [comanda.id]
  );

  if (!pedidos) {
    // Tudo o que esta pendente vai nesta venda (comportamento de antes).
    await client.query(
      'UPDATE pdv_comanda_items SET sale_id = $1 WHERE comanda_id = $2 AND sale_id IS NULL',
      [sale.id, comanda.id]
    );
    await fecharComanda(client, { comandaId: comanda.id, saleId: sale.id, pct });
    await ligarVenda(client, { comandaId: comanda.id, saleId: sale.id, companyId });
    return resposta;
  }

  const porId = new Map(pendentes.map((r) => [String(r.id).toLowerCase(), r]));
  const faltando = pedidos.filter((p) => !porId.has(p.id));
  if (faltando.length) {
    const { rows: cobrados } = await client.query(
      `SELECT id FROM pdv_comanda_items
        WHERE comanda_id = $1 AND id = ANY($2::uuid[]) AND sale_id IS NOT NULL`,
      [comanda.id, faltando.map((p) => p.id)]
    );
    if (cobrados.length) {
      throw erro(409, 'COMANDA_ITEM_ALREADY_CHARGED', `Um dos itens da comanda ${comanda.number} já foi cobrado. Abra a comanda de novo para ver o que falta.`);
    }
    throw erro(409, 'COMANDA_ITEM_NOT_FOUND', `Um dos itens não está mais na comanda ${comanda.number}. Abra a comanda de novo para ver o que falta.`);
  }

  let restam = pendentes.length;
  for (const p of pedidos) {
    const linha = porId.get(p.id);
    const tem = round3(Number(linha.quantity));
    if (p.quantity == null || p.quantity === tem) {
      await client.query('UPDATE pdv_comanda_items SET sale_id = $1 WHERE id = $2', [sale.id, linha.id]);
      restam -= 1;
      continue;
    }
    if (p.quantity > tem) {
      throw erro(409, 'COMANDA_ITEM_QTY_INVALID', `Quantidade maior do que a lançada na comanda ${comanda.number}. Abra a comanda de novo.`);
    }
    // Parte da linha: a original fica com o que sobra (pendente) e a parte
    // cobrada nasce numa linha propria, ligada a venda.
    await client.query(
      'UPDATE pdv_comanda_items SET quantity = $1 WHERE id = $2',
      [round3(tem - p.quantity), linha.id]
    );
    await client.query(
      `INSERT INTO pdv_comanda_items
         (comanda_id, company_id, product_id, variant_id, name, unit, quantity, unit_price, added_by, created_at, sale_id)
       SELECT comanda_id, company_id, product_id, variant_id, name, unit, $1, unit_price, added_by, created_at, $2
         FROM pdv_comanda_items WHERE id = $3`,
      [p.quantity, sale.id, linha.id]
    );
  }

  if (restam <= 0) {
    await fecharComanda(client, { comandaId: comanda.id, saleId: sale.id, pct });
  }
  await ligarVenda(client, { comandaId: comanda.id, saleId: sale.id, companyId });
  return restam > 0 ? { ...resposta, comanda_open: true } : resposta;
}

/**
 * @returns {Promise<{comandas_reopened: number}>}
 */
async function afterSaleCancel(client, { companyId, saleId }) {
  const vazio = { comandas_reopened: 0 };
  if (!saleId) return vazio;
  if (!(await tabelaExiste(client))) return vazio;
  const comItemVenda = await temItemVenda(client);

  // A comanda que esta venda fechou (368) e as que tem itens cobrados por
  // ela (392, cobranca parcial — a comanda pode estar aberta ainda).
  const { rows } = comItemVenda
    ? await client.query(
        `SELECT id, number, status FROM pdv_comandas
          WHERE company_id = $2
            AND (sale_id = $1 OR id IN (SELECT comanda_id FROM pdv_comanda_items WHERE sale_id = $1))
          FOR UPDATE`,
        [saleId, companyId]
      )
    : await client.query(
        `SELECT id, number, status FROM pdv_comandas
          WHERE sale_id = $1 AND company_id = $2 AND status = 'closed'
          FOR UPDATE`,
        [saleId, companyId]
      );
  if (!rows.length) return vazio;

  if (comItemVenda) {
    // Os itens desta venda voltam a ficar pendentes na comanda.
    await client.query(
      'UPDATE pdv_comanda_items SET sale_id = NULL WHERE sale_id = $1 AND company_id = $2',
      [saleId, companyId]
    );
  }

  let reopened = 0;
  for (const c of rows) {
    if (c.status !== 'closed') continue;
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

module.exports = { afterSaleInsert, afterSaleCancel, tabelaExiste, temItemVenda, itensCobrados, _resetCache };
