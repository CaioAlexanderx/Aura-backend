// ============================================================
// Redes sociais no rodapé (02/09/2026)
//
// A lojista cadastra o @ e a loja mostra o ícone. O campo `instagram` já
// existia desde o começo do canal digital e NINGUÉM desenhava: estava no
// painel, ia pro payload e morria ali. TikTok e Facebook nasceram junto.
//
// O que este teste guarda:
//   1. O que a lojista digita — @nome, nome, o link inteiro, o link de
//      partilha com ?igsh= — vira sempre a mesma coisa.
//   2. O que NÃO pode virar href numa loja pública: javascript:, link de
//      outro site, caracteres fora do alfabeto de perfil da rede.
//   3. Sem rede cadastrada, o rodapé não desenha linha nenhuma.
// ============================================================
const fs = require('fs');
const path = require('path');
const { normalizarHandle, urlDoPerfil, montarRedes, REDES } = require('../src/services/redesSociais');
const buildPage = require('../src/templates/storefrontPage');

const fonte = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function pagina(redes) {
  return buildPage({
    site: { name: 'Davi Calçados', primary_color: '#0bbdea' },
    contact: { whatsapp: '5512999999999', redes },
    settings: {}, products: [], categories: [], categorias_arvore: [],
    tira_de_categorias: [], facetas: { preco: { min: 10, max: 300 } },
    home: { mais_vendidos: [], ultimas_unidades: [], novidades: [] },
  }, 'davi-calcados-villa-branca');
}

describe('o @ que a lojista digita, de todo jeito que ela digita', () => {
  test.each([
    ['@lojinha', 'lojinha'],
    ['lojinha', 'lojinha'],
    ['  @Lojinha_01  ', 'Lojinha_01'],
    ['instagram.com/lojinha', 'lojinha'],
    ['https://instagram.com/lojinha', 'lojinha'],
    ['https://www.instagram.com/lojinha/', 'lojinha'],
    ['https://www.instagram.com/lojinha/?igsh=abc123', 'lojinha'],
  ])('instagram: %s → %s', (bruto, esperado) => {
    expect(normalizarHandle('instagram', bruto)).toBe(esperado);
  });

  test('tiktok aceita o @ dentro do caminho', () => {
    expect(normalizarHandle('tiktok', 'https://www.tiktok.com/@davi.calcados')).toBe('davi.calcados');
    expect(normalizarHandle('tiktok', '@davi.calcados')).toBe('davi.calcados');
  });

  test('facebook aceita hífen, que Instagram e TikTok não têm', () => {
    expect(normalizarHandle('facebook', 'https://facebook.com/davi-calcados')).toBe('davi-calcados');
    expect(normalizarHandle('instagram', 'davi-calcados')).toBeNull();
  });

  test('vazio é null, não string vazia', () => {
    for (const v of ['', '   ', null, undefined, '@', '@@']) {
      expect(normalizarHandle('instagram', v)).toBeNull();
    }
  });
});

describe('o que não pode virar link numa loja pública', () => {
  test.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'https://evil.com/lojinha',
    'https://instagram.com.evil.com/lojinha',
    'lojinha/../../etc',
    'loja com espaco',
    '<script>',
  ])('recusa %s', (ruim) => {
    expect(normalizarHandle('instagram', ruim)).toBeNull();
    expect(urlDoPerfil('instagram', ruim)).toBeNull();
  });

  test('rede desconhecida não passa', () => {
    expect(normalizarHandle('orkut', 'lojinha')).toBeNull();
    expect(urlDoPerfil('orkut', 'lojinha')).toBeNull();
  });
});

