// ============================================================================
// AURA. — Comprovante da venda condicional (C8, 25/11/2026)
//
// Duas folhas do mesmo documento: bobina de 80 mm e A4 (o formato vem de
// `@page`, como no cupom). Os textos sao os do mockup aprovado em 25/11.
//
// Regras (R13):
//   - loja, numero C-nnnn, cliente (nome e telefone), retirada e devolucao,
//     vendedora, pecas (nome, cor, tamanho, preco DA RETIRADA), total e
//     linha de assinatura da cliente;
//   - o quadro "Combinado da loja" so existe quando a condicional tem termos
//     (copia dos termos da loja no dia em que foi guardada). Sem texto, nada;
//   - rodape fixo: nao e documento fiscal;
//   - "atualizado" quando houve peca acrescentada depois da retirada
//     (evento peca_acrescentada).
// Nenhum recurso remoto: o comprovante e texto puro.
// ============================================================================
'use strict';

const { nomeDaLoja } = require('./nomeDaLoja');
const { autoPrintScript } = require('./autoPrintScript');

const TZ = 'America/Sao_Paulo';
const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const DIAS_CURTOS = ['DOM.', 'SEG.', 'TER.', 'QUA.', 'QUI.', 'SEX.', 'SÁB.'];

const TEXTO_NADA_PAGO_A4 = 'Nada foi pago na retirada. A cliente paga só as peças com que ficar.';
const TEXTO_NADA_PAGO_80 = 'Nada foi pago na retirada.';
const RODAPE_A4 = 'Não é documento fiscal · não é comprovante de venda';
const RODAPE_80 = 'NÃO É DOCUMENTO FISCAL';

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function brl(n) {
  const v = Number(n) || 0;
  return v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function formatPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return String(v || '');
}

function formatCnpj(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length === 14) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  if (d.length === 11) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  return String(v || '');
}

// Instante (timestamptz) -> dia 'YYYY-MM-DD' em Sao Paulo; string de data passa.
function ymdDe(v) {
  if (!v) return '';
  if (v instanceof Date) return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(v);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s.slice(0, 10)) && s.length === 10) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s.slice(0, 10) : new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
}

function partes(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m) return null;
  const dia = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return { a: m[1], m: m[2], d: m[3], dia };
}

/** 'quarta, 25/11/2026' */
function dataComDia(v) {
  const p = partes(ymdDe(v));
  return p ? `${DIAS[p.dia]}, ${p.d}/${p.m}/${p.a}` : '';
}

/** 'SÁB., 28/11/2026' */
function dataComDiaCurto(v) {
  const p = partes(ymdDe(v));
  return p ? `${DIAS_CURTOS[p.dia]}, ${p.d}/${p.m}/${p.a}` : '';
}

