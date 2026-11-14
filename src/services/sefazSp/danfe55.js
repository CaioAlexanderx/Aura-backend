// ============================================================
// AURA. — sefazSp/danfe55: DANFE A4 (retrato) da NF-e modelo 55, gerado
// pela Aura a partir do XML ASSINADO + protocolo de autorização.
// 14/11/2026 — CP3. Vale para a 55 de VENDA e para a de DEVOLUÇÃO (a
// devolução dependia do PDF da Nuvem Fiscal, que não existe mais).
//
// PDFKit (já usado no DANFSe e no holerite) — sem dependência nova. O
// código de barras CODE-128C da chave é desenhado aqui (tabela padrão do
// Code 128, ~40 linhas), sem biblioteca.
//
// Leiaute (Manual de Orientação do Contribuinte, Anexo II — DANFE):
//   canhoto (1ª folha) · emitente | DANFE 0-entrada/1-saída, nº, série,
//   folha X/Y | código de barras + chave + consulta · natureza da operação
//   + protocolo · IE / IE do ST / CNPJ · destinatário/remetente · fatura/
//   duplicatas (quando há cobr) · cálculo do imposto · transportador/
//   volumes · dados dos produtos · dados adicionais (infCpl + infAdFisco).
//   Folhas seguintes repetem o quadro do cabeçalho e seguem os produtos.
// Marcas: homologação (tpAmb=2) → "SEM VALOR FISCAL"; cancelada →
// "CANCELADA" (o cancelamento 110111 da 55 é o CP5; a marca já fica pronta).
//
// Regras: tudo vem do XML; campo ausente fica vazio, nada é completado com
// o cadastro. Texto do XML entra como texto (PDFKit grava em hex), nada
// vira link ou ação.
// lerNfe55 é PURA (testável sem PDF). O nfeProc (XML de guardar) mora em sefazSp/nfeProc.js.
// ============================================================
'use strict';

const PDFDocument = require('pdfkit');
const { XMLParser } = require('fast-xml-parser');
const { textoPdf } = require('../nfseNacional/danfseLocal');

// ── leitura do XML ───────────────────────────────────────────

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ['det', 'detPag', 'dup', 'vol', 'lacres', 'NFref'].includes(name),
});

const s = (v) => (v == null ? '' : String(typeof v === 'object' && '#text' in v ? v['#text'] : v));
const n = (v) => { const x = Number(s(v)); return Number.isFinite(x) ? x : 0; };

function primeiroFilho(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const k = Object.keys(obj).find((x) => !x.startsWith('@_'));
  return k ? (obj[k] || {}) : {};
}

/**
 * Lê o que o DANFE precisa do XML (<NFe> assinada ou <nfeProc>).
 * @returns modelo plano { chave, ide, emit, dest, itens[], total, transp, cobr, infAdic, prot? }
 */
