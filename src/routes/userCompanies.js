// ============================================================
// AURA. — User Companies (Multi-CNPJ M1-02 + M2-02 + M2-03 + M2-04)
// Endpoints user-level: não dependem de :companyId no path.
// Permite ao usuário listar suas empresas e criar adicionais.
//
// M2-02: após criar 2° CNPJ, sincroniza valor da subscription
// no Asaas via safeSyncSubscriptionValue (não bloqueia a resposta
// se o Asaas falhar — user já tem a empresa criada localmente).
//
// M2-03: POST /me/companies/:id/transfer-primary — torna outra
//        empresa a principal. Move o vínculo Asaas (customer +
//        subscription) e atualiza billing_owner_company_id de
//        TODAS as empresas do owner pra apontar pra nova primary.
//
// M2-04: DELETE /me/companies/:id desativa empresa secundária e
//        reduz a cobrança no próximo ciclo. NÃO remove primary
//        (precisa de transfer-primary primeiro).
//
// GET /me/companies/billing-preview: UI consulta valor antes de
// criar pra mostrar "vai custar mais R$X" no modal de adicionar.
// ============================================================
const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const db = require('../config/database');
const {
  calculateMulticnpjValue,
  safeSyncSubscriptionValue,
  PLAN_PRICES,
  EXTRA_PRICES,
  INCLUDED_CNPJS,
} = require('../utils/multicnpjBilling');

router.use(requireAuth);

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
// GET /me/companies/billing-preview
// Retorna o valor atual da assinatura E o que ela seria com
// +1 CNPJ. Usado pelo modal de "Adicionar empresa" pra mostrar
// "Sua mensalidade vai de R$X para R$Y" antes do user confirmar.
// ──────────────────────────────────────────────────────────
router.get('/billing-preview', async (req, res) => {
  try {
    const userId = req.user.id;
    const primaryRes = await db.query(
      `SELECT id, plan FROM companies
       WHERE owner_id = $1 AND is_primary = true AND is_active = true
       LIMIT 1`,
      [userId]
    );
    if (!primaryRes.rows.length) {
      return res.status(404).json({ error: 'Nenhuma empresa principal encontrada' });
    }
    const primaryId = primaryRes.rows[0].id;
    const planKey = String(primaryRes.rows[0].plan || '').toLowerCase();

    const current = await calculateMulticnpjValue(primaryId);
    if (!current) {
      return res.status(500).json({ error: 'Erro ao calcular valor atual' });
    }

    // Simula 1 empresa a mais
    const basePrice = PLAN_PRICES[planKey] || 0;
    const extraPrice = EXTRA_PRICES[planKey] || 0;
    const included = INCLUDED_CNPJS[planKey] || 1;
    const wouldBeTotal = current.total_companies + 1;
    const wouldBeExtras = Math.max(0, wouldBeTotal - included);
    const wouldBeMonthly = Math.round((basePrice + wouldBeExtras * extraPrice) * 100) / 100;
    const delta = Math.round((wouldBeMonthly - current.total_monthly) * 100) / 100;

    return res.json({
      current: current,
      if_add_one: {
        total_companies: wouldBeTotal,
        extra_cnpjs: wouldBeExtras,
        new_total_monthly: wouldBeMonthly,
        delta_monthly: delta,
      },
      can_add: planKey !== 'essencial',
      block_reason: planKey === 'essencial' ? 'Plano Essencial não permite multi-CNPJ' : null,
    });
  } catch (err) {
    console.error('[userCompanies] billing-preview error:', err.message);
    res.status(500).json({ error: 'Erro ao calcular preview' });
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
          'O plano Essencial inclui apenas 1 CNPJ. Faça upgrade para o plano Negócio (R$169,90/mês) que inclui até 2 CNPJs e desbloqueia: CRM, Folha, Agenda, WhatsApp, Canal Digital, IA Analista e mais.',
        current_plan: primary.plan,
        suggested_plan: 'negocio',
        suggested_plan_price: PLAN_PRICES.negocio,
        upgrade_savings_note:
          'Adicionar 2º CNPJ no Essencial custaria R$45/mês extra (total R$134). Migrar para Negócio custa R$169,90 e desbloqueia muito mais.',
      });
    }

    // 3. Contar CNPJs ativos do owner (pra dedup + audit metadata)
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

    // 7. M2-01: cálculo definitivo do billing preview (usa helper)
    //    Faz a contagem real DEPOIS do INSERT (currentCount era pré-insert).
    const billingCalc = await calculateMulticnpjValue(primary.id);

    // 8. M2-02: sincroniza com Asaas (não bloqueia se falhar — user
    //    já tem a empresa criada; sync rodará novamente em retries
    //    futuros, ex: ao trocar de empresa ou manualmente).
    const syncResult = await safeSyncSubscriptionValue(primary.id);

    // Decide a "note" exibida ao user com base no resultado real do sync
    let billingNote;
    if (syncResult.synced) {
      billingNote = `Mensalidade atualizada de R$${syncResult.old_value?.toFixed(2)} para R$${syncResult.new_value.toFixed(2)} no Asaas. Próxima fatura virá com o novo valor.`;
    } else if (syncResult.reason === 'no_subscription') {
      billingNote = 'Você está em período de teste. O valor será cobrado apenas quando ativar pagamento.';
    } else if (syncResult.reason === 'no_change') {
      billingNote = 'Nenhuma alteração de valor — esta empresa cabe nos CNPJs já inclusos do seu plano.';
    } else if (syncResult.reason === 'subscription_not_found_in_asaas') {
      billingNote = 'Atenção: sua assinatura no Asaas não foi encontrada. Reative o pagamento em Configurações > Faturamento.';
    } else if (syncResult.reason === 'error') {
      billingNote = 'Empresa criada. Houve um problema ao atualizar o Asaas — vamos tentar novamente em breve.';
      console.error('[userCompanies] Asaas sync failed (non-blocking):', syncResult.error);
    } else {
      billingNote = 'Mensalidade ajustada conforme tabela do plano.';
    }

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
      billing_preview: billingCalc ? {
        total_companies: billingCalc.total_companies,
        included_in_plan: billingCalc.included_in_plan,
        extra_cnpjs: billingCalc.extra_cnpjs,
        plan_base_price: billingCalc.base_price,
        extra_unit_price: billingCalc.extra_unit_price,
        extras_price: billingCalc.extras_value,
        new_total_monthly: billingCalc.total_monthly,
        note: billingNote,
        // Metadata adicional pra UI mostrar status real do Asaas
        asaas_synced: syncResult.synced,
        asaas_reason: syncResult.reason || null,
      } : {
        // Fallback se o helper falhar (improvável — primary acabou de ser lida)
        total_companies: currentCount + 1,
        included_in_plan: INCLUDED_CNPJS[planKey] || 1,
        new_total_monthly: PLAN_PRICES[planKey] || 0,
        note: 'Cálculo de mensalidade indisponível no momento.',
      },
      message: `Empresa "${newCompany.trade_name || newCompany.legal_name}" criada com sucesso.`,
    });
  } catch (err) {
    console.error('[userCompanies] POST error:', err.message, err.stack);
    return res.status(500).json({ error: 'Erro ao criar empresa' });
  }
});

