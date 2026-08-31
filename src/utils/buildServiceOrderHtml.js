// ============================================================================
// AURA. — Gerador HTML da Ordem de Servico (A4)
//
// Pedido (31/08/2026): folha A4, logo e marca do CLIENTE no topo, Aura apenas
// discreta no rodape. Ou seja: o documento e da loja, nao da Aura.
//
// Uso:
//   const { buildServiceOrderHtml } = require('../utils/buildServiceOrderHtml');
//   res.type('html').send(buildServiceOrderHtml({ os, items, company, brand }));
//
// Largura (licao da DANFE, 31/08/2026): a coluna e DECLARADA e vale igual na
// tela e no print. O bug da termica nasceu de `.page` ter uma largura na tela e
// outra no `@media print` — a pre-visualizacao mostrava um documento que cabia
// e o papel saia outro. Aqui `.page` tem 182mm (A4 210mm menos as margens de
// 14mm) nos dois meios, e o `@media print` so tira sombra e toolbar.
// ============================================================================

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
  return v.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function formatCnpj(cnpj) {
  const d = String(cnpj || '').replace(/\D/g, '');
  if (d.length !== 14) return String(cnpj || '');
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

// Fuso EXPLICITO. getDate()/getHours() leem o fuso do PROCESSO: na maquina do
// dev (UTC-3) o horario sai certo e no Railway (UTC) sai 3h adiantado — o
// documento diria que o cliente deixou o aparelho as 09:15 quando ele chegou
// as 06:15. Como a OS carimba hora de entrega e de assinatura, isso vira
// discussao no balcao. Mesmo tratamento que print.js ja usa no carne.
const TZ = 'America/Sao_Paulo';

function formatDateBR(dt, comHora = true) {
  if (!dt) return '';
  const d = dt instanceof Date ? dt : new Date(dt);
  if (isNaN(d.getTime())) return '';
  const opts = comHora
    ? { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
    : { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' };
  // pt-BR devolve "25/08/2026, 06:15" com hora; a virgula nao serve ao layout.
  return d.toLocaleString('pt-BR', opts).replace(',', '');
}

function getInitials(name) {
  if (!name) return '?';
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

const STATUS_LABEL = {
  aberta:      'Aberta',
  em_execucao: 'Em execução',
  pronta:      'Pronta para retirada',
  entregue:    'Entregue',
  cancelada:   'Cancelada',
};

const KIND_LABEL = { servico: 'Serviço', peca: 'Peça' };

// Garantia expressa em data, nao em "90 dias". O cliente guarda o papel por
// meses; "90 dias" obriga ele a lembrar de quando contou, e a discussao no
// balcao vira a palavra de um contra a do outro.
function garantiaAte(os) {
  const dias = Number(os.warranty_days) || 0;
  if (dias <= 0) return null;
  const base = os.delivered_at || os.created_at;
  if (!base) return null;
  const d = new Date(base);
  if (isNaN(d.getTime())) return null;
  // Soma em milissegundos, nao setDate(): setDate() opera no fuso do processo
  // e daria dias diferentes conforme onde o codigo roda. O Brasil nao tem
  // horario de verao desde 2019, entao 86.400.000 ms e sempre um dia.
  return new Date(d.getTime() + dias * 86400000);
}

// ============================================================
// Builder principal
// ============================================================
// autoprint: false por padrao. Diferente do cupom, a OS e conferida na tela
// antes de sair (o balconista revisa o estado do aparelho com o cliente na
// frente); disparar o dialogo de impressao sozinho atrapalha em vez de ajudar.
function buildServiceOrderHtml({ os, items = [], company, brand = {}, autoprint = false }) {
  if (!os) throw new Error('os obrigatório');
  if (!company) throw new Error('company obrigatório');

  // Armadilha #2 do CLAUDE.md: companies nao tem coluna `name`.
  const empresaNome = company.trade_name || company.legal_name || 'Empresa';
  // Marca do lojista: a vitrine (digital_channel_config) e a fonte mais rica
  // — logo, cor e nome do site. companies.logo_url e o fallback.
  const logoUrl = brand.logo_url || company.logo_url || null;
  const cor = /^#[0-9a-fA-F]{3,8}$/.test(String(brand.primary_color || '')) ? brand.primary_color : '#1f2937';

  const numero = os.os_number != null ? String(os.os_number) : String(os.id || '').slice(-8).toUpperCase();
  const statusLabel = STATUS_LABEL[os.status] || os.status || '';

  const enderecoLinha = [
    [company.address_street, company.address_number].filter(Boolean).join(', '),
    company.address_district,
    [company.address_city, company.address_state].filter(Boolean).join(' - '),
  ].filter(Boolean).join(' — ');

  const totalItens = items.reduce((s, i) => s + (Number(i.total_price) || 0), 0);
  const totalOrcado = Number(os.estimated_amount) || totalItens;
  const gAte = garantiaAte(os);

  const logoHtml = logoUrl
    ? `<img class="logo" src="${escapeHtml(logoUrl)}" alt="">`
    : `<div class="logo logo-fb">${escapeHtml(getInitials(empresaNome))}</div>`;

  // ── Itens ──
  let itensHtml = '';
  if (items.length) {
    itensHtml += '<table class="tab"><thead><tr>'
      + '<th class="l">Descrição</th><th class="c">Tipo</th><th class="r">Qtd</th>'
      + '<th class="r">Unit.</th><th class="r">Total</th></tr></thead><tbody>';
    items.forEach((it) => {
      itensHtml += '<tr>'
        + `<td class="l">${escapeHtml(it.description || '')}</td>`
        + `<td class="c">${escapeHtml(KIND_LABEL[it.kind] || it.kind || '')}</td>`
        + `<td class="r">${escapeHtml(String(Number(it.quantity) || 0).replace('.', ','))}</td>`
        + `<td class="r">${formatBRL(it.unit_price)}</td>`
        + `<td class="r">${formatBRL(it.total_price)}</td>`
        + '</tr>';
    });
    itensHtml += '</tbody></table>';
  } else {
    itensHtml = '<div class="vazio">Nenhum item orçado até o momento.</div>';
  }

  // ── Assinaturas ──
  // Se ja assinou, imprime a imagem; senao imprime a linha pra assinar no
  // balcao. O mesmo documento serve pros dois momentos.
  function blocoAssinatura(titulo, url, quando, legenda) {
    const corpo = url
      ? `<img class="assin-img" src="${escapeHtml(url)}" alt="">`
      : '<div class="assin-linha"></div>';
    const data = quando ? `<div class="assin-data">Assinado em ${escapeHtml(formatDateBR(quando))}</div>` : '';
    return `<div class="assin">
      <div class="assin-tit">${escapeHtml(titulo)}</div>
      ${corpo}
      <div class="assin-rot">${escapeHtml(legenda)}</div>
      ${data}
    </div>`;
  }

  let h = '';
  h += '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">';
  h += `<title>Ordem de Serviço nº ${escapeHtml(numero)} — ${escapeHtml(empresaNome)}</title>`;
  h += '<style>';
  h += '@page{size:A4;margin:14mm}';
  h += '*{margin:0;padding:0;box-sizing:border-box}';
  h += 'html,body{background:#f3f4f6;color:#111;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;font-size:10pt;line-height:1.4}';
  // 182mm = A4 (210mm) menos as duas margens de 14mm. Mesma largura na tela e
  // no papel — ver o cabecalho deste arquivo.
  h += '.page{width:182mm;margin:0 auto;background:#fff;color:#111}';
  h += '@media screen{body{padding:28px 0}.page{padding:14mm;box-shadow:0 4px 24px rgba(0,0,0,.15)}';
  h += '.toolbar{position:fixed;top:0;left:0;right:0;background:#1a1a2e;color:#fff;padding:10px 20px;display:flex;align-items:center;justify-content:space-between;z-index:99}';
  h += '.toolbar button{background:#7c3aed;color:#fff;border:0;padding:8px 18px;border-radius:6px;font-weight:700;cursor:pointer}';
  h += '.toolbar span{font-size:12px;color:#a78bfa}}';
  h += '@media print{body{background:#fff}.page{box-shadow:none;padding:0}.toolbar{display:none!important}';
  // Sem isto a cor da marca do lojista sai cinza na impressora.
  h += 'body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}';
  // Header
  h += '.hd{display:flex;align-items:flex-start;gap:6mm;padding-bottom:4mm;border-bottom:2.5pt solid ' + cor + '}';
  h += '.logo{flex:0 0 auto;width:24mm;height:24mm;object-fit:contain;border-radius:2mm}';
  h += '.logo-fb{display:flex;align-items:center;justify-content:center;border:1.5pt solid ' + cor + ';color:' + cor + ';font-size:15pt;font-weight:800}';
  h += '.hd-info{flex:1;min-width:0}';
  h += '.hd-nome{font-size:15pt;font-weight:800;color:' + cor + ';line-height:1.15;margin-bottom:1mm}';
  h += '.hd-sub{font-size:8.5pt;color:#444;line-height:1.35}';
  h += '.hd-os{flex:0 0 auto;text-align:right}';
  h += '.hd-os .rot{font-size:8pt;letter-spacing:.5pt;text-transform:uppercase;color:#666}';
  h += '.hd-os .num{font-size:20pt;font-weight:800;color:' + cor + ';line-height:1}';
  h += '.badge{display:inline-block;margin-top:1.5mm;padding:1mm 3mm;border-radius:99px;border:1pt solid ' + cor + ';color:' + cor + ';font-size:8pt;font-weight:700}';
  // Blocos
  h += '.bl{margin-top:5mm;break-inside:avoid}';
  h += '.bl-tit{font-size:8.5pt;font-weight:800;text-transform:uppercase;letter-spacing:.6pt;color:' + cor + ';border-bottom:.8pt solid #ddd;padding-bottom:1mm;margin-bottom:2mm}';
  h += '.grid{display:flex;flex-wrap:wrap;gap:2mm 6mm}';
  h += '.f{flex:1 1 42%;min-width:0;font-size:9.5pt}';
  h += '.f .k{font-size:7.5pt;text-transform:uppercase;letter-spacing:.4pt;color:#777;display:block}';
  h += '.f .v{font-weight:600;overflow-wrap:anywhere}';
  h += '.txt{font-size:9.5pt;white-space:pre-wrap;overflow-wrap:anywhere;background:#fafafa;border-left:2pt solid ' + cor + ';padding:2mm 3mm}';
  h += '.vazio{font-size:9pt;color:#888;font-style:italic}';
  // Tabela
  h += '.tab{width:100%;border-collapse:collapse;font-size:9.5pt}';
  h += '.tab th{background:#f4f4f5;font-size:7.5pt;text-transform:uppercase;letter-spacing:.4pt;color:#555;padding:1.5mm 2mm;border-bottom:.8pt solid #ddd}';
  h += '.tab td{padding:1.5mm 2mm;border-bottom:.5pt solid #eee;vertical-align:top}';
  h += '.l{text-align:left}.c{text-align:center}.r{text-align:right;white-space:nowrap}';
  h += '.tot{display:flex;justify-content:flex-end;gap:6mm;align-items:baseline;margin-top:2.5mm}';
  h += '.tot .k{font-size:9pt;color:#555}';
  h += '.tot .v{font-size:14pt;font-weight:800;color:' + cor + '}';
  // Assinaturas
  h += '.assins{display:flex;gap:8mm;margin-top:9mm;break-inside:avoid}';
  h += '.assin{flex:1;text-align:center}';
  h += '.assin-tit{font-size:7.5pt;text-transform:uppercase;letter-spacing:.5pt;color:#777;margin-bottom:8mm}';
  h += '.assin-img{max-width:100%;max-height:18mm;object-fit:contain;display:block;margin:0 auto 1mm}';
  h += '.assin-linha{border-bottom:.8pt solid #333;margin-bottom:1mm}';
  h += '.assin-rot{font-size:8pt;color:#555}';
  h += '.assin-data{font-size:7pt;color:#888;margin-top:.5mm}';
  // Termos + rodape
  h += '.termos{margin-top:6mm;font-size:7.5pt;color:#666;line-height:1.45;break-inside:avoid}';
  h += '.rodape{margin-top:7mm;padding-top:2mm;border-top:.5pt dotted #bbb;display:flex;justify-content:space-between;font-size:7pt;color:#999}';
  h += '</style></head><body>';

  h += '<div class="toolbar"><span>Ordem de Serviço nº ' + escapeHtml(numero) + ' — A4</span>';
  h += '<button onclick="window.print()">Imprimir</button></div>';

  h += '<div class="page">';

  // ===== Header: marca do CLIENTE =====
  h += '<div class="hd">';
  h += logoHtml;
  h += '<div class="hd-info">';
  h += `<div class="hd-nome">${escapeHtml(empresaNome)}</div>`;
  h += '<div class="hd-sub">';
  if (company.cnpj) h += `CNPJ ${escapeHtml(formatCnpj(company.cnpj))}`;
  if (company.inscricao_estadual) h += ` &middot; IE ${escapeHtml(company.inscricao_estadual)}`;
  if (enderecoLinha) h += `<br>${escapeHtml(enderecoLinha)}`;
  const contato = [
    company.phone ? escapeHtml(company.phone) : null,
    brand.whatsapp ? 'WhatsApp ' + escapeHtml(brand.whatsapp) : null,
  ].filter(Boolean).join(' &middot; ');
  if (contato) h += `<br>${contato}`;
  h += '</div></div>';
  h += '<div class="hd-os"><div class="rot">Ordem de Serviço</div>';
  h += `<div class="num">nº ${escapeHtml(numero)}</div>`;
  h += `<div class="badge">${escapeHtml(statusLabel)}</div></div>`;
  h += '</div>';

  // ===== Cliente / datas =====
  h += '<div class="bl"><div class="bl-tit">Cliente</div><div class="grid">';
  h += `<div class="f"><span class="k">Nome</span><span class="v">${escapeHtml(os.customer_name || '')}</span></div>`;
  if (os.customer_phone) h += `<div class="f"><span class="k">Telefone</span><span class="v">${escapeHtml(os.customer_phone)}</span></div>`;
  h += `<div class="f"><span class="k">Abertura</span><span class="v">${escapeHtml(formatDateBR(os.created_at))}</span></div>`;
  if (os.promised_at) h += `<div class="f"><span class="k">Prazo previsto</span><span class="v">${escapeHtml(formatDateBR(os.promised_at))}</span></div>`;
  if (os.technician_name) h += `<div class="f"><span class="k">Técnico responsável</span><span class="v">${escapeHtml(os.technician_name)}</span></div>`;
  if (os.delivered_at) h += `<div class="f"><span class="k">Entrega</span><span class="v">${escapeHtml(formatDateBR(os.delivered_at))}</span></div>`;
  h += '</div></div>';

  // ===== Equipamento =====
  const temEquip = os.equipment_type || os.equipment_brand || os.equipment_model
    || os.equipment_serial || os.equipment_accessories || os.equipment_condition;
  if (temEquip) {
    h += '<div class="bl"><div class="bl-tit">Equipamento recebido</div><div class="grid">';
    if (os.equipment_type)   h += `<div class="f"><span class="k">Tipo</span><span class="v">${escapeHtml(os.equipment_type)}</span></div>`;
    if (os.equipment_brand)  h += `<div class="f"><span class="k">Marca</span><span class="v">${escapeHtml(os.equipment_brand)}</span></div>`;
    if (os.equipment_model)  h += `<div class="f"><span class="k">Modelo</span><span class="v">${escapeHtml(os.equipment_model)}</span></div>`;
    if (os.equipment_serial) h += `<div class="f"><span class="k">Nº de série</span><span class="v">${escapeHtml(os.equipment_serial)}</span></div>`;
    if (os.equipment_accessories) h += `<div class="f"><span class="k">Acessórios</span><span class="v">${escapeHtml(os.equipment_accessories)}</span></div>`;
    h += '</div>';
    if (os.equipment_condition) {
      h += '<div class="f" style="margin-top:2mm"><span class="k">Estado na entrada</span></div>';
      h += `<div class="txt">${escapeHtml(os.equipment_condition)}</div>`;
    }
    h += '</div>';
  }

  // ===== Defeito relatado =====
  h += '<div class="bl"><div class="bl-tit">Defeito relatado pelo cliente</div>';
  h += `<div class="txt">${escapeHtml(os.reported_issue || '')}</div></div>`;

  // ===== Diagnostico / solucao =====
  if (os.diagnosis) {
    h += '<div class="bl"><div class="bl-tit">Diagnóstico técnico</div>';
    h += `<div class="txt">${escapeHtml(os.diagnosis)}</div></div>`;
  }
  if (os.solution) {
    h += '<div class="bl"><div class="bl-tit">Serviço executado</div>';
    h += `<div class="txt">${escapeHtml(os.solution)}</div></div>`;
  }

  // ===== Orcamento =====
  h += '<div class="bl"><div class="bl-tit">Orçamento</div>';
  h += itensHtml;
  h += `<div class="tot"><span class="k">Total orçado</span><span class="v">R$ ${formatBRL(totalOrcado)}</span></div>`;
  if (os.approved_at) {
    h += `<div class="vazio" style="margin-top:1.5mm">Orçamento aprovado pelo cliente em ${escapeHtml(formatDateBR(os.approved_at))}.</div>`;
  }
  h += '</div>';

  // ===== Garantia =====
  if (gAte) {
    h += '<div class="bl"><div class="bl-tit">Garantia</div><div class="grid">';
    h += `<div class="f"><span class="k">Prazo</span><span class="v">${escapeHtml(String(os.warranty_days))} dias</span></div>`;
    h += `<div class="f"><span class="k">Válida até</span><span class="v">${escapeHtml(formatDateBR(gAte, false))}</span></div>`;
    h += '</div></div>';
  }

  // ===== Observacoes =====
  if (os.notes) {
    h += '<div class="bl"><div class="bl-tit">Observações</div>';
    h += `<div class="txt">${escapeHtml(os.notes)}</div></div>`;
  }

  // ===== Assinaturas =====
  h += '<div class="assins">';
  h += blocoAssinatura('Entrega do equipamento', os.intake_signature_url, os.intake_signed_at, os.customer_name || 'Cliente');
  h += blocoAssinatura('Retirada do equipamento', os.pickup_signature_url, os.pickup_signed_at, os.customer_name || 'Cliente');
  h += '</div>';

  h += '<div class="termos">';
  h += 'O cliente declara que o equipamento foi entregue nas condições descritas acima. '
    + 'A garantia cobre exclusivamente o serviço executado e as peças substituídas, não se estendendo a '
    + 'defeitos alheios ao reparo. Equipamentos não retirados em até 90 dias após a comunicação de '
    + 'conclusão poderão ser cobrados por armazenagem, nos termos do Art. 1.275 do Código Civil.';
  h += '</div>';

  // ===== Rodape: Aura discreta (pedido explicito) =====
  h += '<div class="rodape">';
  h += `<span>${escapeHtml(empresaNome)} — OS nº ${escapeHtml(numero)}</span>`;
  h += '<span>gerado por Aura · getaura.com.br</span>';
  h += '</div>';

  h += '</div>'; // .page
  // Mesmo script da DANFE e do carne: nao depende de onload nem de readyState.
  if (autoprint) h += autoPrintScript({ delayMs: 350 });
  h += '</body></html>';
  return h;
}

module.exports = {
  buildServiceOrderHtml,
  // expostos pra teste
  formatBRL, formatCnpj, formatDateBR, getInitials, garantiaAte,
  STATUS_LABEL,
};
