// ============================================================
// AURA. — CORE-01: Onboarding
// Fluxo: CNPJ → RF → detecção regime/vertical → perfil → done
// ============================================================
const router  = require('express').Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { lookupCNPJ, validateCNPJ, sanitizeCNPJ } = require('../services/cnpj');

let redis = null;
try { redis = require('../config/redis').default || require('../config/redis'); } catch (_) {}

// Rate limit CNPJ: 10 lookups/hora por IP
async function _checkRateLimit(ip) {
  if (!redis) return true;
  const key = `rl:cnpj:${ip}`;
  try {
    const cnt = await redis.incr(key);
    if (cnt === 1) await redis.expire(key, 3600);
    return cnt <= 10;
  } catch (_) { return true; }
}

// ── ETAPAS DO ONBOARDING ──────────────────────────────────────
const STEPS = ['cnpj', 'regime', 'perfil', 'vertical', 'done'];
function nextStep(current) {
  const idx = STEPS.indexOf(current);
  return idx < STEPS.length - 1 ? STEPS[idx + 1] : 'done';
}

// ── ROTAS PÚBLICAS ────────────────────────────────────────────

// POST /onboarding/cnpj-lookup
// Consulta pública (pré-cadastro) — não requer empresa criada
router.post('/cnpj-lookup', async (req, res) => {
  const { cnpj } = req.body;
  if (!cnpj) return res.status(400).json({ error: 'cnpj obrigatório' });
  if (!validateCNPJ(cnpj))
    return res.status(400).json({ error: 'CNPJ inválido' });

  const ip = req.ip || 'unknown';
  if (!(await _checkRateLimit(ip)))
    return res.status(429).json({ error: 'Limite de consultas atingido. Tente novamente em 1 hora.' });

  try {
    const data = await lookupCNPJ(cnpj, redis);
    // Não retorna dados se CNPJ inativo
    if (!data.is_active) {
      return res.status(422).json({
        error: 'CNPJ com situação irregular na Receita Federal.',
        situation: data.rf_situation,
      });
    }
    res.json(data);
  } catch (e) {
    const status = e.message.includes('não encontrado') ? 404
                 : e.message.includes('Limite')         ? 429 : 500;
    res.status(status).json({ error: e.message });
  }
});

// ── ROTAS AUTENTICADAS (empresa já criada) ────────────────────

