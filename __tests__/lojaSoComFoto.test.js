// ============================================================
// "Mostrar na loja apenas peças com foto" (migration 308).
//
// Nasce da Finesse: 1.302 peças cadastradas, 143 com foto, loja no ar.
// Nove em cada dez produtos apareciam como um retângulo cinza com o nome
// escrito — pior que não ter loja.
//
// A DECISÃO QUE ESTE TESTE GUARDA: é uma REGRA, não uma lista. A
// alternativa era despejar as 1.159 sem foto em `hidden_product_ids`.
// Funcionaria hoje e apodreceria amanhã — a peça fotografada continuaria
// escondida até alguém editar a lista. Com regra, ela acende sozinha.
// ============================================================
const fs = require('fs');
const path = require('path');
const { filtroDeFoto, COM_FOTO } = require('../src/services/catalogoPaginado');

function fonte(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('o interruptor', () => {
  test('desligado não filtra nada', () => {
    // Default false: nenhuma das lojas existentes muda de comportamento.
    for (const desligado of [false, undefined, null, 0, '']) {
      expect(filtroDeFoto(desligado)).toBe('TRUE');
    }
  });

  test('só o booleano true liga', () => {
    // A string "false" vinda de um query param não pode ligar o filtro —
    // seria a loja inteira sumindo por causa de um parse.
    expect(filtroDeFoto('true')).toBe('TRUE');
    expect(filtroDeFoto('false')).toBe('TRUE');
    expect(filtroDeFoto(1)).toBe('TRUE');
    expect(filtroDeFoto(true)).toBe(COM_FOTO);
  });

  test('capa OU galeria contam como foto', () => {
    // A lojista pode ter subido foto pela galeria sem definir capa.
    // Esconder a peça nesse caso seria esconder trabalho que ela já fez.
    expect(COM_FOTO).toContain('image_url');
    expect(COM_FOTO).toContain('gallery_urls');
    expect(COM_FOTO).toContain(' OR ');
  });

  test('a coluna vazia não conta como foto', () => {
    // image_url = '' é diferente de NULL e acontece em importação.
    expect(COM_FOTO).toContain("btrim(COALESCE(products.image_url, '')) <> ''");
  });
});

describe('a regra chega em TODO lugar que decide o que mostrar', () => {
  const builder = fonte('src/services/storefrontBuilder.js');
  const paginado = fonte('src/services/catalogoPaginado.js');
  const rota = fonte('src/routes/storefront.js');
  const vitrine = fonte('src/routes/studioStorefront.js');

  test('a grade da página 1 e a da página 2 obedecem a mesma regra', () => {
    // Se só a página 1 filtrasse, a grade CRESCERIA ao rolar — a página 2
    // traria de volta o que a 1 escondeu.
    expect(builder).toContain('filtroDeFoto(exigeFoto)');
    expect(rota).toContain('exigeFoto: cfg.require_product_image === true');
  });

  test('a contagem da barra de categorias também', () => {
    // Já erramos exatamente isto uma vez: a barra dizia "Bolsa 29" e a
    // grade mostrava 19, porque a contagem não aplicava o mesmo filtro.
    const i = paginado.indexOf('async function contarPorCategoria');
    const bloco = paginado.slice(i, i + 900);
    expect(bloco).toContain('filtroDeFoto(exigeFoto)');
  });

  test('o total do catálogo também', () => {
    // Ele vira a frase "N produtos" no topo da grade.
    const i = builder.indexOf('async function contarProdutosDaLoja');
    expect(builder.slice(i, i + 500)).toContain('filtroDeFoto(exigeFoto)');
  });

  test('a loja com destaques curados não escapa', () => {
    // fetchStorefrontProducts tem DOIS caminhos. Aplicar em um só faria a
    // loja com destaques ignorar a regra — e destaque é justamente onde a
    // lojista põe o que quer vender.
    const i = builder.indexOf('async function fetchStorefrontProducts');
    const bloco = builder.slice(i, builder.indexOf('\n}', i));
    expect((bloco.match(/\$\{comFoto\}/g) || []).length).toBe(2);
  });

  test('e a vitrine Studio segue a MESMA regra', () => {
    // O bug de campo que vale de um lado e não do outro já aconteceu
    // quatro vezes entre as duas lojas. Ver paridadeDosPayloads.
    expect(vitrine).toContain('filtroDeFoto(config.require_product_image === true)');
    expect(vitrine).toContain('${comFoto}');
  });
});

describe('a lojista consegue desligar sozinha', () => {
  const painel = fonte('src/routes/digitalChannel.js');

  test('o PUT aceita o campo', () => {
    expect(painel).toContain('require_product_image,');
    expect(painel).toContain('SET require_product_image = $1');
  });

  test('o GET devolve o estado', () => {
    // Sem isto o painel não consegue desenhar o interruptor ligado.
    expect(painel).toContain('require_product_image: config.require_product_image === true');
  });

  test('sobrevive à base sem a migration', () => {
    // O backend não roda migration no boot: existe sempre um intervalo em
    // que o código subiu e a coluna não existe.
    const i = painel.indexOf('SET require_product_image');
    const bloco = painel.slice(i - 400, i + 700);
    expect(bloco).toContain("42703");
  });

  test('e o padrão é DESLIGADO', () => {
    // Uma migration que liga sozinha esvaziaria a loja de todo mundo.
    const sql = fonte('migrations/308_loja_so_com_foto.sql');
    expect(sql).toMatch(/DEFAULT\s+FALSE/i);
    expect(sql).toContain('IF NOT EXISTS');
  });
});

describe('é regra, não lista', () => {
  test('nada foi despejado em hidden_product_ids', () => {
    // A distinção é o ponto todo da feature: com lista, a peça
    // fotografada hoje só aparece quando alguém editar a lista.
    const builder = fonte('src/services/storefrontBuilder.js');
    const i = builder.indexOf('const exigeFoto');
    const bloco = builder.slice(i, i + 400);
    expect(bloco).not.toContain('hiddenIds.push');
    expect(bloco).not.toContain('hidden_product_ids =');
  });
});
