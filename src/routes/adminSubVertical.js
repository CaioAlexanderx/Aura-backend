// ============================================================
// AURA. — Admin: setar/limpar companies.sub_vertical
// PATCH /admin/clients/:cid/sub-vertical
//
// Whitelist por vertical principal:
//   varejo (vertical=NULL): calcados, moda, perfumaria, acessorios,
//     presentes, papelaria, eletronicos, brinquedos, casa, esportes,
//     outros
//   studio: canecas, camisetas, tazas, brindes_corporativos, copos,
//     squeezes, almofadas, bolsas, chaveiros, outros (item #6, 25/05)
//   odonto / barber / food / etc: livre (NULL = nao sub-segmenta)
//
// NAO adiciona cobranca de addon — sub-vertical e atributo descritivo
// pra agrupamento, nao cobra nada.
// ============================================================

const router = require('express').Router();
const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');

const adminOnly = [requireAuth, requireRole('admin')];

// Sub-verticais validas por vertical principal. NULL = varejo (sem vertical).
const SUB_VERTICALS_BY_VERTICAL = {
  null: [
    'calcados', 'moda', 'perfumaria', 'acessorios', 'presentes',
    'papelaria', 'eletronicos', 'brinquedos', 'casa', 'esportes',
    'outros',
  ],
  studio: [
    'canecas', 'camisetas', 'tazas', 'brindes_corporativos',
    'copos', 'squeezes', 'almofadas', 'bolsas', 'chaveiros', 'outros',
  ],
  // Outras verticais: sub_vertical e livre por enquanto. Frontend mostra
  // input livre. Se eventualmente curarmos uma whitelist por vertical
  // (ex: odonto -> 'clinica_geral', 'implantes', 'ortodontia'), adiciona aqui.
};

// Helper: valida sub_vertical contra whitelist da vertical
function isValidSubVertical(vertical, subVertical) {
  if (subVertical === null) return true; // sempre permite limpar
  const verticalKey = vertical === null ? null : (SUB_VERTICALS_BY_VERTICAL[vertical] ? vertical : null);
  // Se vertical não tem whitelist, varejo (null) é fallback
  if (verticalKey === null && vertical !== null && !SUB_VERTICALS_BY_VERTICAL[vertical]) {
    return true; // outras verticais: aceita qualquer string
  }
  const whitelist = SUB_VERTICALS_BY_VERTICAL[verticalKey];
  if (!whitelist) return true;
  return whitelist.includes(subVertical);
}

// GET /admin/sub-verticals/options — lista de opcoes pra UI
router.get('/sub-verticals/options', ...adminOnly, asyncHandler(async (req, res) => {
  res.json({
    by_vertical: {
      null: SUB_VERTICALS_BY_VERTICAL[null] || [],
      studio: SUB_VERTICALS_BY_VERTICAL.studio || [],
      odonto: [],
      barber: [],
      food: [],
      estetica: [],
      pet: [],
      academia: [],
    },
  });
}));

// PATCH /admin/clients/:cid/sub-vertical
router.patch('/clients/:cid/sub-vertical', ...adminOnly, asyncHandler(async (req, res) => {
  const { cid } = req.params;
  const body = req.body || {};
  const raw = body.sub_vertical;
  const subVertical = raw === null || raw === '' || raw === undefined
    ? null
    : String(raw).toLowerCase().trim();

  // Valida empresa
  const { rows: existing } = await pool.query(
    `SELECT id, trade_name, vertical_active, sub_vertical FROM companies WHERE id = $1`,
    [cid]
  );
  if (!existing.length) throw new AppError('Empresa nao encontrada', 404);
  const company = existing[0];

  if (!isValidSubVertical(company.vertical_active, subVertical)) {
    const allowed = SUB_VERTICALS_BY_VERTICAL[company.vertical_active === null ? null : company.vertical_active];
    throw new AppError(
      'sub_vertical invalida pra vertical=' + (company.vertical_active || 'varejo') +
      '. Opcoes: ' + (allowed ? allowed.join(', ') : 'qualquer string'),
      400
    );
  }

  const oldSubVertical = company.sub_vertical;
  if (oldSubVertical === subVertical) {
    return res.json({
      message: 'Sub-vertical ja era ' + (subVertical || 'NULL'),
      company,
      changed: false,
    });
  }

  const { rows } = await pool.query(
    `UPDATE companies
     SET sub_vertical = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING id, trade_name, vertical_active, sub_vertical`,
    [subVertical, cid]
  );

  // Audit log (best-effort — segue padrao do adminVertical)
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (actor_user_id, action, target_company_id, payload)
       VALUES ($1, $2, $3, $4)`,
      [
        req.user?.id || null,
        'sub_vertical_change',
        cid,
        JSON.stringify({ from: oldSubVertical, to: subVertical }),
      ]
    );
  } catch (err) {
    console.warn('[admin/sub-vertical] audit log falhou:', err.message);
  }

  res.json({
    message: subVertical
      ? 'Sub-vertical alterada de ' + (oldSubVertical || 'nenhuma') + ' para ' + subVertical
      : 'Sub-vertical limpa (antes: ' + oldSubVertical + ')',
    company: rows[0],
    changed: true,
  });
}));

module.exports = router;
