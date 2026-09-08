// ============================================================
// AURA — QUAIS fotos a vitrine mostra (migration 323)
//
// A migration 323 deu ao produto ate 4 fotos por cor. O PR #684 gravou
// essas fotos e as devolveu no payload; ninguem ainda as DESENHAVA. A
// pagina do produto mostrava uma lista achatada de URLs e trocava a foto
// quando a variante inteira fechava — inclusive ao escolher TAMANHO.
//
// O que estes testes travam:
//
//   1. A CADEIA DE FALLBACK, na ordem: fotos da cor escolhida -> galeria
//      principal (a cor nao tem foto, ou nenhuma cor foi escolhida) ->
//      o que a loja mostrava antes da 323. O ultimo degrau nao e
//      cortesia: o catalogo inteiro que existe hoje esta nele, porque uma
//      peca so ganha linha em product_images depois que a lojista abre o
//      editor de fotos.
//
//   2. A CAPA E A CAPA. Position 0 primeiro, o resto por position. A capa
//      espelha products.image_url e a foto da variante daquela cor — sair
//      da ordem aqui e a peca mudar de rosto na vitrine.
//
//   3. TAMANHO NAO E COR. A galeria e por cor; escolher "38" nao pode
//      trocar a foto (era o que acontecia, e a cliente que so queria
//      saber se tinha o numero via a peca mudar debaixo dela).
//
// A regra e uma STRING que o navegador e o Node executam igual (mesmo
// desenho de coresDaLoja.js e storefrontCapa.js) — por isso um dos testes
// roda a fonte SERIALIZADA e compara com o modulo: e o unico jeito de
// saber que o que foi pra loja e o que foi testado.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const {
  FONTE,
  fotosDaPeca,
  hexDaGaleria,
  fotosLegado,
  ordenarFotos,
  galeriaTemFoto,
} = require('../src/services/fotosDaVitrine');

const fonte = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/** Uma foto como a rota devolve. */
const foto = (id, position, extra = {}) => ({
  id,
  url: `https://cdn.aura/${id}.jpg`,
  thumb_url: `https://cdn.aura/${id}.thumb.jpg`,
  position,
  ...extra,
});

/** Uma peca do payload publico, sem galeria nenhuma. */
const PECA_LEGADA = {
  id: 'p1',
  name: 'Tênis Runner',
  image_url: 'https://cdn.aura/capa.jpg',
  thumb_url: 'https://cdn.aura/capa.thumb.jpg',
  gallery_urls: ['https://cdn.aura/antiga1.jpg', 'https://cdn.aura/antiga2.jpg'],
  variants: [
    { id: 'v1', image_url: 'https://cdn.aura/preto.jpg', thumb_url: 'https://cdn.aura/preto.thumb.jpg',
      values: [{ attribute: 'Cor', value: '#111111' }, { attribute: 'Tamanho', value: '38' }] },
    { id: 'v2', image_url: 'https://cdn.aura/vermelho.jpg', thumb_url: null,
      values: [{ attribute: 'Cor', value: '#ff0000' }, { attribute: 'Tamanho', value: '39' }] },
  ],
};

/** A mesma peca, agora com galeria da 323. */
const PECA_COM_GALERIA = {
  ...PECA_LEGADA,
  images: {
    main: [foto('m0', 0), foto('m1', 1), foto('m2', 2)],
    by_color: {
      '#111111': [foto('preto1', 0), foto('preto2', 1)],
      '#ff0000': [foto('vermelho1', 0)],
    },
  },
};

const urls = (r) => r.fotos.map((f) => f.url);

