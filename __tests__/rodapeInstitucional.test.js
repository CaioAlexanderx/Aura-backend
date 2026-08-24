// O rodape mostra o que a loja ACEITA, nao uma lista fixa de bandeiras.
// Anunciar forma de pagamento que a loja nao aceita e pior que nao
// anunciar: o cliente monta o carrinho contando com o cartao e descobre
// no fim que so tem Pix.
const buildPage = require('../src/templates/storefrontPage');

function pagina(settings, extra) {
  return buildPage({
    slug: 'loja',
    site: { name: 'Loja', primary_color: '#7C3AED' },
    settings: settings || {},
    contact: {},
    products: [],
    categories: [],
    ...extra,
  }, 'loja');
}

describe('formas de pagamento no rodape', () => {
  test('loja sem Pix e sem cartao nao mostra o bloco', () => {
    const html = pagina({});
    expect(html).not.toContain('Formas de pagamento');
  });

  test('so Pix mostra so Pix', () => {
    const html = pagina({ has_pix: true, has_card: false });
    expect(html).toContain('Formas de pagamento');
    expect(html).toContain('Pix');
    expect(html).not.toContain('Cartão de crédito');
  });

  test('com cartao, mostra os dois', () => {
    const html = pagina({ has_pix: true, has_card: true });
    expect(html).toContain('Pix · Cartão de crédito e débito');
  });

  test('pagamento na entrega entra quando ligado', () => {
    const html = pagina({ has_pix: true, pay_on_delivery_enabled: true });
    expect(html).toContain('Pagamento na entrega');
  });

  test('cartao SEM pix nao inventa Pix', () => {
    const html = pagina({ has_pix: false, has_card: true });
    expect(html).toContain('Cartão de crédito e débito');
    // "Pix" nao pode aparecer como forma de pagamento oferecida.
    expect(html).not.toContain('>Pix<');
    expect(html).not.toContain('Pix ·');
  });

  test('nao inventa bandeira que a Aura nao tem', () => {
    // A assercao olha o BLOCO renderizado, nao o documento: o comentario
    // no CSS que explica por que nao usamos selo de bandeira cita "VISA",
    // e o comentario viaja junto no <style>.
    const html = pagina({ has_pix: true, has_card: true });
    const i = html.indexOf('<div class="footer-inst">');
    expect(i).toBeGreaterThan(0);
    const bloco = html.slice(i, html.indexOf('</div>', html.indexOf('Trocas e devoluções')));
    for (const marca of ['VISA', 'Visa', 'Mastercard', 'Elo', 'American Express']) {
      expect(bloco).not.toContain(marca);
    }
  });
});

describe('politica de troca', () => {
  test('sem texto da lojista, usa o padrao', () => {
    const html = pagina({ has_pix: true });
    expect(html).toContain('Trocas e devoluções');
    // O padrao espelha o prazo do CDC para compra fora do
    // estabelecimento. Nao promete mais que a lei.
    expect(html).toContain('7 dias corridos');
    expect(html).toContain('Código de Defesa do Consumidor');
  });

  test('texto da lojista SUBSTITUI o padrao', () => {
    const html = pagina({ has_pix: true }, { politica_troca: 'Trocamos em 30 dias, sem perguntas.' });
    expect(html).toContain('Trocamos em 30 dias');
    expect(html).not.toContain('7 dias corridos');
  });

  test('texto em branco cai no padrao, nao some', () => {
    // Campo vazio nao pode virar loja sem politica nenhuma.
    for (const vazio of ['', '   ', null, undefined]) {
      const html = pagina({ has_pix: true }, { politica_troca: vazio });
      expect(html).toContain('7 dias corridos');
    }
  });

  test('o texto da lojista e escapado', () => {
    const html = pagina({ has_pix: true }, { politica_troca: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('o painel recebe o mesmo texto que a loja publica', () => {
  // Se o app duplicasse o texto padrao, uma correcao aqui passaria a valer
  // na loja e nao no painel: a lojista leria uma politica no campo e
  // publicaria outra no rodape. Por isso o padrao viaja no GET da config.
  const fs = require('fs');
  const path = require('path');
  const rota = fs.readFileSync(
    path.join(__dirname, '../src/routes/digitalChannel.js'), 'utf8',
  );

  test('o GET da config devolve politica_troca_padrao', () => {
    expect(rota).toContain('politica_troca_padrao: POLITICA_PADRAO');
    // Nos DOIS caminhos: loja que ainda nao existe tambem precisa do texto,
    // senao o campo nasce vazio na primeira configuracao.
    expect(rota.match(/politica_troca_padrao/g).length).toBeGreaterThanOrEqual(2);
  });

  test('o padrao sai de um so lugar', () => {
    const tpl = require('../src/templates/storefrontHtml');
    expect(typeof tpl.POLITICA_PADRAO).toBe('string');
    expect(tpl.POLITICA_PADRAO).toContain('7 dias corridos');
    // O texto nao pode estar escrito a mao dentro da rota.
    expect(rota).not.toContain('7 dias corridos');
  });
});
