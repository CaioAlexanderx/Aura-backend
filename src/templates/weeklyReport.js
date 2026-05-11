// ============================================================
// AURA. — Template HTML Relatório Semanal
// Função pura: recebe dados → retorna string HTML completa.
// ============================================================

// ── Formatadores ─────────────────────────────────────────────
function fmtBRL(v) {
  const n = Math.round(v * 100) / 100;
  const [int, dec] = n.toFixed(2).split('.');
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return dec === '00' ? intFmt : `${intFmt},${dec}`;
}

// Valor compacto para rotulo das barras (sem "R$")
function fmtBarVal(v) {
  if (!v || v === 0) return '–';
  if (v >= 1000000) return (v / 1000000).toFixed(1).replace('.', ',') + 'M';
  if (v >= 1000)    return (v / 1000).toFixed(1).replace('.', ',') + 'K';
  const [int, dec] = v.toFixed(2).split('.');
  return dec === '00' ? int : `${int},${dec}`;
}

// Inteiro com separador de milhar PT-BR (sem ICU)
function fmtInt(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// Data DD/MM/YYYY sem depender de Intl
function fmtDateBR(date) {
  const d = date.getUTCDate();
  const m = date.getUTCMonth() + 1;
  const y = date.getUTCFullYear();
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

// ── SVG helpers ───────────────────────────────────────────────
function arrowSvg(dir) {
  const pts   = dir === 'up' ? '18 15 12 9 6 15' : '6 9 12 15 18 9';
  const color = dir === 'up' ? '#34d399' : '#f87171';
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="${pts}"/></svg>`;
}

function wowIconSvg(type) {
  const base = `width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
  if (type === 'box')
    return `<svg ${base}><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`;
  if (type === 'user')
    return `<svg ${base}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
  return `<svg ${base}><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`;
}

// ── Health helpers ────────────────────────────────────────────
function pillColors(score) {
  if (score >= 70) return 'background:#0d2e22;color:#34d399;border-color:rgba(52,211,153,0.3)';
  if (score >= 40) return 'background:#2e2208;color:#fbbf24;border-color:rgba(251,191,36,0.3)';
  return 'background:#2e0d0d;color:#f87171;border-color:rgba(248,113,113,0.3)';
}
function pillLabel(score) {
  if (score >= 70) return 'Saudável';
  if (score >= 40) return 'Atenção';
  return 'Crítico';
}
function healthBarColor(score) {
  if (score >= 70) return '#34d399';
  if (score >= 40) return '#fbbf24';
  return '#f87171';
}

// ── Heatmap builder ───────────────────────────────────────────
function buildHeatmapHtml(heatmapData) {
  if (!heatmapData || heatmapData.length === 0) return '';

  const HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
  const DAYS  = [
    { dow: 1, label: 'Seg' },
    { dow: 2, label: 'Ter' },
    { dow: 3, label: 'Qua' },
    { dow: 4, label: 'Qui' },
    { dow: 5, label: 'Sex' },
    { dow: 6, label: 'Sab' },
  ];

  // Lookup dow → hour → { count, revenue }
  const hmap = {};
  heatmapData.forEach(row => {
    if (!hmap[row.dow]) hmap[row.dow] = {};
    hmap[row.dow][row.hour] = {
      count:   row.sale_count,
      revenue: parseFloat(row.revenue) || 0,
    };
  });

  const maxCount = Math.max(...heatmapData.map(r => r.sale_count), 1);

  const header = `<div class="hmap-row">
    <div class="hmap-label"></div>
    ${HOURS.map(h => `<div class="hmap-h">${h}h</div>`).join('')}
  </div>`;

  const rows = DAYS.map(({ dow, label }) => {
    const cells = HOURS.map(h => {
      const cell  = hmap[dow] && hmap[dow][h];
      const count = cell ? cell.count : 0;
      const alpha = count > 0 ? Math.max(0.12, (count / maxCount) * 0.85) : 0.04;
      const bg    = `rgba(124,58,237,${alpha.toFixed(2)})`;
      const tip   = count > 0 ? `${count} venda${count !== 1 ? 's' : ''}` : '0';
      return `<div class="hmap-cell" style="background:${bg}" title="${tip}"></div>`;
    }).join('');
    return `<div class="hmap-row"><div class="hmap-label">${label}</div>${cells}</div>`;
  }).join('');

  return `<div class="hmap-wrap">${header}${rows}</div>`;
}

// ── Main builder ──────────────────────────────────────────────
function buildWeeklyReportHtml(data) {
  const {
    company, period, health, kpis,
    dailyRevenue, topProducts, payments,
    priorities, wowInsight,
    narratives = {},
    heatmapData = [],
    plan,
  } = data;

  // Bar chart
  const maxVal    = Math.max(...dailyRevenue.map(d => d.value), 0);
  const barItems  = dailyRevenue.map(d => {
    const heightPct = maxVal > 0 ? Math.round((d.value / maxVal) * 96) : 0;
    const bestClass = d.is_best ? ' best' : '';
    return `
      <div class="bar-col">
        <div class="bar-val">${fmtBarVal(d.value)}</div>
        <div class="bar-wrap">
          <div class="bar-fill${bestClass}" style="height:${heightPct}%"></div>
        </div>
        <div class="bar-day">${d.day}</div>
      </div>`;
  }).join('');

  // Payments
  const payItems = payments.map(p => `
    <div class="pay-row">
      <div class="pay-label">${p.name}</div>
      <div class="pay-track"><div class="pay-fill" style="width:${Math.round(p.pct)}%"></div></div>
      <div class="pay-pct">${p.pct.toFixed(1)}%</div>
    </div>`).join('');

  // Top products
  const prodItems = topProducts.map((p, i) => `
    <div class="prod-row">
      <div class="prod-rank">${p.rank}</div>
      <div class="prod-info">
        <div class="prod-name">${p.name}</div>
        <div class="prod-cat">${p.category}</div>
      </div>
      <div class="prod-nums">
        <div class="prod-rev">R$&nbsp;${fmtBRL(p.revenue)}</div>
        <div class="prod-qty">${fmtInt(p.qty)} un.</div>
      </div>
    </div>${i < topProducts.length - 1 ? '<div class="prod-divider"></div>' : ''}`).join('');

  // Priorities
  const priItems = priorities.map((p, i) => `
    <div class="pri-item">
      <div class="pri-num">${p.num}</div>
      <div class="pri-body">
        <div class="pri-action">${p.action}</div>
        <div class="pri-impact">${p.impact}</div>
        <a href="${p.cta_url}" class="pri-cta">${p.cta_label} →</a>
      </div>
    </div>${i < priorities.length - 1 ? '<div class="pri-divider"></div>' : ''}`).join('');

  // WoW block
  const wowBlock = wowInsight ? `
    <div class="wow">
      <div class="wow-icon">${wowIconSvg(wowInsight.icon_type)}</div>
      <div class="wow-text">${wowInsight.text}</div>
    </div>` : '';

  // Company logo
  const logoBlock = company.logo_url
    ? `<img src="${company.logo_url}" alt="${company.name}">`
    : `<div class="logo-placeholder">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
      </div>`;

  // KPI novos clientes (planos NEG+)
  const showNewCustomers = plan !== 'essencial';
  const newCustBlock = showNewCustomers ? `
    <div class="kpi-card">
      <div class="kpi-label">Novos Clientes <span class="kpi-badge">NEG+</span></div>
      <div class="kpi-value">${kpis.new_customers}</div>
      <div class="kpi-delta" style="color:${kpis.customers_dir === 'up' ? '#34d399' : '#f87171'}">
        ${arrowSvg(kpis.customers_dir)} ${kpis.customers_delta > 0 ? '+' : ''}${kpis.customers_delta} vs sem. ant.
      </div>
    </div>` : '';

  // Narrativa de faturamento
  const revenueNarrBlock = narratives.revenue ? `
    <div class="bar-insight">${narratives.revenue}</div>` : '';

  // Heatmap section
  const heatmapHtml = buildHeatmapHtml(heatmapData);
  const heatmapPanel = heatmapHtml ? `
    <div class="section-label">③ Mapa de Movimentação · Hora × Dia</div>
    <div class="panel">
      <div class="panel-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
        Vendas por horário — semana passada
      </div>
      ${heatmapHtml}
      <div class="hmap-legend">
        <div class="hmap-leg-item"><div class="hmap-leg-dot" style="background:rgba(124,58,237,0.08)"></div> Sem vendas</div>
        <div class="hmap-leg-item"><div class="hmap-leg-dot" style="background:rgba(124,58,237,0.5)"></div> Moderado</div>
        <div class="hmap-leg-item"><div class="hmap-leg-dot" style="background:rgba(124,58,237,0.9)"></div> Pico</div>
      </div>
    </div>` : '';

  // Health
  const _pillLabel   = pillLabel(health.score);
  const _pillColors  = pillColors(health.score);
  const _barColor    = healthBarColor(health.score);
  const deltaSign    = health.delta_dir === 'up' ? '+' : '';
  const deltaColor   = health.delta_dir === 'up' ? '#34d399' : '#f87171';

  // Numeracao das secoes (heatmap desloca)
  const secPriLabel  = heatmapHtml ? '④' : '③';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Relatório Semanal · ${company.name}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Sora:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: linear-gradient(160deg,#0e1228 0%,#130f2a 50%,#0e1228 100%);
      color: #f1f5f9;
      font-family: 'Inter', system-ui, sans-serif;
      min-height: 100vh;
      padding: 32px 16px 64px;
      -webkit-font-smoothing: antialiased;
    }

    .shell { max-width: 680px; margin: 0 auto; display: flex; flex-direction: column; gap: 24px; }

    /* ── Powered bar ── */
    .powered { display: flex; align-items: center; justify-content: space-between; padding: 0 4px; }
    .powered-brand { display: flex; align-items: center; gap: 8px; }
    .powered-logo { font-family: 'Sora', 'Inter', sans-serif; font-size: 18px; font-weight: 700; color: #a78bfa; letter-spacing: -0.5px; }
    .powered-tag { font-size: 11px; color: #64748b; font-style: italic; }
    .powered-meta { font-size: 12px; color: #64748b; text-align: right; line-height: 1.5; }
    .powered-period { font-weight: 600; color: #cbd5e1; }

    /* ── Masthead ── */
    .masthead { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 20px; padding: 28px 28px 24px; display: flex; gap: 20px; align-items: flex-start; box-shadow: 0 4px 24px -8px rgba(0,0,0,0.5); }
    .client-logo { width: 64px; height: 64px; border-radius: 14px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.07); display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0; }
    .client-logo img { width: 100%; height: 100%; object-fit: contain; }
    .logo-placeholder { display: flex; flex-direction: column; align-items: center; gap: 4px; color: #64748b; font-size: 9px; }
    .masthead-info { flex: 1; min-width: 0; }
    .masthead-kicker { font-size: 11px; font-weight: 600; letter-spacing: 1.2px; text-transform: uppercase; color: #a78bfa; margin-bottom: 6px; }
    .masthead-name { font-family: 'Sora', 'Inter', sans-serif; font-size: 26px; font-weight: 700; color: #f1f5f9; letter-spacing: -0.5px; line-height: 1.2; margin-bottom: 10px; }
    .masthead-pills { display: flex; flex-wrap: wrap; gap: 8px; }
    .meta-pill { font-size: 12px; padding: 4px 10px; border-radius: 20px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.07); color: #cbd5e1; display: flex; align-items: center; gap: 5px; }

    /* ── Section label ── */
    .section-label { font-size: 11px; font-weight: 600; letter-spacing: 1.2px; text-transform: uppercase; color: #64748b; padding: 0 4px; }

    /* ── Diagnostic row ── */
    .diag { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    @media (max-width: 520px) { .diag { grid-template-columns: 1fr; } }

    /* ── Health card ── */
    .health-card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 16px; padding: 20px; }
    .health-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 16px; }
    .health-label-sm { font-size: 11px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; color: #64748b; margin-bottom: 4px; }
    .health-score { font-family: 'Sora', 'Inter', sans-serif; font-size: 40px; font-weight: 700; line-height: 1; color: #f1f5f9; }
    .health-score sup { font-size: 18px; font-weight: 600; color: #64748b; vertical-align: super; }
    .health-pill { font-size: 12px; font-weight: 600; padding: 5px 12px; border-radius: 20px; border: 1px solid; margin-top: 4px; }
    .health-bar-wrap { background: rgba(255,255,255,0.06); border-radius: 8px; height: 8px; position: relative; margin-bottom: 8px; overflow: visible; }
    .health-bar-fill { height: 100%; border-radius: 8px; }
    .health-bar-marker { position: absolute; top: -4px; width: 10px; height: 16px; background: #f1f5f9; border-radius: 3px; box-shadow: 0 2px 8px rgba(0,0,0,0.4); }
    .health-delta { font-size: 12px; color: #64748b; margin-top: 8px; }

    /* ── KPI grid ── */
    .kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .kpi-card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 14px; padding: 14px 16px; }
    .kpi-label { font-size: 11px; font-weight: 600; letter-spacing: 0.8px; text-transform: uppercase; color: #64748b; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
    .kpi-badge { font-size: 9px; padding: 2px 6px; border-radius: 10px; background: rgba(124,58,237,0.2); color: #a78bfa; border: 1px solid rgba(124,58,237,0.3); }
    .kpi-value { font-family: 'Sora', 'Inter', sans-serif; font-size: 22px; font-weight: 700; color: #f1f5f9; line-height: 1.1; margin-bottom: 4px; }
    .kpi-delta { font-size: 11px; font-weight: 500; display: flex; align-items: center; gap: 3px; }
    .kpi-days { font-size: 11px; color: #64748b; margin-top: 2px; }

    /* ── Panel ── */
    .panel { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 16px; padding: 20px; box-shadow: 0 4px 24px -8px rgba(0,0,0,0.5); }
    .panel-title { font-size: 13px; font-weight: 600; color: #cbd5e1; margin-bottom: 20px; display: flex; align-items: center; gap: 8px; }
    .panel-title svg { color: #a78bfa; }

    /* ── Bar chart ── */
    .bar-chart { display: flex; align-items: flex-end; gap: 8px; height: 160px; }
    .bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; gap: 2px; }
    .bar-val {
      font-size: 9px;
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
      color: #94a3b8;
      white-space: nowrap;
      text-align: center;
      line-height: 1;
      padding-bottom: 2px;
      max-width: 100%;
      overflow: hidden;
    }
    .bar-wrap { flex: 1; width: 100%; display: flex; align-items: flex-end; }
    .bar-fill { width: 100%; border-radius: 6px 6px 3px 3px; background: rgba(167,139,250,0.3); min-height: 3px; }
    .bar-fill.best { background: linear-gradient(180deg, #7c3aed 0%, #a78bfa 100%); box-shadow: 0 0 12px rgba(124,58,237,0.4); }
    .bar-day { font-size: 10px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; }

    /* ── Bar narrative insight ── */
    .bar-insight { margin-top: 16px; font-size: 12px; color: #94a3b8; line-height: 1.6; padding: 10px 14px; background: rgba(167,139,250,0.05); border-radius: 8px; border-left: 2px solid rgba(167,139,250,0.25); font-style: italic; }

    /* ── Heatmap ── */
    .hmap-wrap { display: flex; flex-direction: column; gap: 4px; }
    .hmap-row { display: flex; align-items: center; gap: 3px; }
    .hmap-label { font-size: 10px; font-weight: 600; color: #64748b; width: 28px; flex-shrink: 0; text-align: right; padding-right: 6px; }
    .hmap-h { flex: 1; font-size: 8px; color: #475569; text-align: center; font-family: 'JetBrains Mono', monospace; }
    .hmap-cell { flex: 1; height: 22px; border-radius: 3px; cursor: default; min-width: 0; }
    .hmap-legend { display: flex; gap: 16px; margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.06); }
    .hmap-leg-item { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #64748b; }
    .hmap-leg-dot { width: 14px; height: 14px; border-radius: 3px; flex-shrink: 0; }

    /* ── Split grid ── */
    .split { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    @media (max-width: 520px) { .split { grid-template-columns: 1fr; } }

    /* ── Top products ── */
    .prod-list { display: flex; flex-direction: column; gap: 12px; }
    .prod-row { display: flex; align-items: center; gap: 10px; }
    .prod-rank { font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 600; color: #a78bfa; width: 18px; flex-shrink: 0; text-align: center; }
    .prod-info { flex: 1; min-width: 0; }
    .prod-name { font-size: 13px; font-weight: 500; color: #f1f5f9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .prod-cat { font-size: 11px; color: #64748b; margin-top: 1px; }
    .prod-nums { text-align: right; flex-shrink: 0; }
    .prod-rev { font-family: 'JetBrains Mono', monospace; font-size: 12px; font-weight: 600; color: #f1f5f9; }
    .prod-qty { font-size: 11px; color: #64748b; margin-top: 1px; }
    .prod-divider { height: 1px; background: rgba(255,255,255,0.07); margin: 4px 0; }

    /* ── Payments ── */
    .pay-list { display: flex; flex-direction: column; gap: 10px; }
    .pay-row { display: flex; align-items: center; gap: 8px; }
    .pay-label { font-size: 12px; font-weight: 500; color: #cbd5e1; width: 52px; flex-shrink: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pay-track { flex: 1; height: 6px; background: rgba(255,255,255,0.06); border-radius: 4px; overflow: hidden; }
    .pay-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, #7c3aed, #a78bfa); min-width: 4px; }
    .pay-pct { font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 600; color: #a78bfa; width: 38px; text-align: right; flex-shrink: 0; }

    /* ── Priorities card ── */
    .priorities-card { background: rgba(255,255,255,0.03); border: 1px solid rgba(167,139,250,0.25); border-radius: 20px; padding: 24px; }
    .priorities-header { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
    .priorities-icon { width: 36px; height: 36px; border-radius: 10px; background: rgba(124,58,237,0.15); border: 1px solid rgba(124,58,237,0.3); display: flex; align-items: center; justify-content: center; }
    .priorities-title { font-family: 'Sora', 'Inter', sans-serif; font-size: 16px; font-weight: 700; color: #f1f5f9; }
    .priorities-sub { font-size: 12px; color: #64748b; margin-top: 1px; }
    .pri-list { display: flex; flex-direction: column; gap: 16px; }
    .pri-item { display: flex; gap: 14px; align-items: flex-start; }
    .pri-num { width: 28px; height: 28px; border-radius: 8px; background: rgba(124,58,237,0.2); border: 1px solid rgba(167,139,250,0.25); display: flex; align-items: center; justify-content: center; font-family: 'Sora', 'Inter', sans-serif; font-size: 13px; font-weight: 700; color: #a78bfa; flex-shrink: 0; }
    .pri-body { flex: 1; }
    .pri-action { font-size: 14px; font-weight: 500; color: #f1f5f9; line-height: 1.4; margin-bottom: 4px; }
    .pri-impact { font-size: 12px; color: #64748b; line-height: 1.4; margin-bottom: 8px; }
    .pri-cta { display: inline-block; font-size: 12px; font-weight: 600; color: #a78bfa; text-decoration: none; padding: 5px 12px; border: 1px solid rgba(167,139,250,0.25); border-radius: 20px; background: rgba(124,58,237,0.1); }
    .pri-divider { height: 1px; background: rgba(255,255,255,0.07); margin: 4px 0; }

    /* ── WoW insight ── */
    .wow { margin-top: 20px; padding: 16px; border-radius: 12px; background: rgba(124,58,237,0.08); border: 1px solid rgba(167,139,250,0.2); display: flex; gap: 12px; align-items: flex-start; }
    .wow-icon { width: 36px; height: 36px; border-radius: 10px; background: rgba(124,58,237,0.15); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .wow-text { font-size: 13px; color: #cbd5e1; line-height: 1.6; padding-top: 8px; }
    .wow-text .num { font-family: 'JetBrains Mono', monospace; color: #a78bfa; font-weight: 600; }

    /* ── Footer ── */
    .footer { display: flex; align-items: center; justify-content: space-between; padding: 0 4px; font-size: 12px; color: #64748b; }
    .footer em { font-style: italic; }
  </style>
</head>
<body>
  <div class="shell">

    <!-- Powered bar -->
    <div class="powered">
      <div class="powered-brand">
        <span class="powered-logo">Aura.</span>
        <span class="powered-tag">Relatório Semanal</span>
      </div>
      <div class="powered-meta">
        <div class="powered-period">${period.label}</div>
        <div>Edição #${period.edition} · ${period.sent_at}</div>
      </div>
    </div>

    <!-- Masthead -->
    <div class="masthead">
      <div class="client-logo">${logoBlock}</div>
      <div class="masthead-info">
        <div class="masthead-kicker">Resumo Executivo Semanal</div>
        <div class="masthead-name">${company.name}</div>
        <div class="masthead-pills">
          <div class="meta-pill">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            ${period.label}
          </div>
          <div class="meta-pill">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            ${period.sent_at}
          </div>
        </div>
      </div>
    </div>

    <!-- ① Diagnóstico -->
    <div class="section-label">① Diagnóstico do Período</div>
    <div class="diag">
      <div class="health-card">
        <div class="health-top">
          <div>
            <div class="health-label-sm">Saúde do Negócio</div>
            <div class="health-score">${health.score}<sup>/100</sup></div>
          </div>
          <div class="health-pill" style="${_pillColors}">${_pillLabel}</div>
        </div>
        <div class="health-bar-wrap">
          <div class="health-bar-fill" style="width:${health.score}%;background:${_barColor}"></div>
          <div class="health-bar-marker" style="left:calc(${health.score}% - 5px)"></div>
        </div>
        <div class="health-delta" style="color:${deltaColor}">
          ${arrowSvg(health.delta_dir)} ${deltaSign}${health.delta} pts vs semana anterior
        </div>
      </div>

      <div class="kpis">
        <div class="kpi-card">
          <div class="kpi-label">Faturamento</div>
          <div class="kpi-value" style="font-size:16px;">R$&nbsp;${fmtBRL(kpis.revenue)}</div>
          <div class="kpi-delta" style="color:${kpis.revenue_dir === 'up' ? '#34d399' : '#f87171'}">
            ${arrowSvg(kpis.revenue_dir)} ${kpis.revenue_delta > 0 ? '+' : ''}${kpis.revenue_delta}% vs sem. ant.
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Vendas</div>
          <div class="kpi-value">${kpis.sales}</div>
          <div class="kpi-days">${kpis.active_days} dias ativos</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Ticket Médio</div>
          <div class="kpi-value" style="font-size:16px;">R$&nbsp;${fmtBRL(kpis.avg_ticket)}</div>
          <div class="kpi-delta" style="color:${kpis.ticket_dir === 'up' ? '#34d399' : '#f87171'}">
            ${arrowSvg(kpis.ticket_dir)} ${kpis.ticket_delta > 0 ? '+' : ''}${kpis.ticket_delta}% vs sem. ant.
          </div>
        </div>
        ${newCustBlock}
      </div>
    </div>

    <!-- ② Performance -->
    <div class="section-label">② Performance · Faturamento Diário</div>
    <div class="panel">
      <div class="panel-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
        Faturamento por Dia · Seg–Sab
      </div>
      <div class="bar-chart">${barItems}</div>
      ${revenueNarrBlock}
    </div>

    <!-- ③ Heatmap (se houver dados) -->
    ${heatmapPanel}

    <!-- Top produtos + Pagamentos -->
    <div class="split">
      <div class="panel">
        <div class="panel-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
          Top Produtos
        </div>
        <div class="prod-list">${prodItems}</div>
      </div>
      <div class="panel">
        <div class="panel-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
          Pagamentos
        </div>
        <div class="pay-list">${payItems}</div>
      </div>
    </div>

    <!-- Prioridades -->
    <div class="section-label">${secPriLabel} Prioridades da Semana</div>
    <div class="priorities-card">
      <div class="priorities-header">
        <div class="priorities-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        </div>
        <div>
          <div class="priorities-title">Suas prioridades</div>
          <div class="priorities-sub">Ações de maior impacto para esta semana</div>
        </div>
      </div>
      <div class="pri-list">${priItems}</div>
      ${wowBlock}
    </div>

    <!-- Footer -->
    <footer class="footer">
      <div>
        <span style="font-family:'Sora',sans-serif;font-size:14px;color:#a78bfa;letter-spacing:-0.3px;">Aura.</span>
        &nbsp;<em>Tecnologia para Negócios</em>
      </div>
      <div><em>Gerado automaticamente · ${fmtDateBR(new Date(Date.now() - 3 * 3600000))}</em></div>
    </footer>

  </div>
</body>
</html>`;
}

module.exports = { buildWeeklyReportHtml };
