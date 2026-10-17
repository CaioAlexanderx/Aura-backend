// ============================================================
// AURA. — Venda idempotente no Caixa (migration 390, card tq-15, 17/10/2026)
//
// O app manda o cabecalho `Idempotency-Key` no POST /pdv/sale (e no
// /pdv/sale-com-sinal, que delega ao mesmo handleSale): um uuid por
// carrinho, o MESMO em toda nova tentativa da mesma venda e nas duas abas
// que restauraram o mesmo carrinho. Cabecalho (e nao campo no body) pelo
// mesmo motivo do recebimento do crediario (routes/credit.js): e o padrao
// do HTTP, ja esta no allowedHeaders do CORS (src/app.js) e nao se mistura
// com o body que o /sale-com-sinal reescreve antes de delegar.
//
// Como a rota usa (routes/pdv.js, handleSale):
//   1. chaveDaVenda(req): le e valida a chave; null = sem idempotencia
//      (sem cabecalho, chave fora do formato ou migration 390 ausente).
//   2. logo apos o BEGIN, travarEBuscar(): trava a chave (advisory lock da
//      transacao) e procura a venda dela. A segunda requisicao simultanea
//      ESPERA a primeira terminar e entao enxerga a venda ja gravada —
//      inclusive antes das conferencias de estoque/cupom, que dariam um
//      409 falso depois que a primeira baixou o estoque.
//   3. achou -> ROLLBACK e responderRepeticao(): devolve a venda que ja
//      existe, sem gravar nada (sem estoque, receita, crediario, comanda,
//      Matcon ou trial). A NFC-e sai depois, pelo /nfce/emit, que ja recusa
//      segunda nota para o mesmo sale_id.
//   4. nao achou -> a venda segue igual e o INSERT grava a chave. O indice
//      UNICO parcial e a garantia final: se mesmo assim duas linhas
//      tentarem nascer, a segunda leva 23505 (ehColisaoDaChave) e tambem
//      cai em responderRepeticao().
//   5. depois do COMMIT, guardarResposta() grava o corpo da resposta 201
//      (sem esperar). A repeticao devolve esse corpo; se ele ainda nao
//      estiver gravado, remonta o basico (venda + itens + recibo).
//
// Mesma chave com OUTROS itens (a aba velha que ficou com a chave e montou
// outra venda) nao e repeticao: 409 IDEMPOTENCY_KEY_REUSED com o numero da
// venda ja registrada. O app troca a chave e o proximo clique vira venda
// nova — nunca uma venda some calada dentro da resposta de outra.
// ============================================================
'use strict';

const db = require('../config/database');

const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;
const INDICE = 'uq_sales_company_idempotency_key';

// Cache da sondagem das colunas: "existe" e permanente no processo; "nao
// existe" e reperguntado a cada 60 s (a 390 pode ter acabado de rodar).
let _colunas = null;
let _checadoEm = 0;

async function colunasDisponiveis() {
  if (_colunas === true) return true;
  if (_colunas === false && (Date.now() - _checadoEm) < 60000) return false;
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sales'
          AND column_name IN ('idempotency_key', 'idempotency_response')`
    );
    _colunas = parseInt(rows?.[0]?.n || 0, 10) === 2;
  } catch (e) {
    _colunas = false;
  }
  _checadoEm = Date.now();
  return _colunas;
}

function _resetCache() { _colunas = null; _checadoEm = 0; }

function lerCabecalho(req) {
  const raw = req?.headers?.['idempotency-key'];
  if (raw === undefined || raw === null) return null;
  const k = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (!k) return null;
  if (!KEY_RE.test(k)) {
    // Fora do formato: a venda NAO cai por isso, so segue sem protecao.
    console.warn('[PDV] Idempotency-Key fora do formato, ignorada');
    return null;
  }
  return k;
}

/** A chave desta venda, ou null quando a venda segue sem idempotencia. */
async function chaveDaVenda(req) {
  const k = lerCabecalho(req);
  if (!k) return null;
  return (await colunasDisponiveis()) ? k : null;
}

/** Dentro da transacao da venda. Devolve o id da venda ja feita, ou null. */
async function travarEBuscar(client, companyId, key) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pdv-sale:${companyId}:${key}`]);
  const { rows } = await client.query(
    `SELECT id FROM sales WHERE company_id = $1 AND idempotency_key = $2 LIMIT 1`,
    [companyId, key]
  );
  return rows[0]?.id || null;
}