describe('a cadeia de fallback', () => {
  test('cor escolhida COM foto: as fotos daquela cor, so elas', () => {
    const r = fotosDaPeca(PECA_COM_GALERIA, '#111111');
    expect(r.origem).toBe('cor');
    expect(r.cor).toBe('#111111');
    expect(urls(r)).toEqual([
      'https://cdn.aura/preto1.jpg',
      'https://cdn.aura/preto2.jpg',
    ]);
  });

  test('nenhuma cor escolhida: a galeria principal', () => {
    const r = fotosDaPeca(PECA_COM_GALERIA, null);
    expect(r.origem).toBe('principal');
    expect(urls(r)).toEqual([
      'https://cdn.aura/m0.jpg',
      'https://cdn.aura/m1.jpg',
      'https://cdn.aura/m2.jpg',
    ]);
  });

  test('cor escolhida SEM foto: cai na principal, nao numa tela vazia', () => {
    // A lojista fotografou o preto e o vermelho e parou. Quem clica no
    // azul nao pode ver um retangulo cinza — ve a peca.
    const r = fotosDaPeca(PECA_COM_GALERIA, '#1f5fbf');
    expect(r.origem).toBe('principal');
    expect(urls(r)[0]).toBe('https://cdn.aura/m0.jpg');
  });

  test('peca sem NENHUMA linha de galeria: exatamente o que a loja mostrava antes', () => {
    // Este e o degrau que segura o catalogo inteiro que ja existe: a 323
    // e dual-write e uma peca so entra na galeria depois que a lojista
    // abre o editor de fotos.
    const r = fotosDaPeca(PECA_LEGADA, null);
    expect(r.origem).toBe('legado');
    expect(urls(r)).toEqual([
      'https://cdn.aura/capa.jpg',
      'https://cdn.aura/antiga1.jpg',
      'https://cdn.aura/antiga2.jpg',
      'https://cdn.aura/preto.jpg',
      'https://cdn.aura/vermelho.jpg',
    ]);
  });

  test('galeria so com cores e nenhuma cor escolhida: cai no legado, nao numa cor sorteada', () => {
    // Mostrar "a primeira cor que tiver foto" seria escolher pela cliente
    // uma cor que ela nao pediu.
    const so_cores = {
      ...PECA_LEGADA,
      images: { main: [], by_color: { '#111111': [foto('preto1', 0)] } },
    };
    const r = fotosDaPeca(so_cores, null);
    expect(r.origem).toBe('legado');
    expect(urls(r)[0]).toBe('https://cdn.aura/capa.jpg');
  });

  test('galeria vazia dos dois lados: legado', () => {
    const r = fotosDaPeca({ ...PECA_LEGADA, images: { main: [], by_color: {} } }, '#111111');
    expect(r.origem).toBe('legado');
    expect(r.fotos.length).toBe(5);
  });

  test('peca sem foto nenhuma devolve lista vazia (a pagina desenha as iniciais)', () => {
    const r = fotosDaPeca({ id: 'p9', name: 'Peça nova' }, null);
    expect(r.origem).toBe('legado');
    expect(r.fotos).toEqual([]);
  });

  test('a galeria pode vir por argumento — e o caso da busca assincrona', () => {
    // A peca aberta pela GRADE nao traz `images`; a galeria chega depois,
    // por fetch, e entra por aqui sem mutar o produto do payload.
    const r = fotosDaPeca(PECA_LEGADA, '#ff0000', PECA_COM_GALERIA.images);
    expect(r.origem).toBe('cor');
    expect(urls(r)).toEqual(['https://cdn.aura/vermelho1.jpg']);
  });
});

describe('a capa e a capa', () => {
  test('position 0 primeiro, mesmo quando o banco devolve fora de ordem', () => {
    const baguncada = {
      ...PECA_LEGADA,
      images: { main: [foto('b', 2), foto('c', 1), foto('a', 0)], by_color: {} },
    };
    expect(urls(fotosDaPeca(baguncada, null))).toEqual([
      'https://cdn.aura/a.jpg',
      'https://cdn.aura/c.jpg',
      'https://cdn.aura/b.jpg',
    ]);
  });

  test('empate de position desempata por id — a ordem nao pode ser sorteada a cada render', () => {
    const empatadas = ordenarFotos([foto('z', 0), foto('a', 0)]);
    expect(empatadas.map((f) => f.url)).toEqual([
      'https://cdn.aura/a.jpg',
      'https://cdn.aura/z.jpg',
    ]);
  });

  test('linha sem url nao entra — buraco na galeria e foto quebrada na vitrine', () => {
    const r = ordenarFotos([{ id: 'x', url: null, position: 0 }, foto('ok', 1)]);
    expect(r.map((f) => f.url)).toEqual(['https://cdn.aura/ok.jpg']);
  });
});

