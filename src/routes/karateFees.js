// ============================================================
// AURA KARATÊ — Rotas da Tabela de Anuidades (Track B)
//
// GET /financial/fees   — tabela vigente (por plano [Fase F2] + porte [legado] + CPF)
// PUT /financial/fees   — cria nova vigência (append-only, nunca sobrescreve)
//
// Tabela karate_annual_fees (migration 154; ganhou `plan`/`due_months` na
// migration 222 — Fase F1):
//   id, federation_id, fee_type (dojo|cpf), size_tier (legado), plan
//   (anual|semestral|trimestral), amount, due_months (smallint[]),
//   effective_from.
// Vigente = registro com effective_from <= hoje, o mais recente por
// (fee_type, plan, size_tier).
//
// Fase F2 — PUT aceita DOIS formatos de body (o endpoint não muda de path,
// só passa a aceitar o novo shape além do antigo — o front antigo, que edita
// por size_tier, continua funcionando sem alteração):
//   1) LEGADO (size_tier): { effective_from, fees: [{ fee_type, size_tier, amount }] }
//   2) NOVO (por plano):   { fee_type, plan, amount, due_months, effective_from? }
//      — devolve o registro único criado (não um array). due_months é
//      obrigatório e precisa ser coerente com o nº de cobranças do plano
//      (anual=1, semestral=2, trimestral=4); fee_type='cpf' é SEMPRE 1
//      cobrança, independente do plano escolhido (só existe o plano 'anual'
//      p/ CPF hoje — praticante faixa-preta paga 1x/ano).
//      effective_from é OPCIONAL — default CURRENT_DATE (hoje). Isso é
//      proposital: uma vigência nova serve só para cobranças FUTURAS.
//      ⚠️ Nova vigência é append-only: NÃO faz UPDATE/DELETE em parcelas já
//      geradas (karate_annuity_installments). Quem já tem cobrança lançada
//      neste ano mantém o valor/vencimento antigo — só a PRÓXIMA geração de
//      parcelas (próximo /charge ou próxima temporada) usa o valor novo. Ver
//      karateAnnuityService.getVigentFee(), que sempre busca a linha com
//      MAIOR effective_from <= hoje — nunca reescreve karate_annuity_installments.
//
// Guard: adminOnly() — apenas federation_admin pode ajustar a tabela de preços.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { VALID_PLANS } = require('../services/karateAnnuityService');

// Nº de cobranças esperado por plano (dojô). CPF é sempre 1, não importa o
// plano — só existe 'anual' p/ CPF na prática, mas a validação não hardcoda
// isso: qualquer plano válido com fee_type='cpf' exige due_months.length===1.
const PLAN_INSTALLMENT_COUNT = { anual: 1, semestral: 2, trimestral: 4 };

// GET /financial/fees
router.get('/fees', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;

  try {
    // Vigente = por (fee_type, plan, size_tier), o registro com
    // effective_from mais recente <= hoje.
    // NOTA (Fase F2 — bugfix): antes desta fase o DISTINCT ON não incluía
    // `plan`, então os 3 planos de dojô (anual/semestral/trimestral) — todos
    // com size_tier NULL desde a migration 222 — colapsavam num único
    // registro "vencedor" arbitrário. Cada (fee_type, plan) precisa
    // aparecer separado.
    const { rows } = await db.query(
      `SELECT DISTINCT ON (fee_type, plan, size_tier)
         id, fee_type, size_tier, plan, amount, due_months, effective_from
       FROM karate_annual_fees
       WHERE federation_id = $1
         AND effective_from <= CURRENT_DATE
       ORDER BY fee_type, plan, size_tier, effective_from DESC, id DESC`,
      [federationId]
    );

    res.json(rows.map(r => ({
      id: r.id,
      fee_type: r.fee_type,
      size_tier: r.size_tier,
      plan: r.plan || null,
      amount: parseFloat(r.amount),
      due_months: r.due_months || null,
      effective_from: r.effective_from,
    })));
  } catch (err) {
    // 42703: coluna plan/due_months ausente (deployment parcial, migration
    // 222 ainda não aplicada) — cai pro shape legado (sem plan/due_months).
    if (err.code === '42703') {
      try {
        const { rows } = await db.query(
          `SELECT DISTINCT ON (fee_type, size_tier)
             id, fee_type, size_tier, amount, effective_from
           FROM karate_annual_fees
           WHERE federation_id = $1
             AND effective_from <= CURRENT_DATE
           ORDER BY fee_type, size_tier, effective_from DESC`,
          [federationId]
        );
        return res.json(rows.map(r => ({
          id: r.id,
          fee_type: r.fee_type,
          size_tier: r.size_tier,
          amount: parseFloat(r.amount),
          effective_from: r.effective_from,
        })));
      } catch (e2) {
        console.error('[karateFees] list fallback error:', e2.message);
        return res.status(500).json({ error: 'Erro ao listar tabela de anuidades' });
      }
    }
    if (err.code === '42P01') {
      console.warn('[karateFees] tabela ausente, devolvendo vazio:', err.message);
      return res.json([]);
    }
    console.error('[karateFees] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar tabela de anuidades' });
  }
});

