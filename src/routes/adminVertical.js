// ============================================================
// AURA. — Admin: ativacao/desativacao de modulo vertical
// PATCH /admin/clients/:cid/vertical
//
// Verticais disponiveis (companies.vertical_active):
//   odonto   — Odontologia (T1+T2 implementado)
//   barber   — Barbearia/Salao (T1+T2 implementado)
//   food     — Food Service (implementado)
//   estetica — Estetica (em desenvolvimento, so exibicao)
//   pet      — Pet Shop (em desenvolvimento)
//   academia — Academia (em desenvolvimento)
//   null     — Nenhuma vertical ativa (esconde tab Vertical)
//
// Altera so companies.vertical_active + vertical_enabled_at.
// NAO adiciona cobranca de addon — enquanto alpha, sem custo extra.
// ============================================================

const router = require('express').Router();
const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');

const adminOnly = [requireAuth, requireRole('admin')];

const VALID_VERTICALS = ['odonto', 'barber', 'food', 'estetica', 'pet', 'academia'];

// PATCH /admin/clients/:cid/vertical
router.patch('/clients/:cid/vertical', ...adminOnly, asyncHandler(async (req, res) => {
  const { cid } = req.params;
  const body = req.body || {};
  // Aceita null explicito ou string vazia pra desativar
  const raw = body.vertical;
  const vertical = raw === null || raw === '' || raw === undefined ? null : String(raw).toLowerCase().trim();

  if (vertical !== null && !VALID_VERTICALS.includes(vertical)) {
    throw new AppError(
      'Vertical invalida. Use null para desativar ou uma de: ' + VALID_VERTICALS.join(', '),
      400
    );
  }

  // Valida empresa
  const { rows: existing } = await pool.query(
    `SELECT id, plan, trade_name, vertical_active FROM companies WHERE id = $1`,
    [cid]
  );
  if (!existing.length) throw new AppError('Empresa nao encontrada', 404);

  const oldVertical = existing[0].vertical_active;
  if (oldVertical === vertical) {
    return res.json({
      message: vertical ? 'Vertical ja esta em ' + vertical : 'Nenhuma vertical ja era o estado',
      company: existing[0],
      changed: false,
    });
  }

  // Atualiza vertical_active + timestamp de ativacao
  // Se desativando: limpa enabled_at
  // Se ativando: setta NOW()
  const { rows } = await pool.query(
    `UPDATE companies
     SET vertical_active = $1,
         vertical_enabled_at = CASE WHEN $1::text IS NULL THEN NULL ELSE NOW() END,
         updated_at = NOW()
     WHERE id = $2
     RETURNING id, plan, trade_name, vertical_active, vertical_enabled_at`,
    [vertical, cid]
  );

  const company = rows[0];

  // Audit log (best-effort)
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (actor_user_id, action, target_company_id, payload)
       VALUES ($1, $2, $3, $4)`,
      [
        req.user?.id || null,
        'vertical_change',
        cid,
        JSON.stringify({ from: oldVertical, to: vertical }),
      ]
    );
  } catch (err) {
    console.warn('[admin/vertical] audit log falhou:', err.message);
  }

  res.json({
    message: vertical
      ? 'Vertical alterada de ' + (oldVertical || 'nenhuma') + ' para ' + vertical
      : 'Vertical desativada (antes: ' + oldVertical + ')',
    company,
    changed: true,
  });
}));

module.exports = router;
