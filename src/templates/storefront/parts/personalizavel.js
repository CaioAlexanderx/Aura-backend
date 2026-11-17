// AURA. -- storefront/parts/personalizavel.js
// O produto personalizavel na loja comum (p-180, loja unica 3.2b,
// 17/11/2026). Desenho aprovado pelo Caio no mockup p-132, versao A.
//
// SO ENTRA NA PAGINA DA LOJA COM `tem_personalizavel` (p-179: o servidor
// olha o catalogo inteiro). Nas outras lojas o HTML sai byte a byte igual
// (__tests__/lojaSemPersonalizavel.fixture.test.js): este arquivo nao edita
// card.js nem product_detail.js. Ele troca trechos EXATOS (TROCAS_*) e
// acrescenta as funcoes novas (EXTRA), como promocao.js. Cada trecho tem
// de existir uma vez so; se alguem mudar o cartao ou a pagina do produto
// e o trecho sumir, aplicar() quebra no teste em vez de a loja sair sem
// o selo.
//
// Na tela, so em peca com `personalizavel: true` no payload:
//   - cartao: selo "Personalize" no lugar do NOVO, "a partir de" antes do
//     preco e a linha "Com o seu nome ou a sua arte";
//   - pagina do produto: "a partir de" no preco, o botao "Personalizar" no
//     lugar de "Adicionar a sacola" (sem escolher variacao: quem escolhe
//     e o personalizador) e o bloco "Como funciona".
//
// O botao "Personalizar" ainda nao abre o personalizador (e o p-182, o
// quadro). Por enquanto ele dispara o evento `aura:personalizar` na
// window, cancelavel, com { produto_id, origem, modo }. Quem abrir o
// personalizador chama preventDefault(). Sem ninguem ouvindo, a peca vai
// ao WhatsApp da loja (como a loja comum ja faz sem checkout) ou, sem
// WhatsApp, um aviso.
//
// O banner A da home (bannerHtml) tambem mora aqui: ver o fim do arquivo.
'use strict';

const { textoSobre } = require('../../storefrontContraste');

const EXTRA = `
// ── O produto personalizavel (p-180) ──
var SELO_PERSONALIZE_SVG='<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 0 L7.4 4.6 L12 6 L7.4 7.4 L6 12 L4.6 7.4 L0 6 L4.6 4.6Z" fill="currentColor"/></svg>';
function seloPersonalize(p){
  return (p&&p.personalizavel)?'<span class="pz-selo">'+SELO_PERSONALIZE_SVG+'Personalize</span>':'';
}
function aPartirDe(p){
  return (p&&p.personalizavel)?'<small class="pz-apartir">a partir de</small>':'';
}
function linhaPersonalize(p){
  return (p&&p.personalizavel)?'<div class="pz-linha">Com o seu nome ou a sua arte</div>':'';
}
function comoFuncionaHtml(p){
  if(!p||!p.personalizavel) return '';
  return '<div class="pz-como"><div class="sf-label">Como funciona</div>'
    +'<div class="pz-passo"><i>1</i><span>Você coloca o nome ou a arte e vê a prévia da peça.</span></div>'
    +'<div class="pz-passo"><i>2</i><span>Adiciona à sacola e paga, como em qualquer peça da loja.</span></div>'
    +'<div class="pz-passo"><i>3</i><span>A gente mostra a arte pronta para você aprovar antes de produzir.</span></div>'
    +'</div>';
}
/**
 * Pede o personalizador. Devolve true quando alguem atendeu (o quadro do
 * p-182 chama preventDefault no evento).
 */
function pedirPersonalizador(id,origem,modo){
  var ev;
  try{ ev=new CustomEvent('aura:personalizar',{cancelable:true,detail:{produto_id:id,origem:origem||'',modo:modo||''}}); }
  catch(e){ return false; }
  window.dispatchEvent(ev);
  return ev.defaultPrevented===true;
}
/** O botao "Personalizar" da pagina da peca. */
function personalizarPeca(p,origem){
  if(pedirPersonalizador(p.id,origem||'detalhe','')) return;
  var n=numeroDoWhatsapp(CONTACT.whatsapp);
  if(n){
    window.open('https://wa.me/'+n+'?text='+encodeURIComponent('Oi! Quero personalizar "'+p.name+'"'),'_blank','noopener');
    return;
  }
  showToast('Fale com a loja para personalizar esta peça.');
}
/**
 * Os botoes do banner da home. A peca do banner pode nao estar na pagina 1
 * da grade: sem ela no PROD_MAP, o link segue para a URL propria da peca.
 */
function abrirPersonalizavel(a){
  var id=a.getAttribute('data-produto'), modo=a.getAttribute('data-modo')||'';
  if(pedirPersonalizador(id,'banner',modo)) return false;
  if(PROD_MAP[id]){ showDetail(id); return false; }
  return true;
}
`;