/** '25/11/2026, 10:42' (A4) ou '25/11/2026 10:42' (bobina) */
function dataEHora(v, sep) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const f = new Intl.DateTimeFormat('pt-BR', {
    timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  return `${f.day}/${f.month}/${f.year}${sep}${f.hour}:${f.minute}`;
}

/** Houve peca acrescentada depois da retirada? */
function foiAtualizada(cond) {
  return Array.isArray(cond && cond.events) && cond.events.some((e) => e && e.tipo === 'peca_acrescentada');
}

function termosDe(cond) {
  const t = cond && typeof cond.terms === 'string' ? cond.terms.trim() : '';
  return t || null;
}

function detalheDaPeca(i) {
  const cor = i.color_name || null;
  const tam = i.size_label || null;
  if (cor || tam) return { cor, tam, linha: [cor, tam].filter(Boolean).join(' · ') };
  return { cor: null, tam: null, linha: i.variant_label || '' };
}

function voltou(i) {
  return !!i && (i.situacao === 'voltou' || i.situacao === 'voltou_defeito');
}

// Peca devolvida fica na lista (riscada) mas fora da soma e da contagem.
function totalDasPecas(cond) {
  const itens = (cond.items || []).filter((i) => !voltou(i));
  const cents = itens.reduce((s, i) => s + Math.round((Number(i.unit_price) || 0) * 100), 0);
  return { n: itens.length, valor: cents / 100 };
}

/** 'Voltou em 27/11' (decided_at, fuso SP) */
function voltouEm(i) {
  const p = partes(ymdDe(i.decided_at));
  return p ? `Voltou em ${p.d}/${p.m}` : 'Voltou';
}

function enderecoDaLoja(company) {
  const rua = company.address_street
    ? `${company.address_street}${company.address_number ? ', ' + company.address_number : ''}` : '';
  const cidade = company.address_city
    ? `${company.address_city}${company.address_state ? ' - ' + company.address_state : ''}` : '';
  return [rua, cidade].filter(Boolean).join(' · ');
}

function folhaA4(cond, company) {
  const { n, valor } = totalDasPecas(cond);
  const termos = termosDe(cond);
  const contato = [enderecoDaLoja(company), company.phone].filter(Boolean).join(' · ');
  const linhas = (cond.items || []).map((i) => {
    const d = detalheDaPeca(i);
    const v = voltou(i);
    return `<tr${v ? ' class="vt"' : ''}><td>${esc(i.product_name)}${v ? `<small>${esc(voltouEm(i))}</small>` : ''}</td>`
      + `<td class="cv">${esc(d.cor || (d.linha || '—'))}</td><td class="cv">${esc(d.tam || '—')}</td>`
      + `<td class="rt">R$ ${brl(i.unit_price)}</td></tr>`;
  }).join('');
  const titulo = foiAtualizada(cond) ? 'Comprovante de condicional (atualizado)' : 'Comprovante de condicional';
  return `<div class="ph"><div><h2>${esc(nomeDaLoja(company))}</h2>`
    + `${company.cnpj ? `<div>CNPJ ${esc(formatCnpj(company.cnpj))}</div>` : ''}`
    + `${contato ? `<div>${esc(contato)}</div>` : ''}</div>`
    + `<div class="r"><div class="nr">${esc(cond.numero_exibicao)}</div><div>${esc(dataEHora(cond.created_at, ', '))}</div></div></div>
  <div class="ttl">${titulo}</div>
  <div class="kv"><div><span>Cliente</span><b>${esc(cond.customer_name)}</b></div>`
    + `<div><span>Telefone</span><b>${esc(formatPhone(cond.customer_phone))}</b></div>`
    + `<div><span>Retirada</span><b>${esc(dataComDia(cond.created_at))}</b></div>`
    + `<div><span>Vendedora</span><b>${esc(cond.seller_name || '—')}</b></div>`
    + `<div class="hl"><span>Devolver até</span><b>${esc(dataComDia(cond.due_date))}</b></div></div>
  <table><thead><tr><th>Peça</th><th class="cv">Cor</th><th class="cv">Tam.</th><th class="rt">Preço</th></tr></thead><tbody>${linhas}</tbody></table>
  <div class="tot"><span>Total das peças (${n})</span><span>R$ ${brl(valor)}</span></div>
  <div>${TEXTO_NADA_PAGO_A4}</div>
  ${termos ? `<div class="tm"><b>Combinado da loja</b><div>${esc(termos)}</div></div>` : ''}
  <div class="sig"><div>Assinatura da cliente</div><div>${esc(nomeDaLoja(company))}${cond.seller_name ? ` · ${esc(cond.seller_name)}` : ''}</div></div>
  <div class="ft">${RODAPE_A4}</div>`;
}

function folhaBobina(cond, company) {
  const { n, valor } = totalDasPecas(cond);
  const termos = termosDe(cond);
  const linhas = (cond.items || []).map((i) => {
    const d = detalheDaPeca(i);
    const v = voltou(i);
    return `<div class="ln${v ? ' vt' : ''}"><span>${esc(i.product_name)}</span><span>${brl(i.unit_price)}</span></div>`
      + (d.linha ? `<div${v ? ' class="vt"' : ''}>&nbsp;&nbsp;${esc(d.linha)}</div>` : '')
      + (v ? `<div>&nbsp;&nbsp;${esc(voltouEm(i))}</div>` : '');
  }).join('');
  const titulo = foiAtualizada(cond) ? 'COMPROVANTE DE CONDICIONAL (ATUALIZADO)' : 'COMPROVANTE DE CONDICIONAL';
  return `<div class="c bb">${esc(String(nomeDaLoja(company)).toUpperCase())}</div>`
    + `${company.cnpj ? `<div class="c">CNPJ ${esc(formatCnpj(company.cnpj))}</div>` : ''}`
    + `${company.phone ? `<div class="c">${esc(company.phone)}</div>` : ''}
  <hr><div class="c bb">${titulo}</div><div class="c">${esc(cond.numero_exibicao)} · ${esc(dataEHora(cond.created_at, ' '))}</div><hr>
  <div>Cliente: ${esc(cond.customer_name)}</div>`
    + `${cond.customer_phone ? `<div>Tel.: ${esc(formatPhone(cond.customer_phone))}</div>` : ''}`
    + `${cond.seller_name ? `<div>Vendedora: ${esc(cond.seller_name)}</div>` : ''}
  <div class="box">DEVOLVER ATÉ ${esc(dataComDiaCurto(cond.due_date))}</div><hr>
  ${linhas}<hr><div class="ln bb"><span>TOTAL DAS PEÇAS (${n})</span><span>${brl(valor)}</span></div><div>${TEXTO_NADA_PAGO_80}</div>
  ${termos ? `<hr><div>${esc(termos)}</div>` : ''}<div class="sg">Assinatura da cliente</div><hr><div class="c">${RODAPE_80}</div>`;
}

const CSS_A4 = `
    @page { margin: 12mm; size: A4; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #111; max-width: 186mm; margin: 0 auto; }
    .ph { display: flex; justify-content: space-between; gap: 12px; border-bottom: 2px solid #111; padding-bottom: 8px; }
    .ph h2 { font-size: 18px; margin-bottom: 2px; }
    .ph .r { text-align: right; }
    .ph .nr { font-size: 20px; font-weight: bold; }
    .ttl { font-size: 15px; font-weight: bold; margin: 12px 0 8px; text-transform: uppercase; letter-spacing: .04em; }
    .kv { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; margin-bottom: 10px; }
    .kv span { display: block; font-size: 10px; color: #555; text-transform: uppercase; }
    .kv .hl { grid-column: 1 / -1; border: 2px solid #111; padding: 6px 8px; font-size: 14px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
    th { text-align: left; font-size: 10px; text-transform: uppercase; border-bottom: 1px solid #111; padding: 4px 0; }
    td { padding: 5px 0; border-bottom: 1px solid #ddd; vertical-align: top; }
    .rt { text-align: right; } .cv { text-align: left; }
    tr.vt td { text-decoration: line-through; color: #666; }
    tr.vt td small { display: block; text-decoration: none; font-size: 10px; }
    .tot { display: flex; justify-content: space-between; font-size: 14px; font-weight: bold; padding: 6px 0; border-bottom: 2px solid #111; margin-bottom: 8px; }
    .tm { border: 1px solid #111; padding: 8px; margin: 10px 0; font-size: 11px; }
    .tm b { display: block; margin-bottom: 4px; }
    .sig { display: flex; justify-content: space-between; gap: 24px; margin-top: 44px; }
    .sig div { flex: 1; border-top: 1px solid #111; padding-top: 4px; font-size: 11px; }
    .ft { margin-top: 18px; text-align: center; font-size: 10px; color: #555; }`;

const CSS_80 = `
    @page { margin: 4mm 5mm; size: 80mm auto; }
    body { font-family: Consolas, 'Lucida Console', Menlo, 'Courier New', monospace; font-size: 11px; width: 72mm; color: #000; }
    .c { text-align: center; } .bb { font-weight: bold; }
    hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; }
    .ln { display: flex; justify-content: space-between; gap: 6px; }
    .vt { text-decoration: line-through; }
    .box { border: 2px solid #000; text-align: center; font-weight: bold; padding: 3px; margin: 4px 0; }
    .sg { margin-top: 28px; border-top: 1px solid #000; padding-top: 2px; text-align: center; }`;

/**
 * @param {object} cond   detalhe de lerCondicionalCompleta (items, events, terms...)
 * @param {object} company { legal_name, trade_name, cnpj, phone, address_* }
 * @param {{ format?: '80'|'a4', autoprint?: boolean }} [opts]
 */
function buildCondicionalHtml(cond, company, opts = {}) {
  const a4 = opts.format === 'a4';
  const loja = nomeDaLoja(company);
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Condicional ${esc(cond.numero_exibicao)} - ${esc(loja)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }${a4 ? CSS_A4 : CSS_80}
    @media print { body { -webkit-print-color-adjust: exact; } button { display: none; } }
  </style>
</head>
<body>
  ${a4 ? folhaA4(cond, company) : folhaBobina(cond, company)}
  <br><button onclick="window.print()" style="width:100%;padding:8px;margin-top:8px;cursor:pointer">Imprimir</button>
  ${opts.autoprint ? autoPrintScript() : ''}
</body>
</html>`;
}

module.exports = { buildCondicionalHtml, foiAtualizada };
