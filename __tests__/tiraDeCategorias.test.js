// ============================================================
// A tira de categorias da home.
//
// A navegação por categoria era uma barra de texto — correta e
// silenciosa. A tira põe quatro cartões grandes antes da grade.
//
// AS TRÊS DECISÕES DE CAIO (30/08) QUE ESTES TESTES GUARDAM:
//
// 1. SÓ O PRIMEIRO NÍVEL. A Finesse tem 38 categorias visíveis e só 4
//    raízes aparecem de fato. Tira com 38 cartões não é navegação, é um
//    segundo catálogo.
// 2. MÍNIMO DE 3. Uma ou duas em fila leem como defeito, não como
//    navegação. Mesmo raciocínio do limiar de 20 itens da grade.
// 3. SEM BANNER, ENTRA MESMO ASSIM, com ladrilho de cor. Foi decisão
//    explícita contra a alternativa (sumir o cartão) — sumir faria a tira
//    mudar de tamanho conforme a lojista sobe as imagens.
// ============================================================
const fs = require('fs');
const path = require('path');
const { montarTira, MINIMO_PARA_APARECER } = require('../src/services/tiraDeCategorias');

const raiz = (nome, extra = {}) => ({
  nome, path: '/' + nome.toLowerCase(), slug: nome.toLowerCase(),
  depth: 0, total: 10, banner_url: null, ...extra,
});
const filha = (nome, extra = {}) => raiz(nome, { depth: 1, ...extra });

describe('só o primeiro nível entra', () => {
  test('filha e neta ficam de fora, por mais produtos que tenham', () => {
    const tira = montarTira([
      raiz('Vestidos'), raiz('Conjuntos'), raiz('Blusas'),
      filha('Vestido Midi Festa', { total: 900 }),
      { ...raiz('Neta'), depth: 2, total: 500 },
    ]);
    expect(tira.map((c) => c.nome)).toEqual(['Vestidos', 'Conjuntos', 'Blusas']);
  });

  test('depth vindo como string do banco também conta', () => {
    // pg devolve smallint como number, mas um dia devolveu string noutro
    // campo e a barra ficou vazia sem ninguém entender.
    const tira = montarTira([
      { ...raiz('A'), depth: '0' }, { ...raiz('B'), depth: '0' }, { ...raiz('C'), depth: '0' },
    ]);
    expect(tira).toHaveLength(3);
  });
});

describe('o mínimo de 3', () => {
  test('com duas, a tira não aparece', () => {
    expect(montarTira([raiz('Vestidos'), raiz('Conjuntos')])).toEqual([]);
  });

  test('com três, aparece', () => {
    expect(montarTira([raiz('A'), raiz('B'), raiz('C')])).toHaveLength(3);
  });

  test('o limiar é 3 — se mudar, é decisão, não acidente', () => {
    expect(MINIMO_PARA_APARECER).toBe(3);
  });

  test('categoria sem peça visível não conta para o mínimo', () => {
    // Três cadastradas, uma vazia: sobram duas e a tira some. O contrário
    // mostraria um cartão que leva a uma prateleira vazia.
    expect(montarTira([raiz('A'), raiz('B'), raiz('C', { total: 0 })])).toEqual([]);
  });
});

describe('sem banner, o cartão entra do mesmo jeito', () => {
  test('banner_url vira null e a loja decide o ladrilho', () => {
    const tira = montarTira([raiz('A'), raiz('B'), raiz('C')]);
    expect(tira.every((c) => c.banner_url === null)).toBe(true);
    expect(tira).toHaveLength(3);
  });

  test('string vazia e só-espaços contam como sem banner', () => {
    const tira = montarTira([
      raiz('A', { banner_url: '' }),
      raiz('B', { banner_url: '   ' }),
      raiz('C', { banner_url: 'https://x/c.jpg' }),
    ]);
    expect(tira.map((c) => c.banner_url)).toEqual([null, null, 'https://x/c.jpg']);
  });

  test('a tira mistura com e sem banner sem mudar de tamanho', () => {
    // É o ponto da decisão: subir uma imagem não pode reordenar nem
    // encolher a tira.
    const semNenhum = montarTira([raiz('A'), raiz('B'), raiz('C')]);
    const comUm = montarTira([raiz('A', { banner_url: 'u' }), raiz('B'), raiz('C')]);
    expect(comUm).toHaveLength(semNenhum.length);
    expect(comUm.map((c) => c.nome)).toEqual(semNenhum.map((c) => c.nome));
  });
});

describe('entradas ruins não derrubam a loja', () => {
  test('árvore vazia ou não-lista devolve vazio', () => {
    for (const lixo of [[], null, undefined, 'arvore', 42, {}]) {
      expect(montarTira(lixo)).toEqual([]);
    }
  });

  test('o cartão leva o que a loja precisa pra desenhar e navegar', () => {
    const [c] = montarTira([raiz('Vestidos'), raiz('B'), raiz('C')]);
    expect(Object.keys(c).sort()).toEqual(
      ['banner_url', 'caminho', 'nome', 'slug', 'total'].sort()
    );
  });
});

describe('as duas lojas leem a mesma tira', () => {
  const builder = fs.readFileSync(
    path.join(__dirname, '..', 'src/services/storefrontBuilder.js'), 'utf8');

  test('o payload traz a tira pronta, não a árvore crua', () => {
    // Redesign 09/2026: a tira ainda sai de montarTira, mas passa antes
    // por capasDasCategorias (capa_url) — por isso vira variavel.
    expect(builder).toContain('const tira = montarTira(arvoreBarra)');
    expect(builder).toContain('tira_de_categorias: tira,');
    expect(builder).toContain("require('./tiraDeCategorias')");
  });

  test('a consulta da árvore traz banner_url', () => {
    const catalogo = fs.readFileSync(
      path.join(__dirname, '..', 'src/services/catalogoPaginado.js'), 'utf8');
    const arvore = catalogo.slice(catalogo.indexOf('async function arvoreDeCategorias'));
    const sql = arvore.slice(0, arvore.indexOf('ORDER BY c.depth'));
    expect(sql).toContain('c.banner_url');
  });
});

describe('o upload de banner de categoria é da empresa dona', () => {
  const rota = fs.readFileSync(
    path.join(__dirname, '..', 'src/routes/digitalChannel.js'), 'utf8');
  const upload = rota.slice(rota.indexOf("router.post('/upload-image'"));
  const corpo = upload.slice(0, upload.indexOf('\nrouter.'));

  test('o UPDATE exige company_id — id adivinhado não escreve em loja alheia', () => {
    expect(corpo).toContain('UPDATE product_categories');
    expect(corpo).toMatch(/WHERE id = \$2 AND company_id = \$3/);
  });

  test('zero linhas vira 404, não sucesso silencioso', () => {
    expect(corpo).toContain("if (!rows.length) return res.status(404)");
  });

  test('categoria_id malformado é barrado antes do upload', () => {
    // Sem isso, subiríamos o arquivo ao R2 antes de descobrir que o id é
    // lixo — custo e um objeto órfão no bucket.
    expect(corpo).toContain('categoria_id obrigatorio');
  });
});
