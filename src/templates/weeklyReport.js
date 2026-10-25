// ============================================================
// AURA. — Relatório semanal: página completa (tq-85, 24/10/2026)
//
// Função pura: dados -> HTML completo. Modo claro do layout novo (o mesmo
// emailLayout dos e-mails: paleta da Nina, logo por URL fixa, escuro só por
// prefers-color-scheme), com TODOS os blocos ligados da empresa no modo
// 'pagina' de templates/relatorioSemanalBlocos.
//
// Onde aparece:
//   GET /api/v1/reports/weekly/:token/pagina   (link público do e-mail)
//   GET /admin/reports/preview/:company_id     (equipe Aura)
//
// Substitui o painel escuro antigo (glassmorphism, "saúde do negócio" fixa
// em 71, mapa de calor), que só aparecia na prévia da equipe: o e-mail
// nunca usou este HTML e a página do app monta a tela a partir do JSON.
// ============================================================
'use strict';

const L = require('../services/emailLayout');
const B = require('./relatorioSemanalBlocos');

const { COR, esc, brl } = L;
const FONTE = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function hojeBR(now = Date.now()) {
  return L.dataLonga(new Date(now - 3 * 3600000).toISOString().slice(0, 10));
}

function unidades(breakdown, env) {
  if (!Array.isArray(breakdown) || breakdown.length < 2) return '';
  const linhas = breakdown.map((u) => [
    `${esc(u.company_name)} <a class="a-link" href="${esc(B.linkDoApp('/vendas', u.company_id, env))}" style="color:${COR.violeta};font-size:12px;text-decoration:none;">abrir &rarr;</a>`,
    `${esc(brl(u.revenue))} · ${String(Math.round(u.sales || 0))} vendas`,
  ]);
  return B.caixaDoBloco(B.sub('Por unidade') + B.tabelaSimples(linhas));
}

/**
 * @param {object} d
 * @param {{name, logo_url?}} d.company
 * @param {string} d.companyId           empresa dos links (primária no consolidado)
 * @param {{inicio, fim}} d.periodo      AAAA-MM-DD (fim inclusivo)
 * @param {object} d.relatorio           blocos (relatorioBlocos)
 * @param {Array}  [d.breakdown]         consolidado: uma linha por unidade
 * @param {object} [d.env]
 * @param {number} [d.now]
 */
function buildWeeklyReportHtml(d) {
  const env = d.env || process.env;
  const nome = (d.company && d.company.name) || 'sua loja';
  const periodo = d.periodo || {};
  const blocos = B.renderBlocos(d.relatorio, { modo: 'pagina', companyId: d.companyId, env });
  const vazio = !blocos.trim()
    ? B.caixaDoBloco(B.frase('Não há dados para mostrar nesta semana.'))
    : '';
  const painel = B.linkDoApp('/', d.companyId, env);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>Sua semana · ${esc(nome)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; }
  @media (prefers-color-scheme: dark) {
    .a-bg { background: #0c0a16 !important; }
    .a-card { background: #15122a !important; border-color: #2b2650 !important; }
    .a-ink { color: #ece9ff !important; }
    .a-ink2 { color: #b3add8 !important; }
    .a-line { border-color: #2b2650 !important; }
    .a-soft { background: #1d1938 !important; border-color: #2b2650 !important; }
    .a-btn { background: #a78bfa !important; color: #14102b !important; }
    .a-link { color: #a78bfa !important; }
    .a-bar { background: #3b3270 !important; }
  }
</style>
</head>
<body class="a-bg" style="margin:0;padding:0;background:${COR.fundo};font-family:${FONTE};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="a-bg" style="background:${COR.fundo};">
  <tr><td align="center" style="padding:24px 12px 48px;">
    <table role="presentation" width="680" cellpadding="0" cellspacing="0" class="a-card" style="max-width:680px;width:100%;background:${COR.cartao};border:1px solid ${COR.linha};border-radius:14px;">
      <tr><td class="a-line" style="padding:14px 22px;border-bottom:1px solid ${COR.linha};font-family:${FONTE};">
        <img src="${L.LOGO_AURA_URL}" width="28" height="28" alt="Aura" style="display:inline-block;width:28px;height:28px;vertical-align:middle;border:0;margin-right:9px;">
        <span class="a-ink" style="font-weight:700;font-size:16px;letter-spacing:-.2px;color:${COR.tinta};vertical-align:middle;">Aura.</span>
        <span class="a-ink2" style="font-size:12px;color:${COR.tinta2};vertical-align:middle;margin-left:6px;">Relatório da semana</span>
      </td></tr>
      <tr><td style="padding:22px;font-family:${FONTE};">
        <h1 class="a-ink" style="margin:0 0 4px;font-size:26px;line-height:1.2;font-weight:700;color:${COR.tinta};">Sua semana na ${esc(nome)}</h1>
        <p class="a-ink2" style="margin:0 0 18px;color:${COR.tinta2};font-size:14px;">De ${esc(L.dataCurta(periodo.inicio))} a ${esc(L.dataCurta(periodo.fim))}.</p>
        ${unidades(d.breakdown, env)}${blocos}${vazio}
        <div style="margin:10px 0 0;"><a class="a-btn" href="${esc(painel)}" style="display:inline-block;background:${COR.violeta};color:#ffffff;font-weight:700;font-size:14px;text-decoration:none;padding:11px 18px;border-radius:10px;">Abrir meu Painel</a></div>
      </td></tr>
      <tr><td class="a-line a-ink2" style="padding:12px 22px;border-top:1px solid ${COR.linha};color:${COR.tinta2};font-size:11.5px;line-height:1.6;font-family:${FONTE};">
        Gerado pela Aura em ${esc(hojeBR(d.now))}. Os links abrem o app na empresa certa. · Aura. Tecnologia para negócios
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

module.exports = { buildWeeklyReportHtml };
