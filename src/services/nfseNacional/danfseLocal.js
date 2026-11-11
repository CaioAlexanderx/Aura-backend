// ============================================================
// AURA. — nfseNacional/danfseLocal: DANFSe gerado pela Aura a partir do
// XML AUTORIZADO da NFS-e (PDF, PDFKit).
//
// Por quê (produção, 11/11/2026): a NFS-e estava autorizada, com chave e
// XML gravados, mas o ADN (GET adn.nfse.gov.br/danfse/{chave}) respondia
// HTTP 503 em toda tentativa — o lojista não conseguia ver nem imprimir a
// nota. O PDF do ADN continua sendo a primeira opção; este documento só
// sai quando o ADN não entrega (ver index.js → danfse).
//
// Regras:
//   * tudo vem do XML (nfseParser.lerDanfse): campo ausente fica fora,
//     nada é deduzido nem completado com o cadastro da loja;
//   * códigos do leiaute (regime, retenção, tributação) viram o texto do
//     domínio do leiaute; código desconhecido aparece como veio;
//   * texto do XML entra no PDF como texto (PDFKit grava em hex, sem
//     marcação): nada do XML vira link, ação ou script. O único link do
//     documento é o da consulta pública;
//   * leiaute do DANFSe do Sistema Nacional NFS-e: cabeçalho, emitente,
//     tomador, serviço, tributação, valores, regime, informações
//     complementares e consulta pública com a chave (QR + link).
//
// montarDanfse é PURA (testável sem PDF); gerarDanfsePdf desenha o modelo.
// ============================================================
'use strict';

const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const { lerDanfse } = require('./nfseParser');

const CONSULTA_PUBLICA = 'https://www.nfse.gov.br/consultapublica';
const RODAPE = 'Gerado pela Aura a partir do XML autorizado da NFS-e. Confira na consulta pública com a chave de acesso.';
const TITULO = 'DANFSe — Documento Auxiliar da NFS-e';

// ── domínios do leiaute (Anexo I do manual do Sistema Nacional NFS-e) ──

const OP_SIMP_NAC = {
  1: 'Não optante pelo Simples Nacional',
  2: 'Optante pelo Simples Nacional — Microempreendedor Individual (MEI)',
  3: 'Optante pelo Simples Nacional — Microempresa ou Empresa de Pequeno Porte (ME/EPP)',
};
const REG_AP_TRIB_SN = {
  1: 'Tributos federais e municipal apurados pelo Simples Nacional',
  2: 'Tributos federais pelo Simples Nacional; ISSQN fora do Simples Nacional',
  3: 'Tributos federais e municipal fora do Simples Nacional',
};
const REG_ESP_TRIB = {
  0: 'Nenhum', 1: 'Ato cooperado (cooperativa)', 2: 'Estimativa', 3: 'Microempresa municipal',
  4: 'Notário ou registrador', 5: 'Profissional autônomo', 6: 'Sociedade de profissionais', 9: 'Outros',
};
const TRIB_ISSQN = { 1: 'Operação tributável', 2: 'Imunidade', 3: 'Exportação de serviço', 4: 'Não incidência' };
const TP_RET_ISSQN = { 1: 'Não retido', 2: 'Retido pelo tomador', 3: 'Retido pelo intermediário' };
const TP_RET_PIS_COFINS = { 1: 'Retido', 2: 'Não retido' };

const rotuloDe = (mapa, cod) => (cod == null ? null : (mapa[String(cod)] || String(cod)));

// ── formatação (só apresentação; o valor é o do XML) ──

const soDigitos = (v) => String(v == null ? '' : v).replace(/\D/g, '');

function fmtDoc(v) {
  const d = soDigitos(v);
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return v == null ? null : String(v);
}

function fmtCep(v) {
  const d = soDigitos(v);
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : (v == null ? null : String(v));
}

function fmtFone(v) {
  const d = soDigitos(v);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return v == null ? null : String(v);
}

/** "2026-11-11T12:00:05-03:00" → "11/11/2026 12:00:05" (a hora como está no XML). */
function fmtDataHora(v) {
  if (v == null) return null;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return String(v);
  return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}${m[6] ? `:${m[6]}` : ''}`;
}

function fmtData(v) {
  if (v == null) return null;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v);
}

function fmtNumero(n, casas = 2) {
  const [int, dec] = Math.abs(n).toFixed(casas).split('.');
  const milhar = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${n < 0 ? '-' : ''}${milhar}${dec ? `,${dec}` : ''}`;
}

