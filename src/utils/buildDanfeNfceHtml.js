// ============================================================================
// AURA. — Gerador HTML da DANFE NFC-e térmica (80mm) — v2 compacta
//
// Layout aprovado pelo Caio em 05/05/2026 (mockup mock_danfe_v2.html):
// - Header com logo do cliente à esquerda + dados empresa à direita
// - QR único 28mm centralizado (não 2 QRs como antes)
// - Marca Aura textual discreta no rodapé
// - Body 8.5pt monospace, layout ~30% mais compacto que v1
//
// Uso:
//   const { buildDanfeNfceHtml } = require('../utils/buildDanfeNfceHtml');
//   const html = buildDanfeNfceHtml({ emission, company });
//   res.type('html').send(html);
//
// QR Code (16/07/2026): gerado LOCAL e embutido como SVG inline
// (utils/qrInline.js). Antes vinha de api.qrserver.com via <img src> e era a
// metade visível do bug do Davi Calçados: o auto-print disparava antes do QR
// chegar e o Chrome recusava o job com "Falha na impressão". O comentário
// original aqui afirmava que o <img> "carrega síncrono pelo browser, sem race
// com document.close()" — era falso, e custou dias de um lojista depurando uma
// impressora sadia.
//
// Impressão (16/07/2026): utils/autoPrintScript.js. Não depende de
// window.onload nem de readyState — ambos são inconfiáveis dentro de uma
// janela montada por document.write (ver o porquê no próprio arquivo).
// ============================================================================

const { qrInlineSvg } = require('./qrInline');
const { autoPrintScript } = require('./autoPrintScript');

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

