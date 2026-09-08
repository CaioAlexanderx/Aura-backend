// ============================================================
// AURA — Galeria de fotos por cor (migration 323)
//
// Ate aqui a peca tinha UMA foto e cada cor tinha UMA. Quem vende tenis
// fotografa o de cima, o de lado e a sola — agora cabem quatro por cor.
//
// As duas regras que estes testes mais protegem:
//
//   1. O LIMITE. Quatro por cor e quatro na principal, e a mensagem muda
//      conforme a galeria: quem esta cadastrando precisa saber se estourou
//      "a cor" ou "as principais". A UI sugere duas fotos por cor — isso e
//      dica de tela, nao regra de servidor, e quem fotografou quatro
//      angulos nao pode levar erro por isso.
//
//   2. A POSICAO SEM BURACO. Dentro de um par (produto, cor) as posicoes
//      sao 0..n-1, sempre — porque a posicao 0 e a CAPA e ela espelha
//      products.image_url e a foto das variantes daquela cor. Um buraco no
//      inicio deixaria a peca sem capa COM fotos cadastradas, e o lugar
//      onde isso aparece e a vitrine.
// ============================================================
'use strict';

const {
  MAX_FOTOS,
  normalizarCorHex,
  erroDeLimite,
  proximaPosicao,
  reempacotarAposRemover,
  ordenarPorIds,
  agruparGaleria,
} = require('../src/services/productImageGallery');

/** Uma galeria com n fotos, ja nas posicoes 0..n-1. */
function fotos(n, cor = null) {
  return Array.from({ length: n }, (_, i) => ({
    id: `f${i}`, color_hex: cor, url: `https://cdn.exemplo.com/${i}.jpg`,
    thumb_url: `https://cdn.exemplo.com/${i}.thumb.jpg`, position: i,
  }));
}

describe('erroDeLimite — quatro por cor, quatro na principal', () => {
  // Derivado de MAX_FOTOS de proposito: o limite da galeria antiga ja
  // mudou uma vez (6 -> 5) e um numero fixo aqui vira falso negativo.
  test(`aceita ate ${MAX_FOTOS} fotos numa cor`, () => {
    for (let n = 0; n < MAX_FOTOS; n++) {
      expect(erroDeLimite('#1f2937', n)).toBeNull();
    }
    expect(erroDeLimite('#1f2937', MAX_FOTOS)).toBe(`Máximo de ${MAX_FOTOS} fotos por cor`);
  });

  test('a galeria principal tem o mesmo limite e mensagem PROPRIA', () => {
    expect(erroDeLimite(null, MAX_FOTOS - 1)).toBeNull();
    expect(erroDeLimite(null, MAX_FOTOS)).toBe(`Máximo de ${MAX_FOTOS} fotos principais`);
  });

  test('a mensagem distingue a cor da principal — o lojista precisa saber onde estourou', () => {
    expect(erroDeLimite('#000000', MAX_FOTOS)).not.toBe(erroDeLimite(null, MAX_FOTOS));
  });

  // Duas fotos por cor e a sugestao da tela. Se virasse regra aqui, a
  // lojista com quatro angulos do mesmo tenis levaria 400.
  test('duas fotos numa cor nao e limite — a sugestao da UI nao vira regra', () => {
    expect(erroDeLimite('#ff0000', 2)).toBeNull();
    expect(erroDeLimite('#ff0000', 3)).toBeNull();
  });

  test('base suja com mais fotos do que o limite continua recusando', () => {
    expect(erroDeLimite('#ff0000', MAX_FOTOS + 3)).toMatch(/por cor/);
  });
});

describe('proximaPosicao', () => {
  test('a foto entra no fim da fila', () => {
    expect(proximaPosicao(0)).toBe(0);
    expect(proximaPosicao(3)).toBe(3);
  });

  // De proposito NAO deriva do maior `position` gravado: numa base com
  // buraco (posicoes 0 e 2), o maior + 1 daria 3 e a fila ficaria pior.
  test('nao inventa posicao a partir de lixo', () => {
    expect(proximaPosicao(undefined)).toBe(0);
    expect(proximaPosicao(-5)).toBe(0);
  });
});

describe('reempacotarAposRemover — a fila fecha o buraco', () => {
  test('apagar a do meio reempacota o resto em 0..n-1', () => {
    const r = reempacotarAposRemover(fotos(4), 'f1');
    expect(r.restantes.map((f) => [f.id, f.position]))
      .toEqual([['f0', 0], ['f2', 1], ['f3', 2]]);
  });

  test('so as que MUDARAM entram no UPDATE', () => {
    const r = reempacotarAposRemover(fotos(4), 'f2');
    // f0 e f1 ficam onde estavam; so f3 desce.
    expect(r.mudancas).toEqual([{ id: 'f3', position: 2 }]);
  });

  // A parte que quebra em silencio: apagar a capa tem que PROMOVER a
  // seguinte, senao a peca fica sem foto na vitrine com fotos no banco.
  test('apagar a capa promove a seguinte', () => {
    const r = reempacotarAposRemover(fotos(3), 'f0');
    expect(r.capa).toMatchObject({ id: 'f1', position: 0 });
  });

  test('apagar a ultima foto deixa a galeria sem capa — a coluna legada tem que ser limpa', () => {
    const r = reempacotarAposRemover(fotos(1), 'f0');
    expect(r.restantes).toEqual([]);
    expect(r.capa).toBeNull();
  });

  test('apagar id que nao esta na lista nao mexe em nada', () => {
    const r = reempacotarAposRemover(fotos(3), 'nao-existe');
    expect(r.restantes).toHaveLength(3);
    expect(r.mudancas).toEqual([]);
  });

  // Base vinda de antes, com posicoes repetidas ou fora de ordem: o
  // reempacotamento e a chance de consertar, nao de preservar o defeito.
  test('base com posicoes tortas sai reempacotada mesmo assim', () => {
    const tortas = [
      { id: 'a', position: 5 },
      { id: 'b', position: 5 },
      { id: 'c', position: 1 },
    ];
    const r = reempacotarAposRemover(tortas, 'c');
    expect(r.restantes.map((f) => f.position)).toEqual([0, 1]);
  });
});

