// ============================================================
// loja.getaura.com.br/<slug> serve a vitrine Studio (04/09/2026)
//
// A mesma empresa tinha duas lojas em dois enderecos, e a lojista
// divulgava a errada — o painel copiava o endereco da loja comum e a
// vitrine que ela vende morava em `app.getaura.com.br/cardapio/studio/`.
//
// A decisao: empresa em modo Studio tem UMA loja, neste endereco. O que
// estes testes guardam e o que torna isso seguro — o interruptor certo,
// o bundle apontando para onde ele existe, e a queda do app nao levando
// a loja junto.
// ============================================================
const fs = require('fs');
const path = require('path');

const {
  ehLojaStudio, apontarParaOApp, recadoParaOApp, cspDaVitrineStudio, HOST_DO_APP,
} = require('../src/services/vitrineStudioShell');

describe('quem recebe a vitrine no lugar da loja comum', () => {
  test('so a empresa com o modo Studio ligado', () => {
    expect(ehLojaStudio({ pdv_settings: { studio_enabled: true } })).toBe(true);
    expect(ehLojaStudio({ pdv_settings: { studio_enabled: false } })).toBe(false);
  });

  test('o mesmo interruptor que o painel usa, inclusive como texto', () => {
    // `pdv_settings` e jsonb: dependendo de como a linha e lida, o valor
    // chega como booleano ou como a string "true". As seis lojas que nao
    // sao Studio nao podem trocar de vitrine por causa disso.
    expect(ehLojaStudio({ pdv_settings: { studio_enabled: 'true' } })).toBe(true);
    expect(ehLojaStudio({ pdv_settings: { studio_enabled: 'false' } })).toBe(false);
  });

  test('empresa sem o campo, ou sem pdv_settings, fica na loja comum', () => {
    expect(ehLojaStudio({ pdv_settings: {} })).toBe(false);
    expect(ehLojaStudio({ pdv_settings: null })).toBe(false);
    expect(ehLojaStudio({})).toBe(false);
    expect(ehLojaStudio(null)).toBe(false);
  });
});

describe('a casca do app servida sob outro dominio', () => {
  const casca = `<!DOCTYPE html><html><head><title>Aura.</title>`
    + `<link rel="icon" href="/assets/favicon.png">`
    + `</head><body><div id="root"></div>`
    + `<script src="/_expo/static/js/web/entry-abc123.js" defer></script>`
    + `</body></html>`;

  test('o bundle passa a apontar para o host onde ele existe', () => {
    // Servido daqui, `/_expo/...` e 404: o bundle mora no app. Sem esta
    // reescrita a loja abre em branco.
    const r = apontarParaOApp(casca);
    expect(r).toContain(`src="${HOST_DO_APP}/_expo/static/js/web/entry-abc123.js"`);
    expect(r).not.toContain('src="/_expo/');
  });

  test('os assets tambem', () => {
    expect(apontarParaOApp(casca)).toContain(`href="${HOST_DO_APP}/assets/favicon.png"`);
  });

  test('nao mexe em caminho que nao seja do Expo', () => {
    // Um replace solto em `/` quebraria qualquer href da propria pagina.
    const outro = '<a href="/politica">Política</a><img src="/logo.png">';
    expect(apontarParaOApp(outro)).toBe(outro);
  });
});

describe('o recado que diz qual loja abrir', () => {
  test('leva o slug', () => {
    expect(recadoParaOApp('sheid-mania')).toContain('"sheid-mania"');
    expect(recadoParaOApp('sheid-mania')).toContain('window.__AURA_VITRINE__');
  });

  test('slug com aspas nao escapa do script', () => {
    // O slug vem da URL. Sem escape, `"</script>` fecharia a tag e o
    // resto viraria HTML — injecao pela barra de endereco.
    const r = recadoParaOApp('x" onload="alert(1)');
    expect(r).not.toContain('onload="alert(1)"');
    expect(r).toContain('\\"');
  });
});

describe('a CSP da vitrine', () => {
  const csp = cspDaVitrineStudio('https://api.getaura.com.br');

  test('libera o bundle do app e o three.js do motor 3D', () => {
    expect(csp).toContain(`script-src 'self' 'unsafe-inline' ${HOST_DO_APP} https://cdnjs.cloudflare.com`);
  });

  test('libera a API e o R2, que e de onde vem a foto da cliente', () => {
    expect(csp).toContain('https://api.getaura.com.br');
    expect(csp).toContain('https://*.r2.dev');
  });

  test('nao abre curinga em script-src', () => {
    const linha = csp.split('; ').find((d) => d.startsWith('script-src '));
    expect(linha).not.toContain("'unsafe-eval'");
    expect(linha).not.toMatch(/script-src[^;]*\s\*/);
  });
});

describe('a rota que decide', () => {
  const rota = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'storefront.js'), 'utf8');

  test('le o interruptor da empresa, nao do canal digital', () => {
    // `digital_channel_config` nao sabe se a empresa e Studio; quem sabe
    // e `companies.pdv_settings`.
    expect(rota).toContain('COALESCE(c.pdv_settings');
    expect(rota).toContain('ehLojaStudio(');
  });

  test('app fora do ar cai na loja comum em vez de derrubar a loja', () => {
    // `montarVitrineStudio` devolve null nesse caso; o `if (pagina)` e o
    // que impede a pagina em branco.
    expect(rota).toContain('const pagina = await montarVitrineStudio(slug, cabecalho)');
    expect(rota).toContain('if (pagina) {');
  });

  test('a vitrine sai com a CSP dela, nao com a da loja comum', () => {
    expect(rota).toContain('cspDaVitrineStudio(STOREFRONT_API_BASE)');
  });
});

