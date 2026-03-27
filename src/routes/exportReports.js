// ============================================================
// AURA. — CORE-05: Exportação de Relatórios PDF + CSV
// Relatórios com identidade visual Aura, sem dependência externa
//
// Endpoints:
//   GET /companies/:id/export/dre?from=&to=&format=pdf|csv
//   GET /companies/:id/export/sales?from=&to=&format=pdf|csv
//   GET /companies/:id/export/payroll?period=YYYY-MM&format=pdf|csv
//   GET /companies/:id/export/prolabore?months=12&format=csv
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireAuth, requirePlan } = require('../middleware/auth');

const guard = [requireAuth];

// ── Helpers visuais ──────────────────────────────────────────────
const BRL = (v) => `R$\u00a0${parseFloat(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const DATE_BR = (d) => new Date(d).toLocaleDateString('pt-BR', { timeZone: 'UTC' });

function aurapdfHtml({ title, subtitle, company, periodLabel, tableHead, rows, totals = [], notes = '' }) {
  const rowsHtml = rows.map(r =>
    `<tr>${r.map((c, i) => `<td class="${i === 0 ? 'label' : 'num'}">${c}</td>`).join('')}</tr>`
  ).join('');
  const totalsHtml = totals.map(t =>
    `<tr class="total-row"><td class="label">${t[0]}</td>${t.slice(1).map(c => `<td class="num">${c}</td>`).join('')}</tr>`
  ).join('');
  const headHtml = tableHead.map(h => `<th>${h}</th>`).join('');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>${title} — Aura.</title>
<style>
  @page { margin: 18mm 16mm; size: A4; }
  @media print { button { display:none; } }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:'Helvetica Neue',Arial,sans-serif; font-size:11px; color:#1a1a2e; line-height:1.5; }
  header { display:flex; justify-content:space-between; align-items:flex-end; padding-bottom:10px; border-bottom:2.5px solid #6d28d9; margin-bottom:18px; }
  .brand { font-size:22px; font-weight:800; color:#6d28d9; letter-spacing:-1px; }
  .company-info { text-align:right; font-size:10px; color:#555; }
  .doc-title { margin-bottom:14px; }
  .doc-title h1 { font-size:16px; font-weight:700; color:#1a1a2e; }
  .doc-title p { font-size:10px; color:#666; margin-top:2px; }
  table { width:100%; border-collapse:collapse; margin-bottom:12px; }
  th { background:#6d28d9; color:#fff; font-size:10px; font-weight:600; padding:7px 10px; text-align:left; }
  th:not(:first-child) { text-align:right; }
  td { padding:6px 10px; border-bottom:0.5px solid #e5e7eb; font-size:10px; }
  td.num { text-align:right; font-family:'Courier New',monospace; font-size:10px; }
  td.label { color:#374151; }
  tr:nth-child(even) td { background:#f5f3ff; }
  tr.total-row td { font-weight:700; background:#ede9fe!important; border-top:1.5px solid #6d28d9; font-size:11px; }
  tr.negative td.num { color:#dc2626; }
  tr.positive td.num { color:#059669; }
  .notes { font-size:9px; color:#888; margin-top:10px; font-style:italic; }
  footer { margin-top:20px; padding-top:8px; border-top:0.5px solid #ddd; font-size:9px; color:#aaa; display:flex; justify-content:space-between; }
  .print-btn { display:block; margin:12px auto; padding:10px 28px; background:#6d28d9; color:#fff; border:none; border-radius:8px; font-size:13px; cursor:pointer; font-weight:600; }
</style>
</head>
<body>
<header>
  <div class="brand">aura.</div>
  <div class="company-info">
    <div><strong>${company.trade_name || company.legal_name}</strong></div>
    ${company.cnpj ? `<div>CNPJ: ${company.cnpj}</div>` : ''}
    <div>Emitido em: ${new Date().toLocaleDateString('pt-BR')}</div>
  </div>
</header>
<div class="doc-title">
  <h1>${title}</h1>
  <p>${subtitle || periodLabel}</p>
</div>
<button class="print-btn" onclick="window.print()">&#128424; Imprimir / Salvar PDF</button>
<table>
  <thead><tr>${headHtml}</tr></thead>
  <tbody>${rowsHtml}${totalsHtml}</tbody>
</table>
${notes ? `<p class="notes">${notes}</p>` : ''}
<footer>
  <span>Aura. — Relatório gerencial (estimativa)</span>
  <span>${periodLabel}</span>
</footer>
<script>window.addEventListener('load', function() { /* autoprint se ?print=true */ if (new URLSearchParams(location.search).get('print') === 'true') window.print(); });</script>
</body></html>`;
}

function toCSV(headers, rows) {
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  return [headers, ...rows].map(r => r.map(esc).join(';')).join('\n');
}

async function getCompany(companyId) {
  const { rows } = await db.query(
    `SELECT legal_name, trade_name, cnpj FROM companies WHERE id=$1`, [companyId]
  );
  return rows[0] || { legal_name: 'Empresa', trade_name: '', cnpj: '' };
}

