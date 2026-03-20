// ============================================================
// AURA. — Serviço de Obrigações Fiscais (BE-10)
// LINGUAGEM INVIOLÁVEL:
//   SEMPRE: "estimativa", "apoio contábil", "informativo"
//   NUNCA: "declaração oficial", "transmissão", "assessoria tributária"
// ============================================================

const db = require('../config/database');

// Alíquotas DAS-MEI 2026
const MEI_DAS = {
  commerce:  { inss: 75.90, icms: 1.00, iss: 0,    total: 76.90  }, // comércio
  services:  { inss: 75.90, icms: 0,    iss: 5.00,  total: 80.90  }, // serviços
  both:      { inss: 75.90, icms: 1.00, iss: 5.00,  total: 81.90  }, // ambos
};

const MEI_ANNUAL_LIMIT = 81000.00; // R$ 81k/ano

// Anexos Simples Nacional — alíquotas nominais por faixa (Anexo III)
const SN_ANEXO_III = [
  { max: 180000,   rate: 0.06,   deduction: 0        },
  { max: 360000,   rate: 0.1112, deduction: 9360     },
  { max: 720000,   rate: 0.135,  deduction: 17640    },
  { max: 1800000,  rate: 0.16,   deduction: 35640    },
  { max: 3600000,  rate: 0.21,   deduction: 125640   },
  { max: 4800000,  rate: 0.33,   deduction: 648000   },
];

/**
 * Calcula DAS estimado MEI
 * LINGUAGEM: sempre "estimativa" — nunca "valor oficial"
 */
function calculateMEIDAS(activityType = 'services') {
  const das = MEI_DAS[activityType] || MEI_DAS.services;
  return {
    inss:    das.inss,
    icms:    das.icms,
    iss:     das.iss,
    total:   das.total,
    label:   'Estimativa DAS-MEI',
    disclaimer: 'Valor estimado com base na tabela vigente. Confirme no Portal do Empreendedor antes de pagar.',
  };
}

/**
 * Calcula DAS estimado Simples Nacional (PGDAS-D)
 * LINGUAGEM: sempre "estimativa" — nunca "apuração oficial"
 */
function calculateSNDAS(revenue12months, currentMonthRevenue) {
  if (revenue12months <= 0 || currentMonthRevenue <= 0) {
    return { estimated_rate: 0, estimated_das: 0, label: 'Estimativa PGDAS-D', disclaimer: '' };
  }

  const bracket = SN_ANEXO_III.find(b => revenue12months <= b.max) || SN_ANEXO_III[SN_ANEXO_III.length - 1];
  const nominalRate = bracket.rate;
  const effectiveRate = ((revenue12months * nominalRate) - bracket.deduction) / revenue12months;
  const estimatedDAS = parseFloat((currentMonthRevenue * effectiveRate).toFixed(2));

  return {
    revenue_12m:      parseFloat(revenue12months.toFixed(2)),
    nominal_rate_pct: parseFloat((nominalRate * 100).toFixed(2)),
    effective_rate_pct: parseFloat((effectiveRate * 100).toFixed(2)),
    estimated_das:    estimatedDAS,
    label:            'Estimativa PGDAS-D',
    disclaimer:       'Estimativa calculada com base no Anexo III. A apuração oficial deve ser feita pelo seu analista no Portal do Simples Nacional.',
  };
}

/**
 * Verifica limite de faturamento MEI
 */
function checkMEILimit(annualRevenue) {
  const pct = (annualRevenue / MEI_ANNUAL_LIMIT) * 100;
  const remaining = Math.max(MEI_ANNUAL_LIMIT - annualRevenue, 0);

  return {
    annual_revenue:  annualRevenue,
    annual_limit:    MEI_ANNUAL_LIMIT,
    used_pct:        parseFloat(pct.toFixed(1)),
    remaining:       parseFloat(remaining.toFixed(2)),
    alert_level:     pct >= 100 ? 'critical' : pct >= 80 ? 'warning' : pct >= 60 ? 'info' : null,
    alert_message:   pct >= 100
      ? 'Limite MEI atingido. Fale com seu analista sobre o enquadramento.'
      : pct >= 80
      ? `Você atingiu ${pct.toFixed(0)}% do limite anual MEI. Considere conversar com seu analista.`
      : null,
  };
}

/**
 * Gera calendário de obrigações do mês para a empresa
 */