function lerNfe55(xml) {
  const raiz = parser.parse(String(xml || ''));
  const nfe = raiz.nfeProc ? raiz.nfeProc.NFe : raiz.NFe;
  if (!nfe || !nfe.infNFe) throw new Error('danfe55: XML sem NFe/infNFe');
  const inf = nfe.infNFe;
  const chave = s(inf['@_Id']).replace(/^NFe/, '');
  if (!/^\d{44}$/.test(chave)) throw new Error('danfe55: chave de acesso inválida no XML');
  const ide = inf.ide || {};
  if (s(ide.mod) !== '55') throw new Error('danfe55: o XML não é de NF-e modelo 55');
  const emit = inf.emit || {};
  const dest = inf.dest || {};
  const tot = (inf.total && inf.total.ICMSTot) || {};
  const transp = inf.transp || {};
  const prot = raiz.nfeProc && raiz.nfeProc.protNFe ? raiz.nfeProc.protNFe.infProt || {} : null;

  const itens = (inf.det || []).map((d) => {
    const p = d.prod || {};
    const imp = d.imposto || {};
    const icms = primeiroFilho(imp.ICMS);
    const ipi = imp.IPI ? (imp.IPI.IPITrib || {}) : {};
    return {
      nItem: s(d['@_nItem']),
      codigo: s(p.cProd), descricao: s(p.xProd), ncm: s(p.NCM), cfop: s(p.CFOP), unidade: s(p.uCom),
      quantidade: n(p.qCom), valorUnitario: n(p.vUnCom), valorTotal: n(p.vProd), desconto: n(p.vDesc),
      cst: s(icms.orig) + (s(icms.CSOSN) || s(icms.CST)),
      bcIcms: n(icms.vBC), vIcms: n(icms.vICMS), aliqIcms: n(icms.pICMS),
      vIpi: n(ipi.vIPI), aliqIpi: n(ipi.pIPI),
      infAdProd: s(d.infAdProd),
    };
  });

  const vol = (transp.vol || [])[0] || {};
  const transporta = transp.transporta || {};
  const ender = (e) => e || {};
  const ed = ender(dest.enderDest);
  const ee = ender(emit.enderEmit);
  const cobr = inf.cobr || null;

  return {
    chave,
    ide: {
      natOp: s(ide.natOp), serie: s(ide.serie), nNF: s(ide.nNF), dhEmi: s(ide.dhEmi), dhSaiEnt: s(ide.dhSaiEnt),
      tpNF: s(ide.tpNF), tpAmb: s(ide.tpAmb), finNFe: s(ide.finNFe),
    },
    emit: {
      nome: s(emit.xNome), fantasia: s(emit.xFant), cnpj: s(emit.CNPJ) || s(emit.CPF), ie: s(emit.IE), iest: s(emit.IEST),
      logradouro: s(ee.xLgr), numero: s(ee.nro), complemento: s(ee.xCpl), bairro: s(ee.xBairro),
      municipio: s(ee.xMun), uf: s(ee.UF), cep: s(ee.CEP), fone: s(ee.fone),
    },
    dest: {
      nome: s(dest.xNome), documento: s(dest.CNPJ) || s(dest.CPF) || s(dest.idEstrangeiro), ie: s(dest.IE),
      logradouro: s(ed.xLgr), numero: s(ed.nro), complemento: s(ed.xCpl), bairro: s(ed.xBairro),
      municipio: s(ed.xMun), uf: s(ed.UF), cep: s(ed.CEP), fone: s(ed.fone), email: s(dest.email),
    },
    itens,
    total: {
      vBC: n(tot.vBC), vICMS: n(tot.vICMS), vBCST: n(tot.vBCST), vST: n(tot.vST), vProd: n(tot.vProd),
      vFrete: n(tot.vFrete), vSeg: n(tot.vSeg), vDesc: n(tot.vDesc), vOutro: n(tot.vOutro), vIPI: n(tot.vIPI),
      vNF: n(tot.vNF), vTotTrib: n(tot.vTotTrib),
    },
    transp: {
      modFrete: s(transp.modFrete),
      nome: s(transporta.xNome), documento: s(transporta.CNPJ) || s(transporta.CPF), ie: s(transporta.IE),
      endereco: s(transporta.xEnder), municipio: s(transporta.xMun), uf: s(transporta.UF),
      placa: s(transp.veicTransp && transp.veicTransp.placa), ufPlaca: s(transp.veicTransp && transp.veicTransp.UF),
      rntc: s(transp.veicTransp && transp.veicTransp.RNTC),
      qVol: s(vol.qVol), esp: s(vol.esp), marca: s(vol.marca), nVol: s(vol.nVol), pesoL: s(vol.pesoL), pesoB: s(vol.pesoB),
    },
    cobr: cobr ? {
      fatura: cobr.fat ? { numero: s(cobr.fat.nFat), vOrig: n(cobr.fat.vOrig), vDesc: n(cobr.fat.vDesc), vLiq: n(cobr.fat.vLiq) } : null,
      duplicatas: (cobr.dup || []).map((d) => ({ numero: s(d.nDup), vencimento: s(d.dVenc), valor: n(d.vDup) })),
    } : null,
    infAdic: {
      infCpl: s(inf.infAdic && inf.infAdic.infCpl),
      infAdFisco: s(inf.infAdic && inf.infAdic.infAdFisco),
    },
    prot: prot ? { nProt: s(prot.nProt), dhRecbto: s(prot.dhRecbto), cStat: s(prot.cStat) } : null,
  };
}