// [trecho exato do card.js, o que entra no lugar]. Aplicado DEPOIS de
// promocao.aplicarNoCartao: os trechos daqui nao sao os que ela troca.
const TROCAS_DO_CARTAO = [
  // O selo "Personalize" no lugar do NOVO (e da etiqueta -N%).
  [
    "+'<div class=\"product-img\"'+tileStyle+'>'+imgH+badgeH+'</div>'",
    "+'<div class=\"product-img\"'+tileStyle+'>'+imgH+(seloPersonalize(p)||badgeH)+'</div>'",
  ],
  // "a partir de" antes do preco (com ou sem o "De" riscado antes).
  [
    "<span class=\"product-price mono\">'+fmt(p.price)+'</span>'",
    "'+aPartirDe(p)+'<span class=\"product-price mono\">'+fmt(p.price)+'</span>'",
  ],
  // A linha "Com o seu nome ou a sua arte", logo abaixo do preco.
  [
    "+priceH+tamH+noCarrinho+'</div></div>';",
    "+priceH+linhaPersonalize(p)+tamH+noCarrinho+'</div></div>';",
  ],
];

// [trecho exato do product_detail.js, o que entra no lugar]. Aplicado
// depois de promocao e campanha: nenhum trecho daqui e trocado por elas.
const TROCAS_DO_DETALHE = [
  // Sem seletor de variacao, aviso de estoque nem trava: no personalizavel
  // quem escolhe e o personalizador, e a peca e feita sob encomenda.
  [
    'var hasVar=!!(p.variants && p.variants.length);',
    'var hasVar=!p.personalizavel&&!!(p.variants && p.variants.length);',
  ],
  // "a partir de" em cima do preco.
  [
    "    return '<div class=\"pd-preco-card\">'\n",
    "    return '<div class=\"pd-preco-card\">'+(p.personalizavel?'<small class=\"pz-apartir pz-apartir-pd\">a partir de</small>':'')\n",
  ],
  // O botao principal vira "Personalizar".
  [
    "+'<button type=\"button\" class=\"pd-comprar\" id=\"pdComprar\">Adicionar à sacola</button>'",
    "+'<button type=\"button\" class=\"pd-comprar\" id=\"pdComprar\">'+(p.personalizavel?'Personalizar':'Adicionar à sacola')+'</button>'",
  ],
  // O clique de "Personalizar" pede o personalizador, nao poe na sacola.
  [
    "el.querySelector('#pdComprar').addEventListener('click',function(){\n    if(bloqueado()) return;",
    "el.querySelector('#pdComprar').addEventListener('click',function(){\n    if(p.personalizavel){ personalizarPeca(p,'detalhe'); return; }\n    if(bloqueado()) return;",
  ],
  // "Como funciona", entre os botoes e a entrega.
  [
    "    +entregaHtml()\n",
    "    +comoFuncionaHtml(p)\n    +entregaHtml()\n",
  ],
];

function trocar(src, trocas, nome) {
  let out = src;
  for (const [de, para] of trocas) {
    const n = out.split(de).length - 1;
    if (n !== 1) {
      throw new Error(`personalizavel: trecho do ${nome} encontrado ${n} vezes (esperado 1): ${de.slice(0, 80)}`);
    }
    out = out.replace(de, () => para);
  }
  return out;
}

/** card.js com o selo e o "a partir de", mais as funcoes novas. */
function aplicarNoCartao(cardSrc) {
  return trocar(cardSrc, TROCAS_DO_CARTAO, 'cartao') + EXTRA;
}

/** product_detail.js com o botao "Personalizar" e o "Como funciona". */
function aplicarNoDetalhe(detalheSrc) {
  return trocar(detalheSrc, TROCAS_DO_DETALHE, 'detalhe');
}

