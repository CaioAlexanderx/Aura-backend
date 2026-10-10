// ============================================================================
// AURA. — Gerador HTML do carnê de crediário em A4 (10/10/2026)
//
// Pedido: além da bobina, o carnê sai em folha A4 COM A MARCA DA LOJA — logo,
// nome fantasia, endereço e telefone no topo, faixa na cor da marca — e cada
// parcela a pagar vira um cupom destacável (canhoto "Via da loja" | via do
// cliente | QR Pix). Mockup aprovado: aura-app/docs/mockups/
// crediario-carne-a4-e-termica.html, aba "Folha A4".
//
// Mesmo padrão da Ordem de Serviço (buildServiceOrderHtml.js):
//   - documento é da LOJA; a Aura fica só no rodapé;
//   - `.page` tem 182mm (A4 210mm menos 2 x 14mm de margem) na tela E no
//     print — lição da DANFE: largura diferente nos dois meios faz a prévia
//     mostrar um documento e o papel sair outro;
//   - fuso explícito America/Sao_Paulo (o processo roda em UTC no Railway);
//   - QR embutido como SVG (qrInline), sem recurso remoto para o Pix.
//
// Função PURA: recebe os dados já carregados. Quem consulta é a rota
// GET /print/credit/:cid/carne?format=a4 (routes/print.js). O copia-e-cola de
// cada parcela chega pronto em `installment.pix_payload`; sem ele o cupom sai
// sem coluna de QR e sem copia-e-cola — nada é inventado no lugar.
// ============================================================================
'use strict';

const { autoPrintScript } = require('./autoPrintScript');
const { qrInlineSvg } = require('./qrInline');

const TZ = 'America/Sao_Paulo';
const COR_NEUTRA = '#1f2937';
/** Resíduo (R$) abaixo do qual a parcela conta como quitada no papel. */
const CENT = 0.005;

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
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