// ── CODE-128C ────────────────────────────────────────────────
// Larguras barra/espaço (6 elementos, 11 módulos) dos valores 0..105 e o
// STOP (7 elementos, 13 módulos). Tabela padrão do Code 128 (ISO/IEC 15417).
const CODE128 = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 '
  + '221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 '
  + '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 '
  + '212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 '
  + '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 '
  + '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 '
  + '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 '
  + '112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 '
  + '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 '
  + '214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 '
  + '114131 311141 411131 211412 211214 211232'
).split(' ');
const CODE128_STOP = '2331112';
const START_C = 105;

/** Sequência de larguras (módulos) da barra CODE-128C de uma string de dígitos (comprimento par). */
function code128C(digitos) {
  const d = String(digitos || '');
  if (!/^\d+$/.test(d) || d.length % 2) throw new Error('code128C: precisa de dígitos em quantidade par');
  const valores = [START_C];
  for (let i = 0; i < d.length; i += 2) valores.push(Number(d.slice(i, i + 2)));
  let soma = START_C;
  for (let i = 1; i < valores.length; i++) soma += valores[i] * i;
  valores.push(soma % 103);
  return valores.map((v) => CODE128[v]).join('') + CODE128_STOP;
}

function desenharCode128(doc, digitos, x, y, largura, altura) {
  const larguras = code128C(digitos).split('').map(Number);
  const modulos = larguras.reduce((a, b) => a + b, 0);
  const m = largura / modulos;
  let cx = x;
  larguras.forEach((w, i) => {
    if (i % 2 === 0) doc.rect(cx, y, w * m, altura).fill('#000000');
    cx += w * m;
  });
}

// ── formatação ───────────────────────────────────────────────

const dig = (v) => String(v == null ? '' : v).replace(/\D/g, '');
function fmtDoc(v) {
  const d = dig(v);
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return v || '';
}
const fmtCep = (v) => { const d = dig(v); return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : (v || ''); };
function fmtFone(v) {
  const d = dig(v);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return v || '';
}
function fmtNum(v, casas = 2) {
  return Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
}
function fmtQtd(v) {
  return Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}
/** "2026-11-14T10:00:00-03:00" → { data: "14/11/2026", hora: "10:00:00" } (como está no XML). */
function fmtDataHora(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}:\d{2}))?/);
  return m ? { data: `${m[3]}/${m[2]}/${m[1]}`, hora: m[4] || '' } : { data: '', hora: '' };
}
const fmtChave = (c) => String(c || '').replace(/(\d{4})(?=\d)/g, '$1 ');
const fmtNumeroNF = (nNF) => dig(nNF).padStart(9, '0').replace(/^(\d{3})(\d{3})(\d{3})$/, '$1.$2.$3');
const MOD_FRETE = {
  0: '0 - Por conta do Remetente', 1: '1 - Por conta do Destinatário', 2: '2 - Por conta de Terceiros',
  3: '3 - Próprio por conta do Remetente', 4: '4 - Próprio por conta do Destinatário', 9: '9 - Sem Frete',
};
function endereco(e) {
  return [e.logradouro, e.numero, e.complemento].filter(Boolean).join(', ');
}

// ── desenho ──────────────────────────────────────────────────

const A4 = { w: 595.28, h: 841.89 };
const M = 20;
const W = A4.w - M * 2;
const COR = { texto: '#000000', rotulo: '#333333', linha: '#000000', marca: '#b91c1c', marcaH: '#9ca3af' };
const PAD = 2;
const H_CAMPO = 20;
const Y_FIM = A4.h - M;