// PUT /financial/fees
// Aceita os dois formatos descritos no cabeçalho do arquivo. Detecção pelo
// shape do body: `fees` array presente => legado (size_tier); caso
// contrário => novo formato (plan-based), tratado como uma vigência única.
router.put('/fees', ...guards.adminOnly(), async (req, res) => {
  const federationId = req.params.id;

  if (Array.isArray(req.body?.fees)) {
    return putLegacySizeTier(req, res, federationId);
  }
  return putPlanBased(req, res, federationId);
});

// ── Formato NOVO (Fase F2) — vigência por plano ──────────────────────────
async function putPlanBased(req, res, federationId) {
  const { fee_type, plan, amount, due_months, effective_from } = req.body || {};

  if (!['dojo', 'cpf'].includes(fee_type)) {
    return res.status(422).json({
      error: `fee_type inválido: ${fee_type}. Use: dojo, cpf`,
      code: 'VALIDATION_ERROR',
    });
  }
  if (!VALID_PLANS.includes(plan)) {
    return res.status(422).json({
      error: `plan inválido: ${plan}. Use: ${VALID_PLANS.join(', ')}`,
      code: 'VALIDATION_ERROR',
    });
  }
  if (isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(422).json({ error: 'amount deve ser > 0', code: 'VALIDATION_ERROR' });
  }
  if (!Array.isArray(due_months) || due_months.length === 0) {
    return res.status(422).json({ error: 'due_months deve ser um array não vazio de meses (1–12)', code: 'VALIDATION_ERROR' });
  }
  const monthsValid = due_months.every((m) => Number.isInteger(m) && m >= 1 && m <= 12);
  if (!monthsValid) {
    return res.status(422).json({ error: 'due_months só aceita meses entre 1 e 12', code: 'VALIDATION_ERROR' });
  }
  // fee_type='cpf' é SEMPRE 1 cobrança (praticante faixa-preta paga 1x/ano),
  // independente do plano escolhido. Dojô segue o nº de cobranças do plano.
  const expectedCount = fee_type === 'cpf' ? 1 : PLAN_INSTALLMENT_COUNT[plan];
  if (due_months.length !== expectedCount) {
    return res.status(422).json({
      error: `due_months deve ter ${expectedCount} mes(es) para ${fee_type === 'cpf' ? 'cpf' : `plan=${plan}`} (recebido ${due_months.length})`,
      code: 'VALIDATION_ERROR',
    });
  }
  let effectiveFromDate = effective_from;
  if (effectiveFromDate !== undefined && effectiveFromDate !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effectiveFromDate))) {
      return res.status(422).json({ error: 'effective_from deve estar no formato YYYY-MM-DD', code: 'VALIDATION_ERROR' });
    }
  } else {
    effectiveFromDate = new Date().toISOString().slice(0, 10);
  }

  try {
    const fedRes = await db.query(
      `SELECT id FROM companies WHERE id = $1 AND vertical = 'karate_federation' LIMIT 1`,
      [federationId]
    );
    if (!fedRes.rows.length) {
      return res.status(404).json({ error: 'Federação não encontrada', code: 'NOT_FOUND' });
    }

    // Append-only: SEMPRE insere uma linha nova, nunca UPDATE/DELETE de
    // vigências anteriores. karate_annuity_installments JÁ GERADAS não são
    // tocadas — só a próxima geração de parcelas passa a usar este valor.
    const sortedMonths = [...due_months].sort((a, b) => a - b);
    const { rows } = await db.query(
      `INSERT INTO karate_annual_fees
         (federation_id, fee_type, plan, size_tier, amount, due_months, effective_from, created_at)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, NOW())
       RETURNING id, fee_type, plan, size_tier, amount, due_months, effective_from`,
      [federationId, fee_type, plan, Number(amount), sortedMonths, effectiveFromDate]
    );

    const created = rows[0];
    res.json({
      id: created.id,
      fee_type: created.fee_type,
      plan: created.plan,
      size_tier: created.size_tier,
      amount: parseFloat(created.amount),
      due_months: created.due_months,
      effective_from: created.effective_from,
    });
  } catch (err) {
    if (err.code === '42703' || err.code === '42P01') {
      console.warn('[karateFees] put plan-based: migration 222 ausente:', err.message);
      return res.status(409).json({
        error: 'Tabela de anuidades por plano ainda não está disponível neste ambiente (migration pendente)',
        code: 'MIGRATION_PENDING',
      });
    }
    console.error('[karateFees] put plan-based error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar tabela de anuidades', detail: err.message });
  }
}

