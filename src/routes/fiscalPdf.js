// ============================================================
// AURA. — Fase 1+2 Contabilidade: PDFs de apoio fiscal
//
// Fase 1:
//   GET /obligations/das-mei/pdf
//   GET /obligations/das-sn/pdf?month=
//   GET /obligations/dasn/report?year=
//   GET /obligations/das/auto-preview
// Fase 2:
//   GET /obligations/gps/pdf?month=
//   GET /obligations/defis/report?year=
//   GET /obligations/esocial/summary?month=
//   GET /obligations/fgts/pdf?month=
//
// LINGUAGEM: sempre "estimativa", nunca "declaracao oficial"
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth, requirePlan } = require('../middleware/auth');
const { calculateMEIDAS, calculateSNDAS, checkMEILimit, calculateFGTS, calculateGPS } = require('../services/fiscalObligations');

const BRL = (v) => `R$\u00a0${parseFloat(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const DATE_BR = (d) => new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const MONTH_NAMES = ['Janeiro','Fevereiro','Marco','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

async function getCompany(id) {
  const { rows } = await db.query('SELECT legal_name, trade_name, cnpj, tax_regime, annual_revenue FROM companies WHERE id=$1', [id]);
  return rows[0] || { legal_name: 'Empresa', trade_name: '', cnpj: '', tax_regime: 'mei' };
}

function fiscalPdfHtml({ title, subtitle, company, sections, notes }) {
  const today = DATE_BR(new Date());
  const cnpjFmt = (company.cnpj || '').replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  const sectionsHtml = sections.map(s => {
    if (s.type === 'table') {
      const headHtml = s.headers.map(h => `<th>${h}</th>`).join('');
      const rowsHtml = s.rows.map(r => `<tr>${r.map((c, i) => `<td class="${i === 0 ? 'label' : 'num'}">${c}</td>`).join('')}</tr>`).join('');
      const totHtml = (s.totals || []).map(t => `<tr class="total-row"><td class="label">${t[0]}</td>${t.slice(1).map(c => `<td class="num">${c}</td>`).join('')}</tr>`).join('');
      return `${s.title ? `<h2 class="sec-title">${s.title}</h2>` : ''}<table><thead><tr>${headHtml}</tr></thead><tbody>${rowsHtml}${totHtml}</tbody></table>`;
    }
    if (s.type === 'info') {
      return `<div class="info-block">${s.title ? `<h2 class="sec-title">${s.title}</h2>` : ''}${s.items.map(i => `<div class="info-row"><span class="info-label">${i.label}</span><span class="info-value">${i.value}</span></div>`).join('')}</div>`;
    }
    if (s.type === 'alert') { return `<div class="alert-block ${s.level}">${s.text}</div>`; }
    return '';
  }).join('');

  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>${title} - Aura.</title>
<style>
@page{margin:18mm 16mm;size:A4}@media print{button{display:none}}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;color:#1a1a2e;line-height:1.5}
header{display:flex;justify-content:space-between;align-items:flex-end;padding-bottom:10px;border-bottom:2.5px solid #6d28d9;margin-bottom:18px}
.brand{font-size:22px;font-weight:800;color:#6d28d9;letter-spacing:-1px}
.company-info{text-align:right;font-size:10px;color:#555}
.doc-title{margin-bottom:14px}
.doc-title h1{font-size:16px;font-weight:700;color:#1a1a2e}
.doc-title p{font-size:10px;color:#666;margin-top:2px}
.sec-title{font-size:13px;font-weight:700;color:#374151;margin:16px 0 8px;padding-bottom:4px;border-bottom:1px solid #e5e7eb}
table{width:100%;border-collapse:collapse;margin-bottom:12px}
th{background:#6d28d9;color:#fff;font-size:10px;font-weight:600;padding:7px 10px;text-align:left}
th:not(:first-child){text-align:right}
td{padding:6px 10px;border-bottom:0.5px solid #e5e7eb;font-size:10px}
td.num{text-align:right;font-family:'Courier New',monospace}
td.label{color:#374151}
tr:nth-child(even) td{background:#f5f3ff}
tr.total-row td{font-weight:700;background:#ede9fe!important;border-top:1.5px solid #6d28d9;font-size:11px}
.info-block{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin-bottom:14px}
.info-row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:0.5px solid #f3f4f6}
.info-label{font-size:10px;color:#6b7280}
.info-value{font-size:11px;font-weight:600;color:#1a1a2e;font-family:'Courier New',monospace}
.alert-block{padding:12px 16px;border-radius:8px;font-size:10px;margin-bottom:14px;font-weight:500}
.alert-block.info{background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe}
.alert-block.warning{background:#fefce8;color:#a16207;border:1px solid #fde68a}
.alert-block.critical{background:#fef2f2;color:#dc2626;border:1px solid #fecaca}
.alert-block.ok{background:#f0fdf4;color:#059669;border:1px solid #bbf7d0}
.notes{font-size:9px;color:#888;margin-top:10px;font-style:italic}
footer{margin-top:20px;padding-top:8px;border-top:0.5px solid #ddd;font-size:9px;color:#aaa;display:flex;justify-content:space-between}
.print-btn{display:block;margin:12px auto;padding:10px 28px;background:#6d28d9;color:#fff;border:none;border-radius:8px;font-size:13px;cursor:pointer;font-weight:600}
</style></head><body>
<header><div class="brand">Aura.</div><div class="company-info">
<div><strong>${company.trade_name || company.legal_name}</strong></div>
${cnpjFmt ? `<div>CNPJ: ${cnpjFmt}</div>` : ''}
<div>Emitido em: ${today}</div>
</div></header>
<div class="doc-title"><h1>${title}</h1><p>${subtitle}</p></div>
<button class="print-btn" onclick="window.print()">&#128424; Imprimir / Salvar PDF</button>
${sectionsHtml}
${notes ? `<p class="notes">${notes}</p>` : ''}
<footer><span>Aura. — Documento de apoio contabil (estimativa)</span><span>${today}</span></footer>
</body></html>`;
}