// ── CSS (vai no <head>, so na loja com personalizavel) ──────────
// Cores do tema da loja (--sf-*), que ja trocam no modo escuro. O selo e
// tinta sobre fundo (o maior contraste do tema nos dois modos).
const CSS_DA_PECA = [
  '.pz-selo{position:absolute;top:10px;left:10px;display:inline-flex;align-items:center;gap:5px;background:var(--sf-ink);color:var(--sf-bg);font-size:11px;font-weight:700;line-height:1;padding:5px 10px 5px 8px;border-radius:999px;letter-spacing:.01em;pointer-events:none;z-index:1}',
  '.pz-apartir{font-size:11px;font-weight:500;color:var(--sf-ink-2);margin-right:4px;font-family:inherit;letter-spacing:0}',
  'body.card-style-image-heavy .product-card .pz-apartir{color:inherit;opacity:.85}',
  '.pz-apartir-pd{display:block;font-size:13px;margin:0}',
  '.pz-linha{font-size:12px;color:var(--sf-ink-2);margin-top:2px}',
  '.pz-como{margin-top:16px;border:1px solid var(--sf-border);border-radius:14px;padding:14px 16px;background:var(--sf-bg-card);display:flex;flex-direction:column;gap:9px;font-size:13px;color:var(--sf-ink)}',
  '.pz-passo{display:flex;gap:10px;align-items:flex-start;line-height:1.45}',
  '.pz-passo i{flex-shrink:0;width:22px;height:22px;border-radius:50%;background:var(--sf-brand-wash);color:var(--sf-ink);font-weight:700;font-size:11.5px;line-height:22px;font-style:normal;text-align:center}',
  '@media (max-width:640px){.pz-selo{top:8px;left:8px;padding:4px 8px 4px 7px;font-size:10px}}',
].join('');

// O banner A: fundo na cor da loja, texto preto ou branco pelo contraste
// (o mesmo textoSobre da inicial do logo, tq-56). No celular a peca vem
// primeiro e os botoes ocupam a largura toda (mockup p-132).
function cssDoBanner(primary) {
  const tinta = textoSobre(primary || '#7c3aed');
  const clara = /^#f{3}(f{3})?$/i.test(tinta);
  const linha = clara ? 'rgba(255,255,255,.6)' : 'rgba(0,0,0,.45)';
  return [
    `.pz-banner{--pz-tinta:${tinta};--pz-linha:${linha};}`,
    '.pz-banner-palco{display:grid;grid-template-columns:1fr 1.05fr;min-height:350px;background:var(--sf-brand);color:var(--pz-tinta);overflow:hidden}',
    '.pz-banner-tx{padding:44px 40px;display:flex;flex-direction:column;justify-content:center;gap:14px}',
    '.pz-banner-ey{font-family:\'DM Mono\',\'SF Mono\',monospace;font-size:11px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;opacity:.9}',
    '.pz-banner .pz-banner-tit{font-size:clamp(36px,4.2vw,54px);line-height:1;margin:0;color:var(--pz-tinta);text-wrap:balance}',
    '.pz-banner-texto{margin:0;font-size:15px;line-height:1.55;max-width:430px}',
    '.pz-banner-bt{display:flex;gap:10px;flex-wrap:wrap;margin-top:4px}',
    '.pz-banner-btn{display:inline-block;padding:13px 20px;border-radius:12px;font-size:14px;font-weight:700;text-decoration:none;text-align:center;background:var(--pz-tinta);color:var(--sf-brand);border:1px solid var(--pz-tinta)}',
    '.pz-banner-btn.sec{background:transparent;color:var(--pz-tinta);border-color:var(--pz-linha)}',
    '.pz-banner-btn:focus-visible{outline:2px solid var(--pz-tinta);outline-offset:3px}',
    '.pz-banner-vis{position:relative;display:grid;place-items:center;background:var(--sf-bg-2);min-height:350px;padding:24px}',
    '.pz-banner-vis img{max-width:100%;max-height:320px;width:auto;height:auto;object-fit:contain;border-radius:12px}',
    '.pz-faixa{display:grid;grid-template-columns:repeat(4,1fr);background:var(--sf-bg-card);border-bottom:1px solid var(--sf-border);color:var(--sf-ink)}',
    '.pz-faixa-item{display:flex;align-items:center;gap:10px;padding:14px 18px;border-right:1px solid var(--sf-border);font-size:13px;line-height:1.35}',
    '.pz-faixa-item:last-child{border-right:0}',
    '.pz-faixa-item i{flex-shrink:0;width:30px;height:30px;border-radius:50%;background:var(--sf-brand-wash);color:var(--sf-ink);display:grid;place-items:center;font-style:normal;font-weight:700;font-size:13px}',
    '.pz-faixa-item b{display:block;font-weight:700}',
    '.pz-faixa-item small{color:var(--sf-ink-2);font-size:12px}',
    '@media (max-width:640px){'
      + '.pz-banner-palco{grid-template-columns:1fr;min-height:0}'
      + '.pz-banner-vis{order:-1;min-height:190px;padding:16px}'
      + '.pz-banner-vis img{max-height:170px}'
      + '.pz-banner-tx{padding:20px 18px 22px;gap:10px}'
      + '.pz-banner .pz-banner-tit{font-size:34px}'
      + '.pz-banner-texto{font-size:13.5px}'
      + '.pz-banner-bt{flex-direction:column}'
      + '.pz-banner-btn{display:block;width:100%}'
      + '.pz-faixa{grid-template-columns:1fr 1fr}'
      + '.pz-faixa-item{padding:10px 12px;font-size:12px;border-bottom:1px solid var(--sf-border)}'
      + '.pz-faixa-item:nth-child(2n){border-right:0}'
      + '}',
  ].join('');
}

