// ============================================================
// AURA. — Company Profile CRUD
// PR37 (2026-04-28): whitelist expandida com campos compliance odonto.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');

router.get('/profile', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, trade_name, legal_name, cnpj, phone, email, address,
              tax_regime, plan, billing_status, logo_url,
              trial_ends_at, onboarding_step, created_at, updated_at,
              vigilancia_alvara_expires_at, vigilancia_alvara_number,
              vigilancia_alvara_reminder_enabled,
              cro_state, cro_pj_number, cro_rt_number, cro_rt_user_id,
              cnes_number, uses_controlled_meds, dental_compliance_enabled
       FROM companies WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Empresa nao encontrada' });
    const c = rows[0];
    res.json({
      id:              c.id,
      name:            c.trade_name || c.legal_name || '',
      trade_name:      c.trade_name  || '',
      legal_name:      c.legal_name  || '',
      cnpj:            c.cnpj         || '',
      phone:           c.phone        || '',
      email:           c.email        || '',
      address:         c.address      || '',
      tax_regime:      c.tax_regime   || 'simples',
      plan:            c.plan         || 'essencial',
      billing_status:  c.billing_status || 'inactive',
      logo_url:        c.logo_url     || '',
      trial_ends_at:   c.trial_ends_at,
      onboarding_step: c.onboarding_step,
      created_at:      c.created_at,
      updated_at:      c.updated_at,
      // PR37: compliance odonto
      vigilancia_alvara_expires_at:        c.vigilancia_alvara_expires_at,
      vigilancia_alvara_number:            c.vigilancia_alvara_number,
      vigilancia_alvara_reminder_enabled:  c.vigilancia_alvara_reminder_enabled !== false,
      cro_state:                           c.cro_state,
      cro_pj_number:                       c.cro_pj_number,
      cro_rt_number:                       c.cro_rt_number,
      cro_rt_user_id:                      c.cro_rt_user_id,
      cnes_number:                         c.cnes_number,
      uses_controlled_meds:                !!c.uses_controlled_meds,
      dental_compliance_enabled:           c.dental_compliance_enabled !== false,
    });
  } catch (err) {
    console.error('[company] GET /profile error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar perfil' });
  }
});

router.put('/profile', async (req, res) => {
  const allowedFields = {
    trade_name: 'trade_name',
    name:       'trade_name',
    legal_name: 'legal_name',
    cnpj:       'cnpj',
    phone:      'phone',
    email:      'email',
    address:    'address',
    tax_regime: 'tax_regime',
    logo_url:   'logo_url',
    // PR37: compliance odonto
    vigilancia_alvara_expires_at:        'vigilancia_alvara_expires_at',
    vigilancia_alvara_number:            'vigilancia_alvara_number',
    vigilancia_alvara_reminder_enabled:  'vigilancia_alvara_reminder_enabled',
    cro_state:                           'cro_state',
    cro_pj_number:                       'cro_pj_number',
    cro_rt_number:                       'cro_rt_number',
    cro_rt_user_id:                      'cro_rt_user_id',
    cnes_number:                         'cnes_number',
    uses_controlled_meds:                'uses_controlled_meds',
    dental_compliance_enabled:           'dental_compliance_enabled',
  };

  const updates = [];
  const values  = [];
  let idx = 1;
  const seen = new Set();

  for (const [bodyKey, dbCol] of Object.entries(allowedFields)) {
    if (req.body[bodyKey] !== undefined && !seen.has(dbCol)) {
      if (dbCol === 'cnpj' && req.body[bodyKey]) {
        const nums = String(req.body[bodyKey]).replace(/\D/g, '');
        if (nums.length !== 0 && nums.length !== 11 && nums.length !== 14) {
          return res.status(400).json({ error: 'CNPJ/CPF invalido' });
        }
      }
      if (dbCol === 'tax_regime' && req.body[bodyKey]) {
        const valid = ['mei', 'simples', 'simples_nacional', 'lucro_presumido', 'lucro_real', 'pessoa_fisica'];
        if (!valid.includes(req.body[bodyKey])) {
          return res.status(400).json({ error: 'Regime tributario invalido' });
        }
      }
      updates.push(`${dbCol} = $${idx}`);
      values.push(req.body[bodyKey]);
      idx++;
      seen.add(dbCol);
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  }

  updates.push('updated_at = NOW()');
  values.push(req.params.id);

  try {
    const result = await db.query(
      `UPDATE companies SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Empresa nao encontrada' });
    const c = result.rows[0];
    res.json({
      id:         c.id,
      name:       c.trade_name || c.legal_name || '',
      trade_name: c.trade_name || '',
      cnpj:       c.cnpj        || '',
      phone:      c.phone       || '',
      email:      c.email       || '',
      address:    c.address     || '',
      tax_regime: c.tax_regime  || 'simples',
      logo_url:   c.logo_url   || '',
      vigilancia_alvara_expires_at:        c.vigilancia_alvara_expires_at,
      vigilancia_alvara_reminder_enabled:  c.vigilancia_alvara_reminder_enabled !== false,
      cro_state:                           c.cro_state,
      cro_pj_number:                       c.cro_pj_number,
      cnes_number:                         c.cnes_number,
      uses_controlled_meds:                !!c.uses_controlled_meds,
      updated:    true,
    });
  } catch (err) {
    console.error('[company] PUT /profile error:', err.message);
    res.status(500).json({ error: 'Erro ao atualizar perfil' });
  }
});

module.exports = router;