// ── GET /export/dre ───────────────────────────────────────────────
router.get('/dre', guard, async (req, res) => {
  const { format = 'pdf' } = req.query;
  let { from, to } = req.query;

  if (!from || !to) {
    const now = new Date();
    from = `${now.getFullYear()}-01-01`;
    to   = `${now.getFullYear()}-12-31`;
  }

  const cid = req.params.id;
  const company = await getCompany(cid);

  const { rows: txns } = await db.query(
    `SELECT type, category, amount, description
     FROM transactions
     WHERE company_id=$1 AND status='confirmed'
       AND paid_at::date BETWEEN $2 AND $3
     ORDER BY type, category`,
    [cid, from, to]
  );

  // Agrupa por categoria
  const summary = {};
  for (const t of txns) {
    const key = `${t.type}:${t.category || 'outros'}`;
    if (!summary[key]) summary[key] = { type: t.type, category: t.category || 'outros', total: 0 };
    summary[key].total += parseFloat(t.amount);
  }

  const receitas = Object.values(summary).filter(r => r.type === 'income');
  const despesas = Object.values(summary).filter(r => r.type === 'expense');
  const totalRec = receitas.reduce((s, r) => s + r.total, 0);
  const totalDesp = despesas.reduce((s, r) => s + r.total, 0);
  const resultado = totalRec - totalDesp;
  const periodLabel = `${DATE_BR(from + 'T12:00:00Z')} a ${DATE_BR(to + 'T12:00:00Z')}`;

  if (format === 'csv') {
    const headers = ['Tipo', 'Categoria', 'Total'];
    const csvRows = [
      ...receitas.map(r => ['Receita', r.category, r.total.toFixed(2)]),
      ...despesas.map(r => ['Despesa', r.category, (-r.total).toFixed(2)]),
      ['', 'Resultado Líquido', resultado.toFixed(2)],
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="DRE_${from}_${to}.csv"`);
    return res.send('\uFEFF' + toCSV(headers, csvRows));
  }

  // PDF (HTML imprimível)
  const tableHead = ['Categoria', 'Valor (R$)'];
  const tableRows = [
    ...receitas.map(r => [r.category.replace(/_/g,' '), BRL(r.total)]),
    ...despesas.map(r => [r.category.replace(/_/g,' '), BRL(-r.total)]),
  ];
  const totals = [['Resultado Líquido', BRL(resultado)]];

  const html = aurapdfHtml({
    title: 'DRE Gerencial',
    subtitle: company.trade_name || company.legal_name,
    company, periodLabel,
    tableHead, rows: tableRows, totals,
    notes: 'Relatório gerencial estimado pela Aura com base nos lançamentos confirmados. Não é documento contábil oficial.',
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ── GET /export/sales ───────────────────────────────────────────────
router.get('/sales', guard, async (req, res) => {
  const { format = 'pdf' } = req.query;
  let { from, to } = req.query;
  const cid = req.params.id;
  const company = await getCompany(cid);

  if (!from || !to) {
    const now = new Date();
    from = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const last = new Date(now.getFullYear(), now.getMonth()+1, 0);
    to = `${last.getFullYear()}-${String(last.getMonth()+1).padStart(2,'0')}-${String(last.getDate()).padStart(2,'0')}`;
  }

  const { rows: sales } = await db.query(
    `SELECT s.id, s.created_at, s.total_amount, s.discount_amount, s.payment_method,
            c.name AS customer_name, u.full_name AS seller_name,
            COUNT(si.id) AS item_count
     FROM sales s
     LEFT JOIN customers c ON c.id=s.customer_id
     LEFT JOIN users u ON u.id=s.seller_id
     LEFT JOIN sale_items si ON si.sale_id=s.id
     WHERE s.company_id=$1 AND s.created_at::date BETWEEN $2 AND $3
     GROUP BY s.id, c.name, u.full_name
     ORDER BY s.created_at DESC`,
    [cid, from, to]
  );

  const totalVendas = sales.reduce((s, r) => s + parseFloat(r.total_amount), 0);
  const totalDesc  = sales.reduce((s, r) => s + parseFloat(r.discount_amount || 0), 0);
  const periodLabel = `${DATE_BR(from + 'T12:00:00Z')} a ${DATE_BR(to + 'T12:00:00Z')}`;

  const headers = ['Data', 'Cliente', 'Atendente', 'Itens', 'Desconto', 'Total', 'Pagamento'];
  const csvRows = sales.map(s => [
    new Date(s.created_at).toLocaleDateString('pt-BR'),
    s.customer_name || '—',
    s.seller_name   || '—',
    s.item_count,
    parseFloat(s.discount_amount||0).toFixed(2),
    parseFloat(s.total_amount).toFixed(2),
    s.payment_method || '—',
  ]);

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Vendas_${from}_${to}.csv"`);
    return res.send('\uFEFF' + toCSV(headers, csvRows));
  }

  const tableHead = headers;
  const tableRows = sales.map(s => [
    new Date(s.created_at).toLocaleDateString('pt-BR'),
    s.customer_name || '—',
    s.seller_name   || '—',
    s.item_count,
    BRL(s.discount_amount || 0),
    BRL(s.total_amount),
    s.payment_method || '—',
  ]);
  const totals = [['Total do período', '', '', sales.length + ' vendas', BRL(totalDesc), BRL(totalVendas), '']];

  const html = aurapdfHtml({
    title: 'Relatório de Vendas',
    subtitle: company.trade_name || company.legal_name,
    company, periodLabel, tableHead,
    rows: tableRows, totals,
    notes: '',
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ── GET /export/payroll ──────────────────────────────────────────────
router.get('/payroll', guard, async (req, res) => {
  const { format = 'pdf', period } = req.query;
  const cid = req.params.id;
  const company = await getCompany(cid);

  const per = period || (() => {
    const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`;
  })();

  const { rows } = await db.query(
    `SELECT
       e.name AS employee_name, e.role,
       pr.gross_salary, pr.inss_employee, pr.irrf, pr.fgts, pr.net_salary,
       pr.other_deductions, pr.other_additions
     FROM payroll_records pr
     JOIN employees e ON e.id=pr.employee_id
     WHERE pr.company_id=$1 AND pr.period=$2
     ORDER BY e.name`,
    [cid, per]
  );

  const totGross = rows.reduce((s, r) => s + parseFloat(r.gross_salary || 0), 0);
  const totNet   = rows.reduce((s, r) => s + parseFloat(r.net_salary   || 0), 0);
  const totFgts  = rows.reduce((s, r) => s + parseFloat(r.fgts         || 0), 0);
  const [year, month] = per.split('-');
  const monthNames = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const periodLabel = `${monthNames[parseInt(month)-1]} de ${year}`;

  const headers = ['Funcionário', 'Cargo', 'Salário Bruto', 'INSS', 'IRRF', 'FGTS', 'Salário Líquido'];
  const csvRows = rows.map(r => [
    r.employee_name, r.role || '—',
    parseFloat(r.gross_salary||0).toFixed(2), parseFloat(r.inss_employee||0).toFixed(2),
    parseFloat(r.irrf||0).toFixed(2), parseFloat(r.fgts||0).toFixed(2),
    parseFloat(r.net_salary||0).toFixed(2),
  ]);

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Folha_${per}.csv"`);
    return res.send('\uFEFF' + toCSV(headers, csvRows));
  }

  const tableRows = rows.map(r => [
    r.employee_name, r.role || '—',
    BRL(r.gross_salary), BRL(r.inss_employee),
    BRL(r.irrf), BRL(r.fgts), BRL(r.net_salary),
  ]);
  const totals = [['TOTAIS', '', BRL(totGross), '', '', BRL(totFgts), BRL(totNet)]];

  const html = aurapdfHtml({
    title: 'Folha de Pagamento',
    subtitle: company.trade_name || company.legal_name,
    company, periodLabel, tableHead: headers,
    rows: tableRows, totals,
    notes: 'Relatório gerado pela Aura. Confira com seu contador antes de transmitir.',
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ── GET /export/prolabore ──────────────────────────────────────────────
router.get('/prolabore', guard, requirePlan('negocio', 'expansao'), async (req, res) => {
  const { format = 'csv', months = 12 } = req.query;
  const cid = req.params.id;
  const company = await getCompany(cid);

  const { rows } = await db.query(
    `SELECT reference_month, amount, inss_amount, net_amount, fator_r_result, gross_revenue
     FROM prolabore_history WHERE company_id=$1
     ORDER BY reference_month DESC LIMIT $2`,
    [cid, months]
  );

  const headers = ['Mês/Ano', 'Pró-labore Bruto', 'INSS', 'Pró-labore Líquido', 'Fator R (%)', 'Receita Bruta do Mês'];
  const csvRows = rows.map(r => [
    new Date(r.reference_month).toLocaleDateString('pt-BR', { month:'long', year:'numeric', timeZone:'UTC' }),
    parseFloat(r.amount||0).toFixed(2),
    parseFloat(r.inss_amount||0).toFixed(2),
    parseFloat(r.net_amount||0).toFixed(2),
    r.fator_r_result ? parseFloat(r.fator_r_result).toFixed(1) + '%' : '—',
    parseFloat(r.gross_revenue||0).toFixed(2),
  ]);

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="Prolabore.csv"');
    return res.send('\uFEFF' + toCSV(headers, csvRows));
  }

  const periodLabel = `Últimos ${months} meses`;
  const tableRows = csvRows;
  const html = aurapdfHtml({
    title: 'Histórico de Pró-labore',
    subtitle: company.trade_name || company.legal_name,
    company, periodLabel, tableHead: headers,
    rows: tableRows, totals: [],
    notes: 'Valores registrados na Aura. Fator R = pró-labore acumulado 12m ÷ receita 12m.',
  });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

module.exports = router;