const fmtMoeda = (n) => (n == null ? null : `R$ ${fmtNumero(n)}`);
const fmtPct = (n) => (n == null ? null : `${fmtNumero(n)}%`);

/** cTribNac "240101" → "24.01.01". */
function fmtCTribNac(v) {
  const d = soDigitos(v);
  return d.length === 6 ? `${d.slice(0, 2)}.${d.slice(2, 4)}.${d.slice(4)}` : (v == null ? null : String(v));
}

const juntar = (partes, sep = ' — ') => {
  const p = partes.filter((x) => x != null && String(x).trim() !== '');
  return p.length ? p.join(sep) : null;
};

function linhaEndereco(e) {
  if (!e) return null;
  const rua = juntar([e.xLgr, e.nro], ', ');
  return juntar([rua, e.xCpl, e.xBairro], ' — ');
}

// ── modelo ──

/** Campo do DANFSe; valor vazio some. span = colunas de 4. */
const campo = (rotulo, valor, span = 1, destaque = false) => (
  valor == null || String(valor).trim() === '' ? null : { rotulo, valor: String(valor), span, destaque }
);

const secao = (titulo, campos) => {
  const c = campos.filter(Boolean);
  return c.length ? { titulo, campos: c } : null;
};

function qrDaChave(chave) {
  return chave ? `${CONSULTA_PUBLICA}?tpc=1&chave=${chave}` : CONSULTA_PUBLICA;
}

/**
 * @param {object} l — saída de nfseParser.lerDanfse
 * @param {{ cancelada?: boolean }} [opts] — cancelada vem da situação da nota no banco
 */