// Telefone com máscara (10/10/2026): o cadastro guarda só dígitos e o cabeçalho
// saía '6681573761'. Mesmo formato do buildWarrantyHtml; fora de 10/11 dígitos
// sai como foi cadastrado.
function formatPhone(v) {
  let d = String(v || '').replace(/D/g, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return String(v || '');
}

// Documento do cliente: 11 dígitos é CPF, 14 é CNPJ; qualquer outra coisa sai
// como foi cadastrada (melhor um documento sem máscara do que um errado).
function formatDocumento(doc) {
  const d = String(doc || '').replace(/\D/g, '');
  if (d.length === 11) {
    return { rotulo: 'CPF', valor: `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` };
  }
  if (d.length === 14) return { rotulo: 'CNPJ', valor: formatCnpj(d) };
  return { rotulo: 'CPF/CNPJ', valor: String(doc || '') };
}

function getInitials(name) {
  if (!name) return '?';
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// Instante (timestamptz: data da compra, pago em, emissão) -> dia em São Paulo.
function formatDiaSP(dt) {
  if (!dt) return '';
  const d = dt instanceof Date ? dt : new Date(dt);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Vencimento é DATE (dia-calendário, sem fuso). A rota manda `due_date_br` já
// formatado pelo banco; o fallback lê o dia em UTC, como o carnê térmico
// sempre fez — aplicar o fuso de São Paulo aqui voltaria um dia.
function formatVencimento(inst) {
  if (inst && inst.due_date_br) return String(inst.due_date_br);
  const raw = inst && inst.due_date;
  if (!raw) return '—';
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return `${raw.slice(8, 10)}/${raw.slice(5, 7)}/${raw.slice(0, 4)}`;
  }
  const d = raw instanceof Date ? raw : new Date(raw);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatQtd(q) {
  if (q === null || q === undefined) return '';
  const n = Number(q);
  if (!Number.isFinite(n)) return '';
  return String(round2(n)).replace('.', ',');
}

// Quanto falta de PRINCIPAL numa parcela (encargos de atraso não entram no
// papel: mudam todo dia).
function remainingOf(inst) {
  return round2(Math.max(0, num(inst.amount_due) - num(inst.covered_amount)));
}

// Em atraso: a rota manda `past_due` (vencimento < hoje em São Paulo, calculado
// no banco). O status persistido é só fallback — ele fica congelado entre uma
// sincronização e outra (ver services/credit/overdue.js).
function isLate(inst) {
  if (typeof inst.past_due === 'boolean') return inst.past_due;
  return inst.status === 'overdue';
}

/**
 * Separa as parcelas de um grupo em pagas e a pagar. Canceladas ficam FORA do
 * papel. Usado pelos dois formatos (A4 aqui, térmica em routes/print.js) para
 * que os dois contem a mesma história.
 *
 * Paga = status 'paid' OU sem resto de principal. A pagar = o restante.
 *
 * @returns {{ paid: object[], open: object[] }} cada item é a parcela original
 *          acrescida de `remaining` (principal que falta) e `late`.
 */
function classifyInstallments(installments) {
  const paid = [];
  const open = [];
  for (const inst of installments || []) {
    if (!inst || inst.status === 'cancelled') continue;
    const remaining = remainingOf(inst);
    if (inst.status === 'paid' || remaining <= CENT) {
      paid.push({ ...inst, remaining: 0, late: false });
    } else {
      open.push({ ...inst, remaining, late: isLate(inst) });
    }
  }
  return { paid, open };
}

/**
 * Resumo do topo: Comprou / Já pagou / Falta pagar.
 *
 * A conta sai das PARCELAS EXIBIDAS (não canceladas), de propósito — é o que
 * o cliente consegue conferir com o dedo no papel:
 *
 *   Comprou      = soma de amount_due de todas as parcelas exibidas
 *   Falta pagar  = soma do resto de principal (amount_due - covered_amount)
 *                  das parcelas a pagar = soma dos valores dos cupons
 *   Já pagou     = Comprou - Falta pagar
 *                = valor cheio das parcelas pagas + o que já foi abatido das
 *                  parcelas a pagar (pagamento parcial)
 *
 * Então Comprou = Já pagou + Falta pagar SEMPRE, e "Falta pagar" é a soma dos
 * cupons impressos logo abaixo. Não usamos o saldo do razão
 * (customer_credit_balances): razão e parcelas são duas fontes de verdade que
 * podem divergir (juros de renegociação, crédito a favor, parcela órfã), e um
 * resumo que não fecha com as parcelas da própria folha vira discussão no
 * balcão. Encargos de atraso não entram (ver nota do rodapé).
 */
function summarize(groups) {
  let comprou = 0;
  let falta = 0;
  for (const g of groups || []) {
    const { paid, open } = classifyInstallments(g.installments);
    for (const i of paid) comprou += num(i.amount_due);
    for (const i of open) { comprou += num(i.amount_due); falta += i.remaining; }
  }
  comprou = round2(comprou);
  falta = round2(falta);
  return { comprou, pagou: round2(comprou - falta), falta };
}

// ============================================================
// Builder principal
// ============================================================
/**
 * @param {object} args
 * @param {object} args.company  { trade_name, legal_name, cnpj, phone, logo_url,
 *                                 address_street, address_number, address_district,
 *                                 address_city, address_state, address }
 * @param {object} [args.brand]  digital_channel_config { logo_url, primary_color }
 * @param {object} args.customer { name, phone, cpf_cnpj }
 * @param {Array}  [args.groups] [{ key, name, closed, installments, purchases }]
 *        installments: { installment_number, total_installments, amount_due,
 *                        covered_amount, due_date, due_date_br, paid_at, status,
 *                        past_due, pix_payload }
 *        purchases:    { lines: [{ date, description, quantity, amount }], total } | null
 * @param {string}  [args.carneName] nome do carnê quando a folha é de UM carnê
 *        só (?account=). Vai no cabeçalho; o resumo já é do carnê porque sai
 *        dos grupos recebidos — a rota manda só aquele.
 * @param {boolean} [args.autoprint=true] o carnê sempre abriu direto no diálogo
 *        de impressão (formato térmico); o A4 segue o mesmo comportamento.
 * @param {Date}    [args.now] instante da emissão (injetável para teste)
 */
function buildCarneA4Html({ company, brand = {}, customer, groups = [], carneName = null, autoprint = true, now } = {}) {
  if (!company) throw new Error('company obrigatório');
  if (!customer) throw new Error('customer obrigatório');

  // companies não tem coluna `name`.
  const lojaNome = company.trade_name || company.legal_name || 'Loja';
  const logoUrl = (brand && brand.logo_url) || company.logo_url || null;
  const cor = /^#[0-9a-fA-F]{3,8}$/.test(String((brand && brand.primary_color) || ''))
    ? brand.primary_color : COR_NEUTRA;

  const enderecoEstruturado = [
    [company.address_street, company.address_number].filter(Boolean).join(', '),
    company.address_district,
    [company.address_city, company.address_state].filter(Boolean).join('/'),
  ].filter(Boolean).join(' — ');
  // Sem rua nem bairro cadastrados, o texto livre (companies.address) diz mais
  // do que só "Cidade/UF".
  const temRua = !!(company.address_street || company.address_district);
  const endereco = temRua ? enderecoEstruturado : (String(company.address || '').trim() || enderecoEstruturado);

  const contatoLoja = [
    company.phone ? escapeHtml(formatPhone(company.phone)) : null,
    company.cnpj ? 'CNPJ ' + escapeHtml(formatCnpj(company.cnpj)) : null,
  ].filter(Boolean).join(' &middot; ');

  const doc = customer.cpf_cnpj ? formatDocumento(customer.cpf_cnpj) : null;
  const contatoCliente = [
    customer.phone ? escapeHtml(formatPhone(customer.phone)) : null,
    doc && doc.valor ? escapeHtml(doc.rotulo) + ' ' + escapeHtml(doc.valor) : null,
  ].filter(Boolean).join(' &middot; ');

  // Só entram no papel os grupos com parcela viva.
  const grupos = (groups || [])
    .map(g => ({ ...g, ...classifyInstallments(g.installments) }))
    .filter(g => g.paid.length || g.open.length);
  const resumo = summarize(grupos);
  const variosGrupos = grupos.length > 1;
  const temPix = grupos.some(g => g.open.some(i => i.pix_payload));
  const emitidoEm = formatDiaSP(now || new Date());

  const logoHtml = logoUrl
    ? `<img class="logo" src="${escapeHtml(logoUrl)}" alt="">`
    : `<div class="logo logo-fb">${escapeHtml(getInitials(lojaNome))}</div>`;

  // ── Cupom destacável de uma parcela a pagar ──
  function slipHtml(inst) {
    const rotulo = `Parcela ${escapeHtml(inst.installment_number)}/${escapeHtml(inst.total_installments)}`;
    const venc = escapeHtml(formatVencimento(inst));
    const valor = 'R$ ' + formatBRL(inst.remaining);
    const payload = inst.pix_payload ? String(inst.pix_payload) : '';
    // QR que não gerou (payload inválido) = cupom sem Pix, igual a loja sem chave.
    const qr = payload ? qrInlineSvg(payload, { size: '28mm', margin: 1, ecc: 'M' }) : '';
    const comPix = !!(payload && qr);
    const selo = inst.late ? '<span class="late">Em atraso</span>' : '';
    const parcial = num(inst.covered_amount) > CENT
      ? `<div class="meta">Parcela de R$ ${formatBRL(inst.amount_due)} &middot; já pago R$ ${formatBRL(num(inst.amount_due) - inst.remaining)}</div>`
      : '';

    let s = `<div class="slip${comPix ? '' : ' sem-pix'}">`;
    s += '<div class="stub">';
    s += '<div class="lbl">Via da loja</div>';
    s += `<div class="big">${rotulo}</div>`;
    s += `<div>Venc. ${venc}</div>`;
    s += `<div><b>${valor}</b></div>`;
    s += `<div>${escapeHtml(customer.name || '')}</div>`;
    s += '<div class="sign">Recebido em ___/___/___ &nbsp; Visto</div>';
    s += '</div>';
    s += '<div class="main">';
    s += `<div class="top"><span class="num">${rotulo}${selo}</span><span class="val">${valor}</span></div>`;
    s += `<div class="due">Vencimento <b>${venc}</b></div>`;
    s += `<div class="meta">${escapeHtml(lojaNome)} &middot; ${escapeHtml(customer.name || '')}</div>`;
    s += parcial;
    if (comPix) {
      s += '<div class="lbl" style="margin-top:2mm">Pix copia e cola</div>';
      s += `<div class="emv">${escapeHtml(payload)}</div>`;
    }
    s += '</div>';
    if (comPix) s += `<div class="qr">${qr}<span>Pague com Pix</span></div>`;
    s += '</div>';
    return s;
  }

  function grupoHtml(g) {
    let s = '';
    if (variosGrupos) {
      const falta = round2(g.open.reduce((t, i) => t + i.remaining, 0));
      s += '<div class="grp">';
      s += `<span>${escapeHtml(g.name || 'Sem carnê')}${g.closed ? ' (encerrado)' : ''}</span>`;
      s += `<span>Falta pagar R$ ${formatBRL(falta)}</span>`;
      s += '</div>';
    }

    // O que foi comprado
    const linhas = (g.purchases && g.purchases.lines) || [];
    if (linhas.length) {
      s += '<h2>O que foi comprado</h2>';
      s += '<table><thead><tr><th>Data</th><th>Produto</th><th class="r">Qtd</th><th class="r">Valor</th></tr></thead><tbody>';
      for (const l of linhas) {
        s += '<tr>'
          + `<td class="nw">${escapeHtml(formatDiaSP(l.date))}</td>`
          + `<td>${escapeHtml(l.description)}</td>`
          + `<td class="r">${escapeHtml(formatQtd(l.quantity))}</td>`
          + `<td class="r">R$ ${formatBRL(l.amount)}</td>`
          + '</tr>';
      }
      s += '</tbody></table>';
    }

    // Parcelas pagas
    s += '<h2>Parcelas pagas</h2>';
    if (g.paid.length) {
      s += '<table><thead><tr><th>Parcela</th><th>Vencimento</th><th>Pago em</th><th class="r">Valor</th><th class="r">Situação</th></tr></thead><tbody>';
      for (const i of g.paid) {
        s += '<tr>'
          + `<td>${escapeHtml(i.installment_number)}/${escapeHtml(i.total_installments)}</td>`
          + `<td>${escapeHtml(formatVencimento(i))}</td>`
          + `<td>${escapeHtml(formatDiaSP(i.paid_at) || '—')}</td>`
          + `<td class="r">R$ ${formatBRL(i.amount_due)}</td>`
          + '<td class="r ok">Paga</td>'
          + '</tr>';
      }
      s += '</tbody></table>';
    } else {
      s += '<div class="vazio">Nenhuma parcela paga.</div>';
    }

    // Parcelas a pagar
    s += '<h2>Parcelas a pagar</h2>';
    if (g.open.length) s += g.open.map(slipHtml).join('');
    else s += '<div class="vazio">Nenhuma parcela a pagar.</div>';
    return s;
  }

  let h = '';
  h += '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">';
  h += `<title>Carnê de crediário — ${escapeHtml(customer.name || '')} — ${escapeHtml(lojaNome)}</title>`;
  h += '<style>';
  h += '@page{size:A4;margin:14mm}';
  h += '*{margin:0;padding:0;box-sizing:border-box}';
  h += 'html,body{background:#f4f4f5;color:#18181b;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:10.5pt;line-height:1.35}';
  // 182mm = A4 (210mm) menos as duas margens de 14mm. Mesma largura na tela e
  // no papel — ver o cabeçalho deste arquivo.
  h += '.page{width:182mm;margin:0 auto;background:#fff;color:#18181b}';
  h += '@media screen{body{padding:28px 0}.page{padding:14mm;box-sizing:content-box;box-shadow:0 2px 16px rgba(0,0,0,.12)}';
  h += '.toolbar{position:fixed;top:0;left:0;right:0;background:#1a1a2e;color:#fff;padding:10px 20px;display:flex;align-items:center;justify-content:space-between;z-index:99}';
  h += '.toolbar button{background:#7c3aed;color:#fff;border:0;padding:8px 18px;border-radius:6px;font-weight:700;cursor:pointer}';
  h += '.toolbar span{font-size:12px;color:#a78bfa}}';
  h += '@media print{html,body{background:#fff}.page{box-shadow:none;padding:0}.toolbar{display:none!important}';
  // Sem isto a faixa e o logo na cor da marca saem cinza na impressora.
  h += 'body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}';
  // Cabeçalho: marca da loja
  h += '.head{display:flex;gap:5mm;align-items:center;padding-bottom:4mm;border-bottom:.6mm solid ' + cor + '}';
  h += '.logo{flex:none;width:24mm;height:24mm;object-fit:contain;border-radius:3mm}';
  h += '.logo-fb{display:flex;align-items:center;justify-content:center;background:' + cor + ';color:#fff;font-weight:800;font-size:18pt}';
  h += '.store{flex:1;min-width:0}';
  h += '.store .name{font-size:17pt;font-weight:800;letter-spacing:-.01em;color:#18181b;overflow-wrap:anywhere}';
  h += '.store div{color:#52525b;font-size:9.5pt;overflow-wrap:anywhere}';
  h += '.doc{flex:none;text-align:right}';
  h += '.doc .t{font-size:12pt;font-weight:800;text-transform:uppercase;letter-spacing:.04em;color:' + cor + '}';
  h += '.doc div{font-size:9pt;color:#52525b}';
  h += '.doc .cn{font-weight:700;color:#18181b;overflow-wrap:anywhere;max-width:60mm}';
  // Cliente + resumo
  h += '.grid2{display:grid;grid-template-columns:1.2fr 1fr;gap:5mm;margin-top:5mm}';
  h += '.box{border:.3mm solid #e4e4e7;border-radius:2mm;padding:3mm 4mm;min-width:0}';
  h += '.lbl{font-size:7.5pt;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#71717a;margin-bottom:1mm}';
  h += '.box .v{font-weight:700;font-size:11.5pt;overflow-wrap:anywhere}';
  h += '.box .s{color:#52525b;font-size:9.5pt}';
  h += '.sum{display:grid;grid-template-columns:repeat(3,1fr);gap:3mm;text-align:center}';
  h += '.sum .n{font-size:12.5pt;font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap}';
  h += '.sum .open .n{color:' + cor + '}';
  // Grupo (só com mais de um carnê)
  h += '.grp{display:flex;justify-content:space-between;gap:4mm;margin-top:7mm;padding:2mm 3mm;border-left:1.2mm solid ' + cor + ';background:#fafafa;font-weight:800;font-size:11pt;break-after:avoid}';
  h += '.grp span:last-child{font-size:9.5pt;white-space:nowrap}';
  // Tabelas
  h += 'h2{font-size:9pt;font-weight:800;text-transform:uppercase;letter-spacing:.06em;margin:6mm 0 2mm;break-after:avoid}';
  h += 'table{width:100%;border-collapse:collapse;font-size:9.5pt}';
  h += 'th{text-align:left;font-size:7.5pt;text-transform:uppercase;letter-spacing:.05em;color:#71717a;padding:1.5mm 2mm;border-bottom:.3mm solid #18181b}';
  h += 'td{padding:1.8mm 2mm;border-bottom:.2mm solid #e4e4e7;vertical-align:top;overflow-wrap:anywhere}';
  h += 'tr{break-inside:avoid}';
  h += '.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}';
  h += '.nw{white-space:nowrap}';
  h += '.ok{font-weight:700}';
  h += '.vazio{font-size:9pt;color:#71717a;font-style:italic}';
  // Parcela a pagar = cupom destacável: canhoto da loja | via do cliente | QR
  h += '.slip{display:grid;grid-template-columns:42mm 1fr 36mm;border:.3mm solid #18181b;border-radius:2mm;margin-bottom:3mm;break-inside:avoid;page-break-inside:avoid}';
  // Sem chave Pix: duas colunas, sem buraco no lugar do QR.
  h += '.slip.sem-pix{grid-template-columns:42mm 1fr}';
  h += '.slip>div{padding:3mm 3.5mm;min-width:0}';
  h += '.stub{border-right:.3mm dashed #18181b;font-size:8.5pt;overflow-wrap:anywhere}';
  h += '.stub .big{font-size:11pt;font-weight:800}';
  h += '.stub .sign{margin-top:3mm;border-top:.2mm solid #52525b;padding-top:.8mm;font-size:7pt;color:#52525b}';
  h += '.main .top{display:flex;justify-content:space-between;align-items:baseline;gap:3mm}';
  h += '.main .num{font-size:13pt;font-weight:800}';
  h += '.main .val{font-size:15pt;font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap}';
  h += '.main .due{font-size:10pt;margin-top:.5mm}';
  h += '.main .due b{font-weight:800}';
  h += '.main .meta{font-size:8.5pt;color:#52525b;margin-top:1.5mm;overflow-wrap:anywhere}';
  h += '.main .emv{margin-top:0;font-family:Consolas,Menlo,monospace;font-size:6.5pt;word-break:break-all;color:#52525b;border:.2mm solid #e4e4e7;border-radius:1mm;padding:1mm 1.5mm;user-select:all}';
  h += '.qr{border-left:.3mm solid #e4e4e7;text-align:center}';
  h += '.qr svg{width:28mm;height:28mm;display:block;margin:0 auto}';
  h += '.qr span{font-size:7pt;font-weight:700;text-transform:uppercase;letter-spacing:.05em}';
  h += '.late{background:#18181b;color:#fff;font-size:7pt;font-weight:800;padding:.4mm 1.6mm;border-radius:1mm;text-transform:uppercase;letter-spacing:.05em;vertical-align:middle;margin-left:1.5mm}';
  h += '.foot{margin-top:5mm;padding-top:3mm;border-top:.2mm solid #e4e4e7;font-size:8pt;color:#52525b;display:flex;justify-content:space-between;gap:6mm;break-inside:avoid}';
  h += '</style></head><body>';

  h += `<div class="toolbar"><span>Carnê de crediário — ${escapeHtml(customer.name || '')} — A4</span>`;
  h += '<button onclick="window.print()">Imprimir</button></div>';

  h += '<div class="page">';

  // ===== Cabeçalho: marca da LOJA =====
  h += '<div class="head">';
  h += logoHtml;
  h += '<div class="store">';
  h += `<div class="name">${escapeHtml(lojaNome)}</div>`;
  if (endereco) h += `<div>${escapeHtml(endereco)}</div>`;
  if (contatoLoja) h += `<div>${contatoLoja}</div>`;
  h += '</div>';
  h += '<div class="doc"><div class="t">Carnê de crediário</div>';
  if (carneName) h += `<div class="cn">${escapeHtml(carneName)}</div>`;
  h += `<div>Emitido em ${escapeHtml(emitidoEm)}</div></div>`;
  h += '</div>';

  // ===== Cliente + resumo =====
  h += '<div class="grid2">';
  h += '<div class="box"><div class="lbl">Cliente</div>';
  h += `<div class="v">${escapeHtml(customer.name || '')}</div>`;
  if (contatoCliente) h += `<div class="s">${contatoCliente}</div>`;
  h += '</div>';
  h += '<div class="box sum">';
  h += `<div><div class="lbl">Comprou</div><div class="n">R$ ${formatBRL(resumo.comprou)}</div></div>`;
  h += `<div><div class="lbl">Já pagou</div><div class="n">R$ ${formatBRL(resumo.pagou)}</div></div>`;
  h += `<div class="open"><div class="lbl">Falta pagar</div><div class="n">R$ ${formatBRL(resumo.falta)}</div></div>`;
  h += '</div></div>';

  // ===== Carnês =====
  if (grupos.length) h += grupos.map(grupoHtml).join('');
  else h += '<div class="vazio" style="margin-top:6mm">Nenhuma parcela registrada.</div>';

  // ===== Rodapé: nota de principal/multa + Aura discreta =====
  h += '<div class="foot">';
  h += '<span>Valores de principal. Parcela em atraso tem multa e juros calculados no dia do pagamento.'
    + (temPix ? ' O pagamento por Pix é confirmado pela loja.' : '') + '</span>';
  h += '<span style="white-space:nowrap">Powered by Aura</span>';
  h += '</div>';

  h += '</div>'; // .page
  // Mesmo script da DANFE, da OS e do carnê térmico: não depende de onload.
  if (autoprint) h += autoPrintScript({ delayMs: 350 });
  h += '</body></html>';
  return h;
}

module.exports = {
  buildCarneA4Html,
  classifyInstallments,
  summarize,
  // expostos para teste
  formatBRL, formatCnpj, formatDocumento, formatDiaSP, formatVencimento, getInitials,
};
