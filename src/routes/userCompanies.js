// ============================================================
// AURA. — User Companies (Multi-CNPJ M1-02)
// Endpoints user-level: não dependem de :companyId no path.
// Permite ao usuário listar suas empresas e criar adicionais.
// ============================================================
const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const db = require('../config/database');

router.use(requireAuth);

// ── Tabela de preços (deve casar com cálculo do M2-01) ────
const PLAN_PRICES = { essencial: 89, negocio: 169, expansao: 269 };
const EXTRA_PRICES = { essencial: 45, negocio: 85, expansao: 135 };
const INCLUDED_CNPJS = { essencial: 1, negocio: 2, expansao: 2, personalizado: 999 };

// ──────────────────────────────────────────────────────────
// GET /me/companies — lista empresas do usuário
// ──────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;
    const { rows } = await db.query(
      `SELECT
         c.id, c.trade_name, c.legal_name, c.cnpj, c.vertical_active,
         c.plan, c.is_primary, c.is_active, c.billing_status, c.logo_url,
         c.billing_owner_company_id, c.created_at,
         CASE
           WHEN c.owner_id = $1 THEN 'owner'
           ELSE COALESCE(cm.role_label, 'member')
         END AS role
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id AND cm.user_id = $1
        AND cm.status = 'active' AND cm.is_active = true
       WHERE (c.owner_id = $1 OR cm.user_id = $1)
         AND c.is_active = true
       ORDER BY c.is_primary DESC, c.created_at ASC`,
      [userId]
    );

    res.json({
      companies: rows.map((c) => ({
        id: c.id,
        name: c.trade_name || c.legal_name || '',
        legal_name: c.legal_name || '',
        trade_name: c.trade_name || '',
        cnpj: c.cnpj || '',
        vertical: c.vertical_active,
        plan: c.plan,
        is_primary: c.is_primary,
        billing_owner_company_id: c.billing_owner_company_id,
        billing_status: c.billing_status,
        logo_url: c.logo_url,
        role: c.role,
        created_at: c.created_at,
      })),
    });
  } catch (err) {
    console.error('[userCompanies] GET error:', err.message);
    res.status(500).json({ error: 'Erro ao listar empresas' });
  }
});

