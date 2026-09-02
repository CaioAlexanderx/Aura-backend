// ============================================================
// A pagina do produto (fase 5 do redesign, 02/09/2026)
//
// Migalhas, galeria com miniaturas em coluna e zoom, cartao de preco com
// parcela e Pix, tamanho esgotado riscado, "Ultimas N no M", "Adicionar
// a sacola" + WhatsApp, frete por CEP e retirada, ficha, politica de
// troca (a MESMA do rodape), e "Da mesma categoria" com os cartoes da
// grade. Tudo com dado que ja existe; nada inventado.
// ============================================================
const fs = require('fs');
const path = require('path');

const buildPage = require('../src/templates/storefrontPage');
const buildStyles = require('../src/templates/storefrontStyles');

const parte = fs.readFileSync(path.join(__dirname, '../src/templates/storefront/parts/product_detail.js'), 'utf8');
const src = parte.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const css = buildStyles('#7a1f3a', null, false, 'classic');

describe('estrutura da pagina do produto', () => {
  test('migalhas + voltar no topo; galeria e informacao em duas colunas; relacionados embaixo', () => {
    const ordem = ["class=\"pd-topo\"", 'id="pdVoltar"', 'class="crumbs pd-crumbs"', 'id="pdGaleria"', 'class="pd-col-info"', 'id="pdPreco"', 'id="pdOpcoes"', 'id="pdAviso"', 'id="pdComprar"', 'id="pdRelacionados"'];
    const idx = ordem.map((s) => src.indexOf(s));
    idx.forEach((i, k) => expect({ k: ordem[k], i }).toEqual({ k: ordem[k], i: expect.any(Number) }));
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
  });
  test('as miniaturas ficam em coluna a esquerda, e a foto grande e 3:4 em contain', () => {
    expect(src).toContain("'<div class=\"pd-minis\">'");
    // A coluna de minis vem ANTES da foto no markup; o CSS ordena.
    expect(src.indexOf("class=\"pd-minis\"")).toBeLessThan(src.indexOf('id="pdFoto"'));
    expect(css).toContain('.pd-foto{position:relative;flex:1;min-width:0;aspect-ratio:3/4;background:var(--sf-canvas)');
    expect(css).toContain('.pd-foto img{width:100%;height:100%;object-fit:contain');
  });
  test('o zoom segue o mouse, e no celular nao existe', () => {
    expect(src).toContain("foto.addEventListener('mousemove'");
    expect(src).toContain('transformOrigin');
    expect(css).toMatch(/@media\(max-width:900px\)\{[\s\S]*\.pd-foto:hover img\{transform:none;\}/);
  });
});

describe('preco, tamanho e urgencia', () => {
  test('cartao de preco: valor em mono, parcela ao lado, Pix em verde so quando ha desconto', () => {
    expect(src).toContain('class="pd-preco-card"');
    expect(src).toContain("<span class=\"pd-preco mono\">'+fmt(v)+'</span>");
    expect(src).toContain("em até '+esc(parc)+' sem juros");
    expect(src).toContain("pixPct>0?'<div class=\"pd-pix\">");
  });
  test('tamanho esgotado fica riscado e desabilitado', () => {
    expect(src).toContain("(ok?'':' disabled')");
    expect(css).toContain('.op-chip.off{color:var(--sf-ink-3);background:var(--sf-canvas);cursor:not-allowed;text-decoration:line-through');
  });
  test('"Ultimas N unidades no tamanho M" quando a variante escolhida esta acabando', () => {
    expect(src).toContain('var LIMITE_DE_ULTIMAS=3;');
    expect(src).toContain("variante.stock_qty<=LIMITE_DE_ULTIMAS");
    expect(src).toContain("' no tamanho '+esc(tam)");
    expect(src).toContain("'Última unidade'");
  });
  test('o rotulo diz o que ja foi escolhido — e cor em hex vira o NOME da cor', () => {
    // "Cor — #92400E" nao diz nada a cliente (Caio, 02/09, Finesse no ar).
    expect(src).toContain("' — <span class=\"op-escolhido\">'+esc(escolhidoRotulo)+'</span>'");
    expect(src).toContain('escolhidoRotulo=nomeDaCor(escolhido)||escolhido;');
  });
});

describe('acoes', () => {
  test('"Adicionar a sacola" e a acao principal; o WhatsApp leva o nome da peca', () => {
    expect(src).toContain('class="pd-comprar" id="pdComprar">Adicionar à sacola<');
    expect(src).toContain("https://wa.me/'+whatsNum+'?text='+encodeURIComponent('Oi! Tenho uma dúvida sobre \"'+p.name+'\"')");
    expect(src).not.toContain('Comprar agora');
    expect(src).not.toContain('id="pdAdd"');
  });
  test('sem numero de WhatsApp, sem botao', () => {
    expect(src).toContain("var whatsHtml=whatsNum\n    ?");
  });
});

describe('frete e retirada', () => {
  test('frete por CEP so quando a loja entrega, pela MESMA rota do checkout', () => {
    expect(src).toContain('if(SETTINGS.delivery_enabled){');
    expect(src).toContain("/shipping-quote?cep='+cep+'&subtotal='");
  });
  test('gratis quando a cota diz gratis; erro do servidor vira texto, nao excecao', () => {
    expect(src).toContain("(q.fee===0||q.free_shipping)?'<span class=\"pd-frete-gratis\">Grátis</span>'");
    expect(src).toContain("res.textContent=x.d.error||'Não consegui calcular o frete.'");
  });
  test('retirada mostra o endereco e o prazo cadastrados, so se a retirada esta ligada', () => {
    expect(src).toContain("if(SETTINGS.pickup_enabled!==false&&(CONTACT.pickup_address||CONTACT.address)){");
    expect(src).toContain('SETTINGS.pickup_eta_text');
  });
});

describe('ficha, politica e relacionados', () => {
  test('a politica de troca e a MESMA do rodape (rodape_institucional), e chega a pagina', () => {
    expect(src).toContain('var r=__S.rodape_institucional||{};');
    const html = buildPage({
      site: { name: 'F', banners: [] }, contact: {}, settings: {}, products: [], categories: [],
      rodape_institucional: { formas: ['Pix'], politica: 'Texto da politica' },
    }, 'f');
    expect(html).toContain('"rodape_institucional":{"formas":["Pix"],"politica":"Texto da politica"}');
  });
  test('a ficha so tem as linhas preenchidas (migration 305)', () => {
    expect(src).toContain("].filter(function(l){ return l[1] && String(l[1]).trim(); });");
  });
  test('"Da mesma categoria" usa a rota da grade e o cartao da grade — titulo honesto (decisao 15)', () => {
    expect(src).toContain('Da mesma categoria');
    expect(src).not.toContain('Quem viu também levou');
    expect(src).toContain("grade.innerHTML=lista.map(function(x){ return cardHtml(x); }).join('');");
    expect(src).toContain("/catalogo?limit=12&cat='+encodeURIComponent(cat)");
  });
  test('relacionados usam o CAMINHO da categoria quando ha arvore', () => {
    expect(src).toContain('var cat=p.category_path||p.category;');
  });
});
