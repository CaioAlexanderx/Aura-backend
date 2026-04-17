// ============================================================
// AURA. — Fase 1 Contabilidade: PDFs de apoio fiscal
//
// Endpoints:
//   GET /obligations/das-mei/pdf          — Resumo DAS-MEI
//   GET /obligations/das-sn/pdf?month=    — Resumo DAS Simples Nacional
//   GET /obligations/dasn/report?year=    — Relatorio anual DASN-SIMEI
//   GET /obligations/das/auto-preview     — Auto-preenchimento receita
//
// LINGUAGEM: sempre "estimativa", nunca "declaracao oficial"
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { calculateMEIDAS, calculateSNDAS, checkMEILimit } = require('../services/fiscalObligations');

const BRL = (v) => `R$\u00a0${parseFloat(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const DATE_BR = (d) => new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const MONTH_NAMES = ['Janeiro','Fevereiro','Marco','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

function todaySP() {
  const d = new Date(Date.now() - 3 * 3600000);
  return d.toISOString().slice(0, 10);
}

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
      const rowsHtml = s.rows.map(r =>
        `<tr>${r.map((c, i) => `<td class="${i === 0 ? 'label' : 'num'}">${c}</td>`).join('')}</tr>`
      ).join('');
      const totHtml = (s.totals || []).map(t =>
        `<tr class="total-row"><td class="label">${t[0]}</td>${t.slice(1).map(c => `<td class="num">${c}</td>`).join('')}</tr>`
      ).join('');
      return `${s.title ? `<h2 class="sec-title">${s.title}</h2>` : ''}<table><thead><tr>${headHtml}</tr></thead><tbody>${rowsHtml}${totHtml}</tbody></table>`;
    }
    if (s.type === 'info') {
      return `<div class="info-block">${s.title ? `<h2 class="sec-title">${s.title}</h2>` : ''}${s.items.map(i =>
        `<div class="info-row"><span class="info-label">${i.label}</span><span class="info-value">${i.value}</span></div>`
      ).join('')}</div>`;
    }
    if (s.type === 'alert') {
      return `<div class="alert-block ${s.level}">${s.text}</div>`;
    }
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

// ── C1-01: PDF Resumo DAS-MEI ────────────────────────────────────────
router.get('/das-mei/pdf', requireAuth, async (req, res) => {
  try {
    const company = await getCompany(req.params.id);
    if (company.tax_regime !== 'mei') return res.status(400).json({ error: 'Disponivel apenas para MEI' });

    const activity = req.query.activity || 'services';
    const das = calculateMEIDAS(activity);
    const now = new Date();
    const refMonth = MONTH_NAMES[now.getMonth()];
    const dueDate = new Date(now.getFullYear(), now.getMonth(), 20);
    const duePast = dueDate < now;
    const actLabel = activity === 'commerce' ? 'Comercio' : activity === 'both' ? 'Comercio e Servicos' : 'Servicos';

    // Limite MEI
    const { rows: revRows } = await db.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE company_id=$1 AND type='income' AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date >= date_trunc('year', NOW() AT TIME ZONE 'America/Sao_Paulo')::date`,
      [req.params.id]
    );
    const annualRev = parseFloat(revRows[0]?.total || 0);
    const limit = checkMEILimit(annualRev);

    const html = fiscalPdfHtml({
      title: 'Resumo DAS-MEI',
      subtitle: `Competencia: ${refMonth} ${now.getFullYear()} | Vencimento: ${DATE_BR(dueDate)}`,
      company,
      sections: [
        { type: 'info', title: 'Dados do DAS', items: [
          { label: 'Competencia', value: `${refMonth}/${now.getFullYear()}` },
          { label: 'Atividade', value: actLabel },
          { label: 'Vencimento', value: DATE_BR(dueDate) },
          { label: 'Situacao', value: duePast ? 'VENCIDO' : 'A vencer' },
        ]},
        { type: 'table', title: 'Composicao do valor', headers: ['Tributo', 'Valor (R$)'], rows: [
          ['INSS (contribuicao previdenciaria)', BRL(das.inss)],
          ['ICMS (comercio/industria)', BRL(das.icms)],
          ['ISS (servicos)', BRL(das.iss)],
        ], totals: [['DAS-MEI Total', BRL(das.total)]] },
        duePast ? { type: 'alert', level: 'critical', text: `ATENCAO: O DAS de ${refMonth} venceu em ${DATE_BR(dueDate)}. Pague o mais rapido possivel para evitar juros e multa.` }
          : { type: 'alert', level: 'ok', text: `DAS dentro do prazo. Vence em ${DATE_BR(dueDate)}.` },
        { type: 'info', title: 'Monitor de faturamento anual', items: [
          { label: 'Faturamento acumulado no ano', value: BRL(annualRev) },
          { label: 'Limite anual MEI', value: BRL(81000) },
          { label: 'Utilizado', value: limit.used_pct.toFixed(1) + '%' },
          { label: 'Disponivel', value: BRL(limit.remaining) },
        ]},
        limit.alert_level ? { type: 'alert', level: limit.alert_level === 'critical' ? 'critical' : 'warning', text: limit.alert_message } : null,
        { type: 'info', title: 'Como pagar', items: [
          { label: 'Portal PGMEI', value: 'www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app' },
          { label: 'Opcoes de pagamento', value: 'Boleto, Pix ou Debito Automatico' },
          { label: 'Dica', value: 'Use o QR Code na aba Contabilidade da Aura para abrir o portal com CNPJ preenchido' },
        ]},
      ].filter(Boolean),
      notes: 'Estimativa com base na tabela DAS-MEI vigente. Confirme o valor no portal PGMEI antes de efetuar o pagamento. Este documento nao substitui a guia oficial.',
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[fiscal-pdf] das-mei error:', err.message);
    res.status(500).json({ error: 'Erro ao gerar PDF do DAS-MEI' });
  }
});

