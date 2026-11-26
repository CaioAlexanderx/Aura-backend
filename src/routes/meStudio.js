// ============================================================
// AURA. — Personalizados na visão consolidada (multi-CNPJ)
//
// 17/11/2026 (p-186): a Produção e os Orçamentos de todas as lojas do
// usuário numa lista só, para a tela consolidada do app (p-187).
//
//   GET /me/studio/orders?company_id=&status=&days=30&limit=50&offset=0
//     { orders: [<linha de GET /companies/:id/studio/orders>
//                + company_id, company_name],
//       total, limit, offset, filtered_company_id,
//       breakdown: [{company_id, company_name, is_primary, total}],
//       company_count, degraded? }
//
//   GET /me/studio/quotes?company_id=&status=&days=90&limit=50&offset=0
//     { quotes: [<linha de GET /companies/:id/studio/quotes> + company_name],
//       total, limit, offset, filtered_company_id,
//       breakdown: [...], company_count }
//
// ─── Que lojas entram ────────────────────────────────────────
// As lojas que o usuário acessa (dono ou membro ativo, como os outros
// /me/*), quando as duas condições valem NA LOJA:
//   1. plano Negócio para cima (companies.plan em STUDIO_PLANS: negocio,
//      expansao, personalizado). O gate é por loja, não pelo plano do JWT:
//      no consolidado o JWT leva o MAIOR plano entre as lojas, e uma loja
//      Essencial do grupo não pode aparecer por carona;
//   2. o usuário vê Personalizados ali: dono (owner_id ou role_label
//      'owner'), membro sem restrição gravada (permissions null) ou membro
//      com permissions['personalizados.access'] = true. É a mesma regra do
//      app (PERM_TO_MODULES) e de /auth/my-permissions.
// Loja que não passa fica fora, sem erro. Nenhuma loja passa: lista vazia.
// ?company_id= de loja que o usuário não acessa: 403 (igual a /me/sales).
// De loja dele que não passa nas condições: lista vazia.
//
// ─── O que sai ───────────────────────────────────────────────
// Os mesmos campos das rotas por empresa, mais a loja. Fora de propósito:
//   - pedidos: card_customization sai null (é o JSON da personalização com
//     a configuração do produto, pesado para uma lista de várias lojas; o
//     cartão consolidado usa card_image_url e o detalhe abre na loja);
//   - pedidos: sem ?with_balance (a aba "A receber" junta vendas fora da
//     view; fica na tela da loja). Os campos de saldo saem em cada linha.
//
// Só leitura, como todo /me/*: para agir, o usuário entra na loja.
// ============================================================
'use strict';

const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const db = require('../config/database');
const { STUDIO_PLANS } = require('../services/segment');
const pagamentoDoPedido = require('../services/pagamentoDoPedidoStudio');
const tirarDaFila = require('../services/tirarDaFila');
const { comItemEOrigem, NULL_ITEM_E_ORIGEM } = require('../services/itemEOrigemDoPedido');
const { listaDaProducao: L } = require('./studioKdsApproval');
const { nomeDaLoja: nomeDaLojaPelaRegra } = require('../utils/nomeDaLoja');

router.use(requireAuth);

const LIMITE_PADRAO = 50;
const LIMITE_MAX = 200;
const DIAS_MAX = 365;
const STATUS_DO_ORCAMENTO = ['draft', 'sent', 'accepted', 'rejected', 'expired', 'converted', 'closed'];

function inteiro(v, padrao, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(Math.max(n, min), max);
}

