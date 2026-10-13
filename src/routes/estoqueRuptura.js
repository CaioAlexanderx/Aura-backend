// ============================================================
// AURA. — Estoque › O que vai faltar (13/10/2026)
//
// Montado em /companies/:id/estoque (requireAuth + requireCompanyAccess).
//
// GET /companies/:id/estoque/ruptura?ate=YYYY-MM-DD&janela=14&escopo=grupo
//
// Loja ou consolidado, conforme o token: com `consolidated_view` (o usuário
// está em "Todas as empresas") — ou com ?escopo=grupo — a lista soma as
// lojas do grupo de :id que o usuário alcança (dono ou membro ativo, a
// mesma regra de utils/userCompanyIds.js). O estoque compartilhado entra
// uma vez só nos dois modos: é uma linha de produto (services/ruptura.js).
//
// Sem requirePlan e sem limite de plano: é leitura do que a loja já tem
// cadastrado, como GET /products.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { calcularRuptura, normalizarParametros } = require('../services/ruptura');

const GRUPO = (a) => `COALESCE(NULLIF(${a}.billing_owner_company_id, ${a}.id), ${a}.id)`;

// Lojas ativas do grupo de :id que o usuário alcança. Staff alcança todas.
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

router.get('/ruptura', async (req, res) => {
  const companyId = req.params.id;
  let parametros;
  try {
    parametros = normalizarParametros({ ate: req.query.ate, janela: req.query.janela });
  } catch (err) {
    return res.status(400).json({ error: err.message, code: err.code });
  }

  try {
    const consolidado = req.user?.consolidated_view === true || req.query.escopo === 'grupo';
    const companyIds = consolidado ? await lojasDoConsolidado(companyId, req.user) : [];
    const resultado = await calcularRuptura({
      companyId,
      companyIds,
      ate: parametros.ate,
      janelaDias: parametros.janelaDias,
      hoje: parametros.hoje,
    });
    res.json(resultado);
  } catch (err) {
    console.error('[estoque] ruptura error:', err.message);
    res.status(500).json({ error: 'Erro ao calcular o que vai faltar' });
  }
});

module.exports = router;