// ──────────────────────────────────────────────────────────
// POST /me/companies/:companyId/transfer-primary  (M2-03)
// Torna companyId a nova empresa principal do owner.
//
// Efeitos:
//   - is_primary: troca entre as duas (transfer atômico)
//   - asaas_customer_id e asaas_subscription_id: movem da antiga
//     pra nova primary (a subscription ancorada migra junto)
//   - billing_owner_company_id: TODAS as empresas do owner que
//     apontavam pra antiga passam a apontar pra nova
//   - billing_status: a antiga vira 'active' (mantém vivo, mas
//     agora é uma "filha" de billing); a nova herda o status que
//     a antiga tinha
//
// Validações:
//   - target deve pertencer ao owner autenticado
//   - target deve estar ativa
//   - target NÃO pode já ser primary (no-op explícito)
//   - owner deve ter >= 2 empresas
//
// Atenção: o índice uq_companies_primary_per_owner é parcial em
// is_primary=true AND is_active=true. Por isso o swap precisa ser
// feito em UMA única statement com CASE (ou em transação com defer-
// red constraints). Optei por UPDATE com CASE — mais simples e 100%
// atômico em PostgreSQL.
// ──────────────────────────────────────────────────────────
router.post('/:companyId/transfer-primary', async (req, res) => {
  const userId = req.user.id;
  const targetId = req.params.companyId;

  if (!targetId) {
    return res.status(400).json({ error: 'companyId é obrigatório' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1. Lookup target + primary atual numa só query
    const { rows: ctx } = await client.query(
      `SELECT id, trade_name, legal_name, is_primary, is_active,
              asaas_customer_id, asaas_subscription_id, billing_status
         FROM companies
        WHERE owner_id = $1 AND is_active = true
        ORDER BY is_primary DESC`,
      [userId]
    );

    const target = ctx.find((c) => c.id === targetId);
    const currentPrimary = ctx.find((c) => c.is_primary === true);

    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Empresa não encontrada ou você não é o dono.',
      });
    }
    if (target.is_primary) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'ALREADY_PRIMARY',
        message: 'Esta empresa já é a principal.',
      });
    }
    if (!currentPrimary) {
      await client.query('ROLLBACK');
      return res.status(500).json({
        error: 'NO_CURRENT_PRIMARY',
        message: 'Estado inválido: não há empresa principal atual. Contate o suporte.',
      });
    }
    if (ctx.length < 2) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'NOT_ENOUGH_COMPANIES',
        message: 'Você precisa de pelo menos 2 empresas para transferir o título de principal.',
      });
    }

    // 2. Swap atômico — uma única statement.
    // Subtle: PostgreSQL valida unique indexes ao final do statement
    // (não por-linha), então este UPDATE de 2 rows não viola o
    // uq_companies_primary_per_owner mesmo com índice parcial.
    await client.query(
      `UPDATE companies
          SET is_primary = CASE
                WHEN id = $1 THEN true
                WHEN id = $2 THEN false
                ELSE is_primary
              END,
              -- Move o vínculo Asaas da antiga primary pra nova
              asaas_customer_id     = CASE WHEN id = $1 THEN $3 WHEN id = $2 THEN NULL ELSE asaas_customer_id END,
              asaas_subscription_id = CASE WHEN id = $1 THEN $4 WHEN id = $2 THEN NULL ELSE asaas_subscription_id END,
              -- billing_status: nova herda o da antiga; antiga vira 'active' (segue viva como filha)
              billing_status        = CASE
                WHEN id = $1 THEN $5::text
                WHEN id = $2 THEN 'active'
                ELSE billing_status
              END,
              updated_at = NOW()
        WHERE owner_id = $6
          AND id IN ($1, $2)`,
      [
        targetId,
        currentPrimary.id,
        currentPrimary.asaas_customer_id,
        currentPrimary.asaas_subscription_id,
        currentPrimary.billing_status || 'active',
        userId,
      ]
    );

    // 3. Re-aponta billing_owner_company_id de TODAS as empresas
    //    do owner que apontavam pra antiga primary → nova primary.
    //    Inclui a antiga primary (que agora vira filha apontando
    //    pra nova) e a própria nova (que aponta pra si mesma).
    await client.query(
      `UPDATE companies
          SET billing_owner_company_id = $1, updated_at = NOW()
        WHERE owner_id = $2
          AND is_active = true
          AND (billing_owner_company_id = $3 OR id = $1)`,
      [targetId, userId, currentPrimary.id]
    );

    // 4. Audit
    try {
      await client.query(
        `INSERT INTO multicnpj_audit
           (user_id, action, source_company_id, target_company_id, metadata)
         VALUES ($1, 'transfer_primary', $2, $3, $4::jsonb)`,
        [
          userId,
          currentPrimary.id,
          targetId,
          JSON.stringify({
            old_primary_name: currentPrimary.trade_name || currentPrimary.legal_name,
            new_primary_name: target.trade_name || target.legal_name,
            asaas_customer_moved: !!currentPrimary.asaas_customer_id,
            asaas_subscription_moved: !!currentPrimary.asaas_subscription_id,
          }),
        ]
      );
    } catch (auditErr) {
      console.error('[userCompanies] transfer-primary audit failed:', auditErr.message);
    }

    await client.query('COMMIT');

    return res.json({
      transferred: true,
      old_primary: {
        id: currentPrimary.id,
        name: currentPrimary.trade_name || currentPrimary.legal_name,
      },
      new_primary: {
        id: targetId,
        name: target.trade_name || target.legal_name,
      },
      asaas_customer_moved: !!currentPrimary.asaas_customer_id,
      asaas_subscription_moved: !!currentPrimary.asaas_subscription_id,
      message: `"${target.trade_name || target.legal_name}" agora é sua empresa principal.`,
      next_step: 'Atualize o switcher fazendo logout/login ou recarregue a página.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[userCompanies] transfer-primary error:', err.message, err.stack);
    return res.status(500).json({ error: 'Erro ao transferir título de principal' });
  } finally {
    client.release();
  }
});

