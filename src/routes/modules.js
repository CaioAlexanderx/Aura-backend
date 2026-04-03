// ============================================================
// AURA. — VER-01b: Company Modules Routes
// Admin-only activation of vertical modules
// GET  /companies/:id/modules       — list active modules
// PUT  /companies/:id/modules/:key  — activate/deactivate
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAuditAction } = require('../middleware/auditLog');

// Module definitions with metadata
const MODULE_DEFS = {
  odonto:   { name: 'Odontologia',      accent: '#06B6D4', icon: 'tooth',    minPlan: 'negocio' },
  barber:   { name: 'Barbearia/Salao',   accent: '#F59E0B', icon: 'scissors', minPlan: 'negocio' },
  estetica: { name: 'Estetica',          accent: '#EC4899', icon: 'sparkles', minPlan: 'negocio' },
  pet:      { name: 'Pet Shop',          accent: '#10B981', icon: 'paw',      minPlan: 'negocio' },
  food:     { name: 'Food Service',      accent: '#EF4444', icon: 'utensils', minPlan: 'negocio' },
  moda:     { name: 'Moda/Varejo',       accent: '#8B5CF6', icon: 'shirt',    minPlan: 'negocio' },
  academia: { name: 'Academia',          accent: '#3B82F6', icon: 'dumbbell', minPlan: 'negocio' },
};

// GET /companies/:id/modules — list all modules with status
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows: active } = await db.query(
      `SELECT module_key, is_active, activated_at, config FROM company_modules
       WHERE company_id = $1 ORDER BY activated_at`,
      [req.params.id]
    );

    // Build full list with definitions + status
    const modules = Object.entries(MODULE_DEFS).map(([key, def]) => {
      const record = active.find(r => r.module_key === key);
      return {
        key,
        ...def,
        is_active: record ? record.is_active : false,
        activated_at: record ? record.activated_at : null,
        config: record ? record.config : {},
      };
    });

    res.json({ total: modules.length, active: modules.filter(m => m.is_active).length, modules });
  } catch (err) {
    console.error('modules list error:', err);
    res.status(500).json({ error: 'Erro ao listar modulos' });
  }
});

// PUT /companies/:id/modules/:key — activate or deactivate a module
// Admin-only (Aura team activates for clients)
router.put('/:key', requireAuth, requireRole('admin', 'analyst'), async (req, res) => {
  const { key } = req.params;
  const { is_active, config } = req.body;

  if (!MODULE_DEFS[key]) {
    return res.status(400).json({ error: `Modulo '${key}' nao existe`, valid_modules: Object.keys(MODULE_DEFS) });
  }

  if (is_active === undefined) {
    return res.status(400).json({ error: 'is_active e obrigatorio' });
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO company_modules (company_id, module_key, is_active, activated_by, config)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, module_key)
       DO UPDATE SET
         is_active = $3,
         activated_by = $4,
         config = COALESCE($5, company_modules.config),
         updated_at = NOW(),
         activated_at = CASE WHEN $3 = true AND company_modules.is_active = false THEN NOW() ELSE company_modules.activated_at END,
         deactivated_at = CASE WHEN $3 = false THEN NOW() ELSE NULL END
       RETURNING *`,
      [req.params.id, key, is_active, req.user.id, config ? JSON.stringify(config) : '{}']
    );

    // Audit log
    logAuditAction(
      req.user.id,
      req.params.id,
      is_active ? 'module_activated' : 'module_deactivated',
      `Module ${key} ${is_active ? 'activated' : 'deactivated'} for company ${req.params.id}`
    );

    res.json({
      module: {
        key,
        ...MODULE_DEFS[key],
        ...rows[0],
      },
      message: `Modulo ${MODULE_DEFS[key].name} ${is_active ? 'ativado' : 'desativado'} com sucesso`,
    });
  } catch (err) {
    console.error('module toggle error:', err);
    res.status(500).json({ error: 'Erro ao atualizar modulo' });
  }
});

// Export module definitions for use in other files
router.MODULE_DEFS = MODULE_DEFS;

module.exports = router;
