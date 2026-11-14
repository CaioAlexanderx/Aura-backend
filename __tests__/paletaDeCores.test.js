// ============================================================
// AURA. — A paleta única de cores (CP3 da revisão de cores, 14/11/2026)
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  PALETA, FAMILIAS, chaveDoNome, corPeloNome, hexPeloNome, maisPerto, porFamilia,
} = require('../src/services/paletaDeCores');

// O MESMO arquivo vive no app (constants/paletaDeCores.json), com o mesmo
// hash no __tests__/paletaDeCores.test.ts de lá. Mudou a paleta: copie o
// arquivo para o outro repositório e troque o hash nos DOIS testes.
const SHA256_DA_PALETA = '1b6079ebae74a46a728ccdb72815a8605938f6f18176d8d0a38fe00353c14423';

test('o arquivo é o mesmo do app (sha256, fim de linha normalizado)', () => {
  const bruto = fs.readFileSync(path.join(__dirname, '../src/data/paletaDeCores.json'), 'utf8').replace(/\r\n/g, '\n');
  expect(crypto.createHash('sha256').update(bruto).digest('hex')).toBe(SHA256_DA_PALETA);
});

describe('os dados', () => {
  test('a lista da vitrine com acentos, mais Caqui e Azul escuro', () => {
    expect(PALETA.length).toBe(49);
    const nomes = PALETA.map((c) => c.nome);
    for (const n of ['Caqui', 'Azul escuro', 'Off white', 'Verde-água', 'Azul-marinho', 'Bordô', 'Lilás', 'Petróleo', 'Salmão']) {
      expect(nomes).toContain(n);
    }
  });
  test('todo hex é válido e único; toda família existe', () => {
    const hexes = PALETA.map((c) => c.hex);
    for (const h of hexes) expect(h).toMatch(/^#[0-9A-F]{6}$/);
    expect(new Set(hexes).size).toBe(hexes.length);
    for (const c of PALETA) expect(FAMILIAS).toContain(c.familia);
  });
  test('nenhum nome ou apelido aponta para duas cores', () => {
    const visto = new Map();
    for (const c of PALETA) {
      for (const n of [c.nome, ...c.apelidos]) {
        const k = chaveDoNome(n);
        if (visto.has(k)) expect(visto.get(k)).toBe(c.nome);
        visto.set(k, c.nome);
      }
    }
  });
});

describe('ler um nome de cor', () => {
  test.each([
    ['Caqui', '#C3B091'], ['caqui', '#C3B091'], ['khaki', '#C3B091'],
    ['Preta', '#111111'], ['PRETO', '#111111'],
    ['Off white', '#F3EFE7'], ['off-white', '#F3EFE7'], ['OFFWHITE', '#F3EFE7'],
    ['Verde agua', '#7FD1C1'], ['verde-água', '#7FD1C1'],
    ['Azul marinho', '#1B2A4A'], ['marinho', '#1B2A4A'],
    ['Azul escuro', '#1C2F6B'],
  ])('%p → %p', (nome, hex) => {
    expect(hexPeloNome(nome)).toBe(hex);
  });
  test('nome desconhecido, vazio ou nulo → null', () => {
    expect(hexPeloNome('Rosa chiclete')).toBeNull();
    expect(hexPeloNome('')).toBeNull();
    expect(hexPeloNome(null)).toBeNull();
    expect(corPeloNome('Rosa chiclete')).toBeNull();
  });
  test('corPeloNome devolve o nome da paleta', () => {
    expect(corPeloNome('preta')).toMatchObject({ nome: 'Preto', familia: 'Neutros' });
  });
});

describe('mais perto e por família', () => {
  test('o tom mais perto de um hex', () => {
    expect(maisPerto('#C3B091').nome).toBe('Caqui');
    expect(maisPerto('#1F2A44').nome).toBe('Azul-marinho');
    expect(maisPerto('azul')).toBeNull();
  });
  test('por família, na ordem das famílias, sem perder cor', () => {
    const g = porFamilia();
    expect(g.map((x) => x.familia)).toEqual([...FAMILIAS]);
    expect(g.reduce((n, x) => n + x.cores.length, 0)).toBe(PALETA.length);
  });
});
