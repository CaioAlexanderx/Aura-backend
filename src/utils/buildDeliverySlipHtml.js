// ============================================================
// AURA. -- Papel de entrega da venda do Caixa (09/11/2026, parte 2)
//
// O papel que vai colado no pacote. Mockup aprovado pelo Caio em
// 09/11/2026 (secao G): "ENTREGA", numero e data da venda; nome e
// telefone de quem recebe em letra grande; endereco completo com CEP e
// referencia; recado; itens com quantidade e nome, SEM preco; "Pago ·
// forma" (ou "Crediário") e o valor do frete; telefone da loja;
// "Recebido por". Sem "valor a cobrar na entrega" (decisao 1 do mockup:
// no Caixa toda venda ja sai paga).
//
// Tres saidas:
//   - blocoDaBobina(): vai DEPOIS do cupom, separado por uma linha de
//     corte, quando o app pede /print/receipt/:id[/preview]?entrega=1.
//     comPapelDeEntrega() so ACRESCENTA: sem o parametro o cupom nao
//     passa por aqui e o HTML e o de sempre, byte a byte
//     (__tests__/papelDeEntrega.test.js).
//   - documentoDoPapel({ format: '80' | '58' }): o papel sozinho na bobina.
//   - documentoDoPapel({ format: 'a4' }): folha A4 com a marca da loja.
//
// Largura: na bobina nada tem largura fixa por dentro -- o bloco ocupa a
// largura do corpo (72 mm no cupom de 80 mm; 48 mm no papel de 58 mm),
// com quebra de palavra longa. Sem QZ Tray: e window.print() como o cupom.
// ============================================================
'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const t = (v) => (v === null || v === undefined ? '' : String(v).trim());

const NOME_DO_FRETE = 'frete';

const ROTULO_PAGAMENTO = {
  pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão', debito: 'Débito',
  credito: 'Crédito', fiado: 'Fiado', crediario: 'Crediário', outro: 'Outro',
};

function moeda(v) {
  const n = Math.round((parseFloat(v) || 0) * 100) / 100;
  return 'R$ ' + n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function quantidade(q) {
  const n = parseFloat(q);
  if (!Number.isFinite(n)) return '1';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000).replace('.', ',');
}

/** 11999998888 -> (11) 99999-8888. Outro formato fica como veio. */
function telefone(v) {
  const s = t(v);
  let d = s.replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return s;
}

function cep(v) {
  const d = t(v).replace(/\D/g, '');
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : t(v);
}

function dataDaVenda(createdAt) {
  const d = new Date(createdAt);
  if (isNaN(d.getTime())) return '';
  const tz = { timeZone: 'America/Sao_Paulo' };
  const dia = d.toLocaleDateString('pt-BR', { ...tz, day: '2-digit', month: '2-digit', year: 'numeric' });
  const hora = d.toLocaleTimeString('pt-BR', { ...tz, hour: '2-digit', minute: '2-digit' });
  return { dia, hora };
}

function numeroDaVenda(sale) {
  if (sale && sale.sale_number != null && sale.sale_number !== '') return String(sale.sale_number);
  return String(sale && sale.id ? sale.id : '').slice(-8).toUpperCase();
}

const ehFrete = (i) => !i.product_id && t(i.product_name || i.product_name_snapshot).toLowerCase() === NOME_DO_FRETE;

/**
 * Junta o que o papel mostra. `entrega` e o retrato (sales.delivery_address)
 * ou, para venda sem retrato, o cadastro do cliente.
 */
