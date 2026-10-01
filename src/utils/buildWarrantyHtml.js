// ============================================================================
// AURA. — Gerador HTML do Certificado de Garantia (A4)
//
// Documento da LOJA com assinatura visual da Aura: a marca do lojista
// (logo + cor) manda no cabecalho e nos destaques; a Aura aparece no selo do
// QR e numa linha discreta no rodape.
//
// Uso:
//   res.type('html').send(buildWarrantyHtml({ warranty, items, company, brand }));
//
// Mesma regra de largura da OS (buildServiceOrderHtml): `.page` tem 182mm na
// tela e no papel (A4 menos margens de 14mm), e o @media print so tira sombra
// e toolbar. Nenhum recurso remoto: o QR e SVG inline (qrInline) e a fonte e
// a do sistema, entao imprimir nunca depende de rede.
//
// QR: carrega `aura://garantia/<code>`-equivalente em URL https
// (getaura.com.br/g/<code>) — o app le o codigo no fim do caminho e valida
// logado; abrir a URL fora do app nao revela nada.
// ============================================================================

const { autoPrintScript } = require('./autoPrintScript');
const { qrInlineSvg } = require('./qrInline');
const { DEFAULT_WARRANTY_TERMS } = require('./warrantyTerms');

const TZ = 'America/Sao_Paulo';
const QR_BASE = 'https://getaura.com.br/g/';

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatBRL(n) {
  const v = Number(n) || 0;
  return v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function formatCnpj(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length === 14) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  if (d.length === 11) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  return String(v || '');
}

function formatPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return String(v || '');
}

