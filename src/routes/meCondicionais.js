// ============================================================
// AURA. — Condicionais na visão consolidada (C2 / R14, 25/11/2026)
//
//   GET /me/condicionais?company_id=&filtro=em_aberto&q=&page=1&limit=30
//     { condicionais: [<linha de GET /companies/:id/condicionais>, com
//                      company_id e company_name],
//       filtro, hoje, totalizador, valor_a_cobrar, counts, pagination,
//       por_empresa: [{company_id, company_name, totalizador, counts}],
//       company_count, filtered_company_id }
//
// ─── Que lojas entram ────────────────────────────────────────
// A mesma regra de /me/pedidos (mePedidos.js): lojas ativas em que o usuário
// é dono ou membro ativo, quando ele vê a aba Condicionais NA LOJA: dono
// (owner_id ou role_label 'owner'), membro sem restrição gravada
// (permissions null) ou membro com permissions.vendas ou
// permissions['vendas.condicionais'] = true (a permissão de Vendas). Loja
// que não passa fica fora, sem erro. ?company_id= de loja que o usuário não
// acessa: 403.
//
// O totalizador do conjunto conta a cliente uma vez só, mesmo com
// condicional em duas lojas (listaDeCondicionais.js). Só leitura: para
// guardar ou concluir, o usuário entra na loja (criar pede a loja).
// Trava CONDICIONAL_LIBERADA como a rota da loja.
// ============================================================
'use strict';

const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const db = require('../config/database');
const condicional = require('../services/condicional');
const listaDeCondicionais = require('../services/listaDeCondicionais');
const resolver = require('../services/condicionalResolver');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Montado em /me junto de outros routers: nada de router.use aqui (a trava
// responderia 404 para todo /me/*).
function trava(req, res, next) {
  if (!condicional.condicionalLiberada(req)) return res.status(404).json({ error: 'Não encontrado' });
  return next();
}

function lerPermissoes(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

/** O usuário vê a aba Condicionais nesta loja? (a permissão de Vendas) */
function lojaEntra({ isOwner, roleLabel, permissions }) {
  if (isOwner === true || roleLabel === 'owner') return true;
  if (permissions == null) return true;
  return permissions.vendas === true || permissions['vendas.condicionais'] === true;
}

/** Lojas que o usuário acessa (dono ou membro ativo), na ordem da tela. */
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

router.get('/condicionais', requireAuth, trava, async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ error: 'Não autenticado' });
    const lojas = await lojasDoUsuario(userId);
    const filtro = req.query.company_id ? String(req.query.company_id) : null;
    if (filtro && (!UUID_RE.test(filtro) || !lojas.some((l) => String(l.id) === filtro))) {
      return res.status(403).json({ error: 'Sem acesso a esta empresa.' });
    }
    const visiveis = lojas.filter((l) => l.entra && (!filtro || String(l.id) === filtro));
    const out = await listaDeCondicionais.listarCondicionais(db, {
      empresas: visiveis.map((l) => l.id),
      filtro: req.query.filtro || req.query.situacao,
      busca: req.query.q,
      page: req.query.page,
      limit: req.query.limit,
      hoje: condicional.hojeSP(),
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
      return res.status(503).json({ error: 'As condicionais ainda não estão disponíveis. Tente de novo em instantes.', code: 'COND_INDISPONIVEL' });
    }
    console.error('[me/condicionais]', err && err.message);
    return res.status(500).json({ error: 'Não conseguimos carregar as condicionais agora. Tente de novo em instantes.' });
  }
});

// Pecas para resolver de todas as lojas que o usuario ve (C16): {pecas, total}.
// Cada peca traz company_id e company_name; resolver e feito na loja (POST da loja).
router.get('/condicionais/para-resolver', requireAuth, trava, async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ error: 'Não autenticado' });
    const lojas = await lojasDoUsuario(userId);
    const filtro = req.query.company_id ? String(req.query.company_id) : null;
    if (filtro && (!UUID_RE.test(filtro) || !lojas.some((l) => String(l.id) === filtro))) {
      return res.status(403).json({ error: 'Sem acesso a esta empresa.' });
    }
    const visiveis = lojas.filter((l) => l.entra && (!filtro || String(l.id) === filtro));
    const out = await resolver.listarParaResolver(db, { empresas: visiveis.map((l) => l.id) });
    const nomes = new Map(lojas.map((l) => [String(l.id), l.nome]));
    out.pecas = out.pecas.map((pc) => ({ ...pc, company_name: nomes.get(String(pc.company_id)) || null }));
    res.set('Cache-Control', 'no-store');
    return res.json(out);
  } catch (err) {
    if (err && (err.code === '42703' || err.code === '42P01')) {
      return res.status(503).json({ error: 'As condicionais ainda não estão disponíveis. Tente de novo em instantes.', code: 'COND_INDISPONIVEL' });
    }
    console.error('[me/condicionais/para-resolver]', err && err.message);
    return res.status(500).json({ error: 'Não conseguimos carregar as peças para resolver agora. Tente de novo em instantes.' });
  }
});

module.exports = router;
module.exports._lojaEntra = lojaEntra;
