// ============================================================
// AURA. — Matcon: ganchos da venda (M1 — orcamento -> pedido -> entrega)
//
// 23/09/2026. O pdv.js chama estas funcoes DENTRO da transacao da venda
// (e do cancelamento), pra que o Matcon nunca deixe meia venda gravada.
// Tudo que o Matcon precisa fazer quando uma venda nasce ou morre mora
// aqui, e nao espalhado no handleSale: o M3 (pontos do profissional que
// indicou) acopla na mesma extensao sem tocar o pdv.js de novo.
//
//   afterSaleInsert(client, { companyId, sale, body, userId })
//     body.quote_id presente -> a venda nasceu de um orcamento:
//       - confere que o orcamento e desta loja;
//       - aceita orcamento open, approved ou expired (decisao abaixo);
//       - grava sales.quote_id, matcon_quotes.converted_sale_id e deixa o
//         orcamento approved;
//       - cria a 1a entrega (separating, scheduled_for = hoje +
//         matcon_default_delivery_days, padrao 2) com TODOS os itens.
//     Sem quote_id: retorna null SEM tocar o banco (venda comum igual).
//
//   Tambem (M3, 23/09/2026): body.referred_by_professional_id presente ->
//     credita os pontos do profissional parceiro (services/
//     matconProfessionals.creditReferredSale, dentro de SAVEPOINT proprio).
//     Nunca derruba a venda: erro vira aviso no log e a venda segue.
//
//   afterSaleCancel(client, { companyId, saleId })
//     - estorna os pontos da indicacao, se houve (reverseReferredSale);
//     - as entregas da venda ganham cancelled_at e saem da esteira (o
//       registro fica: e o rastro do que ja tinha ido pro caminhao);
//     - o orcamento perde o converted_sale_id e continua approved: o
//       cliente aprovou, quem desfez foi a loja (troca de forma de
//       pagamento e o motivo mais comum). Assim o "Virar pedido" volta a
//       aparecer na esteira e o lojista refaz a venda do mesmo orcamento.
//
// DECISAO — que orcamento vira venda: open, approved e expired passam.
//   O Caixa e a fonte da verdade: travar a venda no balcao porque o
//   orcamento venceu ontem seria pior que vender pelo preco combinado (o
//   lojista esta vendo o carrinho e decide). Barramos so o que geraria
//   pedido duplicado ou contradiz o lojista:
//     - ja virou outra venda (converted_sale_id) -> 409;
//     - marcado como perdido (lost)             -> 409.
//
// DECISAO — sem gate de matcon_enabled aqui: o quote_id so chega de uma
//   tela do Matcon, e desligar o toggle no meio do dia nao pode derrubar
//   a venda que ja esta no Caixa (o gate das rotas /matcon bloqueia a
//   escrita das telas, nao a venda).
//
// SEM RESERVA DE ESTOQUE: o repo nao tem mecanismo de reserva. O
//   "Virar pedido" so aprova; a baixa e a da venda, no proprio handleSale.
// ============================================================
'use strict';

const { findOwnerScopedCustomer } = require('../utils/customerScope');
// M3 (migration 353): pontos do profissional parceiro que indicou a venda.
const { creditReferredSale, reverseReferredSale } = require('./matconProfessionals');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SP_TODAY = "(NOW() AT TIME ZONE 'America/Sao_Paulo')::date";

const DEFAULT_DELIVERY_DAYS = 2;

// Erro que o catch do handleSale ja propaga como {error, code} (statusCode
// + code). Mensagem em portugues simples: vai direto pro toast do Caixa.
function erroMatcon(statusCode, code, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  e.code = code;
  return e;
}

// Prazo padrao da entrega: pdv_settings.matcon_default_delivery_days,
// inteiro entre 0 e 60; qualquer outra coisa cai no padrao do contrato (2).
function diasDeEntrega(pdvSettings) {
  const raw = pdvSettings && pdvSettings.matcon_default_delivery_days;
  const n = Number(raw);
  if (raw === null || raw === undefined || raw === '' || !Number.isInteger(n) || n < 0 || n > 60) {
    return DEFAULT_DELIVERY_DAYS;
  }
  return n;
}

// "Rua das Acacias, 233 - Centro - Campinas". Montado em JS a partir do
// SELECT * pra nao depender de quais colunas de endereco a tabela ja tem
// (street/city vem da 001; numero e bairro, da 073).
function enderecoDoCliente(c) {
  if (!c) return null;
  const rua = [c.street || c.address || null, c.address_number || null].filter(Boolean).join(', ');
  const partes = [rua, c.neighborhood || null, c.city || null].filter(Boolean);
  return partes.length ? partes.join(' - ') : null;
}

/**
 * Cria a 1a entrega de uma venda com todos os itens vendidos.
 * Usada pela venda com quote_id e pelo POST /matcon/deliveries (venda
 * avulsa do Caixa). Nao confere se ja existe entrega: quem chama confere.
 *
 * @returns {Promise<{id: string, public_token: string}>}
 */
