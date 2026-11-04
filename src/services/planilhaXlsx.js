// ============================================================
// AURA. — Planilha .xlsx mínima, sem dependência (03/11/2026)
//
// Para o anexo do e-mail de fechamento do mês (services/fechamentoDoMes.js).
// O PO escolheu .xlsx (abre "bonito" no Excel; o .csv bagunça acento e
// vírgula). O backend não tinha biblioteca de planilha e o package-lock do
// main está fora de sincronia (npm ci falha), então em vez de dependência
// nova: o formato Office Open XML é um zip com 6 arquivos XML. O zip sai sem
// compressão (STORE), o que todo leitor aceita — a planilha do mês tem
// poucas centenas de linhas.
//
// Uma aba, cabeçalho em negrito, cabeçalho congelado, filtro automático,
// larguras de coluna; número fica número (soma e filtro funcionam no
// Excel), texto vira "inline string".
// ============================================================
'use strict';

// ── CRC-32 (o zip exige) ──────────────────────────────────────────
const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABELA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Zip sem compressão. arquivos: [{ nome, dados: Buffer }]. */
function zipSemCompressao(arquivos, quando = new Date()) {
  const hora = ((quando.getHours() << 11) | (quando.getMinutes() << 5) | Math.floor(quando.getSeconds() / 2)) & 0xffff;
  const data = (((quando.getFullYear() - 1980) << 9) | ((quando.getMonth() + 1) << 5) | quando.getDate()) & 0xffff;
  const locais = [];
  const centrais = [];
  let deslocamento = 0;
  for (const a of arquivos) {
    const nome = Buffer.from(a.nome, 'utf8');
    const dados = a.dados;
    const crc = crc32(dados);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // versão necessária
    local.writeUInt16LE(0x0800, 6);   // nomes em UTF-8
    local.writeUInt16LE(0, 8);        // STORE
    local.writeUInt16LE(hora, 10);
    local.writeUInt16LE(data, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(dados.length, 18);
    local.writeUInt32LE(dados.length, 22);
    local.writeUInt16LE(nome.length, 26);
    local.writeUInt16LE(0, 28);
    locais.push(local, nome, dados);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(hora, 12);
    central.writeUInt16LE(data, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(dados.length, 20);
    central.writeUInt32LE(dados.length, 24);
    central.writeUInt16LE(nome.length, 28);
    central.writeUInt32LE(deslocamento, 42);
    centrais.push(central, nome);
    deslocamento += 30 + nome.length + dados.length;
  }
  const tamanhoCentral = centrais.reduce((s, b) => s + b.length, 0);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(arquivos.length, 8);
  fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(tamanhoCentral, 12);
  fim.writeUInt32LE(deslocamento, 16);
  return Buffer.concat([...locais, ...centrais, fim]);
}

// ── XML da planilha ───────────────────────────────────────────────

function xmlEsc(v) {
  return String(v)
    // Caractere de controle quebra o XML (e o Excel recusa o arquivo).
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function letraDaColuna(i) { // 0 -> A, 25 -> Z, 26 -> AA
  let s = '';
  let n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Estilos: 0 normal, 1 cabeçalho em negrito, 2 número com 2 casas (#,##0.00), 3 inteiro (#,##0).
const ESTILOS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="4">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/**
 * @param {object} p
 * @param {string} p.aba        nome da aba (até 31 caracteres)
 * @param {Array<{titulo, tipo?: 'texto'|'moeda'|'inteiro'|'numero', largura?}>} p.colunas
 * @param {Array<Array>} p.linhas  valores na ordem das colunas
 * @returns {Buffer} o .xlsx
 */
function montarXlsx({ aba = 'Planilha', colunas, linhas }) {
  const nomeAba = xmlEsc(String(aba).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Planilha');
  const ultimaCol = letraDaColuna(colunas.length - 1);
  const cel = (ref, valor, tipo, estilo) => {
    if (valor === null || valor === undefined || valor === '') return '';
    if (tipo !== 'texto' && typeof valor === 'number' && Number.isFinite(valor)) {
      const s = estilo != null ? estilo : tipo === 'moeda' ? 2 : tipo === 'inteiro' ? 3 : 0;
      return `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${valor}</v></c>`;
    }
    return `<c r="${ref}" t="inlineStr"${estilo ? ` s="${estilo}"` : ''}><is><t xml:space="preserve">${xmlEsc(valor)}</t></is></c>`;
  };
  const cab = `<row r="1">${colunas.map((c, i) => cel(letraDaColuna(i) + '1', c.titulo, 'texto', 1)).join('')}</row>`;
  const corpo = linhas.map((l, j) => {
    const r = j + 2;
    return `<row r="${r}">${colunas.map((c, i) => cel(letraDaColuna(i) + r, l[i], c.tipo || 'texto')).join('')}</row>`;
  }).join('');
  const cols = `<cols>${colunas.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.largura || 14}" customWidth="1"/>`).join('')}</cols>`;
  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    cols +
    `<sheetData>${cab}${corpo}</sheetData>` +
    `<autoFilter ref="A1:${ultimaCol}${Math.max(linhas.length + 1, 1)}"/>` +
    '</worksheet>';

  const arquivos = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets><sheet name="${nomeAba}" sheetId="1" r:id="rId1"/></sheets>` +
      `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${nomeAba.replace(/'/g, "''")}'!$A$1:$${ultimaCol}$${Math.max(linhas.length + 1, 1)}</definedName></definedNames>` +
      '</workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>'],
    ['xl/worksheets/sheet1.xml', sheet],
    ['xl/styles.xml', ESTILOS],
  ];
  return zipSemCompressao(arquivos.map(([nome, xml]) => ({ nome, dados: Buffer.from(xml, 'utf8') })));
}

module.exports = { montarXlsx, zipSemCompressao, crc32, letraDaColuna, xmlEsc };