// ──────────────────────────────────────────────────────────
// POST /me/companies — cria empresa adicional
// Body: { legal_name (obrig), trade_name?, cnpj?, vertical?,
//         tax_regime?, email?, phone?, address? }
// ──────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const userId = req.user.id;
  const {
    legal_name,
    trade_name,
    cnpj,
    vertical,
    tax_regime,
    email,
    phone,
    address,
  } = req.body || {};

  if (!legal_name || String(legal_name).trim().length < 2) {
    return res
      .status(400)
      .json({ error: 'legal_name é obrigatório (mínimo 2 caracteres)' });
  }

  try {
    // 1. Achar a primary do user
    const primaryRes = await db.query(
      `SELECT id, plan, billing_owner_company_id, trade_name, legal_name
       FROM companies
       WHERE owner_id = $1 AND is_primary = true AND is_active = true
       LIMIT 1`,
      [userId]
    );

    if (!primaryRes.rows.length) {
      return res.status(400).json({
        error: 'NO_PRIMARY',
        message:
          'Você precisa ter uma empresa principal antes de adicionar outras. Complete o onboarding primeiro.',
      });
    }

    const primary = primaryRes.rows[0];
    const planKey = String(primary.plan || '').toLowerCase();

    // 2. Validar limite por plano (Essencial = 1 CNPJ apenas)
    if (planKey === 'essencial') {
      return res.status(403).json({
        error: 'PLAN_LIMIT_REACHED',
        message:
          'O plano Essencial inclui apenas 1 CNPJ. Faça upgrade para o plano Negócio (R$169/mês) que inclui até 2 CNPJs e desbloqueia: CRM, Folha, Agenda, WhatsApp, Canal Digital, IA Analista e mais.',
        current_plan: primary.plan,
        suggested_plan: 'negocio',
        suggested_plan_price: PLAN_PRICES.negocio,
        upgrade_savings_note:
          'Adicionar 2º CNPJ no Essencial custaria R$45/mês extra (total R$134). Migrar para Negócio custa R$169 e desbloqueia muito mais.',
      });
    }

    // 3. Contar CNPJs ativos do owner
    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM companies
       WHERE owner_id = $1 AND is_active = true`,
      [userId]
    );
    const currentCount = countRes.rows[0].total;

    // 4. Verificar duplicidade de CNPJ no escopo do owner
    let cleanCnpj = null;
    if (cnpj) {
      cleanCnpj = String(cnpj).replace(/\D/g, '');
      if (cleanCnpj.length !== 14) {
        return res
          .status(400)
          .json({ error: 'CNPJ inválido (deve ter 14 dígitos)' });
      }
      const dupRes = await db.query(
        `SELECT id, trade_name, legal_name FROM companies
         WHERE owner_id = $1
           AND REGEXP_REPLACE(COALESCE(cnpj, ''), '\\D', '', 'g') = $2
           AND is_active = true
         LIMIT 1`,
        [userId, cleanCnpj]
      );
      if (dupRes.rows.length) {
        return res.status(409).json({
          error: 'DUPLICATE_CNPJ',
          message: `Você já tem uma empresa cadastrada com este CNPJ: "${
            dupRes.rows[0].trade_name || dupRes.rows[0].legal_name
          }".`,
        });
      }
    }

    // 5. Criar a empresa (herda plano da primary, billing_owner = primary.id)
    const insertRes = await db.query(
      `INSERT INTO companies (
         owner_id, legal_name, trade_name, cnpj, vertical_active,
         tax_regime, plan, email, phone, address,
         is_primary, billing_owner_company_id,
         is_active, billing_status, onboarding_step
       ) VALUES (
         $1, $2, $3, $4, $5,
         COALESCE($6, 'simples_nacional'::tax_regime), $7::plan_type, $8, $9, $10,
         false, $11,
         true, 'active', 'completed'
       )
       RETURNING id, trade_name, legal_name, cnpj, plan,
                 vertical_active, is_primary, billing_owner_company_id, created_at`,
      [
        userId,
        String(legal_name).trim(),
        trade_name ? String(trade_name).trim() : null,
        cleanCnpj || cnpj || null,
        vertical || null,
        tax_regime,
        primary.plan, // herda plano
        email || null,
        phone || null,
        address || null,
        primary.id, // billing_owner = primary do mesmo owner
      ]
    );

    const newCompany = insertRes.rows[0];

    // 6. Audit (best-effort, não bloqueia resposta)
    try {
      await db.query(
        `INSERT INTO multicnpj_audit
           (user_id, action, source_company_id, target_company_id, metadata)
         VALUES ($1, 'add_company', $2, $3, $4::jsonb)`,
        [
          userId,
          primary.id,
          newCompany.id,
          JSON.stringify({
            new_count: currentCount + 1,
            previous_count: currentCount,
            plan: primary.plan,
            primary_company_name: primary.trade_name || primary.legal_name,
          }),
        ]
      );
    } catch (auditErr) {
      console.error('[userCompanies] audit insert failed:', auditErr.message);
    }

    // 7. Billing preview (cálculo definitivo no M2-01)
    const basePrice = PLAN_PRICES[planKey] || 0;
    const extraUnitPrice = EXTRA_PRICES[planKey] || 0;
    const includedCnpjs = INCLUDED_CNPJS[planKey] || 1;
    const newTotalCount = currentCount + 1;
    const extraCnpjs = Math.max(0, newTotalCount - includedCnpjs);
    const extrasPrice = extraCnpjs * extraUnitPrice;
    const totalPrice = basePrice + extrasPrice;

    return res.status(201).json({
      company: {
        id: newCompany.id,
        name: newCompany.trade_name || newCompany.legal_name,
        legal_name: newCompany.legal_name,
        trade_name: newCompany.trade_name,
        cnpj: newCompany.cnpj,
        plan: newCompany.plan,
        vertical: newCompany.vertical_active,
        is_primary: newCompany.is_primary,
        billing_owner_company_id: newCompany.billing_owner_company_id,
        created_at: newCompany.created_at,
      },
      billing_preview: {
        total_companies: newTotalCount,
        included_in_plan: includedCnpjs,
        extra_cnpjs: extraCnpjs,
        plan_base_price: basePrice,
        extra_unit_price: extraUnitPrice,
        extras_price: extrasPrice,
        new_total_monthly: totalPrice,
        note:
          'Cobrança via Asaas será atualizada no próximo ciclo (implementação completa em M2-01).',
      },
      message: `Empresa "${newCompany.trade_name || newCompany.legal_name}" criada com sucesso.`,
    });
  } catch (err) {
    console.error('[userCompanies] POST error:', err.message, err.stack);
    return res.status(500).json({ error: 'Erro ao criar empresa' });
  }
});

module.exports = router;
