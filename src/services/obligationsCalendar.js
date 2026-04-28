// ============================================================
// AURA. — Servico de Calendario de Obrigacoes
//
// PR37 (2026-04-28): suporte a vertical_active='odonto' (UNION cnae='saude')
// + filtros de toggle (uses_controlled_meds, vigilancia_alvara_reminder_enabled)
// + novos due_rules (quarterly_30, quarterly_15, last_business_day, manual_renewal).
//
// LINGUAGEM INVIOLAVEL:
//   SEMPRE: "estimativa", "apoio contabil", "informativo"
//   NUNCA: "declaracao oficial", "transmissao", "assessoria tributaria"
// ============================================================

const db = require('../config/database');

async function getCompanyProfile(companyId) {
  const { rows } = await db.query(
    `SELECT
       c.id, c.legal_name AS name, c.tax_regime, c.cnae_code, c.annual_revenue,
       c.vertical_active,
       c.dental_compliance_enabled,
       c.uses_controlled_meds,
       c.vigilancia_alvara_reminder_enabled,
       c.vigilancia_alvara_expires_at,
       EXISTS (
         SELECT 1 FROM employees e
         WHERE e.company_id = c.id AND e.is_active = true
       ) AS has_employee
     FROM companies c
     WHERE c.id = $1`,
    [companyId]
  );
  return rows[0] || null;
}

function getCnaeCategory(cnaeCode) {
  if (!cnaeCode) return 'general';
  const code = cnaeCode.replace(/\D/g, '');
  if (/^4[67]/.test(code)) return 'icms';
  return 'general';
}

// PR37: lista de categorias CNAE aplicaveis pra empresa.
// 'general' sempre; 'icms' se comercio; 'saude' se vertical odonto + flag enabled.
function getApplicableCategories(company) {
  const cats = ['general'];
  const baseCat = getCnaeCategory(company.cnae_code);
  if (baseCat !== 'general') cats.push(baseCat); // 'icms'
  if (company.vertical_active === 'odonto' && company.dental_compliance_enabled !== false) {
    cats.push('saude');
  }
  return cats;
}

async function getApplicableTemplates(regime, hasEmployee, categories) {
  const { rows } = await db.query(
    `SELECT *
     FROM obligations_templates
     WHERE active = true
       AND regime IN ($1, 'both')
       AND (
         has_employee IS NULL
         OR has_employee = $2
       )
       AND cnae_category = ANY($3::text[])
     ORDER BY sort_order ASC`,
    [regime, hasEmployee, categories]
  );
  return rows;
}

// PR37: filtra templates de acordo com toggles do company
function applyComplianceFilters(templates, company) {
  return templates.filter((t) => {
    // SNGPC so se a clinica usa medicamentos controlados
    if (t.code === 'SNGPC_NOTIFICACAO' && !company.uses_controlled_meds) return false;
    // Alvara so se reminder ligado
    if (t.code === 'ALVARA_VIGILANCIA' && company.vigilancia_alvara_reminder_enabled === false) return false;
    return true;
  });
}

function getNextDueDate(template, referenceDate = new Date(), company = null) {
  const now = referenceDate;
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-12

  // Helper pra ultimo dia util do mes (PR37 - aproximacao: dia 28 quando mes tem fim de semana cedo)
  function lastBusinessDay(y, m /* 1-12 */) {
    let d = new Date(y, m, 0); // ultimo dia do mes
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
    return d;
  }
  // Trimestres terminam em mar/jun/set/dez. Vencimento dia X do mes seguinte.
  function nextQuarterDeadline(currYear, currMonth, day) {
    // Encontra fim de trimestre >= mes atual
    const ends = [3, 6, 9, 12];
    for (const m of ends) {
      if (m >= currMonth) {
        const d = new Date(currYear, m, day); // dia X do mes M+1 (zero-indexed em JS)
        if (d >= now) return d;
      }
    }
    // Proximo ano
    return new Date(currYear + 1, 3, day); // Q1 do ano seguinte (abr)
  }

  switch (template.due_rule) {
    case 'day_20': {
      const d = new Date(year, month - 1, 20);
      return d < now ? new Date(year, month, 20) : d;
    }
    case 'day_7': {
      const d = new Date(year, month - 1, 7);
      return d < now ? new Date(year, month, 7) : d;
    }
    case 'may_31': {
      const d = new Date(year, 4, 31);
      return d < now ? new Date(year + 1, 4, 31) : d;
    }
    case 'mar_31': {
      const d = new Date(year, 2, 31);
      return d < now ? new Date(year + 1, 2, 31) : d;
    }
    case 'apr_30': {
      const d = new Date(year, 3, 30);
      return d < now ? new Date(year + 1, 3, 30) : d;
    }
    case 'nov_dec':
      return new Date(year, 10, 30);
    case 'last_business_day': {
      const d = lastBusinessDay(year, month);
      return d < now ? lastBusinessDay(year, month + 1) : d;
    }
    case 'quarterly_30':
      return nextQuarterDeadline(year, month, 30);
    case 'quarterly_15':
      return nextQuarterDeadline(year, month, 15);
    case 'manual_renewal':
      // PR37: usa data cadastrada manualmente em companies.vigilancia_alvara_expires_at
      if (company && company.vigilancia_alvara_expires_at) {
        return new Date(company.vigilancia_alvara_expires_at);
      }
      return null;
    case 'per_event':
    case 'continuous':
      return null;
    default:
      // Fallback: usa due_month + due_day se setados
      if (template.due_day != null) {
        const m = (template.due_month != null ? template.due_month : month) - 1;
        const y = template.due_month != null && template.due_month < month ? year + 1 : year;
        const d = new Date(y, m, template.due_day);
        return d < now ? new Date(y + 1, m, template.due_day) : d;
      }
      return null;
  }
}

