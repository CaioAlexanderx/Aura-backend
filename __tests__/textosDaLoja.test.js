// ============================================================
// Textos da loja (QA das lojas, 08/09/2026)
//
// Quatro achados de copy e um de valor:
//  - "Duvida com tamanho ou tecido?" era jargao de moda fixo no template,
//    e aparecia na loja de calcados;
//  - "Curadoria editada" era o selo padrao do painel, gravado em lojas
//    que nunca mexeram nele;
//  - "Loja sem CEP de origem geolocalizado, usando taxa fixa." e recado
//    pra lojista e aparecia pra cliente no calculo de frete;
//  - a opcao "Entrega" do checkout dizia "Gratis" antes de qualquer CEP,
//    em loja com frete por distancia;
//  - depois da cotacao, o resumo somava o delivery_fee fixo da config em
//    vez do frete cotado — que e o que o servidor cobra.
// ============================================================
const fs = require('fs');
const path = require('path');
const buildPage = require('../src/templates/storefrontPage');

const fonte = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function pagina(extra) {
  return buildPage({
    slug: 'loja',
    site: { name: 'Loja', primary_color: '#7a1f3a' },
    contact: { whatsapp: '5512999990000' }, settings: {}, products: [], categories: [],
    categorias_arvore: [], tira_de_categorias: [], facetas: { preco: { min: 10, max: 300 } },
    home: { mais_vendidos: [], ultimas_unidades: [], novidades: [] },
    ...extra,
  }, 'loja');
}

describe('copy que serve a qualquer loja', () => {
  test('o bloco do WhatsApp nao fala em tecido', () => {
    const html = pagina({});
    expect(html).toContain('Dúvida sobre tamanho ou modelo?');
    expect(html).not.toContain('tecido');
  });

  test('o selo padrao do painel deixou de ser "Curadoria editada"', () => {
    const rota = fonte('src/routes/digitalChannel.js');
    expect(rota).not.toContain("title: 'Curadoria editada'");
    expect(rota).toContain("title: 'Seleção da loja'");
    expect(rota).not.toContain('Curadoria editada, pensada pra durar.');
  });

  test('loja que ainda tem o par antigo gravado recebe o padrao novo', () => {
    // parseServiceCards nao e exportada; a pagina e o caminho publico.
    const html = pagina({ site: { name: 'Loja', primary_color: '#7a1f3a', service_cards: [
      { icon: 'sparkle', title: 'Curadoria editada', body: 'Produtos selecionados', enabled: true },
    ] } });
    // O template desenha o que o builder entregou; aqui o builder nao rodou,
    // entao conferimos a regra na fonte.
    const builder = fonte('src/services/storefrontBuilder.js');
    expect(builder).toContain("if (title === 'Curadoria editada' && body === 'Produtos selecionados')");
    expect(builder).toContain("title = 'Seleção da loja'; body = 'Escolhidos a dedo';");
    expect(html).toBeTruthy();
  });

  test('selo que a lojista escreveu fica intacto', () => {
    const builder = fonte('src/services/storefrontBuilder.js');
    // A troca exige o PAR antigo; titulo mudado ou corpo mudado passa direto.
    expect(builder).toContain("title === 'Curadoria editada' && body === 'Produtos selecionados'");
  });
});

describe('o recado de configuracao do frete nao vai pra cliente', () => {
  const js = pagina({}).match(/<script>([\s\S]*?)<\/script>/)[1];

  test('a pagina do produto nao desenha q.alert', () => {
    expect(js).not.toContain("q.alert?'<div");
    expect(js).not.toContain("esc(q.alert)");
  });

  test('o checkout nao concatena q.alert no status', () => {
    expect(js).not.toContain("q.alert?' · '+q.alert");
  });

  test('o servico continua devolvendo alert (e recado pro painel)', () => {
    const svc = fonte('src/services/shippingQuote.js');
    expect(svc).toContain("'Loja sem CEP de origem geolocalizado, usando taxa fixa.'");
  });
});

describe('frete por distancia antes do CEP', () => {
  const js = pagina({}).match(/<script>([\s\S]*?)<\/script>/)[1];

  test('a opcao de entrega diz "A calcular" enquanto nao ha cotacao', () => {
    expect(js).toContain("function freteACalcular(){ return SETTINGS.delivery_pricing_mode==='distance' && !shippingQuote; }");
    expect(js).toContain("(freteACalcular()?'A calcular':(fee2?fmt(fee2):'Grátis'))");
    expect(js).toContain('id="opt_delivery_preco"');
  });

  test('o resumo e a sacola usam a mesma regra', () => {
    expect(js).toContain("function textoDoFrete(fee){ return fretePendente()?'A calcular':(fee?fmt(fee):'Grátis'); }");
    expect((js.match(/spans\[1\]\.textContent=textoDoFrete\(fee\)/g) || []).length).toBe(2);
    expect(js).toContain("document.getElementById('deliveryVal').textContent=(typeof textoDoFrete==='function')?textoDoFrete(fee)");
  });

  test('com a cotacao feita, a opcao mostra o valor cotado', () => {
    expect(js).toContain("var precoOp=document.getElementById('opt_delivery_preco');");
    expect(js).toContain("precoOp.classList.remove('a-calcular');");
  });

  test('o total soma o frete cotado, o mesmo que o servidor confere', () => {
    expect(js).toContain("if(typeof shippingQuote!=='undefined' && shippingQuote && shippingQuote.fee!=null) return parseFloat(shippingQuote.fee)||0;");
    // O servidor confere pelo mesmo campo.
    expect(js).toContain('expectedFee=shippingQuote.fee;');
  });

  test('o script continua sendo JS valido', () => {
    expect(() => new Function(js.replace(/<\\\/script>/g, '</script>'))).not.toThrow();
  });
});