function lerPermissoes(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

/** Regra pura: a loja entra na visão consolidada de Personalizados? */
function lojaEntra({ plan, isOwner, roleLabel, permissions }) {
  if (!STUDIO_PLANS.includes(plan)) return false;
  if (isOwner === true || roleLabel === 'owner') return true;
  if (permissions == null) return true;
  return permissions['personalizados.access'] === true;
}

/**
 * Lojas do usuário: `acessa` são todas as que ele abre (para o 403 do
 * ?company_id=), `lojas` só as que entram, na ordem dos outros /me/*
 * (principal primeiro, depois a mais antiga).
 */
async function lojasDoUsuario(userId) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (c.id)
            c.id, c.legal_name, c.trade_name, c.plan, c.is_primary, c.created_at,
            (c.owner_id = $1) AS is_owner, cm.role_label, cm.permissions
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id
        AND cm.user_id = $1
        AND cm.status = 'active'
        AND cm.is_active = true
      WHERE (c.owner_id = $1 OR cm.user_id = $1)
        AND c.is_active = true
      ORDER BY c.id, (c.owner_id = $1) DESC, cm.role_label NULLS LAST`,
    [userId]
  );
  const acessa = new Set(rows.map((r) => String(r.id)));
  const lojas = rows
    .filter((r) => lojaEntra({
      plan: r.plan, isOwner: r.is_owner, roleLabel: r.role_label, permissions: lerPermissoes(r.permissions),
    }))
    .map((r) => ({
      id: r.id,
      nome: nomeDaLojaPelaRegra(r, 'Empresa'),
      is_primary: !!r.is_primary,
      created_at: r.created_at,
    }));
  lojas.sort((a, b) => {
    if (a.is_primary && !b.is_primary) return -1;
    if (!a.is_primary && b.is_primary) return 1;
    return new Date(a.created_at) - new Date(b.created_at);
  });
  return { acessa, lojas };
}

/**
 * Lojas da consulta e começo da resposta. Devolve { erro } (403) quando o
 * ?company_id= não é de loja do usuário.
 */
async function escopo(req) {
  const { acessa, lojas } = await lojasDoUsuario(req.user.id);
  const filtro = typeof req.query.company_id === 'string' && req.query.company_id.trim()
    ? req.query.company_id.trim()
    : null;
  if (filtro && !acessa.has(filtro)) return { erro: { status: 403, error: 'Sem acesso a essa empresa' } };
  const ids = filtro ? lojas.filter((l) => String(l.id) === filtro).map((l) => l.id) : lojas.map((l) => l.id);
  return { lojas, ids, filtro };
}

function comBreakdown(lojas, contagens) {
  const porLoja = new Map(contagens.map((r) => [String(r.company_id), parseInt(r.total, 10) || 0]));
  return lojas.map((l) => ({
    company_id: l.id,
    company_name: l.nome,
    is_primary: l.is_primary,
    total: porLoja.get(String(l.id)) || 0,
  }));
}

function respostaVazia(chave, lojas, filtro, limit, offset) {
  return {
    [chave]: [], total: 0, limit, offset,
    filtered_company_id: filtro,
    breakdown: comBreakdown(lojas, []),
    company_count: lojas.length,
  };
}

// ─── GET /me/studio/orders ───────────────────────────────────
router.get('/studio/orders', async (req, res) => {
  const limit = inteiro(req.query.limit, LIMITE_PADRAO, 1, LIMITE_MAX);
  const offset = inteiro(req.query.offset, 0, 0, 1e7);
  const dias = inteiro(req.query.days, 30, 1, DIAS_MAX);
  const status = req.query.status ? String(req.query.status) : null;
  if (status && !L.VALID_PRODUCTION_STATUS.includes(status)) {
    return res.status(400).json({ error: 'Etapa inválida', valid_status: L.VALID_PRODUCTION_STATUS });
  }

  let ctx;
  try {
    ctx = await escopo(req);
  } catch (err) {
    console.error('[meStudio] lojas:', err.message);
    return res.status(500).json({ error: 'Erro ao carregar os pedidos das lojas' });
  }
  if (ctx.erro) return res.status(ctx.erro.status).json({ error: ctx.erro.error });
  const { lojas, ids, filtro } = ctx;
  if (!ids.length) return res.json(respostaVazia('orders', lojas, filtro, limit, offset));

  const nomeDaLoja = new Map(lojas.map((l) => [String(l.id), l.nome]));
  const doBreakdown = lojas.map((l) => l.id);

  // Filtro comum: o breakdown conta em todas as lojas que entram (para o
  // seletor de loja mostrar quantos tem cada uma); a lista, só nas do filtro.
  // C1: tirados da Fila saem da lista, do total e do breakdown (?tirados=true: so eles).
  const soTirados = req.query.tirados === 'true' || req.query.tirados === '1';
  const fragTirados = (await tirarDaFila.temTabela(db))
    ? (soTirados ? tirarDaFila.soOsTirados('o') : tirarDaFila.semOsTirados('o'))
    : '';
  const filtros = (params) => {
    let w = fragTirados;
    if (status) { params.push(status); w += ` AND ${L.ETAPA_DO_PEDIDO} = $${params.length}`; }
    params.push(dias);
    w += ` AND o.created_at >= NOW() - make_interval(days => $${params.length}::int)`;
    return w;
  };

  try {
    const [comSaldo, comPrazo] = await Promise.all([L.hasInstallmentsTable(), L.hasPromisedDate()]);

    const pLista = [ids];
    const wLista = `o.company_id = ANY($1)` + filtros(pLista);
    const pConta = [ids];
    const wConta = `o.company_id = ANY($1)` + filtros(pConta);
    const pBreak = [doBreakdown];
    const wBreak = `o.company_id = ANY($1)` + filtros(pBreak);
    pLista.push(limit, offset);

    let linhas;
    let degraded = null;
    try {
      const r = await db.query(
        `SELECT o.id, o.company_id, o.created_at, o.total_amount, o.status,
                ${L.ETAPA_DO_PEDIDO} AS studio_production_status,
                o.customer_name, o.customer_phone,
                o.display_name,
                o.source,
${L.CARD_IMAGE_COL}
${L.CARD_SOURCE_COLS}
${comPrazo ? L.PROMISED_COL : ''}
${comSaldo ? L.BALANCE_COLS : ''}
                o.digital_order_id,
                o.pdv_sale_id,
                o.marketplace_order_id,
                o.marketplace_platform,
                o.customization_collected_at,
${L.ITENS_E_APROVACAO_COLS}
           FROM studio_orders o${comSaldo ? L.BALANCE_LATERAL : ''}
          WHERE ${wLista}
          ORDER BY o.created_at DESC, o.id DESC
          LIMIT $${pLista.length - 1} OFFSET $${pLista.length}`,
        pLista
      );
      linhas = r.rows.map((row) => L.fonteDaCapa({
        ...(comSaldo ? null : L.NULL_BALANCE),
        ...(comPrazo ? null : { promised_date: null }),
        ...row,
      }));
      linhas = await comPagamentoPorLoja(linhas);
      linhas = await comItemEOrigemPorLoja(linhas);
    } catch (errRica) {
      // Mesmo degrau do per-company: sem as colunas ricas, a lista sai com o
      // essencial da view em vez de 500.
      console.error('[meStudio] pedidos (rica):', errRica.message, errRica.code);
      const r = await db.query(
        `SELECT o.id, o.company_id, o.created_at, o.total_amount, o.status,
                ${L.ETAPA_DO_PEDIDO} AS studio_production_status,
                o.customer_name, o.customer_phone, o.display_name, o.source,
                o.digital_order_id, o.pdv_sale_id, o.marketplace_order_id,
                o.marketplace_platform, o.customization_collected_at
           FROM studio_orders o
          WHERE ${wLista}
          ORDER BY o.created_at DESC, o.id DESC
          LIMIT $${pLista.length - 1} OFFSET $${pLista.length}`,
        pLista
      );
      linhas = r.rows.map((row) => ({
        ...row,
        item_count: 0,
        pending_approval_url: null,
        approval_count: 0,
        ...L.NULL_BALANCE,
        card_image_url: null,
        card_image_source: null,
        card_customization: null,
        promised_date: null,
        ...NULL_ITEM_E_ORIGEM,
      }));
      degraded = 'slim';
    }

    const [conta, porLoja] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total FROM studio_orders o WHERE ${wConta}`, pConta),
      db.query(
        `SELECT o.company_id, COUNT(*)::int AS total FROM studio_orders o WHERE ${wBreak} GROUP BY o.company_id`,
        pBreak
      ),
    ]);

    // C1: fila_tem_recebimento / fila_recebido, uma chamada por loja da pagina.
    linhas = await comRecebimentoPorLoja(linhas);

    const orders = linhas.map((row) => ({
      ...row,
      company_name: nomeDaLoja.get(String(row.company_id)) || 'Empresa',
    }));

    const out = {
      orders,
      total: conta.rows[0]?.total || 0,
      limit, offset,
      filtered_company_id: filtro,
      breakdown: comBreakdown(lojas, porLoja.rows),
      company_count: lojas.length,
    };
    if (degraded) out.degraded = degraded;
    return res.json(out);
  } catch (err) {
    console.error('[meStudio] pedidos:', err.message, err.code);
    return res.status(500).json({ error: 'Erro ao carregar os pedidos das lojas' });
  }
});