async function createFirstDelivery(client, opts) {
  const {
    companyId, saleId, customerId, userId,
    fallbackName, fallbackPhone, scheduledFor, deliveryDays,
  } = opts;

  let nome = fallbackName || null;
  let fone = fallbackPhone || null;
  let endereco = null;
  if (customerId) {
    const c = await findOwnerScopedCustomer(client, companyId, customerId, '*');
    if (c) {
      nome = c.name || nome;
      fone = c.phone || fone;
      endereco = enderecoDoCliente(c);
    }
  }

  const dias = Number.isInteger(deliveryDays) ? deliveryDays : DEFAULT_DELIVERY_DAYS;
  const { rows } = await client.query(
    `INSERT INTO matcon_deliveries
       (company_id, sale_id, sequence, stage, scheduled_for,
        customer_name, customer_phone, address, created_by)
     VALUES ($1, $2, 1, 'separating',
             COALESCE($3::date, ${SP_TODAY} + $4::int),
             $5, $6, $7, $8)
     RETURNING id, public_token`,
    [companyId, saleId, scheduledFor || null, dias, nome, fone, endereco, userId || null]
  );
  const delivery = rows[0];

  await client.query(
    `INSERT INTO matcon_delivery_items (delivery_id, sale_item_id, quantity)
     SELECT $1, si.id, si.quantity
       FROM sale_items si
      WHERE si.sale_id = $2 AND si.quantity > 0`,
    [delivery.id, saleId]
  );
  return delivery;
}

/**
 * Gancho pos-INSERT da venda. Ver cabecalho.
 * @returns {Promise<null | {quote_id: string, delivery_id: string, delivery_token: string}>}
 */
async function afterSaleInsert(client, { companyId, sale, body, userId }) {
  const referral = await creditarIndicacao(client, { companyId, sale, body });
  const quoteId = body && body.quote_id ? String(body.quote_id) : null;
  if (!quoteId) return referral ? { referral } : null;
  if (!UUID_RE.test(quoteId)) {
    throw erroMatcon(400, 'QUOTE_INVALID', 'Orçamento inválido. Abra o orçamento de novo pela tela de Orçamentos.');
  }

  // FOR UPDATE: duas vendas do mesmo orcamento ao mesmo tempo (dois
  // caixas, clique duplo) — a segunda espera a primeira e ve o
  // converted_sale_id preenchido.
  const { rows: qRows } = await client.query(
    `SELECT id, status, converted_sale_id, customer_name, customer_phone
       FROM matcon_quotes
      WHERE id = $1 AND company_id = $2
      FOR UPDATE`,
    [quoteId, companyId]
  );
  if (!qRows.length) {
    throw erroMatcon(404, 'QUOTE_NOT_FOUND', 'Orçamento não encontrado nesta loja.');
  }
  const quote = qRows[0];
  if (quote.converted_sale_id) {
    throw erroMatcon(409, 'QUOTE_ALREADY_CONVERTED', 'Este orçamento já virou uma venda. Confira em Vendas antes de vender de novo.');
  }
  if (quote.status === 'lost') {
    throw erroMatcon(409, 'QUOTE_LOST', 'Este orçamento está marcado como perdido. Reabra o orçamento antes de vender.');
  }

  await client.query(
    `UPDATE matcon_quotes
        SET status = 'approved',
            approved_at = COALESCE(approved_at, NOW()),
            converted_sale_id = $1
      WHERE id = $2`,
    [sale.id, quoteId]
  );
  await client.query(
    'UPDATE sales SET quote_id = $1 WHERE id = $2 AND company_id = $3',
    [quoteId, sale.id, companyId]
  );

  const { rows: cfg } = await client.query(
    'SELECT pdv_settings FROM companies WHERE id = $1',
    [companyId]
  );
  const delivery = await createFirstDelivery(client, {
    companyId,
    saleId: sale.id,
    customerId: sale.customer_id || null,
    userId,
    fallbackName: quote.customer_name,
    fallbackPhone: quote.customer_phone,
    scheduledFor: null,
    deliveryDays: diasDeEntrega(cfg[0] && cfg[0].pdv_settings),
  });

  return {
    quote_id: quoteId, delivery_id: delivery.id, delivery_token: delivery.public_token,
    ...(referral ? { referral } : {}),
  };
}