function getAlertLevel(dueDate, status) {
  if (!dueDate || status === 'completed') return null;
  const days = Math.ceil((new Date(dueDate) - new Date()) / 86400000);
  if (days < 0)   return 'overdue';
  if (days <= 3)  return 'critical';
  if (days <= 7)  return 'warning';
  if (days <= 15) return 'info';
  // PR37: alvara da vigilancia tem janelas mais largas (60/30/7d)
  if (days <= 30) return 'warning_long';
  if (days <= 60) return 'info_long';
  return null;
}

async function getPersonalizedCalendar(companyId) {
  const company = await getCompanyProfile(companyId);
  if (!company) return null;

  const { tax_regime, has_employee, name } = company;
  const categories = getApplicableCategories(company);

  let templates = await getApplicableTemplates(tax_regime, has_employee, categories);
  templates = applyComplianceFilters(templates, company);

  const { rows: existingObs } = await db.query(
    `SELECT code, status, checkpoint_done, checkpoint_total, due_date, completed_at
     FROM fiscal_obligations
     WHERE company_id = $1
     ORDER BY due_date DESC`,
    [companyId]
  );

  const existingMap = {};
  existingObs.forEach(ob => {
    if (!existingMap[ob.code]) existingMap[ob.code] = ob;
  });

  const calendar = templates.map(t => {
    const existing = existingMap[t.code];
    const dueDate  = existing?.due_date ? new Date(existing.due_date) : getNextDueDate(t, new Date(), company);
    const status   = existing?.status || 'pending';

    return {
      code:             t.code,
      name:             t.name_display,
      description:      t.description,
      frequency:        t.frequency,
      due_date:         dueDate,
      due_rule:         t.due_rule,
      responsible:      t.responsible,
      filter_label:     t.filter_label,
      aura_action:      t.aura_action,
      user_action:      t.user_action || null,
      time_estimate:    t.time_estimate || null,
      cnae_category:    t.cnae_category,
      status,
      checkpoint_done:  existing?.checkpoint_done || 0,
      checkpoint_total: t.checkpoint_total,
      alert_level:      getAlertLevel(dueDate, status),
      days_until_due:   dueDate
        ? Math.ceil((new Date(dueDate) - new Date()) / 86400000)
        : null,
    };
  });

  const summary = {
    aura_resolve: calendar.filter(c => c.filter_label === 'aura_resolve').length,
    voce_faz:     calendar.filter(c => c.filter_label === 'voce_faz').length,
    contador:     calendar.filter(c => c.filter_label === 'contador').length,
    overdue:      calendar.filter(c => c.alert_level === 'overdue').length,
    upcoming:     calendar.filter(c => ['critical','warning'].includes(c.alert_level)).length,
    saude_count:  calendar.filter(c => c.cnae_category === 'saude').length,
  };

  return {
    company: {
      id: company.id, name, tax_regime, has_employee,
      cnae_category: getCnaeCategory(company.cnae_code),
      categories,
      vertical_active: company.vertical_active,
    },
    calendar,
    summary,
    disclaimer: 'Calendario informativo. Valores e prazos sao estimativas. A transmissao oficial de cada obrigacao e responsabilidade do titular ou analista.',
  };
}

module.exports = { getPersonalizedCalendar, getCompanyProfile, getApplicableTemplates, getApplicableCategories };
