// ============================================================================
// AURA. — Folha A4 da OS de ótica, em duas vias iguais (p-206, 23/11/2026)
//
// Mockup aprovado pelo Caio em 23/11 (side-session-notes/otica-pacote/
// mockup-os-impressa.html, seção 1). Inspirada na folha de papel que um
// cliente já usa: OS, venda e termos numa página só, com assinatura.
//
// Decisões que não mudam sem o Caio:
//   - As DUAS VIAS SÃO IGUAIS. Só muda o rótulo do topo: "VIA DO
//     LABORATÓRIO" e "VIA DO CLIENTE". Cada via é uma folha A4.
//   - Termos da venda: o texto é DA LOJA (otica_settings, p-207). A Aura não
//     escreve termo nenhum. Sem texto, o quadro de termos não aparece.
//   - A receita é dado de saúde: sai no papel e no PDF, nunca em WhatsApp
//     nem no acompanhamento público. Este HTML só é servido por rota
//     autenticada (/print/os/:osId).
//   - Nada de sugestão de lente nem de comissão a prescritor (Decreto
//     24.492, art. 13; CEM arts. 68/69): a folha só registra o que foi pedido.
//
// A OS de reparo não passa por aqui (buildServiceOrderHtml.js, sem mudança).
//
// Largura: a mesma lição da DANFE e do builder da OS — a coluna é declarada
// em mm e vale igual na tela e no papel (186mm = A4 menos 12mm de cada lado).
// ============================================================================
'use strict';

const { nomeDaLoja } = require('./nomeDaLoja');
const { autoPrintScript } = require('./autoPrintScript');
const { formatBRL, formatCnpj, formatDateBR, formatGrau, lerOptical } = require('./buildServiceOrderHtml');

// Ponto de encaixe com o p-207 (termos da venda por loja, agente C): a chave
// em companies.otica_settings onde mora o texto. Se o p-207 gravar com outro
// nome, é só trocar aqui.
const CHAVE_TERMOS = 'sale_terms';

const VIAS = {
  laboratorio: 'VIA DO LABORATÓRIO',
  cliente: 'VIA DO CLIENTE',
};

const USOS = [
  ['longe', 'Longe'], ['perto', 'Perto'], ['multifocal', 'Multifocal'],
  ['bifocal', 'Bifocal'], ['sol', 'Sol com grau'],
];
// Mesma lista do app (services/oticaApi.ts, LENS_TREATMENTS), na ordem do
// mockup. Tratamento que não estiver aqui sai escrito ao lado.
const TRATAMENTOS = ['Antirreflexo', 'Filtro azul', 'Fotossensível', 'Antirrisco', 'Polarizada', 'Hidrofóbico'];
const SERVICOS = [['lente', 'Venda de lente'], ['montagem', 'Montagem'], ['lente_montagem', 'Lente + montagem']];
const QUANTIDADE = { par: '1 par', unidade: '1 lente' };
const FORMA = { pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão', debito: 'Débito', credito: 'Cartão' };

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMm(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(1).replace('.', ',') : '';
}

function formatCpf(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length === 11) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  if (d.length === 14) return formatCnpj(d);
  return String(v || '');
}

function formatCep(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : String(v || '');
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Data sem hora ('2026-11-10', a receita) e o dia escrito, sem fuso: lida como
// instante ela vira meia-noite UTC e sairia no dia anterior em Sao Paulo.
// Instante de verdade (created_at, promised_at) passa pelo formatDateBR.
function dataBR(v) {
  if (!v) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof v === 'string' ? v : '');
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  if (v instanceof Date && !isNaN(v.getTime()) && v.getUTCHours() === 0 && v.getUTCMinutes() === 0) {
    // DATE do pg chega como Date a meia-noite local do processo; em UTC (Railway) e o proprio dia.
    return formatDateBR(new Date(v.getTime() + 12 * 3600000), false);
  }
  return formatDateBR(v, false);
}

/**
 * Valores da OS a partir da venda do sinal e das parcelas dela.
 * Puro (testado sem banco).
 *
 *   total     = valor cheio da venda do sinal; sem sinal, o orçado da OS.
 *   sinal     = total - soma das parcelas (o saldo do sinal é juros zero).
 *   restante  = o que está em aberto hoje nas parcelas.
 *   parcelas  = quantas e de quanto (a última pode ter centavos a mais).
 */