/** Uma célula com rótulo pequeno em cima e o valor embaixo. */
function campo(doc, x, y, w, h, rotulo, valor, o = {}) {
  doc.lineWidth(0.5).strokeColor(COR.linha).rect(x, y, w, h).stroke();
  doc.fillColor(COR.rotulo).font('Helvetica').fontSize(5.5)
    .text(textoPdf(rotulo), x + PAD, y + PAD, { width: w - PAD * 2, lineBreak: false, ellipsis: true });
  doc.fillColor(COR.texto).font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.size || 7.5)
    .text(textoPdf(valor), x + PAD, y + PAD + 7, {
      width: w - PAD * 2, align: o.align || 'left', lineBreak: !!o.quebra, ellipsis: !o.quebra, height: h - PAD - 8,
    });
}

/** Linha de campos com larguras relativas. */
function linhaDeCampos(doc, y, campos, h = H_CAMPO) {
  const soma = campos.reduce((a, c) => a + c[0], 0);
  let x = M;
  for (const [peso, rotulo, valor, o] of campos) {
    const w = (W * peso) / soma;
    campo(doc, x, y, w, h, rotulo, valor, o);
    x += w;
  }
  return y + h;
}

function tituloBloco(doc, y, texto) {
  doc.fillColor(COR.texto).font('Helvetica-Bold').fontSize(6.5).text(textoPdf(texto), M, y + 2, { width: W, lineBreak: false });
  return y + 10;
}

function canhoto(doc, d, y) {
  const h = 46;
  const wNum = 100;
  doc.lineWidth(0.5).strokeColor(COR.linha).rect(M, y, W - wNum, h).stroke();
  doc.fillColor(COR.texto).font('Helvetica').fontSize(6)
    .text(textoPdf(`RECEBEMOS DE ${d.emit.nome.toUpperCase()} OS PRODUTOS E/OU SERVIÇOS CONSTANTES DA NOTA FISCAL ELETRÔNICA INDICADA AO LADO`),
      M + PAD, y + PAD, { width: W - wNum - PAD * 2 });
  const yb = y + 22;
  campo(doc, M, yb, 120, h - 22, 'DATA DE RECEBIMENTO', '');
  campo(doc, M + 120, yb, W - wNum - 120, h - 22, 'IDENTIFICAÇÃO E ASSINATURA DO RECEBEDOR', '');
  doc.lineWidth(0.5).rect(M + W - wNum, y, wNum, h).stroke();
  doc.font('Helvetica-Bold').fontSize(10).text('NF-e', M + W - wNum, y + 6, { width: wNum, align: 'center' });
  doc.fontSize(8).text(textoPdf(`Nº ${fmtNumeroNF(d.ide.nNF)}`), M + W - wNum, y + 20, { width: wNum, align: 'center' });
  doc.text(textoPdf(`SÉRIE ${d.ide.serie}`), M + W - wNum, y + 31, { width: wNum, align: 'center' });
  // linha de corte
  const yc = y + h + 5;
  doc.lineWidth(0.5).dash(3, { space: 2 }).moveTo(M, yc).lineTo(M + W, yc).stroke().undash();
  return yc + 5;
}

