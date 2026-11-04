// ============================================================
// AURA. — Template do e-mail de fechamento do mês (03/11/2026)
//
// Mockup: aura-app docs/mockups/relatorio-vendas-por-numeracao.html, tela 6.
// Assunto "Fechamento de Outubro de 2026: 412 pares · R$ 48.930,00".
// Corpo: os 5 modelos que mais venderam (tipo, quantidade, giro), a
// numeração campeã, quanto comprar para repor e o aviso da planilha anexa.
// Mesmo modelo dos outros e-mails (services/emailLayout.js) e as peças do
// relatório semanal (templates/relatorioSemanalBlocos.js).
// ============================================================
'use strict';

const L = require('../services/emailLayout');
const B = require('./relatorioSemanalBlocos');
const { linkDescadastro, linkAjustarEmails, cabecalhosDescadastro } = require('../services/emailLinks');

const { COR, esc } = L;
const MODELOS_NO_EMAIL = 5;

function rotuloUnidade(unidade, n) {
  if (unidade === 'pares') return n === 1 ? 'par' : 'pares';
  if (unidade === 'itens') return n === 1 ? 'item' : 'itens';
  return n === 1 ? 'peça' : 'peças';
}

function tabelaTop(rel) {
  const th = (t, a = 'left') => `<th class="a-ink2 a-line" align="${a}" style="padding:6px 6px 6px 0;border-bottom:1px solid ${COR.linha};color:${COR.tinta2};font-size:11px;text-transform:uppercase;letter-spacing:.04em;text-align:${a};font-weight:700;">${t}</th>`;
  const td = (t, a = 'left', forte = false, borda = true) => `<td class="${forte ? 'a-ink' : 'a-ink2'} a-line" align="${a}" style="padding:7px 6px 7px 0;${borda ? `border-bottom:1px solid ${COR.linha};` : ''}color:${forte ? COR.tinta : COR.tinta2};font-size:13px;${forte ? 'font-weight:700;' : ''}text-align:${a};">${t}</td>`;
  const top = rel.modelos.slice(0, MODELOS_NO_EMAIL);
  const linhas = top.map((m, i) => {
    const b = i < top.length - 1;
    return `<tr>${td(esc(m.nome), 'left', true, b)}${td(esc(m.tipo), 'left', false, b)}${td(B.qtd(m.vendidos), 'right', true, b)}${td(m.giro_pct == null ? '—' : `${m.giro_pct}%`, 'right', false, b)}</tr>`;
  }).join('');
  const un = rel.unidade === 'pares' ? 'Pares' : rel.unidade === 'itens' ? 'Itens' : 'Peças';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px;border-collapse:collapse;">` +
    `<tr>${th('Modelo')}${th('Tipo')}${th(un, 'right')}${th('Giro', 'right')}</tr>${linhas}</table>`;
}

/**
 * @param {object} a
 * @param {object} a.rel        saída de vendasPorNumeracao, com `periodo`
 * @param {string} a.companyId  a primária (assina o descadastro)
 * @param {string} a.nome       nome da loja (ou "Loja (+2 unid.)")
 * @param {boolean} a.grupo
 */