function calcularValores({ os, parcelas = [], formaDoSinal = null }) {
  const comSinal = !!os.deposit_sale_id && os.deposit_sale_total != null;
  const vivas = (parcelas || []).filter((p) => p && p.status !== 'cancelled');
  if (!comSinal) {
    const total = r2(os.estimated_amount);
    const pago = !!os.sale_id;
    return {
      comSinal: false, total, sinal: 0, formaDoSinal: null,
      restante: pago ? 0 : total, saldoOriginal: total, parcelas: [], pagoNaEntrega: pago,
    };
  }
  const total = r2(os.deposit_sale_total);
  const saldoOriginal = r2(vivas.reduce((s, p) => s + Number(p.amount_due || 0), 0));
  const restante = r2(vivas.reduce((s, p) => {
    if (p.status === 'paid') return s;
    return s + Math.max(0, Number(p.amount_due || 0) - Number(p.covered_amount || 0));
  }, 0));
  return {
    comSinal: true,
    total,
    sinal: r2(total - saldoOriginal),
    formaDoSinal,
    restante,
    saldoOriginal,
    parcelas: vivas.map((p) => ({ valor: r2(p.amount_due), vencimento: p.due_date, paga: p.status === 'paid' })),
    pagoNaEntrega: false,
  };
}

// "2x R$ 40,00" ou, quando a última leva o centavo, "3x R$ 33,33 (última R$ 33,34)".
function textoDasParcelas(parcelas) {
  if (!parcelas.length) return '';
  const n = parcelas.length;
  const primeira = parcelas[0].valor;
  const ultima = parcelas[n - 1].valor;
  const iguais = parcelas.every((p) => Math.abs(p.valor - primeira) < 0.005);
  if (iguais) return `${n}x R$ ${formatBRL(primeira)}`;
  return `${n}x R$ ${formatBRL(primeira)} (última R$ ${formatBRL(ultima)})`;
}

function chk(marcado, rotulo) {
  return `<span class="chk"><span class="cx">${marcado ? '&#10005;' : ''}</span>${escapeHtml(rotulo)}</span>`;
}

function campo(rotulo, valor, extraClasse = '') {
  return `<div class="campo ${extraClasse}"><small>${escapeHtml(rotulo)}</small><span>${escapeHtml(valor || '')}</span></div>`;
}

/**
 * @param {object} p
 * @param {object} p.os          linha de service_orders (+ customer_*, deposit_sale_total)
 * @param {object} p.company     linha de companies
 * @param {object} [p.brand]     digital_channel_config (logo)
 * @param {object} [p.customer]  cpf_cnpj, phone, street, number, complement, neighborhood, city, state, zip_code
 * @param {object} [p.settings]  companies.otica_settings (rt_name, rt_registry, sanitary_license, termos)
 * @param {Array}  [p.parcelas]  credit_installments da venda do sinal
 * @param {string} [p.formaDoSinal]
 * @param {string[]} [p.vias]    ['laboratorio','cliente'] (padrão) ou uma só
 * @param {boolean} [p.autoprint]
 * @param {Date}   [p.agora]     só para teste
 */
