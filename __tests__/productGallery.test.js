// ============================================================
// AURA — Galeria de fotos do produto (S9, migrations 290/291)
//
// `products.image_url` guardava UMA foto. Uma caneca precisa de mais de
// um angulo — a estampa, a alca, o interior colorido, a foto de uso — e a
// vitrine ficava pobre por limitacao de cadastro, nao por falta de
// material.
//
// A regra que estes testes mais protegem: o indice 0 e a CAPA e
// `image_url` continua espelhando ela. Todo o resto do sistema le
// image_url — listagem, carrinho, marketplace, notificacao, PDV — e nada
// disso foi tocado. Se o espelho quebrar, some foto em lugares que
// ninguem esta olhando agora.
// ============================================================
'use strict';

const {
  MAX_FOTOS, urlValida, normalizeGallery, setCover,
} = require('../src/services/productGallery');

const A = 'https://cdn.exemplo.com/caneca-frente.png';
const B = 'https://cdn.exemplo.com/caneca-alca.png';
const C = 'https://cdn.exemplo.com/caneca-uso.webp';

describe('normalizeGallery', () => {
  test('a capa e o primeiro item da lista', () => {
    expect(normalizeGallery([A, B, C])).toEqual({ gallery: [A, B, C], cover: A });
  });

  test('galeria vazia zera a capa — produto pode ficar sem foto', () => {
    expect(normalizeGallery([])).toEqual({ gallery: [], cover: null });
    expect(normalizeGallery(null)).toEqual({ gallery: [], cover: null });
  });

  test('aceita a lista como string JSON', () => {
    expect(normalizeGallery(JSON.stringify([A, B])).gallery).toEqual([A, B]);
  });

  // Derivado de MAX_FOTOS de proposito: o limite ja mudou uma vez (6 -> 5) e
  // um numero fixo aqui vira falso negativo na proxima.
  test(`recusa acima de ${MAX_FOTOS} fotos`, () => {
    const demais = Array.from({ length: MAX_FOTOS + 1 }, (_, i) => `https://cdn.exemplo.com/${i}.png`);
    expect(normalizeGallery(demais).error).toMatch(new RegExp(`Maximo de ${MAX_FOTOS}`));
    expect(normalizeGallery(demais.slice(0, MAX_FOTOS)).gallery).toHaveLength(MAX_FOTOS);
  });

  // A mesma foto duas vezes no carrossel e erro de cadastro, nao intencao
  // — e nao pode consumir uma das vagas.
  test('duplicata e descartada, sem gastar vaga', () => {
    const r = normalizeGallery([A, B, A, B, C]);
    expect(r.gallery).toEqual([A, B, C]);
  });

  test('URL invalida e recusada com mensagem util', () => {
    expect(normalizeGallery(['nao e url']).error).toMatch(/Foto invalida/);
    expect(normalizeGallery([A, '']).error).toMatch(/Foto invalida/);
    expect(normalizeGallery([123]).error).toMatch(/Foto invalida/);
  });

  test('valor que nao e lista e recusado', () => {
    expect(normalizeGallery({ url: A }).error).toMatch(/deve ser uma lista/);
    expect(normalizeGallery('{quebrado').error).toMatch(/invalido/);
  });
});

describe('urlValida', () => {
  test('aceita http, https e data URI de imagem', () => {
    expect(urlValida('http://x.com/a.png')).toBe(true);
    expect(urlValida('https://x.com/a.png')).toBe(true);
    expect(urlValida('data:image/png;base64,iVBOR')).toBe(true);
  });

  // Nao executa nada num <img>, mas vira foto quebrada na vitrine — e
  // isso o cliente ve.
  test('recusa o que nao carrega como imagem', () => {
    expect(urlValida('javascript:alert(1)')).toBe(false);
    expect(urlValida('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    expect(urlValida('ftp://x.com/a.png')).toBe(false);
    expect(urlValida('  ')).toBe(false);
    expect(urlValida('https://x.com/' + 'a'.repeat(2100))).toBe(false);
  });
});

describe('setCover — "definir como capa" e reordenar', () => {
  test('a foto escolhida vai para a frente, o resto mantem a ordem', () => {
    expect(setCover([A, B, C], C)).toEqual([C, A, B]);
  });

  test('escolher a que ja e capa nao muda nada', () => {
    expect(setCover([A, B, C], A)).toEqual([A, B, C]);
  });

  test('foto fora da galeria devolve null em vez de inventar', () => {
    expect(setCover([A, B], C)).toBeNull();
  });
});