// GET /companies/:id/onboarding
// Retorna status atual do onboarding + dados da sessão
router.get('/', requireAuth, async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows: companies } = await db.query(
      `SELECT c.onboarding_step, c.onboarding_completed_at,
              c.tax_regime, c.vertical_active, c.cnpj, c.legal_name,
              c.trade_name, c.cnaes, c.legal_nature, c.company_size,
              c.rf_situation, c.address_city, c.address_state,
              os.rf_data, os.step_cnpj_done, os.step_regime_done,
              os.step_perfil_done, os.step_vertical_done
       FROM companies c
       LEFT JOIN onboarding_sessions os ON os.company_id = c.id
       WHERE c.id = $1 AND c.owner_id = $2`,
      [cid, req.user.id]
    );
    if (!companies.length)
      return res.status(404).json({ error: 'Empresa não encontrada' });

    const c = companies[0];
    res.json({
      step:       c.onboarding_step || 'cnpj',
      completed:  !!c.onboarding_completed_at,
      completed_at: c.onboarding_completed_at,
      steps_done: {
        cnpj:     c.step_cnpj_done     || false,
        regime:   c.step_regime_done   || false,
        perfil:   c.step_perfil_done   || false,
        vertical: c.step_vertical_done || false,
      },
      company: {
        cnpj:           c.cnpj,
        legal_name:     c.legal_name,
        trade_name:     c.trade_name,
        tax_regime:     c.tax_regime,
        vertical_active:c.vertical_active,
        cnaes:          c.cnaes,
        legal_nature:   c.legal_nature,
        company_size:   c.company_size,
        rf_situation:   c.rf_situation,
        city:           c.address_city,
        state:          c.address_state,
      },
      rf_data: c.rf_data || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /companies/:id/onboarding/step/cnpj
// Etapa 1: consulta RF, preenche empresa automaticamente
router.post('/step/cnpj', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { cnpj } = req.body;
  if (!cnpj) return res.status(400).json({ error: 'cnpj obrigatório' });
  if (!validateCNPJ(cnpj))
    return res.status(400).json({ error: 'CNPJ inválido' });

  const ip = req.ip || 'unknown';
  if (!(await _checkRateLimit(ip)))
    return res.status(429).json({ error: 'Limite de consultas atingido' });

  try {
    // Verifica ownership
    const { rows } = await db.query(
      `SELECT id FROM companies WHERE id=$1 AND owner_id=$2`, [cid, req.user.id]
    );
    if (!rows.length) return res.status(403).json({ error: 'Acesso negado' });

    const rf = await lookupCNPJ(cnpj, redis);
    if (!rf.is_active)
      return res.status(422).json({ error: 'CNPJ com situação irregular na RF.', situation: rf.rf_situation });

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Atualiza dados da empresa com informações da RF
      await client.query(
        `UPDATE companies SET
           cnpj             = $1,  tax_id          = $1,
           legal_name       = $2,  trade_name      = COALESCE(NULLIF($3,''), trade_name),
           legal_nature     = $4,  legal_nature_code = $5,
           company_size     = $6,  rf_situation    = $7,
           opening_date     = $8,
           cnaes            = $9,
           address_street   = COALESCE(NULLIF($10,''), address_street),
           address_number   = COALESCE(NULLIF($11,''), address_number),
           address_complement=COALESCE(NULLIF($12,''), address_complement),
           address_district = COALESCE(NULLIF($13,''), address_district),
           address_city     = COALESCE(NULLIF($14,''), address_city),
           address_state    = COALESCE(NULLIF($15,''), address_state),
           address_zip      = COALESCE(NULLIF($16,''), address_zip),
           onboarding_step  = 'regime',
           updated_at       = NOW()
         WHERE id = $17`,
        [
          rf.cnpj_raw,
          rf.legal_name,
          rf.trade_name,
          rf.legal_nature,
          rf.legal_nature_code,
          rf.company_size,
          rf.rf_situation,
          rf.opening_date || null,
          JSON.stringify({
            principal:    rf.cnae_principal,
            secundarios:  rf.cnaes_secundarios,
          }),
          rf.address_street, rf.address_number, rf.address_complement,
          rf.address_district, rf.address_city, rf.address_state, rf.address_zip,
          cid,
        ]
      );

      // Upsert sessão de onboarding
      await client.query(
        `INSERT INTO onboarding_sessions (company_id, current_step, rf_data, step_cnpj_done)
         VALUES ($1, 'regime', $2, TRUE)
         ON CONFLICT (company_id) DO UPDATE
           SET current_step    = 'regime',
               rf_data         = $2,
               step_cnpj_done  = TRUE,
               updated_at      = NOW()`,
        [cid, JSON.stringify(rf)]
      );

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }

    res.json({
      next_step: 'regime',
      suggestions: {
        tax_regime:   rf.suggested_regime,
        vertical:     rf.suggested_vertical,
        is_mei:       rf.is_mei,
      },
      rf_data: rf,
    });
  } catch (e) {
    const status = e.message.includes('não encontrado') ? 404
                 : e.message.includes('Limite')         ? 429 : 500;
    res.status(status).json({ error: e.message });
  }
});