describe('montarRedes: só o que existe, na ordem do rodapé', () => {
  test('as três, na ordem', () => {
    const r = montarRedes({ instagram: '@a', tiktok: '@b', facebook: '@c' });
    expect(r.map((x) => x.rede)).toEqual(['instagram', 'tiktok', 'facebook']);
    expect(r.map((x) => x.url)).toEqual([
      'https://instagram.com/a', 'https://tiktok.com/@b', 'https://facebook.com/c',
    ]);
  });

  test('campo vazio ou inválido some da lista', () => {
    expect(montarRedes({ instagram: '@a', tiktok: '', facebook: 'https://evil.com/x' }))
      .toEqual([{ rede: 'instagram', nome: 'Instagram', handle: 'a', url: 'https://instagram.com/a' }]);
    expect(montarRedes({})).toEqual([]);
    expect(montarRedes(null)).toEqual([]);
  });
});

describe('o rodapé', () => {
  test('desenha um link por rede, em nova aba e sem vazar referrer', () => {
    const html = pagina([
      { rede: 'instagram', nome: 'Instagram', handle: 'davi', url: 'https://instagram.com/davi' },
      { rede: 'tiktok', nome: 'TikTok', handle: 'davi', url: 'https://tiktok.com/@davi' },
    ]);
    expect(html).toContain('class="footer-redes"');
    expect(html).toContain('href="https://instagram.com/davi" target="_blank" rel="noopener"');
    expect(html).toContain('href="https://tiktok.com/@davi" target="_blank" rel="noopener"');
    // O @ vai no aria-label e no title: o ícone sozinho não diz o perfil.
    expect(html).toContain('aria-label="Instagram: @davi"');
    expect(html).toContain('title="@davi"');
    // Facebook não foi cadastrado — não aparece.
    expect(html).not.toContain('facebook.com');
  });

  test('sem rede nenhuma, a linha não existe', () => {
    // O CSS da folha está sempre na página; o que não pode existir é a
    // marcação — ícone que leva a lugar nenhum é pior que ícone nenhum.
    const html = pagina([]);
    expect(html).not.toContain('class="footer-redes"');
    expect(html).not.toContain('class="footer-rede"');
  });

  test('o ícone herda a tinta do rodapé e tem alvo de dedo', () => {
    const css = require('../src/templates/storefrontHomeStyles')({ fontSerif: 'S', fontSans: 'A', fontMono: 'M' });
    expect(css).toContain('.footer-redes{display:flex;');
    expect(css).toMatch(/\.footer-rede\{[^}]*width:40px;height:40px;/);
    expect(css).toMatch(/\.footer-rede\{[^}]*color:var\(--sf-ink-2\);/);
    expect(css).toContain('.footer-rede:hover{color:var(--sf-brand);border-color:var(--sf-brand);}');
    // Nao sobe: elevacao e da peca e do botao de compra (lojaMinimalista).
    expect(css).not.toMatch(/\.footer-rede:hover\{[^}]*transform/);
    expect(css).toContain('.footer-rede:focus-visible{outline:2px solid var(--sf-brand);');
  });
});

describe('o caminho até o rodapé não pode se perder', () => {
  test('o builder normaliza e põe em contact.redes', () => {
    const builder = fonte('src/services/storefrontBuilder.js');
    expect(builder).toContain("const { montarRedes } = require('./redesSociais');");
    expect(builder).toContain('redes: montarRedes(config),');
  });

  test('a página passa contact.redes pro template', () => {
    expect(fonte('src/templates/storefrontPage.js')).toContain('redes: (data.contact && data.contact.redes) || []');
  });

  test('a rota grava o @ já limpo — inclusive o Instagram, que é antigo', () => {
    const rota = fonte('src/routes/digitalChannel.js');
    expect(rota).toContain("const { normalizarHandle } = require('../services/redesSociais');");
    expect(rota).toContain("[['instagram', instagram], ['tiktok', tiktok], ['facebook', facebook]]");
    expect(rota).toContain('const limpo = normalizarHandle(campo, valor);');
    // 42703: a base sem a migration 319 não pode derrubar o salvamento.
    expect(rota).toContain("[canal-redes] coluna ${campo} inexistente");
  });

  test('as três redes têm glyph próprio', () => {
    const html = fonte('src/templates/storefrontHtml.js');
    for (const { rede } of REDES) {
      expect(html).toContain(`${rede}: '<svg`);
    }
  });
});