/** Quadro do cabeçalho (repetido em toda folha). Reserva o lugar da "FOLHA x/y". */
function cabecalho(doc, d, y, folhas) {
  const h = 92;
  const wEmit = W * 0.38;
  const wDanfe = W * 0.2;
  const wChave = W - wEmit - wDanfe;
  // emitente
  doc.lineWidth(0.5).strokeColor(COR.linha).rect(M, y, wEmit, h).stroke();
  doc.fillColor(COR.texto).font('Helvetica-Bold').fontSize(9)
    .text(textoPdf(d.emit.nome), M + 4, y + 8, { width: wEmit - 8, align: 'center' });
  doc.font('Helvetica').fontSize(7)
    .text(textoPdf([endereco(d.emit), d.emit.bairro].filter(Boolean).join(' - ')), M + 4, doc.y + 4, { width: wEmit - 8, align: 'center' })
    .text(textoPdf(`${d.emit.municipio} - ${d.emit.uf}  CEP ${fmtCep(d.emit.cep)}`), M + 4, doc.y + 1, { width: wEmit - 8, align: 'center' });
  if (d.emit.fone) doc.text(textoPdf(`Fone: ${fmtFone(d.emit.fone)}`), M + 4, doc.y + 1, { width: wEmit - 8, align: 'center' });
  // DANFE
  const xd = M + wEmit;
  doc.rect(xd, y, wDanfe, h).stroke();
  doc.font('Helvetica-Bold').fontSize(12).text('DANFE', xd, y + 4, { width: wDanfe, align: 'center' });
  doc.font('Helvetica').fontSize(6.5)
    .text(textoPdf('Documento Auxiliar da Nota Fiscal Eletrônica'), xd + 4, y + 18, { width: wDanfe - 8, align: 'center' });
  doc.fontSize(7).text('0 - ENTRADA', xd + 8, y + 40).text(textoPdf('1 - SAÍDA'), xd + 8, y + 49);
  doc.rect(xd + wDanfe - 28, y + 39, 18, 18).stroke();
  doc.font('Helvetica-Bold').fontSize(12).text(textoPdf(d.ide.tpNF), xd + wDanfe - 28, y + 42, { width: 18, align: 'center' });
  doc.fontSize(8).text(textoPdf(`Nº ${fmtNumeroNF(d.ide.nNF)}`), xd, y + 62, { width: wDanfe, align: 'center' })
    .text(textoPdf(`SÉRIE ${d.ide.serie}`), xd, y + 72, { width: wDanfe, align: 'center' });
  folhas.push({ x: xd, y: y + 82, w: wDanfe });
  // código de barras + chave
  const xc = xd + wDanfe;
  doc.rect(xc, y, wChave, h).stroke();
  desenharCode128(doc, d.chave, xc + 10, y + 5, wChave - 20, 32);
  campo(doc, xc, y + 42, wChave, 20, 'CHAVE DE ACESSO', fmtChave(d.chave), { bold: true, size: 7.5, align: 'center' });
  doc.fillColor(COR.texto).font('Helvetica').fontSize(6.5)
    .text(textoPdf('Consulta de autenticidade no portal nacional da NF-e www.nfe.fazenda.gov.br/portal ou no site da Sefaz Autorizadora'),
      xc + 4, y + 66, { width: wChave - 8, align: 'center' });
  y += h;
  const prot = d.protocolo ? `${d.protocolo}${d.dataProtocolo ? '  ' + d.dataProtocolo : ''}` : '';
  y = linhaDeCampos(doc, y, [
    [62, 'NATUREZA DA OPERAÇÃO', d.ide.natOp],
    [38, 'PROTOCOLO DE AUTORIZAÇÃO DE USO', prot, { align: 'center' }],
  ]);
  y = linhaDeCampos(doc, y, [
    [1, 'INSCRIÇÃO ESTADUAL', d.emit.ie],
    [1, 'INSCRIÇÃO ESTADUAL DO SUBST. TRIBUT.', d.emit.iest],
    [1, 'CNPJ', fmtDoc(d.emit.cnpj)],
  ]);
  return y + 3;
}

function blocoDestinatario(doc, d, y) {
  y = tituloBloco(doc, y, 'DESTINATÁRIO / REMETENTE');
  const emi = fmtDataHora(d.ide.dhEmi);
  const sai = fmtDataHora(d.ide.dhSaiEnt);
  y = linhaDeCampos(doc, y, [
    [60, 'NOME / RAZÃO SOCIAL', d.dest.nome],
    [25, 'CNPJ / CPF', fmtDoc(d.dest.documento)],
    [15, 'DATA DA EMISSÃO', emi.data],
  ]);
  y = linhaDeCampos(doc, y, [
    [50, 'ENDEREÇO', endereco(d.dest)],
    [25, 'BAIRRO / DISTRITO', d.dest.bairro],
    [10, 'CEP', fmtCep(d.dest.cep)],
    [15, 'DATA DA SAÍDA/ENTRADA', sai.data],
  ]);
  y = linhaDeCampos(doc, y, [
    [38, 'MUNICÍPIO', d.dest.municipio],
    [20, 'FONE / FAX', fmtFone(d.dest.fone)],
    [5, 'UF', d.dest.uf],
    [22, 'INSCRIÇÃO ESTADUAL', d.dest.ie],
    [15, 'HORA DA SAÍDA/ENTRADA', sai.hora],
  ]);
  return y + 3;
}