// 'YYYY-MM-DD' (coluna DATE ou string) → 'DD/MM/AAAA'. Sem passar por Date:
// DATE nao tem fuso, e new Date('2026-09-30') viraria 29/09 as 21h em SP.
function formatDateOnly(v) {
  if (!v) return '';
  if (v instanceof Date) {
    // pg devolve DATE como Date à meia-noite LOCAL do processo.
    const p = (n) => String(n).padStart(2, '0');
    return `${p(v.getDate())}/${p(v.getMonth() + 1)}/${v.getFullYear()}`;
  }
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

function formatDateTimeBR(dt) {
  if (!dt) return '';
  const d = dt instanceof Date ? dt : new Date(dt);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('pt-BR', {
    timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).replace(',', ' ·');
}

function getInitials(name) {
  const w = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  return (w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[1][0]).toUpperCase();
}

// "365 dias" → "1 ano"; "180" → "6 meses"; "90" → "3 meses"; "45" → "45 dias".
function prazoLabel(days) {
  const d = Number(days) || 0;
  if (d >= 365 && d % 365 === 0) { const a = d / 365; return `${a} ${a === 1 ? 'ano' : 'anos'}`; }
  if (d >= 30 && d % 30 === 0) { const m = d / 30; return `${m} ${m === 1 ? 'mês' : 'meses'}`; }
  return `${d} ${d === 1 ? 'dia' : 'dias'}`;
}

function numeroLabel(n) {
  return String(Number(n) || 0).padStart(6, '0');
}

// Termos em blocos: "## titulo", "- item" e paragrafos.
function termosHtml(text) {
  const lines = String(text || DEFAULT_WARRANTY_TERMS).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let h = '';
  let emLista = false;
  const fechaLista = () => { if (emLista) { h += '</ul>'; emLista = false; } };
  for (const l of lines) {
    if (l.startsWith('## ')) {
      fechaLista();
      h += `<h4>${esc(l.slice(3))}</h4>`;
    } else if (l.startsWith('- ')) {
      if (!emLista) { h += '<ul>'; emLista = true; }
      h += `<li>${esc(l.slice(2))}</li>`;
    } else {
      fechaLista();
      h += `<p>${esc(l)}</p>`;
    }
  }
  fechaLista();
  return h;
}

function buildWarrantyHtml({ warranty, items = [], company, brand = {}, autoprint = false }) {
  if (!warranty) throw new Error('warranty obrigatório');
  if (!company) throw new Error('company obrigatório');

  // Armadilha #2 do CLAUDE.md: companies nao tem coluna `name`.
  const empresaNome = company.trade_name || company.legal_name || 'Empresa';
  const logoUrl = brand.logo_url || company.logo_url || null;
  const cor = /^#[0-9a-fA-F]{3,8}$/.test(String(brand.primary_color || '')) ? brand.primary_color : '#5b21b6';

  const enderecoLinha = [
    [company.address_street, company.address_number].filter(Boolean).join(', '),
    company.address_district,
    [company.address_city, company.address_state].filter(Boolean).join(' / '),
    company.address_zip ? `CEP ${company.address_zip}` : '',
  ].filter(Boolean).join(' · ');
  const contatoLinha = [
    company.phone ? formatPhone(company.phone) : '',
    brand.whatsapp ? formatPhone(brand.whatsapp) : '',
  ].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · ');

  const numero = numeroLabel(warranty.warranty_number);
  const qr = qrInlineSvg(QR_BASE + warranty.code, { size: '26mm', margin: 1, ecc: 'M' });
  const anulada = !!warranty.voided_at;

  const logoHtml = logoUrl
    ? `<img class="logo" src="${esc(logoUrl)}" alt="">`
    : `<div class="logo logo-fb">${esc(getInitials(empresaNome))}</div>`;

  // ── Itens: um cartao por produto, com a linha do tempo da vigencia ──
  const cards = items.map((it) => {
    const qtd = Number(it.quantity) || 1;
    return `<div class="item">
      <div class="item-main">
        <div class="item-nome">${esc(it.product_name)}${qtd !== 1 ? ` <span class="qtd">× ${esc(String(qtd).replace('.', ','))}</span>` : ''}</div>
        ${it.serial ? `<div class="item-serie"><span>IMEI / Série</span> ${esc(it.serial)}</div>` : ''}
        <div class="linha">
          <div class="ponto"><b>${esc(formatDateOnly(it.starts_on))}</b><span>início</span></div>
          <div class="barra"><i></i></div>
          <div class="ponto fim"><b>${esc(formatDateOnly(it.expires_on))}</b><span>vence</span></div>
        </div>
      </div>
      <div class="item-prazo">
        <div class="prazo-n">${esc(prazoLabel(it.days))}</div>
        <div class="prazo-r">de garantia</div>
      </div>
    </div>`;
  }).join('');

  const totalItens = items.reduce((s, i) => s + (Number(i.unit_price) || 0) * (Number(i.quantity) || 1), 0);
  const compraRef = warranty.sale_number != null
    ? `Venda nº ${warranty.sale_number}`
    : (warranty.sale_id ? `Venda ${String(warranty.sale_id).slice(-8).toUpperCase()}` : '');

  const css = `
@page{size:A4;margin:14mm}
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:#eceef3;color:#14121f;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;font-size:10pt;line-height:1.4}
:root{--cor:${cor};--ink:#14121f;--mut:#6b6880;--line:#e6e4ee}
.page{width:182mm;margin:0 auto;background:#fff;color:var(--ink);position:relative}
@media screen{body{padding:28px 0}.page{padding:14mm;box-shadow:0 8px 40px rgba(20,18,31,.18)}
.toolbar{position:fixed;top:0;left:0;right:0;background:#1a1a2e;color:#fff;padding:10px 20px;display:flex;align-items:center;justify-content:space-between;z-index:99}
.toolbar button{background:#7c3aed;color:#fff;border:0;padding:8px 18px;border-radius:6px;font-weight:700;cursor:pointer}
.toolbar span{font-size:12px;color:#a78bfa}}
@media print{body{background:#fff}.page{box-shadow:none;padding:0}.toolbar{display:none!important}
body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}

/* faixa de marca */
.faixa{height:3mm;background:var(--cor);border-radius:1.5mm 1.5mm 0 0;position:relative;overflow:hidden}
.faixa::after{content:"";position:absolute;right:-6mm;top:-8mm;width:40mm;height:16mm;background:rgba(255,255,255,.18);transform:skewX(-30deg)}

/* cabecalho */
.hd{display:flex;align-items:center;gap:5mm;padding:4mm 0 3mm}
.logo{flex:0 0 auto;width:20mm;height:20mm;object-fit:contain;border-radius:3mm;border:.6pt solid var(--line);background:#fff}
.logo-fb{display:flex;align-items:center;justify-content:center;border:none;background:var(--cor);color:#fff;font-size:15pt;font-weight:800}
.hd-info{flex:1;min-width:0}
.hd-nome{font-size:14pt;font-weight:800;line-height:1.15;color:var(--ink)}
.hd-sub{font-size:8pt;color:var(--mut);line-height:1.45;margin-top:.8mm}
.hd-num{flex:0 0 auto;text-align:right}
.hd-num .rot{font-size:7pt;letter-spacing:1.2pt;text-transform:uppercase;color:var(--mut)}
.hd-num .num{font-size:15pt;font-weight:800;letter-spacing:.5pt;color:var(--cor);font-variant-numeric:tabular-nums}
.hd-num .dt{font-size:8pt;color:var(--mut);margin-top:.5mm}

/* heroi */
.hero{display:flex;align-items:stretch;gap:6mm;border-radius:4mm;padding:5mm 6mm;margin-top:1mm;color:#fff;
  background:linear-gradient(135deg,var(--cor) 0%,#1b1033 135%);position:relative;overflow:hidden}
.hero::before{content:"";position:absolute;right:-14mm;bottom:-22mm;width:70mm;height:70mm;border-radius:50%;border:5mm solid rgba(255,255,255,.07)}
.hero::after{content:"";position:absolute;right:6mm;bottom:-30mm;width:54mm;height:54mm;border-radius:50%;border:3mm solid rgba(255,255,255,.06)}
.hero-t{flex:1;min-width:0;position:relative;z-index:1}
.hero-k{font-size:7.5pt;letter-spacing:2pt;text-transform:uppercase;opacity:.75}
.hero-h{font-size:20pt;font-weight:800;line-height:1.05;margin:1mm 0 2mm;letter-spacing:-.4pt}
.hero-p{font-size:9pt;opacity:.88;max-width:98mm}
.hero-q{flex:0 0 auto;position:relative;z-index:1;background:#fff;color:var(--ink);border-radius:3mm;padding:2.5mm 2.5mm 2mm;text-align:center;align-self:center}
.hero-q svg{display:block;width:26mm;height:26mm}
.hero-q .q1{font-size:6.5pt;font-weight:800;letter-spacing:1pt;text-transform:uppercase;margin-top:1.2mm;color:var(--cor)}
.hero-q .q2{font-size:8pt;font-weight:700;letter-spacing:1.5pt;font-variant-numeric:tabular-nums;margin-top:.3mm}

/* itens */
.sec{margin-top:4mm}
.sec-t{font-size:7.5pt;font-weight:800;letter-spacing:1.4pt;text-transform:uppercase;color:var(--mut);margin-bottom:2.5mm;display:flex;align-items:center;gap:3mm}
.sec-t::after{content:"";flex:1;height:.6pt;background:var(--line)}
.item{display:flex;gap:5mm;align-items:center;border:.8pt solid var(--line);border-left:1.6mm solid var(--cor);border-radius:3mm;padding:3mm 5mm;margin-bottom:2.5mm;break-inside:avoid}
.item-main{flex:1;min-width:0}
.item-nome{font-size:11.5pt;font-weight:800;line-height:1.25;overflow-wrap:anywhere}
.item-nome .qtd{font-weight:600;color:var(--mut)}
.item-serie{font-size:8.5pt;margin-top:1mm;font-variant-numeric:tabular-nums}
.item-serie span{font-size:6.5pt;font-weight:800;letter-spacing:1pt;text-transform:uppercase;color:var(--mut);margin-right:1.5mm}
.linha{display:flex;align-items:center;gap:3mm;margin-top:2.5mm}
.ponto{display:flex;flex-direction:column;font-size:8.5pt;line-height:1.2}
.ponto b{font-variant-numeric:tabular-nums}
.ponto span{font-size:6.5pt;letter-spacing:1pt;text-transform:uppercase;color:var(--mut)}
.ponto.fim{text-align:right}
.barra{flex:1;height:1.6mm;border-radius:99px;background:var(--line);position:relative}
.barra i{position:absolute;inset:0;border-radius:99px;background:var(--cor)}
.barra::before,.barra::after{content:"";position:absolute;top:50%;width:3.2mm;height:3.2mm;border-radius:50%;background:#fff;border:.9mm solid var(--cor);transform:translateY(-50%)}
.barra::before{left:-1mm}.barra::after{right:-1mm}
.item-prazo{flex:0 0 30mm;text-align:center;border-radius:3mm;background:color-mix(in srgb,var(--cor) 9%,#fff);padding:3.5mm 2mm}
.prazo-n{font-size:16pt;font-weight:800;line-height:1;color:var(--cor)}
.prazo-r{font-size:7pt;letter-spacing:1pt;text-transform:uppercase;color:var(--mut);margin-top:1.2mm}

/* partes */
.partes{display:flex;gap:4mm}
.parte{flex:1;min-width:0;border-radius:3mm;background:#f7f6fb;padding:3mm 5mm}
.parte .k{font-size:6.5pt;font-weight:800;letter-spacing:1.2pt;text-transform:uppercase;color:var(--mut)}
.parte .nome{font-size:11pt;font-weight:800;margin:.8mm 0 1.2mm;overflow-wrap:anywhere}
.parte .l{font-size:8.5pt;color:#3d3a52;display:flex;gap:2mm}
.parte .l em{font-style:normal;color:var(--mut);min-width:14mm}

/* termos */
.termos{column-count:2;column-gap:7mm;font-size:6.9pt;line-height:1.34;color:#3d3a52}
.termos h4{font-size:7.5pt;letter-spacing:1pt;text-transform:uppercase;color:var(--ink);margin:0 0 1.2mm;break-after:avoid}
.termos p{margin-bottom:1.6mm;text-align:justify}
.termos ul{margin:0 0 2.5mm 3.2mm}
.termos li{margin-bottom:1mm;text-align:justify}
.termos h4:not(:first-child){margin-top:2.5mm}

/* rodape */
.rodape{margin-top:5mm;padding-top:3mm;border-top:.6pt solid var(--line);display:flex;justify-content:space-between;align-items:center;font-size:7pt;color:var(--mut)}
.rodape b{color:var(--cor);letter-spacing:.3pt}
.valid{margin-top:4mm;font-size:7.5pt;color:var(--mut);text-align:center}

/* Impressao P/B: sem fundo escuro nem cor como informacao. A cor da marca
   vira preto; o heroi vira moldura; tudo continua legivel em laser mono/termica. */
@media print{
  :root{--cor:#000;--mut:#444;--line:#999}
  .faixa{background:#000}
  .faixa::after{display:none}
  .hero{background:#fff!important;color:#000;border:1.4pt solid #000}
  .hero::before,.hero::after{display:none}
  .hero-q{border:1pt solid #000}
  .logo-fb{background:#fff;color:#000;border:1.4pt solid #000}
  .item{border-color:#777;border-left:1.6mm solid #000}
  .item-prazo{background:#fff;border:1pt solid #000}
  .prazo-n{color:#000}
  .barra{background:#bbb}
  .barra i{background:#000}
  .barra::before,.barra::after{border-color:#000}
  .parte{background:#fff;border:.8pt solid #777}
  .hd-num .num,.rodape b,.hero-q .q1{color:#000}
}

/* anulada */
.anulada{position:absolute;top:80mm;left:0;right:0;text-align:center;font-size:54pt;font-weight:900;letter-spacing:6pt;color:rgba(190,18,60,.16);transform:rotate(-16deg);pointer-events:none}
`;

  let h = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">';
  h += '<meta name="viewport" content="width=device-width,initial-scale=1">';
  h += `<title>Garantia nº ${esc(numero)} — ${esc(empresaNome)}</title>`;
  h += `<style>${css}</style></head><body>`;
  h += '<div class="toolbar"><span>Certificado de garantia — confira e imprima</span>'
    + '<button onclick="window.print()">Imprimir</button></div>';
  h += '<div class="page">';
  if (anulada) h += '<div class="anulada">ANULADA</div>';

  h += '<div class="faixa"></div>';
  h += `<div class="hd">${logoHtml}<div class="hd-info">`
    + `<div class="hd-nome">${esc(empresaNome)}</div>`
    + `<div class="hd-sub">${company.cnpj ? `CNPJ ${esc(formatCnpj(company.cnpj))}` : ''}`
    + `${enderecoLinha ? `<br>${esc(enderecoLinha)}` : ''}`
    + `${contatoLinha ? `<br>${esc(contatoLinha)}` : ''}</div></div>`
    + `<div class="hd-num"><div class="rot">Garantia nº</div><div class="num">${esc(numero)}</div>`
    + `<div class="dt">${esc(formatDateTimeBR(warranty.created_at))}</div></div></div>`;

  h += '<div class="hero"><div class="hero-t">'
    + '<div class="hero-k">Certificado de garantia</div>'
    + `<div class="hero-h">${items.length > 1 ? 'Seus produtos estão protegidos.' : 'Seu produto está protegido.'}</div>`
    + '<div class="hero-p">Guarde este documento. Ele comprova a compra e o prazo de cobertura de cada item abaixo.</div></div>'
    + `<div class="hero-q">${qr}<div class="q1">Validar no app Aura</div><div class="q2">${esc(warranty.code)}</div></div></div>`;

  h += `<div class="sec"><div class="sec-t">${items.length > 1 ? 'Produtos cobertos' : 'Produto coberto'}</div>${cards}</div>`;

  h += '<div class="sec"><div class="partes">'
    + '<div class="parte"><div class="k">Cliente</div>'
    + `<div class="nome">${esc(warranty.customer_name)}</div>`
    + `<div class="l"><em>CPF</em>${esc(formatCnpj(warranty.customer_cpf) || '—')}</div>`
    + `<div class="l"><em>Telefone</em>${esc(formatPhone(warranty.customer_phone) || '—')}</div></div>`
    + '<div class="parte"><div class="k">Compra</div>'
    + `<div class="nome">${esc(compraRef || 'Garantia avulsa')}</div>`
    + `<div class="l"><em>Emissão</em>${esc(formatDateTimeBR(warranty.created_at))}</div>`
    + `${totalItens > 0 ? `<div class="l"><em>Valor</em>R$ ${formatBRL(totalItens)}</div>` : ''}</div>`
    + '</div></div>';

  h += `<div class="sec"><div class="sec-t">Termos</div><div class="termos">${termosHtml(warranty.terms_text)}</div></div>`;

  h += '<div class="rodape">'
    + `<span>${esc(empresaNome)} · Garantia nº ${esc(numero)}</span>`
    + '<span>emitido com <b>aura.</b> · getaura.com.br</span></div>';

  h += '</div>';
  if (autoprint) h += autoPrintScript({ delayMs: 350 });
  h += '</body></html>';
  return h;
}

module.exports = {
  buildWarrantyHtml,
  prazoLabel, formatDateOnly, numeroLabel, termosHtml,
};