describe('ordenarPorIds — reordenar sem sortear a capa', () => {
  test('a ordem pedida vira posicao 0..n-1', () => {
    const r = ordenarPorIds(fotos(3), ['f2', 'f0', 'f1']);
    expect(r.ordem).toEqual([
      { id: 'f2', position: 0 },
      { id: 'f0', position: 1 },
      { id: 'f1', position: 2 },
    ]);
  });

  // Mandar metade das fotos deixaria as outras com posicao repetida e
  // "qual e a capa" viraria sorteio.
  test('lista incompleta e recusada', () => {
    expect(ordenarPorIds(fotos(3), ['f0', 'f1']).error).toMatch(/todas as fotos/);
  });

  test('id de outro produto ou de outra cor e recusado', () => {
    expect(ordenarPorIds(fotos(2), ['f0', 'de-outra-cor']).error)
      .toMatch(/nao pertence/);
  });

  test('id repetido e recusado antes de virar posicao duplicada', () => {
    expect(ordenarPorIds(fotos(2), ['f0', 'f0']).error).toMatch(/repetidos/);
  });

  test('o que nao e lista e recusado', () => {
    expect(ordenarPorIds(fotos(2), 'f0,f1').error).toMatch(/deve ser uma lista/);
    expect(ordenarPorIds(fotos(2), ['f0', '']).error).toMatch(/vazio/);
  });

  test('galeria vazia com lista vazia e um no-op valido', () => {
    expect(ordenarPorIds([], []).ordem).toEqual([]);
  });
});

describe('normalizarCorHex', () => {
  // '#FF0000' e '#ff0000' sao a mesma cor, e a diferenca de caixa ja
  // custou variantes duplicadas no catalogo.
  test('sai sempre minusculo', () => {
    expect(normalizarCorHex('#FF0000')).toEqual({ color_hex: '#ff0000' });
    expect(normalizarCorHex('1F2937')).toEqual({ color_hex: '#1f2937' });
  });

  test('ausencia de cor e a galeria PRINCIPAL, nao um erro', () => {
    expect(normalizarCorHex(null)).toEqual({ color_hex: null });
    expect(normalizarCorHex(undefined)).toEqual({ color_hex: null });
    expect(normalizarCorHex('  ')).toEqual({ color_hex: null });
  });

  test('qualquer outra coisa e erro com o formato na mensagem', () => {
    expect(normalizarCorHex('vermelho').error).toMatch(/#rrggbb/);
    expect(normalizarCorHex('#f00').error).toMatch(/#rrggbb/);
    expect(normalizarCorHex('#12345g').error).toMatch(/#rrggbb/);
  });
});

describe('agruparGaleria — o shape que o app recebe', () => {
  test('color_hex null vai pra main; o resto agrupa por cor', () => {
    const linhas = [
      ...fotos(2),
      { id: 'c1', color_hex: '#1F2937', url: 'u1', thumb_url: null, position: 0 },
      { id: 'c2', color_hex: '#1f2937', url: 'u2', thumb_url: null, position: 1 },
    ];
    const g = agruparGaleria(linhas);
    expect(g.main.map((f) => f.id)).toEqual(['f0', 'f1']);
    // A chave e minuscula mesmo quando a base guardou em caixa alta.
    expect(g.by_color['#1f2937'].map((f) => f.id)).toEqual(['c1', 'c2']);
  });

  test('cada foto sai com id, url, thumb_url e position', () => {
    const g = agruparGaleria(fotos(1));
    expect(g.main[0]).toEqual({
      id: 'f0', url: 'https://cdn.exemplo.com/0.jpg',
      thumb_url: 'https://cdn.exemplo.com/0.thumb.jpg', position: 0,
    });
  });

  test('cor sem foto nao vira chave vazia', () => {
    expect(agruparGaleria(fotos(1)).by_color).toEqual({});
  });

  // A ordem do payload nao pode depender da ordem que o banco devolveu:
  // o cliente desenha o carrossel na ordem em que recebe.
  test('sai na ordem da posicao, mesmo recebendo fora de ordem', () => {
    const fora = [
      { id: 'b', color_hex: null, url: 'u', position: 2 },
      { id: 'a', color_hex: null, url: 'u', position: 0 },
      { id: 'c', color_hex: null, url: 'u', position: 1 },
    ];
    expect(agruparGaleria(fora).main.map((f) => f.id)).toEqual(['a', 'c', 'b']);
  });

  test('galeria vazia devolve o shape completo, nao undefined', () => {
    expect(agruparGaleria([])).toEqual({ main: [], by_color: {} });
    expect(agruparGaleria(null)).toEqual({ main: [], by_color: {} });
  });
});
