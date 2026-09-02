// ============================================================
// Os subtextos da vitrine falam com QUEM COMPRA (02/09/2026)
//
// A loja estava explicando o próprio mecanismo para o cliente:
//
//   "Ranking automático pelas vendas do Caixa."
//   "Os últimos cadastros do estoque, direto na vitrine."
//   "Categorias e contagens vêm direto do estoque — sem peça
//    disponível, a categoria some sozinha."
//   "Menu montado pelo cadastro de categorias do estoque."
//
// Tudo isso é verdade e nada disso é da conta de quem está comprando um
// sapato. "Caixa", "cadastro", "vitrine" e "estoque" são palavras do
// PAINEL — quem lê ali é a lojista. Na loja, o subtexto ou vende ou sai.
//
// Este teste guarda a régua, não as frases: o que ele proíbe é o
// vocabulário interno aparecer em texto que o cliente lê.
// ============================================================
const fs = require('fs');
const path = require('path');

const parts = (f) => fs.readFileSync(path.join(__dirname, '../src/templates/storefront/parts', f), 'utf8');

/** Só as strings literais — comentário de código pode falar de estoque à vontade. */
function textosVisiveis(src) {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
    .match(/'[^']{12,}'/g) || [];
}

const VOCABULARIO_DO_PAINEL = /\b(estoque|cadastr\w+|vitrine|Caixa|ranking autom\w+|sistema)\b/i;

describe('vocabulário interno não aparece no que o cliente lê', () => {
  test.each(['home.js', 'tira_categorias.js'])('%s', (arquivo) => {
    const suspeitos = textosVisiveis(parts(arquivo))
      // "Sem estoque" na página do produto é informação de compra, não de
      // bastidor — mas ela não mora nestes dois arquivos.
      .filter((t) => VOCABULARIO_DO_PAINEL.test(t));
    expect(suspeitos).toEqual([]);
  });
});

describe('os subtextos novos', () => {
  const home = parts('home.js');
  const tira = parts('tira_categorias.js');

  test('Mais vendidos fala do que sai, não de onde o número vem', () => {
    expect(home).toContain("'Mais vendidos','As peças que mais saem daqui.'");
  });

  test('Últimas unidades cria urgência com o que é verdade', () => {
    // A regra é estoque total <= max(stock_min, 1): restam poucas mesmo.
    expect(home).toContain("'Últimas unidades','Restam poucas de cada uma.'");
  });

  test('Acabaram de chegar não diz "cadastro"', () => {
    expect(home).toContain("'Acabaram de chegar','O que entrou por último na loja.'");
  });

  test('a tira convida em vez de explicar', () => {
    expect(tira).toContain("'Compre por categoria','Escolha por onde começar.'");
  });
});

describe('as notas de rodapé do menu saíram', () => {
  const home = parts('home.js');

  test('o mega-menu e a gaveta não explicam mais como o menu é montado', () => {
    expect(home).not.toContain('mega-nota');
    expect(home).not.toContain('drawer-nota');
  });

  test('o CSS órfão saiu junto', () => {
    const css = require('../src/templates/storefrontHomeStyles')({ fontSerif: 'S', fontSans: 'A', fontMono: 'M' });
    expect(css).not.toContain('.mega-nota');
    expect(css).not.toContain('.drawer-nota');
  });

  test('o menu em si continua inteiro', () => {
    // Tirar a nota não pode ter levado a lista junto.
    expect(home).toContain('mega-col');
    expect(home).toContain('drawer-nav');
  });
});