/** O <style> do <head>: a peca sempre; o banner so quando ele entra. */
function cssDe({ primary, comBanner }) {
  return CSS_DA_PECA + (comBanner ? cssDoBanner(primary) : '');
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * O HTML do banner A, no lugar do hero da home. `banner` e o que o builder
 * montou (services/bannerPersonalizados.js, ja saneado): textos da
 * lojista, a peca com a capa e os itens da faixa de confianca.
 * `urlDaLoja` e o endereco publico da loja: o botao e um link de verdade
 * para a URL propria da peca, e o JS (abrirPersonalizavel) so o intercepta.
 */
function bannerHtml(banner, { urlDaLoja } = {}) {
  if (!banner || !banner.produto || !banner.produto.image_url) return '';
  const p = banner.produto;
  const base = String(urlDaLoja || '').replace(/\/+$/, '');
  const href = base ? `${base}/p/${encodeURIComponent(p.id)}` : '#';
  const link = (rotulo, modo, sec) => `<a class="pz-banner-btn${sec ? ' sec' : ''}" href="${escHtml(href)}" data-produto="${escHtml(p.id)}" data-modo="${modo}" onclick="return abrirPersonalizavel(this)">${escHtml(rotulo)}</a>`;
  const botoes = [
    banner.botao ? link(banner.botao, 'personalizar', false) : '',
    banner.botao_3d ? link(banner.botao_3d, '3d', true) : '',
  ].join('');
  const faixa = (banner.faixa || []).map((f) => `<div class="pz-faixa-item"><i aria-hidden="true">${escHtml(f.icone)}</i><span><b>${escHtml(f.titulo)}</b><small>${escHtml(f.texto)}</small></span></div>`).join('');
  return `
<section class="home-sec pz-banner" id="bannerPersonalizados" aria-label="${escHtml(banner.titulo || 'Personalize')}">
  <div class="pz-banner-palco">
    <div class="pz-banner-tx">
      ${banner.kicker ? `<div class="pz-banner-ey">${escHtml(banner.kicker)}</div>` : ''}
      ${banner.titulo ? `<h2 class="pz-banner-tit serif">${escHtml(banner.titulo)}</h2>` : ''}
      ${banner.texto ? `<p class="pz-banner-texto">${escHtml(banner.texto)}</p>` : ''}
      ${botoes ? `<div class="pz-banner-bt">${botoes}</div>` : ''}
    </div>
    <div class="pz-banner-vis"><img src="${escHtml(p.image_url)}" alt="${escHtml(p.name)}" fetchpriority="high"></div>
  </div>
  ${faixa ? `<div class="pz-faixa">${faixa}</div>` : ''}
</section>`;
}

module.exports = {
  aplicarNoCartao, aplicarNoDetalhe, cssDe, bannerHtml,
  EXTRA, TROCAS_DO_CARTAO, TROCAS_DO_DETALHE,
};