function blocoFatura(doc, d, y) {
  if (!d.cobr || (!d.cobr.fatura && !d.cobr.duplicatas.length)) return y;
  y = tituloBloco(doc, y, 'FATURA / DUPLICATAS');
  const partes = [];
  if (d.cobr.fatura) {
    partes.push(`Fatura ${d.cobr.fatura.numero}: original ${fmtNum(d.cobr.fatura.vOrig)}  desconto ${fmtNum(d.cobr.fatura.vDesc)}  líquido ${fmtNum(d.cobr.fatura.vLiq)}`);
  }
  for (const dup of d.cobr.duplicatas) {
    partes.push(`Dup. ${dup.numero}  venc. ${fmtDataHora(dup.vencimento).data}  R$ ${fmtNum(dup.valor)}`);
  }
  doc.font('Helvetica').fontSize(7);
  const texto = textoPdf(partes.join('   |   '));
  const h = Math.max(H_CAMPO, doc.heightOfString(texto, { width: W - PAD * 2 }) + PAD * 2 + 2);
  doc.lineWidth(0.5).rect(M, y, W, h).stroke();
  doc.fillColor(COR.texto).text(texto, M + PAD, y + PAD + 1, { width: W - PAD * 2 });
  return y + h + 3;
}

function blocoImposto(doc, d, y) {
  const t = d.total;
  y = tituloBloco(doc, y, 'CÁLCULO DO IMPOSTO');
  const r = { align: 'right' };
  y = linhaDeCampos(doc, y, [
    [1, 'BASE DE CÁLC. DO ICMS', fmtNum(t.vBC), r],
    [1, 'VALOR DO ICMS', fmtNum(t.vICMS), r],
    [1, 'BASE DE CÁLC. ICMS S.T.', fmtNum(t.vBCST), r],
    [1, 'VALOR DO ICMS SUBST.', fmtNum(t.vST), r],
    [1, 'V. APROX. DOS TRIBUTOS', fmtNum(t.vTotTrib), r],
    [1, 'VALOR TOTAL DOS PRODUTOS', fmtNum(t.vProd), r],
  ]);
  y = linhaDeCampos(doc, y, [
    [1, 'VALOR DO FRETE', fmtNum(t.vFrete), r],
    [1, 'VALOR DO SEGURO', fmtNum(t.vSeg), r],
    [1, 'DESCONTO', fmtNum(t.vDesc), r],
    [1, 'OUTRAS DESPESAS', fmtNum(t.vOutro), r],
    [1, 'VALOR TOTAL IPI', fmtNum(t.vIPI), r],
    [1, 'VALOR TOTAL DA NOTA', fmtNum(t.vNF), { align: 'right', bold: true }],
  ]);
  return y + 3;
}

function blocoTransporte(doc, d, y) {
  const t = d.transp;
  y = tituloBloco(doc, y, 'TRANSPORTADOR / VOLUMES TRANSPORTADOS');
  y = linhaDeCampos(doc, y, [
    [32, 'NOME / RAZÃO SOCIAL', t.nome],
    [20, 'FRETE POR CONTA', MOD_FRETE[t.modFrete] || t.modFrete],
    [12, 'CÓDIGO ANTT', t.rntc],
    [11, 'PLACA DO VEÍCULO', t.placa],
    [5, 'UF', t.ufPlaca],
    [20, 'CNPJ / CPF', fmtDoc(t.documento)],
  ]);
  y = linhaDeCampos(doc, y, [
    [45, 'ENDEREÇO', t.endereco],
    [30, 'MUNICÍPIO', t.municipio],
    [5, 'UF', t.uf],
    [20, 'INSCRIÇÃO ESTADUAL', t.ie],
  ]);
  y = linhaDeCampos(doc, y, [
    [1, 'QUANTIDADE', t.qVol], [1, 'ESPÉCIE', t.esp], [1, 'MARCA', t.marca], [1, 'NUMERAÇÃO', t.nVol],
    [1, 'PESO BRUTO', t.pesoB ? fmtNum(t.pesoB, 3) : ''], [1, 'PESO LÍQUIDO', t.pesoL ? fmtNum(t.pesoL, 3) : ''],
  ]);
  return y + 3;
}

