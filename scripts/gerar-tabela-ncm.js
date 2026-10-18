#!/usr/bin/env node
// ============================================================
// AURA. — Gera src/data/ncm-siscomex.json a partir da tabela oficial NCM.
//
// Fonte: Portal Único Siscomex (Receita Federal / Gecex), arquivo de DADOS
// publico em JSON:
//   https://portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json
//
// Uso (atualizar a lista quando sair resolução nova da Gecex):
//   1. baixe o JSON do endereço acima para um arquivo temporario;
//   2. node scripts/gerar-tabela-ncm.js <entrada.json> [saida.json]
//
// Guardamos so os codigos de 8 digitos vigentes (Data_Fim = 31/12/9999) com a
// descricao composta pela hierarquia (posicao > subposicao > item), que e o
// que a Receita publica. A lista e DADO versionado, nao migration.
// ============================================================
'use strict';
const fs   = require('fs');
const path = require('path');

const entrada = process.argv[2];
const saida   = process.argv[3] || path.join(__dirname, '..', 'src', 'data', 'ncm-siscomex.json');
if (!entrada) {
  console.error('uso: node scripts/gerar-tabela-ncm.js <entrada.json> [saida.json]');
  process.exit(1);
}

const bruto = JSON.parse(fs.readFileSync(entrada, 'utf8'));
const lista = bruto.Nomenclaturas;
if (!Array.isArray(lista) || lista.length < 5000) {
  console.error('arquivo inesperado: Nomenclaturas ausente ou pequena demais');
  process.exit(1);
}

function limpa(d) {
  return String(d || '').replace(/<[^>]*>/g, '').replace(/^[\s-]+/, '').replace(/[:\s]+$/, '').replace(/\s+/g, ' ').trim();
}
function nivel(d) {
  const m = /^(-+)/.exec(String(d || '').trim());
  return m ? m[1].length : 0;
}

// "Vigente em 18/10/2026" -> 2026-10-18
const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(bruto.Data_Ultima_Atualizacao_NCM || '');
const vigenteEm = m ? `${m[3]}-${m[2]}-${m[1]}` : null;

const itens = {};
const posicoes = {};         // descricao da posicao de 4 digitos (ex.: 6109 - camisetas)
let posicao = '';
let pilha = [];              // pilha[k] = descricao do nivel de tracos k+1
for (const n of lista) {
  const digitos = String(n.Codigo || '').replace(/\D/g, '');
  const desc = limpa(n.Descricao);
  if (digitos.length === 4) { posicao = digitos; posicoes[digitos] = desc; pilha = []; continue; }
  if (digitos.length < 4) continue;
  const k = nivel(n.Descricao);
  if (k > 0) { pilha = pilha.slice(0, k - 1); pilha[k - 1] = desc; }
  if (digitos.length === 8 && n.Data_Fim === '31/12/9999') {
    const pais = pilha.slice(0, Math.max(k - 1, 0)).filter(Boolean);
    itens[digitos] = [...pais, desc].filter(Boolean).join(' > ');
  }
}

const codigos = Object.keys(itens).sort();
const ordenado = {};
for (const c of codigos) ordenado[c] = itens[c];

const out = {
  fonte: 'Receita Federal / Siscomex - Tabela NCM (Portal Unico, classificacao fiscal)',
  url: 'https://portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json',
  ato: bruto.Ato || null,
  vigente_em: vigenteEm,
  total: codigos.length,
  // descricao completa de um NCM = posicoes[4 primeiros digitos] + ' > ' + itens[codigo]
  posicoes,
  itens: ordenado,
};
fs.mkdirSync(path.dirname(saida), { recursive: true });
fs.writeFileSync(saida, JSON.stringify(out, null, 0) + '\n', 'utf8');
console.log(`ok: ${codigos.length} NCMs de 8 digitos, vigente em ${vigenteEm}, ${bruto.Ato || ''} -> ${saida}`);