// POST /companies/:id/onboarding/step/regime
// Etapa 2: confirmar regime tributário detectado (ou escolher manualmente)
router.post('/step/regime', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { tax_regime } = req.body;
  const validRegimes = ['mei','simples_nacional','lucro_presumido','lucro_real'];
  if (!tax_regime || !validRegimes.includes(tax_regime))
    return res.status(400).json({ error: `tax_regime deve ser: ${validRegimes.join(' | ')}` });

  try {
    const { rows } = await db.query(
      `SELECT id, tax_regime FROM companies WHERE id=$1 AND owner_id=$2`, [cid, req.user.id]
    );
    if (!rows.length) return res.status(403).json({ error: 'Acesso negado' });

    const prevRegime = rows[0].tax_regime;
    await db.query(
      `UPDATE companies SET tax_regime=$1, onboarding_step='perfil', updated_at=NOW() WHERE id=$2`,
      [tax_regime, cid]
    );
    await db.query(
      `INSERT INTO onboarding_sessions (company_id, current_step, step_regime_done)
       VALUES ($1,'perfil',TRUE)
       ON CONFLICT (company_id) DO UPDATE
         SET current_step=CASE WHEN current_step='regime' THEN 'perfil' ELSE current_step END,
             step_regime_done=TRUE, updated_at=NOW()`,
      [cid]
    );
    // Audit log se mudou regime
    if (prevRegime !== tax_regime) {
      await db.query(
        `INSERT INTO audit_logs (company_id, user_id, action, entity_type, entity_id, old_value, new_value)
         VALUES ($1,$2,'tax_regime.changed','company',$1,$3,$4)`,
        [cid, req.user.id, JSON.stringify({tax_regime:prevRegime}), JSON.stringify({tax_regime})]
      );
    }
    res.json({ next_step: 'perfil', tax_regime });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /companies/:id/onboarding/step/perfil
// Etapa 3: dados complementares (nome fantasia, telefone, email)
router.post('/step/perfil', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { trade_name, phone, email, name } = req.body;
  try {
    const { rows } = await db.query(
      `SELECT id FROM companies WHERE id=$1 AND owner_id=$2`, [cid, req.user.id]
    );
    if (!rows.length) return res.status(403).json({ error: 'Acesso negado' });

    await db.query(
      `UPDATE companies SET
         trade_name = COALESCE($1, trade_name),
         phone      = COALESCE($2, phone),
         email      = COALESCE($3, email),
         legal_name = COALESCE($4, legal_name),
         onboarding_step = 'vertical',
         updated_at = NOW()
       WHERE id = $5`,
      [trade_name||null, phone||null, email||null, name||null, cid]
    );
    await db.query(
      `INSERT INTO onboarding_sessions (company_id, current_step, step_perfil_done)
       VALUES ($1,'vertical',TRUE)
       ON CONFLICT (company_id) DO UPDATE
         SET current_step=CASE WHEN current_step='perfil' THEN 'vertical' ELSE current_step END,
             step_perfil_done=TRUE, updated_at=NOW()`,
      [cid]
    );
    res.json({ next_step: 'vertical' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /companies/:id/onboarding/step/vertical
// Etapa 4: escolher vertical (ou pular)
router.post('/step/vertical', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { vertical } = req.body; // null = sem vertical
  const validVerticals = [null,'odonto','salao','estetica','academia','pet','food','moda'];
  if (!validVerticals.includes(vertical))
    return res.status(400).json({ error: 'Vertical inválido' });

  try {
    const { rows } = await db.query(
      `SELECT id FROM companies WHERE id=$1 AND owner_id=$2`, [cid, req.user.id]
    );
    if (!rows.length) return res.status(403).json({ error: 'Acesso negado' });

    await db.query(
      `UPDATE companies SET
         vertical_active = $1,
         vertical_enabled_at = CASE WHEN $1 IS NOT NULL THEN NOW() ELSE NULL END,
         onboarding_step = 'done',
         onboarding_completed_at = NOW(),
         updated_at = NOW()
       WHERE id = $2`,
      [vertical, cid]
    );
    await db.query(
      `INSERT INTO onboarding_sessions
         (company_id, current_step, step_vertical_done, completed_at)
       VALUES ($1,'done',TRUE,NOW())
       ON CONFLICT (company_id) DO UPDATE
         SET current_step='done', step_vertical_done=TRUE,
             completed_at=NOW(), updated_at=NOW()`,
      [cid]
    );
    res.json({
      next_step: 'done',
      onboarding_complete: true,
      vertical_active: vertical,
      message: 'Onboarding concluído! O checklist mensal foi gerado automaticamente.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /companies/:id/onboarding/restart
// Reinicia o onboarding (útil se empresa mudou de CNPJ)
router.post('/restart', requireAuth, async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows } = await db.query(
      `SELECT id FROM companies WHERE id=$1 AND owner_id=$2`, [cid, req.user.id]
    );
    if (!rows.length) return res.status(403).json({ error: 'Acesso negado' });
    await db.query(
      `UPDATE companies SET onboarding_step='cnpj', onboarding_completed_at=NULL WHERE id=$1`, [cid]
    );
    await db.query(
      `DELETE FROM onboarding_sessions WHERE company_id=$1`, [cid]
    );
    res.json({ ok: true, step: 'cnpj' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
