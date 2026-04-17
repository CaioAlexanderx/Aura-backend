// ============================================================
// AURA. — Servico de Obrigacoes Fiscais (BE-10 + Fase 2)
// Adicionado: Anexo V + selecao automatica III/V + calculo FGTS
//
// LINGUAGEM INVIOLAVEL:
//   SEMPRE: "estimativa", "apoio contabil", "informativo"
//   NUNCA: "declaracao oficial", "transmissao", "assessoria tributaria"
// ============================================================

const db = require('../config/database');

// Aliquotas DAS-MEI 2026
const MEI_DAS = {
  commerce:  { inss: 75.90, icms: 1.00, iss: 0,    total: 76.90  },
  services:  { inss: 75.90, icms: 0,    iss: 5.00,  total: 80.90  },
  both:      { inss: 75.90, icms: 1.00, iss: 5.00,  total: 81.90  },
};

const MEI_ANNUAL_LIMIT = 81000.00;

// Anexo III — Simples Nacional (servicos com Fator R >= 28%)
const SN_ANEXO_III = [
  { max: 180000,   rate: 0.06,   deduction: 0        },
  { max: 360000,   rate: 0.1112, deduction: 9360     },
  { max: 720000,   rate: 0.135,  deduction: 17640    },
  { max: 1800000,  rate: 0.16,   deduction: 35640    },
  { max: 3600000,  rate: 0.21,   deduction: 125640   },
  { max: 4800000,  rate: 0.33,   deduction: 648000   },
];

// C4-02: Anexo V — Simples Nacional (servicos com Fator R < 28%)
const SN_ANEXO_V = [
  { max: 180000,   rate: 0.155,  deduction: 0        },
  { max: 360000,   rate: 0.18,   deduction: 4500     },
  { max: 720000,   rate: 0.195,  deduction: 9900     },
  { max: 1800000,  rate: 0.205,  deduction: 17100    },
  { max: 3600000,  rate: 0.23,   deduction: 62100    },
  { max: 4800000,  rate: 0.305,  deduction: 540000   },
];

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

// C4-02: Calcula DAS com selecao automatica Anexo III/V baseada no Fator R
function calculateSNDAS(revenue12months, currentMonthRevenue, fatorR = null) {
  if (revenue12months <= 0 || currentMonthRevenue <= 0) {
    return { estimated_rate: 0, estimated_das: 0, anexo: 'III', label: 'Estimativa PGDAS-D', disclaimer: '' };
  }

  // Selecionar anexo baseado no Fator R
  const useAnexoV = fatorR !== null && fatorR < 28;
  const table = useAnexoV ? SN_ANEXO_V : SN_ANEXO_III;
  const anexo = useAnexoV ? 'V' : 'III';

  const bracket = table.find(b => revenue12months <= b.max) || table[table.length - 1];
  const nominalRate = bracket.rate;
  const effectiveRate = ((revenue12months * nominalRate) - bracket.deduction) / revenue12months;
  const estimatedDAS = parseFloat((currentMonthRevenue * effectiveRate).toFixed(2));

  return {
    revenue_12m:      parseFloat(revenue12months.toFixed(2)),
    nominal_rate_pct: parseFloat((nominalRate * 100).toFixed(2)),
    effective_rate_pct: parseFloat((effectiveRate * 100).toFixed(2)),
    estimated_das:    estimatedDAS,
    anexo:            anexo,
    fator_r:          fatorR,
    label:            'Estimativa PGDAS-D',
    disclaimer:       `Estimativa calculada com base no Anexo ${anexo}. A apuracao oficial deve ser feita pelo seu analista no Portal do Simples Nacional.`,
  };
}

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
      ? `Voce atingiu ${pct.toFixed(0)}% do limite anual MEI. Considere conversar com seu analista.`
      : null,
  };
}

// C4-01: Calcula FGTS para todos os empregados ativos
async function calculateFGTS(companyId, month) {
  const [y, m] = (month || '').split('-').map(Number);
  if (!y || !m) {
    const now = new Date();
    return _calcFGTS(companyId, now.getFullYear(), now.getMonth() + 1);
  }
  return _calcFGTS(companyId, y, m);
}

async function _calcFGTS(companyId, y, m) {
  const FGTS_RATE = 0.08;
  const { rows } = await db.query(
    `SELECT id, name, role_title, salary FROM employees WHERE company_id=$1 AND status='active' ORDER BY name`,
    [companyId]
  );
  const employees = rows.map(e => {
    const salary = parseFloat(e.salary || 0);
    const fgts = parseFloat((salary * FGTS_RATE).toFixed(2));
    return { id: e.id, name: e.name, role: e.role_title || '', salary, fgts };
  });
  const totalSalary = employees.reduce((s, e) => s + e.salary, 0);
  const totalFGTS = employees.reduce((s, e) => s + e.fgts, 0);
  return {
    month: `${y}-${String(m).padStart(2, '0')}`,
    rate: FGTS_RATE,
    employees,
    total_salary: totalSalary,
    total_fgts: totalFGTS,
    due_date: `${y}-${String(m).padStart(2, '0')}-07`,
    disclaimer: 'Estimativa. O recolhimento oficial deve ser feito pelo FGTS Digital (portal gov.br).',
  };
}