// Situação do pagamento dos pedidos da vitrine (selo "Pagamento a conferir"),
// uma consulta por loja que tem pedido digital na página. Nunca lança.
async function comPagamentoPorLoja(linhas) {
  const lojasComDigital = [...new Set(
    linhas.filter((o) => o.source === 'digital' && o.digital_order_id).map((o) => String(o.company_id))
  )];
  if (!lojasComDigital.length) return linhas;
  const porId = new Map();
  for (const cid of lojasComDigital) {
    const daLoja = linhas.filter((o) => String(o.company_id) === cid);
    const comSelo = await pagamentoDoPedido.comPagamentoNaLista(
      db, cid, daLoja, (o) => (o.source === 'digital' ? o.digital_order_id : null)
    );
    comSelo.forEach((o) => porId.set(`${o.company_id}:${o.source}:${o.id}`, o));
  }
  return linhas.map((o) => porId.get(`${o.company_id}:${o.source}:${o.id}`) || o);
}

// Recebimento do pedido (C1), uma chamada por loja da pagina. Nunca lanca.
async function comRecebimentoPorLoja(linhas) {
  const porId = new Map();
  for (const cid of [...new Set(linhas.map((o) => String(o.company_id)))]) {
    const daLoja = linhas.filter((o) => String(o.company_id) === cid);
    const com = await tirarDaFila.comRecebimento(db, cid, daLoja);
    com.forEach((o) => porId.set(`${o.company_id}:${o.source}:${o.id}`, o));
  }
  return linhas.map((o) => porId.get(`${o.company_id}:${o.source}:${o.id}`)
    || { ...o, fila_recebido: 0, fila_tem_recebimento: false });
}