function buildOticaOsHtml({
  os, company, brand = {}, customer = {}, settings = {}, parcelas = [], formaDoSinal = null,
  vias = ['laboratorio', 'cliente'], autoprint = false, agora = new Date(),
}) {
  if (!os) throw new Error('os obrigatório');
  if (!company) throw new Error('company obrigatório');

  const optical = lerOptical(os) || {};
  const rx = optical.prescription || null;
  const lens = optical.lens || {};
  const frame = optical.frame || {};
  const loja = nomeDaLoja(company, 'Ótica');
  const logoUrl = brand.logo_url || company.logo_url || null;
  const numero = os.os_number != null ? String(os.os_number).padStart(4, '0') : String(os.id || '').slice(-8).toUpperCase();
  const valores = calcularValores({ os, parcelas, formaDoSinal });
  const termos = String((settings && settings[CHAVE_TERMOS]) || '').trim();
  const viasOk = (Array.isArray(vias) ? vias : []).filter((v) => VIAS[v]);
  const listaVias = viasOk.length ? viasOk : ['laboratorio', 'cliente'];

  const enderecoLoja = [
    [company.address_street, company.address_number].filter(Boolean).join(', '),
    company.address_district,
    [company.address_city, company.address_state].filter(Boolean).join('/'),
  ].filter(Boolean).join(' · ');
  const contatoLoja = [
    company.cnpj ? `CNPJ ${formatCnpj(company.cnpj)}` : null,
    company.phone ? `Tel. ${company.phone}` : null,
  ].filter(Boolean).join(' · ');
  const responsavel = [settings.rt_name, settings.rt_registry ? `Registro ${settings.rt_registry}` : null]
    .filter(Boolean).join(' · ');

  const c = customer || {};
  const enderecoCliente = [
    [c.street, c.number].filter(Boolean).join(', '),
    c.complement, c.neighborhood,
  ].filter(Boolean).join(' · ');
  const cidadeCliente = [c.city, c.state].filter(Boolean).join('/');
  const telefone = c.phone || os.customer_phone || '';

  const tratamentos = Array.isArray(lens.treatments) ? lens.treatments : [];
  const tratamentosExtras = tratamentos.filter((t) => !TRATAMENTOS.includes(t));
  const marcaDesenho = [lens.brand, lens.design].filter(Boolean).join(' · ');
  const modeloArmacao = [frame.description, frame.color, frame.size].filter(Boolean).join(' · ');
  const prescritor = rx ? [rx.prescriber_name, rx.prescriber_registry].filter(Boolean).join(' · ') : '';
  const datasReceita = rx
    ? [dataBR(rx.issued_at), dataBR(rx.valid_until)].filter(Boolean).join(' · ')
    : '';

  // ── uma via (o conteúdo é o mesmo nas duas) ──
  function folha(via) {
    let h = '<section class="folha">';

    // Cabeçalho
    h += '<div class="cab">';
    h += logoUrl
      ? `<img class="logo" src="${escapeHtml(logoUrl)}" alt="">`
      : `<div class="logo logo-vazio">${escapeHtml(loja.slice(0, 2).toUpperCase())}</div>`;
    h += '<div class="loja">';
    h += `<strong>${escapeHtml(loja)}</strong>`;
    if (contatoLoja) h += `${escapeHtml(contatoLoja)}<br>`;
    if (enderecoLoja) h += `${escapeHtml(enderecoLoja)}<br>`;
    if (responsavel) h += `Óptico responsável: ${escapeHtml(responsavel)}`;
    if (settings.sanitary_license) h += `${responsavel ? ' · ' : ''}Licença sanitária ${escapeHtml(settings.sanitary_license)}`;
    h += '</div>';
    h += `<div class="via"><div class="os">ORDEM DE SERVIÇO Nº ${escapeHtml(numero)}</div>`;
    h += `<div class="rot">${escapeHtml(VIAS[via])}</div></div>`;
    h += '</div>';

    h += '<div class="l2">';
    h += campo('Entrada', formatDateBR(os.created_at, false));
    h += campo('Previsão de entrega', formatDateBR(os.promised_at, false));
    h += '</div>';

    // Cliente
    h += '<div class="bloco"><div class="bt">CLIENTE</div>';
    h += campo('Nome', os.customer_name);
    h += '<div class="l2">' + campo('Endereço', enderecoCliente) + campo('Cidade/UF', cidadeCliente) + '</div>';
    h += '<div class="l2">' + campo('CPF', c.cpf_cnpj ? formatCpf(c.cpf_cnpj) : '')
      + campo('CEP', c.zip_code ? formatCep(c.zip_code) : '') + campo('Tel.', telefone) + '</div>';
    h += '</div>';

    // Lentes
    h += '<div class="bloco"><div class="bt">LENTES</div>';
    h += '<div class="linha-chk">' + USOS.map(([k, r]) => chk(optical.use === k, r)).join('') + '</div>';
    h += '<div class="linha-chk">' + TRATAMENTOS.map((t) => chk(tratamentos.includes(t), t)).join('')
      + (tratamentosExtras.length ? `<span class="chk">${escapeHtml(tratamentosExtras.join(', '))}</span>` : '') + '</div>';
    h += '<div class="l2">' + campo('Marca / desenho', marcaDesenho) + campo('Material / índice', lens.material)
      + campo('Quantidade', QUANTIDADE[optical.quantity] || '', 'curto') + '</div>';
    h += '</div>';

    // Armação
    h += '<div class="bloco"><div class="bt">ARMAÇÃO</div>';
    h += '<div class="l2">' + campo('Modelo / ref.', modeloArmacao)
      + `<div class="campo curto"><small>Fornecida por</small><span>${chk(frame.source === 'cliente', 'Cliente')}${chk(frame.source === 'estoque', 'Loja')}</span></div>`
      + '</div></div>';

    // Grau
    h += '<div class="bloco"><div class="bt">GRAU</div>';
    h += '<table class="grau"><thead><tr><th></th><th>Esférico</th><th>Cilíndrico</th><th>Eixo</th><th>Adição</th><th>DNP</th><th>Altura</th></tr></thead><tbody>';
    for (const [rot, o] of [['OD', (rx && rx.od) || {}], ['OE', (rx && rx.oe) || {}]]) {
      const eixo = o.axis != null && o.axis !== '' ? `${o.axis}°` : '';
      h += `<tr><td class="olho">${rot}</td>`
        + `<td class="n">${escapeHtml(formatGrau(o.sph) || '—')}</td>`
        + `<td class="n">${escapeHtml(formatGrau(o.cyl) || '—')}</td>`
        + `<td class="n">${escapeHtml(eixo || '—')}</td>`
        + `<td class="n">${escapeHtml(formatGrau(o.add) || '—')}</td>`
        + `<td class="n">${escapeHtml(formatMm(o.pd) || '—')}</td>`
        + `<td class="n">${escapeHtml(formatMm(o.height) || '—')}</td></tr>`;
    }
    h += '</tbody></table>';
    h += '<div class="l2">' + campo('Prescritor', prescritor) + campo('Receita emitida / válida até', datasReceita) + '</div>';
    h += '</div>';

    // Serviço
    h += '<div class="bloco"><div class="bt">SERVIÇO</div>';
    h += '<div class="linha-chk">' + SERVICOS.map(([k, r]) => chk(optical.service_type === k, r)).join('') + '</div>';
    if (os.notes) h += `<div class="campo obs"><small>Obs.</small><span>${escapeHtml(os.notes)}</span></div>`;
    h += '</div>';

    // Valores
    h += '<div class="valores">';
    h += `<div class="tot"><span class="tit-campo">Valor total</span><strong>R$ ${formatBRL(valores.total)}</strong></div>`;
    if (valores.comSinal) {
      h += `<div class="v"><small>Pagamento do sinal</small><b>${escapeHtml(FORMA[valores.formaDoSinal] || valores.formaDoSinal || '—')}</b></div>`;
      h += `<div class="v"><small>Sinal</small><b>R$ ${formatBRL(valores.sinal)}</b></div>`;
      h += `<div class="v"><small>Restante</small><b>${valores.restante > 0.005 ? `R$ ${formatBRL(valores.restante)}` : 'quitado'}</b></div>`;
      h += `<div class="v"><small>Parcelas</small><b>${escapeHtml(textoDasParcelas(valores.parcelas) || '—')}</b></div>`;
    } else {
      h += '<div class="v"><small>Sinal</small><b>sem sinal</b></div>';
      h += `<div class="v"><small>${valores.pagoNaEntrega ? 'Pago na entrega' : 'A pagar na retirada'}</small><b>R$ ${formatBRL(valores.pagoNaEntrega ? valores.total : valores.restante)}</b></div>`;
    }
    h += '</div>';

    // Termos da loja (p-207). Sem texto, sem quadro.
    if (termos) {
      h += `<div class="termos"><b>TERMOS DA VENDA:</b> ${escapeHtml(termos)}</div>`;
    }

    h += '<div class="assin"><div>Assinatura do cliente</div><div>Assinatura da loja</div></div>';
    h += `<div class="rodape">Emitida pelo Aura · ${escapeHtml(formatDateBR(agora))} · a receita é dado de saúde: guarde esta via com cuidado.</div>`;
    h += '</section>';
    return h;
  }

  let h = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">';
  h += '<meta name="viewport" content="width=device-width, initial-scale=1">';
  h += `<title>OS nº ${escapeHtml(numero)} — ${escapeHtml(loja)}</title>`;
  h += '<style>';
  h += '@page{size:A4;margin:12mm}';
  h += '*{box-sizing:border-box;margin:0;padding:0}';
  h += 'html,body{background:#eceaf3;color:#111;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;font-size:9.4pt;line-height:1.35}';
  h += '.toolbar{position:sticky;top:0;background:#1a1a2e;color:#fff;padding:10px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;z-index:9}';
  h += '.toolbar span{font-size:12px;color:#c4b5fd}.toolbar button{background:#7c3aed;color:#fff;border:0;padding:8px 18px;border-radius:6px;font-weight:700;cursor:pointer}';
  h += '.folha{width:186mm;min-height:270mm;margin:16px auto;background:#fff;padding:0;display:flex;flex-direction:column;gap:2.6mm}';
  h += '@media screen{.folha{padding:8mm;width:202mm;box-shadow:0 6px 24px rgba(0,0,0,.16)}}';
  h += '@media print{html,body{background:#fff}.toolbar{display:none!important}.folha{margin:0;box-shadow:none;break-after:page;page-break-after:always}.folha:last-of-type{break-after:auto;page-break-after:auto}body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}';
  h += '.cab{display:flex;justify-content:space-between;align-items:flex-start;gap:4mm;border-bottom:1.6pt solid #111;padding-bottom:2.4mm}';
  h += '.logo{width:36mm;height:13mm;object-fit:contain;flex:none}';
  h += '.logo-vazio{display:flex;align-items:center;justify-content:center;border:1pt solid #999;font-weight:800;color:#555}';
  h += '.loja{flex:1;text-align:center;font-size:8pt;color:#333;line-height:1.4}';
  h += '.loja strong{display:block;font-size:14pt;letter-spacing:.3pt;color:#111;margin-bottom:.6mm}';
  h += '.via{flex:none;text-align:right}.via .os{font-weight:800;font-size:10.5pt}';
  h += '.via .rot{display:inline-block;margin-top:1mm;border:1.2pt solid #111;padding:.5mm 2mm;font-weight:800;font-size:8pt;letter-spacing:.4pt}';
  h += '.l2{display:flex;gap:5mm}.l2>.campo{flex:1;min-width:0}.l2>.campo.curto{flex:0 0 34mm}';
  h += '.campo{border-bottom:.7pt solid #444;padding:.5mm 0 .3mm;min-height:5.4mm;display:flex;gap:1.6mm;align-items:baseline;min-width:0}';
  h += '.campo small,.tit-campo{font-size:7pt;font-weight:800;letter-spacing:.3pt;text-transform:uppercase;color:#444;white-space:nowrap}';
  h += '.campo span{font-size:9.4pt;overflow-wrap:anywhere}';
  h += '.campo.obs span{white-space:pre-wrap}';
  h += '.bloco{display:flex;flex-direction:column;gap:1.6mm;break-inside:avoid}';
  h += '.bt{font-weight:800;font-size:8.4pt;letter-spacing:.8pt;border-bottom:.8pt solid #111;padding-bottom:.4mm}';
  h += '.linha-chk{display:flex;flex-wrap:wrap;gap:1mm 0}';
  h += '.chk{display:inline-flex;align-items:center;gap:1.2mm;margin-right:3.4mm;font-size:8.8pt;white-space:nowrap}';
  h += '.cx{width:3mm;height:3mm;border:1pt solid #111;display:inline-flex;align-items:center;justify-content:center;font-size:7pt;font-weight:800;line-height:1}';
  h += 'table.grau{border-collapse:collapse;width:100%;font-size:9.4pt}';
  h += 'table.grau th,table.grau td{border:.7pt solid #444;padding:1.1mm 1.6mm;text-align:center}';
  h += 'table.grau th{background:#f1f1f1;font-size:7pt;letter-spacing:.3pt;text-transform:uppercase}';
  h += 'table.grau td.olho{font-weight:800;width:12mm;background:#f1f1f1}';
  h += 'table.grau td.n{font-family:ui-monospace,Menlo,Consolas,monospace}';
  h += '.valores{border:1.1pt solid #111;padding:2mm 3mm;display:grid;grid-template-columns:repeat(4,1fr);gap:1.6mm 3.6mm;break-inside:avoid}';
  h += '.valores .tot{grid-column:1/-1;display:flex;justify-content:space-between;align-items:baseline;border-bottom:.7pt solid #999;padding-bottom:1.2mm}';
  h += '.valores .tot strong{font-size:13pt;font-family:ui-monospace,Menlo,Consolas,monospace}';
  h += '.v small{display:block;font-size:7pt;text-transform:uppercase;letter-spacing:.3pt;color:#444;font-weight:800}';
  h += '.v b{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:9.6pt}';
  h += '.termos{font-size:7.4pt;line-height:1.4;color:#333;text-align:justify;border:.7pt solid #bbb;padding:1.6mm 2.4mm;white-space:pre-wrap;break-inside:avoid}';
  h += '.assin{margin-top:auto;display:flex;gap:10mm;padding-top:9mm}';
  h += '.assin div{flex:1;border-top:.8pt solid #111;text-align:center;font-size:8pt;padding-top:.8mm;color:#333}';
  h += '.rodape{font-size:6.8pt;color:#777;text-align:center}';
  h += '</style></head><body>';

  const rotulo = listaVias.length > 1 ? '2 vias iguais (laboratório e cliente)' : VIAS[listaVias[0]].toLowerCase();
  h += `<div class="toolbar"><span>OS nº ${escapeHtml(numero)} · A4 · ${escapeHtml(rotulo)}</span>`;
  h += '<button onclick="window.print()">Imprimir</button></div>';
  for (const via of listaVias) h += folha(via);
  if (autoprint) h += autoPrintScript({ delayMs: 350 });
  h += '</body></html>';
  return h;
}

module.exports = {
  buildOticaOsHtml,
  // expostos para teste
  calcularValores, textoDasParcelas, formatCpf, formatCep, dataBR,
  CHAVE_TERMOS, VIAS,
};
