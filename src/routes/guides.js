// ============================================================
// AURA. — Guia Assistido Universal
// Features: BE-26 (fiscal) + BE-29 (trabalhista ME)
// ============================================================
// Endpoints:
//   GET  /companies/:id/guides                        → listar guias (filtros: category, module, plan)
//   GET  /companies/:id/guides/:slug?period=          → guia + valores calculados
//   POST /companies/:id/guides/:slug/complete         → marcar como concluído
//   POST /companies/:id/guides/:slug/report-stale     → reportar passo desatualizado
//   GET  /admin/guides                                → admin: todos os guias + stats
//   PUT  /admin/guides/:slug                          → admin: atualizar guia sem deploy
//   POST /admin/guides/:slug/resolve-stale            → admin: fechar reports
//
// Convenção de period:
//   Guias mensais:          'YYYY-MM'          ex: '2026-02'
//   Guias anuais:           'YYYY'             ex: '2025'
//   Guias por funcionário:  'employee:UUID'    ex: 'employee:abc-123'
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

// ─── Utilitários ────────────────────────────────────────────

function formatBRL(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

function parsePeriod(period) {
  if (!period) return { type: null };
  if (period.startsWith('employee:')) {
    return { type: 'employee', employeeId: period.replace('employee:', '') };
  }
  const parts = period.split('-');
  if (parts.length === 2) return { type: 'monthly', year: parts[0], month: parts[1] };
  if (parts.length === 1 && parts[0].length === 4) return { type: 'annual', year: parts[0] };
  return { type: null };
}

function calcINSSPatronal(salarioBruto) {
  return salarioBruto * 0.258;
}

function calcINSSEmpregado(salarioBruto) {
  if (salarioBruto <= 1518.00)  return salarioBruto * 0.075;
  if (salarioBruto <= 2793.88)  return salarioBruto * 0.09;
  if (salarioBruto <= 4190.83)  return salarioBruto * 0.12;
  if (salarioBruto <= 8157.41)  return salarioBruto * 0.14;
  return 1142.04;
}

function calcIRRF(baseCalculo) {
  if (baseCalculo <= 2259.20)  return 0;
  if (baseCalculo <= 2826.65)  return baseCalculo * 0.075 - 169.44;
  if (baseCalculo <= 3751.05)  return baseCalculo * 0.15  - 381.44;
  if (baseCalculo <= 4664.68)  return baseCalculo * 0.225 - 662.77;
  return baseCalculo * 0.275 - 896.00;
}

// ─── computeGuideValues — motor central ─────────────────────

async function computeGuideValues(slug, companyId, period) {
  const values = {};

  try {

    // ── FISCAL ──────────────────────────────────────────────

    if (slug === 'pgdas_d') {
      const { year, month } = parsePeriod(period);
      if (!year || !month) return values;
      const start = `${year}-${month}-01`;
      const end   = `${year}-${month}-31`;

      const rec = await db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN category IN ('product','commerce') OR category IS NULL THEN amount ELSE 0 END),0) AS comercio,
           COALESCE(SUM(CASE WHEN category = 'service' THEN amount ELSE 0 END),0) AS servicos
         FROM transactions
         WHERE company_id=$1 AND type='income' AND date>=$2 AND date<=$3`,
        [companyId, start, end]
      );
      const comercio = parseFloat(rec.rows[0]?.comercio || 0);
      const servicos = parseFloat(rec.rows[0]?.servicos || 0);

      const issR = await db.query(
        `SELECT COALESCE(SUM(retention_iss),0) AS total FROM transactions
         WHERE company_id=$1 AND type='income' AND date>=$2 AND date<=$3
           AND retention_iss IS NOT NULL AND retention_iss > 0`,
        [companyId, start, end]
      );
      const issRetido = parseFloat(issR.rows[0]?.total || 0);

      const frR = await db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN type='expense' AND category='payroll' THEN amount ELSE 0 END),0) AS folha,
           COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) AS fat
         FROM transactions
         WHERE company_id=$1
           AND date>=(DATE $2 - INTERVAL '11 months')::date
           AND date<=$3`,
        [companyId, start, end]
      );
      const folha12 = parseFloat(frR.rows[0]?.folha || 0);
      const fat12   = parseFloat(frR.rows[0]?.fat   || 0);
      const fatorR  = fat12 > 0 ? folha12 / fat12 : 0;
      const fPct    = (fatorR * 100).toFixed(1);
      const anexo   = fatorR >= 0.28 ? 'III (6%)' : 'V (15,5%)';
      const aliqS   = fatorR >= 0.28 ? 0.06 : 0.155;
      const das     = Math.max((comercio * 0.06 + servicos * aliqS) - issRetido, 0);

      values.receita_comercio    = { label: `Receita de comércio — ${month}/${year}`,  value: formatBRL(comercio), raw: comercio };
      values.receita_servicos    = { label: `Receita de serviços — ${month}/${year}`,  value: formatBRL(servicos), raw: servicos };
      values.fator_r_percentual  = { label: 'Fator R (últimos 12 meses)', value: `${fPct}%`, raw: fatorR,
        alert: fatorR < 0.28 && servicos > 0 ? 'Fator R abaixo de 28% — tributação pelo Anexo V. Considere ajustar o pró-labore.' : null };
      values.fator_r             = { label: 'Anexo de serviços', value: anexo, raw: anexo };
      values.anexo_servicos      = values.fator_r;
      values.iss_retido          = { label: 'ISS retido na fonte', value: formatBRL(issRetido), raw: issRetido };
      values.valor_das_estimado  = { label: 'Estimativa do boleto mensal', value: formatBRL(das), raw: das,
        note: 'Estimativa da Aura — confira o valor gerado pelo sistema da Receita Federal.' };
    }

    if (slug === 'dasn_simei') {
      const { year } = parsePeriod(period) || { year: String(new Date().getFullYear() - 1) };
      const start = `${year}-01-01`, end = `${year}-12-31`;

      const rec = await db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN category IN ('product','commerce') OR category IS NULL THEN amount ELSE 0 END),0) AS comercio,
           COALESCE(SUM(CASE WHEN category='service' THEN amount ELSE 0 END),0) AS servicos
         FROM transactions WHERE company_id=$1 AND type='income' AND date>=$2 AND date<=$3`,
        [companyId, start, end]
      );
      const funcR = await db.query(
        `SELECT COUNT(*)>0 AS teve FROM payroll_records WHERE company_id=$1 AND period>=$2 AND period<=$3`,
        [companyId, start, end]
      );
      values.faturamento_comercio_anual = { label: `Receita de comércio — ${year}`, value: formatBRL(parseFloat(rec.rows[0]?.comercio||0)) };
      values.faturamento_servicos_anual = { label: `Receita de serviços — ${year}`, value: formatBRL(parseFloat(rec.rows[0]?.servicos||0)) };
      values.teve_funcionario           = { label: 'Teve funcionário em algum mês',  value: funcR.rows[0]?.teve ? 'Sim' : 'Não' };
    }

    if (slug === 'defis') {
      const { year } = parsePeriod(period) || { year: String(new Date().getFullYear() - 1) };
      const start = `${year}-01-01`, end = `${year}-12-31`;

      const rec = await db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN category IN ('product','commerce') OR category IS NULL THEN amount ELSE 0 END),0) AS comercio,
           COALESCE(SUM(CASE WHEN category='service' THEN amount ELSE 0 END),0) AS servicos
         FROM transactions WHERE company_id=$1 AND type='income' AND date>=$2 AND date<=$3`,
        [companyId, start, end]
      );
      const mediaR = await db.query(
        `SELECT ROUND(COUNT(DISTINCT employee_id)::numeric / NULLIF(COUNT(DISTINCT period),0), 1) AS media
         FROM payroll_records WHERE company_id=$1 AND period>=$2 AND period<=$3`,
        [companyId, start, end]
      );
      values.faturamento_anual_comercio = { label: `Receita de comércio — ${year}`, value: formatBRL(parseFloat(rec.rows[0]?.comercio||0)) };
      values.faturamento_anual_servicos = { label: `Receita de serviços — ${year}`, value: formatBRL(parseFloat(rec.rows[0]?.servicos||0)) };
      values.media_funcionarios         = { label: 'Média de funcionários no ano',   value: String(mediaR.rows[0]?.media || 0) };
    }

    // ── TRABALHISTA ──────────────────────────────────────────

    if (slug === 'esocial_folha_mensal') {
      const { year, month } = parsePeriod(period);
      if (!year || !month) return values;
      const per = `${year}-${month}`;

      const folhaR = await db.query(
        `SELECT
           COUNT(DISTINCT employee_id)          AS num_func,
           COALESCE(SUM(gross_salary),0)        AS total_bruto,
           COALESCE(SUM(inss_employee),0)       AS total_inss_func,
           COALESCE(SUM(irrf),0)                AS total_irrf,
           COALESCE(SUM(gross_salary * 0.08),0) AS total_fgts,
           COALESCE(SUM(net_salary),0)          AS total_liquido
         FROM payroll_records
         WHERE company_id=$1 AND period=$2`,
        [companyId, per]
      );

      const hasPayroll = parseInt(folhaR.rows[0]?.num_func || 0) > 0;
      let totalBruto, totalINSSFunc, totalIRRF, totalFGTS, totalLiquido, numFunc;

      if (hasPayroll) {
        totalBruto    = parseFloat(folhaR.rows[0]?.total_bruto     || 0);
        totalINSSFunc = parseFloat(folhaR.rows[0]?.total_inss_func  || 0);
        totalIRRF     = parseFloat(folhaR.rows[0]?.total_irrf       || 0);
        totalFGTS     = parseFloat(folhaR.rows[0]?.total_fgts       || 0);
        totalLiquido  = parseFloat(folhaR.rows[0]?.total_liquido    || 0);
        numFunc       = parseInt(folhaR.rows[0]?.num_func           || 0);
      } else {
        const empR = await db.query(
          `SELECT COALESCE(SUM(base_salary),0) AS total_sal, COUNT(*) AS cnt
           FROM employees WHERE company_id=$1 AND status='active'`,
          [companyId]
        );
        totalBruto    = parseFloat(empR.rows[0]?.total_sal || 0);
        numFunc       = parseInt(empR.rows[0]?.cnt         || 0);
        totalINSSFunc = totalBruto > 0 ? calcINSSEmpregado(totalBruto / Math.max(numFunc, 1)) * numFunc : 0;
        totalIRRF     = 0;
        totalFGTS     = totalBruto * 0.08;
        totalLiquido  = totalBruto - totalINSSFunc - totalIRRF;
      }

      const totalINSSPatronal = calcINSSPatronal(totalBruto);

      values.num_funcionarios       = { label: 'Funcionários na folha',             value: String(numFunc), raw: numFunc };
      values.total_salarios         = { label: `Total de salários — ${month}/${year}`, value: formatBRL(totalBruto), raw: totalBruto };
      values.total_inss_funcionarios = { label: 'INSS descontado dos funcionários', value: formatBRL(totalINSSFunc), raw: totalINSSFunc };
      values.total_irrf             = { label: 'IRRF retido na fonte',              value: formatBRL(totalIRRF), raw: totalIRRF };
      values.total_fgts             = { label: 'FGTS a depositar (8%)',             value: formatBRL(totalFGTS), raw: totalFGTS,
        note: 'Pago via FGTS Digital após fechar a folha no eSocial.' };
      values.total_liquido          = { label: 'Total líquido a pagar',             value: formatBRL(totalLiquido), raw: totalLiquido };
      values.inss_patronal_estimado = { label: 'INSS patronal estimado (25,8%)',    value: formatBRL(totalINSSPatronal), raw: totalINSSPatronal,
        note: 'Pago via DCTFWeb no e-CAC até o dia 20.' };
    }

    if (slug === 'dctfweb') {
      const { year, month } = parsePeriod(period);
      if (!year || !month) return values;
      const per = `${year}-${month}`;

      const folhaR = await db.query(
        `SELECT
           COALESCE(SUM(gross_salary),0)  AS total_bruto,
           COALESCE(SUM(inss_employee),0) AS inss_func,
           COALESCE(SUM(irrf),0)          AS irrf
         FROM payroll_records WHERE company_id=$1 AND period=$2`,
        [companyId, per]
      );

      let totalBruto = parseFloat(folhaR.rows[0]?.total_bruto || 0);
      if (totalBruto === 0) {
        const empR = await db.query(
          `SELECT COALESCE(SUM(base_salary),0) AS s FROM employees WHERE company_id=$1 AND status='active'`,
          [companyId]
        );
        totalBruto = parseFloat(empR.rows[0]?.s || 0);
      }

      const inssFunc     = parseFloat(folhaR.rows[0]?.inss_func || 0);
      const irrf         = parseFloat(folhaR.rows[0]?.irrf      || 0);
      const inssPatronal = calcINSSPatronal(totalBruto);
      const totalDCTF    = inssPatronal + inssFunc + irrf;

      values.valor_inss_patronal     = { label: 'INSS da empresa (25,8%)',         value: formatBRL(inssPatronal), raw: inssPatronal };
      values.valor_inss_funcionarios = { label: 'INSS dos funcionários',            value: formatBRL(inssFunc),     raw: inssFunc };
      values.valor_irrf              = { label: 'IRRF retido na folha',             value: formatBRL(irrf),         raw: irrf };
      values.valor_total_dctfweb     = { label: `Total a pagar — ${month}/${year}`, value: formatBRL(totalDCTF),    raw: totalDCTF,
        note: 'Estimativa da Aura — confira o DARF gerado no e-CAC após transmitir a DCTFWeb.' };
    }

    if (slug === 'fgts_digital') {
      const { year, month } = parsePeriod(period);
      if (!year || !month) return values;
      const per = `${year}-${month}`;

      const folhaR = await db.query(
        `SELECT COALESCE(SUM(gross_salary),0) AS bruto, COUNT(DISTINCT employee_id) AS cnt
         FROM payroll_records WHERE company_id=$1 AND period=$2`,
        [companyId, per]
      );

      let totalBruto = parseFloat(folhaR.rows[0]?.bruto || 0);
      let numFunc    = parseInt(folhaR.rows[0]?.cnt     || 0);
      if (totalBruto === 0) {
        const empR = await db.query(
          `SELECT COALESCE(SUM(base_salary),0) AS s, COUNT(*) AS c FROM employees WHERE company_id=$1 AND status='active'`,
          [companyId]
        );
        totalBruto = parseFloat(empR.rows[0]?.s || 0);
        numFunc    = parseInt(empR.rows[0]?.c   || 0);
      }

      values.num_funcionarios = { label: 'Funcionários na folha',               value: String(numFunc), raw: numFunc };
      values.valor_fgts_total = { label: `FGTS a depositar — ${month}/${year}`, value: formatBRL(totalBruto * 0.08), raw: totalBruto * 0.08,
        note: 'Estimativa da Aura (8% do salário bruto). Confira a Guia do FGTS Digital gerada pelo eSocial.' };
    }

    if (slug === 'esocial_admissao_me' || slug === 'esocial_admissao') {
      const { type, employeeId } = parsePeriod(period);
      if (type === 'employee' && employeeId) {
        const empR = await db.query(
          `SELECT name, cpf, admission_date, base_salary, role, work_hours
           FROM employees WHERE id=$1 AND company_id=$2`,
          [employeeId, companyId]
        );
        if (empR.rows[0]) {
          const e = empR.rows[0];
          values.nome_funcionario = { label: 'Nome do funcionário', value: e.name || '' };
          values.cpf_funcionario  = { label: 'CPF',                 value: e.cpf  || '' };
          values.data_admissao    = { label: 'Data de admissão',     value: e.admission_date ? new Date(e.admission_date).toLocaleDateString('pt-BR') : '' };
          values.salario          = { label: 'Salário',              value: formatBRL(parseFloat(e.base_salary || 0)) };
          values.cargo            = { label: 'Cargo',                value: e.role || '' };
          values.jornada          = { label: 'Jornada semanal',      value: e.work_hours ? `${e.work_hours}h` : '44h' };
        }
      } else {
        values.nota = { label: 'Como usar este guia', value: 'Acesse Folha → Funcionários → Novo Funcionário na Aura primeiro. Depois abra este guia a partir do cadastro do funcionário.' };
      }
    }

    if (slug === 'esocial_demissao') {
      const { type, employeeId } = parsePeriod(period);
      if (type === 'employee' && employeeId) {
        const empR = await db.query(
          `SELECT name, cpf, base_salary FROM employees WHERE id=$1 AND company_id=$2`,
          [employeeId, companyId]
        );
        if (empR.rows[0]) {
          const e   = empR.rows[0];
          const sal = parseFloat(e.base_salary || 0);
          const totalVerbas    = sal + sal * (1 + 1/3) + sal / 12;
          const fgtsRescisorio = sal * 12 * 0.08;

          values.nome_funcionario   = { label: 'Funcionário',                    value: e.name || '' };
          values.cpf_funcionario    = { label: 'CPF',                            value: e.cpf  || '' };
          values.data_demissao      = { label: 'Data de saída',                  value: '' };
          values.motivo_demissao    = { label: 'Motivo da saída',                value: '' };
          values.verbas_rescisorias = { label: 'Verbas rescisórias estimadas',   value: formatBRL(totalVerbas), raw: totalVerbas,
            note: 'Estimativa sem aviso prévio. O valor exato depende do período trabalhado e do motivo da saída.' };
          values.saldo_fgts         = { label: 'FGTS rescisório estimado',       value: formatBRL(fgtsRescisorio), raw: fgtsRescisorio,
            note: 'Estimativa. O saldo real está no FGTS Digital após registrar a saída no eSocial.' };
        }
      }
    }

  } catch (err) {
    console.error('[guides] computeGuideValues error:', { slug, period, error: err.message });
  }

  return values;
}

