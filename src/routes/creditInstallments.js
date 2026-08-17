/**
 * creditInstallments.js
 * Crediario parcelado -- vendas a prazo, score interno, regua de cobranca, dashboard inadimplencia.
 *
 * F1 (29/05/2026): applyPayment unificado no ledger.
 * Hub F1 (05/06/2026): PUT /plan-config com period_unit/period_count.
 * F2 (05/06/2026):
 *   - PUT /customers/:cid/terms -- persiste overrides de termos por cliente
 *   - GET /customers/:cid/profile -- adiciona campo `terms: { overrides, effective }`
 * F3 (05/06/2026):
 *   - POST /installments aceita account_id para vincular parcelas a um carne
 * F3.1 (06/06/2026):
 *   - PATCH /installments/:id/due-date -- edita vencimento com cascata nas parcelas seguintes
 * Hub F1.4 (07/06/2026):
 *   - GET /customers/:cid/profile: score_label, available_limit, account_id nas parcelas abertas
 *   - GET /plan-config + PUT /plan-config: score_warn_min (defensivo 42703)
 * Hub F1.4.1 (07/06/2026):
 *   - GET /customers/:cid/profile: score_warning (aviso nao-impeditivo)
 *   - POST /installments: warnings[] (SCORE_BELOW_MIN) sem bloquear.
 *     REGRA: score NUNCA bloqueia. Unico impeditivo e o bloqueio MANUAL
 *     (status === 'blocked' -> 422 CUSTOMER_BLOCKED), ja existente.
 * F2 PR1 (08/06/2026): encargos (mora/multa) — motor de leitura + tetos CDC.
 *   - PUT /plan-config: persiste late_charges_enabled + late_grace_days e
 *     valida TETO CDC (late_fee_rate <= 2%, late_interest_daily <= 1% a.m.).
 *   - PUT /customers/:cid/terms: mesma validacao de teto nos overrides.
 *   - GET /customers/:cid/profile + GET /installments: enriquecem parcelas
 *     abertas com late_fee/late_interest/charges_total/days_overdue/days_charged/total_due
 *     calculados lazy (sem persistir). Zero quando late_charges_enabled=false.
 *   - applyPayment (materializacao) NAO e tocado aqui — vem no PR2.
 * B2 (11/06/2026): Pix EMV real (copia-e-cola) no crediario.
 *   - GET /installments/:iid/pix — payload EMV da parcela (remaining + encargos do dia).
 *   - GET /customers/:cid/pix?amount=N — payload EMV de valor livre (sem cap por saldo).
 *   - POST /collection/trigger/:iid: mensagem usa o Pix copia-e-cola REAL
 *     (fallback: pix_link legado gravado na parcela).
 *   - Link fake pagar.getaura.com.br APOSENTADO: parcelas novas gravam pix_link NULL;
 *     o QR e gerado no FRONTEND a partir do payload (react-native-qrcode-svg).
 */

const express = require('express');
const pool = require('../config/database');
const creditLedger = require('../services/creditLedger');
const { buildStaticBrCode, validatePixKey, sanitizeTxid } = require('../services/staticPixService');
const collectionNotice = require('../services/credit/collectionNotice');

const router = express.Router({ mergeParams: true });

const SP_DATE = "(NOW() AT TIME ZONE 'America/Sao_Paulo')::date";

const nz = (v) => (v === undefined || v === null || v === '') ? null : v;

// F2 PR1: epsilon p/ comparacao de teto (evita falso-positivo por float).
const CAP_EPS = 1e-9;
const aboveCap = (v, cap) => v != null && v !== '' && Number(v) > cap + CAP_EPS;

// ─── B2: Pix EMV real (copia-e-cola) ────────────────────────────────────
// Chave Pix da loja: MESMO lookup do carne imprimivel (print.js /credit/:cid/carne)
// — digital_channel_config + fallbacks de nome/cidade em companies.
// Retorna null se nao ha chave configurada/valida (caller decide o erro).
async function resolvePixSetup(companyId) {
  let cfg = null;
  try {
    const { rows } = await pool.query(
      `SELECT pix_key, pix_key_type, pix_holder_name, pix_holder_city, site_name, address
         FROM digital_channel_config WHERE company_id = $1`,
      [companyId]
    );
    cfg = rows[0] || null;
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
    return null;
  }
  if (!cfg || !cfg.pix_key || !String(cfg.pix_key).trim()) return null;
  const validation = validatePixKey(cfg.pix_key, cfg.pix_key_type);
  if (!validation.valid) return null;

  // companies NAO tem coluna `name` — COALESCE(trade_name, legal_name)
  let company = {};
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(trade_name, legal_name) AS display_name, address_city
         FROM companies WHERE id = $1`,
      [companyId]
    );
    company = rows[0] || {};
  } catch (_) { company = {}; }

  let city = cfg.pix_holder_city;
  if (!city && cfg.address) {
    const parts = String(cfg.address).split(',').map(s => s.trim());
    city = parts[parts.length - 2] || parts[parts.length - 1] || '';
  }

  return {
    pixKey:  validation.normalized,
    keyType: cfg.pix_key_type || null,
    name:    cfg.pix_holder_name || cfg.site_name || company.display_name || 'AURA NEGOCIO',
    city:    city || company.address_city || 'BRASIL',
  };
}

// B2: config + profile p/ engine de encargos lazy (defensivo 42703/42P01).
// Mesma conta usada no GET /customers/:cid/profile.
async function loadLateContext(companyId, customerId) {
  // So 42703/42P01 (deploy parcial) sao fallback silencioso; qualquer outro
  // erro (ex.: transiente de banco) e logado p/ nao passar despercebido,
  // mas segue com config/profile null (nao derruba a rota).
  let config = null;
  try {
    const cfg = await pool.query(`SELECT * FROM credit_plan_configs WHERE company_id = $1`, [companyId]);
    config = cfg.rows[0] || null;
  } catch (err) {
    if (err.code !== '42703' && err.code !== '42P01') {
      console.warn('[credit/pix] loadLateContext falhou:', err.message);
    }
    config = null;
  }
  let profile = null;
  if (customerId) {
    try {
      const prof = await pool.query(
        `SELECT * FROM customer_credit_profiles WHERE company_id = $1 AND customer_id = $2`,
        [companyId, customerId]
      );
      profile = prof.rows[0] || null;
    } catch (err) {
      if (err.code !== '42703' && err.code !== '42P01') {
        console.warn('[credit/pix] loadLateContext falhou:', err.message);
      }
      profile = null;
    }
  }
  return { config, profile };
}

function buildWhatsAppMessage(template, params = {}) {
  const { customerName = 'Cliente', storeName = 'Loja', amount = '0,00',
          dueDate = '', installmentNum = '', totalInstallments = '',
          pixLink = '', daysLate = '' } = params;
  const templates = {
    lembrete:    `Ola, ${customerName}! Lembrete: a parcela ${installmentNum}/${totalInstallments} de R$ ${amount} vence em *${dueDate}*. Pague via PIX: ${pixLink} -- *${storeName}*`,
    confirmacao: `Ola, ${customerName}! Amanha vence sua parcela ${installmentNum}/${totalInstallments} de R$ ${amount}. PIX rapido: ${pixLink} -- *${storeName}*`,
    vencimento:  `${customerName}, a parcela ${installmentNum}/${totalInstallments} de R$ ${amount} vence *hoje*. Evite juros: ${pixLink} -- *${storeName}*`,
    atraso_1:    `${customerName}, sua parcela ${installmentNum}/${totalInstallments} de R$ ${amount} esta *${daysLate} dias* em atraso. Regularize agora: ${pixLink} -- *${storeName}*`,
    atraso_2:    `${customerName}, identificamos debito de R$ ${amount} com *${daysLate} dias* de atraso. Acesse ${pixLink} ou entre em contato. -- *${storeName}*`,
    bloqueio:    `${customerName}, seu credito em *${storeName}* foi suspenso por inadimplencia. Regularize: ${pixLink} ou fale com a loja.`,
  };
  return templates[template] || templates.lembrete;
}

async function assertCrediarioEnabled(req, res, next) {
  try {
    const result = await pool.query(
      `SELECT pdv_settings->>'crediario_enabled' AS enabled FROM companies WHERE id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Empresa nao encontrada.' });
    if (result.rows[0]?.enabled !== 'true') {
      return res.status(403).json({
        error: 'Crediario nao habilitado. Ative em Configuracoes > PDV > Politicas do Caixa.',
        code: 'CREDIARIO_DISABLED',
      });
    }
    next();
  } catch (err) { next(err); }
}

