// ============================================================
// AURA. — Admin: ativacao/desativacao de modulo vertical
// PATCH /admin/clients/:cid/vertical
//
// Verticais disponiveis (companies.vertical_active):
//   odonto   — Odontologia (T1+T2 implementado)
//   barber   — Barbearia/Salao (T1+T2 implementado)
//   food     — Food Service (implementado)
//   studio   — Aura Studio / Personalizados (implementado 25/05)
//   estetica — Estetica (em desenvolvimento, so exibicao)
//   pet      — Pet Shop (em desenvolvimento)
//   academia — Academia (em desenvolvimento)
//   null     — Nenhuma vertical ativa (esconde tab Vertical)
//
// Altera companies.vertical_active + vertical_enabled_at e, quando
// a vertical for "studio", sincroniza pdv_settings.studio_enabled=true
// para liberar o /studio/* gateado. Ao desativar, desliga o toggle.
// ============================================================

const router = require('express').Router();
const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');

const adminOnly = [requireAuth, requireRole('admin')];

const VALID_VERTICALS = ['odonto', 'barber', 'food', 'studio', 'estetica', 'pet', 'academia'];

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
    `SELECT id, plan, trade_name, vertical_active, pdv_settings FROM companies WHERE id = $1`,
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
  const { rows } = await pool.query(
    `UPDATE companies
     SET vertical_active = $1,
         vertical_enabled_at = CASE WHEN $1::text IS NULL THEN NULL ELSE NOW() END,
         updated_at = NOW()
     WHERE id = $2
     RETURNING id, plan, trade_name, vertical_active, vertical_enabled_at, pdv_settings`,
    [vertical, cid]
  );

  const company = rows[0];

  // Sincroniza toggle studio_enabled quando ativando/desativando studio
  // (best-effort — não bloqueia o response se a coluna pdv_settings não existir)
  try {
    if (vertical === 'studio') {
      await pool.query(
        `UPDATE companies
           SET pdv_settings = COALESCE(pdv_settings, '{}'::jsonb)
                             || jsonb_build_object('studio_enabled', true)
         WHERE id = $1`,
        [cid]
      );
    } else if (oldVertical === 'studio') {
      // desativando o studio — desliga o toggle pra não vazar telas
      await pool.query(
        `UPDATE companies
           SET pdv_settings = COALESCE(pdv_settings, '{}'::jsonb)
                             || jsonb_build_object('studio_enabled', false)
         WHERE id = $1`,
        [cid]
      );
    }
  } catch (err) {
    console.warn('[admin/vertical] sync studio_enabled falhou:', err.message);
  }

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