function dadosDoPapel({ company = {}, sale = {}, items = [], payments = [], entrega = {} }) {
  const itens = items.filter((i) => !ehFrete(i)).map((i) => ({
    qtd: quantidade(i.quantity),
    nome: t(i.product_name || i.product_name_snapshot) + (t(i.variant_label) ? ` (${t(i.variant_label)})` : ''),
  }));
  const frete = items.filter(ehFrete)
    .reduce((s, i) => s + (parseFloat(i.total_price != null ? i.total_price : (i.quantity * i.unit_price)) || 0), 0);

  // Pagamento: sale_payments guarda o que entrou no caixa; o crediario fica
  // de fora dele. O que faltar para o total foi para o crediario.
  const total = parseFloat(sale.total_amount) || 0;
  const pagos = (payments || []).filter((p) => (parseFloat(p.amount) || 0) > 0);
  const metodos = [];
  for (const p of pagos) {
    const m = String(p.method || '').toLowerCase();
    const r = ROTULO_PAGAMENTO[m] || t(p.method);
    if (r && !metodos.includes(r)) metodos.push(r);
  }
  const somaPaga = pagos.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const metodoDaVenda = String(sale.payment_method || '').toLowerCase();
  if (!pagos.length && metodoDaVenda && metodoDaVenda !== 'crediario') {
    metodos.push(ROTULO_PAGAMENTO[metodoDaVenda] || t(sale.payment_method));
  }
  const temCrediario = metodoDaVenda === 'crediario' || (pagos.length > 0 && somaPaga < total - 0.009);
  let pagamento;
  if (temCrediario && !metodos.filter((m) => m !== 'Crediário').length) pagamento = 'Crediário';
  else if (temCrediario) pagamento = metodos.filter((m) => m !== 'Crediário').join(' + ') + ' + Crediário';
  else pagamento = 'Pago · ' + (metodos.join(' + ') || 'Outro');

  const quando = dataDaVenda(sale.created_at) || { dia: '', hora: '' };
  const e = entrega || {};
  return {
    loja: t(company.trade_name) || t(company.legal_name),
    lojaTelefone: telefone(company.phone),
    lojaEndereco: [
      t(company.address_street) + (t(company.address_number) ? ', ' + t(company.address_number) : ''),
      t(company.address_city) + (t(company.address_state) ? '/' + t(company.address_state) : ''),
    ].filter(Boolean).join(' · '),
    numero: numeroDaVenda(sale),
    dia: quando.dia,
    hora: quando.hora,
    nome: t(e.name),
    telefone: telefone(e.phone),
    rua: t(e.street) + (t(e.number) ? ', ' + t(e.number) : ''),
    complemento: t(e.complement),
    bairro: t(e.neighborhood),
    cidade: t(e.city) + (t(e.state) ? '/' + t(e.state) : ''),
    cep: cep(e.zip_code),
    referencia: t(e.address_reference),
    recado: t(e.note),
    itens,
    frete: Math.round(frete * 100) / 100,
    pagamento,
  };
}

// ── Bobina ─────────────────────────────────────────────────────
const CSS_BOBINA = [
  '.ent{font-family:Consolas,\'Lucida Console\',Menlo,\'Courier New\',monospace;font-size:11px;color:#000;width:100%;overflow-wrap:anywhere;word-break:break-word}',
  '.ent-corte{text-align:center;font-size:10px;margin:10px 0 8px;border-top:1px dashed #000;padding-top:3px}',
  '.ent-titulo{font-size:20px;font-weight:bold;letter-spacing:2px;text-align:center}',
  '.ent-c{text-align:center}',
  '.ent-hr{border-top:1px dashed #000;margin:5px 0}',
  '.ent-k{font-size:10px;font-weight:bold}',
  '.ent-nome{font-size:16px;font-weight:bold;text-transform:uppercase}',
  '.ent-tel{font-size:14px;font-weight:bold}',
  '.ent-end{font-size:14px;font-weight:bold;line-height:1.35}',
  '.ent-l{display:flex;justify-content:space-between;gap:2mm}',
  '.ent-l b{text-align:right}',
  '.ent-assina{margin-top:14px}',
].join('');