async function generateMonthlyObligations(companyId, referenceMonth) {
  const { rows: companyRows } = await db.query(`
    SELECT tax_regime, annual_revenue FROM companies WHERE id = $1
  `, [companyId]);

  if (!companyRows.length) throw new Error('Empresa não encontrada');

  const { tax_regime, annual_revenue } = companyRows[0];
  const refDate = new Date(referenceMonth);
  const year    = refDate.getFullYear();
  const month   = refDate.getMonth() + 1;

  const obligations = [];

  if (tax_regime === 'mei') {
    // DAS-MEI — vence dia 20
    const dueDate = new Date(year, month - 1, 20);
    const das = calculateMEIDAS('services');

    obligations.push({
      code:             'DAS_MEI',
      description:      'Apoio contábil — DAS-MEI',
      due_date:         dueDate,
      reference_period: `${year}-${String(month).padStart(2,'0')}`,
      estimated_amount: das.total,
      disclaimer:       das.disclaimer,
      checkpoint_total: 3,
      alerts: generateAlerts(dueDate),
    });

    // DASN-SIMEI — vence 31/05 (declaração anual)
    if (month === 4) {
      obligations.push({
        code:             'DASN_SIMEI',
        description:      'Apoio contábil — DASN-SIMEI (ano anterior)',
        due_date:         new Date(year, 4, 31),
        reference_period: `${year - 1}`,
        estimated_amount: null,
        disclaimer:       'A transmissão oficial deve ser feita pelo titular no Portal do Empreendedor.',
        checkpoint_total: 5,
        alerts: generateAlerts(new Date(year, 4, 31)),
      });
    }
  }

  if (tax_regime === 'simples_nacional') {
    // PGDAS-D — vence dia 20
    const dueDate = new Date(year, month - 1, 20);

    obligations.push({
      code:             'PGDAS_D',
      description:      'Apoio contábil — PGDAS-D',
      due_date:         dueDate,
      reference_period: `${year}-${String(month).padStart(2,'0')}`,
      estimated_amount: null, // calculado via endpoint separado
      disclaimer:       'Estimativa disponível após informar a receita bruta do mês. A transmissão oficial é realizada pelo seu analista.',
      checkpoint_total: 3,
      alerts: generateAlerts(dueDate),
    });

    // DEFIS — vence 31/03
    if (month === 2) {
      obligations.push({
        code:             'DEFIS',
        description:      'Apoio contábil — DEFIS (ano anterior)',
        due_date:         new Date(year, 2, 31),
        reference_period: `${year - 1}`,
        estimated_amount: null,
        disclaimer:       'A transmissão oficial da DEFIS é realizada pelo seu analista.',
        checkpoint_total: 5,
        alerts: generateAlerts(new Date(year, 2, 31)),
      });
    }
  }

  // Inserir ou atualizar obrigações no banco
  for (const ob of obligations) {
    await db.query(`
      INSERT INTO fiscal_obligations
        (company_id, code, description, due_date, reference_period,
         estimated_amount, checkpoint_total, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
      ON CONFLICT (company_id, code, reference_period)
        DO UPDATE SET
          estimated_amount = EXCLUDED.estimated_amount,
          updated_at = NOW()
    `, [
      companyId, ob.code, ob.description,
      ob.due_date, ob.reference_period,
      ob.estimated_amount, ob.checkpoint_total,
    ]);
  }

  return obligations;
}

/**
 * Busca obrigações da empresa com status e alertas
 */
async function getObligations(companyId, options = {}) {
  const { status, year } = options;
  const params = [companyId];
  const filters = [];

  if (status) { params.push(status); filters.push(`status = $${params.length}`); }
  if (year)   { params.push(year);   filters.push(`EXTRACT(YEAR FROM due_date) = $${params.length}`); }

  const where = filters.length ? `AND ${filters.join(' AND ')}` : '';

  const { rows } = await db.query(`
    SELECT
      id, code, description, due_date, reference_period,
      estimated_amount, status, checkpoint_total, checkpoint_done,
      streak_days, completed_at, created_at
    FROM fiscal_obligations
    WHERE company_id = $1 ${where}
    ORDER BY due_date ASC
  `, params);

  return rows.map(r => ({
    ...r,
    estimated_amount: r.estimated_amount ? parseFloat(r.estimated_amount) : null,
    days_until_due:   Math.ceil((new Date(r.due_date) - new Date()) / 86400000),
    alert_level:      getAlertLevel(r.due_date, r.status),
    disclaimer:       'Valores informativos. A transmissão oficial é responsabilidade do titular ou analista.',
  }));
}

/**
 * Atualiza checkpoint de uma obrigação
 */
async function updateCheckpoint(companyId, obligationId, checkpointDone) {
  const { rows } = await db.query(`
    UPDATE fiscal_obligations
    SET
      checkpoint_done = $1,
      status = CASE WHEN $1 >= checkpoint_total THEN 'completed' ELSE status END,
      completed_at = CASE WHEN $1 >= checkpoint_total THEN NOW() ELSE NULL END,
      updated_at = NOW()
    WHERE id = $2 AND company_id = $3
    RETURNING *
  `, [checkpointDone, obligationId, companyId]);

  if (!rows.length) throw new Error('Obrigação não encontrada');
  return rows[0];
}

// ── Helpers ──────────────────────────────────────────────────

function generateAlerts(dueDate) {
  const now = new Date();
  const days = Math.ceil((dueDate - now) / 86400000);
  const alerts = [];
  [15, 7, 3, 1].forEach(d => {
    if (days <= d) alerts.push({ days_before: d, triggered: true });
  });
  return alerts;
}

function getAlertLevel(dueDate, status) {
  if (status === 'completed') return null;
  const days = Math.ceil((new Date(dueDate) - new Date()) / 86400000);
  if (days < 0)  return 'overdue';
  if (days <= 3) return 'critical';
  if (days <= 7) return 'warning';
  if (days <= 15) return 'info';
  return null;
}

module.exports = {
  calculateMEIDAS,
  calculateSNDAS,
  checkMEILimit,
  generateMonthlyObligations,
  getObligations,
  updateCheckpoint,
};
