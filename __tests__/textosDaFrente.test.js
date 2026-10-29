// ============================================================
// Textos fixos da vitrine pela frente da conta (tq-58, 29/10/2026)
//
// "Sobre esta peça" e "Dúvida sobre tamanho ou modelo?" sao textos de loja
// de roupa. Frente que nao e de roupa (incluindo a futura "Adega e bar")
// passa a ver "Sobre o produto" e "Dúvida sobre o produto?".
//
// O que mais importa aqui e o que NAO muda: loja de roupa (frente vazia
// ou 'varejo') sai byte a byte igual. As fixtures .html foram geradas com
// o codigo de origin/main antes deste cartao (tests/fixtures/vitrine/).
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

const { textosDaFrente, ehFrenteDeRoupa, TEXTOS_DE_ROUPA } = require('../src/services/textosDaFrente');
const { BLOCO_PADRAO } = require('../src/services/whatsappDaLoja');
const buildScript = require('../src/templates/storefront');
const { dados, ANO_DA_FIXTURE } = require('../tests/fixtures/vitrine/lojaDeRoupa');

const DIR = path.join(__dirname, '../tests/fixtures/vitrine');
const fixture = (nome) => fs.readFileSync(path.join(DIR, nome), 'utf8');
const productDetail = fs.readFileSync(path.join(__dirname, '../src/templates/storefront/parts/product_detail.js'), 'utf8');

let buildPage;
beforeAll(() => {
  // O mesmo ambiente em que as fixtures nasceram: ano travado e o
  // endereco padrao da API.
  jest.useFakeTimers({ now: new Date(ANO_DA_FIXTURE) });
  for (const k of Object.keys(process.env)) {
    if (/API_PUBLIC|PUBLIC_API|API_URL|BACKEND_URL|RAILWAY/.test(k)) delete process.env[k];
  }
  buildPage = require('../src/templates/storefrontPage');
});
afterAll(() => jest.useRealTimers());

describe('a frente decide os textos', () => {
  test.each([null, undefined, '', 'varejo', ' Varejo '])('roupa: %p', (seg) => {
    expect(ehFrenteDeRoupa(seg)).toBe(true);
    expect(textosDaFrente(seg)).toEqual({
      sobreProduto: 'Sobre esta peça',
      duvidaTitulo: 'Dúvida sobre tamanho ou modelo?',
    });
  });

  test.each(['matcon', 'otica', 'assistencia', 'studio', 'outro', 'adega'])('nao e roupa: %p', (seg) => {
    expect(textosDaFrente(seg)).toEqual({
      sobreProduto: 'Sobre o produto',
      duvidaTitulo: 'Dúvida sobre o produto?',
    });
  });

  test('o texto de roupa e o mesmo do bloco padrao do WhatsApp', () => {
    expect(TEXTOS_DE_ROUPA.duvidaTitulo).toBe(BLOCO_PADRAO.titulo);
  });
});

describe('loja de roupa: byte a byte igual a de antes', () => {
  test.each([
    ['sem o campo (payload antigo)', undefined],
    ['frente vazia', textosDaFrente(null)],
    ['varejo', textosDaFrente('varejo')],
  ])('home com WhatsApp — %s', (_nome, textos) => {
    const extra = textos === undefined ? {} : { textos_da_frente: textos };
    expect(buildPage(dados(extra), 'loja-modelo')).toBe(fixture('loja-de-roupa.html'));
  });

  test('com o texto do bloco escrito pela lojista (migration 401)', () => {
    const html = buildPage(dados({
      whats_bloco: { titulo: null, texto: 'Respondemos em minutos.' },
      textos_da_frente: textosDaFrente('varejo'),
    }), 'loja-modelo');
    expect(html).toBe(fixture('loja-de-roupa-texto-da-lojista.html'));
  });
});

describe('frente que nao e de roupa', () => {
  const adega = () => buildPage(dados({ textos_da_frente: textosDaFrente('outro') }), 'loja-modelo');

  test('pagina do produto: "Sobre o produto"', () => {
    const html = adega();
    expect(html).toContain('<div class="sf-label">Sobre o produto</div>');
    expect(html).not.toContain('Sobre esta peça');
  });

  test('bloco do WhatsApp: "Dúvida sobre o produto?"', () => {
    const html = adega();
    expect(html).toContain('<div class="whats-block-tit serif">Dúvida sobre o produto?</div>');
    expect(html).not.toContain('Dúvida sobre tamanho ou modelo?');
  });

  test('o titulo escrito pela lojista continua ganhando', () => {
    const html = buildPage(dados({
      whats_bloco: { titulo: 'Fale com o sommelier', texto: null },
      textos_da_frente: textosDaFrente('outro'),
    }), 'loja-modelo');
    expect(html).toContain('Fale com o sommelier');
    expect(html).not.toContain('Dúvida sobre o produto?');
  });

  test('so o titulo e o rotulo mudam: o resto da pagina e o mesmo da loja de roupa', () => {
    const roupa = fixture('loja-de-roupa.html');
    const outra = adega()
      .replace('<div class="sf-label">Sobre o produto</div>', '<div class="sf-label">Sobre esta peça</div>')
      .replace('Dúvida sobre o produto?', 'Dúvida sobre tamanho ou modelo?');
    expect(outra).toBe(roupa);
  });
});

describe('a troca no script da pagina do produto', () => {
  test('o rotulo procurado existe UMA vez no part (se mudar la, a troca nao falha calada)', () => {
    const n = productDetail.split(buildScript.ROTULO_SOBRE_DE_ROUPA).length - 1;
    expect(n).toBe(1);
  });

  test('sem frente, o script e o mesmo de sempre', () => {
    expect(buildScript('{}', 's', '', null)).toBe(buildScript('{}', 's', ''));
  });

  test('texto com aspas ou barra nao quebra a string do script', () => {
    const js = buildScript('{}', 's', '', { sobreProduto: "Sobre o \\ 'produto'" });
    expect(js).toContain('<div class="sf-label">Sobre o  produto</div>');
  });
});