describe('os dois tamanhos (migration 317)', () => {
  test('cada foto sai com url e thumb_url — a miniatura NAO baixa o original', () => {
    // Sem isto a pagina baixa quatro arquivos de 1600px pra desenhar
    // quatro quadradinhos de 76px.
    const r = fotosDaPeca(PECA_COM_GALERIA, null);
    expect(r.fotos[0]).toEqual({
      url: 'https://cdn.aura/m0.jpg',
      thumb_url: 'https://cdn.aura/m0.thumb.jpg',
    });
  });

  test('foto antiga sem miniatura cai na foto grande, nao em undefined', () => {
    const semMini = {
      ...PECA_LEGADA,
      images: { main: [{ id: 'a', url: 'https://cdn.aura/so-grande.jpg', position: 0 }], by_color: {} },
    };
    expect(fotosDaPeca(semMini, null).fotos[0].thumb_url).toBe('https://cdn.aura/so-grande.jpg');
  });

  test('o legado carrega a miniatura da peca e a da variante quando existem', () => {
    const lista = fotosLegado(PECA_LEGADA);
    expect(lista[0].thumb_url).toBe('https://cdn.aura/capa.thumb.jpg');
    expect(lista[3].thumb_url).toBe('https://cdn.aura/preto.thumb.jpg');
    // Variante sem miniatura cai na foto grande.
    expect(lista[4].thumb_url).toBe('https://cdn.aura/vermelho.jpg');
  });

  test('URL repetida entre capa, galeria antiga e variante entra UMA vez', () => {
    const repetida = {
      image_url: 'https://cdn.aura/a.jpg',
      gallery_urls: ['https://cdn.aura/a.jpg', 'https://cdn.aura/b.jpg'],
      variants: [{ image_url: 'https://cdn.aura/b.jpg' }],
    };
    expect(fotosLegado(repetida).map((f) => f.url))
      .toEqual(['https://cdn.aura/a.jpg', 'https://cdn.aura/b.jpg']);
  });
});

describe('a cor do lojista vira a chave da galeria', () => {
  test("'#FF0000' e '#ff0000' sao a mesma cor", () => {
    // Ja custou caro no catalogo: variante duplicada por diferenca de
    // caixa. A chave gravada e minuscula; a escolhida na tela, nem sempre.
    expect(hexDaGaleria('#FF0000')).toBe('#ff0000');
    expect(urls(fotosDaPeca(PECA_COM_GALERIA, '#FF0000'))).toEqual(['https://cdn.aura/vermelho1.jpg']);
  });

  test('hex de 3 digitos e hex sem cerquilha tambem', () => {
    expect(hexDaGaleria('#f00')).toBe('#ff0000');
    expect(hexDaGaleria('FF0000')).toBe('#ff0000');
  });

  test('a chave gravada em caixa alta ainda e encontrada', () => {
    const suja = { ...PECA_LEGADA, images: { main: [], by_color: { '#FF0000': [foto('v', 0)] } } };
    expect(fotosDaPeca(suja, '#ff0000').origem).toBe('cor');
  });

  test('o que nao e hex nao e cor: nome, vazio e lixo caem na principal', () => {
    // O nome ('Preto') e traduzido pra hex por corDoValor ANTES de chegar
    // aqui — o servico de cor mora em coresDaLoja.js e nao se repete.
    for (const v of ['Preto', '', null, undefined, '#12345', 'rgb(0,0,0)']) {
      expect(hexDaGaleria(v)).toBeNull();
      expect(fotosDaPeca(PECA_COM_GALERIA, v).origem).toBe('principal');
    }
  });
});