// ─── GET /companies/:id/guides ───────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const companyId = req.params.id;
    const { category, module: mod } = req.query;

    const compR = await db.query(
      `SELECT tax_regime, plan FROM companies WHERE id=$1`, [companyId]
    );
    const regime = compR.rows[0]?.tax_regime || 'mei';
    const plan   = compR.rows[0]?.plan       || 'essencial';
    const type   = regime === 'mei' ? 'mei' : 'me';

    let whereClause = `WHERE is_active=true AND (obligation_type=$1 OR obligation_type='both')`;
    const params = [type];
    let idx = 2;

    whereClause += ` AND (plan_required IS NULL OR plan_required=$${idx++})`;
    params.push(plan);

    if (category) { whereClause += ` AND category=$${idx++}`;  params.push(category); }
    if (mod)      { whereClause += ` AND module=$${idx++}`;     params.push(mod); }

    const result = await db.query(
      `SELECT
         slug, title, subtitle, obligation_type, deep_link,
         version, fallback_mode, notes, category, module,
         plan_required, complexity, estimated_minutes, sort_order,
         updated_at
       FROM guide_configs
       ${whereClause}
       ORDER BY
         CASE category
           WHEN 'onboarding'  THEN 1
           WHEN 'fiscal'      THEN 2
           WHEN 'trabalhista' THEN 3
           WHEN 'importacao'  THEN 4
           ELSE 5
         END,
         sort_order, title`,
      params
    );

    const grouped = result.rows.reduce((acc, g) => {
      if (!acc[g.category]) acc[g.category] = [];
      acc[g.category].push(g);
      return acc;
    }, {});

    res.json({ guides: result.rows, grouped, regime, plan });
  } catch (err) {
    console.error('[guides] list error:', err);
    res.status(500).json({ error: 'Erro ao listar guias' });
  }
});