// ── M3: pontos do profissional que indicou ───────────────────
//
// O Caixa manda referred_by_professional_id (chip "quem indicou?"). O
// servico do M3 valida loja/ativo/clube ligado e roda em SAVEPOINT; aqui so
// garantimos que NADA disso derruba a venda: um erro inesperado vira log e
// a venda e gravada sem os pontos (o extrato do parceiro nao e mais
// importante que o dinheiro no caixa).
async function creditarIndicacao(client, { companyId, sale, body }) {
  const professionalId = body && body.referred_by_professional_id
    ? String(body.referred_by_professional_id) : null;
  if (!professionalId || !sale || !sale.id) return null;
  if (!UUID_RE.test(professionalId)) return { credited: false, reason: 'INVALID_INPUT' };
  try {
    return await creditReferredSale(client, {
      companyId, saleId: sale.id, professionalId, total: Number(sale.total_amount) || 0,
    });
  } catch (e) {
    console.warn('[matcon] pontos da indicacao nao creditados:', e && e.message);
    return { credited: false, reason: 'ERROR' };
  }
}

// ── A tabela existe? ─────────────────────────────────────────
//
// Duas pessoas perguntam: o cancelamento (dentro da transacao, onde um
// 42P01 abortaria tudo) e as telas de Vendas, que embutem o EXISTS de
// has_pending_delivery no SELECT que ja fazem (sem consulta a mais: o
// banco fica em Sao Paulo e o backend nos EUA, ~190 ms por ida).
//
// Cache: "existe" e PERMANENTE no processo (a tabela nao some); "nao
// existe" e reperguntado a cada 60s (a 352 pode ter acabado de rodar).
// Assim, em regime, nenhuma tela paga ida extra ao banco por isto.
let _tabelaCheckedAt = 0;
let _tabelaExiste = null;

async function tabelasMatconExistem(q) {
  const now = Date.now();
  if (_tabelaExiste === true) return true;
  if (_tabelaExiste === false && (now - _tabelaCheckedAt) < 60000) return false;
  try {
    const r = await q.query(
      "SELECT to_regclass('public.matcon_deliveries') IS NOT NULL AS ok"
    );
    _tabelaExiste = !!(r && r.rows && r.rows[0] && r.rows[0].ok);
  } catch (e) {
    _tabelaExiste = false;
  }
  _tabelaCheckedAt = now;
  return _tabelaExiste;
}

/**
 * Fragmento de SELECT para `has_pending_delivery` (selo "saldo a entregar"):
 * venda com entrega aberta (stage <> delivered, nao cancelada). Mesmo
 * idioma do saleNumberSelect: sem a tabela, `false` com o mesmo alias, pra
 * forma do JSON nao mudar. Pergunte antes com tabelasMatconExistem().
 *
 * @param {boolean} available  resultado de tabelasMatconExistem()
 * @param {string} [alias]     alias da tabela sales na query (default 's')
 */
function pendingDeliverySelect(available, alias) {
  const a = alias || 's';
  if (!available) return 'false AS has_pending_delivery';
  return `EXISTS (SELECT 1 FROM matcon_deliveries md
                   WHERE md.sale_id = ${a}.id AND md.cancelled_at IS NULL
                     AND md.stage <> 'delivered') AS has_pending_delivery`;
}

/**
 * Gancho do cancelamento da venda. Ver cabecalho.
 * @returns {Promise<{deliveries_cancelled: number, quotes_released: number}>}
 */
async function afterSaleCancel(client, { companyId, saleId }) {
  const vazio = { deliveries_cancelled: 0, quotes_released: 0, points_reversed: false };
  if (!saleId) return vazio;
  // M3: estorno dos pontos da indicacao (SAVEPOINT proprio; sem a 353 ou
  // sem credito, so devolve reversed:false). Nunca derruba o cancelamento.
  let pointsReversed = false;
  try {
    const r = await reverseReferredSale(client, { companyId, saleId });
    pointsReversed = !!(r && r.reversed);
  } catch (e) {
    console.warn('[matcon] estorno dos pontos da indicacao falhou:', e && e.message);
  }
  vazio.points_reversed = pointsReversed;
  if (!(await tabelasMatconExistem(client))) return vazio;

  const r = await client.query(
    `WITH d AS (
       UPDATE matcon_deliveries
          SET cancelled_at = NOW()
        WHERE sale_id = $1 AND company_id = $2 AND cancelled_at IS NULL
        RETURNING id
     ), q AS (
       UPDATE matcon_quotes
          SET converted_sale_id = NULL
        WHERE converted_sale_id = $1 AND company_id = $2
        RETURNING id
     )
     SELECT (SELECT COUNT(*) FROM d)::int AS deliveries_cancelled,
            (SELECT COUNT(*) FROM q)::int AS quotes_released`,
    [saleId, companyId]
  );
  const row = r && r.rows && r.rows[0];
  return row
    ? { deliveries_cancelled: row.deliveries_cancelled || 0, quotes_released: row.quotes_released || 0, points_reversed: pointsReversed }
    : vazio;
}

// Exposto so pros testes: zera o cache da sondagem.
function _resetCache() { _tabelaCheckedAt = 0; _tabelaExiste = null; }

module.exports = {
  afterSaleInsert,
  afterSaleCancel,
  createFirstDelivery,
  tabelasMatconExistem,
  pendingDeliverySelect,
  diasDeEntrega,
  enderecoDoCliente,
  _resetCache,
};
