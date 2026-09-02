// ============================================================
// Sacola e checkout (fase 6 do redesign, 02/09/2026)
//
// Tres coisas se travam aqui:
//   1. a sacola sobrevive a aba (localStorage por loja, 7 dias);
//   2. o checkout e uma VISTA de pagina inteira no mesmo documento —
//      nao uma rota — com o resumo fixo a direita;
//   3. o desconto do Pix que a loja anuncia (309) e APLICADO no pedido,
//      no servidor, e gravado (316). Anunciar desconto que o pedido nao
//      da e pior que nao anunciar.
// ============================================================
const fs = require('fs');
const path = require('path');

const buildPage = require('../src/templates/storefrontPage');
const parts = (n) => fs.readFileSync(path.join(__dirname, '../src/templates/storefront/parts/', n), 'utf8');
const semComentarios = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const rota = semComentarios(fs.readFileSync(path.join(__dirname, '../src/routes/storefront.js'), 'utf8'));
const migracao = fs.readFileSync(path.join(__dirname, '../migrations/316_digital_orders_desconto.sql'), 'utf8');

function pagina() {
  return buildPage({
    site: { name: 'Finesse', primary_color: '#7a1f3a', logo_url: 'https://x/logo.jpg', banners: [] },
    contact: {}, settings: {}, products: [], categories: [], pix_discount_pct: 5,
  }, 'finesse');
}

describe('a sacola sobrevive', () => {
  const src = semComentarios(parts('sacola.js'));
  test('grava por loja e vale 7 dias', () => {
    expect(src).toContain("var CHAVE_DA_SACOLA='aura_sacola_'+SLUG;");
    expect(src).toContain('var VALIDADE_DA_SACOLA=7*24*60*60*1000;');
  });
  test('carrega no boot, antes de desenhar a sacola', () => {
    const boot = parts('bootstrap.js');
    expect(boot.indexOf('carregarSacola();')).toBeGreaterThan(0);
    expect(boot.indexOf('carregarSacola();')).toBeLessThan(boot.indexOf('updateCartUI();'));
  });
  test('toda mudanca na sacola grava', () => {
    expect(semComentarios(parts('cart.js'))).toContain("if(typeof salvarSacola==='function') salvarSacola();");
  });
  test('item sem preco ou sem quantidade nao volta', () => {
    expect(src).toContain('if(!i||!i.key||!i.product_id||!(i.qty>0)||i.price==null) return;');
  });
});

describe('o checkout e uma pagina, no mesmo documento', () => {
  const html = pagina();
  test('topo com "Continuar comprando", logo e "Compra segura"; stepper; duas colunas; resumo fixo', () => {
    const ordem = ['class="checkout-page"', 'class="checkout-voltar-loja"', 'class="checkout-topo-logo"', 'Compra segura', 'class="steps-bar"', 'class="checkout-cols"', 'id="checkoutBody"', 'id="prevBtn"', 'id="nextBtn"', 'id="checkoutResumo"'];
    const idx = ordem.map((s) => html.indexOf(s));
    idx.forEach((i, k) => expect({ k: ordem[k], i }).toEqual({ k: ordem[k], i: expect.any(Number) }));
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
  });
  test('os ids que o JS ja usava continuam', () => {
    for (const id of ['checkoutOverlay', 'checkoutTitle', 'checkoutSub', 'dot1', 'dot2', 'dot3', 'lbl1', 'lbl2', 'lbl3', 'checkoutBody', 'nextBtn']) {
      expect(html).toContain('id="' + id + '"');
    }
  });
  test('nao ha rota nova: abrir o checkout e mostrar a vista', () => {
    const src = semComentarios(parts('checkout.js'));
    expect(src).toContain("document.getElementById('checkoutOverlay').classList.add('open');");
    expect(rota).not.toContain("router.get('/:slug/checkout'");
  });
  test('o resumo e redesenhado a cada passo e a cada escolha de pagamento', () => {
    const co = semComentarios(parts('checkout.js'));
    expect(co).toContain("if(typeof renderResumoDoCheckout==='function') renderResumoDoCheckout();");
    expect(semComentarios(parts('pix.js'))).toContain("if(typeof renderResumoDoCheckout==='function') renderResumoDoCheckout();");
  });
  test('as opcoes de entrega e pagamento sao cartoes de radio, sem emoji', () => {
    const co = semComentarios(parts('checkout.js'));
    expect(co).toContain('id="opt_pickup" role="radio"');
    expect(co).toContain('id="opt_pix_method" role="button"');
    expect(co).not.toContain('🏪');
    expect(co).not.toContain('🚚');
    expect(co).not.toContain('💵');
  });
  test('a sacola mostra o total no Pix quando ha desconto', () => {
    expect(html).toContain('id="cartPixRow"');
    expect(semComentarios(parts('cart.js'))).toContain("v.textContent=fmt(sub-desc+fee)+' no Pix'");
  });
});

describe('o desconto do Pix e aplicado no pedido, no servidor', () => {
  test('a migration 316 grava o desconto', () => {
    expect(migracao).toContain('ADD COLUMN IF NOT EXISTS discount_amount');
    expect(migracao).toContain('ADD COLUMN IF NOT EXISTS discount_reason');
  });
  test('so no Pix, so com percentual, e nunca sobre o frete', () => {
    expect(rota).toContain("const discount_amount = (pmethod === 'pix' && pixPct > 0)");
    expect(rota).toContain('Math.round(subtotal * pixPct) / 100');
    expect(rota).toContain('const total = subtotal - discount_amount + delivery_fee;');
  });
  test('o percentual e o da LOJA (config), nao do cliente', () => {
    expect(rota).toContain('const pixPct = Number(config.pix_discount_pct) || 0;');
    expect(rota).not.toContain('req.body.pix_discount');
  });
  test('base sem a migration nao derruba o pedido (42703 -> insert sem as colunas)', () => {
    expect(rota).toContain("if (e.code !== '42703') throw e;");
    expect(rota).toContain('insertPedido(false)');
  });
  test('a cliente ve a mesma conta: percentual da loja sobre o subtotal', () => {
    const src = semComentarios(parts('sacola.js'));
    expect(src).toContain('function descontoPix(sub){ var p=pctDoPix(); return p>0?Math.round(sub*p)/100:0; }');
  });
});