function montarDanfse(l, { cancelada = false } = {}) {
  const d = l.dps || {};
  const p = l.prestador || {};
  const e = l.emitente || {};
  const s = l.servico || {};
  const vn = l.valoresNfse || {};
  const vd = l.valoresDps || {};
  const t = l.tomador;

  const avisos = [];
  if (cancelada) avisos.push('NFS-e CANCELADA');
  if (d.tpAmb === '2') avisos.push('Emitida em produção restrita (ambiente de testes) — sem valor fiscal');

  const endEmit = e.endereco;
  const munEmit = endEmit && endEmit.cMun
    ? juntar([endEmit.cMun === d.cLocEmi && l.xLocEmi ? l.xLocEmi : `IBGE ${endEmit.cMun}`, endEmit.UF], ' / ')
    : null;

  const cabecalho = secao('Identificação da NFS-e', [
    campo('Número da NFS-e', l.nNFSe, 1, true),
    campo('Competência', fmtData(d.dCompet)),
    campo('Data e hora da emissão', fmtDataHora(d.dhEmi)),
    campo('Data e hora do processamento', fmtDataHora(l.dhProc)),
    campo('Chave de acesso', l.chaveAcesso, 4, true),
    campo('Número da DPS', d.nDPS),
    campo('Série da DPS', d.serie),
    campo('Local de emissão', l.xLocEmi),
    campo('Número do DFS-e', l.nDFSe),
  ]);

  const emitente = secao('Emitente / prestador do serviço', [
    campo(e.CPF || p.CPF ? 'CPF' : 'CNPJ', fmtDoc(e.CNPJ || e.CPF || p.CNPJ || p.CPF)),
    campo('Inscrição municipal', e.IM || p.IM),
    campo('Nome / razão social', e.xNome, 2),
    campo('Nome fantasia', e.xFant, 2),
    campo('Endereço', linhaEndereco(endEmit), 2),
    campo('Município', munEmit),
    campo('CEP', endEmit && fmtCep(endEmit.CEP)),
    campo('Telefone', fmtFone(e.fone)),
    campo('E-mail', e.email, 2),
  ]);

  const tomador = t ? secao('Tomador do serviço', [
    campo(t.CNPJ ? 'CNPJ' : (t.CPF ? 'CPF' : 'NIF'), fmtDoc(t.CNPJ || t.CPF || t.NIF)),
    campo('Inscrição municipal', t.IM),
    campo('Nome / razão social', t.xNome, 2),
    campo('Endereço', linhaEndereco(t.endereco), 2),
    campo('Município (IBGE)', t.endereco && t.endereco.cMun),
    campo('CEP', t.endereco && fmtCep(t.endereco.CEP)),
    campo('Cidade (exterior)', t.endereco && t.endereco.xCidade),
    campo('Telefone', fmtFone(t.fone)),
    campo('E-mail', t.email, 2),
  ]) : null;

  const servico = secao('Serviço prestado', [
    campo('Código de tributação nacional', juntar([fmtCTribNac(s.cTribNac), l.xTribNac]), 4),
    campo('Código de tributação municipal', juntar([s.cTribMun, l.xTribMun]), 2),
    campo('Código NBS', juntar([s.cNBS, l.xNBS]), 2),
    campo('Local da prestação', l.xLocPrestacao || (s.cLocPrestacao ? `IBGE ${s.cLocPrestacao}` : (s.cPaisPrestacao ? `País ${s.cPaisPrestacao}` : null)), 2),
    campo('Município de incidência do ISSQN', l.xLocIncid || (l.cLocIncid ? `IBGE ${l.cLocIncid}` : null), 2),
    campo('Descrição do serviço', s.xDescServ, 4),
  ]);

  const tributacao = secao('Tributação municipal (ISSQN)', [
    campo('Tributação do ISSQN', rotuloDe(TRIB_ISSQN, vd.tribISSQN), 2),
    campo('Retenção do ISSQN', rotuloDe(TP_RET_ISSQN, vd.tpRetISSQN), 2),
  ]);

  const pisCofinsRet = vd.tpRetPisCofins ? ` (${rotuloDe(TP_RET_PIS_COFINS, vd.tpRetPisCofins).toLowerCase()})` : '';
  const valores = secao('Valores', [
    campo('Valor do serviço', fmtMoeda(vd.vServ)),
    campo('Valor recebido', fmtMoeda(vd.vReceb)),
    campo('Desconto incondicionado', fmtMoeda(vd.vDescIncond)),
    campo('Desconto condicionado', fmtMoeda(vd.vDescCond)),
    campo('Deduções / reduções', fmtMoeda(vn.vCalcDR != null ? vn.vCalcDR : vd.vDR)),
    campo('Base de cálculo do ISSQN', fmtMoeda(vn.vBC)),
    campo('Alíquota do ISSQN', fmtPct(vn.pAliqAplic != null ? vn.pAliqAplic : vd.pAliq)),
    campo('Valor do ISSQN', fmtMoeda(vn.vISSQN)),
    campo('IRRF retido', fmtMoeda(vd.vRetIRRF)),
    campo('Contribuição previdenciária retida', fmtMoeda(vd.vRetCP)),
    campo('CSLL retida', fmtMoeda(vd.vRetCSLL)),
    campo(`PIS${pisCofinsRet}`, fmtMoeda(vd.vPis)),
    campo(`COFINS${pisCofinsRet}`, fmtMoeda(vd.vCofins)),
    campo('Total de retenções', fmtMoeda(vn.vTotalRet)),
    campo('Valor líquido da NFS-e', fmtMoeda(vn.vLiq), 2, true),
  ]);

  const totTrib = vd.pTotTribSN != null
    ? `${fmtPct(vd.pTotTribSN)} (Simples Nacional)`
    : juntar([
      vd.vTotTribFed != null ? `Federais ${fmtMoeda(vd.vTotTribFed)}` : (vd.pTotTribFed != null ? `Federais ${fmtPct(vd.pTotTribFed)}` : null),
      vd.vTotTribEst != null ? `Estaduais ${fmtMoeda(vd.vTotTribEst)}` : (vd.pTotTribEst != null ? `Estaduais ${fmtPct(vd.pTotTribEst)}` : null),
      vd.vTotTribMun != null ? `Municipais ${fmtMoeda(vd.vTotTribMun)}` : (vd.pTotTribMun != null ? `Municipais ${fmtPct(vd.pTotTribMun)}` : null),
    ], ' · ');

  const regime = secao('Regime tributário', [
    campo('Simples Nacional', rotuloDe(OP_SIMP_NAC, p.opSimpNac), 4),
    campo('Regime de apuração', rotuloDe(REG_AP_TRIB_SN, p.regApTribSN), 2),
    campo('Regime especial de tributação', rotuloDe(REG_ESP_TRIB, p.regEspTrib), 2),
    campo('Tributos aproximados', totTrib, 4),
  ]);

  const complementares = secao('Informações complementares', [
    campo('Informações complementares', s.xInfComp, 4),
    campo('Outras informações', l.xOutInf, 4),
  ]);

  return {
    titulo: TITULO,
    numero: l.nNFSe,
    chave: l.chaveAcesso,
    avisos,
    secoes: [cabecalho, emitente, tomador, servico, tributacao, valores, regime, complementares].filter(Boolean),
    consulta: { url: CONSULTA_PUBLICA, qr: qrDaChave(l.chaveAcesso), chave: l.chaveAcesso },
    rodape: RODAPE,
  };
}

