// ============================================================
// AURA. — FIN-02: DRE Gerencial + Fluxo de Caixa Projetado
//
// DRE: Demonstração do Resultado do Exercício (gerencial)
// Fluxo projetado: média móvel dos últimos N meses + ajustes
//
// LINGUAGEM: "gerencial"/"estimativa" — não é documento contabil oficial
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireAuth, requirePlan } = require('../middleware/auth');

const guard = [requireAuth, requirePlan(['negocio','expansao'])];

// ── Mapeamento padrão categoria → linha DRE ───────────────────
// O usuário pode personalizar via dre_category_map
const DEFAULT_LINE_MAP = {
  // Receitas
  'venda':            { line: 'receita_bruta',    group: 'Receita Bruta', sign: 1 },
  'servico':          { line: 'receita_bruta',    group: 'Receita Bruta', sign: 1 },
  'servico_pj':       { line: 'receita_bruta',    group: 'Receita Bruta', sign: 1 },
  'receita_diversa':  { line: 'outras_receitas',  group: 'Outras Receitas', sign: 1 },
  // Deduções
  'imposto':          { line: 'deducoes',         group: 'Deduções', sign: -1 },
  'das':              { line: 'deducoes',         group: 'Deduções', sign: -1 },
  // CMV
  'compra_produto':   { line: 'cmv',              group: 'CMV', sign: -1 },
  'estoque':          { line: 'cmv',              group: 'CMV', sign: -1 },
  'mercadoria':       { line: 'cmv',              group: 'CMV', sign: -1 },
  // Despesas operacionais
  'folha':            { line: 'despesa_pessoal',  group: 'Despesas Pessoal', sign: -1 },
  'salario':          { line: 'despesa_pessoal',  group: 'Despesas Pessoal', sign: -1 },
  'prolabore':        { line: 'despesa_pessoal',  group: 'Despesas Pessoal', sign: -1 },
  'inss':             { line: 'despesa_pessoal',  group: 'Despesas Pessoal', sign: -1 },
  'fgts':             { line: 'despesa_pessoal',  group: 'Despesas Pessoal', sign: -1 },
  'aluguel':          { line: 'despesa_fixa',     group: 'Despesas Fixas', sign: -1 },
  'energia':          { line: 'despesa_fixa',     group: 'Despesas Fixas', sign: -1 },
  'internet':         { line: 'despesa_fixa',     group: 'Despesas Fixas', sign: -1 },
  'telefone':         { line: 'despesa_fixa',     group: 'Despesas Fixas', sign: -1 },
  'seguro':           { line: 'despesa_fixa',     group: 'Despesas Fixas', sign: -1 },
  'assinatura':       { line: 'despesa_fixa',     group: 'Despesas Fixas', sign: -1 },
  'marketing':        { line: 'despesa_variavel', group: 'Despesas Variáveis', sign: -1 },
  'comissao':         { line: 'despesa_variavel', group: 'Despesas Variáveis', sign: -1 },
  'frete':            { line: 'despesa_variavel', group: 'Despesas Variáveis', sign: -1 },
  'manutencao':       { line: 'despesa_variavel', group: 'Despesas Variáveis', sign: -1 },
  'fornecedor':       { line: 'despesa_variavel', group: 'Despesas Variáveis', sign: -1 },
  // Financeiras
  'juros':            { line: 'despesa_financeira',group:'Despesas Financeiras', sign: -1 },
  'emprestimo':       { line: 'despesa_financeira',group:'Despesas Financeiras', sign: -1 },
  'tarifa':           { line: 'despesa_financeira',group:'Despesas Financeiras', sign: -1 },
};

function _mapCategory(category, customMap) {
  const key = (category || 'outros').toLowerCase().trim();
  if (customMap[key]) return customMap[key];
  if (DEFAULT_LINE_MAP[key]) return DEFAULT_LINE_MAP[key];
  return { line: 'outros', group: 'Outros', sign: -1 }; // despesa por padrão
}

