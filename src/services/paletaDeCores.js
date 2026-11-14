// ============================================================
// AURA. — A paleta única de cores (CP3 da revisão de cores, 14/11/2026)
//
// Os dados moram em src/data/paletaDeCores.json — o MESMO arquivo do app
// (constants/paletaDeCores.json), travado por sha256 nos dois repositórios
// (__tests__/paletaDeCores.test.js aqui, __tests__/paletaDeCores.test.ts lá).
//
// Para que serve: o editor de cor (nome + amostra), as sugestões de nome
// (CP5), a busca (CP6) e ler um NOME de cor que chega em importação ou na
// grade ("Caqui", "Preta", "Off white") como amostra.
//
// Para que NÃO serve: dar nome a uma cor sem nome na tela ou na etiqueta.
// Essa reserva continua sendo a paleta de 26 tons do app
// (services/nomeDaCor.js), congelada para a etiqueta sair igual.
//
// Funções puras, sem banco: o Studio usa do mesmo jeito quando vier para o
// Negócio.
// ============================================================
'use strict';

const dados = require('../data/paletaDeCores.json');

const HEX = /^#[0-9A-Fa-f]{6}$/;

/** "Verde-água " → "verde agua": sem acento, minúsculo, hífen vira espaço. */
function chaveDoNome(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const PALETA = Object.freeze(dados.cores.map((c) => Object.freeze({
  nome: c.nome, hex: c.hex.toUpperCase(), familia: c.familia, apelidos: Object.freeze([...(c.apelidos || [])]),
})));
const FAMILIAS = Object.freeze([...dados.familias]);

const INDICE = (() => {
  const m = new Map();
  for (const c of PALETA) {
    for (const n of [c.nome, ...c.apelidos]) {
      const k = chaveDoNome(n);
      if (k && !m.has(k)) m.set(k, c);
    }
  }
  return m;
})();

/** A cor da paleta com esse nome ou apelido ("preta", "Verde agua", "khaki"), ou null. */
function corPeloNome(nome) {
  const k = chaveDoNome(nome);
  return (k && INDICE.get(k)) || null;
}

/** Hex da cor com esse nome ou apelido, ou null. */
function hexPeloNome(nome) {
  const c = corPeloNome(nome);
  return c ? c.hex : null;
}

/**
 * A cor da paleta mais perto de um hex, com a distância de peso perceptual
 * da vitrine (services/coresDaLoja.js). Hex inválido → null.
 */
function maisPerto(hex) {
  if (!HEX.test(String(hex || ''))) return null;
  const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const [r, g, b] = rgb(hex);
  let melhor = null;
  let menor = Infinity;
  for (const c of PALETA) {
    const [cr, cg, cb] = rgb(c.hex);
    const d = Math.sqrt(2 * (r - cr) ** 2 + 4 * (g - cg) ** 2 + 3 * (b - cb) ** 2);
    if (d < menor) { menor = d; melhor = c; }
  }
  return melhor;
}

/** As cores agrupadas, na ordem das famílias: [{ familia, cores: [...] }]. */
function porFamilia() {
  return FAMILIAS.map((f) => ({ familia: f, cores: PALETA.filter((c) => c.familia === f) }));
}

module.exports = {
  PALETA,
  FAMILIAS,
  chaveDoNome,
  corPeloNome,
  hexPeloNome,
  maisPerto,
  porFamilia,
};