// Calcula INSS sobre pro-labore (GPS/DARF)
function calculateGPS(grossProlabore, inssRate = 0.11, inssCap = 7786.02, patronalRate = 0.20) {
  const base = Math.min(grossProlabore, inssCap);
  const inssRetido = parseFloat((base * inssRate).toFixed(2));
  const inssPatronal = parseFloat((grossProlabore * patronalRate).toFixed(2));
  const totalGPS = parseFloat((inssRetido + inssPatronal).toFixed(2));
  return {
    gross_prolabore: grossProlabore,
    inss_retido: inssRetido,
    inss_patronal: inssPatronal,
    total_gps: totalGPS,
    inss_rate: inssRate,
    patronal_rate: patronalRate,
    inss_cap: inssCap,
    code_receita: '1007',
    disclaimer: 'Estimativa. A guia GPS/DARF oficial deve ser gerada no portal da Receita Federal (Sicalc).',
  };
}

async function generateMonthlyObligations(companyId, referenceMonth) {
  const { rows: companyRows } = await db.query(
    `SELECT tax_regime, annual_revenue FROM companies WHERE id = $1`, [companyId]
  );
  if (!companyRows.length) throw new Error('Empresa nao encontrada');

  const { tax_regime } = companyRows[0];
  const refDate = new Date(referenceMonth);
  const year    = refDate.getFullYear();
  const month   = refDate.getMonth() + 1;

  const obligations = [];

  if (tax_regime === 'mei') {
    const dueDate = new Date(year, month - 1, 20);
    const das = calculateMEIDAS('services');
    obligations.push({
      code: 'DAS_MEI', description: 'Apoio contabil — DAS-MEI',
      due_date: dueDate, reference_period: `${year}-${String(month).padStart(2,'0')}`,
      estimated_amount: das.total, disclaimer: das.disclaimer,
      checkpoint_total: 3, alerts: generateAlerts(dueDate),
    });
    if (month === 4) {
      obligations.push({
        code: 'DASN_SIMEI', description: 'Apoio contabil — DASN-SIMEI (ano anterior)',
        due_date: new Date(year, 4, 31), reference_period: `${year - 1}`,
        estimated_amount: null, disclaimer: 'A transmissao oficial deve ser feita pelo titular no Portal do Empreendedor.',
        checkpoint_total: 5, alerts: generateAlerts(new Date(year, 4, 31)),
      });
    }
  }

  if (tax_regime === 'simples_nacional') {
    const dueDate = new Date(year, month - 1, 20);
    obligations.push({
      code: 'PGDAS_D', description: 'Apoio contabil — PGDAS-D',
      due_date: dueDate, reference_period: `${year}-${String(month).padStart(2,'0')}`,
      estimated_amount: null, disclaimer: 'Estimativa disponivel apos informar a receita bruta do mes.',
      checkpoint_total: 3, alerts: generateAlerts(dueDate),
    });
    if (month === 2) {
      obligations.push({
        code: 'DEFIS', description: 'Apoio contabil — DEFIS (ano anterior)',
        due_date: new Date(year, 2, 31), reference_period: `${year - 1}`,
        estimated_amount: null, disclaimer: 'A transmissao oficial da DEFIS e realizada pelo seu analista.',
        checkpoint_total: 5, alerts: generateAlerts(new Date(year, 2, 31)),
      });
    }
  }

  for (const ob of obligations) {
    await db.query(`
      INSERT INTO fiscal_obligations
        (company_id, code, description, due_date, reference_period,
         estimated_amount, checkpoint_total, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
      ON CONFLICT (company_id, code, reference_period)
        DO UPDATE SET estimated_amount = EXCLUDED.estimated_amount, updated_at = NOW()
    `, [companyId, ob.code, ob.description, ob.due_date, ob.reference_period, ob.estimated_amount, ob.checkpoint_total]);
  }

  return obligations;
}

async function getObligations(companyId, options = {}) {
  const { status, year } = options;
  const params = [companyId];
  const filters = [];
  if (status) { params.push(status); filters.push(`status = $${params.length}`); }
  if (year)   { params.push(year);   filters.push(`EXTRACT(YEAR FROM due_date) = $${params.length}`); }
  const where = filters.length ? `AND ${filters.join(' AND ')}` : '';

  const { rows } = await db.query(`
    SELECT id, code, description, due_date, reference_period,
      estimated_amount, status, checkpoint_total, checkpoint_done,
      streak_days, completed_at, created_at
    FROM fiscal_obligations WHERE company_id = $1 ${where}
    ORDER BY due_date ASC
  `, params);

  return rows.map(r => ({
    ...r,
    estimated_amount: r.estimated_amount ? parseFloat(r.estimated_amount) : null,
    days_until_due:   Math.ceil((new Date(r.due_date) - new Date()) / 86400000),
    alert_level:      getAlertLevel(r.due_date, r.status),
    disclaimer:       'Valores informativos. A transmissao oficial e responsabilidade do titular ou analista.',
  }));
}

async function updateCheckpoint(companyId, obligationId, checkpointDone) {
  const { rows } = await db.query(`
    UPDATE fiscal_obligations SET
      checkpoint_done = $1,
      status = CASE WHEN $1 >= checkpoint_total THEN 'completed' ELSE status END,
      completed_at = CASE WHEN $1 >= checkpoint_total THEN NOW() ELSE NULL END,
      updated_at = NOW()
    WHERE id = $2 AND company_id = $3 RETURNING *
  `, [checkpointDone, obligationId, companyId]);
  if (!rows.length) throw new Error('Obrigacao nao encontrada');
  return rows[0];
}

function generateAlerts(dueDate) {
  const days = Math.ceil((dueDate - new Date()) / 86400000);
  const alerts = [];
  [15, 7, 3, 1].forEach(d => { if (days <= d) alerts.push({ days_before: d, triggered: true }); });
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
  calculateMEIDAS, calculateSNDAS, checkMEILimit,
  calculateFGTS, calculateGPS,
  generateMonthlyObligations, getObligations, updateCheckpoint,
  SN_ANEXO_III, SN_ANEXO_V,
};