// ── C1-02: PDF Resumo DAS Simples Nacional ───────────────────────────
router.get('/das-sn/pdf', requireAuth, async (req, res) => {
  try {
    const company = await getCompany(req.params.id);
    if (company.tax_regime !== 'simples_nacional') return res.status(400).json({ error: 'Disponivel apenas para Simples Nacional' });

    const now = new Date();
    const month = req.query.month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const [y, m] = month.split('-').map(Number);
    const monthName = MONTH_NAMES[m - 1];
    const dueDate = new Date(y, m - 1, 20);

    const { rows: curR } = await db.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE company_id=$1 AND type='income' AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date >= $2::date AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date < $3::date`,
      [req.params.id, `${y}-${String(m).padStart(2,'0')}-01`, m === 12 ? `${y+1}-01-01` : `${y}-${String(m+1).padStart(2,'0')}-01`]
    );
    const { rows: r12 } = await db.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE company_id=$1 AND type='income' AND created_at >= NOW() - INTERVAL '12 months'`,
      [req.params.id]
    );
    const currentRev = parseFloat(curR[0]?.total || 0);
    const rev12m = parseFloat(r12[0]?.total || 0);
    const das = calculateSNDAS(rev12m, currentRev);

    // Fator R (se disponivel)
    let fatorRInfo = null;
    try {
      const { rows: plRows } = await db.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM prolabore_history WHERE company_id=$1 AND reference_month >= NOW() - INTERVAL '11 months'`,
        [req.params.id]
      );
      const pl12 = parseFloat(plRows[0]?.total || 0);
      if (rev12m > 0) {
        const fatorR = ((pl12 / rev12m) * 100).toFixed(1);
        fatorRInfo = { fatorR, anexo: parseFloat(fatorR) >= 28 ? 'III' : 'V', pl12 };
      }
    } catch {}

    const sections = [
      { type: 'info', title: 'Dados da apuracao', items: [
        { label: 'Competencia', value: `${monthName}/${y}` },
        { label: 'Receita bruta do mes', value: BRL(currentRev) },
        { label: 'Receita bruta 12 meses (RBT12)', value: BRL(rev12m) },
        { label: 'Vencimento', value: DATE_BR(dueDate) },
      ]},
      { type: 'table', title: 'Calculo estimado do DAS', headers: ['Item', 'Valor'], rows: [
        ['Receita bruta do mes', BRL(currentRev)],
        ['RBT12 (receita bruta acumulada 12m)', BRL(rev12m)],
        ['Aliquota nominal (Anexo ' + (fatorRInfo ? fatorRInfo.anexo : 'III') + ')', das.nominal_rate_pct + '%'],
        ['Aliquota efetiva', das.effective_rate_pct + '%'],
      ], totals: [['DAS estimado', BRL(das.estimated_das)]] },
    ];

    if (fatorRInfo) {
      sections.push({ type: 'info', title: 'Fator R', items: [
        { label: 'Pro-labore acumulado 12m', value: BRL(fatorRInfo.pl12) },
        { label: 'Fator R', value: fatorRInfo.fatorR + '%' },
        { label: 'Anexo enquadrado', value: 'Anexo ' + fatorRInfo.anexo },
        { label: 'Status', value: parseFloat(fatorRInfo.fatorR) >= 28 ? 'OK - Anexo III (aliquota menor)' : 'Atencao - Anexo V (aliquota maior)' },
      ]});
    }

    sections.push({ type: 'info', title: 'Proximos passos', items: [
      { label: '1. Transmitir PGDAS-D', value: 'Portal Simples Nacional' },
      { label: '2. Gerar guia DAS', value: 'No portal, apos transmissao' },
      { label: '3. Pagar', value: 'Boleto ou Pix ate ' + DATE_BR(dueDate) },
    ]});

    const html = fiscalPdfHtml({
      title: 'Demonstrativo DAS - Simples Nacional',
      subtitle: `Competencia: ${monthName}/${y} | Vencimento: ${DATE_BR(dueDate)}`,
      company, sections,
      notes: 'Estimativa calculada pela Aura com base no Anexo ' + (fatorRInfo ? fatorRInfo.anexo : 'III') + ' do Simples Nacional. A apuracao oficial deve ser feita no Portal PGDAS-D. Valores podem divergir da apuracao oficial.',
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[fiscal-pdf] das-sn error:', err.message);
    res.status(500).json({ error: 'Erro ao gerar PDF do DAS-SN' });
  }
});

// ── C1-03: PDF Relatorio Anual DASN-SIMEI ────────────────────────────
router.get('/dasn/report', requireAuth, async (req, res) => {
  try {
    const company = await getCompany(req.params.id);
    const year = parseInt(req.query.year) || (new Date().getFullYear() - 1);

    const { rows: monthly } = await db.query(
      `SELECT
         TO_CHAR(date_trunc('month', created_at AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM') AS month,
         COALESCE(SUM(amount) FILTER(WHERE category IN ('Vendas','Revenda','Comercio','Produto','Mercadoria')), 0) AS comercio,
         COALESCE(SUM(amount) FILTER(WHERE category NOT IN ('Vendas','Revenda','Comercio','Produto','Mercadoria')), 0) AS servicos,
         COALESCE(SUM(amount), 0) AS total
       FROM transactions
       WHERE company_id=$1 AND type='income'
         AND EXTRACT(YEAR FROM created_at AT TIME ZONE 'America/Sao_Paulo') = $2
       GROUP BY month ORDER BY month`,
      [req.params.id, year]
    );

    const totalComercio = monthly.reduce((s, r) => s + parseFloat(r.comercio), 0);
    const totalServicos = monthly.reduce((s, r) => s + parseFloat(r.servicos), 0);
    const totalGeral = monthly.reduce((s, r) => s + parseFloat(r.total), 0);
    const limit = checkMEILimit(totalGeral);

    // Preencher meses sem dados
    const allMonths = [];
    for (let i = 0; i < 12; i++) {
      const key = `${year}-${String(i + 1).padStart(2, '0')}`;
      const found = monthly.find(m => m.month === key);
      allMonths.push({
        label: MONTH_NAMES[i],
        comercio: found ? parseFloat(found.comercio) : 0,
        servicos: found ? parseFloat(found.servicos) : 0,
        total: found ? parseFloat(found.total) : 0,
      });
    }

    const sections = [
      { type: 'info', title: 'Informacoes da declaracao', items: [
        { label: 'Ano-calendario', value: String(year) },
        { label: 'Regime', value: 'MEI - Simples Nacional (SIMEI)' },
        { label: 'Prazo de entrega', value: '31/05/' + (year + 1) },
        { label: 'Portal', value: 'DASN-SIMEI (Simples Nacional)' },
      ]},
      { type: 'table', title: 'Faturamento mensal - ' + year, headers: ['Mes', 'Comercio/Industria (R$)', 'Servicos (R$)', 'Total (R$)'],
        rows: allMonths.map(m => [m.label, BRL(m.comercio), BRL(m.servicos), BRL(m.total)]),
        totals: [['TOTAL ANUAL', BRL(totalComercio), BRL(totalServicos), BRL(totalGeral)]],
      },
      { type: 'info', title: 'Resumo para preenchimento', items: [
        { label: 'Receita bruta - Comercio e Industria', value: BRL(totalComercio) },
        { label: 'Receita bruta - Prestacao de Servicos', value: BRL(totalServicos) },
        { label: 'Receita bruta total', value: BRL(totalGeral) },
        { label: 'Percentual do limite MEI utilizado', value: limit.used_pct.toFixed(1) + '%' },
      ]},
      limit.alert_level ? { type: 'alert', level: limit.alert_level === 'critical' ? 'critical' : 'warning', text: limit.alert_message } : null,
      { type: 'info', title: 'Como transmitir', items: [
        { label: '1.', value: 'Acesse o portal DASN-SIMEI (link na aba Contabilidade da Aura)' },
        { label: '2.', value: 'Informe seu CNPJ e codigo de acesso' },
        { label: '3.', value: 'Preencha os valores de Comercio e Servicos conforme este relatorio' },
        { label: '4.', value: 'Confira, transmita e guarde o recibo' },
      ]},
    ].filter(Boolean);

    const html = fiscalPdfHtml({
      title: 'Relatorio Anual de Faturamento - DASN-SIMEI',
      subtitle: `Ano-calendario ${year} | Entrega ate 31/05/${year + 1}`,
      company, sections,
      notes: `Dados consolidados pela Aura com base nos lancamentos de receita registrados em ${year}. Confira os valores antes de transmitir a DASN-SIMEI. A separacao entre comercio e servicos e baseada nas categorias dos lancamentos e pode precisar de ajuste manual.`,
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[fiscal-pdf] dasn error:', err.message);
    res.status(500).json({ error: 'Erro ao gerar relatorio DASN' });
  }
});

// ── C4-03: Auto-preview DAS (sem parametros manuais) ─────────────────
router.get('/das/auto-preview', requireAuth, async (req, res) => {
  try {
    const company = await getCompany(req.params.id);
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;

    if (company.tax_regime === 'mei') {
      const activity = req.query.activity || 'services';
      const das = calculateMEIDAS(activity);
      const { rows } = await db.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE company_id=$1 AND type='income' AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date >= date_trunc('year', NOW() AT TIME ZONE 'America/Sao_Paulo')::date`,
        [req.params.id]
      );
      const annualRev = parseFloat(rows[0]?.total || 0);
      const limit = checkMEILimit(annualRev);
      return res.json({ regime: 'mei', das, limit_check: limit, due_date: `${y}-${String(m).padStart(2,'0')}-20` });
    }

    if (company.tax_regime === 'simples_nacional') {
      const { rows: curR } = await db.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE company_id=$1 AND type='income' AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date >= $2::date AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date < $3::date`,
        [req.params.id, `${y}-${String(m).padStart(2,'0')}-01`, m === 12 ? `${y+1}-01-01` : `${y}-${String(m+1).padStart(2,'0')}-01`]
      );
      const { rows: r12 } = await db.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE company_id=$1 AND type='income' AND created_at >= NOW() - INTERVAL '12 months'`,
        [req.params.id]
      );
      const currentRev = parseFloat(curR[0]?.total || 0);
      const rev12m = parseFloat(r12[0]?.total || 0);
      const das = calculateSNDAS(rev12m, currentRev);
      return res.json({ regime: 'simples_nacional', das, current_revenue: currentRev, revenue_12m: rev12m, due_date: `${y}-${String(m).padStart(2,'0')}-20` });
    }

    res.status(400).json({ error: 'Regime nao suportado: ' + company.tax_regime });
  } catch (err) {
    console.error('[das-auto-preview] error:', err.message);
    res.status(500).json({ error: 'Erro ao calcular DAS' });
  }
});

module.exports = router;