// colunas dos produtos (pesos relativos)
const COLUNAS = [
  ['CÓDIGO', 8, 'left'], ['DESCRIÇÃO DO PRODUTO / SERVIÇO', 27, 'left'], ['NCM/SH', 7, 'center'],
  ['O/CSOSN', 6, 'center'], ['CFOP', 5, 'center'], ['UN', 4, 'center'], ['QUANT.', 6, 'right'],
  ['VALOR UNIT.', 7, 'right'], ['VALOR TOTAL', 7, 'right'], ['V. DESC.', 6, 'right'],
  ['BC ICMS', 6, 'right'], ['V. ICMS', 5, 'right'], ['V. IPI', 5, 'right'], ['ALÍQ. ICMS', 5, 'right'], ['ALÍQ. IPI', 5, 'right'],
];
const SOMA_COL = COLUNAS.reduce((a, c) => a + c[1], 0);
const larguraCol = (i) => (W * COLUNAS[i][1]) / SOMA_COL;

function cabecalhoProdutos(doc, y) {
  y = tituloBloco(doc, y, 'DADOS DOS PRODUTOS / SERVIÇOS');
  const h = 16;
  let x = M;
  COLUNAS.forEach(([rotulo, , ], i) => {
    const w = larguraCol(i);
    doc.lineWidth(0.5).rect(x, y, w, h).stroke();
    doc.fillColor(COR.texto).font('Helvetica-Bold').fontSize(5)
      .text(textoPdf(rotulo), x + 1, y + 2, { width: w - 2, align: 'center' });
    x += w;
  });
  return y + h;
}

function celulasDoItem(it) {
  return [
    it.codigo, it.descricao + (it.infAdProd ? `\n${it.infAdProd}` : ''), it.ncm, it.cst, it.cfop, it.unidade,
    fmtQtd(it.quantidade), fmtNum(it.valorUnitario, 2), fmtNum(it.valorTotal), fmtNum(it.desconto),
    fmtNum(it.bcIcms), fmtNum(it.vIcms), fmtNum(it.vIpi), fmtNum(it.aliqIcms), fmtNum(it.aliqIpi),
  ].map(textoPdf);
}

function alturaItem(doc, cel) {
  doc.font('Helvetica').fontSize(6.3);
  let h = 0;
  cel.forEach((t, i) => { h = Math.max(h, doc.heightOfString(t, { width: larguraCol(i) - 3 })); });
  return h + 4;
}

function linhaItem(doc, cel, y, h) {
  let x = M;
  cel.forEach((t, i) => {
    const w = larguraCol(i);
    doc.lineWidth(0.3).rect(x, y, w, h).stroke();
    doc.fillColor(COR.texto).font('Helvetica').fontSize(6.3).text(t, x + 1.5, y + 2, { width: w - 3, align: COLUNAS[i][2] });
    x += w;
  });
}

