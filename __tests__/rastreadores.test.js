// ============================================================
// GA4 e Pixel nas lojas (04/09/2026)
//
// As colunas existiam desde a migration 220 e o painel gravava; nenhuma
// loja lia. A lojista colava o ID e o Google nunca via uma visita.
// ============================================================
const fs = require('fs');
const path = require('path');
const {
  idGa4, idPixel, rastreadoresDaLoja, scriptsDoHead, metatagsDeSeo,
} = require('../src/services/rastreadores');

describe('o ID so entra no formato certo', () => {
  test('GA4 e G- mais letras e numeros, e sobe para maiusculas', () => {
    expect(idGa4('g-abc123xyz')).toBe('G-ABC123XYZ');
    expect(idGa4('G-1234567890')).toBe('G-1234567890');
  });

  test('UA antigo, GTM e lixo viram null — nao viram script quebrado', () => {
    expect(idGa4('UA-12345-1')).toBeNull();
    expect(idGa4('GTM-ABC123')).toBeNull();
    expect(idGa4('')).toBeNull();
    expect(idGa4(null)).toBeNull();
  });

  test('Pixel e numerico de 15 ou 16 digitos', () => {
    expect(idPixel('123456789012345')).toBe('123456789012345');
    expect(idPixel(' 1234567890123456 ')).toBe('1234567890123456');
    expect(idPixel('12345')).toBeNull();
    expect(idPixel('abc')).toBeNull();
  });
});

describe('o que vai para o head', () => {
  test('loja sem rastreador nao carrega script nenhum', () => {
    expect(scriptsDoHead(rastreadoresDaLoja({}))).toBe('');
    expect(scriptsDoHead(rastreadoresDaLoja({ ga4_measurement_id: 'lixo' }))).toBe('');
  });

  test('com GA4, o gtag com o ID e IP anonimizado', () => {
    const h = scriptsDoHead(rastreadoresDaLoja({ ga4_measurement_id: 'G-ABC123XYZ' }));
    expect(h).toContain('googletagmanager.com/gtag/js?id=G-ABC123XYZ');
    expect(h).toContain("gtag('config','G-ABC123XYZ'");
    expect(h).toContain('anonymize_ip:true');
    expect(h).not.toContain('fbq(');
  });

  test('com Pixel, o fbevents com o ID e o PageView', () => {
    const h = scriptsDoHead(rastreadoresDaLoja({ meta_pixel_id: '123456789012345' }));
    expect(h).toContain("fbq('init','123456789012345')");
    expect(h).toContain("fbq('track','PageView')");
    expect(h).not.toContain('gtag');
  });
});

describe('as metatags de compartilhamento', () => {
  test('titulo, descricao, url e imagem viram Open Graph', () => {
    const m = metatagsDeSeo({ titulo: 'Sheid Mania', descricao: 'Canecas', url: 'https://loja.getaura.com.br/sheid-mania', imagem: 'https://r2/capa.jpg' });
    expect(m).toContain('<meta property="og:title" content="Sheid Mania">');
    expect(m).toContain('<meta property="og:description" content="Canecas">');
    expect(m).toContain('<link rel="canonical" href="https://loja.getaura.com.br/sheid-mania">');
    expect(m).toContain('<meta property="og:image" content="https://r2/capa.jpg">');
    expect(m).toContain('summary_large_image');
  });

  test('aspas e sinais no nome da loja nao escapam do atributo', () => {
    const m = metatagsDeSeo({ titulo: 'Loja "A&B" <x>', descricao: '' });
    expect(m).toContain('content="Loja &quot;A&amp;B&quot; &lt;x>"');
  });

  test('sem imagem, o cartao e o simples', () => {
    expect(metatagsDeSeo({ titulo: 'X' })).toContain('content="summary"');
  });
});

describe('as duas lojas leem do mesmo lugar', () => {
  const le = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  test('a loja comum injeta no head a partir do servico', () => {
    const t = le('src/templates/storefrontPage.js');
    expect(t).toContain("require('../services/rastreadores')");
    expect(t).toContain('scriptsDoHead(site.rastreadores');
    expect(t).toContain('metatagsDeSeo({');
  });

  test('o builder e o payload do Studio expoem os IDs validados', () => {
    expect(le('src/services/storefrontBuilder.js')).toContain('rastreadores:  rastreadoresDaLoja(config)');
    expect(le('src/routes/studioStorefront.js')).toContain('rastreadores: rastreadoresDaLoja(config)');
  });
});