router.use(assertCrediarioEnabled);

// ─── GET /credit/customers/:cid/profile ──────────────────────────────────
// F2: adiciona campo `terms: { overrides, effective }` ao perfil.
// Hub F1.4: score_label, available_limit, account_id nas parcelas abertas.
// Hub F1.4.1: score_warning (aviso nao-impeditivo).
// F2 PR1: parcelas abertas enriquecidas com encargos lazy (mora/multa) + total_due.
router.get('/customers/:cid/profile', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;
  const client = await pool.connect();
  try {
    const profile = await creditLedger._getOrCreateProfile(client, companyId, customerId);
    if (!profile) return res.json({ score: 500, label: 'regular', credit_limit: 0, credit_used: 0, status: 'active', terms: { overrides: {}, effective: {} } });
    const config = await creditLedger._getOrCreatePlanConfig(client, companyId);

    // account_id: coluna adicionada na migration 163. SELECT defensivo via RETURNING * e coluna pode nao estar no pg client antigo;
    // usar try/catch individual para manter retrocompatibilidade.
    let installmentRows = [];
    try {
      const r = await client.query(
        `SELECT id, installment_number, total_installments, amount_due, covered_amount,
                due_date, status, pix_link, late_fee, late_interest, collection_stage, account_id
         FROM credit_installments
         WHERE company_id = $1 AND customer_id = $2 AND status IN ('pending','overdue')
         ORDER BY due_date ASC`,
        [companyId, customerId]
      );
      installmentRows = r.rows;
    } catch (e) {
      if (e.code === '42703') {
        // account_id ainda nao existe (deploy parcial) — fallback sem a coluna
        const r = await client.query(
          `SELECT id, installment_number, total_installments, amount_due, covered_amount,
                  due_date, status, pix_link, late_fee, late_interest, collection_stage
           FROM credit_installments
           WHERE company_id = $1 AND customer_id = $2 AND status IN ('pending','overdue')
           ORDER BY due_date ASC`,
          [companyId, customerId]
        );
        installmentRows = r.rows;
      } else throw e;
    }

    // F2: termos resolvidos (reutilizados pelo engine de encargos abaixo)
    const terms = creditLedger.resolveTerms(profile, config);

    // Hub F1.4: score_label e available_limit
    const creditScore = parseInt(profile.credit_score) || 500;
    const creditLimit = Number(profile.credit_limit || 0);
    const creditUsed  = Number(profile.credit_used  || 0);
    const availableLimit = Math.max(creditLimit - creditUsed, 0);

    res.json({
      ...profile,
      score_label:     creditLedger.scoreLabel(creditScore),
      // Hub F1.4.1: aviso nao-impeditivo. null = sem aviso.
      score_warning:   creditLedger.scoreWarning(creditScore, config),
      available_limit: availableLimit,
      config,
      terms,
      // F2 PR1: encargos lazy (mora/multa) por parcela. Zero se capability OFF.
      open_installments: installmentRows.map(i => {
        const remaining = parseFloat((parseFloat(i.amount_due) - parseFloat(i.covered_amount || 0)).toFixed(2));
        const lc = creditLedger.computeLateCharges(i, terms, config);
        return {
          ...i,
          account_id:    i.account_id || null,
          remaining,
          late_fee:      lc.late_fee,
          late_interest: lc.late_interest,
          charges_total: lc.charges_total,
          days_overdue:  lc.days_overdue,
          days_charged:  lc.days_charged,
          total_due:     parseFloat((remaining + lc.charges_total).toFixed(2)),
        };
      }),
    });
  } catch (err) {
    console.error('GET /credit/customers/:cid/profile', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── GET /credit/customers/:cid/pix?amount=N (B2) ─────────────────────────
// Payload EMV (Pix copia-e-cola) de VALOR LIVRE.
// Sem cap por saldo: pagamento acima do devido vira credito em conta
// (decisao de produto). QR e gerado no FRONTEND a partir do payload.
router.get('/customers/:cid/pix', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;
  const amount = Number(req.query.amount);
  if (!isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'amount deve ser um numero maior que zero.' });
  }
  try {
    const { rows: custRows } = await pool.query(
      `SELECT id FROM customers WHERE id = $1 AND company_id = $2`,
      [customerId, companyId]
    );
    if (!custRows.length) return res.status(404).json({ error: 'Cliente nao encontrado nesta empresa.' });

    const pix = await resolvePixSetup(companyId);
    if (!pix) {
      return res.status(422).json({
        error: 'Chave Pix nao configurada. Configure em Canal Digital > Pagamentos.',
        code:  'PIX_KEY_MISSING',
      });
    }

    const txid = sanitizeTxid('CREDL' + String(customerId).replace(/-/g, ''));
    const emv = buildStaticBrCode({
      pixKey:          pix.pixKey,
      amount:          creditLedger.round2(amount),
      beneficiaryName: pix.name,
      beneficiaryCity: pix.city,
      txid,
    });

    res.json({
      emv,
      amount:        creditLedger.round2(amount),
      key_type:      pix.keyType,
      merchant_name: pix.name,
    });
  } catch (err) {
    console.error('GET /credit/customers/:cid/pix', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /credit/customers/:cid/terms (F2) ──────────────────────────────────────
// Persiste overrides de termos por cliente. null limpa o override (volta ao padrao da loja).
// F2 PR1: valida TETO CDC para late_fee_rate / late_interest_daily.
router.put('/customers/:cid/terms', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;
  const {
    interest_rate,
    max_installments,
    period_unit,
    period_count,
    due_day,
    late_fee_rate,
    late_interest_daily,
  } = req.body || {};

  // Valida period_unit se fornecido (nao null)
  if (period_unit !== undefined && period_unit !== null &&
      !['day', 'week', 'month'].includes(period_unit)) {
    return res.status(400).json({ error: 'period_unit deve ser day, week ou month' });
  }

  // F2 PR1: teto CDC (imutavel). Acima do teto -> 422 (override nao pode furar o teto).
  if (aboveCap(late_fee_rate, creditLedger.LATE_FEE_MAX)) {
    return res.status(422).json({ code: 'LATE_FEE_ABOVE_CAP', max: creditLedger.LATE_FEE_MAX });
  }
  if (aboveCap(late_interest_daily, creditLedger.LATE_INTEREST_DAILY_MAX)) {
    return res.status(422).json({ code: 'LATE_INTEREST_ABOVE_CAP', max: creditLedger.LATE_INTEREST_DAILY_MAX });
  }

  const client = await pool.connect();
  try {
    // Garante que perfil existe
    await creditLedger._getOrCreateProfile(client, companyId, customerId);

    // Monta SET dinamico apenas para os campos enviados no body
    // Se o campo vier como null -> NULL (limpa override)
    // Se o campo nao vier -> nao altera (COALESCE com valor atual)
    const setClauses = [];
    const params = [companyId, customerId];
    let idx = 3;

    const fieldMap = {
      interest_rate:       'term_interest_rate',
      max_installments:    'term_max_installments',
      period_unit:         'term_period_unit',
      period_count:        'term_period_count',
      due_day:             'term_due_day',
      late_fee_rate:       'term_late_fee_rate',
      late_interest_daily: 'term_late_interest_daily',
    };

    for (const [bodyField, dbCol] of Object.entries(fieldMap)) {
      if (req.body && bodyField in req.body) {
        setClauses.push(`${dbCol} = $${idx}`);
        params.push(req.body[bodyField] === null ? null : req.body[bodyField]);
        idx++;
      }
    }

    if (!setClauses.length) {
      return res.status(400).json({ error: 'Nenhum campo de termo fornecido' });
    }
    setClauses.push('updated_at = NOW()');

    let r;
    try {
      r = await client.query(
        `UPDATE customer_credit_profiles
           SET ${setClauses.join(', ')}
         WHERE company_id = $1 AND customer_id = $2
         RETURNING *`,
        params
      );
    } catch (e) {
      if (e.code === '42703') {
        // Colunas term_* ainda nao existem (deploy parcial)
        return res.status(503).json({ error: 'Colunas de termos ainda nao disponiveis. Aguarde o deploy completo.' });
      }
      throw e;
    }

    if (!r.rows.length) return res.status(404).json({ error: 'Perfil nao encontrado' });

    const profile = r.rows[0];
    const config = await creditLedger._getOrCreatePlanConfig(client, companyId);
    const terms = creditLedger.resolveTerms(profile, config);

    res.json({ ...profile, terms });
  } catch (err) {
    console.error('PUT /credit/customers/:cid/terms', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── PUT /credit/customers/:cid/limit ─────────────────────────────────
router.put('/customers/:cid/limit', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;
  const { credit_limit } = req.body;
  if (credit_limit === undefined || isNaN(parseFloat(credit_limit))) {
    return res.status(400).json({ error: 'credit_limit e obrigatorio e deve ser numerico.' });
  }
  const client = await pool.connect();
  try {
    await creditLedger._getOrCreateProfile(client, companyId, customerId);
    const r = await client.query(
      `UPDATE customer_credit_profiles
         SET credit_limit = $3, updated_at = NOW()
       WHERE company_id = $1 AND customer_id = $2 RETURNING *`,
      [companyId, customerId, parseFloat(credit_limit)]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error('PUT /credit/customers/:cid/limit', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── PATCH /credit/customers/:cid/block ────────────────────────────────
router.patch('/customers/:cid/block', async (req, res) => {
  const companyId  = req.params.id;
  const customerId = req.params.cid;
  const { action, reason } = req.body;
  if (!['block', 'unblock'].includes(action)) {
    return res.status(400).json({ error: 'action deve ser "block" ou "unblock".' });
  }
  const client = await pool.connect();
  try {
    const r = await client.query(
      `UPDATE customer_credit_profiles
         SET status = $3, blocked_reason = $4, updated_at = NOW()
       WHERE company_id = $1 AND customer_id = $2 RETURNING *`,
      [companyId, customerId,
       action === 'block' ? 'blocked' : 'active',
       action === 'block' ? (reason || 'Bloqueio manual') : null]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Perfil nao encontrado.' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('PATCH /credit/customers/:cid/block', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── GET/PUT /credit/plan-config ───────────────────────────────────────
// Hub F1.4: GET tambem retorna score_warn_min (via RETURNING *; defensivo se coluna faltar).
// F2 PR1: GET retorna late_charges_enabled + late_grace_days (via RETURNING *).
router.get('/plan-config', async (req, res) => {
  const client = await pool.connect();
  try {
    // _getOrCreatePlanConfig usa RETURNING * — se as colunas novas existirem, vem automaticamente.
    // Se a coluna nao existir ainda (42703), retorna config sem ela.
    let config;
    try {
      config = await creditLedger._getOrCreatePlanConfig(client, req.params.id);
    } catch (e) {
      if (e.code === '42703') {
        // fallback: busca sem as colunas novas
        const r = await client.query(
          `INSERT INTO credit_plan_configs (company_id)
           VALUES ($1)
           ON CONFLICT (company_id) DO UPDATE SET updated_at = NOW()
           RETURNING id, company_id, max_installments, min_installment_value,
                     interest_rate, late_fee_rate, late_interest_daily,
                     auto_block_days, require_score_min, period_unit, period_count, updated_at`,
          [req.params.id]
        );
        config = r.rows[0] || null;
      } else throw e;
    }
    res.json(config || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// Hub F1.4: PUT tambem aceita score_warn_min. Padrao defensivo identico ao existente:
// se a coluna 42703, ignora graciosamente (nao bloqueia o save dos outros campos).
// F2 PR1: aceita/persiste late_charges_enabled + late_grace_days e valida TETO CDC
//         (late_fee_rate <= 2%, late_interest_daily <= 1% a.m.). Acima -> 422.
router.put('/plan-config', async (req, res) => {
  const { max_installments, min_installment_value, interest_rate,
          late_fee_rate, late_interest_daily, auto_block_days,
          require_score_min, period_unit, period_count, score_warn_min,
          late_charges_enabled, late_grace_days } = req.body;
  const safeUnit = ['day', 'week', 'month'].includes(period_unit) ? period_unit : null;

  // F2 PR1: teto CDC (imutavel). Acima do teto -> 422 (a loja nao pode furar o teto).
  if (aboveCap(late_fee_rate, creditLedger.LATE_FEE_MAX)) {
    return res.status(422).json({ code: 'LATE_FEE_ABOVE_CAP', max: creditLedger.LATE_FEE_MAX });
  }
  if (aboveCap(late_interest_daily, creditLedger.LATE_INTEREST_DAILY_MAX)) {
    return res.status(422).json({ code: 'LATE_INTEREST_ABOVE_CAP', max: creditLedger.LATE_INTEREST_DAILY_MAX });
  }

  const client = await pool.connect();
  try {
    // Tenta salvar com score_warn_min + late_charges_enabled + late_grace_days
    let r;
    try {
      r = await client.query(
        `INSERT INTO credit_plan_configs (company_id, max_installments, min_installment_value,
           interest_rate, late_fee_rate, late_interest_daily, auto_block_days,
           require_score_min, period_unit, period_count, score_warn_min,
           late_charges_enabled, late_grace_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'month'),COALESCE($10,1),$11,
                 COALESCE($12,false),COALESCE($13,3))
         ON CONFLICT (company_id) DO UPDATE SET
           max_installments      = COALESCE($2, credit_plan_configs.max_installments),
           min_installment_value = COALESCE($3, credit_plan_configs.min_installment_value),
           interest_rate         = COALESCE($4, credit_plan_configs.interest_rate),
           late_fee_rate         = COALESCE($5, credit_plan_configs.late_fee_rate),
           late_interest_daily   = COALESCE($6, credit_plan_configs.late_interest_daily),
           auto_block_days       = COALESCE($7, credit_plan_configs.auto_block_days),
           require_score_min     = COALESCE($8, credit_plan_configs.require_score_min),
           period_unit           = COALESCE($9, credit_plan_configs.period_unit),
           period_count          = COALESCE($10, credit_plan_configs.period_count),
           score_warn_min        = COALESCE($11, credit_plan_configs.score_warn_min),
           late_charges_enabled  = COALESCE($12, credit_plan_configs.late_charges_enabled),
           late_grace_days       = COALESCE($13, credit_plan_configs.late_grace_days),
           updated_at            = NOW()
         RETURNING *`,
        [req.params.id,
         nz(max_installments), nz(min_installment_value), nz(interest_rate),
         nz(late_fee_rate), nz(late_interest_daily), nz(auto_block_days),
         nz(require_score_min), safeUnit, nz(period_count), nz(score_warn_min),
         nz(late_charges_enabled), nz(late_grace_days)]
      );
    } catch (e) {
      if (e.code === '42703') {
        // Alguma coluna nova ainda nao existe (deploy parcial) -- salva com o set antigo
        r = await client.query(
          `INSERT INTO credit_plan_configs (company_id, max_installments, min_installment_value,
             interest_rate, late_fee_rate, late_interest_daily, auto_block_days,
             require_score_min, period_unit, period_count)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,'month'),COALESCE($10,1))
           ON CONFLICT (company_id) DO UPDATE SET
             max_installments      = COALESCE($2, credit_plan_configs.max_installments),
             min_installment_value = COALESCE($3, credit_plan_configs.min_installment_value),
             interest_rate         = COALESCE($4, credit_plan_configs.interest_rate),
             late_fee_rate         = COALESCE($5, credit_plan_configs.late_fee_rate),
             late_interest_daily   = COALESCE($6, credit_plan_configs.late_interest_daily),
             auto_block_days       = COALESCE($7, credit_plan_configs.auto_block_days),
             require_score_min     = COALESCE($8, credit_plan_configs.require_score_min),
             period_unit           = COALESCE($9, credit_plan_configs.period_unit),
             period_count          = COALESCE($10, credit_plan_configs.period_count),
             updated_at            = NOW()
           RETURNING *`,
          [req.params.id,
           nz(max_installments), nz(min_installment_value), nz(interest_rate),
           nz(late_fee_rate), nz(late_interest_daily), nz(auto_block_days),
           nz(require_score_min), safeUnit, nz(period_count)]
        );
      } else throw e;
    }
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── POST /credit/installments ───────────────────────────────────────────
// F3: aceita account_id para vincular parcelas ao carne
// Hub F1.4.1: aviso de score NAO-impeditivo (warnings[]). UNICO impeditivo
//             continua sendo o bloqueio MANUAL (status === 'blocked' -> 422).
// B2: pix_link fake aposentado — parcelas novas gravam NULL; o Pix real (EMV)
//     e gerado on-demand via GET /installments/:iid/pix.
router.post('/installments', async (req, res) => {
  const companyId = req.params.id;
  const { customer_id, sale_id, total_amount, installments, first_due_date,
          period_unit, period_count, account_id } = req.body;
  if (!customer_id || !total_amount || !installments || !first_due_date) {
    return res.status(400).json({ error: 'customer_id, total_amount, installments e first_due_date sao obrigatorios.' });
  }
  const n = parseInt(installments);
  const total = parseFloat(total_amount);
  if (isNaN(n) || n < 1 || n > 100) return res.status(400).json({ error: 'installments deve ser entre 1 e 100.' });
  if (isNaN(total) || total <= 0)   return res.status(400).json({ error: 'total_amount invalido.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const profile = await creditLedger._getOrCreateProfile(client, companyId, customer_id);
    // UNICO impeditivo: bloqueio MANUAL do cliente.
    if (profile?.status === 'blocked') {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: `Cliente com credito bloqueado. Motivo: ${profile.blocked_reason || 'Bloqueio manual'}.`,
        code: 'CUSTOMER_BLOCKED',
      });
    }
    const config = await creditLedger._getOrCreatePlanConfig(client, companyId);
    if (config && n > parseInt(config.max_installments)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Maximo de ${config.max_installments} parcelas configurado.` });
    }

    // Aviso de score NAO-impeditivo. NUNCA retorna erro por score.
    const scoreWarn = creditLedger.scoreWarning(parseInt(profile?.credit_score, 10) || 500, config);
    const warnings = scoreWarn
      ? [{ code: 'SCORE_BELOW_MIN', threshold: scoreWarn.threshold, actual: scoreWarn.actual }]
      : [];

    const period = creditLedger.resolvePeriod(period_unit, period_count, config);
    const effectiveRate = parseFloat(config?.interest_rate) || 0;
    const totalWithInterest = effectiveRate > 0
      ? parseFloat((total * (1 + effectiveRate * n)).toFixed(2))
      : total;
    const baseAmount = Math.floor((totalWithInterest / n) * 100) / 100;
    const remainder  = Math.round((totalWithInterest - baseAmount * n) * 100) / 100;

    const createdInstallments = [];
    for (let i = 1; i <= n; i++) {
      const amount     = i === n ? baseAmount + remainder : baseAmount;
      const dueDateStr = creditLedger.dueDateForIndex(first_due_date, period.unit, period.count, i - 1);
      let row;
      try {
        const ins = await client.query(
          `INSERT INTO credit_installments
             (company_id, sale_id, customer_id, installment_number, total_installments,
              amount_due, due_date, status, covered_amount, account_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',0,$8) RETURNING *`,
          [companyId, sale_id || null, customer_id, i, n, amount, dueDateStr, account_id || null]
        );
        row = ins.rows[0];
      } catch (e) {
        if (e.code === '42703') {
          const ins = await client.query(
            `INSERT INTO credit_installments
               (company_id, sale_id, customer_id, installment_number, total_installments,
                amount_due, due_date, status, covered_amount)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',0) RETURNING *`,
            [companyId, sale_id || null, customer_id, i, n, amount, dueDateStr]
          );
          row = ins.rows[0];
        } else throw e;
      }
      // B2: sem UPDATE de pix_link — o campo fica NULL (link fake aposentado).
      createdInstallments.push(row);
    }
    if (sale_id) {
      try {
        await client.query(
          `UPDATE sales SET is_installment=true, total_installments=$2, credit_plan_snapshot=$3
           WHERE id=$1 AND company_id=$4`,
          [sale_id, n, JSON.stringify({ installments: n, total_amount: total, interest_rate: effectiveRate,
                                        period_unit: period.unit, period_count: period.count }), companyId]
        );
      } catch (e) { if (e.code !== '42703' && e.code !== '42P01') throw e; }
    }
    await creditLedger._updateCreditUsed(client, companyId, customer_id);
    await client.query('COMMIT');
    res.status(201).json({ installments: createdInstallments, warnings });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /credit/installments', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── GET /credit/installments ──────────────────────────────────────────────
// F2 PR1: cada parcela e enriquecida com encargos lazy (mora/multa) + total_due.
//         config (e profile, se customer_id no filtro) sao carregados 1x por request.
router.get('/installments', async (req, res) => {
  const companyId = req.params.id;
  const { customer_id, status, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  let where = 'WHERE ci.company_id = $1';
  const vals = [companyId];
  let idx = 2;
  if (customer_id) { where += ` AND ci.customer_id = $${idx++}`; vals.push(customer_id); }
  if (status)      { where += ` AND ci.status = $${idx++}`;       vals.push(status); }
  try {
    await pool.query(
      `UPDATE credit_installments SET status='overdue'
       WHERE company_id=$1 AND status='pending' AND due_date < ${SP_DATE}`,
      [companyId]
    );
    // Reverte status invalido: parcelas com due_date futura nunca devem ser overdue
    await pool.query(
      `UPDATE credit_installments SET status='pending'
       WHERE company_id=$1 AND status='overdue' AND due_date >= ${SP_DATE}`,
      [companyId]
    );
    const r = await pool.query(
      `SELECT ci.*,
              (ci.amount_due - ci.covered_amount) AS remaining_amount,
              COALESCE(c.name, c.phone) AS customer_name,
              c.phone AS customer_phone
       FROM credit_installments ci
       LEFT JOIN customers c ON c.id=ci.customer_id AND c.company_id=ci.company_id
       ${where}
       ORDER BY ci.due_date ASC
       LIMIT $${idx} OFFSET $${idx+1}`,
      [...vals, parseInt(limit), offset]
    );
    const count = await pool.query(`SELECT COUNT(*) FROM credit_installments ci ${where}`, vals);

    // F2 PR1: carrega config 1x (e profile do cliente filtrado, se houver) e
    // enriquece cada linha com encargos lazy. resolveTerms reaproveitado p/ todas.
    let lateConfig = null;
    try {
      const cfg = await pool.query(`SELECT * FROM credit_plan_configs WHERE company_id=$1`, [companyId]);
      lateConfig = cfg.rows[0] || null;
    } catch (_) { lateConfig = null; }
    let lateProfile = null;
    if (customer_id) {
      try {
        const prof = await pool.query(
          `SELECT * FROM customer_credit_profiles WHERE company_id=$1 AND customer_id=$2`,
          [companyId, customer_id]
        );
        lateProfile = prof.rows[0] || null;
      } catch (_) { lateProfile = null; }
    }
    const lateTerms = creditLedger.resolveTerms(lateProfile, lateConfig);

    const data = r.rows.map(row => {
      const remaining = parseFloat((parseFloat(row.amount_due) - parseFloat(row.covered_amount || 0)).toFixed(2));
      const lc = creditLedger.computeLateCharges(row, lateTerms, lateConfig);
      return {
        ...row,
        late_fee:      lc.late_fee,
        late_interest: lc.late_interest,
        charges_total: lc.charges_total,
        days_overdue:  lc.days_overdue,
        days_charged:  lc.days_charged,
        total_due:     parseFloat((remaining + lc.charges_total).toFixed(2)),
      };
    });

    res.json({ data, total: parseInt(count.rows[0].count), page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('GET /credit/installments', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /credit/installments/:iid/pix (B2) ──────────────────────────────────
// Payload EMV (Pix copia-e-cola) da parcela. Valor devido HOJE:
// remaining + encargos lazy (mesma conta do GET /customers/:cid/profile).
// Encargos OFF (late_charges_enabled=false) => so remaining.
// QR e gerado no FRONTEND a partir do payload (react-native-qrcode-svg).
router.get('/installments/:iid/pix', async (req, res) => {
  const companyId     = req.params.id;
  const installmentId = req.params.iid;
  try {
    const { rows } = await pool.query(
      `SELECT ci.*, COALESCE(c.name, c.phone) AS customer_name
         FROM credit_installments ci
         LEFT JOIN customers c ON c.id = ci.customer_id AND c.company_id = ci.company_id
        WHERE ci.id = $1 AND ci.company_id = $2`,
      [installmentId, companyId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Parcela nao encontrada.' });
    const inst = rows[0];
    if (inst.status === 'paid') {
      return res.status(409).json({ error: 'Parcela ja paga.', code: 'INSTALLMENT_PAID' });
    }
    if (inst.status === 'cancelled') {
      return res.status(409).json({ error: 'Parcela cancelada.', code: 'INSTALLMENT_CANCELLED' });
    }

    const { config, profile } = await loadLateContext(companyId, inst.customer_id);
    const terms = creditLedger.resolveTerms(profile, config);
    const remaining = parseFloat((parseFloat(inst.amount_due) - parseFloat(inst.covered_amount || 0)).toFixed(2));
    const lc = creditLedger.computeLateCharges(inst, terms, config);
    const amount = parseFloat((remaining + lc.charges_total).toFixed(2));
    if (amount <= 0) {
      return res.status(409).json({ error: 'Parcela sem valor em aberto.', code: 'NOTHING_DUE' });
    }

    const pix = await resolvePixSetup(companyId);
    if (!pix) {
      return res.status(422).json({
        error: 'Chave Pix nao configurada. Configure em Canal Digital > Pagamentos.',
        code:  'PIX_KEY_MISSING',
      });
    }

    const txid = sanitizeTxid('CRED' + String(installmentId).replace(/-/g, ''));
    const emv = buildStaticBrCode({
      pixKey:          pix.pixKey,
      amount,
      beneficiaryName: pix.name,
      beneficiaryCity: pix.city,
      txid,
    });

    res.json({
      emv,
      amount,
      key_type:      pix.keyType,
      merchant_name: pix.name,
      installment: {
        id:         inst.id,
        number:     inst.installment_number,
        due_date:   inst.due_date,
        account_id: inst.account_id || null,
      },
    });
  } catch (err) {
    console.error('GET /credit/installments/:iid/pix', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /credit/installments/:iid/pay ────────────────────────────────────
router.patch('/installments/:iid/pay', async (req, res) => {
  const companyId     = req.params.id;
  const installmentId = req.params.iid;
  const { amount_paid, payment_method } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const cur = await client.query(
      `SELECT * FROM credit_installments WHERE id=$1 AND company_id=$2 FOR UPDATE`,
      [installmentId, companyId]
    );
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Parcela nao encontrada.' });
    }
    const ins = cur.rows[0];
    if (ins.status === 'paid')      { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Parcela ja paga.' }); }
    if (ins.status === 'cancelled') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Parcela cancelada.' }); }

    let activeSessaoId = null;
    try {
      const sessRes = await pool.query(
        `SELECT id FROM caixa_sessoes WHERE company_id=$1 AND status='aberta' LIMIT 1`,
        [companyId]
      );
      activeSessaoId = sessRes?.rows?.[0]?.id || null;
    } catch (_) {}

    const uncovered = Math.max(0, parseFloat(ins.amount_due) - parseFloat(ins.covered_amount || 0));
    const payAmount = amount_paid !== undefined ? parseFloat(amount_paid) : uncovered;
    if (payAmount <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Valor de pagamento deve ser > 0.' });
    }

    const result = await creditLedger.applyPayment(client, {
      companyId,
      customerId: ins.customer_id,
      amount:     payAmount,
      method:     payment_method || 'dinheiro',
      sessaoId:   activeSessaoId,
      createdBy:  req.user?.id || null,
      accountId:  ins.account_id || null,
    });

    await client.query('COMMIT');

    const { rows: updated } = await pool.query(
      `SELECT * FROM credit_installments WHERE id=$1`, [installmentId]
    );
    // M4 (auditoria 12/06): expoe o breakdown REAL do applyPayment. O FIFO e
    // oldest-first, entao a parcela clicada pode NAO ser a coberta -- `applied`
    // lista as parcelas efetivamente afetadas e `applied_to_requested` diz se
    // a parcela da URL recebeu cobertura. Campos pre-existentes intactos.
    const appliedList = (result.covered_installments || []).map(c => ({
      installment_id: c.id,
      covered:        c.covered,
      status:         c.status,
    }));
    res.json({
      ...updated[0],
      remaining:   Math.max(0, parseFloat(updated[0].amount_due) - parseFloat(updated[0].covered_amount || 0)),
      new_balance: result.new_balance,
      settled:     result.settled_receivables,
      applied:              appliedList,
      applied_to_requested: appliedList.some(a => String(a.installment_id) === String(installmentId)),
      charges_paid:         result.charges_paid || 0,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PATCH /credit/installments/:iid/pay', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── PATCH /credit/installments/:iid/cancel ─────────────────────────────────
router.patch('/installments/:iid/cancel', async (req, res) => {
  const companyId     = req.params.id;
  const installmentId = req.params.iid;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE credit_installments
         SET status='cancelled', updated_at=NOW()
       WHERE id=$1 AND company_id=$2 AND status IN ('pending','overdue')
       RETURNING *`,
      [installmentId, companyId]
    );
    if (!r.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Parcela nao encontrada ou nao pode ser cancelada.' });
    }
    await creditLedger._updateCreditUsed(client, companyId, r.rows[0].customer_id);
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PATCH /credit/installments/:iid/cancel', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── PATCH /credit/installments/:iid/due-date ────────────────────────────────────
// F3.1: edita a data de vencimento de uma parcela com cascata nas parcelas seguintes
// do mesmo cliente+empresa que estejam pendentes/atrasadas.
router.patch('/installments/:iid/due-date', async (req, res) => {
  const companyId     = req.params.id;
  const installmentId = req.params.iid;
  const { due_date } = req.body || {};

  // Validacao: due_date obrigatorio e deve ser uma data valida (YYYY-MM-DD ou ISO)
  if (!due_date) {
    return res.status(400).json({ error: 'due_date e obrigatorio.' });
  }
  const newDate = new Date(due_date);
  if (isNaN(newDate.getTime())) {
    return res.status(400).json({ error: 'due_date invalido. Use o formato YYYY-MM-DD.' });
  }
  // Normaliza para YYYY-MM-DD ignorando horario
  const newDateStr = due_date.slice(0, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Busca a parcela garantindo que pertence a empresa e pode ser alterada
    const cur = await client.query(
      `SELECT * FROM credit_installments
       WHERE id=$1 AND company_id=$2 AND status IN ('pending','overdue')
       FOR UPDATE`,
      [installmentId, companyId]
    );
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Parcela nao encontrada ou nao pode ser editada (status invalido).' });
    }
    const installment = cur.rows[0];
    const oldDateStr  = installment.due_date instanceof Date
      ? installment.due_date.toISOString().slice(0, 10)
      : String(installment.due_date).slice(0, 10);

    // Calcula delta em dias (pode ser negativo para antecipar)
    const oldMs   = new Date(oldDateStr).getTime();
    const newMs   = new Date(newDateStr).getTime();
    const deltaDays = Math.round((newMs - oldMs) / 86400000);

    // Atualiza a parcela selecionada
    await client.query(
      `UPDATE credit_installments
         SET due_date=$1, updated_at=NOW()
       WHERE id=$2`,
      [newDateStr, installmentId]
    );
    let updatedCount = 1;

    // Cascata: atualiza parcelas seguintes do mesmo cliente+empresa
    // Usa installment_number se disponivel, caso contrario due_date > old_due_date
    const hasInstallmentNumber = installment.installment_number !== null &&
                                  installment.installment_number !== undefined;
    if (deltaDays !== 0) {
      let cascadeResult;
      if (hasInstallmentNumber) {
        cascadeResult = await client.query(
          `UPDATE credit_installments
             SET due_date = due_date + ($1 * INTERVAL '1 day'), updated_at = NOW()
           WHERE company_id=$2
             AND customer_id=$3
             AND id != $4
             AND status IN ('pending','overdue')
             AND installment_number > $5`,
          [deltaDays, companyId, installment.customer_id, installmentId,
           installment.installment_number]
        );
      } else {
        cascadeResult = await client.query(
          `UPDATE credit_installments
             SET due_date = due_date + ($1 * INTERVAL '1 day'), updated_at = NOW()
           WHERE company_id=$2
             AND customer_id=$3
             AND id != $4
             AND status IN ('pending','overdue')
             AND due_date > $5`,
          [deltaDays, companyId, installment.customer_id, installmentId, oldDateStr]
        );
      }
      updatedCount += cascadeResult.rowCount || 0;
    }

    // Ajuste de status apos alterar datas:
    // pending com due_date passada -> overdue
    await client.query(
      `UPDATE credit_installments
         SET status='overdue', updated_at=NOW()
       WHERE company_id=$1
         AND customer_id=$2
         AND status='pending'
         AND due_date < ${SP_DATE}`,
      [companyId, installment.customer_id]
    );
    // overdue com due_date futura -> pending
    await client.query(
      `UPDATE credit_installments
         SET status='pending', updated_at=NOW()
       WHERE company_id=$1
         AND customer_id=$2
         AND status='overdue'
         AND due_date >= ${SP_DATE}`,
      [companyId, installment.customer_id]
    );

    await client.query('COMMIT');
    res.json({ success: true, updated_count: updatedCount });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PATCH /credit/installments/:iid/due-date', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ─── GET /credit/dashboard ────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  const companyId = req.params.id;
  try {
    await pool.query(
      `UPDATE credit_installments SET status='overdue'
       WHERE company_id=$1 AND status='pending' AND due_date < ${SP_DATE}`,
      [companyId]
    );
    // Reverte status invalido: parcelas com due_date futura nunca devem ser overdue
    await pool.query(
      `UPDATE credit_installments SET status='pending'
       WHERE company_id=$1 AND status='overdue' AND due_date >= ${SP_DATE}`,
      [companyId]
    );

    const kpis = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('pending','overdue'))                                     AS total_open_count,
         COALESCE(SUM(amount_due - covered_amount) FILTER (WHERE status IN ('pending','overdue')), 0) AS total_open_amount,
         COUNT(*) FILTER (WHERE status='overdue')                                                     AS overdue_count,
         COALESCE(SUM(amount_due - covered_amount) FILTER (WHERE status='overdue'), 0)               AS overdue_amount,
         COUNT(*) FILTER (WHERE status='overdue'
           AND due_date < ${SP_DATE} - 30)                                                           AS critical_count,
         COALESCE(SUM(amount_due - covered_amount) FILTER (
           WHERE status='overdue' AND due_date < ${SP_DATE} - 30), 0)                                AS critical_amount,
         COUNT(DISTINCT customer_id) FILTER (WHERE status='overdue')                                 AS defaulting_customers,
         COUNT(*) FILTER (WHERE status='paid'
           AND DATE_TRUNC('month', paid_at AT TIME ZONE 'America/Sao_Paulo')
             = DATE_TRUNC('month', NOW() AT TIME ZONE 'America/Sao_Paulo'))                          AS paid_this_month_count,
         COALESCE(SUM(covered_amount) FILTER (WHERE status='paid'
           AND DATE_TRUNC('month', paid_at AT TIME ZONE 'America/Sao_Paulo')
             = DATE_TRUNC('month', NOW() AT TIME ZONE 'America/Sao_Paulo')), 0)                      AS paid_this_month_amount
       FROM credit_installments WHERE company_id=$1`,
      [companyId]
    );

    const top = await pool.query(
      `SELECT
         ci.customer_id,
         COALESCE(c.name, c.phone) AS customer_name, c.phone,
         COUNT(*) AS overdue_count,
         SUM(ci.amount_due - ci.covered_amount) AS total_overdue,
         MIN(ci.due_date) AS oldest_due_date,
         MAX(ci.collection_stage) AS collection_stage,
         ccp.credit_score, ccp.status AS credit_status
       FROM credit_installments ci
       LEFT JOIN customers c ON c.id=ci.customer_id AND c.company_id=ci.company_id
       LEFT JOIN customer_credit_profiles ccp
         ON ccp.customer_id=ci.customer_id AND ccp.company_id=ci.company_id
       WHERE ci.company_id=$1 AND ci.status='overdue'
       GROUP BY ci.customer_id, c.name, c.phone, ccp.credit_score, ccp.status
       ORDER BY total_overdue DESC LIMIT 20`,
      [companyId]
    );

    // Auditoria 12/06: carteira REAL do ledger (view customer_credit_balances,
    // em reais -- mesma unidade do total_open de GET /credit/balances). Os KPIs
    // acima cobrem so credit_installments; vendas 1x sem agenda de parcelas nao
    // aparecem la. Campos NOVOS, sem alterar os existentes. Defensivo 42P01/42703.
    let portfolio = { portfolio_open_amount: 0, customers_with_balance: 0 };
    try {
      const p = await pool.query(
        `SELECT COALESCE(SUM(balance) FILTER (WHERE balance > 0), 0) AS portfolio_open_amount,
                COUNT(*) FILTER (WHERE balance > 0)                  AS customers_with_balance
           FROM customer_credit_balances
          WHERE company_id = $1`,
        [companyId]
      );
      portfolio = {
        portfolio_open_amount:  parseFloat(p.rows[0]?.portfolio_open_amount || 0),
        customers_with_balance: parseInt(p.rows[0]?.customers_with_balance || 0, 10),
      };
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') throw e;
    }

    // Fix 10/07 (relato Jenniffer): "Recebido no mes" contava parcelas QUITADAS,
    // nao RECEBIMENTOS -- pagamento parcial, valor livre que nao quita parcela e
    // recebimento de venda sem agenda ficavam de fora (validado em prod: 23/74).
    // Fonte correta: ledger customer_credit_transactions type='payment' (refund/
    // exchange_credit NAO contam). Mantem os nomes dos campos; sobrescreve os
    // valores da query antiga. Defensivo 42P01 (fallback = calculo antigo).
    let paidMonth = null;
    try {
      const pm = await pool.query(
        `SELECT COUNT(*)                 AS paid_count,
                COALESCE(SUM(amount), 0) AS paid_amount
           FROM customer_credit_transactions
          WHERE company_id = $1 AND type = 'payment'
            AND DATE_TRUNC('month', created_at AT TIME ZONE 'America/Sao_Paulo')
              = DATE_TRUNC('month', NOW() AT TIME ZONE 'America/Sao_Paulo')`,
        [companyId]
      );
      paidMonth = {
        paid_this_month_count:  parseInt(pm.rows[0]?.paid_count || 0, 10),
        paid_this_month_amount: parseFloat(pm.rows[0]?.paid_amount || 0),
      };
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') throw e;
    }

    res.json({ kpis: { ...kpis.rows[0], ...portfolio, ...(paidMonth || {}) }, top_defaulters: top.rows });
  } catch (err) {
    console.error('GET /credit/dashboard', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /credit/dashboard/aging ────────────────────────────────────────────────
router.get('/dashboard/aging', async (req, res) => {
  const companyId = req.params.id;
  try {
    const r = await pool.query(
      `SELECT
         CASE
           WHEN due_date >= ${SP_DATE}      THEN 'a_vencer'
           WHEN due_date >= ${SP_DATE} - 30 THEN '1_30_dias'
           WHEN due_date >= ${SP_DATE} - 60 THEN '31_60_dias'
           WHEN due_date >= ${SP_DATE} - 90 THEN '61_90_dias'
           ELSE                                  'acima_90'
         END AS faixa,
         COUNT(*) AS count,
         COALESCE(SUM(amount_due - covered_amount), 0) AS amount
       FROM credit_installments
       WHERE company_id=$1 AND status IN ('pending','overdue')
       GROUP BY faixa ORDER BY faixa`,
      [companyId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('GET /credit/dashboard/aging', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── collection/rules + collection/trigger ───────────────────────────────────
router.get('/collection/rules', async (req, res) => {
  const client = await pool.connect();
  try {
    let r;
    try {
      r = await client.query(`SELECT * FROM credit_collection_rules WHERE company_id=$1`, [req.params.id]);
    } catch (e) {
      if (e.code === '42P01') return res.json({ rules: [], enabled: false });
      throw e;
    }
    if (!r.rows.length) {
      const ins = await client.query(
        `INSERT INTO credit_collection_rules (company_id) VALUES ($1)
         ON CONFLICT (company_id) DO UPDATE SET updated_at=NOW() RETURNING *`,
        [req.params.id]
      );
      return res.json(ins.rows[0]);
    }
    res.json(r.rows[0]);
  } catch (err) {
    console.error('GET /credit/collection/rules', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

router.put('/collection/rules', async (req, res) => {
  const { enabled, whatsapp_connected, rules, pix_key } = req.body;
  const client = await pool.connect();
  try {
    const r = await client.query(
      `INSERT INTO credit_collection_rules (company_id, enabled, whatsapp_connected, rules, pix_key)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (company_id) DO UPDATE SET
         enabled=$2, whatsapp_connected=$3, rules=$4,
         pix_key=COALESCE($5, credit_collection_rules.pix_key), updated_at=NOW()
       RETURNING *`,
      [req.params.id,
       enabled !== undefined ? enabled : true,
       whatsapp_connected !== undefined ? whatsapp_connected : false,
       rules ? JSON.stringify(rules) : null,
       pix_key !== undefined ? String(pix_key).trim() : null]
    );
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '42P01') return res.status(503).json({ error: 'Tabela de regua ainda nao disponivel.' });
    console.error('PUT /credit/collection/rules', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// B2: a mensagem de cobranca agora carrega o Pix copia-e-cola REAL (EMV),
// com o valor devido HOJE (remaining + encargos lazy). Fallback: pix_link
// legado gravado na parcela (parcelas novas nao gravam mais).
// 17/08/2026: corpo extraido pra services/credit/collectionNotice.js, SEM
// mudanca de comportamento. O mesmo motor agora atende a cobranca do saldo
// de encomenda do Studio, que nao passa pelo gate de crediario.
router.post('/collection/trigger/:iid', async (req, res) => {
  const companyId     = req.params.id;
  const installmentId = req.params.iid;
  const { template = 'atraso_1', channel = 'whatsapp' } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const notice = await collectionNotice.buildNotice(client, {
      companyId, installmentId, template, channel,
    });
    if (!notice) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Parcela nao encontrada.' }); }
    await client.query('COMMIT');
    res.json({ success: true, ...notice });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /credit/collection/trigger/:iid', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

module.exports = router;