// ============================================================
// BE-1 (25/09/2026) — a previa do link. O robo do WhatsApp nao roda
// JavaScript: o que ele mostra e o que o servidor escreveu no <head>.
// As rotas ponta a ponta estao em vitrineStudioEnderecos.test.js.
// ============================================================
const {
  metatagsDaVitrineStudio, comCabecalhoDaLoja, precoEmReais, textoCurto, fotoDaPeca,
} = require('../src/services/vitrineStudioShell');

describe('as metatags da vitrine Studio', () => {
  const loja = { nome: 'Sheid Mania', tagline: 'Canecas que viram presente', logo_url: 'https://r2/logo.png' };
  const peca = {
    id: '8f21c4a9-5b1e-4c7a-9d3e-2a6f0b1c9e77', name: 'Caneca Alça Coração', price: 49.9,
    description: 'Porcelana branca, 325 ml.', image_url: 'https://r2/g.jpg', image_thumb_url: 'https://r2/p.jpg',
  };
  const url = 'https://loja.getaura.com.br/sheid-mania';

  test('preco em reais, com milhar e centavos; zero ou lixo nao vira preco', () => {
    expect(precoEmReais(49.9)).toBe('R$ 49,90');
    expect(precoEmReais('1234.5')).toBe('R$ 1.234,50');
    expect(precoEmReais(0)).toBe('');
    expect(precoEmReais(null)).toBe('');
    expect(precoEmReais('abc')).toBe('');
  });

  test('descricao longa e cortada na palavra, com reticencias', () => {
    const t = textoCurto('palavra '.repeat(40), 60);
    expect(t.length).toBeLessThanOrEqual(60);
    expect(t.endsWith('palavra…')).toBe(true);
    expect(textoCurto('  duas\n\nlinhas  ')).toBe('duas linhas');
  });

  test('a foto: miniatura, depois a grande, depois a galeria', () => {
    expect(fotoDaPeca(peca)).toBe('https://r2/p.jpg');
    expect(fotoDaPeca({ image_url: 'https://r2/g.jpg' })).toBe('https://r2/g.jpg');
    expect(fotoDaPeca({ gallery_urls: [null, 'https://r2/1.jpg'] })).toBe('https://r2/1.jpg');
    expect(fotoDaPeca({})).toBeNull();
  });

  test('da peca: titulo "<peca> · <loja>", preco na descricao e tipo product', () => {
    const h = metatagsDaVitrineStudio({ loja, peca, urlDaLoja: url });
    expect(h).toContain('<title>Caneca Alça Coração · Sheid Mania</title>');
    expect(h).toContain('<meta property="og:description" content="R$ 49,90 · Porcelana branca, 325 ml.">');
    expect(h).toContain(`<meta property="og:url" content="${url}/p/${peca.id}">`);
    expect(h).toContain('<meta property="og:type" content="product">');
    expect(h).toContain('<meta name="twitter:card" content="summary_large_image">');
  });

  test('loja que esconde preco nao tem preco na previa', () => {
    const h = metatagsDaVitrineStudio({ loja, peca, urlDaLoja: url, mostrarPreco: false });
    expect(h).not.toContain('R$');
  });

  test('peca sem descricao ganha "<peca> na <loja>"', () => {
    const h = metatagsDaVitrineStudio({ loja, peca: { ...peca, description: null }, urlDaLoja: url });
    expect(h).toContain('content="R$ 49,90 · Caneca Alça Coração na Sheid Mania"');
  });

  test('sem peca: nome, tagline e logo da loja', () => {
    const h = metatagsDaVitrineStudio({ loja, peca: null, urlDaLoja: url });
    expect(h).toContain('<title>Sheid Mania</title>');
    expect(h).toContain('<meta property="og:description" content="Canecas que viram presente">');
    expect(h).toContain('<meta property="og:image" content="https://r2/logo.png">');
    expect(h).toContain('<meta property="og:type" content="website">');
  });

  test('o que vem da lojista e escapado nos atributos e no <title>', () => {
    const h = metatagsDaVitrineStudio({
      loja: { nome: 'A&B "Loja"', tagline: '<img src=x onerror=alert(1)>' },
      peca: { ...peca, name: '"><script>x()</script>' }, urlDaLoja: url,
    });
    expect(h).not.toContain('<script>');
    expect(h).not.toContain('<img');
    expect(h).toContain('<title>&quot;&gt;&lt;script&gt;x()&lt;/script&gt; · A&amp;B &quot;Loja&quot;</title>');
  });

  test('entra no lugar do <title> da casca e tira Open Graph que ela tiver', () => {
    const casca = '<html><head><title>Aura.</title><meta property="og:image" content="aura.png">'
      + '<meta name="description" content="Aura"></head><body></body></html>';
    const r = comCabecalhoDaLoja(casca, metatagsDaVitrineStudio({ loja, peca, urlDaLoja: url }));
    expect(r).not.toContain('Aura.');
    expect(r).not.toContain('aura.png');
    expect(r.match(/<title>/g)).toHaveLength(1);
    expect(r).toContain('og:image" content="https://r2/p.jpg"');
  });

  test('casca sem <title> recebe o cabecalho antes de </head>', () => {
    const r = comCabecalhoDaLoja('<head></head>', '<title>X</title>');
    expect(r).toBe('<head><title>X</title></head>');
  });

  test('"$&" no nome nao vira padrao de substituicao', () => {
    const r = comCabecalhoDaLoja('<head><title>Aura.</title></head>', '<title>R$& co</title>');
    expect(r).toBe('<head><title>R$& co</title></head>');
  });
});