function montarEmailDoFechamento({ rel, companyId, nome, grupo = false, env = process.env }) {
  const k = rel.kpis;
  const unidadeTxt = `${B.qtd(k.vendidos)} ${rotuloUnidade(rel.unidade, k.vendidos)}`;
  const titulo = `Fechamento de ${rel.periodo.rotulo.replace(/ de \d{4}$/, '').toLowerCase()}`;
  const assunto = `Fechamento de ${rel.periodo.rotulo}: ${unidadeTxt} · ${L.brl(k.receita)}`;
  const previa = k.campea
    ? `Numeração campeã: ${k.campea.numeracao}. A planilha do mês vai anexa.`
    : 'Os modelos que mais venderam e a planilha do mês anexa.';

  const repor = rel.totais && rel.totais.repor > 0
    ? ` Para repor o mês: <b>${B.qtd(rel.totais.repor)} ${rotuloUnidade(rel.unidade, rel.totais.repor)}</b> em ${B.plural(rel.modelos.filter((m) => m.repor > 0).length, 'modelo', 'modelos')}.`
    : '';
  const campea = k.campea
    ? `Numeração campeã: <b>${esc(k.campea.numeracao)}</b> (${B.qtd(k.campea.vendidos)} ${rotuloUnidade(rel.unidade, k.campea.vendidos)}, ${k.campea.pct}%).`
    : '';
  const variacao = k.variacao_pct == null ? ''
    : k.variacao_pct === 0 ? ' Igual ao mês anterior.'
      : ` ${k.variacao_pct > 0 ? '+' : ''}${k.variacao_pct}% em relação ao mês anterior.`;

  const arquivo = `vendas-por-numeracao-${rel.periodo.inicio.slice(0, 7)}.xlsx`;
  const anexo = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 4px;border:1px solid ${COR.linha};border-radius:10px;width:100%;"><tr>` +
    `<td style="padding:10px 12px;width:34px;"><div style="width:34px;height:34px;border-radius:8px;background:#e8f5ee;color:#1d6f42;font-weight:800;font-size:12px;line-height:34px;text-align:center;">XLS</div></td>` +
    `<td class="a-ink" style="padding:10px 12px 10px 0;color:${COR.tinta};font-size:13px;"><b>${esc(arquivo)}</b><br><span class="a-ink2" style="color:${COR.tinta2};font-size:11.5px;">modelo · tipo · cor · numeração · vendidos · receita · estoque · giro · comprar p/ repor</span></td>` +
    `</tr></table>`;

  const corpo = [
    `<h1 class="a-ink" style="margin:0 0 4px;font-size:24px;line-height:1.2;font-weight:700;color:${COR.tinta};">${esc(titulo.charAt(0).toUpperCase() + titulo.slice(1))}</h1>`,
    `<p class="a-ink2" style="margin:0 0 16px;color:${COR.tinta2};font-size:13.5px;">${esc(nome)} · ${esc(unidadeTxt)} · ${esc(L.brl(k.receita))}.${esc(variacao)}</p>`,
    B.sub(`Os ${Math.min(MODELOS_NO_EMAIL, rel.modelos.length)} modelos que mais venderam`),
    tabelaTop(rel),
    campea || repor ? B.frase(`${campea}${repor}`) : '',
    B.sub('A planilha do mês'),
    B.miuda('Vai anexa: uma linha por modelo e numeração. Abre no Excel e no Google Planilhas.'),
    anexo,
  ].join('\n');

  const descadastro = linkDescadastro(companyId, 'fechamento_mes', { grupo }, env);
  const ajustar = linkAjustarEmails(companyId, env);
  const url = B.linkDoApp('/financeiro/vendas-por-numeracao?period=last_month', companyId, env);
  const rodape = 'Você recebe o fechamento no dia 1º de cada mês.' +
    (ajustar ? ` <a class="a-link" href="${esc(ajustar)}" style="color:${COR.violeta};">Ajustar meus e-mails</a>` : '') +
    (descadastro ? ` · <a class="a-link" href="${esc(descadastro)}" style="color:${COR.violeta};">Parar de receber</a>` : '') +
    ' · Aura. Tecnologia para negócios';

  const html = L.montarEmail({
    variante: 'aura-transacional',
    assunto,
    previa,
    corpo,
    botao: { rotulo: 'Abrir no app', url },
    assinatura: false,
    rodape,
  });
  const text = `Aura. — ${assunto}.\n` +
    rel.modelos.slice(0, MODELOS_NO_EMAIL).map((m) => `- ${m.nome}: ${m.vendidos}`).join('\n') +
    `\n\nA planilha do mês vai anexa (${arquivo}).\nAbrir no app: ${url}` +
    (ajustar ? `\n\nAjustar meus e-mails: ${ajustar}` : '') +
    (descadastro ? `\n\nParar de receber: ${descadastro}` : '');

  return { assunto, previa, html, text, cabecalhos: cabecalhosDescadastro(descadastro) };
}

module.exports = { montarEmailDoFechamento, rotuloUnidade };
