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
//
// 05/10/2026: a logica de ativar/desativar mora em services/segment.js
// (setCompanyVertical), compartilhada com o cadastro e com
// PATCH /admin/clients/:cid/segment. Studio passa a exigir plano
// negocio/expansao/personalizado (409 STUDIO_PLAN_REQUIRED).
// ============================================================

const router = require('express').Router();
const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');
const {
  setCompanyVertical, canHaveStudio, studioPlanError, applySegment, isValidSegment, SEGMENTS,
} = require('../services/segment');

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

  // 05/10/2026: Studio so nos planos negocio/expansao. Antes a rota deixava
  // ativar no Essencial e o cliente ficava preso: o app manda toda empresa
  // Studio pra /studio, e o plano nao libera as telas.
  if (vertical === 'studio' && !canHaveStudio(existing[0].plan)) {
    const err = studioPlanError(existing[0].plan);
    return res.status(409).json({ error: err.message, code: err.code });
  }

  // Atualiza vertical_active + timestamp de ativacao e sincroniza o toggle
  // studio_enabled (best-effort, como sempre foi). Logica compartilhada com
  // o cadastro e com PATCH /admin/clients/:cid/segment (services/segment.js).
  const company = await setCompanyVertical(pool, cid, vertical, oldVertical, { bestEffortSync: true });

  // Audit log (best-effort)
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (staff_user_id, action, company_id, payload)
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

// ============================================================
// PATCH /admin/clients/:cid/segment  (05/10/2026)
// Body: { segment, extras?: ['os'], disable?: ['matcon'|'otica'|'os'] }
// A equipe define/troca a frente de qualquer empresa (por CNPJ) e liga ou
// desliga recursos. Grava segment_source='staff'. Studio so em plano que o
// suporta (409 STUDIO_PLAN_REQUIRED). Sair do Studio desativa a vertical.
// Resposta: { segment, segment_source, vertical_active, flags: {...} }
// ============================================================
router.patch('/clients/:cid/segment', ...adminOnly, asyncHandler(async (req, res) => {
  const { cid } = req.params;
  const body = req.body || {};
  const segment = typeof body.segment === 'string' ? body.segment.trim().toLowerCase() : body.segment;
  if (!isValidSegment(segment)) {
    throw new AppError('Frente invalida. Use uma de: ' + SEGMENTS.join(', '), 400);
  }
  for (const key of ['extras', 'disable']) {
    if (body[key] !== undefined && (!Array.isArray(body[key]) || body[key].length > 5)) {
      throw new AppError(key + ' deve ser uma lista', 400);
    }
  }

  const client = await pool.connect();
  let state;
  let previous = null;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT segment FROM companies WHERE id = $1', [cid]);
    if (!rows.length) throw new AppError('Empresa nao encontrada', 404);
    previous = rows[0].segment || null;
    state = await applySegment(client, cid, {
      segment,
      extras: body.extras || [],
      disable: body.disable || [],
      source: 'staff',
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err && err.code === 'STUDIO_PLAN_REQUIRED') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    throw err;
  } finally {
    client.release();
  }

  try {
    await pool.query(
      `INSERT INTO admin_audit_log (staff_user_id, action, company_id, payload)
       VALUES ($1, $2, $3, $4)`,
      [
        req.user?.id || null,
        'segment_change',
        cid,
        JSON.stringify({ from: previous, to: segment, extras: body.extras || [], disable: body.disable || [] }),
      ]
    );
  } catch (err) {
    console.warn('[admin/segment] audit log falhou:', err.message);
  }

  res.json(state);
}));

module.exports = router;