// ─── GET /companies/:id/guides/:slug ────────────────────────
router.get('/:slug', requireAuth, async (req, res) => {
  try {
    const { id: companyId, slug } = req.params;
    const { period } = req.query;

    const guideR = await db.query(
      `SELECT * FROM guide_configs WHERE slug=$1 AND is_active=true`, [slug]
    );
    if (!guideR.rows[0]) return res.status(404).json({ error: 'Guia não encontrado' });

    const guide  = guideR.rows[0];
    const values = await computeGuideValues(slug, companyId, period);

    let completion = null;
    if (period) {
      const cR = await db.query(
        `SELECT completed_at, receipt_url FROM guide_completions
         WHERE company_id=$1 AND guide_slug=$2 AND period=$3`,
        [companyId, slug, period]
      );
      completion = cR.rows[0] || null;
    }

    const staleR = await db.query(
      `SELECT step_id, created_at FROM guide_stale_reports
       WHERE guide_slug=$1 AND resolved=false
       ORDER BY created_at DESC LIMIT 5`,
      [slug]
    );

    res.json({
      guide: {
        ...guide,
        fallback_mode: guide.fallback_mode || staleR.rows.length > 0,
        stale_steps:   staleR.rows.map(r => r.step_id)
      },
      values,
      period,
      completion,
      computed_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('[guides] get error:', err);
    res.status(500).json({ error: 'Erro ao carregar guia' });
  }
});

// ─── POST /companies/:id/guides/:slug/complete ──────────────
router.post('/:slug/complete', requireAuth, async (req, res) => {
  try {
    const { id: companyId, slug } = req.params;
    const { period, receipt_url, notes } = req.body;

    if (!period) return res.status(400).json({ error: 'Campo period é obrigatório' });

    const result = await db.query(
      `INSERT INTO guide_completions (company_id, guide_slug, period, receipt_url, notes)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (company_id, guide_slug, period)
       DO UPDATE SET receipt_url=EXCLUDED.receipt_url, notes=EXCLUDED.notes
       RETURNING *`,
      [companyId, slug, period, receipt_url || null, notes || null]
    );
    res.status(201).json({ completion: result.rows[0] });
  } catch (err) {
    console.error('[guides] complete error:', err);
    res.status(500).json({ error: 'Erro ao registrar conclusão' });
  }
});

// ─── POST /companies/:id/guides/:slug/report-stale ──────────
router.post('/:slug/report-stale', requireAuth, async (req, res) => {
  try {
    const { id: companyId, slug } = req.params;
    const { step_id, notes } = req.body;

    if (!step_id) return res.status(400).json({ error: 'Campo step_id é obrigatório' });

    await db.query(
      `INSERT INTO guide_stale_reports (guide_slug, step_id, company_id, notes) VALUES ($1,$2,$3,$4)`,
      [slug, step_id, companyId, notes || null]
    );
    res.json({ message: 'Reporte recebido. Nossa equipe irá atualizar o guia em breve.' });
  } catch (err) {
    console.error('[guides] report-stale error:', err);
    res.status(500).json({ error: 'Erro ao registrar reporte' });
  }
});

// ─── ADMIN ───────────────────────────────────────────────────

router.get('/admin/guides', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         g.*,
         COUNT(DISTINCT sr.id) FILTER (WHERE sr.resolved=false) AS open_stale_reports,
         COUNT(DISTINCT gc.id)                                   AS total_completions
       FROM guide_configs g
       LEFT JOIN guide_stale_reports sr ON sr.guide_slug=g.slug
       LEFT JOIN guide_completions   gc ON gc.guide_slug=g.slug
       GROUP BY g.id
       ORDER BY g.category, g.sort_order, g.title`
    );
    res.json({ guides: result.rows });
  } catch (err) {
    console.error('[guides] admin list error:', err);
    res.status(500).json({ error: 'Erro ao listar guias' });
  }
});

router.put('/admin/guides/:slug', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { slug } = req.params;
    const allowed = ['title','subtitle','steps','deep_link','fallback_mode',
                     'version','notes','is_active','category','module',
                     'complexity','estimated_minutes','sort_order'];
    const fields = [], vals = [];
    let idx = 1;

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        fields.push(`${key}=$${idx++}`);
        vals.push(key === 'steps' ? JSON.stringify(req.body[key]) : req.body[key]);
      }
    }

    if (!fields.length) return res.status(400).json({ error: 'Nenhum campo para atualizar' });

    vals.push(slug);
    const result = await db.query(
      `UPDATE guide_configs SET ${fields.join(',')} WHERE slug=$${idx} RETURNING *`, vals
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Guia não encontrado' });
    res.json({ guide: result.rows[0] });
  } catch (err) {
    console.error('[guides] admin update error:', err);
    res.status(500).json({ error: 'Erro ao atualizar guia' });
  }
});

router.post('/admin/guides/:slug/resolve-stale', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { slug } = req.params;
    const { step_id } = req.body;

    const q = step_id
      ? `UPDATE guide_stale_reports SET resolved=true, resolved_at=NOW() WHERE guide_slug=$1 AND step_id=$2 AND resolved=false`
      : `UPDATE guide_stale_reports SET resolved=true, resolved_at=NOW() WHERE guide_slug=$1 AND resolved=false`;
    const r = await db.query(q, step_id ? [slug, step_id] : [slug]);
    res.json({ resolved_count: r.rowCount });
  } catch (err) {
    console.error('[guides] resolve-stale error:', err);
    res.status(500).json({ error: 'Erro ao resolver relatórios' });
  }
});

module.exports = router;