describe('galeriaTemFoto — decide entre usar o cache e ir buscar', () => {
  test('galeria vazia, nula ou sem chave nenhuma nao conta', () => {
    expect(galeriaTemFoto(null)).toBe(false);
    expect(galeriaTemFoto({ main: [], by_color: {} })).toBe(false);
    expect(galeriaTemFoto({ main: [], by_color: { '#111111': [] } })).toBe(false);
  });

  test('uma foto em qualquer lado conta', () => {
    expect(galeriaTemFoto({ main: [foto('a', 0)], by_color: {} })).toBe(true);
    expect(galeriaTemFoto({ main: [], by_color: { '#111111': [foto('a', 0)] } })).toBe(true);
  });
});

describe('a MESMA regra roda no navegador', () => {
  // A pagina do produto e um <script> montado por concatenacao de
  // strings. Se a fonte serializada divergir do modulo, o teste passa e a
  // loja quebra — foi o que aconteceu com o istanbul e o toString().
  const NAVEGADOR = new Function(
    FONTE + '\nreturn { fotosDaPeca: fotosDaPeca, hexDaGaleria: hexDaGaleria, galeriaTemFoto: galeriaTemFoto };'
  )();

  test('o codigo que vai pra loja devolve o mesmo que o modulo', () => {
    for (const cor of [null, '#111111', '#FF0000', '#1f5fbf', 'Preto']) {
      expect(NAVEGADOR.fotosDaPeca(PECA_COM_GALERIA, cor))
        .toEqual(fotosDaPeca(PECA_COM_GALERIA, cor));
      expect(NAVEGADOR.fotosDaPeca(PECA_LEGADA, cor))
        .toEqual(fotosDaPeca(PECA_LEGADA, cor));
    }
    expect(NAVEGADOR.hexDaGaleria('#F00')).toBe('#ff0000');
    expect(NAVEGADOR.galeriaTemFoto(PECA_COM_GALERIA.images)).toBe(true);
  });

  test('a fonte entra no <script> da loja e a pagina do produto a usa', () => {
    const buildScript = require('../src/templates/storefront');
    const js = buildScript(JSON.stringify({ products: [], site: {} }), 'loja', '');
    expect(js).toContain('function fotosDaPeca(');
    expect(js).toContain('function galeriaTemFoto(');
    // Sem esta chamada a fonte iria junto e ninguem a executaria.
    expect(js).toContain('fotosDaPeca(p,corEscolhida(),galeria)');
  });

  test('o script gerado e JavaScript valido', () => {
    const buildScript = require('../src/templates/storefront');
    const js = buildScript(JSON.stringify({ products: [], site: {} }), 'loja', '');
    const corpo = js.slice(js.indexOf('>') + 1, js.lastIndexOf('</' + 'script>'));
    expect(() => new Function(corpo)).not.toThrow();
  });
});

describe('tamanho nao e cor: a pagina so troca a foto quando a COR muda', () => {
  const pagina = fonte('src/templates/storefront/parts/product_detail.js');

  test('a cor escolhida ignora todo atributo que nao seja de cor', () => {
    // corEscolhida() percorre attrOrder e pula o que nao passa em
    // atributoDeCor — e so ela alimenta a galeria.
    expect(pagina).toContain('function corEscolhida()');
    expect(pagina).toMatch(/corEscolhida[\s\S]{0,320}if\(!atributoDeCor\(a\)\) continue;/);
  });

  test('o clique numa opcao so repinta a galeria se a cor mudou', () => {
    expect(pagina).toContain("var corAntes=corEscolhida();");
    expect(pagina).toContain('if(corEscolhida()!==corAntes) repintarGaleria();');
  });

  test('o pulo pela foto da variante saiu do caminho da variante inteira', () => {
    // Era isto que fazia escolher "38" trocar a foto.
    expect(pagina).not.toContain('var i=fotos.indexOf(variante.image_url);');
  });

  test('a foto so volta pra capa quando a lista muda de dono', () => {
    expect(pagina).toContain('if(assinatura!==assinaturaFotos)');
  });
});

