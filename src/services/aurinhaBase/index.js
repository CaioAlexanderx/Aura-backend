// ============================================================
// AURA. — aurinhaBase: base de conhecimento da Aurinha de plantão
//
// Um arquivo markdown por tema, nesta pasta. Cada arquivo abre com um
// cabeçalho:
//
//   ---
//   tema: Nome do tema
//   palavras: palavra, outra palavra, expressão de duas palavras
//   ---
//   - o que a Aurinha pode afirmar sobre o tema
//
// PARA ENSINAR ALGO À AURINHA: edite o .md do tema (ou crie um arquivo novo
// com o mesmo cabeçalho). Nada mais precisa mudar — a pasta é lida no boot.
//
// A base NÃO vai inteira no prompt: selecionarTemas() escolhe os temas pela
// fala do cliente, por palavra-chave (sem acento, sem caixa). Expressão de
// mais de uma palavra pesa mais que palavra solta. Sem nenhuma palavra
// batendo, nenhum tema entra e a persona cai no "não sei" (anota e promete
// retorno) — nunca responde de cabeça.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_TEMAS = 2;

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function lerTema(arquivo, bruto) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(bruto);
  if (!m) return null;
  const cab = {};
  for (const linha of m[1].split(/\r?\n/)) {
    const i = linha.indexOf(':');
    if (i > 0) cab[linha.slice(0, i).trim()] = linha.slice(i + 1).trim();
  }
  const palavras = String(cab.palavras || '')
    .split(',').map(normalizar).filter(Boolean);
  const conteudo = m[2].trim();
  if (!cab.tema || !palavras.length || !conteudo) return null;
  return { id: path.basename(arquivo, '.md'), tema: cab.tema, palavras, conteudo };
}

function carregarTemas(dir = __dirname) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => lerTema(f, fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter(Boolean);
}

const TEMAS = carregarTemas();

// Quanto o tema tem a ver com o texto. Palavra inteira (ou no plural simples).
function pontuar(tema, textoNormalizado) {
  const alvo = ` ${textoNormalizado} `;
  let pontos = 0;
  for (const p of tema.palavras) {
    if (alvo.includes(` ${p} `) || alvo.includes(` ${p}s `)) pontos += p.split(' ').length;
  }
  return pontos;
}

// Temas mais relevantes para o texto, no máximo `max`. Empate: ordem do arquivo.
function selecionarTemas(texto, { max = MAX_TEMAS, temas = TEMAS } = {}) {
  const t = normalizar(texto);
  if (!t) return [];
  return temas
    .map((tema) => ({ tema, pontos: pontuar(tema, t) }))
    .filter((x) => x.pontos > 0)
    .sort((a, b) => b.pontos - a.pontos)
    .slice(0, max)
    .map((x) => x.tema);
}

module.exports = { TEMAS, selecionarTemas, carregarTemas, normalizar, MAX_TEMAS };