function blocoDadosAdicionais(doc, d, y, novaFolha) {
  const texto = textoPdf([d.infAdic.infCpl, d.infAdic.infAdFisco].filter(Boolean).join('\n'));
  const wInf = W * 0.65;
  doc.font('Helvetica').fontSize(6.5);
  const h = Math.max(52, doc.heightOfString(texto, { width: wInf - PAD * 2 }) + 14);
  if (y + 10 + h > Y_FIM) y = novaFolha();
  y = tituloBloco(doc, y, 'DADOS ADICIONAIS');
  doc.lineWidth(0.5).rect(M, y, wInf, h).stroke().rect(M + wInf, y, W - wInf, h).stroke();
  doc.fillColor(COR.rotulo).font('Helvetica').fontSize(5.5).text(textoPdf('INFORMAÇÕES COMPLEMENTARES'), M + PAD, y + PAD)
    .text('RESERVADO AO FISCO', M + wInf + PAD, y + PAD);
  doc.fillColor(COR.texto).font('Helvetica').fontSize(6.5).text(texto, M + PAD, y + 10, { width: wInf - PAD * 2 });
  return y + h;
}

function marcaDagua(doc, linhas, cor) {
  doc.save();
  doc.rotate(-35, { origin: [A4.w / 2, A4.h / 2] });
  doc.fillColor(cor).fillOpacity(0.28).font('Helvetica-Bold');
  let y = A4.h / 2 - linhas.length * 28;
  for (const [texto, tamanho] of linhas) {
    doc.fontSize(tamanho).text(textoPdf(texto), -100, y, { width: A4.w + 200, align: 'center', lineBreak: false });
    y += tamanho + 10;
  }
  doc.restore();
  doc.fillOpacity(1);
}

/**
 * DANFE A4 da NF-e 55.
 * @param {string} xmlSigned — <NFe> assinada (ou <nfeProc>)
 * @param {{ protocolo?, dhRecbto?, cancelada?, compress? }} [opts]
 * @returns {Promise<Buffer>}
 */
async function gerarDanfe55Pdf(xmlSigned, opts = {}) {
  const d = lerNfe55(xmlSigned);
  const prot = d.prot || {};
  d.protocolo = opts.protocolo || prot.nProt || '';
  const dh = fmtDataHora(opts.dhRecbto || prot.dhRecbto);
  d.dataProtocolo = dh.data ? `${dh.data} ${dh.hora}`.trim() : '';
  const homologacao = d.ide.tpAmb === '2';

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4', margins: { top: M, left: M, right: M, bottom: 0 }, compress: opts.compress !== false,
        bufferPages: true, autoFirstPage: true,
        info: { Title: textoPdf(`DANFE NF-e ${d.ide.nNF} série ${d.ide.serie}`), Producer: 'Aura', Creator: 'Aura' },
      });
      const partes = [];
      doc.on('data', (c) => partes.push(c));
      doc.on('end', () => resolve(Buffer.concat(partes)));
      doc.on('error', reject);

      const folhas = [];
      let y = canhoto(doc, d, M);
      y = cabecalho(doc, d, y, folhas);
      y = blocoDestinatario(doc, d, y);
      y = blocoFatura(doc, d, y);
      y = blocoImposto(doc, d, y);
      y = blocoTransporte(doc, d, y);

      const novaFolha = () => {
        doc.addPage();
        return cabecalho(doc, d, M, folhas);
      };

      y = cabecalhoProdutos(doc, y);
      for (const it of d.itens) {
        const cel = celulasDoItem(it);
        const h = alturaItem(doc, cel);
        if (y + h > Y_FIM - 4) { y = cabecalhoProdutos(doc, novaFolha()); }
        linhaItem(doc, cel, y, h);
        y += h;
      }
      blocoDadosAdicionais(doc, d, y + 3, novaFolha);

      // FOLHA x/y e marcas, em todas as folhas
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        const f = folhas[i];
        if (f) {
          doc.fillColor(COR.texto).font('Helvetica-Bold').fontSize(7)
            .text(`FOLHA ${i + 1}/${range.count}`, f.x, f.y, { width: f.w, align: 'center', lineBreak: false });
        }
        if (homologacao) marcaDagua(doc, [['SEM VALOR FISCAL', 54], ['NF-E EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO', 18]], COR.marcaH);
        if (opts.cancelada) marcaDagua(doc, [['CANCELADA', 80]], COR.marca);
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  lerNfe55, gerarDanfe55Pdf, code128C, CODE128, CODE128_STOP,
  fmtChave, fmtNumeroNF,
};