// Item e origem (p-194), uma chamada por loja da página. Só acrescenta
// campos; comItemEOrigem não lança, e se algo escapar a linha segue com null.
async function comItemEOrigemPorLoja(linhas) {
  const lojas = [...new Set(linhas.map((o) => String(o.company_id)))];
  const porId = new Map();
  for (const cid of lojas) {
    const daLoja = linhas.filter((o) => String(o.company_id) === cid);
    let comItem;
    try {
      comItem = await comItemEOrigem(db, cid, daLoja);
    } catch (err) {
      console.error('[meStudio] item e origem:', err.message);
      comItem = daLoja.map((o) => ({ ...o, ...NULL_ITEM_E_ORIGEM }));
    }
    comItem.forEach((o) => porId.set(`${o.company_id}:${o.source}:${o.id}`, o));
  }
  return linhas.map((o) => porId.get(`${o.company_id}:${o.source}:${o.id}`) || { ...o, ...NULL_ITEM_E_ORIGEM });
}

// ─── GET /me/studio/quotes ───────────────────────────────────
router.get('/studio/quotes', async (req, res) => {
  const limit = inteiro(req.query.limit, LIMITE_PADRAO, 1, LIMITE_MAX);
  const offset = inteiro(req.query.offset, 0, 0, 1e7);
  const dias = inteiro(req.query.days, 90, 1, DIAS_MAX);
  const status = req.query.status ? String(req.query.status) : null;
  if (status && !STATUS_DO_ORCAMENTO.includes(status)) {
    return res.status(400).json({ error: 'Situação inválida', valid_status: STATUS_DO_ORCAMENTO });
  }

  try {
    const ctx = await escopo(req);
    if (ctx.erro) return res.status(ctx.erro.status).json({ error: ctx.erro.error });
    const { lojas, ids, filtro } = ctx;
    if (!ids.length) return res.json(respostaVazia('quotes', lojas, filtro, limit, offset));

    const filtros = (params) => {
      let w = '';
      if (status) { params.push(status); w += ` AND q.status = $${params.length}`; }
      params.push(dias);
      w += ` AND q.created_at >= NOW() - make_interval(days => $${params.length}::int)`;
      return w;
    };
    const pLista = [ids];
    const wLista = `q.company_id = ANY($1)` + filtros(pLista);
    const pConta = [ids];
    const wConta = `q.company_id = ANY($1)` + filtros(pConta);
    const pBreak = [lojas.map((l) => l.id)];
    const wBreak = `q.company_id = ANY($1)` + filtros(pBreak);
    pLista.push(limit, offset);

    const [lista, conta, porLoja] = await Promise.all([
      db.query(
        `SELECT q.id, q.company_id, q.customer_id, q.customer_name, q.customer_phone,
                q.status, q.token, q.subtotal, q.discount, q.total, q.estimated_cost,
                q.validity_days, q.expires_at, q.sent_at, q.responded_at, q.response_note,
                q.order_id, q.deposit_pct, q.deposit_amount, q.notes, q.created_by,
                q.created_at, q.updated_at,
                (q.video_key IS NOT NULL) AS tem_video, q.video_expira_em, q.canal_envio,
                q.versao, q.ajuste_pedido_em
           FROM studio_quotes q
          WHERE ${wLista}
          ORDER BY q.created_at DESC, q.id DESC
          LIMIT $${pLista.length - 1} OFFSET $${pLista.length}`,
        pLista
      ),
      db.query(`SELECT COUNT(*)::int AS total FROM studio_quotes q WHERE ${wConta}`, pConta),
      db.query(
        `SELECT q.company_id, COUNT(*)::int AS total FROM studio_quotes q WHERE ${wBreak} GROUP BY q.company_id`,
        pBreak
      ),
    ]);

    const nomeDaLoja = new Map(lojas.map((l) => [String(l.id), l.nome]));
    return res.json({
      quotes: lista.rows.map((q) => ({ ...q, company_name: nomeDaLoja.get(String(q.company_id)) || 'Empresa' })),
      total: conta.rows[0]?.total || 0,
      limit, offset,
      filtered_company_id: filtro,
      breakdown: comBreakdown(lojas, porLoja.rows),
      company_count: lojas.length,
    });
  } catch (err) {
    console.error('[meStudio] orçamentos:', err.message, err.code);
    return res.status(500).json({ error: 'Erro ao carregar os orçamentos das lojas' });
  }
});

module.exports = router;
module.exports._lojaEntra = lojaEntra;
module.exports._lojasDoUsuario = lojasDoUsuario;