// ── GET /companies/:id/dre?from=YYYY-MM-01&to=YYYY-MM-31 ────────
// DRE gerencial do período
router.get('/', guard, async (req, res) => {
  const cid = req.params.id;
  let { from, to, period } = req.query;

  // Se period=month, from/to do mês atual
  if (!from || !to) {
    const now  = new Date();
    const y    = now.getFullYear();
    const m    = now.getMonth();
    if (period === 'year') {
      from = `${y}-01-01`;
      to   = `${y}-12-31`;
    } else {
      from = `${y}-${String(m+1).padStart(2,'0')}-01`;
      const lastDay = new Date(y, m+1, 0).getDate();
      to   = `${y}-${String(m+1).padStart(2,'0')}-${lastDay}`;
    }
  }

  try {
    // Carrega mapeamento personalizado
    const { rows: mapRows } = await db.query(
      `SELECT category, dre_line AS line, dre_group AS group FROM dre_category_map
       WHERE company_id=$1 AND is_active=TRUE`, [cid]
    );
    const customMap = {};
    mapRows.forEach(r => { customMap[r.category.toLowerCase()] = { line: r.line, group: r.group, sign: r.line.startsWith('receita') ? 1 : -1 }; });

    // Busca lançamentos pagos no período
    const { rows: txns } = await db.query(
      `SELECT type, category, amount, description
       FROM transactions
       WHERE company_id=$1
         AND status='confirmed'
         AND paid_at::date BETWEEN $2 AND $3
       ORDER BY type, category`,
      [cid, from, to]
    );

    // Agrupa por linha DRE
    const lineMap = {};
    for (const t of txns) {
      const sign   = t.type === 'income' ? 1 : -1;
      const mapped = _mapCategory(t.category, customMap);
      const key    = mapped.line;
      if (!lineMap[key]) lineMap[key] = { line: key, group: mapped.group, total: 0, items: [] };
      lineMap[key].total += parseFloat(t.amount) * sign;
      lineMap[key].items.push({ desc: t.description, amount: parseFloat(t.amount) * sign });
    }

    // Calcula linhas do DRE
    const get = (k) => parseFloat((lineMap[k]?.total || 0).toFixed(2));

    const receita_bruta        = get('receita_bruta') + get('outras_receitas');
    const deducoes             = Math.abs(get('deducoes'));
    const receita_liquida      = parseFloat((receita_bruta - deducoes).toFixed(2));
    const cmv                  = Math.abs(get('cmv'));
    const lucro_bruto          = parseFloat((receita_liquida - cmv).toFixed(2));
    const despesa_pessoal      = Math.abs(get('despesa_pessoal'));
    const despesa_fixa         = Math.abs(get('despesa_fixa'));
    const despesa_variavel     = Math.abs(get('despesa_variavel'));
    const despesa_financeira   = Math.abs(get('despesa_financeira'));
    const outros               = get('outros');
    const total_despesas_op    = despesa_pessoal + despesa_fixa + despesa_variavel + outros;
    const ebitda               = parseFloat((lucro_bruto - total_despesas_op).toFixed(2));
    const lucro_antes_financ   = parseFloat((ebitda - despesa_financeira).toFixed(2));
    const impostos             = deducoes; // impostos já capturados em deduções
    const lucro_liquido        = parseFloat((lucro_antes_financ).toFixed(2));
    const margem_liquida       = receita_bruta > 0
      ? parseFloat((lucro_liquido / receita_bruta * 100).toFixed(1)) : 0;

    res.json({
      note:            'DRE Gerencial — estimativa Aura com base nos lançamentos cadastrados',
      period:          { from, to },
      summary: {
        receita_bruta,
        deducoes:          -deducoes,
        receita_liquida,
        cmv:               -cmv,
        lucro_bruto,
        despesa_pessoal:   -despesa_pessoal,
        despesa_fixa:      -despesa_fixa,
        despesa_variavel:  -despesa_variavel,
        outros,
        ebitda,
        despesa_financeira:-despesa_financeira,
        lucro_liquido,
        margem_liquida_pct:margem_liquida,
      },
      detail: Object.values(lineMap).map(l => ({
        group: l.group,
        line:  l.line,
        total: parseFloat(l.total.toFixed(2)),
      })).sort((a,b) => a.group.localeCompare(b.group)),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /companies/:id/dre/monthly?months=12 ──────────────────
// DRE mensal consolidado (evoluição ao longo do tempo)
router.get('/monthly', guard, async (req, res) => {
  const { months = 12 } = req.query;
  try {
    const { rows } = await db.query(
      `SELECT
         to_char(date_trunc('month', paid_at),'YYYY-MM') AS month,
         COALESCE(SUM(amount) FILTER (WHERE type='income'),0)  AS receita,
         COALESCE(SUM(amount) FILTER (WHERE type='expense'),0) AS despesa
       FROM transactions
       WHERE company_id=$1
         AND status='confirmed'
         AND paid_at >= date_trunc('month', NOW()) - (($2-1) || ' months')::INTERVAL
       GROUP BY month
       ORDER BY month DESC`,
      [req.params.id, months]
    );
    res.json(rows.map(r => ({
      month:         r.month,
      receita:       parseFloat(r.receita),
      despesa:       parseFloat(r.despesa),
      lucro:         parseFloat((r.receita - r.despesa).toFixed(2)),
      margem_pct:    r.receita > 0 ? parseFloat(((r.receita - r.despesa)/r.receita*100).toFixed(1)) : 0,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /companies/:id/dre/cashflow?months_ahead=3 ────────────
// Fluxo de caixa projetado: média móvel dos últimos 3 meses
// + a receber em aberto + despesas pendentes
router.get('/cashflow', guard, async (req, res) => {
  const cid = req.params.id;
  const months_ahead = Math.min(parseInt(req.query.months_ahead || 3), 12);

  try {
    // ── 1. Média histórica dos últimos 3 meses (base da projeção) ──
    const { rows: hist } = await db.query(
      `SELECT
         COALESCE(AVG(monthly_income),0)   AS avg_income,
         COALESCE(AVG(monthly_expense),0)  AS avg_expense
       FROM (
         SELECT
           date_trunc('month', paid_at) AS month,
           SUM(amount) FILTER (WHERE type='income')  AS monthly_income,
           SUM(amount) FILTER (WHERE type='expense') AS monthly_expense
         FROM transactions
         WHERE company_id=$1 AND status='confirmed'
           AND paid_at >= NOW() - INTERVAL '3 months'
           AND paid_at < date_trunc('month', NOW())
         GROUP BY month
       ) sub`,
      [cid]
    );
    const avg_income  = parseFloat(hist[0]?.avg_income  || 0);
    const avg_expense = parseFloat(hist[0]?.avg_expense || 0);

    // ── 2. A receber em aberto (por mês de vencimento) ──────────
    const { rows: receivables } = await db.query(
      `SELECT
         to_char(date_trunc('month', due_date),'YYYY-MM') AS month,
         SUM(amount) AS total
       FROM transactions
       WHERE company_id=$1
         AND type='income'
         AND status='pending'
         AND due_date BETWEEN NOW() AND NOW() + ($2 || ' months')::INTERVAL
       GROUP BY month
       ORDER BY month`,
      [cid, months_ahead]
    );
    const receivablesByMonth = {};
    receivables.forEach(r => { receivablesByMonth[r.month] = parseFloat(r.total); });

    // ── 3. Despesas pendentes (por mês de vencimento) ──────────
    const { rows: payables } = await db.query(
      `SELECT
         to_char(date_trunc('month', due_date),'YYYY-MM') AS month,
         SUM(amount) AS total
       FROM transactions
       WHERE company_id=$1
         AND type='expense'
         AND status='pending'
         AND due_date BETWEEN NOW() AND NOW() + ($2 || ' months')::INTERVAL
       GROUP BY month
       ORDER BY month`,
      [cid, months_ahead]
    );
    const payablesByMonth = {};
    payables.forEach(p => { payablesByMonth[p.month] = parseFloat(p.total); });

    // ── 4. Saldo atual (caixa real) ────────────────────────────
    const { rows: balance } = await db.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE type='income'),0)  -
         COALESCE(SUM(amount) FILTER (WHERE type='expense'),0) AS current_balance
       FROM transactions
       WHERE company_id=$1 AND status='confirmed'`,
      [cid]
    );
    let running_balance = parseFloat(balance[0]?.current_balance || 0);

    // ── 5. Monta projeção mês a mês ──────────────────────────
    const projection = [];
    const now = new Date();

    for (let i = 0; i < months_ahead; i++) {
      const d     = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
      const mKey  = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;

      // Receita projetada = média histórica + a receber confirmado
      const proj_income  = avg_income + (receivablesByMonth[mKey] || 0);
      // Despesa projetada = média histórica + despesas confirmadas
      const proj_expense = avg_expense + (payablesByMonth[mKey] || 0);
      const proj_net     = parseFloat((proj_income - proj_expense).toFixed(2));
      running_balance    = parseFloat((running_balance + proj_net).toFixed(2));

      projection.push({
        month:                mKey,
        projected_income:     parseFloat(proj_income.toFixed(2)),
        projected_expense:    parseFloat(proj_expense.toFixed(2)),
        projected_net:        proj_net,
        running_balance:      running_balance,
        receivables_confirmed:parseFloat((receivablesByMonth[mKey]||0).toFixed(2)),
        payables_confirmed:   parseFloat((payablesByMonth[mKey]||0).toFixed(2)),
        is_negative:          running_balance < 0,
      });
    }

    res.json({
      note:             'Projeção estimada pela Aura com base no histórico dos últimos 3 meses + lançamentos pendentes',
      current_balance:  parseFloat(balance[0]?.current_balance || 0),
      basis: {
        avg_monthly_income:  parseFloat(avg_income.toFixed(2)),
        avg_monthly_expense: parseFloat(avg_expense.toFixed(2)),
        avg_monthly_net:     parseFloat((avg_income - avg_expense).toFixed(2)),
      },
      months_ahead,
      projection,
      alert: projection.some(p => p.is_negative)
        ? 'Atenção: projeção indica saldo negativo em um ou mais meses.'
        : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /companies/:id/dre/category-map ──────────────────────
// Mapeia uma categoria personalizada para uma linha do DRE
router.post('/category-map', guard, async (req, res) => {
  const { category, dre_line, dre_group } = req.body;
  if (!category || !dre_line || !dre_group)
    return res.status(400).json({ error: 'category, dre_line e dre_group obrigatórios' });
  try {
    const { rows } = await db.query(
      `INSERT INTO dre_category_map (company_id, category, dre_line, dre_group)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (company_id, category)
       DO UPDATE SET dre_line=$3, dre_group=$4, is_active=TRUE
       RETURNING *`,
      [req.params.id, category.toLowerCase(), dre_line, dre_group]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /companies/:id/dre/category-map
router.get('/category-map', guard, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM dre_category_map WHERE company_id=$1 AND is_active=TRUE ORDER BY dre_group, category`,
      [req.params.id]
    );
    // Retorna também os defaults para referência
    res.json({ custom: rows, defaults: DEFAULT_LINE_MAP });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