// ──────────────────────────────────────────────────────────
// DELETE /me/companies/:companyId — desativa empresa secundária
// (M2-04)
//
// Comportamento:
//  - NÃO permite remover primary (precisa transfer-primary antes)
//  - Soft-delete via is_active=false (preserva histórico fiscal)
//  - Sincroniza Asaas pra reduzir mensalidade
//  - Audit log com ação remove_company
//
// Não permite remover se a empresa tem dados críticos pendentes
// (ex: NF-es não autorizadas, vendas em aberto). Aqui validamos
// apenas o caso "tem vendas" — outros gates podem ser adicionados.
// ──────────────────────────────────────────────────────────
router.delete('/:companyId', async (req, res) => {
  const userId = req.user.id;
  const companyId = req.params.companyId;

  if (!companyId) {
    return res.status(400).json({ error: 'companyId é obrigatório' });
  }

  try {
    // 1. Achar a empresa, validar acesso e que NÃO é primary
    const { rows } = await db.query(
      `SELECT id, trade_name, legal_name, is_primary, billing_owner_company_id
       FROM companies
       WHERE id = $1 AND owner_id = $2 AND is_active = true
       LIMIT 1`,
      [companyId, userId]
    );

    if (!rows.length) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Empresa não encontrada ou você não é o dono.',
      });
    }

    const company = rows[0];

    if (company.is_primary) {
      return res.status(403).json({
        error: 'CANNOT_REMOVE_PRIMARY',
        message:
          'Não é possível remover a empresa principal. Transfira o título de "principal" para outra empresa primeiro.',
      });
    }

    // 2. Bloquear se houver vendas registradas (preservação fiscal)
    const salesCheck = await db.query(
      `SELECT COUNT(*)::int AS total FROM sales WHERE company_id = $1 LIMIT 1`,
      [companyId]
    );
    if (salesCheck.rows[0]?.total > 0) {
      return res.status(409).json({
        error: 'HAS_SALES',
        message:
          'Esta empresa tem vendas registradas. Por questões fiscais, não é possível removê-la. Você pode desativá-la temporariamente entrando em contato com o suporte.',
        sales_count: salesCheck.rows[0].total,
      });
    }

    // 3. Soft-delete + capturar billing_owner pra sincronizar depois
    await db.query(
      `UPDATE companies
         SET is_active = false,
             updated_at = NOW()
       WHERE id = $1`,
      [companyId]
    );

    // 4. Audit
    try {
      await db.query(
        `INSERT INTO multicnpj_audit
           (user_id, action, source_company_id, target_company_id, metadata)
         VALUES ($1, 'remove_company', $2, $3, $4::jsonb)`,
        [
          userId,
          company.billing_owner_company_id,
          companyId,
          JSON.stringify({
            removed_company_name: company.trade_name || company.legal_name,
          }),
        ]
      );
    } catch (auditErr) {
      console.error('[userCompanies] DELETE audit failed:', auditErr.message);
    }

    // 5. Sincronizar Asaas (reduz mensalidade)
    const syncResult = await safeSyncSubscriptionValue(company.billing_owner_company_id);
    const billingCalc = await calculateMulticnpjValue(company.billing_owner_company_id);

    let note;
    if (syncResult.synced) {
      note = `Mensalidade reduzida de R$${syncResult.old_value?.toFixed(2)} para R$${syncResult.new_value.toFixed(2)}.`;
    } else if (syncResult.reason === 'no_subscription') {
      note = 'Empresa removida. Sem assinatura ativa para atualizar.';
    } else if (syncResult.reason === 'no_change') {
      note = 'Empresa removida. Mensalidade permanece a mesma (ainda dentro dos CNPJs inclusos).';
    } else {
      note = 'Empresa removida.';
    }

    return res.json({
      removed: true,
      company_id: companyId,
      company_name: company.trade_name || company.legal_name,
      billing_after: billingCalc ? {
        total_companies: billingCalc.total_companies,
        new_total_monthly: billingCalc.total_monthly,
      } : null,
      note,
    });
  } catch (err) {
    console.error('[userCompanies] DELETE error:', err.message, err.stack);
    return res.status(500).json({ error: 'Erro ao remover empresa' });
  }
});

module.exports = router;