describe('acessibilidade e paridade no toque', () => {
  const pagina = fonte('src/templates/storefront/parts/product_detail.js');
  const estilos = fonte('src/templates/storefrontHomeStyles.js');

  test('o alt e o nome da peca mais a cor', () => {
    expect(pagina).toContain('function altDaFoto(');
    expect(pagina).toContain("var base=p.name+(cor?' \\u2014 '+cor:'');");
    expect(pagina).toContain('alt="\'+esc(altDaFoto(fotoAtual))+\'"');
  });

  test('seta do teclado no desktop', () => {
    expect(pagina).toContain("if(e.key==='ArrowLeft')");
    expect(pagina).toContain("else if(e.key==='ArrowRight')");
    expect(pagina).toContain('tabindex="0"');
  });

  test('as setas sao botoes de verdade, com nome — nao um controle de hover', () => {
    expect(pagina).toContain('aria-label="Foto anterior"');
    expect(pagina).toContain('class="pd-seta pd-seta-prox"');
    // Nada de :hover no seletor que MOSTRA a seta.
    expect(estilos).not.toMatch(/\.pd-foto:hover\s+\.pd-seta/);
  });

  test('o toque tem gesto proprio e a tela estreita tem bolinha', () => {
    expect(pagina).toContain("caixa.addEventListener('touchstart'");
    expect(pagina).toContain('passarFoto(dx<0?1:-1)');
    expect(estilos).toContain('@media(max-width:560px)');
    expect(estilos).toMatch(/@media\(max-width:560px\)\{[\s\S]{0,200}\.pd-pontos\{display:flex;\}/);
  });

  test('sem hover, nem zoom nem dica de mouse', () => {
    expect(estilos).toMatch(/@media\(hover:none\)\{[\s\S]{0,200}\.pd-zoom-dica\{display:none;\}/);
  });

  test('o tema da loja continua vindo dos tokens — nada de cor de marca no codigo', () => {
    // A lojista escolhe as cores; a galeria nova nao pode fixar nenhuma.
    const novos = estilos.slice(estilos.indexOf('.pd-seta{'), estilos.indexOf('.pd-foto-conta{'));
    expect(novos).toContain('var(--sf-brand)');
    expect(novos).not.toMatch(/#[0-9a-fA-F]{6}/);
  });
});

describe('so a capa carrega adiantado', () => {
  const pagina = fonte('src/templates/storefront/parts/product_detail.js');

  test('a miniatura da capa vem eager; as outras, lazy', () => {
    expect(pagina).toContain("(i===0?'':' loading=\"lazy\" decoding=\"async\"')");
  });

  test('a foto grande usa url e a miniatura usa thumb_url', () => {
    expect(pagina).toContain("esc(fotos[fotoAtual].url)");
    expect(pagina).toContain("esc(f.thumb_url||f.url)");
  });

  test('uma busca por PECA, nao por cor nem por variante', () => {
    // GALERIAS guarda o resultado: reabrir a peca (ou voltar pra ela) nao
    // pede de novo, e nao existe fetch por cor.
    expect(pagina).toContain('if(galeria||GALERIAS[p.id]) return;');
    expect((pagina.match(/\/produto\/'\+encodeURIComponent\(p\.id\)\+'\/fotos/g) || []).length).toBe(1);
  });
});

describe('o payload diz se a galeria foi carregada ou nao', () => {
  const { montarProdutoPublico } = require('../src/services/storefrontBuilder');
  const ctx = { variantsByProduct: {}, categoryById: {}, primaryLinkByProduct: {}, mostrarPrecos: true };

  test('peca da GRADE vem com images null — a galeria nem foi consultada', () => {
    // Um objeto vazio aqui seria indistinguivel de "esta peca nao tem
    // galeria", e a pagina buscaria de novo em TODA peca do catalogo
    // antigo — que hoje e o catalogo inteiro.
    const linha = { id: 'p1', name: 'Blusa', price: '10.00', stock_qty: 3 };
    expect(montarProdutoPublico(linha, ctx).images).toBeNull();
  });

  test('peca da URL propria vem com o objeto, mesmo vazio — nao ha o que buscar', () => {
    const linha = { id: 'p1', name: 'Blusa', price: '10.00', stock_qty: 3, __galeria: { main: [], by_color: {} } };
    expect(montarProdutoPublico(linha, ctx).images).toEqual({ main: [], by_color: {} });
  });
});

// ── A rota publica que serve a galeria de UMA peca ─────────
describe('GET /storefront/:slug/produto/:id/fotos', () => {
  const db = require('../src/config/database');
  const COMPANY = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
  const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use('/storefront', require('../src/routes/storefront'));
    return app;
  }

  beforeEach(() => { db.query.mockReset(); });

  function mockBanco({ loja = true, linhas = [], erro = null } = {}) {
    const sqls = [];
    db.query.mockImplementation((sql) => {
      const s = String(sql);
      sqls.push(s);
      if (/FROM digital_channel_config/.test(s)) {
        return Promise.resolve({ rows: loja ? [{ company_id: COMPANY }] : [] });
      }
      if (/FROM product_images/.test(s)) {
        if (erro) return Promise.reject(Object.assign(new Error('boom'), { code: erro }));
        return Promise.resolve({ rows: linhas });
      }
      return Promise.resolve({ rows: [] });
    });
    return sqls;
  }

  test('devolve a galeria agrupada: principal separada, cores por hex', async () => {
    mockBanco({ linhas: [
      { id: 'm0', color_hex: null, url: 'u0', thumb_url: 't0', position: 0 },
      { id: 'c0', color_hex: '#ff0000', url: 'r0', thumb_url: 'rt0', position: 0 },
      { id: 'c1', color_hex: '#ff0000', url: 'r1', thumb_url: null, position: 1 },
    ] });
    const r = await request(makeApp()).get(`/storefront/finesse/produto/${PID}/fotos`);
    expect(r.status).toBe(200);
    expect(r.body.main.map((f) => f.url)).toEqual(['u0']);
    expect(r.body.by_color['#ff0000'].map((f) => f.url)).toEqual(['r0', 'r1']);
  });

  test('UMA query pra galeria — nao uma por cor', async () => {
    // Quatro cores nao podem virar quatro round-trips na pagina que mais
    // converte da loja.
    const sqls = mockBanco({ linhas: [
      { id: 'a', color_hex: '#111111', url: 'a', thumb_url: null, position: 0 },
      { id: 'b', color_hex: '#ff0000', url: 'b', thumb_url: null, position: 0 },
      { id: 'c', color_hex: '#1f5fbf', url: 'c', thumb_url: null, position: 0 },
      { id: 'd', color_hex: '#2e7d4f', url: 'd', thumb_url: null, position: 0 },
    ] });
    await request(makeApp()).get(`/storefront/finesse/produto/${PID}/fotos`);
    expect(sqls.filter((s) => /FROM product_images/.test(s)).length).toBe(1);
  });

  test('a visibilidade da grade entra na MESMA query', async () => {
    const sqls = mockBanco({ linhas: [] });
    await request(makeApp()).get(`/storefront/finesse/produto/${PID}/fotos`);
    const galeria = sqls.find((s) => /FROM product_images/.test(s));
    expect(galeria).toMatch(/EXISTS \(/);
    expect(galeria).toMatch(/is_active IS NOT FALSE/);
    expect(galeria).toMatch(/is_group_shared/);
  });

  test('loja despublicada da 404', async () => {
    mockBanco({ loja: false });
    const r = await request(makeApp()).get(`/storefront/finesse/produto/${PID}/fotos`);
    expect(r.status).toBe(404);
  });

  test('id que nao e uuid nao chega ao banco', async () => {
    const sqls = mockBanco({ linhas: [] });
    const r = await request(makeApp()).get('/storefront/finesse/produto/nao-e-uuid/fotos');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ main: [], by_color: {} });
    expect(sqls.filter((s) => /FROM product_images/.test(s)).length).toBe(0);
  });

  test('base sem a migration 323 devolve galeria vazia, e a pagina abre com a foto de sempre', async () => {
    // Loja aberta e o lugar onde um erro custa venda (CLAUDE.md, 1).
    mockBanco({ erro: '42P01' });
    const r = await request(makeApp()).get(`/storefront/finesse/produto/${PID}/fotos`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ main: [], by_color: {} });
  });
});