function corpoDaBobina(d) {
  const linhas = [];
  linhas.push('<div class="ent-titulo">ENTREGA</div>');
  linhas.push(`<div class="ent-c">Venda Nº ${esc(d.numero)}${d.dia ? ` · ${esc(d.dia)} ${esc(d.hora)}` : ''}</div>`);
  linhas.push('<div class="ent-hr"></div>');
  linhas.push('<div class="ent-k">PARA</div>');
  linhas.push(`<div class="ent-nome">${esc(d.nome)}</div>`);
  if (d.telefone) linhas.push(`<div class="ent-tel">${esc(d.telefone)}</div>`);
  linhas.push('<div class="ent-hr"></div>');
  linhas.push('<div class="ent-k">ENDEREÇO</div>');
  const end = [d.rua, [d.complemento, d.bairro].filter(Boolean).join(' - '), d.cidade, d.cep ? 'CEP ' + d.cep : '']
    .filter(Boolean).map(esc).join('<br>');
  linhas.push(`<div class="ent-end">${end}</div>`);
  if (d.referencia) linhas.push(`<div style="margin-top:4px">Ref.: ${esc(d.referencia)}</div>`);
  if (d.recado) {
    linhas.push('<div class="ent-hr"></div>');
    linhas.push('<div class="ent-k">RECADO</div>');
    linhas.push(`<div>${esc(d.recado)}</div>`);
  }
  linhas.push('<div class="ent-hr"></div>');
  linhas.push(`<div class="ent-k">ITENS (${d.itens.length})</div>`);
  for (const i of d.itens) linhas.push(`<div>${esc(i.qtd)}x ${esc(i.nome)}</div>`);
  linhas.push('<div class="ent-hr"></div>');
  linhas.push(`<div class="ent-l"><span>Pagamento</span><b>${esc(d.pagamento.toUpperCase())}</b></div>`);
  if (d.frete > 0) linhas.push(`<div class="ent-l"><span>Frete</span><span>${esc(moeda(d.frete))}</span></div>`);
  linhas.push('<div class="ent-hr"></div>');
  linhas.push(`<div class="ent-c">${esc(d.loja)}${d.lojaTelefone ? ' · ' + esc(d.lojaTelefone) : ''}</div>`);
  linhas.push('<div class="ent-assina">Recebido por: ________________</div>');
  return linhas.join('\n  ');
}

/** O papel para ir depois do cupom, com a linha de corte. */
function blocoDaBobina(d) {
  return `
  <div class="ent" data-papel-entrega>
  <style>${CSS_BOBINA}</style>
  <div class="ent-corte">✂ - - - - corte - - - -</div>
  ${corpoDaBobina(d)}
  </div>`;
}

const MARCA_DO_BOTAO = '\n  <br><button onclick="window.print()"';

/**
 * Acrescenta o papel ao HTML do cupom, logo antes do botao "Imprimir" (que
 * nao sai no papel). Sem o botao (formato futuro), antes do </body>.
 */
function comPapelDeEntrega(cupomHtml, bloco) {
  if (!bloco) return cupomHtml;
  const i = cupomHtml.lastIndexOf(MARCA_DO_BOTAO);
  if (i >= 0) return cupomHtml.slice(0, i) + bloco + cupomHtml.slice(i);
  const f = cupomHtml.lastIndexOf('</body>');
  if (f >= 0) return cupomHtml.slice(0, f) + bloco + '\n' + cupomHtml.slice(f);
  return cupomHtml + bloco;
}

// ── A4 ─────────────────────────────────────────────────────────
function corpoDoA4(d, logoUrl) {
  const iniciais = (d.loja || 'L').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
  const logo = logoUrl
    ? `<div class="logo"><img src="${esc(logoUrl)}" alt=""></div>`
    : `<div class="logo">${esc(iniciais)}</div>`;
  const lojaInfo = [d.lojaTelefone, d.lojaEndereco].filter(Boolean).map(esc).join(' · ');
  const end1 = [d.rua, d.complemento].filter(Boolean).map(esc).join(' · ');
  const end2 = [d.bairro, d.cidade, d.cep ? 'CEP ' + d.cep : ''].filter(Boolean).map(esc).join(' · ');
  const itens = d.itens.map((i) => `<tr><td>${esc(i.qtd)}</td><td>${esc(i.nome)}</td></tr>`).join('');
  return `<div class="hd">
    <div class="loja">${logo}<div><b class="loja-nome">${esc(d.loja)}</b>${lojaInfo ? `<br><span class="cinza">${lojaInfo}</span>` : ''}</div></div>
    <div class="dir"><div class="tt">ENTREGA</div><div>Venda Nº ${esc(d.numero)}${d.dia ? ` · ${esc(d.dia)}` : ''}</div></div>
  </div>
  <div class="blk"><div class="k">PARA</div><div class="nm">${esc(d.nome)}</div>${d.telefone ? `<div class="tel">${esc(d.telefone)}</div>` : ''}</div>
  <div class="blk"><div class="k">ENDEREÇO</div><div class="addr">${end1}${end2 ? '<br>' + end2 : ''}</div>${d.referencia ? `<div style="margin-top:4px">Ponto de referência: ${esc(d.referencia)}</div>` : ''}</div>
  ${d.recado ? `<div class="blk"><div class="k">RECADO</div><div style="font-size:13px">${esc(d.recado)}</div></div>` : ''}
  <div class="blk"><div class="k">ITENS (${d.itens.length})</div>
    <table><thead><tr><th style="width:50px">Qtd</th><th>Produto</th></tr></thead><tbody>${itens}</tbody></table>
  </div>
  <div class="blk lado"><div><div class="k">PAGAMENTO</div><b class="v">${esc(d.pagamento)}</b></div>${d.frete > 0 ? `<div class="dir"><div class="k">FRETE</div><b class="v">${esc(moeda(d.frete))}</b></div>` : ''}</div>
  <div class="sig"><div>Recebido por</div><div>Data e hora</div></div>`;
}

