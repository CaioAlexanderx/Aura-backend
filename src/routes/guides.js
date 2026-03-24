// ============================================================
// AURA. — Guia Fiscal Assistido
// Feature: BE-26
// ============================================================
// Endpoints:
//   GET  /companies/:id/guides                    → listar guias disponíveis para o regime da empresa
//   GET  /companies/:id/guides/:slug              → guia + valores calculados para o período
//   POST /companies/:id/guides/:slug/complete     → marcar guia como concluído
//   POST /companies/:id/guides/:slug/report-stale → reportar passo desatualizado
//   GET  /admin/guides                            → admin: listar todos os guias
//   PUT  /admin/guides/:slug                      → admin: atualizar guia (sem deploy)
//   POST /admin/guides/:slug/staleness-check      → admin: forçar verificação de staleness
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

// ─── Helpers ────────────────────────────────────────────────

// Retorna o regime tributário da empresa ('mei' | 'me' | null)
async function getCompanyRegime(companyId) {
  const res = await db.query(
    `SELECT tax_regime FROM companies WHERE id = $1`,
    [companyId]
  );
  return res.rows[0]?.tax_regime || null;
}

// Calcula os valores dinâmicos que serão injetados no guia
// Cada value_key vira um campo com label + valor + copiável
async function computeGuideValues(slug, companyId, period) {
  const values = {};

  try {
    if (slug === 'pgdas_d') {
      // period = 'YYYY-MM'
      const [year, month] = (period || '').split('-');
      if (!year || !month) return values;

      const start = `${year}-${month}-01`;
      const end   = `${year}-${month}-31`; // o DB trata o overflow

      // Receita bruta do mês por categoria
      const receitas = await db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN category = 'product' OR category IS NULL THEN amount ELSE 0 END), 0) AS comercio,
           COALESCE(SUM(CASE WHEN category = 'service' THEN amount ELSE 0 END), 0) AS servicos
         FROM transactions
         WHERE company_id = $1
           AND type = 'income'
           AND date >= $2 AND date <= $3`,
        [companyId, start, end]
      );

      const comercio = parseFloat(receitas.rows[0]?.comercio || 0);
      const servicos = parseFloat(receitas.rows[0]?.servicos || 0);

      // ISS retido na fonte no mês (campo retencao_iss nas transactions)
      const issRes = await db.query(
        `SELECT COALESCE(SUM(retention_iss), 0) AS total
         FROM transactions
         WHERE company_id = $1
           AND type = 'income'
           AND date >= $2 AND date <= $3
           AND retention_iss IS NOT NULL AND retention_iss > 0`,
        [companyId, start, end]
      );
      const issRetido = parseFloat(issRes.rows[0]?.total || 0);

      // Fator R (últimos 12 meses)
      const fatorRRes = await db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN t.type = 'expense' AND t.category = 'payroll' THEN t.amount ELSE 0 END), 0) AS folha_12m,
           COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount ELSE 0 END), 0) AS faturamento_12m
         FROM transactions t
         WHERE t.company_id = $1
           AND t.date >= (DATE $2 - INTERVAL '11 months')::date
           AND t.date <= $3`,
        [companyId, start, end]
      );

      const folha12m       = parseFloat(fatorRRes.rows[0]?.folha_12m || 0);
      const faturamento12m = parseFloat(fatorRRes.rows[0]?.faturamento_12m || 0);
      const fatorR         = faturamento12m > 0 ? (folha12m / faturamento12m) : 0;
      const fatorRPct      = (fatorR * 100).toFixed(1);
      const anexoServicos  = fatorR >= 0.28 ? 'III (6%)' : 'V (15,5%)';

      // DAS estimado simples (Anexo I para comércio ~6%, Anexo III/V para serviços)
      const aliquotaComercio = 0.06;
      const aliquotaServicos = fatorR >= 0.28 ? 0.06 : 0.155;
      const dasEstimado = (comercio * aliquotaComercio + servicos * aliquotaServicos) - issRetido;

      values.receita_comercio     = { label: `Receita de comércio — ${month}/${year}`, value: formatBRL(comercio), raw: comercio };
      values.receita_servicos     = { label: `Receita de serviços — ${month}/${year}`, value: formatBRL(servicos), raw: servicos };
      values.fator_r_percentual   = { label: 'Fator R (últimos 12 meses)', value: `${fatorRPct}%`, raw: fatorR, alert: fatorR < 0.28 && servicos > 0 ? 'Abaixo de 28% — tributação pelo Anexo V. Considere ajustar o pró-labore.' : null };
      values.fator_r              = { label: 'Anexo de serviços', value: anexoServicos, raw: anexoServicos };
      values.anexo_servicos       = values.fator_r;
      values.iss_retido           = { label: 'ISS retido na fonte', value: formatBRL(issRetido), raw: issRetido };
      values.valor_das_estimado   = { label: 'DAS estimado (antes de pagar)', value: formatBRL(Math.max(dasEstimado, 0)), raw: Math.max(dasEstimado, 0), note: 'Estimativa da Aura — confira o valor gerado pelo sistema da Receita Federal.' };
    }

    if (slug === 'dasn_simei') {
      const year = period || new Date().getFullYear() - 1;
      const start = `${year}-01-01`;
      const end   = `${year}-12-31`;

      const receitas = await db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN category = 'product' OR category IS NULL THEN amount ELSE 0 END), 0) AS comercio,
           COALESCE(SUM(CASE WHEN category = 'service' THEN amount ELSE 0 END), 0) AS servicos
         FROM transactions
         WHERE company_id = $1 AND type = 'income' AND date >= $2 AND date <= $3`,
        [companyId, start, end]
      );

      const funcRes = await db.query(
        `SELECT COUNT(*) > 0 AS teve_funcionario
         FROM payroll_records
         WHERE company_id = $1
           AND period >= $2 AND period <= $3`,
        [companyId, start, end]
      );

      values.faturamento_comercio_anual = { label: `Receita de comércio — ${year}`, value: formatBRL(parseFloat(receitas.rows[0]?.comercio || 0)) };
      values.faturamento_servicos_anual = { label: `Receita de serviços — ${year}`, value: formatBRL(parseFloat(receitas.rows[0]?.servicos || 0)) };
      values.teve_funcionario           = { label: 'Teve funcionário em algum mês', value: funcRes.rows[0]?.teve_funcionario ? 'Sim' : 'Não' };
    }

    if (slug === 'defis') {
      const year = period || new Date().getFullYear() - 1;
      const start = `${year}-01-01`;
      const end   = `${year}-12-31`;

      const receitas = await db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN category = 'product' OR category IS NULL THEN amount ELSE 0 END), 0) AS comercio,
           COALESCE(SUM(CASE WHEN category = 'service' THEN amount ELSE 0 END), 0) AS servicos
         FROM transactions
         WHERE company_id = $1 AND type = 'income' AND date >= $2 AND date <= $3`,
        [companyId, start, end]
      );

      values.faturamento_anual_comercio = { label: `Receita de comércio — ${year}`, value: formatBRL(parseFloat(receitas.rows[0]?.comercio || 0)) };
      values.faturamento_anual_servicos = { label: `Receita de serviços — ${year}`, value: formatBRL(parseFloat(receitas.rows[0]?.servicos || 0)) };
      values.media_funcionarios         = { label: 'Média de funcionários', value: '0', note: 'Verifique na folha de pagamento de cada mês.' };
    }

  } catch (err) {
    console.error('[guides] computeGuideValues error:', err.message);
    // Retorna valores parciais — nunca falha a requisição por erro de cálculo
  }

  return values;
}

