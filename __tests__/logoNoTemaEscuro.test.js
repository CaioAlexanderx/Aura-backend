// ============================================================
// Logo no tema escuro (tq-64, 20/10/2026)
//
// O multiply existe pra JPEG de fundo branco nao virar um retangulo
// branco sobre o creme (o caso da Finesse). No tema escuro ele faz o
// contrario: multiplica a logo pelo fundo quase preto e ela some. O topo
// e o rodape ja tinham a excecao `body.sf-dark ... {mix-blend-mode:normal}`;
// o topo do checkout nao tinha, e a logo da Felic sumia ao fechar o
// pedido.
//
// Este teste guarda a regra: TODA logo com multiply tem a excecao do
// escuro. A proxima logo que entrar com multiply quebra aqui.
// ============================================================
const buildStyles = require('../src/templates/storefrontStyles');

const css = buildStyles('#C7A956', '#C7A956', true, 'classic');

function seletoresComMultiply() {
  const achados = [];
  const re = /(^|\n)([^\n{]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    if (/mix-blend-mode:multiply/.test(m[3])) achados.push(m[2].trim());
  }
  return achados;
}

describe('logo com multiply tem a excecao do tema escuro', () => {
  test('topo, rodape e topo do checkout estao cobertos', () => {
    const lista = seletoresComMultiply();
    expect(lista).toEqual(expect.arrayContaining([
      '.topbar-logo img',
      '.site-footer-logo img',
      '.checkout-topo-logo img',
    ]));
  });

  test.each(seletoresComMultiply())('%s volta a normal no body.sf-dark', (seletor) => {
    expect(css).toContain(`body.sf-dark ${seletor}{mix-blend-mode:normal;}`);
  });

  test('loja clara continua com multiply no checkout (a regra clara nao mudou)', () => {
    expect(css).toContain('.checkout-topo-logo img{height:42px;max-width:140px;object-fit:contain;mix-blend-mode:multiply;}');
  });
});