// ── PDF ──

// Fontes padrão do PDF (Helvetica) usam WinAnsi: o que não cabe vira "?".
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
function textoPdf(v) {
  return String(v == null ? '' : v)
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('')
    .map((ch) => {
      const c = ch.charCodeAt(0);
      if (ch === '\n') return ch;
      if (c < 0x20 || (c >= 0x7f && c < 0xa0)) return ' ';
      if (c <= 0xff || WIN_ANSI_EXTRA.has(ch)) return ch;
      return '?';
    })
    .join('');
}

const A4 = { w: 595.28, h: 841.89 };
const MARGEM = 32;
const LARGURA = A4.w - MARGEM * 2;
const COR = { texto: '#111111', rotulo: '#555555', linha: '#9a9a9a', faixa: '#e9e9e9', aviso: '#b91c1c' };
const PAD = 3;
const ALTURA_TITULO_SECAO = 13;
// o rodapé fica abaixo da área das seções, dentro da margem de baixo menor
const MARGEM_BAIXO = 14;
const Y_RODAPE = A4.h - MARGEM_BAIXO - 12;
const LIMITE_Y = Y_RODAPE - 8;

function linhasDeCampos(campos) {
  const linhas = [];
  let atual = [];
  let usado = 0;
  for (const c of campos) {
    const span = Math.min(4, Math.max(1, c.span || 1));
    if (usado + span > 4) { linhas.push(atual); atual = []; usado = 0; }
    atual.push({ ...c, span });
    usado += span;
  }
  if (atual.length) linhas.push(atual);
  // a última célula da linha ocupa o que sobrou
  return linhas.map((l) => {
    const total = l.reduce((a, c) => a + c.span, 0);
    if (total < 4) l[l.length - 1] = { ...l[l.length - 1], span: l[l.length - 1].span + (4 - total) };
    return l;
  });
}

function alturaCelula(doc, c, largura) {
  doc.font('Helvetica').fontSize(6.5);
  const hr = doc.heightOfString(textoPdf(c.rotulo), { width: largura - PAD * 2 });
  doc.font(c.destaque ? 'Helvetica-Bold' : 'Helvetica').fontSize(c.destaque ? 10 : 8.5);
  const hv = doc.heightOfString(textoPdf(c.valor), { width: largura - PAD * 2 });
  return hr + hv + PAD * 2 + 1;
}

function desenharCelula(doc, c, x, y, largura, altura) {
  doc.lineWidth(0.5).strokeColor(COR.linha).rect(x, y, largura, altura).stroke();
  doc.fillColor(COR.rotulo).font('Helvetica').fontSize(6.5)
    .text(textoPdf(c.rotulo), x + PAD, y + PAD, { width: largura - PAD * 2 });
  doc.fillColor(COR.texto).font(c.destaque ? 'Helvetica-Bold' : 'Helvetica').fontSize(c.destaque ? 10 : 8.5)
    .text(textoPdf(c.valor), x + PAD, doc.y + 1, { width: largura - PAD * 2 });
}

function desenharRodape(doc, rodape) {
  const y = Y_RODAPE;
  doc.fillColor(COR.rotulo).font('Helvetica').fontSize(6.5)
    .text(textoPdf(rodape), MARGEM, y, { width: LARGURA, align: 'center', lineBreak: false });
}

function novaPagina(doc, modelo) {
  desenharRodape(doc, modelo.rodape);
  doc.addPage();
  return MARGEM;
}

function desenharSecao(doc, modelo, sec, y0) {
  let y = y0;
  const linhas = linhasDeCampos(sec.campos);
  const larg = (span) => (LARGURA * span) / 4;
  const alturas = linhas.map((l) => Math.max(...l.map((c) => alturaCelula(doc, c, larg(c.span)))));
  // título nunca fica sozinho no pé da página
  if (y + ALTURA_TITULO_SECAO + alturas[0] > LIMITE_Y) y = novaPagina(doc, modelo);
  doc.rect(MARGEM, y, LARGURA, ALTURA_TITULO_SECAO).fill(COR.faixa);
  doc.fillColor(COR.texto).font('Helvetica-Bold').fontSize(7.5)
    .text(textoPdf(sec.titulo.toUpperCase()), MARGEM + PAD, y + 3.5, { width: LARGURA - PAD * 2, lineBreak: false });
  y += ALTURA_TITULO_SECAO;
  linhas.forEach((l, i) => {
    if (y + alturas[i] > LIMITE_Y) y = novaPagina(doc, modelo);
    let x = MARGEM;
    for (const c of l) {
      desenharCelula(doc, c, x, y, larg(c.span), alturas[i]);
      x += larg(c.span);
    }
    y += alturas[i];
  });
  return y + 5;
}

