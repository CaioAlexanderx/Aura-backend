// ============================================================
// "O que falta pra loja ficar pronta."
//
// A Finesse publicou 143 peças. Nenhuma com marca, 37 sem tamanho, e até
// 30/08 nenhuma com descrição — e nada disso aparecia como erro em lugar
// nenhum. A loja só ficava mais pobre, em silêncio.
//
// O QUE ESTES TESTES GUARDAM, em ordem de importância:
//
// 1. A condição de "falta foto" é a NEGAÇÃO exata de COM_FOTO. As duas
//    vivem em arquivos diferentes e vão divergir se ninguém segurar:
//    já aconteceu com a contagem da barra de categorias, que dizia 29
//    enquanto a grade renderizava 19.
// 2. O universo de cada pendência não é o mesmo. Mandar a lojista
//    escrever descrição para as 1.159 peças que a loja esconde seria
//    trabalho jogado fora.
// 3. `campo` vem da query string e entra numa cláusula SQL. Só pode
//    passar pela lista branca.
// ============================================================
const fs = require('fs');
const path = require('path');
const {
  CAMPOS, LIMITE_DO_LOTE, LIMITE_DE_TEXTO,
  condicaoDeFalta, exigeFotoNoUniverso, sanitizarItens,
} = require('../src/services/pendenciasDaVitrine');
const { COM_FOTO } = require('../src/services/catalogoPaginado');

const semEspacos = (s) => String(s).replace(/\s+/g, '');

describe('a condição de falta de foto espelha COM_FOTO', () => {
  const foto = CAMPOS.find((c) => c.chave === 'foto');

  test('nega os dois lados do OR: capa E galeria', () => {
    // COM_FOTO é `capa <> '' OR galeria tem item`. A negação tem que ser
    // `capa = '' E galeria não tem item` — trocar o E por OU aqui faria
    // a tela pedir foto de peça que já tem.
    const n = semEspacos(foto.onde);
    expect(n).toContain(semEspacos(`btrim(COALESCE(products.image_url,''))=''`));
    expect(n).toContain('AND');
    expect(n).toContain('jsonb_array_length(products.gallery_urls)=0');
  });

  test('usa as MESMAS colunas que COM_FOTO', () => {
    for (const coluna of ['products.image_url', 'products.gallery_urls']) {
      expect(COM_FOTO).toContain(coluna);
      expect(foto.onde).toContain(coluna);
    }
  });

  test('COM_FOTO continua sendo OR — se virar AND, esta negação está errada', () => {
    // Sentinela: o dia em que COM_FOTO mudar de forma, este teste cai e
    // obriga a revisitar a negação em vez de deixar as duas divergirem.
    expect(COM_FOTO).toContain(' OR ');
  });
});

describe('o universo de cada pendência', () => {
  test('só "foto" pergunta sobre o catálogo inteiro', () => {
    expect(exigeFotoNoUniverso('foto')).toBe(false);
    for (const c of CAMPOS.filter((c) => c.chave !== 'foto')) {
      expect(exigeFotoNoUniverso(c.chave)).toBe(true);
    }
  });
});

describe('campo vem da URL, então é lista branca', () => {
  test('campo conhecido devolve SQL', () => {
    for (const c of CAMPOS) {
      expect(typeof condicaoDeFalta(c.chave)).toBe('string');
    }
  });

  test('qualquer outra coisa devolve null, nunca um fragmento', () => {
    for (const veneno of [
      'descricao; DROP TABLE products',
      "1=1 OR products.id IS NOT NULL",
      '', null, undefined, 42, {}, 'FOTO', 'toString', 'constructor',
    ]) {
      expect(condicaoDeFalta(veneno)).toBeNull();
    }
  });
});