function ehColisaoDaChave(e) {
  return !!e && e.code === '23505' && String(e.constraint || '') === INDICE;
}

// Os itens identificam a venda: produto, variante e quantidade (o preco
// pode mudar de centavo entre a tela e o servidor; os itens, nao).
function linhaDoItem(productId, variantId, nome, quantidade) {
  const produto = productId ? String(productId) : 'n:' + String(nome || '').trim();
  return [produto, variantId ? String(variantId) : '', Number(quantidade || 0).toFixed(3)].join('|');
}

function mesmosItens(itensDoPedido, itensGravados) {
  const a = (itensDoPedido || []).map((i) => linhaDoItem(i.product_id, i.variant_id, i.product_name_snapshot, i.quantity)).sort();
  const b = (itensGravados || []).map((i) => linhaDoItem(i.product_id, i.variant_id, i.product_name_snapshot, i.quantity)).sort();
  return a.length === b.length && a.every((x, idx) => x === b[idx]);
}

/**
 * Responde a repeticao com a venda que a chave ja gerou. Fora da transacao
 * (o client da venda ja fez ROLLBACK). Devolve false quando nao achou a
 * venda (nao deveria acontecer) — a rota responde o erro de sempre.
 */
async function responderRepeticao(res, { companyId, key, itens }) {
  const { rows } = await db.query(
    `SELECT * FROM sales WHERE company_id = $1 AND idempotency_key = $2 LIMIT 1`,
    [companyId, key]
  );
  if (!rows.length) return false;
  const { idempotency_response: guardada, ...venda } = rows[0];

  const { rows: itensGravados } = await db.query(
    `SELECT si.*, p.name AS product_name FROM sale_items si
       LEFT JOIN products p ON p.id = si.product_id WHERE si.sale_id = $1`,
    [venda.id]
  );

  if (!mesmosItens(itens, itensGravados)) {
    const numero = venda.sale_number ? ` (venda ${venda.sale_number})` : '';
    res.status(409).json({
      error: `Esta venda já foi registrada${numero} com outros itens. Confira em Vendas; se for uma venda nova, finalize de novo.`,
      code: 'IDEMPOTENCY_KEY_REUSED',
      sale_id: venda.id,
      sale_number: venda.sale_number ?? null,
    });
    return true;
  }

  const corpo = guardada && typeof guardada === 'object'
    ? { ...guardada }
    : {
        sale: { ...venda, items: itensGravados },
        coupon_applied: venda.coupon_code
          ? { code: venda.coupon_code, discount: parseFloat(venda.discount_amount || 0) }
          : null,
        credit: null,
        card_fee: null,
        receipt_url: `/companies/${companyId}/print/receipt/${venda.id}`,
        track_url: venda.tracker_token
          ? `${process.env.APP_PUBLIC_URL || ''}/acompanhar/${venda.tracker_token}`
          : null,
      };
  corpo.idempotent_replay = true;
  res.set('Idempotent-Replayed', 'true');
  res.status(201).json(corpo);
  return true;
}

/** Depois do COMMIT, sem esperar: a venda nunca atrasa nem cai por isto. */
function guardarResposta({ companyId, saleId, corpo }) {
  Promise.resolve()
    .then(() => db.query(
      `UPDATE sales SET idempotency_response = $1::jsonb WHERE id = $2 AND company_id = $3`,
      [JSON.stringify(corpo), saleId, companyId]
    ))
    .catch((e) => console.warn('[PDV] resposta da venda idempotente nao guardada:', e && e.message));
}

module.exports = {
  chaveDaVenda,
  travarEBuscar,
  ehColisaoDaChave,
  responderRepeticao,
  guardarResposta,
  mesmosItens,
  _resetCache,
  INDICE,
};