// ── FASE 1 ──────────────────────────────────────────────────

// C1-01: PDF DAS-MEI
router.get('/das-mei/pdf', requireAuth, async (req, res) => {
  try {
    const company = await getCompany(req.params.id);
    if (company.tax_regime !== 'mei') return res.status(400).json({ error: 'Disponivel apenas para MEI' });
    const activity = req.query.activity || 'services';
    const das = calculateMEIDAS(activity);
    const now = new Date(); const refMonth = MONTH_NAMES[now.getMonth()];
    const dueDate = new Date(now.getFullYear(), now.getMonth(), 20); const duePast = dueDate < now;
    const actLabel = activity === 'commerce' ? 'Comercio' : activity === 'both' ? 'Comercio e Servicos' : 'Servicos';
    const { rows: revRows } = await db.query(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE company_id=$1 AND type='income' AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date >= date_trunc('year', NOW() AT TIME ZONE 'America/Sao_Paulo')::date`, [req.params.id]);
    const annualRev = parseFloat(revRows[0]?.total || 0); const limit = checkMEILimit(annualRev);
    const html = fiscalPdfHtml({ title: 'Resumo DAS-MEI', subtitle: `Competencia: ${refMonth} ${now.getFullYear()} | Vencimento: ${DATE_BR(dueDate)}`, company, sections: [
      { type: 'info', title: 'Dados do DAS', items: [{ label: 'Competencia', value: `${refMonth}/${now.getFullYear()}` },{ label: 'Atividade', value: actLabel },{ label: 'Vencimento', value: DATE_BR(dueDate) },{ label: 'Situacao', value: duePast ? 'VENCIDO' : 'A vencer' }]},
      { type: 'table', title: 'Composicao do valor', headers: ['Tributo', 'Valor (R$)'], rows: [['INSS', BRL(das.inss)],['ICMS', BRL(das.icms)],['ISS', BRL(das.iss)]], totals: [['DAS-MEI Total', BRL(das.total)]] },
      duePast ? { type: 'alert', level: 'critical', text: `ATENCAO: DAS vencido em ${DATE_BR(dueDate)}.` } : { type: 'alert', level: 'ok', text: `DAS dentro do prazo. Vence em ${DATE_BR(dueDate)}.` },
      { type: 'info', title: 'Monitor faturamento anual', items: [{ label: 'Acumulado', value: BRL(annualRev) },{ label: 'Limite MEI', value: BRL(81000) },{ label: 'Utilizado', value: limit.used_pct.toFixed(1)+'%' },{ label: 'Disponivel', value: BRL(limit.remaining) }]},
      limit.alert_level ? { type: 'alert', level: limit.alert_level === 'critical' ? 'critical' : 'warning', text: limit.alert_message } : null,
    ].filter(Boolean), notes: 'Estimativa com base na tabela DAS-MEI vigente. Confirme no portal PGMEI.' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(html);
  } catch (err) { console.error('[fiscal-pdf] das-mei:', err.message); res.status(500).json({ error: 'Erro ao gerar PDF' }); }
});

// C1-02: PDF DAS Simples Nacional
router.get('/das-sn/pdf', requireAuth, async (req, res) => {
  try {
    const company = await getCompany(req.params.id);
    if (company.tax_regime !== 'simples_nacional') return res.status(400).json({ error: 'Disponivel apenas para Simples Nacional' });
    const now = new Date(); const month = req.query.month || `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    const [y, m] = month.split('-').map(Number); const monthName = MONTH_NAMES[m-1]; const dueDate = new Date(y, m-1, 20);
    const { rows: curR } = await db.query(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE company_id=$1 AND type='income' AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date >= $2::date AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date < $3::date`, [req.params.id, `${y}-${String(m).padStart(2,'0')}-01`, m===12?`${y+1}-01-01`:`${y}-${String(m+1).padStart(2,'0')}-01`]);
    const { rows: r12 } = await db.query(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE company_id=$1 AND type='income' AND created_at >= NOW() - INTERVAL '12 months'`, [req.params.id]);
    const currentRev = parseFloat(curR[0]?.total||0); const rev12m = parseFloat(r12[0]?.total||0);
    let fatorR = null;
    try { const { rows: pl } = await db.query(`SELECT COALESCE(SUM(amount),0) AS total FROM prolabore_history WHERE company_id=$1 AND reference_month >= NOW() - INTERVAL '11 months'`, [req.params.id]); if (rev12m > 0) fatorR = parseFloat(((parseFloat(pl[0]?.total||0)/rev12m)*100).toFixed(1)); } catch {}
    const das = calculateSNDAS(rev12m, currentRev, fatorR);
    const sections = [
      { type: 'info', title: 'Dados da apuracao', items: [{ label: 'Competencia', value: `${monthName}/${y}` },{ label: 'Receita do mes', value: BRL(currentRev) },{ label: 'RBT12', value: BRL(rev12m) },{ label: 'Vencimento', value: DATE_BR(dueDate) }]},
      { type: 'table', title: 'Calculo DAS (Anexo '+das.anexo+')', headers: ['Item','Valor'], rows: [['Receita bruta do mes',BRL(currentRev)],['RBT12',BRL(rev12m)],['Aliquota nominal',das.nominal_rate_pct+'%'],['Aliquota efetiva',das.effective_rate_pct+'%']], totals: [['DAS estimado',BRL(das.estimated_das)]] },
    ];
    if (fatorR !== null) sections.push({ type: 'info', title: 'Fator R', items: [{ label: 'Fator R', value: fatorR+'%' },{ label: 'Anexo', value: das.anexo },{ label: 'Status', value: fatorR>=28?'OK - Anexo III':'Atencao - Anexo V' }]});
    const html = fiscalPdfHtml({ title: 'Demonstrativo DAS - Simples Nacional', subtitle: `Competencia: ${monthName}/${y}`, company, sections, notes: das.disclaimer });
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(html);
  } catch (err) { console.error('[fiscal-pdf] das-sn:', err.message); res.status(500).json({ error: 'Erro ao gerar PDF' }); }
});

// C1-03: PDF Relatorio Anual DASN-SIMEI
router.get('/dasn/report', requireAuth, async (req, res) => {
  try {
    const company = await getCompany(req.params.id);
    const year = parseInt(req.query.year) || (new Date().getFullYear()-1);
    const { rows: monthly } = await db.query(`SELECT TO_CHAR(date_trunc('month', created_at AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM') AS month, COALESCE(SUM(amount) FILTER(WHERE category IN ('Vendas','Revenda','Comercio','Produto','Mercadoria')), 0) AS comercio, COALESCE(SUM(amount) FILTER(WHERE category NOT IN ('Vendas','Revenda','Comercio','Produto','Mercadoria')), 0) AS servicos, COALESCE(SUM(amount), 0) AS total FROM transactions WHERE company_id=$1 AND type='income' AND EXTRACT(YEAR FROM created_at AT TIME ZONE 'America/Sao_Paulo') = $2 GROUP BY month ORDER BY month`, [req.params.id, year]);
    const totalC = monthly.reduce((s,r) => s+parseFloat(r.comercio), 0);
    const totalS = monthly.reduce((s,r) => s+parseFloat(r.servicos), 0);
    const totalG = monthly.reduce((s,r) => s+parseFloat(r.total), 0);
    const limit = checkMEILimit(totalG);
    const allMonths = []; for (let i=0;i<12;i++) { const k=`${year}-${String(i+1).padStart(2,'0')}`; const f=monthly.find(m=>m.month===k); allMonths.push({ label:MONTH_NAMES[i], comercio:f?parseFloat(f.comercio):0, servicos:f?parseFloat(f.servicos):0, total:f?parseFloat(f.total):0 }); }
    const html = fiscalPdfHtml({ title: 'Relatorio Anual DASN-SIMEI', subtitle: `Ano ${year} | Entrega ate 31/05/${year+1}`, company, sections: [
      { type: 'info', title: 'Informacoes', items: [{ label: 'Ano', value: String(year) },{ label: 'Regime', value: 'MEI (SIMEI)' },{ label: 'Prazo', value: '31/05/'+(year+1) }]},
      { type: 'table', title: 'Faturamento mensal', headers: ['Mes','Comercio (R$)','Servicos (R$)','Total (R$)'], rows: allMonths.map(m=>[m.label,BRL(m.comercio),BRL(m.servicos),BRL(m.total)]), totals: [['TOTAL',BRL(totalC),BRL(totalS),BRL(totalG)]] },
      { type: 'info', title: 'Resumo', items: [{ label: 'Comercio', value: BRL(totalC) },{ label: 'Servicos', value: BRL(totalS) },{ label: 'Total', value: BRL(totalG) },{ label: 'Limite MEI', value: limit.used_pct.toFixed(1)+'%' }]},
      limit.alert_level ? { type: 'alert', level: limit.alert_level==='critical'?'critical':'warning', text: limit.alert_message } : null,
    ].filter(Boolean), notes: 'Dados consolidados pela Aura. Confira antes de transmitir.' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(html);
  } catch (err) { console.error('[fiscal-pdf] dasn:', err.message); res.status(500).json({ error: 'Erro' }); }
});

// C4-03: Auto-preview DAS
router.get('/das/auto-preview', requireAuth, async (req, res) => {
  try {
    const company = await getCompany(req.params.id); const now = new Date(); const y = now.getFullYear(); const m = now.getMonth()+1;
    if (company.tax_regime === 'mei') {
      const das = calculateMEIDAS(req.query.activity||'services');
      const { rows } = await db.query(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE company_id=$1 AND type='income' AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date >= date_trunc('year', NOW() AT TIME ZONE 'America/Sao_Paulo')::date`, [req.params.id]);
      return res.json({ regime: 'mei', das, limit_check: checkMEILimit(parseFloat(rows[0]?.total||0)), due_date: `${y}-${String(m).padStart(2,'0')}-20` });
    }
    if (company.tax_regime === 'simples_nacional') {
      const { rows: curR } = await db.query(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE company_id=$1 AND type='income' AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date >= $2::date AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date < $3::date`, [req.params.id, `${y}-${String(m).padStart(2,'0')}-01`, m===12?`${y+1}-01-01`:`${y}-${String(m+1).padStart(2,'0')}-01`]);
      const { rows: r12 } = await db.query(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE company_id=$1 AND type='income' AND created_at >= NOW() - INTERVAL '12 months'`, [req.params.id]);
      const currentRev = parseFloat(curR[0]?.total||0); const rev12m = parseFloat(r12[0]?.total||0);
      let fatorR = null;
      try { const { rows: pl } = await db.query(`SELECT COALESCE(SUM(amount),0) AS total FROM prolabore_history WHERE company_id=$1 AND reference_month >= NOW() - INTERVAL '11 months'`, [req.params.id]); if (rev12m > 0) fatorR = parseFloat(((parseFloat(pl[0]?.total||0)/rev12m)*100).toFixed(1)); } catch {}
      const das = calculateSNDAS(rev12m, currentRev, fatorR);
      return res.json({ regime: 'simples_nacional', das, current_revenue: currentRev, revenue_12m: rev12m, fator_r: fatorR, due_date: `${y}-${String(m).padStart(2,'0')}-20` });
    }
    res.status(400).json({ error: 'Regime nao suportado' });
  } catch (err) { console.error('[auto-preview]:', err.message); res.status(500).json({ error: 'Erro' }); }
});

// ── FASE 2 ──────────────────────────────────────────────────

// C1-04: PDF Guia GPS/DARF (pro-labore INSS)
router.get('/gps/pdf', [requireAuth, requirePlan('negocio','expansao')], async (req, res) => {
  try {
    const company = await getCompany(req.params.id);
    const now = new Date(); const month = req.query.month || `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    const [y, m] = month.split('-').map(Number); const monthName = MONTH_NAMES[m-1];
    const dueDate = new Date(y, m-1, 20);
    // Buscar pro-labore do mes
    const { rows: plRows } = await db.query(`SELECT amount, inss_amount, net_amount, fator_r_result FROM prolabore_history WHERE company_id=$1 AND reference_month=$2`, [req.params.id, `${y}-${String(m).padStart(2,'0')}-01`]);
    let grossPL, gps;
    if (plRows.length > 0) {
      grossPL = parseFloat(plRows[0].amount);
      gps = calculateGPS(grossPL);
    } else {
      // Preview: calcular sugerido
      const { rows: cfg } = await db.query(`SELECT * FROM prolabore_config WHERE company_id=$1`, [req.params.id]);
      grossPL = parseFloat(cfg[0]?.fixed_amount || 1518);
      gps = calculateGPS(grossPL);
    }
    const html = fiscalPdfHtml({ title: 'Guia GPS/DARF - INSS Pro-labore', subtitle: `Competencia: ${monthName}/${y} | Vencimento: ${DATE_BR(dueDate)}`, company, sections: [
      { type: 'info', title: 'Dados do recolhimento', items: [{ label: 'Competencia', value: `${monthName}/${y}` },{ label: 'Codigo de receita', value: gps.code_receita+' (INSS)' },{ label: 'Vencimento', value: DATE_BR(dueDate) }]},
      { type: 'table', title: 'Calculo GPS', headers: ['Item','Valor (R$)'], rows: [
        ['Pro-labore bruto', BRL(grossPL)],
        ['INSS retido ('+Math.round(gps.inss_rate*100)+'% ate teto '+BRL(gps.inss_cap)+')', BRL(gps.inss_retido)],
        ['INSS patronal ('+Math.round(gps.patronal_rate*100)+'%)', BRL(gps.inss_patronal)],
      ], totals: [['Total GPS a recolher', BRL(gps.total_gps)]] },
      { type: 'info', title: 'Como pagar', items: [{ label: '1.', value: 'Acesse o Sicalc Web (receita.fazenda.gov.br/sicalc)' },{ label: '2.', value: 'Informe CNPJ, periodo e codigo 1007' },{ label: '3.', value: 'Gere a guia DARF e pague via Pix ou boleto' }]},
      { type: 'alert', level: 'info', text: 'O recolhimento do INSS sobre pro-labore e obrigatorio para socios de empresas do Simples Nacional.' },
    ], notes: gps.disclaimer });
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(html);
  } catch (err) { console.error('[fiscal-pdf] gps:', err.message); res.status(500).json({ error: 'Erro ao gerar PDF GPS' }); }
});

// C1-05: PDF Relatorio Anual DEFIS
router.get('/defis/report', [requireAuth], async (req, res) => {
  try {
    const company = await getCompany(req.params.id);
    const year = parseInt(req.query.year) || (new Date().getFullYear()-1);
    // Receitas mensais
    const { rows: recM } = await db.query(`SELECT TO_CHAR(date_trunc('month', created_at AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM') AS month, COALESCE(SUM(amount),0) AS total FROM transactions WHERE company_id=$1 AND type='income' AND EXTRACT(YEAR FROM created_at AT TIME ZONE 'America/Sao_Paulo')=$2 GROUP BY month ORDER BY month`, [req.params.id, year]);
    // Despesas por categoria
    const { rows: despCat } = await db.query(`SELECT COALESCE(category,'Outros') AS category, SUM(amount) AS total FROM transactions WHERE company_id=$1 AND type='expense' AND EXTRACT(YEAR FROM created_at AT TIME ZONE 'America/Sao_Paulo')=$2 GROUP BY category ORDER BY total DESC`, [req.params.id, year]);
    // Pro-labore anual
    const { rows: plAn } = await db.query(`SELECT COALESCE(SUM(amount),0) AS total, COALESCE(SUM(inss_amount),0) AS inss FROM prolabore_history WHERE company_id=$1 AND EXTRACT(YEAR FROM reference_month)=$2`, [req.params.id, year]);
    // Folha
    const { rows: folha } = await db.query(`SELECT COALESCE(SUM(gross_salary),0) AS total_bruto, COALESCE(SUM(fgts),0) AS total_fgts FROM payroll_records WHERE company_id=$1 AND period LIKE $2`, [req.params.id, year+'%']).catch(() => ({ rows: [{ total_bruto: 0, total_fgts: 0 }] }));

    const totalRec = recM.reduce((s,r) => s+parseFloat(r.total), 0);
    const totalDesp = despCat.reduce((s,r) => s+parseFloat(r.total), 0);
    const totalPL = parseFloat(plAn[0]?.total||0);
    const totalINSS = parseFloat(plAn[0]?.inss||0);
    const totalFolha = parseFloat(folha[0]?.total_bruto||0);
    const totalFGTS = parseFloat(folha[0]?.total_fgts||0);

    const allMonths = []; for (let i=0;i<12;i++) { const k=`${year}-${String(i+1).padStart(2,'0')}`; const f=recM.find(m=>m.month===k); allMonths.push({ label: MONTH_NAMES[i], total: f?parseFloat(f.total):0 }); }

    const html = fiscalPdfHtml({ title: 'Relatorio Anual - DEFIS', subtitle: `Ano-calendario ${year} | Entrega ate 31/03/${year+1}`, company, sections: [
      { type: 'info', title: 'Informacoes gerais', items: [{ label: 'Ano', value: String(year) },{ label: 'Regime', value: 'Simples Nacional' },{ label: 'Prazo DEFIS', value: '31/03/'+(year+1) }]},
      { type: 'table', title: 'Receita bruta mensal', headers: ['Mes','Receita (R$)'], rows: allMonths.map(m=>[m.label, BRL(m.total)]), totals: [['TOTAL ANUAL', BRL(totalRec)]] },
      { type: 'table', title: 'Despesas por categoria', headers: ['Categoria','Total (R$)'], rows: despCat.map(d=>[d.category, BRL(d.total)]), totals: [['TOTAL DESPESAS', BRL(totalDesp)]] },
      { type: 'info', title: 'Folha e encargos', items: [{ label: 'Pro-labore anual', value: BRL(totalPL) },{ label: 'INSS sobre pro-labore', value: BRL(totalINSS) },{ label: 'Folha de pagamento', value: BRL(totalFolha) },{ label: 'FGTS', value: BRL(totalFGTS) }]},
      { type: 'info', title: 'Resultado', items: [{ label: 'Receita bruta', value: BRL(totalRec) },{ label: 'Despesas', value: BRL(totalDesp) },{ label: 'Resultado bruto', value: BRL(totalRec-totalDesp) }]},
    ], notes: 'Dados consolidados pela Aura. A transmissao oficial da DEFIS deve ser feita no Portal do Simples Nacional.' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(html);
  } catch (err) { console.error('[fiscal-pdf] defis:', err.message); res.status(500).json({ error: 'Erro ao gerar DEFIS' }); }
});

// C1-06: PDF Resumo Folha / eSocial
router.get('/esocial/summary', [requireAuth, requirePlan('negocio','expansao')], async (req, res) => {
  try {
    const company = await getCompany(req.params.id);
    const now = new Date(); const month = req.query.month || `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    const [y, m] = month.split('-').map(Number); const monthName = MONTH_NAMES[m-1];
    // Empregados ativos
    const { rows: emps } = await db.query(`SELECT name, role_title, salary, hire_date FROM employees WHERE company_id=$1 AND status='active' ORDER BY name`, [req.params.id]);
    // Folha do mes
    const { rows: payroll } = await db.query(`SELECT e.name, pr.gross_salary, pr.inss_employee, pr.irrf, pr.fgts, pr.net_salary FROM payroll_records pr JOIN employees e ON e.id=pr.employee_id WHERE pr.company_id=$1 AND pr.period=$2 ORDER BY e.name`, [req.params.id, month]).catch(() => ({ rows: [] }));

    const totalBruto = payroll.reduce((s,r) => s+parseFloat(r.gross_salary||0), 0);
    const totalINSS = payroll.reduce((s,r) => s+parseFloat(r.inss_employee||0), 0);
    const totalFGTS = payroll.reduce((s,r) => s+parseFloat(r.fgts||0), 0);
    const totalLiq = payroll.reduce((s,r) => s+parseFloat(r.net_salary||0), 0);

    const sections = [
      { type: 'info', title: 'Dados do periodo', items: [{ label: 'Competencia', value: `${monthName}/${y}` },{ label: 'Empregados ativos', value: String(emps.length) },{ label: 'Portal', value: 'eSocial (login.esocial.gov.br)' }]},
      { type: 'table', title: 'Empregados ativos', headers: ['Nome','Cargo','Salario (R$)','Admissao'], rows: emps.map(e=>[e.name, e.role_title||'-', BRL(e.salary), e.hire_date ? DATE_BR(e.hire_date) : '-']) },
    ];
    if (payroll.length > 0) {
      sections.push({ type: 'table', title: 'Folha do mes', headers: ['Nome','Bruto (R$)','INSS (R$)','IRRF (R$)','FGTS (R$)','Liquido (R$)'], rows: payroll.map(p=>[p.name, BRL(p.gross_salary), BRL(p.inss_employee), BRL(p.irrf), BRL(p.fgts), BRL(p.net_salary)]), totals: [['TOTAIS', BRL(totalBruto), BRL(totalINSS), '-', BRL(totalFGTS), BRL(totalLiq)]] });
    }
    sections.push(
      { type: 'info', title: 'Eventos eSocial do mes', items: [{ label: 'S-1200', value: 'Remuneracao ('+emps.length+' empregados)' },{ label: 'S-1210', value: 'Pagamentos (folha do mes)' },{ label: 'S-1299', value: 'Fechamento dos eventos periodicos' }]},
      { type: 'info', title: 'Como enviar', items: [{ label: '1.', value: 'Acesse login.esocial.gov.br com Gov.br' },{ label: '2.', value: 'Navegue ate Enviar eventos' },{ label: '3.', value: 'Confira os dados com este resumo e envie' }]},
    );
    const html = fiscalPdfHtml({ title: 'Resumo da Folha - eSocial', subtitle: `Competencia: ${monthName}/${y}`, company, sections, notes: 'Resumo de apoio para envio no eSocial. Nao substitui o envio oficial dos eventos. Confira todos os dados antes de transmitir.' });
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(html);
  } catch (err) { console.error('[fiscal-pdf] esocial:', err.message); res.status(500).json({ error: 'Erro ao gerar resumo eSocial' }); }
});

// C1-07: PDF Guia FGTS
router.get('/fgts/pdf', [requireAuth, requirePlan('negocio','expansao')], async (req, res) => {
  try {
    const company = await getCompany(req.params.id);
    const now = new Date(); const month = req.query.month || `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    const [y, m] = month.split('-').map(Number); const monthName = MONTH_NAMES[m-1];
    const fgtsData = await calculateFGTS(req.params.id, month);
    if (fgtsData.employees.length === 0) return res.status(400).json({ error: 'Nenhum empregado ativo encontrado' });
    const dueDate = new Date(y, m-1, 7);
    const html = fiscalPdfHtml({ title: 'Guia FGTS Estimada', subtitle: `Competencia: ${monthName}/${y} | Vencimento: ${DATE_BR(dueDate)}`, company, sections: [
      { type: 'info', title: 'Dados do recolhimento', items: [{ label: 'Competencia', value: `${monthName}/${y}` },{ label: 'Aliquota', value: '8%' },{ label: 'Vencimento', value: DATE_BR(dueDate) },{ label: 'Empregados', value: String(fgtsData.employees.length) }]},
      { type: 'table', title: 'FGTS por empregado', headers: ['Nome','Cargo','Salario (R$)','FGTS (R$)'], rows: fgtsData.employees.map(e=>[e.name, e.role||'-', BRL(e.salary), BRL(e.fgts)]), totals: [['TOTAL', '', BRL(fgtsData.total_salary), BRL(fgtsData.total_fgts)]] },
      { type: 'info', title: 'Como recolher', items: [{ label: '1.', value: 'Acesse o FGTS Digital (fgtsdigital.gov.br)' },{ label: '2.', value: 'Gere a guia de recolhimento' },{ label: '3.', value: 'Pague via Pix ate '+DATE_BR(dueDate) }]},
    ], notes: fgtsData.disclaimer });
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(html);
  } catch (err) { console.error('[fiscal-pdf] fgts:', err.message); res.status(500).json({ error: 'Erro ao gerar PDF FGTS' }); }
});

module.exports = router;