const CSS_A4 = `
    @page { margin: 12mm; size: A4; }
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif; font-size:12px; color:#111; overflow-wrap:anywhere; }
    .hd { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; border-bottom:2px solid #111; padding-bottom:10px; }
    .loja { display:flex; gap:12px; align-items:center; }
    .loja-nome { font-size:14px; }
    .logo { width:46px; height:46px; border-radius:10px; background:#eee; display:flex; align-items:center; justify-content:center; font-weight:900; color:#555; flex:none; overflow:hidden; }
    .logo img { display:block; width:46px; height:46px; object-fit:contain; }
    .cinza { color:#555; }
    .dir { text-align:right; }
    .tt { font-size:24px; font-weight:900; letter-spacing:.06em; }
    .blk { border:1.5px solid #111; border-radius:8px; padding:12px 14px; margin-top:14px; page-break-inside:avoid; break-inside:avoid; }
    .blk .k { font-size:10px; font-weight:800; letter-spacing:.1em; color:#555; }
    .nm { font-size:20px; font-weight:900; }
    .tel { font-size:14px; }
    .addr { font-size:16px; font-weight:700; line-height:1.4; }
    .lado { display:flex; justify-content:space-between; gap:12px; }
    .v { font-size:14px; }
    table { width:100%; border-collapse:collapse; margin-top:6px; }
    td, th { text-align:left; padding:5px 4px; border-bottom:1px solid #ddd; }
    .sig { display:flex; gap:30px; margin-top:26px; }
    .sig div { flex:1; border-top:1px solid #111; padding-top:4px; font-size:11px; color:#444; }
    @media print { body { -webkit-print-color-adjust:exact; } button { display:none; } }`;

/**
 * O papel sozinho.
 * @param {object} d        dadosDoPapel()
 * @param {object} opts     { format: '80'|'58'|'a4', autoprintScript?: string, logoUrl?: string }
 */
function documentoDoPapel(d, { format = '80', autoprintScript = '', logoUrl = null } = {}) {
  const a4 = format === 'a4';
  const papel = format === '58' ? '58mm' : '80mm';
  const largura = format === '58' ? '48mm' : '72mm';
  const estilo = a4
    ? CSS_A4
    : `
    @page { margin: 4mm 5mm; size: ${papel} auto; }
    * { margin:0; padding:0; box-sizing:border-box; }
    body { width:${largura}; color:#000; }
    ${CSS_BOBINA}
    @media print { body { -webkit-print-color-adjust:exact; } button { display:none; } }`;
  const corpo = a4 ? corpoDoA4(d, logoUrl) : `<div class="ent" data-papel-entrega>\n  ${corpoDaBobina(d)}\n  </div>`;
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Entrega - Venda ${esc(d.numero)}</title>
  <style>${estilo}
  </style>
</head>
<body>
  ${corpo}
  <br><button onclick="window.print()" style="width:100%;padding:8px;margin-top:8px;cursor:pointer">Imprimir</button>
  ${autoprintScript}
</body>
</html>`;
}

/** Tem o minimo para o papel: um endereco (rua ou CEP) e a cidade ou o numero. */
function temEnderecoNoPapel(e) {
  return !!e && !!((t(e.street) || t(e.zip_code)) && (t(e.number) || t(e.city)));
}

module.exports = {
  dadosDoPapel,
  blocoDaBobina,
  comPapelDeEntrega,
  documentoDoPapel,
  temEnderecoNoPapel,
  MARCA_DO_BOTAO,
};