/**
 * Desenha o modelo num PDF A4. @returns {Promise<Buffer>}
 * @param {{ compress?: boolean }} [opts] — compress:false só nos testes (texto legível no PDF)
 */
async function desenharPdf(modelo, { compress = true } = {}) {
  const qrPng = await QRCode.toBuffer(modelo.consulta.qr, { margin: 0, width: 240, errorCorrectionLevel: 'M' });
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4', margins: { top: MARGEM, left: MARGEM, right: MARGEM, bottom: MARGEM_BAIXO }, compress,
        info: { Title: textoPdf(`DANFSe ${modelo.numero || ''}`.trim()), Producer: 'Aura', Creator: 'Aura' },
      });
      const partes = [];
      doc.on('data', (c) => partes.push(c));
      doc.on('end', () => resolve(Buffer.concat(partes)));
      doc.on('error', reject);

      // cabeçalho: título à esquerda, QR da consulta à direita
      const QR = 74;
      let y = MARGEM;
      doc.fillColor(COR.texto).font('Helvetica-Bold').fontSize(14)
        .text(textoPdf(modelo.titulo), MARGEM, y, { width: LARGURA - QR - 12 });
      doc.font('Helvetica').fontSize(8).fillColor(COR.rotulo)
        .text('Nota Fiscal de Serviço eletrônica — Sistema Nacional NFS-e', MARGEM, doc.y + 2, { width: LARGURA - QR - 12 });
      if (modelo.numero) {
        doc.font('Helvetica-Bold').fontSize(11).fillColor(COR.texto)
          .text(textoPdf(`NFS-e nº ${modelo.numero}`), MARGEM, doc.y + 6, { width: LARGURA - QR - 12 });
      }
      for (const a of modelo.avisos) {
        doc.font('Helvetica-Bold').fontSize(10).fillColor(COR.aviso)
          .text(textoPdf(a), MARGEM, doc.y + 4, { width: LARGURA - QR - 12 });
      }
      doc.image(qrPng, MARGEM + LARGURA - QR, MARGEM, { width: QR, height: QR });
      y = Math.max(doc.y, MARGEM + QR) + 10;

      for (const sec of modelo.secoes) y = desenharSecao(doc, modelo, sec, y);

      // consulta pública: link e a chave em destaque
      if (y + 46 > LIMITE_Y) y = novaPagina(doc, modelo);
      doc.lineWidth(0.5).strokeColor(COR.linha).rect(MARGEM, y, LARGURA, 42).stroke();
      doc.fillColor(COR.texto).font('Helvetica').fontSize(8)
        .text('Consulte a autenticidade desta NFS-e na consulta pública do Sistema Nacional NFS-e:', MARGEM + PAD, y + PAD, { width: LARGURA - PAD * 2 });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1d4ed8')
        .text(modelo.consulta.url, MARGEM + PAD, doc.y + 1, { width: LARGURA - PAD * 2, link: modelo.consulta.url, underline: true });
      if (modelo.consulta.chave) {
        doc.font('Courier-Bold').fontSize(10).fillColor(COR.texto)
          .text(textoPdf(`Chave de acesso: ${modelo.consulta.chave}`), MARGEM + PAD, doc.y + 3, { width: LARGURA - PAD * 2 });
      }

      desenharRodape(doc, modelo.rodape);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * DANFSe da Aura a partir do XML da NFS-e autorizada.
 * @param {string} nfseXml
 * @param {{ cancelada?: boolean, compress?: boolean }} [opts]
 * @returns {Promise<Buffer>} PDF
 */
async function gerarDanfsePdf(nfseXml, { cancelada = false, compress = true } = {}) {
  const modelo = montarDanfse(lerDanfse(nfseXml), { cancelada });
  return desenharPdf(modelo, { compress });
}

module.exports = {
  montarDanfse, gerarDanfsePdf, desenharPdf, textoPdf,
  CONSULTA_PUBLICA, RODAPE, TITULO,
};