// Iniciais 2 letras pra fallback do logo. "Davi Calçados Matriz" → "DC".
function getInitials(name) {
  if (!name) return '?';
  const words = String(name).trim().split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
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

// QR do cupom: 28mm, ECC M, quiet zone 1 módulo. Constante única — o teste
// reproduz o SVG com estes mesmos parâmetros pra afirmar QUAL texto foi
// codificado, sem depender de detalhe de implementação do gerador.
const QR_OPTS = { size: '28mm', margin: 1, ecc: 'M' };

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
  const enderecoLinha3 = [company.address_city, company.address_state].filter(Boolean).join(' — ');
  const cep = company.address_zip ? `CEP ${company.address_zip}` : '';

  const chave = emission.chave_acesso || '';
  const chaveFmt = formatChaveAcesso(chave);
  // A chave são 54 chars (44 dígitos + 10 espaços) numa coluna de 67mm que
  // comporta ~40 a 7.5pt. Deixar o browser quebrar sozinho corta no meio de um
  // grupo e muda de posição conforme a fonte. Quebra declarada em 6+5 grupos:
  // duas linhas sempre iguais, sempre no mesmo lugar.
  const chaveGrupos = chaveFmt.includes(' ') ? chaveFmt.split(' ') : null;
  const chaveHtml = chaveGrupos
    ? escapeHtml(chaveGrupos.slice(0, 6).join(' ')) + '<br>' + escapeHtml(chaveGrupos.slice(6).join(' '))
    : escapeHtml(chaveFmt);
  const protocolo = emission.protocolo || '';
  const numero = emission.numero || '';
  const serie = emission.serie || '';
  const dataEmissao = formatDateBR(emission.authorized_at || emission.created_at);
  const cpfNota = emission.customer_cpf ? formatCpf(emission.customer_cpf) : null;
  const nomeCliente = emission.customer_name || '';
  const consultaUrl = consultaUrlByUf(company.address_state);
  // QR principal: usa o qr_code da emissão se disponível (URL completa
  // com chave + hash CSC), senão fallback pra chave de acesso.
  //
  // ⚠️ DÍVIDA CONHECIDA (16/07/2026): qr_code está NULL em 100% das emissões
  // em produção — o caminho Nuvem Fiscal nunca devolve infNFeSupl/qrCode e
  // ninguém baixa o XML pra extrair. Hoje cai sempre no fallback e o QR
  // impresso codifica só a chave, que o app da SEFAZ não valida. É bug fiscal
  // REAL e independente do bug de impressão corrigido aqui — PR separado (a
  // engine própria já gera o QR certo em sefazSp/qrcode.js; falta o caminho
  // do gateway e o backfill das notas já emitidas).
  const qrText = emission.qr_code || chave || consultaUrl;
  // Homolog: fake do gateway (HOMOLOG-) OU emissão própria em tpAmb=2
  // (QR aponta pro endpoint de homologação da SEFAZ-SP).
  const isHomologacao = String(protocolo).startsWith('HOMOLOG-')
    || /homologacao\./.test(String(emission.qr_code || ''));
  // S2.3: contingência offline (tpEmis=9) — dizeres + duas vias.
  const isContingencia = Number(emission.tp_emis) === 9;

  // QR inline (SVG, sem rede). String vazia se falhar — o cupom ainda sai
  // com a chave de acesso legível logo acima.
  const qrSvg = qrInlineSvg(qrText, QR_OPTS);

  // Logo: se company.logo_url, usa <img>; senão fallback pra iniciais (2 letras).
  // Segue remoto (R2) — é o único <img> que sobrou, e o autoPrintScript espera
  // ele resolver (load OU error) antes de imprimir.
  const logoHtml = company.logo_url
    ? `<img class="logo-img" src="${escapeHtml(company.logo_url)}" alt="">`
    : `<div class="logo-fallback">${escapeHtml(getInitials(empresaNome))}</div>`;

  // ========== ITEMS ==========
  // Cada item ocupa 2 linhas: name + calc (qtd UN x vUnit = total).
  let itemsHtml = '';
  items.forEach((it, i) => {
    const idx = String(i + 1).padStart(3, '0');
    const code = escapeHtml(String(it.product_id || it.code || '').slice(-6));
    const name = escapeHtml(String(it.product_name || it.name || '').slice(0, 40));
    const qty = Number(it.quantity) || 1;
    const unit = it.unit || 'UN';
    const unitPrice = Number(it.unit_price || it.price) || 0;
    const total = qty * unitPrice;
    itemsHtml +=
      `<div class="item">` +
      `<div class="item-name">${idx} ${code} ${name}</div>` +
      `<div class="item-calc">${qty} ${unit} × ${formatBRL(unitPrice)} = R$ ${formatBRL(total)}</div>` +
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
  html += `<title>DANFE NFC-e #${numero} — ${escapeHtml(empresaNome)}</title>`;
  html += '<style>';
  // ===== Página térmica 80mm =====
  // Largura (31/08/2026): o cupom saía cortado na direita da térmica do Davi
  // — "R$ 289,99" virava "R$ 289,", "conforme NCM" virava "conforme N", e o
  // valor de "Qtd. itens" sumia inteiro. Causa: `margin:2mm 3mm` num @page de
  // 80mm dá uma content box de 74mm, e a `.page` esticava pra 100% dela no
  // print. Medindo o scan do cupom impresso (calibrado pelo QR de 28mm), a
  // cabeça térmica só marca até ~74,5mm da borda esquerda do papel — ou seja,
  // a coluna terminava em cima do limite físico.
  //
  // Agora a largura é declarada, não herdada: @page sem margem (assim
  // "Padrão" e "Nenhuma" no diálogo do Chrome convergem pro mesmo resultado)
  // e a `.page` fixa em 72mm — a área imprimível padrão de uma 80mm, com
  // ~2,5mm de folga pro que foi medido. O recuo lateral vira padding da
  // própria página, que nenhum ajuste de margem do operador consegue comer.
  //
  // ⚠️ .page NÃO muda de largura entre tela e print. Era essa divergência
  // (74mm no print, 68mm na tela) que escondia o bug: a pré-visualização
  // mostrava um cupom que cabia, e o papel saía outro.
  html += '@page{size:80mm auto;margin:0}';
  html += '*{margin:0;padding:0;box-sizing:border-box}';
  html += 'html,body{background:#f3f4f6;color:#000;font-family:"Courier New",Courier,monospace;font-size:8.5pt;line-height:1.2}';
  // 72mm de página, 2.5mm de recuo de cada lado → coluna de texto de 67mm.
  // padding-bottom de 8mm é avanço de papel: sem ele a última linha nasce em
  // cima do serrilhado e a marca do rodapé sai pela metade.
  html += '.page{width:72mm;max-width:72mm;margin:0 auto;background:#fff;padding:0 2.5mm 8mm;color:#000}';
  // Tela: imita papel térmico
  html += '@media screen{body{padding:24px 0}.page{box-shadow:0 4px 20px rgba(0,0,0,0.15);margin-bottom:24px}.print-toolbar{position:fixed;top:0;left:0;right:0;background:#1a1a2e;color:#fff;padding:10px 20px;display:flex;align-items:center;justify-content:space-between;z-index:1000}.print-toolbar button{background:#7c3aed;color:#fff;border:none;padding:8px 18px;border-radius:6px;font-weight:700;cursor:pointer;font-size:13px}.print-toolbar span{font-size:12px;color:#a78bfa}}';
  // Print: papel cru
  // Print: papel cru. `margin:0` (e não `0 auto`) porque centralizar 72mm
  // dentro de 80mm jogaria 4mm da coluna pra fora da cabeça térmica na
  // direita. Alinhado à esquerda, a coluna ocupa 0..72mm do papel. Largura e
  // padding NÃO são reescritos aqui — são os mesmos da tela, de propósito.
  html += '@media print{body{background:#fff;padding:0}.page{box-shadow:none;margin:0}.print-toolbar{display:none!important}}';
  // Helpers
  html += '.center{text-align:center}.small{font-size:7.5pt}.tiny{font-size:6.5pt}.mt1{margin-top:1mm}';
  // Divisores
  html += '.divider{border-top:1px dashed #000;margin:1.5mm 0}';
  html += '.divider-solid{border-top:1px solid #000;margin:1.5mm 0}';
  // Linha row (label + value)
  html += '.row{display:flex;justify-content:space-between;align-items:flex-end;gap:4px;line-height:1.3}';
  // min-width:0 no label: sem isso um flex item não encolhe abaixo do próprio
  // conteúdo e empurra o valor pra fora da coluna — que é exatamente como
  // "R$ 289,99" some numa térmica. Agora quem quebra é o label; o valor, que
  // é o que o consumidor confere, chega inteiro.
  html += '.row span:first-child{flex:1;min-width:0;text-align:left;overflow-wrap:anywhere}';
  html += '.row span:last-child{flex:0 0 auto;text-align:right;white-space:nowrap}';
  // Header com logo
  html += '.header{display:flex;align-items:center;gap:2.5mm;margin-bottom:1mm}';
  html += '.header .logo-img,.header .logo-fallback{flex-shrink:0;width:14mm;height:14mm;border-radius:1.5mm;background:#fff}';
  html += '.header .logo-img{object-fit:contain;border:1px solid #ddd}';
  html += '.header .logo-fallback{border:1.2px solid #000;display:flex;align-items:center;justify-content:center;font-size:9pt;font-weight:800;line-height:1}';
  html += '.header .empresa-info{flex:1;min-width:0;text-align:left}';
  html += '.header .nome{font-size:9.5pt;font-weight:700;text-transform:uppercase;line-height:1.15;margin-bottom:0.5mm;word-break:break-word}';
  html += '.header .info{font-size:7pt;line-height:1.25;color:#000}';
  // Título e subtítulo
  html += '.titulo{text-align:center;font-size:8.5pt;font-weight:700;margin:1mm 0 0.5mm 0;text-transform:uppercase;letter-spacing:0.3pt}';
  html += '.subtitulo{text-align:center;font-size:6.5pt;line-height:1.2;margin-bottom:0.5mm}';
  // Section label
  html += '.section-label{font-size:6.5pt;font-weight:700;text-transform:uppercase;letter-spacing:0.3pt;color:#000;margin-top:1.5mm;margin-bottom:0.8mm}';
  // Itens
  html += '.item{margin-bottom:1mm;font-size:7.8pt;line-height:1.2}';
  html += '.item-name{font-weight:600;word-break:break-word}';
  html += '.item-calc{text-align:right;font-size:7.5pt;color:#000}';
  // Total
  html += '.total-row{font-size:10.5pt;font-weight:800;margin-top:1.5mm}';
  // QR — SVG inline (era <img> remoto do qrserver.com até 16/07/2026)
  html += '.qr-wrap{text-align:center;margin:2mm 0 1mm 0}';
  html += '.qr-wrap svg{display:inline-block;width:28mm;height:28mm}';
  // Consulta
  html += '.consulta{text-align:center;font-size:6.5pt;line-height:1.2;margin:1mm 0}';
  // Chave acesso
  html += '.chave{font-size:7.5pt;font-weight:700;text-align:center;letter-spacing:0.2pt;line-height:1.4;word-break:break-all;margin:1mm 0}';
  // Protocolo / consumidor
  html += '.protocol{font-size:6.5pt;text-align:center;line-height:1.3}';
  html += '.consumidor{font-size:7.5pt;line-height:1.3}';
  // Aviso homologação
  html += '.homolog-warn{text-align:center;border:2px dashed #dc2626;padding:1.5mm;font-size:7.5pt;font-weight:700;color:#dc2626;margin:1mm 0}';
  html += '.conting-warn{text-align:center;border:2px solid #000;padding:1.5mm;font-size:7.5pt;font-weight:800;margin:1mm 0}';
  html += '.via-label{text-align:center;font-size:6.5pt;font-weight:700;letter-spacing:0.5pt;text-transform:uppercase;margin-bottom:1mm}';
  // Marca Aura discreta (só texto, sem QR)
  html += '.aura-mark{text-align:center;margin-top:2.5mm;padding-top:1.5mm;border-top:1px dotted #888;font-size:5.5pt;color:#666;font-style:italic;letter-spacing:0.3pt}';
  html += '</style></head><body>';

  // ========== Toolbar de tela (some no print) ==========
  // Fallback manual: se o auto-print falhar por qualquer motivo, o operador
  // ainda tem um botão. NUNCA remover — foi o único caminho que funcionou pro
  // Davi enquanto o bug do race estava vivo.
  html += '<div class="print-toolbar">';
  html += `<span>DANFE NFC-e #${numero} — 80mm térmica</span>`;
  html += '<button onclick="window.print()">Imprimir</button>';
  html += '</div>';

  // ========== PÁGINA (1 ou 2 vias) ==========
  let page = '';

  // Aviso homologação (se aplicável)
  if (isHomologacao) {
    page += '<div class="homolog-warn">EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO<br>SEM VALOR FISCAL</div>';
  }

  // ===== Header: logo à esquerda + dados empresa =====
  page += '<div class="header">';
  page += logoHtml;
  page += '<div class="empresa-info">';
  page += `<div class="nome">${escapeHtml(empresaNome)}</div>`;
  page += '<div class="info">';
  page += `CNPJ ${cnpj}`;
  if (ie) page += `<br>IE ${escapeHtml(ie)}`;
  if (enderecoLinha1) page += `<br>${escapeHtml(enderecoLinha1)}`;
  if (enderecoLinha2) page += ` — ${escapeHtml(enderecoLinha2)}`;
  if (enderecoLinha3 || cep) page += `<br>${escapeHtml(enderecoLinha3)}${cep ? ' · ' + escapeHtml(cep) : ''}`;
  page += '</div>';
  page += '</div>';
  page += '</div>';

  page += '<div class="divider"></div>';

  // Título DANFE
  page += '<div class="titulo">DANFE NFC-e</div>';
  page += '<div class="subtitulo">Documento Auxiliar da NF-e ao Consumidor<br>Não permite aproveitamento de crédito de ICMS</div>';

  page += '<div class="divider"></div>';

  // Itens
  page += '<div class="section-label">Itens</div>';
  page += itemsHtml;

  page += '<div class="divider"></div>';

  // Totais
  page += `<div class="row"><span>Qtd. itens</span><span>${totalQty}</span></div>`;
  if (totalDiscount > 0) {
    page += `<div class="row"><span>Subtotal</span><span>R$ ${formatBRL(totalProducts)}</span></div>`;
    page += `<div class="row"><span>Desconto</span><span>− R$ ${formatBRL(totalDiscount)}</span></div>`;
  }
  page += `<div class="row total-row"><span>VALOR TOTAL</span><span>R$ ${formatBRL(totalNfce)}</span></div>`;

  page += '<div class="divider"></div>';

  // Pagamentos
  page += '<div class="section-label">Forma de Pagamento</div>';
  page += paymentsHtml;
  // Tributos aproximados (Lei 12.741) — placeholder neutro
  page += '<div class="row small mt1"><span>Trib. aprox. (Lei 12.741)</span><span>conforme NCM</span></div>';

  page += '<div class="divider"></div>';

  // Consumidor
  page += '<div class="section-label">Consumidor</div>';
  if (cpfNota || nomeCliente) {
    page += '<div class="consumidor">';
    if (cpfNota) page += `CPF ${escapeHtml(cpfNota)}`;
    if (cpfNota && nomeCliente) page += '<br>';
    if (nomeCliente) page += `${escapeHtml(nomeCliente)}`;
    page += '</div>';
  } else {
    page += '<div class="consumidor">Consumidor não identificado</div>';
  }

  page += '<div class="divider"></div>';

  // Info NFC-e
  page += '<div class="section-label">Info NFC-e</div>';
  page += `<div class="small">NFC-e nº <b>${escapeHtml(String(numero))}</b> · Série ${escapeHtml(String(serie))}<br>`;
  page += `Emitida em ${escapeHtml(dataEmissao)}</div>`;
  if (protocolo && !String(protocolo).startsWith('HOMOLOG-')) {
    page += `<div class="protocol mt1">Protocolo de Autorização<br>${escapeHtml(protocolo)}</div>`;
  }

  page += '<div class="divider"></div>';

  // Chave acesso
  page += '<div class="section-label center">Chave de Acesso</div>';
  page += `<div class="chave">${chaveHtml}</div>`;

  // QR único (SEFAZ) 28mm — SVG inline, sem request
  if (qrSvg) page += `<div class="qr-wrap">${qrSvg}</div>`;
  page += '<div class="consulta tiny">Consulte pela chave em<br>';
  page += `<b>${escapeHtml(consultaUrl.replace(/^https?:\/\//, ''))}</b></div>`;

  // ===== Marca Aura discreta (só texto) =====
  page += '<div class="aura-mark">gerado por Aura · getaura.com.br</div>';


  const contingBanner = '<div class="conting-warn">EMITIDA EM CONTINGÊNCIA'
    + (protocolo ? '' : '<br>Pendente de autorização da SEFAZ')
    + '</div>';
  if (isContingencia) {
    // Contingência offline: DUAS vias obrigatórias (consumidor + estabelecimento)
    html += '<div class="page">' + contingBanner + '<div class="via-label">Via do Consumidor</div>' + page + '</div>';
    html += '<div class="page">' + contingBanner + '<div class="via-label">Via do Estabelecimento</div>' + page + '</div>';
  } else {
    html += '<div class="page"><div class="via-label">Via do Consumidor</div>' + page + '</div>';
  }

  // Dispara o print sem depender de window.onload/readyState — ver o porquê
  // em utils/autoPrintScript.js.
  html += autoPrintScript({ delayMs: 250, bailMs: 3000 });

  html += '</body></html>';
  return html;
}

module.exports = {
  buildDanfeNfceHtml,
  // helpers expostos pra teste
  formatCnpj, formatCpf, formatChaveAcesso, formatDateBR, formatBRL, getInitials,
  QR_OPTS,
};
