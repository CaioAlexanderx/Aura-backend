// ============================================================
// tests/helpers/textoDoPdf: texto de um PDF gerado pelo PDFKit com as
// fontes padrão (WinAnsi), para conferir o conteúdo nos testes.
// Abre os streams (comprimidos ou não) e decodifica os trechos hex dos
// operadores TJ. Cada TJ vira uma linha.
// ============================================================
'use strict';

const zlib = require('zlib');

// WinAnsi difere do latin1 só em 0x80–0x9F; os usados no DANFSe:
const WIN_ANSI = { 0x96: '–', 0x97: '—', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x85: '…' };

function decodificarHex(hex) {
  const bytes = Buffer.from(hex.replace(/\s+/g, ''), 'hex');
  return [...bytes].map((b) => WIN_ANSI[b] || String.fromCharCode(b)).join('');
}

function streams(buf) {
  const s = buf.toString('latin1');
  const out = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const ini = m.index + m[0].length;
    const fim = s.indexOf('endstream', ini);
    if (fim < 0) break;
    const bruto = buf.subarray(ini, fim);
    try { out.push(zlib.inflateSync(bruto).toString('latin1')); } catch (_) { out.push(bruto.toString('latin1')); }
    re.lastIndex = fim;
  }
  return out;
}

function textoDoPdf(buf) {
  const linhas = [];
  for (const st of streams(buf)) {
    const re = /\[((?:<[0-9a-fA-F\s]*>|[-\d.\s])*)\]\s*TJ/g;
    let m;
    while ((m = re.exec(st))) {
      const partes = m[1].match(/<[0-9a-fA-F\s]*>/g) || [];
      linhas.push(partes.map((p) => decodificarHex(p.slice(1, -1))).join(''));
    }
  }
  return linhas.join('\n');
}

module.exports = { textoDoPdf };
