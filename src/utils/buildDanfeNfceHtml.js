// ============================================================================
// AURA. — Gerador HTML da DANFE NFC-e térmica (80mm)
//
// Layout simplificado conforme manual SEFAZ NFC-e (modelo 65), versão térmica
// (Cupom Fiscal Eletrônico). Impresso em papel 80mm, fonte monospace, QR
// destacado pra escaneamento pelo consumidor.
//
// Uso:
//   const { buildDanfeNfceHtml } = require('../utils/buildDanfeNfceHtml');
//   const html = buildDanfeNfceHtml({ emission, company });
//   res.type('html').send(html);
//
// Onde:
//   emission = row de nfce_emissions (com items jsonb, payment_method, etc.)
//   company  = row de companies (legal_name, cnpj, address_*, etc.)
//
// QR Code: usa qrcode.js via CDN (jsdelivr). Renderiza no client após
// document load. Fallback: link "consulta SEFAZ" abaixo do QR (texto).
// ============================================================================

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBRL(n) {
  const v = Number(n) || 0;
  return v.toFixed(2).replace('.', ',');
}

function formatCnpj(cnpj) {
  const d = String(cnpj || '').replace(/\D/g, '').padStart(14, '0');
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

function formatCpf(cpf) {
  const d = String(cpf || '').replace(/\D/g, '').padStart(11, '0');
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

// Chave de acesso 44 dígitos em grupos de 4 pra leitura humana
function formatChaveAcesso(chave) {
  const d = String(chave || '').replace(/\D/g, '');
  if (d.length !== 44) return d;
  return d.match(/.{1,4}/g).join(' ');
}

function formatDateBR(dt) {
  if (!dt) return '';
  const d = dt instanceof Date ? dt : new Date(dt);
  if (isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}:${ss}`;
}

// payment_method pode ser string ('pix') ou JSON de array (multi-pagamento)
function parsePayments(emission) {
  const pm = emission.payment_method;
  if (!pm) return [{ method: 'dinheiro', value: emission.total_nfce }];
  // String simples — single payment
  if (typeof pm === 'string' && !pm.startsWith('[')) {
    return [{ method: pm, value: Number(emission.total_nfce) || 0, change: emission.payment_change || 0 }];
  }
  // JSON array (multi)
  try {
    const parsed = typeof pm === 'string' ? JSON.parse(pm) : pm;
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {}
  return [{ method: 'dinheiro', value: Number(emission.total_nfce) || 0 }];
}

const PAYMENT_LABELS = {
  dinheiro: 'Dinheiro',
  cheque: 'Cheque',
  credito: 'Cartão Crédito',
  debito: 'Cartão Débito',
  cartao: 'Cartão',
  boleto: 'Boleto',
  pix: 'PIX',
  outros: 'Outros',
  '01': 'Dinheiro',
  '02': 'Cheque',
  '03': 'Cartão Crédito',
  '04': 'Cartão Débito',
  '15': 'Boleto',
  '17': 'PIX',
  '99': 'Outros',
};

function paymentLabel(m) {
  return PAYMENT_LABELS[String(m).toLowerCase()] || PAYMENT_LABELS[String(m)] || String(m).toUpperCase();
}

// URL pública de consulta NFC-e por UF
const CONSULTA_NFCE_URL = {
  SP: 'https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica',
  RJ: 'https://www4.fazenda.rj.gov.br/consultaNFCe/',
  MG: 'https://nfce.fazenda.mg.gov.br/portalnfce',
  RS: 'https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx',
  PR: 'http://www.fazenda.pr.gov.br/nfce',
  SC: 'https://sat.sef.sc.gov.br/nfce/consulta',
  // fallback genérico — site SEFAZ nacional
  _: 'https://www.nfe.fazenda.gov.br/portal/consulta.aspx',
};

function consultaUrlByUf(uf) {
  return CONSULTA_NFCE_URL[(uf || '').toUpperCase()] || CONSULTA_NFCE_URL._;
}

// ============================================================
// Builder principal
// ============================================================
function buildDanfeNfceHtml({ emission, company }) {
  if (!emission) throw new Error('emission obrigatório');
  if (!company) throw new Error('company obrigatório');

  // Items: pode vir como jsonb array
  let items = [];
  try {
    items = typeof emission.items === 'string' ? JSON.parse(emission.items) : (emission.items || []);
  } catch {}
  if (!Array.isArray(items)) items = [];

  const payments = parsePayments(emission);
  const totalQty = items.reduce((s, i) => s + (Number(i.quantity) || 1), 0);
  const totalProducts = Number(emission.total_products) || 0;
  const totalDiscount = Number(emission.total_discount) || 0;
  const totalNfce = Number(emission.total_nfce) || 0;

  const empresaNome = company.trade_name || company.legal_name || 'Emitente';
  const cnpj = formatCnpj(company.cnpj);
  const ie = company.inscricao_estadual || '';
  const enderecoLinha1 = [company.address_street, company.address_number].filter(Boolean).join(', ');
  const enderecoLinha2 = company.address_district || '';
  const enderecoLinha3 = [company.address_city, company.address_state].filter(Boolean).join(' - ');
  const cep = company.address_zip ? `CEP ${company.address_zip}` : '';

  const chave = emission.chave_acesso || '';
  const chaveFmt = formatChaveAcesso(chave);
  const protocolo = emission.protocolo || '';
  const numero = emission.numero || '';
  const serie = emission.serie || '';
  const dataEmissao = formatDateBR(emission.authorized_at || emission.created_at);
  const cpfNota = emission.customer_cpf ? formatCpf(emission.customer_cpf) : null;
  const nomeCliente = emission.customer_name || '';
  const consultaUrl = consultaUrlByUf(company.address_state);
  const qrText = emission.qr_code || consultaUrl;
  const isHomologacao = String(protocolo).startsWith('HOMOLOG-');

  // ========== ITEMS ==========
  // Cada item ocupa 2 linhas:
  //   linha1: código + nome (truncado se necessário)
  //   linha2: qtd UN x vUnit = total (alinhado à direita)
  let itemsHtml = '';
  items.forEach((it, i) => {
    const idx = String(i + 1).padStart(3, '0');
    const code = escapeHtml(String(it.product_id || it.code || '').slice(-6));
    const name = escapeHtml(String(it.product_name || it.name || '').slice(0, 36));
    const qty = Number(it.quantity) || 1;
    const unit = it.unit || 'UN';
    const unitPrice = Number(it.unit_price || it.price) || 0;
    const total = qty * unitPrice;
    itemsHtml +=
      `<div class="item">` +
      `<div class="item-line1">${idx} ${code} ${name}</div>` +
      `<div class="item-line2">${qty} ${unit} x ${formatBRL(unitPrice)} = R$ ${formatBRL(total)}</div>` +
      `</div>`;
  });

  // ========== PAGAMENTOS ==========
  const totalChange = payments.reduce((s, p) => s + (Number(p.change) || 0), 0);
  let paymentsHtml = '';
  payments.forEach((p) => {
    const label = paymentLabel(p.method);
    const value = Number(p.value) || 0;
    paymentsHtml += `<div class="row"><span>${escapeHtml(label)}</span><span>R$ ${formatBRL(value)}</span></div>`;
  });
  if (totalChange > 0) {
    paymentsHtml += `<div class="row"><span>Troco</span><span>R$ ${formatBRL(totalChange)}</span></div>`;
  }

  // ========== HTML ==========
  let html = '';
  html += '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">';
  html += `<title>DANFE NFC-e #${numero} - ${escapeHtml(empresaNome)}</title>`;
  // qrcode.js (CDN) — gera QR no client-side, sem dep no backend
  html += '<script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>';
  html += '<style>';
  // ===== Configuração página térmica 80mm =====
  html += '@page{size:80mm auto;margin:2mm 3mm}';
  html += '*{margin:0;padding:0;box-sizing:border-box}';
  html += 'html,body{background:#f3f4f6;color:#000;font-family:"Courier New",Courier,monospace;font-size:9pt;line-height:1.25}';
  html += '.page{width:74mm;margin:0 auto;background:#fff;padding:3mm;color:#000}';
  // Tela: imita papel térmico
  html += '@media screen{body{padding:24px 0}.page{box-shadow:0 4px 20px rgba(0,0,0,0.15);margin-bottom:24px}.print-toolbar{position:fixed;top:0;left:0;right:0;background:#1a1a2e;color:#fff;padding:10px 20px;display:flex;align-items:center;justify-content:space-between;z-index:1000}.print-toolbar button{background:#7c3aed;color:#fff;border:none;padding:8px 18px;border-radius:6px;font-weight:700;cursor:pointer;font-size:13px}.print-toolbar span{font-size:12px;color:#a78bfa}}';
  // Print: papel cru
  html += '@media print{body{background:#fff;padding:0}.page{box-shadow:none;width:100%;padding:0}.print-toolbar{display:none!important}}';
  // Conteúdo
  html += '.center{text-align:center}.bold{font-weight:700}.small{font-size:8pt}.tiny{font-size:7pt}';
  html += '.divider{border-top:1px dashed #000;margin:2mm 0}';
  html += '.divider-solid{border-top:1px solid #000;margin:2mm 0}';
  html += '.row{display:flex;justify-content:space-between;align-items:flex-end;gap:4px}';
  html += '.row span:first-child{flex:1;text-align:left}';
  html += '.row span:last-child{text-align:right;white-space:nowrap}';
  html += '.empresa{text-align:center;margin-bottom:1mm}';
  html += '.empresa .nome{font-size:10pt;font-weight:700;text-transform:uppercase;line-height:1.2;margin-bottom:1mm}';
  html += '.empresa .info{font-size:8pt;line-height:1.3}';
  html += '.titulo{text-align:center;font-size:9pt;font-weight:700;margin:2mm 0 1mm 0;text-transform:uppercase}';
  html += '.subtitulo{text-align:center;font-size:7pt;line-height:1.25;margin-bottom:1mm}';
  html += '.section-label{font-size:7pt;font-weight:700;text-transform:uppercase;letter-spacing:0.3pt;color:#000;margin-top:2mm;margin-bottom:1mm}';
  html += '.item{margin-bottom:1.5mm;font-size:8.5pt}';
  html += '.item-line1{font-weight:600;line-height:1.25;word-break:break-word}';
  html += '.item-line2{text-align:right;font-size:8pt;color:#000}';
  html += '.total-row{font-size:11pt;font-weight:800;margin-top:2mm}';
  html += '.qr-wrap{text-align:center;margin:3mm 0}';
  html += '.qr-wrap canvas,.qr-wrap img{display:inline-block;width:46mm;height:46mm;image-rendering:pixelated}';
  html += '.consulta{text-align:center;font-size:7pt;line-height:1.3;margin:2mm 0}';
  html += '.consulta a{color:#000;text-decoration:none}';
  html += '.chave{font-size:8pt;font-weight:700;text-align:center;letter-spacing:0.2pt;line-height:1.5;word-break:break-all;margin:2mm 0}';
  html += '.protocol{font-size:7pt;text-align:center;line-height:1.4}';
  html += '.consumidor{font-size:8pt;line-height:1.4}';
  html += '.homolog-warn{text-align:center;border:2px dashed #dc2626;padding:2mm;font-size:8pt;font-weight:700;color:#dc2626;margin:2mm 0}';
  html += '</style></head><body>';

  // ========== Toolbar de tela (some no print) ==========
  html += '<div class="print-toolbar">';
  html += `<span>DANFE NFC-e #${numero} - 80mm térmica</span>`;
  html += '<button onclick="window.print()">Imprimir</button>';
  html += '</div>';

  // ========== PÁGINA ==========
  html += '<div class="page">';

  // Aviso homologação (impresso e na tela)
  if (isHomologacao) {
    html += '<div class="homolog-warn">EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO<br>SEM VALOR FISCAL</div>';
  }

  // Empresa
  html += '<div class="empresa">';
  html += `<div class="nome">${escapeHtml(empresaNome)}</div>`;
  html += '<div class="info">';
  html += `CNPJ ${cnpj}`;
  if (ie) html += ` &nbsp; IE ${escapeHtml(ie)}`;
  if (enderecoLinha1) html += `<br>${escapeHtml(enderecoLinha1)}`;
  if (enderecoLinha2) html += `<br>${escapeHtml(enderecoLinha2)}`;
  if (enderecoLinha3 || cep) html += `<br>${escapeHtml(enderecoLinha3)} ${escapeHtml(cep)}`.trim();
  html += '</div>';
  html += '</div>';

  html += '<div class="divider"></div>';

  // Título DANFE
  html += '<div class="titulo">DANFE NFC-e</div>';
  html += '<div class="subtitulo">Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica<br>Não permite aproveitamento de crédito de ICMS</div>';

  html += '<div class="divider"></div>';

  // Itens
  html += '<div class="section-label">Cód  Descrição (Qtd UN x V.Un = Total)</div>';
  html += itemsHtml;

  html += '<div class="divider"></div>';

  // Totais
  html += `<div class="row"><span>Qtd. itens</span><span>${totalQty}</span></div>`;
  if (totalDiscount > 0) {
    html += `<div class="row"><span>Subtotal</span><span>R$ ${formatBRL(totalProducts)}</span></div>`;
    html += `<div class="row"><span>Desconto</span><span>- R$ ${formatBRL(totalDiscount)}</span></div>`;
  }
  html += `<div class="row total-row"><span>VALOR TOTAL</span><span>R$ ${formatBRL(totalNfce)}</span></div>`;

  html += '<div class="divider"></div>';

  // Pagamentos
  html += '<div class="section-label">Forma de Pagamento</div>';
  html += paymentsHtml;

  // Tributos aproximados (Lei 12.741) — placeholder neutro
  html += '<div class="row small" style="margin-top:1mm;color:#000"><span>Trib. aprox. (Lei 12.741)</span><span>conforme NCM</span></div>';

  html += '<div class="divider"></div>';

  // Consumidor
  html += '<div class="section-label">Consumidor</div>';
  if (cpfNota || nomeCliente) {
    html += '<div class="consumidor">';
    if (cpfNota) html += `CPF ${escapeHtml(cpfNota)}<br>`;
    if (nomeCliente) html += `${escapeHtml(nomeCliente)}`;
    html += '</div>';
  } else {
    html += '<div class="consumidor">Consumidor não identificado</div>';
  }

  html += '<div class="divider"></div>';

  // Info NFC-e
  html += '<div class="section-label">Info NFC-e</div>';
  html += `<div class="small">NFC-e nº <b>${escapeHtml(String(numero))}</b> - Série ${escapeHtml(String(serie))}<br>`;
  html += `Emitida em ${escapeHtml(dataEmissao)}</div>`;
  if (protocolo && !isHomologacao) {
    html += `<div class="protocol">Protocolo de Autorização<br>${escapeHtml(protocolo)}</div>`;
  }

  html += '<div class="divider"></div>';

  // Chave acesso
  html += '<div class="section-label center">Chave de Acesso</div>';
  html += `<div class="chave">${escapeHtml(chaveFmt)}</div>`;

  // Consulta SEFAZ + QR
  html += '<div class="consulta">Consulte pela chave em<br>';
  html += `<b>${escapeHtml(consultaUrl.replace(/^https?:\/\//, ''))}</b></div>`;

  html += '<div class="divider-solid"></div>';
  html += '<div class="qr-wrap"><canvas id="qrcanvas"></canvas></div>';
  html += '<div class="consulta tiny">QR Code para consulta pelo consumidor</div>';

  html += '</div>'; // /page

  // Script: gera QR e dispara print após renderizar
  html += '<script>';
  html += '(function(){';
  html += `var qrText = ${JSON.stringify(qrText)};`;
  html += 'var canvas=document.getElementById("qrcanvas");';
  html += 'function done(){setTimeout(function(){try{window.focus();window.print();}catch(e){}}, 350);}';
  html += 'if(window.QRCode){';
  // qrcode.js (CDN) usa QRCode.toCanvas
  html += 'QRCode.toCanvas(canvas, qrText, {width:174, margin:1, errorCorrectionLevel:"M"}, function(err){';
  html += 'if(err){console.error("QR fail",err);} done();';
  html += '});';
  html += '}else{done();}';
  html += '})();';
  html += '</script>';

  html += '</body></html>';
  return html;
}

module.exports = {
  buildDanfeNfceHtml,
  // helpers expostos pra teste
  formatCnpj, formatCpf, formatChaveAcesso, formatDateBR, formatBRL,
};