function formatBRL(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

// ─── Rotas do cliente ────────────────────────────────────────

// GET /companies/:id/guides
// Lista guias disponíveis para o regime tributário da empresa
router.get('/', authenticateToken, async (req, res) => {
  try {
    const companyId = req.params.id;
    const regime    = await getCompanyRegime(companyId);
    const type      = regime === 'mei' ? 'mei' : 'me';

    const result = await db.query(
      `SELECT slug, title, subtitle, obligation_type, deep_link, version,
              fallback_mode, notes, updated_at
       FROM guide_configs
       WHERE is_active = true
         AND (obligation_type = $1 OR obligation_type = 'both')
       ORDER BY
         CASE obligation_type WHEN 'both' THEN 3 WHEN $1 THEN 1 ELSE 2 END,
         title`,
      [type]
    );

    res.json({ guides: result.rows, regime });
  } catch (err) {
    console.error('[guides] list error:', err);
    res.status(500).json({ error: 'Erro ao listar guias' });
  }
});

// GET /companies/:id/guides/:slug?period=YYYY-MM
// Retorna guia completo + valores calculados para o período
router.get('/:slug', authenticateToken, async (req, res) => {
  try {
    const { id: companyId, slug } = req.params;
    const { period } = req.query; // 'YYYY-MM' para mensal, 'YYYY' para anual

    const guideRes = await db.query(
      `SELECT * FROM guide_configs WHERE slug = $1 AND is_active = true`,
      [slug]
    );

    if (!guideRes.rows[0]) {
      return res.status(404).json({ error: 'Guia não encontrado' });
    }

    const guide  = guideRes.rows[0];
    const values = await computeGuideValues(slug, companyId, period);

    // Verificar se já foi concluído neste período
    let completion = null;
    if (period) {
      const compRes = await db.query(
        `SELECT completed_at, receipt_url FROM guide_completions
         WHERE company_id = $1 AND guide_slug = $2 AND period = $3`,
        [companyId, slug, period]
      );
      completion = compRes.rows[0] || null;
    }

    // Checar se há relatórios de staleness não resolvidos
    const staleRes = await db.query(
      `SELECT step_id, created_at FROM guide_stale_reports
       WHERE guide_slug = $1 AND resolved = false
       ORDER BY created_at DESC LIMIT 5`,
      [slug]
    );

    const hasStaleReports = staleRes.rows.length > 0;
    const effectiveFallback = guide.fallback_mode || hasStaleReports;

    res.json({
      guide: {
        ...guide,
        fallback_mode: effectiveFallback,
        stale_steps: staleRes.rows.map(r => r.step_id)
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

// POST /companies/:id/guides/:slug/complete
// Marca guia como concluído para um período
router.post('/:slug/complete', authenticateToken, async (req, res) => {
  try {
    const { id: companyId, slug } = req.params;
    const { period, receipt_url, notes } = req.body;

    if (!period) {
      return res.status(400).json({ error: 'Campo period é obrigatório' });
    }

    const result = await db.query(
      `INSERT INTO guide_completions (company_id, guide_slug, period, receipt_url, notes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, guide_slug, period)
       DO UPDATE SET receipt_url = EXCLUDED.receipt_url, notes = EXCLUDED.notes
       RETURNING *`,
      [companyId, slug, period, receipt_url || null, notes || null]
    );

    res.status(201).json({ completion: result.rows[0] });
  } catch (err) {
    console.error('[guides] complete error:', err);
    res.status(500).json({ error: 'Erro ao registrar conclusão' });
  }
});

// POST /companies/:id/guides/:slug/report-stale
// Cliente reporta que um passo está desatualizado
router.post('/:slug/report-stale', authenticateToken, async (req, res) => {
  try {
    const { id: companyId, slug } = req.params;
    const { step_id, notes } = req.body;

    if (!step_id) {
      return res.status(400).json({ error: 'Campo step_id é obrigatório' });
    }

    await db.query(
      `INSERT INTO guide_stale_reports (guide_slug, step_id, company_id, notes)
       VALUES ($1, $2, $3, $4)`,
      [slug, step_id, companyId, notes || null]
    );

    res.json({ message: 'Reporte recebido. Nossa equipe irá atualizar o guia em breve.' });
  } catch (err) {
    console.error('[guides] report-stale error:', err);
    res.status(500).json({ error: 'Erro ao registrar reporte' });
  }
});

// ─── Rotas de admin ──────────────────────────────────────────

// GET /admin/guides
// Lista todos os guias com status de staleness
router.get('/admin/guides', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         g.*,
         COUNT(DISTINCT sr.id) FILTER (WHERE sr.resolved = false) AS open_stale_reports,
         COUNT(DISTINCT gc.id) AS total_completions
       FROM guide_configs g
       LEFT JOIN guide_stale_reports sr ON sr.guide_slug = g.slug
       LEFT JOIN guide_completions gc ON gc.guide_slug = g.slug
       GROUP BY g.id
       ORDER BY g.title`
    );

    res.json({ guides: result.rows });
  } catch (err) {
    console.error('[guides] admin list error:', err);
    res.status(500).json({ error: 'Erro ao listar guias' });
  }
});

// PUT /admin/guides/:slug
// Atualiza o guia (steps, screenshots, versão) sem deploy de código
router.put('/admin/guides/:slug', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { slug } = req.params;
    const { title, subtitle, steps, deep_link, fallback_mode, version, notes, is_active } = req.body;

    const fields = [];
    const vals   = [];
    let idx = 1;

    if (title        !== undefined) { fields.push(`title = $${idx++}`);        vals.push(title); }
    if (subtitle     !== undefined) { fields.push(`subtitle = $${idx++}`);     vals.push(subtitle); }
    if (steps        !== undefined) { fields.push(`steps = $${idx++}`);        vals.push(JSON.stringify(steps)); }
    if (deep_link    !== undefined) { fields.push(`deep_link = $${idx++}`);    vals.push(deep_link); }
    if (fallback_mode !== undefined) { fields.push(`fallback_mode = $${idx++}`); vals.push(fallback_mode); }
    if (version      !== undefined) { fields.push(`version = $${idx++}`);      vals.push(version); }
    if (notes        !== undefined) { fields.push(`notes = $${idx++}`);        vals.push(notes); }
    if (is_active    !== undefined) { fields.push(`is_active = $${idx++}`);    vals.push(is_active); }

    if (!fields.length) {
      return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    }

    vals.push(slug);
    const result = await db.query(
      `UPDATE guide_configs SET ${fields.join(', ')} WHERE slug = $${idx} RETURNING *`,
      vals
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Guia não encontrado' });

    res.json({ guide: result.rows[0] });
  } catch (err) {
    console.error('[guides] admin update error:', err);
    res.status(500).json({ error: 'Erro ao atualizar guia' });
  }
});

// POST /admin/guides/:slug/resolve-stale
// Marca relatórios de staleness como resolvidos após atualizar o guia
router.post('/admin/guides/:slug/resolve-stale', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const { slug } = req.params;
    const { step_id } = req.body; // se omitido, resolve todos

    const query = step_id
      ? `UPDATE guide_stale_reports SET resolved = true, resolved_at = NOW()
         WHERE guide_slug = $1 AND step_id = $2 AND resolved = false`
      : `UPDATE guide_stale_reports SET resolved = true, resolved_at = NOW()
         WHERE guide_slug = $1 AND resolved = false`;

    const params = step_id ? [slug, step_id] : [slug];
    const result = await db.query(query, params);

    res.json({ resolved_count: result.rowCount });
  } catch (err) {
    console.error('[guides] resolve-stale error:', err);
    res.status(500).json({ error: 'Erro ao resolver relatórios' });
  }
});

module.exports = router;