// ── Formato LEGADO — vigência por porte (size_tier), inalterado ─────────
// Body: { effective_from: '2027-01-01', fees: [{ fee_type, size_tier, amount }] }
// Append-only: insere nova vigência. Não deleta nem atualiza registros anteriores.
async function putLegacySizeTier(req, res, federationId) {
  const { effective_from, fees } = req.body;

  if (!effective_from || !/^\d{4}-\d{2}-\d{2}$/.test(effective_from)) {
    return res.status(422).json({ error: 'effective_from obrigatorio (formato YYYY-MM-DD)', code: 'VALIDATION_ERROR' });
  }
  if (!Array.isArray(fees) || fees.length === 0) {
    return res.status(422).json({ error: 'fees deve ser array não vazio', code: 'VALIDATION_ERROR' });
  }

  const VALID_FEE_TYPES = ['dojo', 'cpf'];
  const VALID_SIZE_TIERS = ['up_to_40', '41_90', '91_150', 'over_150', null];

  for (const fee of fees) {
    if (!VALID_FEE_TYPES.includes(fee.fee_type)) {
      return res.status(422).json({
        error: `fee_type invalido: ${fee.fee_type}. Use: dojo, cpf`,
        code: 'VALIDATION_ERROR',
      });
    }
    if (fee.fee_type === 'dojo' && !VALID_SIZE_TIERS.includes(fee.size_tier || null)) {
      return res.status(422).json({
        error: `size_tier invalido para fee_type=dojo: ${fee.size_tier}`,
        code: 'VALIDATION_ERROR',
      });
    }
    if (isNaN(Number(fee.amount)) || Number(fee.amount) <= 0) {
      return res.status(422).json({ error: 'amount deve ser > 0', code: 'VALIDATION_ERROR' });
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Verifica federação
    const fedRes = await client.query(
      `SELECT id FROM companies WHERE id = $1 AND vertical = 'karate_federation' LIMIT 1`,
      [federationId]
    );
    if (!fedRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Federação não encontrada', code: 'NOT_FOUND' });
    }

    const inserted = [];
    for (const fee of fees) {
      const { rows } = await client.query(
        `INSERT INTO karate_annual_fees
           (federation_id, fee_type, size_tier, amount, effective_from, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING id, fee_type, size_tier, amount, effective_from`,
        [federationId, fee.fee_type, fee.size_tier || null, Number(fee.amount), effective_from]
      );
      inserted.push({
        id: rows[0].id,
        fee_type: rows[0].fee_type,
        size_tier: rows[0].size_tier,
        amount: parseFloat(rows[0].amount),
        effective_from: rows[0].effective_from,
      });
    }

    await client.query('COMMIT');

    res.json(inserted);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateFees] put legacy error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar tabela de anuidades', detail: err.message });
  } finally {
    client.release();
  }
}

module.exports = router;
