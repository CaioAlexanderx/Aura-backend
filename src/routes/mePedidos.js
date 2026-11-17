// ============================================================
// AURA. — Pedidos guardados no Caixa na visão consolidada (B3 / p-61c)
//
//   GET /me/pedidos?company_id=&situacao=abertos&atrasados=1&q=&page=1&limit=30
//     { orders: [<linha de GET /companies/:id/pedidos>, com company_id e
//                 company_name],
//       situacao, kpis, counts, pagination,
//       por_empresa: [{company_id, company_name, abertos, pecas_reservadas,
//                      atrasados, sinais_recebidos, falta_receber}],
//       company_count, filtered_company_id }
//
// ─── Que lojas entram ────────────────────────────────────────
// A mesma regra de empresas do usuário de resultadoDoPeriodo.js /
// meAggregates (dono OU membro ativo, empresa ativa), quando o usuário vê a
// aba Pedidos NA LOJA: dono (owner_id ou role_label 'owner'), membro sem
// restrição gravada (permissions null) ou membro com permissions.pdv ou
// permissions['vendas.pedidos'] = true. Loja que não passa fica fora, sem
// erro. ?company_id= de loja que o usuário não acessa: 403 (igual a
// /me/sales e /me/studio/orders).
//
// Sem gate de plano: o Pedido é do Essencial (pendência 1). Só leitura, como
// todo /me/*: para agir (Separar, Pronto, Concluir), o usuário entra na loja.
// Trava PEDIDO_LIBERADO como a rota da loja.
// ============================================================
'use strict';

const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const db = require('../config/database');
const pedidoBalcao = require('../services/pedidoBalcao');
const listaDePedidos = require('../services/listaDePedidos');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Montado em /me junto de outros routers: nada de router.use aqui (a trava
// responderia 404 para todo /me/*). Autenticacao e trava so nesta rota.
function trava(req, res, next) {
  if (!pedidoBalcao.pedidoLiberado(req)) return res.status(404).json({ error: 'Não encontrado' });
  return next();
}

function lerPermissoes(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

/** O usuário vê a aba Pedidos nesta loja? */
function lojaEntra({ isOwner, roleLabel, permissions }) {
  if (isOwner === true || roleLabel === 'owner') return true;
  if (permissions == null) return true;
  return permissions.pdv === true || permissions['vendas.pedidos'] === true;
}

/** Todas as lojas que o usuário acessa (dono ou membro ativo), na ordem da tela. */
async function lojasDoUsuario(userId) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (c.id)
            c.id, COALESCE(c.trade_name, c.legal_name) AS nome, c.is_primary, c.created_at,
            (c.owner_id = $1) AS is_owner, cm.role_label, cm.permissions
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id
        AND cm.user_id = $1
        AND cm.status = 'active'
        AND cm.is_active = true
      WHERE (c.owner_id = $1 OR cm.user_id = $1)
        AND c.is_active = true
      ORDER BY c.id, (c.owner_id = $1) DESC`,
    [userId]
  );
  rows.sort((a, b) => {
    if (a.is_primary && !b.is_primary) return -1;
    if (!a.is_primary && b.is_primary) return 1;
    return new Date(a.created_at) - new Date(b.created_at);
  });
  return rows.map((r) => ({
    id: r.id,
    nome: r.nome,
    entra: lojaEntra({ isOwner: r.is_owner, roleLabel: r.role_label, permissions: lerPermissoes(r.permissions) }),
  }));
}

router.get('/pedidos', requireAuth, trava, async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ error: 'Não autenticado' });
    const lojas = await lojasDoUsuario(userId);
    const filtro = req.query.company_id ? String(req.query.company_id) : null;
    if (filtro && (!UUID_RE.test(filtro) || !lojas.some((l) => String(l.id) === filtro))) {
      return res.status(403).json({ error: 'Sem acesso a esta empresa.' });
    }
    const visiveis = lojas.filter((l) => l.entra && (!filtro || String(l.id) === filtro));
    const out = await listaDePedidos.listarPedidos(db, {
      empresas: visiveis.map((l) => l.id),
      situacao: req.query.situacao,
      atrasados: req.query.atrasados === '1' || req.query.atrasados === 'true',
      busca: req.query.q,
      page: req.query.page,
      limit: req.query.limit,
      hoje: pedidoBalcao.hojeSP(),
      porEmpresa: true,
    });
    const nomes = new Map(lojas.map((l) => [String(l.id), l.nome]));
    out.por_empresa = (out.por_empresa || []).map((e) => ({ ...e, company_name: nomes.get(String(e.company_id)) || null }));
    out.company_count = visiveis.length;
    out.filtered_company_id = filtro;
    res.set('Cache-Control', 'no-store');
    return res.json(out);
  } catch (err) {
    if (err && (err.code === '42703' || err.code === '42P01')) {
      return res.status(503).json({ error: 'Os pedidos ainda não estão disponíveis. Tente de novo em instantes.', code: 'PEDIDO_INDISPONIVEL' });
    }
    console.error('[me/pedidos]', err && err.message);
    return res.status(500).json({ error: 'Não conseguimos carregar os pedidos agora. Tente de novo em instantes.' });
  }
});

module.exports = router;
module.exports._lojaEntra = lojaEntra;
