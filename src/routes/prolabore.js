// ============================================================
// AURA. — FIN-01: Pró-labore + Fator R + Distribuição de Lucros
//
// Fator R = Folha dos últimos 12 meses / Receita Bruta 12 meses
// Se Fator R ≥ 28% → Simples Nacional Anexo III (alíquota mínima ~6%)
// Se Fator R < 28% → Simples Nacional Anexo V (alíquota ~15,5%)
//
// LINGUAGEM: "estimativa" — NUNCA "declaração oficial"
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireAuth, requirePlan } = require('../middleware/auth');

const guard = [requireAuth, requirePlan(['negocio','expansao'])];

// ── Tabela INSS sócio-administrador 2026 ────────────────────────
// Alíquota única de 11% (contribuinte individual), capped no teto
function calcINSS(amount, cap = 7786.02, rate = 0.11) {
  const base = Math.min(parseFloat(amount), parseFloat(cap));
  return parseFloat((base * parseFloat(rate)).toFixed(2));
}

// ── Fator R ──────────────────────────────────────────────────
// Fator R = (Pró-labore acumulado 12m) / (Receita Bruta 12m) * 100
function calcFatorR(prolabore12m, revenue12m) {
  if (!revenue12m || revenue12m <= 0) return null;
  return parseFloat(((prolabore12m / revenue12m) * 100).toFixed(2));
}

function fatorRStatus(fatorR, target = 28) {
  if (fatorR === null) return { anexo: null, alert: 'sem_dados' };
  if (fatorR >= target) return {
    anexo: 'III',
    aliquota_min: 6.0,
    status: 'ok',
    message: `Fator R em ${fatorR}% — você está no Anexo III (alíquota mínima ~6%). ✅`,
  };
  const gap = parseFloat((target - fatorR).toFixed(2));
  return {
    anexo: 'V',
    aliquota_min: 15.5,
    status: 'alerta',
    gap_pct: gap,
    message: `Fator R em ${fatorR}% — você está no Anexo V (alíquota ~15,5%). Aumente o pró-labore em ${gap}pp para ir ao Anexo III.`,
  };
}

// ── Busca dados financeiros dos últimos 12 meses ───────────────
async function _getRevenue12m(companyId) {
  const { rows } = await db.query(
    `SELECT
       COALESCE(SUM(amount),0) AS revenue_12m,
       COALESCE(SUM(CASE WHEN date_trunc('month', paid_at) = date_trunc('month', NOW()) THEN amount ELSE 0 END), 0) AS revenue_current_month
     FROM transactions
     WHERE company_id=$1
       AND type='income'
       AND status='confirmed'
       AND paid_at >= NOW() - INTERVAL '12 months'`,
    [companyId]
  );
  return {
    revenue_12m: parseFloat(rows[0]?.revenue_12m || 0),
    revenue_current_month: parseFloat(rows[0]?.revenue_current_month || 0),
  };
}

