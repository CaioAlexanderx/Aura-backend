// ============================================================
// AURA. — Serviço de Calendário de Obrigações (BE-24)
// Gera visão personalizada por regime + CNAE + tem funcionário
//
// LINGUAGEM INVIOLÁVEL:
//   SEMPRE: "estimativa", "apoio contábil", "informativo"
//   NUNCA: "declaração oficial", "transmissão", "assessoria tributária"
// ============================================================

const db = require('../config/database');

/**
 * Busca dados da empresa necessários para montar o calendário
 */
async function getCompanyProfile(companyId) {
  const { rows } = await db.query(
    `SELECT
       c.id, c.name, c.tax_regime, c.cnae_code, c.annual_revenue,
       -- Verifica se tem funcionário ativo
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

/**
 * Determina a categoria CNAE para filtrar templates
 * general: maioria dos CNAEs (varejo, serviços, saúde, beleza)
 * icms:    comércio — precisa de Inscrição Estadual
 */
function getCnaeCategory(cnaeCode) {
  if (!cnaeCode) return 'general';
  const code = cnaeCode.replace(/\D/g, '');
  // CNAEs de comércio (grupo 47xx = comércio varejista, 46xx = atacadista)
  if (/^4[67]/.test(code)) return 'icms';
  return 'general';
}

/**
 * Busca templates aplicáveis para o perfil da empresa
 */
async function getApplicableTemplates(regime, hasEmployee, cnaeCategory) {
  const { rows } = await db.query(
    `SELECT *
     FROM obligations_templates
     WHERE active = true
       AND regime IN ($1, 'both')
       AND (
         has_employee IS NULL
         OR has_employee = $2
       )
       AND (
         cnae_category = 'general'
         OR cnae_category = $3
       )
     ORDER BY sort_order ASC`,
    [regime, hasEmployee, cnaeCategory]
  );
  return rows;
}

/**
 * Calcula próximo vencimento de uma obrigação a partir do template
 */
function getNextDueDate(template, referenceDate = new Date()) {
  const now = referenceDate;
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

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
    case 'per_event':
    case 'continuous':
      return null;
    default:
      return null;
  }
}

/**
 * Calcula nível de alerta com base no prazo
 */
function getAlertLevel(dueDate, status) {
  if (!dueDate || status === 'completed') return null;
  const days = Math.ceil((new Date(dueDate) - new Date()) / 86400000);
  if (days < 0)   return 'overdue';
  if (days <= 3)  return 'critical';
  if (days <= 7)  return 'warning';
  if (days <= 15) return 'info';
  return null;
}

/**
 * Monta o calendário personalizado completo da empresa
 */
async function getPersonalizedCalendar(companyId) {
  const company = await getCompanyProfile(companyId);
  if (!company) return null;

  const { tax_regime, cnae_code, has_employee, name } = company;
  const cnaeCategory = getCnaeCategory(cnae_code);

  const templates = await getApplicableTemplates(tax_regime, has_employee, cnaeCategory);

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
    const dueDate  = existing?.due_date ? new Date(existing.due_date) : getNextDueDate(t);
    const status   = existing?.status || 'pending';

    return {
      code:             t.code,
      name:             t.name_display,
      frequency:        t.frequency,
      due_date:         dueDate,
      due_rule:         t.due_rule,
      responsible:      t.responsible,
      filter_label:     t.filter_label,
      aura_action:      t.aura_action,
      user_action:      t.user_action || null,
      time_estimate:    t.time_estimate || null,
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
  };

  return {
    company: { id: company.id, name, tax_regime, has_employee, cnae_category: cnaeCategory },
    calendar,
    summary,
    disclaimer: 'Calendário informativo. Valores e prazos são estimativas. A transmissão oficial de cada obrigação é responsabilidade do titular ou analista.',
  };
}

module.exports = { getPersonalizedCalendar, getCompanyProfile, getApplicableTemplates };
