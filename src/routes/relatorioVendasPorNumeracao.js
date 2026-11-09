// ============================================================
// AURA. — GET /companies/:id/reports/vendas-por-numeracao (03/11/2026)
//
// Relatório do Financeiro "Vendas por produto e numeração" (services/
// vendasPorNumeracao.js; mockup aura-app docs/mockups/
// relatorio-vendas-por-numeracao.html). Contrato no topo do service.
//
// Query: period = week | month | last_month | d90 | custom (+ start_date,
// end_date), category, q, por_cor=1, escopo=grupo.
//
// Loja ou consolidado: com consolidated_view no token (o usuário está em
// "Todas as empresas") ou ?escopo=grupo, soma as lojas do grupo de :id que
// o usuário alcança — mesma regra de /estoque/ruptura.
//
// Quem vê: o relatório traz receita. Membro precisa de alguma chave da
// retaguarda (financeiro, relatorios, configuracoes ou painel — painel
// ausente conta como ligado, igual ao menu do app). Dono, admin, staff e
// permissions null: sempre. Custo nunca sai daqui.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { resolverPeriodo, vendasPorNumeracao } = require('../services/vendasPorNumeracao');

const GRUPO = (a) => `COALESCE(NULLIF(${a}.billing_owner_company_id, ${a}.id), ${a}.id)`;

async function lojasDoConsolidado(companyId, user) {
  const { rows } = await db.query(
    `SELECT c.id,
            ($3::boolean OR c.owner_id = $2 OR EXISTS (
               SELECT 1 FROM company_members cm
                WHERE cm.company_id = c.id AND cm.user_id = $2
                  AND cm.status = 'active' AND cm.is_active = true
            )) AS alcanca
       FROM companies c
      WHERE ${GRUPO('c')} = (SELECT ${GRUPO('r')} FROM companies r WHERE r.id = $1)
        AND c.is_active = true`,
    [companyId, user.id, user.role === 'admin']
  );
  return rows.filter((r) => r.alcanca).map((r) => r.id);
}

function podeVerRelatorio({ isOwner, roleLabel, permissions }) {
  if (isOwner === true || roleLabel === 'owner' || roleLabel === 'admin') return true;
  if (!permissions) return true;
  if (permissions.painel === undefined) return true;
  return ['financeiro', 'relatorios', 'configuracoes', 'painel'].some((k) => permissions[k] === true);
}

async function permitido(req) {
  if (!req.user || req.user.role === 'admin' || req.companyRole === 'owner' || req.companyRole === 'admin') return true;
  const { rows } = await db.query(
    `SELECT (c.owner_id = $2) AS is_owner, cm.role_label, cm.permissions
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id AND cm.user_id = $2
        AND cm.status = 'active' AND cm.is_active = true
      WHERE c.id = $1
      LIMIT 1`,
    [req.params.id, req.user.id]
  );
  const r = rows[0];
  if (!r) return true;
  let permissions = r.permissions;
  if (typeof permissions === 'string') { try { permissions = JSON.parse(permissions); } catch (_) { permissions = null; } }
  return podeVerRelatorio({ isOwner: r.is_owner, roleLabel: r.role_label, permissions });
}

router.get('/vendas-por-numeracao', async (req, res) => {
  const companyId = req.params.id;
  let periodo;
  try {
    periodo = resolverPeriodo(String(req.query.period || 'month'), req.query.start_date, req.query.end_date);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  try {
    if (!(await permitido(req))) {
      return res.status(403).json({ error: 'Este acesso não inclui os relatórios de vendas.', code: 'SEM_PERMISSAO_RELATORIO' });
    }
    const consolidado = req.user?.consolidated_view === true || req.query.escopo === 'grupo';
    const companyIds = consolidado ? await lojasDoConsolidado(companyId, req.user) : [companyId];
    const relatorio = await vendasPorNumeracao(db, {
      companyId,
      companyIds: companyIds.length ? companyIds : [companyId],
      periodo,
      porCor: req.query.por_cor === '1' || req.query.por_cor === 'true',
      category: req.query.category ? String(req.query.category).slice(0, 120) : null,
      q: req.query.q ? String(req.query.q).slice(0, 120) : null,
    });
    res.json({ ...relatorio, consolidado, lojas: companyIds.length });
  } catch (err) {
    console.error('[vendas-por-numeracao] error:', err.message);
    res.status(500).json({ error: 'Erro ao montar o relatório' });
  }
});

module.exports = router;
module.exports.podeVerRelatorio = podeVerRelatorio;
// p-92 (08/11/2026): o resumo de vendidos na promocao usa as mesmas regras
// de loja/consolidado e de quem ve receita.
module.exports.lojasDoConsolidado = lojasDoConsolidado;
module.exports.permitido = permitido;