async function _getProlabore12m(companyId) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(amount),0) AS prolabore_12m
     FROM prolabore_history
     WHERE company_id=$1
       AND reference_month >= date_trunc('month', NOW()) - INTERVAL '11 months'`,
    [companyId]
  );
  return parseFloat(rows[0]?.prolabore_12m || 0);
}

// ──────────────────────────────────────────────────────
// ROTAS
// ──────────────────────────────────────────────────────

// GET /companies/:id/prolabore/config
router.get('/config', guard, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM prolabore_config WHERE company_id=$1`, [req.params.id]
    );
    res.json(rows[0] || { company_id: req.params.id, mode: 'auto', fator_r_target: 28, include_inss: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /companies/:id/prolabore/config  — cria ou atualiza configuração
router.put('/config', guard, async (req, res) => {
  const { fixed_amount, pct_of_revenue, mode, fator_r_target, include_inss, inss_rate, inss_cap } = req.body;
  if (!['fixed','pct','auto'].includes(mode))
    return res.status(400).json({ error: 'mode deve ser: fixed | pct | auto' });
  try {
    const { rows } = await db.query(
      `INSERT INTO prolabore_config
         (company_id, fixed_amount, pct_of_revenue, mode, fator_r_target, include_inss, inss_rate, inss_cap)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (company_id) DO UPDATE SET
         fixed_amount    = $2, pct_of_revenue = $3, mode           = $4,
         fator_r_target  = $5, include_inss   = $6, inss_rate      = $7,
         inss_cap        = $8, updated_at     = NOW()
       RETURNING *`,
      [req.params.id, fixed_amount||null, pct_of_revenue||null,
       mode||'auto', fator_r_target||28, include_inss!==false,
       inss_rate||0.11, inss_cap||7786.02]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /companies/:id/prolabore/preview
// Calcula pró-labore sugerido + Fator R + impacto no DAS
router.get('/preview', guard, async (req, res) => {
  try {
    const { rows: comp } = await db.query(
      `SELECT tax_regime FROM companies WHERE id=$1`, [req.params.id]
    );
    if (!comp.length) return res.status(404).json({ error: 'Empresa não encontrada' });

    const { rows: cfg } = await db.query(
      `SELECT * FROM prolabore_config WHERE company_id=$1`, [req.params.id]
    );
    const config = cfg[0] || { mode: 'auto', fator_r_target: 28, include_inss: true, inss_rate: 0.11, inss_cap: 7786.02 };

    const [revenueData, prolabore12m] = await Promise.all([
      _getRevenue12m(req.params.id),
      _getProlabore12m(req.params.id),
    ]);
    const { revenue_12m, revenue_current_month } = revenueData;

    // Calcular pró-labore sugerido
    let suggested_amount;
    if (config.mode === 'fixed') {
      suggested_amount = parseFloat(config.fixed_amount || 0);
    } else if (config.mode === 'pct') {
      suggested_amount = parseFloat(((config.pct_of_revenue / 100) * revenue_current_month).toFixed(2));
    } else {
      // auto: calcula o mínimo para atingir o Fator R alvo
      const target = parseFloat(config.fator_r_target || 28);
      // Fator R = (prolabore_12m + suggested) / revenue_12m >= target/100
      // suggested >= revenue_12m * target/100 - prolabore_12m
      const min_needed = revenue_12m * (target / 100) - prolabore12m;
      // Também considera pró-labore mínimo rázoavel (1 salário mínimo)
      suggested_amount = Math.max(min_needed, 1518); // salário mínimo 2026
      suggested_amount = parseFloat(suggested_amount.toFixed(2));
    }

    // INSS sobre pró-labore
    const inss = config.include_inss
      ? calcINSS(suggested_amount, config.inss_cap, config.inss_rate)
      : 0;
    const net_prolabore = parseFloat((suggested_amount - inss).toFixed(2));

    // Fator R com o pró-labore sugerido
    const fatorR_with_suggested = calcFatorR(prolabore12m + suggested_amount, revenue_12m);
    const fatorR_current        = calcFatorR(prolabore12m, revenue_12m);

    res.json({
      note: 'Estimativa Aura — consulte um contador para decisões fiscais oficiais',
      tax_regime:         comp[0].tax_regime,
      current_month: {
        revenue:          revenue_current_month,
        prolabore_12m_acum: prolabore12m,
        revenue_12m,
      },
      suggested: {
        gross_prolabore:  suggested_amount,
        inss:             inss,
        net_prolabore:    net_prolabore,
        mode:             config.mode,
      },
      fator_r: {
        current:          fatorR_current,
        with_suggested:   fatorR_with_suggested,
        target:           parseFloat(config.fator_r_target || 28),
        ...fatorRStatus(fatorR_with_suggested, parseFloat(config.fator_r_target || 28)),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /companies/:id/prolabore/register
// Registra pró-labore efetivamente tomado no mês
router.post('/register', guard, async (req, res) => {
  const { amount, reference_month, notes } = req.body;
  if (!amount || !reference_month)
    return res.status(400).json({ error: 'amount e reference_month (YYYY-MM) obrigatórios' });

  try {
    const { rows: cfg } = await db.query(
      `SELECT * FROM prolabore_config WHERE company_id=$1`, [req.params.id]
    );
    const config = cfg[0] || { include_inss: true, inss_rate: 0.11, inss_cap: 7786.02 };

    const inss       = config.include_inss ? calcINSS(amount, config.inss_cap, config.inss_rate) : 0;
    const net        = parseFloat((amount - inss).toFixed(2));

    const [revenueData, prolabore12m] = await Promise.all([
      _getRevenue12m(req.params.id),
      _getProlabore12m(req.params.id),
    ]);
    const fatorR = calcFatorR(prolabore12m + parseFloat(amount), revenueData.revenue_12m);

    // Monta data de referência como primeiro dia do mês
    const [y, m] = reference_month.split('-').map(Number);
    const refDate = `${y}-${String(m).padStart(2,'0')}-01`;

    const { rows } = await db.query(
      `INSERT INTO prolabore_history
         (company_id, reference_month, amount, inss_amount, net_amount,
          fator_r_result, gross_revenue, revenue_12m, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (company_id, reference_month)
       DO UPDATE SET amount=$3, inss_amount=$4, net_amount=$5,
           fator_r_result=$6, gross_revenue=$7, revenue_12m=$8, notes=$9
       RETURNING *`,
      [req.params.id, refDate, amount, inss, net, fatorR,
       revenueData.revenue_current_month, revenueData.revenue_12m,
       notes||null, req.user?.id||null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /companies/:id/prolabore/history?months=12
router.get('/history', guard, async (req, res) => {
  const { months = 12 } = req.query;
  try {
    const { rows } = await db.query(
      `SELECT * FROM prolabore_history
       WHERE company_id=$1
       ORDER BY reference_month DESC
       LIMIT $2`,
      [req.params.id, months]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /companies/:id/prolabore/distribution
// Distribuição de lucros: receita - despesas - impostos - reservas - pró-labore
// Retorna waterfall com valor disponível para distribuição
router.get('/distribution', guard, async (req, res) => {
  const { month } = req.query; // YYYY-MM, padrão = mês atual
  let dateFrom, dateTo;
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number);
    dateFrom = new Date(y, m - 1, 1);
    dateTo   = new Date(y, m, 0, 23, 59, 59);
  } else {
    const now = new Date();
    dateFrom = new Date(now.getFullYear(), now.getMonth(), 1);
    dateTo   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  }

  try {
    // Receitas e despesas do mês
    const { rows: flows } = await db.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE type='income'  AND status='confirmed'),0) AS gross_revenue,
         COALESCE(SUM(amount) FILTER (WHERE type='expense' AND status='confirmed'),0) AS total_expenses
       FROM transactions
       WHERE company_id=$1
         AND paid_at BETWEEN $2 AND $3`,
      [req.params.id, dateFrom, dateTo]
    );

    // Pró-labore registrado no mês
    const refStr = `${dateFrom.getFullYear()}-${String(dateFrom.getMonth()+1).padStart(2,'0')}-01`;
    const { rows: pl } = await db.query(
      `SELECT COALESCE(amount,0) AS amount, COALESCE(inss_amount,0) AS inss
       FROM prolabore_history WHERE company_id=$1 AND reference_month=$2`,
      [req.params.id, refStr]
    );
    const prolabore     = parseFloat(pl[0]?.amount || 0);
    const prolabore_inss= parseFloat(pl[0]?.inss   || 0);

    // Estima impostos do mês (usa DAS preview simples)
    const { rows: comp } = await db.query(
      `SELECT tax_regime, annual_revenue FROM companies WHERE id=$1`, [req.params.id]
    );
    const regime = comp[0]?.tax_regime || 'mei';
    const gross  = parseFloat(flows[0].gross_revenue);
    const expenses = parseFloat(flows[0].total_expenses);

    // Estimativa de imposto simplificada
    let estimated_tax = 0;
    if (regime === 'mei')                estimated_tax = regime === 'mei' ? 66 : 0; // DAS MEI fixo ~R$66
    if (regime === 'simples_nacional')   estimated_tax = parseFloat((gross * 0.06).toFixed(2)); // ~6% Anexo III
    if (regime === 'lucro_presumido')    estimated_tax = parseFloat((gross * 0.115).toFixed(2));

    // Reservas sugeridas (20% do lucro bruto antes de distribuição)
    const ebitda           = gross - expenses;
    const reserva_capital  = parseFloat((Math.max(0, ebitda) * 0.15).toFixed(2)); // 15% reserva capital giro
    const reserva_impostos = parseFloat((Math.max(0, estimated_tax)).toFixed(2));
    const reserva_emergencia = parseFloat((Math.max(0, ebitda) * 0.05).toFixed(2)); // 5% emergência

    const available = parseFloat(Math.max(0,
      ebitda - prolabore - prolabore_inss - reserva_capital - reserva_impostos - reserva_emergencia
    ).toFixed(2));

    res.json({
      note: 'Estimativa Aura — consulte um contador para distribuições oficiais',
      month: refStr.slice(0,7),
      waterfall: {
        gross_revenue:        gross,
        total_expenses:       expenses,
        ebitda:               parseFloat(ebitda.toFixed(2)),
        prolabore:            prolabore,
        prolabore_inss:       prolabore_inss,
        estimated_tax:        reserva_impostos,
        reserva_capital_giro: reserva_capital,
        reserva_emergencia:   reserva_emergencia,
        available_distribution: available,
      },
      tax_regime: regime,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