describe('a ordem é de impacto, e a tela depende dela', () => {
  test('foto primeiro, marca por último', () => {
    expect(CAMPOS[0].chave).toBe('foto');
    expect(CAMPOS[CAMPOS.length - 1].chave).toBe('marca');
  });

  test('tamanho vem antes de segunda foto', () => {
    // Sem tamanho a peça some do filtro; sem a segunda foto ela só fica
    // menos convincente. Some é pior que fraco.
    const i = (k) => CAMPOS.findIndex((c) => c.chave === k);
    expect(i('tamanho')).toBeLessThan(i('foto2'));
  });

  test('só os campos que a lojista digita são editáveis', () => {
    const editaveis = CAMPOS.filter((c) => c.editavel).map((c) => c.chave);
    expect(editaveis.sort()).toEqual(['descricao', 'marca', 'tamanho']);
    // foto e foto2 são upload, têm rota própria — marcá-los como
    // editáveis abriria um campo de texto pra enviar imagem.
    for (const c of CAMPOS.filter((c) => !c.editavel)) {
      expect(c.coluna).toBeUndefined();
    }
  });
});

describe('sanitizarItens — o que entra no UPDATE em lote', () => {
  test('item sem id é descartado', () => {
    const r = sanitizarItens([{ description: 'oi' }, { id: '  ', size: 'M' }]);
    expect(r.itens).toEqual([]);
    expect(r.descartados).toBe(2);
  });

  test('item sem nenhum campo conhecido é descartado', () => {
    // Sem isso, um UPDATE que não muda nada voltaria como "salvo".
    const r = sanitizarItens([{ id: 'a', ncm: '6104', preco: 10 }]);
    expect(r.itens).toEqual([]);
    expect(r.descartados).toBe(1);
  });

  test('undefined não mexe na coluna; string vazia LIMPA', () => {
    const [it] = sanitizarItens([{ id: 'a', description: '', size: undefined }]).itens;
    expect(it.description).toBe('');   // vira COALESCE('', ...) -> grava vazio
    expect('size' in it).toBe(false);  // vira NULL -> COALESCE mantém o que está
  });

  test('id repetido vale o último — é a tela mandando o mesmo cartão duas vezes', () => {
    const r = sanitizarItens([
      { id: 'a', description: 'primeira' },
      { id: 'a', description: 'segunda' },
    ]);
    expect(r.itens).toHaveLength(1);
    expect(r.itens[0].description).toBe('segunda');
  });

  test('valor não-string é ignorado, não convertido', () => {
    // `size: 42` viraria "42" numa conversão silenciosa. Melhor não gravar.
    const r = sanitizarItens([{ id: 'a', size: 42, description: 'ok' }]);
    expect('size' in r.itens[0]).toBe(false);
    expect(r.itens[0].description).toBe('ok');
  });

  test('texto é aparado e truncado no limite de cada coluna', () => {
    const [it] = sanitizarItens([{
      id: 'a',
      description: '  ' + 'x'.repeat(5000) + '  ',
      size: '  M  ',
    }]).itens;
    expect(it.description).toHaveLength(LIMITE_DE_TEXTO.description);
    expect(it.size).toBe('M');
  });

  test('o lote tem teto', () => {
    const muitos = Array.from({ length: LIMITE_DO_LOTE + 30 }, (_, i) => ({
      id: 'id-' + i, description: 'd',
    }));
    const r = sanitizarItens(muitos);
    expect(r.itens).toHaveLength(LIMITE_DO_LOTE);
    expect(r.descartados).toBe(30);
  });

  test('corpo que não é lista não explode', () => {
    for (const lixo of [null, undefined, 'itens', 42, { id: 'a' }]) {
      expect(sanitizarItens(lixo)).toEqual({ itens: [], descartados: 0 });
    }
  });
});

describe('a rota escreve com a mesma visibilidade que lê', () => {
  const rota = fs.readFileSync(
    path.join(__dirname, '..', 'src/routes/digitalChannel.js'), 'utf8');
  const patch = rota.slice(rota.indexOf("router.patch('/produtos'"));
  const corpo = patch.slice(0, patch.indexOf('\nrouter.'));

  test('o UPDATE em lote passa por listVisibilityWhere', () => {
    // Armadilha 7 do CLAUDE.md: subsidiária que LISTA a peça compartilhada
    // e leva 404 ao editar é o sintoma de write path fora do read path.
    expect(corpo).toContain('listVisibilityWhere');
  });

  test('e não aceita id solto sem checar empresa', () => {
    expect(corpo).toContain('products.id = v.id');
    expect(corpo).toMatch(/WHERE[\s\S]*listVisibilityWhere/);
  });
});
