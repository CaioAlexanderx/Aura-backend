// ============================================================
// AURA. — CSS da home e do cabecalho do redesign (fase 3, 02/09/2026)
//
// Separado de storefrontStyles.js porque e o desenho NOVO — cabecalho com
// mega-menu, hero full-bleed, os quatro blocos da home, selos, bloco do
// WhatsApp e rodape em tres colunas — e porque storefrontStyles.js ja
// tinha 950 linhas. Os tokens (--sf-*) vem de la; aqui so ha consumo.
//
// Escala: desktop 1280 de largura util, 32px de respiro; celular 390 com
// 16px. Alvos de toque >= 44px em toda a navegacao.
// ============================================================
'use strict';

function homeStyles({ fontSerif, fontSans, fontMono }) {
  return `
/* ============================================================
   REDESIGN 09/2026 — cabecalho
   ============================================================ */
/* O atributo hidden vence QUALQUER display: sem isto, .drawer{display:flex}
   e .search-pill .topbar-search-close{display:flex} ignoravam o hidden e a
   gaveta nascia aberta (peguei no primeiro render). */
[hidden]{display:none !important;}
.announcement-bar{background:var(--sf-brand-deep);color:#fff;font-family:${fontMono};font-size:11px;letter-spacing:1.2px;text-transform:uppercase;text-align:center;padding:9px 24px;border:0;}
@media(max-width:600px){.announcement-bar{display:block;font-size:9.5px;letter-spacing:1.1px;padding:8px 16px;}}

.topbar{position:sticky;top:0;z-index:100;background:color-mix(in oklab,var(--sf-bg) 94%,transparent);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-bottom:1px solid var(--sf-border);padding:0 max(20px,calc((100% - 1280px)/2 + 32px));min-height:78px;height:auto;display:flex;flex-wrap:wrap;align-items:center;gap:0 28px;}
.menu-btn{display:none;width:44px;height:44px;align-items:center;justify-content:center;background:none;border:0;cursor:pointer;color:var(--sf-ink);padding:0;margin-left:-8px;}
.topbar-brand{display:flex;align-items:center;gap:10px;text-decoration:none;flex:0 0 auto;min-width:0;}
.topbar-logo:has(img){height:46px;}
/* O nome so aparece quando NAO ha logo: a logo e a identidade. */
.topbar-logo:has(img)+.topbar-brand-text .topbar-name{display:none;}
.topbar-brand-text{gap:4px;}
.topnav{display:flex;align-items:center;gap:4px;flex:1 1 auto;min-width:0;overflow:hidden;}
.topnav-item{appearance:none;background:none;border:0;padding:8px 11px;cursor:pointer;font-family:${fontSans};font-size:13.5px;font-weight:500;letter-spacing:.2px;color:var(--sf-ink);display:inline-flex;align-items:center;gap:5px;white-space:nowrap;border-bottom:2px solid transparent;transition:color var(--sf-motion) var(--sf-ease),border-color var(--sf-motion) var(--sf-ease);}
.topnav-item:hover,.topnav-item.active{color:var(--sf-brand);}
.topnav-item.active{border-bottom-color:var(--sf-brand);font-weight:600;}
.topnav-item:focus-visible{outline:2px solid var(--sf-brand);outline-offset:2px;border-radius:4px;}
.topbar-right{display:flex;align-items:center;gap:10px;flex:0 0 auto;order:3;}
.search-pill{order:2;display:flex;align-items:center;gap:8px;background:var(--sf-bg-card);border:1px solid var(--sf-border);border-radius:999px;padding:0 16px;height:38px;width:200px;color:var(--sf-ink-3);font-size:13px;flex:0 0 auto;transition:border-color var(--sf-motion) var(--sf-ease),width var(--sf-motion) var(--sf-ease);}
.search-pill:focus-within{border-color:var(--sf-brand);width:260px;}
.search-pill .topbar-search-icon{flex-shrink:0;opacity:.7;}
.search-pill input{flex:1;min-width:0;border:0;outline:none;background:transparent;font-family:${fontSans};font-size:13.5px;color:var(--sf-ink);height:100%;}
.search-pill input::placeholder{color:var(--sf-ink-3);}
.search-pill .topbar-search-close{flex-shrink:0;width:22px;height:22px;border-radius:999px;border:0;background:transparent;color:var(--sf-ink-2);font-size:18px;line-height:1;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center;}
.cart-btn{width:42px;height:42px;border:1px solid var(--sf-border);border-radius:999px;background:var(--sf-bg-card);color:var(--sf-ink);display:flex;align-items:center;justify-content:center;cursor:pointer;position:relative;transition:transform var(--sf-motion) var(--sf-ease),box-shadow var(--sf-motion) var(--sf-ease),border-color var(--sf-motion) var(--sf-ease);}
.cart-btn:hover{transform:translateY(var(--sf-lift));box-shadow:var(--sf-shadow-hover);border-color:var(--sf-brand);}
.cart-btn:focus-visible{outline:2px solid var(--sf-brand);outline-offset:2px;}
.cart-badge{position:absolute;top:-4px;right:-4px;background:var(--sf-brand);color:#fff;font-family:${fontMono};font-size:10.5px;width:18px;height:18px;border-radius:999px;display:flex;align-items:center;justify-content:center;}
/* updateCartUI liga .visible quando ha item; sem ela, o contador some. */
.cart-badge{display:none;}
.cart-badge.visible{display:flex;}

/* Mega-menu: uma coluna por categoria de topo, nivel 2 com contagem. */
.mega{position:absolute;left:0;right:0;top:100%;background:var(--sf-bg-card);border-bottom:1px solid var(--sf-border);box-shadow:0 28px 48px rgba(32,26,20,.10);z-index:99;}
.mega-inner{max-width:1280px;margin:0 auto;padding:28px 32px 22px;display:flex;flex-direction:column;gap:20px;}
.mega-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:32px;}
.mega-col{display:flex;flex-direction:column;gap:2px;}
.mega-topo,.mega-item{appearance:none;background:none;border:0;text-align:left;cursor:pointer;color:var(--sf-ink);display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:6px 0;font-family:${fontSans};font-size:13.5px;transition:color var(--sf-motion) var(--sf-ease);}
.mega-topo{font-family:${fontSerif};font-size:20px;font-weight:500;border-bottom:1px solid var(--sf-border);padding-bottom:8px;margin-bottom:6px;justify-content:flex-start;}
.mega-topo:hover,.mega-item:hover{color:var(--sf-brand);}
.mega-num{font-size:11px;color:var(--sf-ink-2);}

/* Gaveta (celular) */
.drawer-overlay{position:fixed;inset:0;background:rgba(32,26,20,.5);z-index:180;}
.drawer{position:fixed;left:0;top:0;bottom:0;width:310px;max-width:86vw;background:var(--sf-bg);box-shadow:24px 0 48px rgba(32,26,20,.18);z-index:190;display:flex;flex-direction:column;overflow-y:auto;}
.drawer-head{display:flex;align-items:center;justify-content:space-between;padding:14px 8px 14px 20px;border-bottom:1px solid var(--sf-border);}
.drawer-tit{font-size:20px;}
.drawer-x{width:44px;height:44px;display:flex;align-items:center;justify-content:center;background:none;border:0;cursor:pointer;color:var(--sf-ink);font-size:26px;line-height:1;}
.drawer-nav{display:flex;flex-direction:column;padding:8px 0 16px;}
.drawer-topo,.drawer-item{appearance:none;background:none;border:0;text-align:left;cursor:pointer;color:var(--sf-ink);display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:44px;padding:0 20px;font-family:${fontSans};font-size:13.5px;}
.drawer-topo{min-height:48px;font-family:${fontSerif};font-size:19px;font-weight:500;}
.drawer-item{padding-left:34px;}
.drawer-novidades{padding-left:20px;font-weight:600;font-size:14.5px;min-height:48px;}
.drawer-sep{border-top:1px solid var(--sf-border);margin:4px 20px;}

/* ============================================================
   REDESIGN 09/2026 — hero full-bleed 3:1
   ============================================================ */
/* A caixa e EXATAMENTE 3:1 — a proporcao do 1920x640 que o painel pede.
   Vinha de clamp(360px,38vw,540px), que dava 2,67:1 a 1440 e 3,56:1 a
   1920: o banner que a lojista fez na medida certa era cortado nas
   laterais num monitor e em cima/embaixo no outro (Finesse, 02/09). Teto
   de 640px: acima de 1920 de largura a arte nao e ampliada alem do
   tamanho em que foi feita. */
.hero{position:relative;width:100%;height:auto;aspect-ratio:3/1;max-height:640px;min-height:280px;overflow:hidden;background:linear-gradient(135deg,color-mix(in oklab,var(--sf-brand) 16%,transparent),var(--sf-brand-wash) 55%,var(--sf-canvas));}
.hero-slide{position:absolute;inset:0;opacity:0;transition:opacity .9s var(--sf-ease);pointer-events:none;}
.hero-slide.active{opacity:1;pointer-events:auto;}
.hero-bg{position:absolute;inset:0;background-image:var(--hero-desk);background-position:center;background-size:cover;background-repeat:no-repeat;}
.hero-slide.com-foto .hero-scrim{position:absolute;inset:0;background:linear-gradient(to right,rgba(32,26,20,.55) 0%,rgba(32,26,20,.18) 52%,transparent 78%);pointer-events:none;}
.hero-inner{position:absolute;inset:0;display:flex;align-items:center;}
.hero-text{max-width:1280px;width:100%;margin:0 auto;padding:0 32px;display:flex;flex-direction:column;align-items:flex-start;gap:16px;}
.hero-text>*{max-width:520px;}
.hero-slide.com-foto .hero-text{color:#fff;}
.hero-slide.sem-foto .hero-text{color:var(--sf-ink);}
.hero-kicker{font-family:${fontMono};font-size:11px;letter-spacing:1.6px;text-transform:uppercase;opacity:.9;}
.hero-headline{font-family:${fontSerif};font-weight:500;font-size:clamp(36px,3.8vw,56px);line-height:1.06;letter-spacing:-.5px;margin:0;color:inherit;}
.hero-slide.com-foto .hero-headline{text-shadow:0 2px 24px rgba(32,26,20,.35);}
.hero-body{font-size:15px;line-height:1.5;margin:0;opacity:.92;}
/* O CTA do hero e a ACAO PRINCIPAL da home: solido, na cor da marca. */
.hero-text .banner-cta{display:inline-flex;align-items:center;gap:8px;background:var(--sf-brand);color:#fff;font-family:${fontSans};font-weight:600;font-size:14px;padding:14px 28px;border-radius:var(--sf-r);border:0;text-decoration:none;margin-top:4px;transition:transform var(--sf-motion) var(--sf-ease),box-shadow var(--sf-motion) var(--sf-ease);}
.hero-text .banner-cta:hover{transform:translateY(var(--sf-lift)) scale(1.015);box-shadow:var(--sf-shadow-hover);color:#fff;}
.hero-text .banner-cta::after{content:none;}
.hero-cta-seta{font-size:15px;line-height:1;}
.hero .banner-dots{position:absolute;left:0;right:0;bottom:18px;display:flex;justify-content:center;gap:6px;z-index:3;}
.hero .banner-dot{width:5px;height:5px;border-radius:999px;border:0;padding:0;cursor:pointer;background:rgba(255,255,255,.55);transition:width .4s var(--sf-ease),background .4s var(--sf-ease);}
.hero .banner-dot.active{width:22px;background:#fff;}
.hero-slide.sem-foto~.banner-dots .banner-dot{background:color-mix(in oklab,var(--sf-ink) 30%,transparent);}
.hero-slide.sem-foto~.banner-dots .banner-dot.active{background:var(--sf-ink);}

/* ============================================================
   REDESIGN 09/2026 — blocos da home
   ============================================================ */
.home-sec{max-width:1280px;margin:0 auto;padding:44px 32px 8px;}
/* Fora do modo home, os blocos E O HERO somem; a grade vira a pagina de
   categoria, que no design comeca nas migalhas. */
body:not(.home) .home-sec{display:none;}
body:not(.home) .hero{display:none;}
/* No modo home, a barra de categorias antiga sai: o cabecalho ja navega. */
body.home .cats-wrap{display:none;}
.home-sec-head{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:22px;}
.home-sec-head>div{display:flex;flex-direction:column;gap:4px;}
.home-sec-tit{font-family:${fontSerif};font-weight:500;font-size:32px;margin:0;letter-spacing:-.3px;line-height:1.1;}
.home-sec-link{font-size:13.5px;font-weight:600;color:var(--sf-brand);text-decoration:none;flex:0 0 auto;white-space:nowrap;}
.home-sec-link:hover{color:var(--sf-brand-deep);}
.home-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:20px 16px;}

/* Compre por categoria: 4:3, pilula com nome e contagem */
.tira-cats-inner{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;}
.tira-cat{appearance:none;border:1px solid var(--sf-border);background:var(--sf-canvas);padding:0;cursor:pointer;text-align:left;font:inherit;position:relative;border-radius:var(--sf-r);overflow:hidden;aspect-ratio:4/3;display:block;transition:transform var(--sf-motion) var(--sf-ease),box-shadow var(--sf-motion) var(--sf-ease);}
.tira-cat:hover,.tira-cat:focus-visible{box-shadow:var(--sf-shadow-hover);}
.tira-cat:focus-visible{outline:2px solid var(--sf-brand);outline-offset:2px;}
.tira-cat-arte{position:absolute;inset:0;overflow:hidden;}
.tira-cat-arte img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .6s var(--sf-ease);}
/* A foto cresce DENTRO da moldura. */
.tira-cat:hover .tira-cat-arte img,.tira-cat:focus-visible .tira-cat-arte img{transform:scale(1.04);}
.tira-cat-pill{position:absolute;left:14px;bottom:12px;background:color-mix(in oklab,var(--sf-bg) 94%,transparent);padding:7px 16px;border-radius:999px;font-size:13px;font-weight:600;color:var(--sf-ink);display:inline-flex;align-items:baseline;gap:6px;pointer-events:none;}
.tira-cat-total{font-size:11px;color:var(--sf-ink-2);}
@media(prefers-reduced-motion:reduce){
  .tira-cat-arte img{transition:none;}
  .tira-cat:hover .tira-cat-arte img,.tira-cat:focus-visible .tira-cat-arte img{transform:none;}
}

/* O cartao: selo, preco com parcela, Pix, tamanhos */
.card-badge{position:absolute;top:10px;left:10px;background:var(--sf-bg-card);border:1px solid var(--sf-border);border-radius:999px;padding:4px 10px;font-family:${fontMono};font-size:10px;letter-spacing:1px;text-transform:uppercase;color:var(--sf-ink);pointer-events:none;}
.product-body{display:flex;flex-direction:column;gap:3px;}
/* O nome no card e sans: a serifa fica pro titulo das secoes. A regra
   antiga (acima) ainda poe a serifa, por isso a fonte e dita aqui. */
.product-name{font-family:${fontSans};font-size:14.5px;font-weight:500;line-height:1.35;color:var(--sf-ink);}
.product-price-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}
.product-price{font-family:${fontMono};font-size:15px;font-weight:500;color:var(--sf-ink);}
.product-parcela{font-size:12px;color:var(--sf-ink-2);}
.product-pix{font-size:12.5px;color:var(--sf-pix);font-weight:600;}
.card-tams{display:flex;flex-wrap:wrap;gap:5px;margin-top:4px;}
.card-tams span{font-size:10.5px;border:1px solid var(--sf-border);border-radius:6px;padding:2px 7px;color:var(--sf-ink-2);}
.product-card:focus-visible{outline:2px solid var(--sf-brand);outline-offset:4px;border-radius:var(--sf-r);}

/* Ultimas unidades: linhas compactas em duas colunas */
.home-linhas{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;}
.home-linha{display:flex;align-items:center;gap:16px;background:var(--sf-bg-card);border:1px solid var(--sf-border);border-radius:var(--sf-r);padding:14px 18px 14px 14px;color:var(--sf-ink);text-decoration:none;transition:transform var(--sf-motion) var(--sf-ease),box-shadow var(--sf-motion) var(--sf-ease);}
.home-linha:hover{transform:translateY(var(--sf-lift));box-shadow:var(--sf-shadow-hover);}
.home-linha:focus-visible{outline:2px solid var(--sf-brand);outline-offset:2px;}
.home-linha-thumb{width:64px;height:84px;flex:0 0 auto;border-radius:10px;overflow:hidden;background:var(--sf-canvas);border:1px solid var(--sf-border);display:flex;align-items:center;justify-content:center;}
.home-linha-thumb img{width:100%;height:100%;object-fit:cover;display:block;}
.home-linha-ini{font-size:30px;}
.home-linha-info{flex:1;display:flex;flex-direction:column;gap:2px;min-width:0;}
.home-linha-nome{font-size:14.5px;font-weight:500;}
.home-linha-tam{font-size:12px;color:var(--sf-ink-2);}
.home-linha-preco{font-size:14px;margin-top:2px;}
.badge-urgencia{flex:0 0 auto;background:var(--sf-urgencia-bg);border:1px solid var(--sf-urgencia-border);color:var(--sf-urgencia-ink);border-radius:999px;padding:5px 12px;font-family:${fontMono};font-size:10px;letter-spacing:1px;white-space:nowrap;}

/* ============================================================
   REDESIGN 09/2026 — selos, WhatsApp, rodape
   ============================================================ */
.service-strip{max-width:1280px;margin:48px auto 0;padding:0 32px;display:grid;grid-template-columns:repeat(4,1fr);gap:16px;border:0;}
.service-strip{position:relative;}
.service-strip::before,.service-strip::after{content:'';position:absolute;left:32px;right:32px;height:1px;background:var(--sf-border);}
.service-strip::before{top:-28px;}
.service-strip::after{bottom:-28px;}
.service-card{display:flex;gap:12px;align-items:flex-start;padding:0;border:0;background:transparent;border-radius:0;}
.service-card-icon{color:var(--sf-brand);flex:0 0 auto;margin-top:2px;width:auto;height:auto;background:transparent;border-radius:0;}
.service-card-title{font-size:13.5px;font-weight:600;color:var(--sf-ink);}
.service-card-body{font-size:12.5px;color:var(--sf-ink-2);margin-top:0;}

.whats-block{max-width:1280px;margin:56px auto 0;padding:0 32px;}
.whats-block-inner{background:var(--sf-brand-wash);border:1px solid var(--sf-border);border-radius:calc(var(--sf-r) + 8px);padding:36px 44px;display:flex;align-items:center;justify-content:space-between;gap:24px;}
.whats-block-tit{font-size:26px;font-weight:500;}
.whats-block-txt{font-size:14px;color:var(--sf-ink-2);margin-top:4px;}
.whatsapp-cta{display:inline-flex;align-items:center;gap:10px;background:var(--sf-pix);color:#fff;font-weight:600;font-size:14px;padding:14px 26px;border-radius:var(--sf-r);border:0;text-decoration:none;font-family:${fontSans};flex:0 0 auto;transition:transform var(--sf-motion) var(--sf-ease),box-shadow var(--sf-motion) var(--sf-ease);}
.whatsapp-cta svg{color:#fff;flex-shrink:0;}
.whatsapp-cta:hover{transform:translateY(var(--sf-lift));box-shadow:var(--sf-shadow-hover);color:#fff;}

.site-footer{background:var(--sf-bg-card);border-top:1px solid var(--sf-border);margin-top:40px;color:var(--sf-ink-2);font-size:13px;line-height:1.6;}
.site-footer-inner{max-width:1280px;margin:0 auto;padding:52px 32px 28px;display:flex;flex-direction:column;gap:36px;}
.site-footer-cols3{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:48px;}
.site-footer-id{display:flex;flex-direction:column;gap:14px;margin:0;}
.site-footer-logo img{display:block;width:220px;height:64px;object-fit:contain;object-position:left;mix-blend-mode:multiply;}
body.sf-dark .site-footer-logo img{mix-blend-mode:normal;}
.site-footer-nome{font-size:28px;color:var(--sf-ink);}
.site-footer-addr{font-size:13px;color:var(--sf-ink-2);max-width:380px;}
/* Redes sociais: a logo herda a tinta do rodape e acende na cor da loja
   no hover. Alvo de 40px — o dedo no celular precisa dele, mesmo com o
   glyph desenhado em 18. */
.footer-redes{display:flex;gap:6px;margin-top:14px;}
.footer-rede{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:10px;color:var(--sf-ink-2);border:1px solid var(--sf-border);background:var(--sf-bg-card);transition:color var(--sf-motion) var(--sf-ease),border-color var(--sf-motion) var(--sf-ease);}
/* Acende na tinta e na borda, e NAO sobe: elevacao e da peca e do botao
   que levam a uma decisao de compra. Tres iconezinhos de 40px pulando no
   rodape seriam movimento sem conteudo. */
.footer-rede:hover{color:var(--sf-brand);border-color:var(--sf-brand);}
.footer-rede:focus-visible{outline:2px solid var(--sf-brand);outline-offset:3px;}
.footer-inst{display:flex;flex-direction:column;gap:14px;padding:0;border:0;margin:0;}
.footer-inst-bloco{display:flex;flex-direction:column;gap:8px;}
.footer-inst-txt{font-family:${fontSans};font-size:13.5px;line-height:1.6;color:var(--sf-ink-2);max-width:52ch;}
.footer-nav{display:flex;flex-direction:column;gap:8px;}
.footer-nav ul{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px;}
.footer-nav a{font-size:13.5px;color:var(--sf-ink);text-decoration:none;}
.footer-nav a:hover{color:var(--sf-brand);}
.site-footer-bottom{border-top:1px solid var(--sf-border);padding-top:20px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;font-size:12.5px;color:var(--sf-ink-2);}
.site-footer-aura{display:inline-flex;align-items:center;gap:14px;flex-wrap:wrap;}
.powered{display:inline-flex;align-items:center;gap:6px;text-decoration:none;color:var(--sf-ink-2);}
.powered .brand{font-family:'Instrument Serif',Georgia,serif;font-size:15px;color:var(--sf-ink);}
.powered .brand-dot{color:#7c3aed;}
.powered .powered-cta{color:var(--sf-brand);font-weight:600;}
/* O selo fica junto da assinatura da Aura (decisao 5, 02/09/2026): e um
   selo da PLATAFORMA sobre a loja, nao um selo que a lojista liga. */
.selo-aura{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--sf-border);border-radius:999px;padding:5px 12px;font-size:12px;font-weight:600;color:var(--sf-ink-2);}
.selo-aura svg{color:var(--sf-pix);}

/* ============================================================
   REDESIGN 09/2026 — pagina de categoria (fase 4)
   ============================================================ */
/* A barra antiga de categorias saiu de cena: o cabecalho navega. O
   elemento fica no DOM (o JS ainda mede e repinta), mas nao aparece. */
.cats-wrap{display:none;}
.products-section{max-width:1280px;margin:0 auto;padding:24px 32px 64px;}
.crumbs{font-size:12.5px;color:var(--sf-ink-3);display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap;}
.crumbs a{color:var(--sf-ink-3);text-decoration:none;}
.crumbs a:hover{color:var(--sf-ink);}
.crumbs [aria-current]{color:var(--sf-ink);font-weight:500;}
.products-header{display:flex;align-items:baseline;justify-content:space-between;gap:18px;margin-bottom:20px;flex-wrap:wrap;}
.products-header-tit{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;}
.products-header h2{font-family:${fontSerif};font-size:40px;font-weight:500;letter-spacing:-.3px;line-height:1.1;margin:0;}
body.home .products-header h2{font-size:32px;}
.products-count{font-size:13px;color:var(--sf-ink-3);}
.products-header-acoes{display:flex;align-items:center;gap:10px;}
.sort-wrap{display:inline-flex;align-items:center;gap:10px;font-size:13px;color:var(--sf-ink-2);}
.sort-lbl{font-family:${fontSans};font-size:13px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--sf-ink-2);}
.sort-wrap select{font-family:${fontSans};font-size:13.5px;padding:9px 14px;border:1px solid var(--sf-border);border-radius:10px;background:var(--sf-bg-card);color:var(--sf-ink);}
.sort-wrap select:hover{border-color:var(--sf-brand);}
/* Subcategorias: chips sob o titulo, na pagina de categoria. */
.cats-sub{position:static;padding:0 0 18px;border:0;background:transparent;display:flex;gap:8px;flex-wrap:wrap;top:auto;}
.cat-sub{font-family:${fontSans};font-size:12.5px;font-weight:600;color:var(--sf-ink-2);background:var(--sf-bg-card);border:1px solid var(--sf-border);border-radius:999px;padding:7px 14px;cursor:pointer;white-space:nowrap;transition:border-color var(--sf-motion) var(--sf-ease),color var(--sf-motion) var(--sf-ease);}
.cat-sub:hover{border-color:var(--sf-brand);color:var(--sf-ink);}
.cat-sub.active{border-color:var(--sf-brand);color:var(--sf-brand);}
.cat-sub::after,.cat-sub:hover::after{content:none;}
.cat-sub .cat-num{opacity:.7;margin-left:6px;}

/* Lateral + grade */
.products-layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:36px;align-items:start;}
body.home .products-layout{grid-template-columns:minmax(0,1fr);}
/* Na home a lateral nao entra: a grade e o catalogo inteiro, e o filtro
   pertence a pagina de categoria (o cabecalho leva pra la). */
body.home .filtros-wrap,body.home .filtro-btn-mobile{display:none !important;}
/* flex-wrap:nowrap e align-items:stretch desfazem a regra antiga (linha
   centralizada, que ainda existe acima): sem isso a lateral saia com os
   grupos centralizados e a folha do celular QUEBRAVA EM DUAS COLUNAS ao
   passar da altura maxima — o botao "Ver resultados" aparecia no canto de
   cima, cortado (QA da Finesse, 02/09). */
.filtros-wrap{position:sticky;top:102px;display:flex;flex-direction:column;flex-wrap:nowrap;align-items:stretch;gap:26px;padding:0;margin:0;}
.filtro-topo{display:none;align-items:center;justify-content:space-between;}
.filtro-topo-tit{font-family:${fontSerif};font-size:20px;}
.filtro-fechar{width:44px;height:44px;background:none;border:0;font-size:26px;line-height:1;color:var(--sf-ink);cursor:pointer;}
.filtro-aplicar{display:none;}
.filtro-grupo{display:flex;flex-direction:column;gap:10px;}
.filtro-ops{display:flex;flex-wrap:wrap;gap:8px;}
.filtro-op{font-family:${fontSans};font-size:12px;font-weight:600;padding:7px 12px;border-radius:8px;border:1px solid var(--sf-border-2);background:var(--sf-bg-card);color:var(--sf-ink-2);cursor:pointer;transition:all 180ms var(--sf-ease);}
.filtro-op:hover{border-color:var(--sf-brand);color:var(--sf-ink);}
.filtro-op.on{background:var(--sf-brand);border-color:var(--sf-brand);color:#fff;}
.filtro-lista{display:flex;flex-direction:column;gap:9px;}
.filtro-linha{display:flex;align-items:center;gap:10px;background:none;border:0;padding:0;cursor:pointer;font-family:${fontSans};font-size:13.5px;color:var(--sf-ink-2);text-align:left;transition:color var(--sf-motion) var(--sf-ease);}
.filtro-linha:hover,.filtro-linha.on{color:var(--sf-ink);}
.filtro-linha.on .filtro-linha-nome{font-weight:600;}
.filtro-linha-nome{flex:1;}
.filtro-linha-n{font-size:11.5px;color:var(--sf-ink-3);}
.filtro-bola{width:16px;height:16px;border-radius:50%;flex:none;box-shadow:inset 0 0 0 1px rgba(0,0,0,.15);}
.filtro-caixa{width:15px;height:15px;border-radius:4px;border:1px solid var(--sf-border-2);background:var(--sf-bg-card);flex:none;position:relative;}
.filtro-linha.on .filtro-caixa{border-color:var(--sf-brand);background:var(--sf-brand);}
.filtro-linha.on .filtro-caixa::after{content:"";position:absolute;left:4px;top:1px;width:5px;height:9px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg);}
.filtro-limpar{align-self:flex-start;font-family:${fontSans};font-size:12.5px;font-weight:600;color:var(--sf-brand);background:none;border:0;border-bottom:1px solid var(--sf-border-2);padding:2px 0;cursor:pointer;}
.filtro-btn-mobile{display:none;}
.filtros-overlay{display:none;}
/* A grade ao lado da lateral: tres colunas. Na home, quatro. */
.products-grid{grid-template-columns:repeat(3,1fr);gap:24px 18px;}
body.home .products-grid{grid-template-columns:repeat(4,1fr);gap:20px 16px;}
/* Paginacao no estilo novo */
.grid-more{margin-top:40px;}
.pg-bar{display:flex;justify-content:center;align-items:center;gap:6px;flex-wrap:wrap;}
.pg-num,.pg-seta{font-family:${fontSans};font-size:13.5px;font-weight:600;color:var(--sf-ink-2);background:var(--sf-bg-card);border:1px solid var(--sf-border);border-radius:10px;min-width:40px;height:40px;padding:0 12px;cursor:pointer;transition:all var(--sf-motion) var(--sf-ease);}
.pg-num:hover:not(.pg-atual),.pg-seta:hover:not(:disabled){border-color:var(--sf-brand);color:var(--sf-ink);}
.pg-num{font-family:${fontMono};}
.pg-atual{color:var(--sf-brand);border-color:var(--sf-brand);border-bottom-color:var(--sf-brand);}
.pg-seta:disabled{opacity:.4;cursor:not-allowed;}
.pg-gap{color:var(--sf-ink-3);padding:0 4px;}
.pg-info{text-align:center;font-family:${fontMono};font-size:12px;color:var(--sf-ink-3);margin-top:12px;}

@media(max-width:900px){
  .products-section{padding:20px 16px 48px;}
  .products-header h2{font-size:28px;}
  body.home .products-header h2{font-size:24px;}
  .products-layout{grid-template-columns:minmax(0,1fr);}
  .products-grid,body.home .products-grid{grid-template-columns:repeat(2,1fr);gap:16px 10px;}
  /* A lateral vira folha: sobe do rodape quando o botao "Filtrar" abre. */
  .filtro-btn-mobile{display:inline-flex;align-items:center;gap:6px;font-family:${fontSans};font-size:13px;font-weight:600;color:var(--sf-ink);background:var(--sf-bg-card);border:1px solid var(--sf-border-2);border-radius:10px;padding:9px 14px;cursor:pointer;}
  .filtro-btn-mobile .filtro-n{color:var(--sf-brand);font-size:11px;}
  .filtros-wrap{position:fixed;left:0;right:0;bottom:0;top:auto;max-height:82vh;overflow-y:auto;background:var(--sf-bg);border-radius:18px 18px 0 0;padding:16px 20px 24px;z-index:190;transform:translateY(100%);transition:transform var(--sf-motion) var(--sf-ease);box-shadow:0 -24px 48px rgba(32,26,20,.18);}
  .filtros-wrap.aberto{transform:translateY(0);}
  .filtro-topo{display:flex;}
  .filtro-aplicar{display:block;width:100%;padding:15px;background:var(--sf-brand);color:#fff;border:0;border-radius:var(--sf-r);font-family:${fontSans};font-size:15px;font-weight:600;cursor:pointer;position:sticky;bottom:0;margin-top:4px;box-shadow:0 -14px 14px var(--sf-bg);}
  .filtros-overlay{position:fixed;inset:0;background:rgba(32,26,20,.5);z-index:180;}
  body:has(.filtros-wrap.aberto) .filtros-overlay{display:block;}
  .pg-num,.pg-seta{min-width:36px;height:36px;padding:0 10px;font-size:12.5px;}
}

/* ============================================================
   REDESIGN 09/2026 — pagina do produto (fase 5)
   ============================================================ */
.pd-topo{position:sticky;top:0;z-index:2;background:color-mix(in oklab,var(--sf-bg) 94%,transparent);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-bottom:1px solid var(--sf-border);padding:0;height:auto;}
.pd-topo-inner{max-width:1280px;margin:0 auto;padding:12px 32px;display:flex;align-items:center;gap:18px;flex-wrap:wrap;}
.pd-voltar{display:inline-flex;align-items:center;gap:8px;font-family:${fontSans};font-size:13.5px;font-weight:600;color:var(--sf-ink-2);background:none;border:0;padding:8px 0;cursor:pointer;}
.pd-voltar:hover{color:var(--sf-brand);}
.pd-crumbs{margin:0;}
.pd-corpo{max-width:1280px;margin:0 auto;padding:24px 32px 8px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:48px;align-items:start;}
/* Galeria: miniaturas em coluna, foto grande 3:4 no canvas */
.pd-col-foto{display:flex;gap:14px;}
.pd-minis{display:flex;flex-direction:column;gap:10px;flex:0 0 76px;margin:0;order:0;}
.pd-mini{width:76px;aspect-ratio:3/4;height:auto;border-radius:10px;overflow:hidden;border:1px solid var(--sf-border);background:var(--sf-canvas);padding:0;cursor:pointer;transition:border-color var(--sf-motion) var(--sf-ease);}
.pd-mini img{width:100%;height:100%;object-fit:contain;padding:0;}
.pd-mini.sel{border:2px solid var(--sf-brand);}
.pd-foto{position:relative;flex:1;min-width:0;aspect-ratio:3/4;max-height:min(78vh,680px);background:var(--sf-canvas);border:1px solid var(--sf-border);border-radius:18px;overflow:hidden;display:flex;align-items:center;justify-content:center;order:1;}
.pd-foto img{width:100%;height:100%;object-fit:contain;padding:0;transition:transform 380ms var(--sf-ease);}
.pd-foto:hover img{transform:scale(1.6);}
.pd-foto-vazia .product-ph-initials{font-size:clamp(64px,10vw,120px);}
.pd-zoom-dica{position:absolute;right:14px;bottom:14px;background:color-mix(in oklab,var(--sf-bg) 94%,transparent);border:1px solid var(--sf-border);border-radius:999px;padding:8px 14px;font-size:12px;font-weight:600;color:var(--sf-ink);display:inline-flex;align-items:center;gap:7px;pointer-events:none;}
.pd-foto:hover .pd-zoom-dica{opacity:0;}
/* Coluna de informacao */
.pd-col-info{display:flex;flex-direction:column;gap:20px;}
.pd-cat{color:var(--sf-brand);margin:0 0 8px;}
.pd-nome{font-family:${fontSerif};font-size:38px;line-height:1.1;font-weight:500;color:var(--sf-ink);margin:0;letter-spacing:-.3px;}
.pd-preco-card{background:var(--sf-bg-card);border:1px solid var(--sf-border);border-radius:16px;padding:20px 22px;display:flex;flex-direction:column;gap:6px;}
.pd-preco-linha{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;}
.pd-preco{font-family:${fontMono};font-size:28px;font-weight:500;color:var(--sf-ink);}
.pd-parcela{font-family:${fontSans};font-size:13.5px;color:var(--sf-ink-2);margin:0;}
.pd-pix{display:inline-flex;align-items:center;gap:8px;color:var(--sf-pix);font-weight:600;font-size:14px;}
.op-grupo{margin:0;display:flex;flex-direction:column;gap:10px;}
.op-label{display:flex;align-items:center;justify-content:space-between;margin:0;}
.op-escolhido{text-transform:none;letter-spacing:0;color:var(--sf-ink);}
.op-pede{font-family:${fontSans};font-size:12.5px;font-weight:600;color:var(--sf-brand);text-transform:none;letter-spacing:0;}
.op-lista{display:flex;flex-wrap:wrap;gap:9px;}
.op-chip{font-family:${fontSans};font-size:13.5px;font-weight:600;min-width:52px;padding:12px 14px;border-radius:10px;border:1px solid var(--sf-border-2);background:var(--sf-bg-card);color:var(--sf-ink-2);cursor:pointer;text-align:center;transition:all 180ms var(--sf-ease);}
.op-chip:hover{border-color:var(--sf-brand);color:var(--sf-ink);}
.op-chip.sel{background:var(--sf-brand);border-color:var(--sf-brand);color:#fff;}
.op-chip.off{color:var(--sf-ink-3);background:var(--sf-canvas);cursor:not-allowed;text-decoration:line-through;opacity:1;}
.pd-aviso{font-size:13px;color:var(--sf-ink-2);margin:0;}
.pd-aviso-ruim{color:#b91c1c;}
.pd-ultimas{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--sf-urgencia-ink);font-weight:600;}
.pd-ultimas-dot{width:7px;height:7px;border-radius:50%;background:#d97706;}
.pd-acoes{display:flex;flex-direction:column;gap:10px;margin:0;}
@media(min-width:520px){.pd-acoes{flex-direction:column;}.pd-acoes button,.pd-acoes a{flex:none;}}
.pd-comprar{font-family:${fontSans};font-size:15px;font-weight:600;background:var(--sf-brand);color:#fff;border:0;border-radius:var(--sf-r);padding:16px;cursor:pointer;transition:transform var(--sf-motion) var(--sf-ease),box-shadow var(--sf-motion) var(--sf-ease);}
.pd-comprar:hover:not(.off){transform:translateY(var(--sf-lift)) scale(1.01);box-shadow:var(--sf-shadow-hover);}
.pd-comprar.feito{background:var(--sf-pix);}
.pd-comprar.off{opacity:.45;cursor:not-allowed;}
.pd-whats{display:inline-flex;align-items:center;justify-content:center;gap:9px;font-family:${fontSans};font-size:14px;font-weight:600;background:var(--sf-bg-card);color:var(--sf-pix);border:1px solid color-mix(in oklab,var(--sf-pix) 35%,transparent);border-radius:var(--sf-r);padding:14px;text-decoration:none;transition:transform var(--sf-motion) var(--sf-ease),box-shadow var(--sf-motion) var(--sf-ease);}
.pd-whats:hover{transform:translateY(var(--sf-lift));box-shadow:var(--sf-shadow-hover);}
.pd-frete{background:var(--sf-bg-card);border:1px solid var(--sf-border);border-radius:16px;padding:18px 20px;display:flex;flex-direction:column;gap:12px;}
.pd-frete-linha{display:flex;gap:10px;}
.pd-frete-linha input{flex:1;min-width:0;font-family:${fontMono};font-size:14px;padding:11px 14px;border:1px solid var(--sf-border-2);border-radius:10px;background:var(--sf-bg);color:var(--sf-ink);outline:none;}
.pd-frete-linha input:focus{border-color:var(--sf-brand);box-shadow:0 0 0 3px color-mix(in oklab,var(--sf-brand) 15%,transparent);}
.pd-frete-btn{font-family:${fontSans};font-size:13.5px;font-weight:600;background:var(--sf-canvas);color:var(--sf-ink);border:1px solid var(--sf-border-2);border-radius:10px;padding:11px 20px;cursor:pointer;}
.pd-frete-res{font-size:13.5px;color:var(--sf-ink-2);display:flex;flex-direction:column;gap:6px;}
.pd-frete-res:empty{display:none;}
.pd-frete-res.erro{color:#b91c1c;}
.pd-frete-op{display:flex;justify-content:space-between;gap:12px;color:var(--sf-ink);}
.pd-frete-gratis{font-family:${fontMono};font-weight:500;color:var(--sf-pix);}
.pd-retirada{display:flex;flex-direction:column;gap:2px;padding:0 4px;}
.pd-retirada-tit{font-size:13.5px;font-weight:600;color:var(--sf-ink);}
.pd-desc{margin:0;padding-top:18px;border-top:1px solid var(--sf-border);display:flex;flex-direction:column;gap:8px;}
.pd-desc p{font-family:${fontSans};font-size:14.5px;line-height:1.65;color:var(--sf-ink-2);margin:0;max-width:62ch;white-space:pre-line;}
.pd-ficha{margin:0;border-top:1px solid var(--sf-border);padding-top:18px;display:grid;grid-template-columns:90px 1fr;gap:6px 16px;font-size:13.5px;}
.pd-ficha-linha{display:contents;}
.pd-ficha-rot{font-family:${fontSans};font-size:13.5px;font-weight:400;letter-spacing:0;text-transform:none;color:var(--sf-ink-3);}
.pd-ficha-val{font-family:${fontSans};font-size:13.5px;line-height:1.55;color:var(--sf-ink);white-space:pre-line;}
.pd-politica{display:flex;gap:10px;align-items:flex-start;background:color-mix(in oklab,var(--sf-brand) 6%,transparent);border-radius:12px;padding:12px 16px;font-size:12.5px;color:var(--sf-ink-2);}
.pd-politica svg{color:var(--sf-brand);flex:0 0 auto;margin-top:1px;}
.pd-relacionados{max-width:1280px;margin:64px auto 0;padding:0 32px 56px;border:0;}
.pd-rel-tit{font-family:${fontSerif};font-size:30px;font-weight:500;color:var(--sf-ink);margin:0 0 22px;}
.pd-rel-grade{display:grid;grid-template-columns:repeat(4,1fr);gap:20px 16px;}
@media(max-width:900px){
  /* A barra tinha altura fixa (60px) e as migalhas quebravam em duas
     linhas: o nome da peca vazava por cima da foto. Agora "Voltar" fica
     numa linha, as migalhas noutra que rola de lado, e o nome da peca
     (que ja e o titulo logo abaixo) sai das migalhas. */
  .pd-topo-inner{padding:10px 16px;flex-wrap:nowrap;flex-direction:column;align-items:flex-start;gap:2px;}
  .pd-crumbs{flex-wrap:nowrap;white-space:nowrap;overflow-x:auto;max-width:100%;scrollbar-width:none;}
  .pd-crumbs::-webkit-scrollbar{display:none;}
  .pd-crumbs [aria-current],.pd-crumbs .crumbs-sep:nth-last-child(2){display:none;}
  .pd-corpo{grid-template-columns:1fr;gap:24px;padding:16px 16px 8px;}
  .pd-col-foto{flex-direction:column;}
  .pd-minis{flex-direction:row;order:1;flex:none;overflow-x:auto;padding-bottom:2px;}
  .pd-mini{flex:0 0 64px;width:64px;}
  .pd-foto{order:0;border-radius:14px;}
  .pd-foto:hover img{transform:none;}
  .pd-zoom-dica{display:none;}
  .pd-nome{font-size:28px;}
  .pd-preco{font-size:24px;}
  .pd-relacionados{margin-top:40px;padding:0 16px 40px;}
  .pd-rel-tit{font-size:24px;}
  .pd-rel-grade{grid-template-columns:repeat(2,1fr);gap:16px 10px;}
}

/* ============================================================
   REDESIGN 09/2026 — sacola e checkout (fase 6)
   ============================================================ */
/* Sacola: o drawer fica (decisao 13), com o desenho novo. */
.cart-overlay{background:rgba(32,26,20,.5);}
.cart-drawer{background:var(--sf-bg);max-width:440px;}
.cart-header{padding:18px 24px 14px;}
.cart-title{font-size:22px;font-weight:500;}
.cart-close{border:0;font-size:24px;color:var(--sf-ink);}
.cart-item{gap:12px;padding:14px 0;}
.cart-item-img{width:64px;height:84px;border-radius:10px;background:var(--sf-canvas);border:1px solid var(--sf-border);}
.cart-item-img img{object-fit:contain;padding:0;}
.cart-item-name{font-family:${fontSans};font-size:13.5px;font-weight:500;letter-spacing:0;}
.cart-item-price{font-size:12px;color:var(--sf-ink-2);}
.cart-footer{background:var(--sf-bg-card);border-top:1px solid var(--sf-border);}
.cart-summary-row{font-family:${fontSans};font-size:13.5px;}
.cart-summary-row span:last-child{font-family:${fontMono};}
.cart-summary-row.total{font-family:${fontSans};font-size:16px;font-weight:600;letter-spacing:0;}
.cart-summary-row.pix{color:var(--sf-pix);}
.cart-vazio{text-align:center;padding:60px 20px;display:flex;flex-direction:column;align-items:center;gap:10px;color:var(--sf-ink-2);}
.cart-vazio-tit{font-family:${fontSerif};font-size:22px;color:var(--sf-ink);}
.qty-btn{background:var(--sf-bg-card);color:var(--sf-ink);border:1px solid var(--sf-border-2);}

/* Checkout: pagina inteira no mesmo documento (decisao 9). */
.checkout-overlay{position:fixed;inset:0;z-index:300;background:var(--sf-bg);display:none;overflow-y:auto;overscroll-behavior:contain;align-items:stretch;justify-content:flex-start;}
.checkout-overlay.open{display:block;}
.checkout-page{min-height:100%;display:flex;flex-direction:column;}
.checkout-topo{background:color-mix(in oklab,var(--sf-bg) 94%,transparent);border-bottom:1px solid var(--sf-border);position:sticky;top:0;z-index:2;}
.checkout-topo-inner{max-width:1180px;margin:0 auto;padding:0 32px;height:72px;display:flex;align-items:center;justify-content:space-between;gap:16px;}
.checkout-voltar-loja{display:inline-flex;align-items:center;gap:10px;color:var(--sf-ink-2);font-size:13.5px;font-weight:500;background:none;border:0;cursor:pointer;font-family:${fontSans};padding:8px 0;}
.checkout-voltar-loja:hover{color:var(--sf-ink);}
.checkout-topo-logo{height:42px;display:flex;align-items:center;}
.checkout-topo-logo img{height:42px;max-width:140px;object-fit:contain;mix-blend-mode:multiply;}
.checkout-topo-logo .serif{font-size:22px;}
.checkout-seguro{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;color:var(--sf-ink-2);}
.checkout-seguro svg{color:var(--sf-pix);}
.checkout-corpo{max-width:1180px;margin:0 auto;padding:36px 32px 72px;width:100%;}
.steps-bar{display:flex;align-items:center;gap:14px;margin-bottom:32px;padding:0;border:0;justify-content:flex-start;}
.step{flex-direction:row;align-items:center;gap:10px;}
.step-dot{width:26px;height:26px;font-family:${fontMono};font-size:12px;font-weight:500;border:1px solid var(--sf-border-2);background:var(--sf-bg-card);color:var(--sf-ink-3);}
.step-dot.active,.step-dot.done{background:var(--sf-brand);border-color:var(--sf-brand);color:#fff;}
.step-label{font-size:13px;font-weight:500;color:var(--sf-ink-3);}
.step-label.active{color:var(--sf-ink);font-weight:600;}
.step-linha{flex:0 0 40px;height:1px;background:var(--sf-border-2);}
.checkout-cols{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:40px;align-items:start;}
.checkout-main{display:flex;flex-direction:column;gap:16px;}
.checkout-card{background:var(--sf-bg-card);border:1px solid var(--sf-border);border-radius:16px;padding:28px;display:flex;flex-direction:column;gap:18px;}
.checkout-head{padding:0;border:0;display:flex;align-items:baseline;gap:12px;}
.checkout-back{display:none;}
.checkout-title{font-family:${fontSerif};font-size:26px;font-weight:500;letter-spacing:0;}
.checkout-subtitle{font-family:${fontMono};font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:var(--sf-ink-3);margin:0;}
.checkout-body{padding:0;overflow:visible;flex:none;}
.field-group{margin-bottom:0;display:flex;flex-direction:column;gap:6px;}
.field-label{font-family:${fontSans};font-size:12.5px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--sf-ink-2);margin:0;}
.field-input{font-family:${fontSans};font-size:14.5px;padding:13px 16px;border:1px solid var(--sf-border-2);border-radius:10px;background:var(--sf-bg);color:var(--sf-ink);}
.field-input:focus{border-color:var(--sf-brand);box-shadow:0 0 0 3px color-mix(in oklab,var(--sf-brand) 15%,transparent);background:var(--sf-bg);}
.field-input.mono,#inp_phone,#inp_cep,#inp_cpf{font-family:${fontMono};font-size:14px;}
.field-row{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;}
.checkout-body .field-group+.field-group,.checkout-body .field-group+.field-row{margin-top:14px;}
.checkout-nota{font-size:12.5px;color:var(--sf-ink-3);}
.nfce-box{margin-top:14px;background:var(--sf-bg);border:1px solid var(--sf-border);border-radius:12px;padding:12px 14px;}
.delivery-opts{gap:10px;margin:0 0 4px;}
.delivery-opt{border:1px solid var(--sf-border-2);border-radius:12px;padding:14px 18px;gap:12px;background:var(--sf-bg-card);}
.delivery-opt.active{border:2px solid var(--sf-brand);background:color-mix(in oklab,var(--sf-brand) 6%,transparent);padding:13px 17px;}
.delivery-opt.pix.active{border-color:var(--sf-pix);background:color-mix(in oklab,var(--sf-pix) 5%,transparent);}
.delivery-opt.pix.active .delivery-opt-radio{border-color:var(--sf-pix);background:var(--sf-pix);}
.delivery-opt-icon{display:none;}
.delivery-opt-name{font-size:14px;font-weight:600;}
.delivery-opt-detail{font-size:12.5px;color:var(--sf-ink-2);}
.delivery-opt-eta{color:var(--sf-ink-2);font-weight:500;}
.delivery-opt-price{font-family:${fontMono};font-size:14px;font-weight:500;}
.delivery-opt-price.gratis,.delivery-opt-price.pix{color:var(--sf-pix);}
.address-form{background:var(--sf-bg);border:1px solid var(--sf-border);border-radius:12px;padding:16px;margin-top:14px;display:flex;flex-direction:column;gap:14px;}
.address-form .field-row{margin:0;}
.shipping-quote-status{margin:0;border-radius:10px;font-size:12.5px;}
.order-summary{display:none;}
.checkout-foot{padding:0;border:0;display:flex;gap:12px;}
.prev-btn{font-family:${fontSans};font-size:14px;font-weight:600;background:var(--sf-bg-card);color:var(--sf-ink-2);border:1px solid var(--sf-border-2);border-radius:var(--sf-r);padding:15px 28px;cursor:pointer;}
.prev-btn:hover{color:var(--sf-ink);border-color:var(--sf-brand);}
.next-btn{flex:1;width:auto;}
.next-btn.green{background:var(--sf-pix);}
.next-btn.green:hover{background:var(--sf-pix);}
.checkout-protegido{display:flex;align-items:center;justify-content:center;gap:8px;font-size:12px;color:var(--sf-ink-3);}
/* Resumo fixo a direita */
.checkout-resumo{background:var(--sf-bg-card);border:1px solid var(--sf-border);border-radius:16px;padding:24px;display:flex;flex-direction:column;gap:16px;position:sticky;top:96px;}
.resumo-cabeca{display:flex;align-items:center;justify-content:space-between;gap:12px;}
.resumo-item{display:flex;gap:12px;align-items:flex-start;}
.resumo-thumb{flex:0 0 64px;height:84px;background:var(--sf-canvas);border:1px solid var(--sf-border);border-radius:10px;overflow:hidden;display:flex;align-items:center;justify-content:center;}
.resumo-thumb img{width:100%;height:100%;object-fit:contain;}
.resumo-info{flex:1;display:flex;flex-direction:column;gap:2px;min-width:0;}
.resumo-nome{font-size:13.5px;font-weight:500;}
.resumo-preco{font-size:13.5px;margin-top:4px;}
.resumo-x{align-self:flex-start;background:none;border:0;color:var(--sf-ink-3);cursor:pointer;font-size:18px;padding:0;line-height:1;}
.resumo-x:hover{color:var(--sf-ink);}
.resumo-totais{border-top:1px solid var(--sf-border);padding-top:14px;display:flex;flex-direction:column;gap:8px;font-size:13.5px;}
.resumo-linha{display:flex;justify-content:space-between;gap:12px;color:var(--sf-ink-2);}
.resumo-gratis{color:var(--sf-pix);}
.resumo-pix{color:var(--sf-pix);}
.resumo-total{font-weight:600;font-size:16px;color:var(--sf-ink);margin-top:4px;}
.resumo-nota{background:color-mix(in oklab,var(--sf-brand) 6%,transparent);border-radius:10px;padding:10px 14px;}
/* Pix e estados do pedido, dentro do cartao */
.pix-box{background:var(--sf-bg);border:1px solid var(--sf-border);border-radius:14px;padding:22px;text-align:center;}
.pix-qr{width:216px;height:216px;border-radius:12px;}
.pix-valor{font-family:${fontMono};font-size:26px;font-weight:500;color:var(--sf-ink);margin:14px 0 4px;}
.pix-key-box{border-radius:10px;}
.pix-copy{color:var(--sf-brand);}
.proof-box{margin-top:14px;background:var(--sf-bg);border:1.5px dashed var(--sf-border-2);border-radius:12px;padding:14px;}
.confirm-title{font-style:normal;font-weight:500;font-size:30px;letter-spacing:-.3px;}
.confirm-icon{font-size:34px;}
.whats-btn{background:var(--sf-pix);border-radius:var(--sf-r);font-family:${fontSans};}
@media(max-width:900px){
  .checkout-topo-inner{padding:0 16px;height:60px;}
  .checkout-voltar-loja span{display:none;}
  .checkout-seguro span{display:none;}
  .checkout-corpo{padding:20px 16px 48px;}
  .steps-bar{gap:8px;margin-bottom:20px;}
  .step-label{display:none;}
  .step-label.active{display:inline;}
  .step-linha{flex-basis:20px;}
  .checkout-cols{grid-template-columns:minmax(0,1fr);gap:16px;}
  .checkout-resumo{position:static;order:-1;padding:18px;}
  .checkout-resumo .resumo-item{display:none;}
  .checkout-resumo.aberto .resumo-item{display:flex;}
  .resumo-toggle{display:inline-flex;align-items:center;gap:6px;background:none;border:0;color:var(--sf-brand);font-family:${fontSans};font-size:12.5px;font-weight:600;cursor:pointer;padding:0;}
  .checkout-card{padding:18px;border-radius:14px;}
  .checkout-title{font-size:22px;}
  .field-row{grid-template-columns:1fr;gap:12px;}
  .checkout-foot{flex-direction:column-reverse;}
}
@media(min-width:901px){.resumo-toggle{display:none;}}

/* ============================================================
   REDESIGN 09/2026 — celular (390)
   ============================================================ */
@media(max-width:900px){
  .home-grid{grid-template-columns:repeat(3,1fr);}
  .tira-cats-inner{grid-template-columns:repeat(2,1fr);}
  .site-footer-cols3{grid-template-columns:1fr 1fr;}
  .mega{display:none;}
  .topnav{display:none;}
  .menu-btn{display:flex;}
}
@media(max-width:600px){
  .topbar{min-height:60px;padding:0 8px;gap:4px;}
  .topbar-brand{flex:1;justify-content:center;}
  .topbar-logo:has(img){height:36px;max-width:118px;}
  .topbar-logo img{max-width:118px;}
  .topbar-brand-text{display:none;}
  .topbar-right{order:2;gap:0;}
  .cart-btn{width:44px;height:44px;border:0;background:transparent;}
  .cart-btn:hover{transform:none;box-shadow:none;}
  .search-pill{order:4;flex:1 0 100%;width:auto;margin:0 8px 12px;height:42px;}
  .search-pill:focus-within{width:auto;}
  .hero{height:340px;}
  /* Banner do celular (image_url_mobile): quadrado, quando a lojista subiu. */
  .hero-bg{background-image:var(--hero-mob,var(--hero-desk));}
  .hero-slide.com-foto .hero-scrim{background:linear-gradient(to top,rgba(32,26,20,.62) 0%,rgba(32,26,20,.18) 55%,transparent 80%);}
  .hero-inner{align-items:flex-end;}
  .hero-text{padding:20px 20px 30px;gap:10px;}
  .hero-headline{font-size:30px;line-height:1.08;letter-spacing:-.4px;}
  .hero-kicker{font-size:10px;letter-spacing:1.5px;}
  .hero-body{font-size:13.5px;}
  .hero-text .banner-cta{font-size:13.5px;padding:13px 24px;}
  .hero .banner-dots{bottom:12px;gap:5px;}
  .hero .banner-dot{width:4px;height:4px;}
  .hero .banner-dot.active{width:18px;}
  .home-sec{padding:28px 16px 4px;}
  .home-sec-head{margin-bottom:14px;gap:12px;}
  .home-sec-tit{font-size:24px;}
  .home-sec-link{font-size:12.5px;padding:8px 0;}
  .home-grid{grid-template-columns:1fr 1fr;gap:16px 10px;}
  .tira-cats-inner{gap:10px;}
  .tira-cat-pill{left:10px;bottom:10px;padding:6px 12px;font-size:12px;}
  .tira-cat-total{font-size:10px;}
  .product-name{font-size:13px;}
  .product-price{font-size:14px;}
  .product-pix{font-size:11.5px;}
  /* No celular o cartao e enxuto: parcela e tamanhos ficam na pagina. */
  .home-sec .product-parcela,.home-sec .card-tams{display:none;}
  .card-badge{top:8px;left:8px;padding:3px 9px;font-size:9px;}
  .home-linhas{grid-template-columns:1fr;gap:10px;}
  .home-linha{gap:12px;padding:10px 14px 10px 10px;}
  .home-linha-thumb{width:54px;height:70px;}
  .home-linha-ini{font-size:26px;}
  .home-linha-nome{font-size:13px;}
  .home-linha-tam{font-size:11px;}
  .home-linha-preco{font-size:13px;}
  .badge-urgencia{padding:4px 10px;font-size:9px;}
  .service-strip{margin:28px auto 0;padding:0 16px;grid-template-columns:1fr 1fr;gap:14px 12px;}
  .service-strip::before,.service-strip::after{left:16px;right:16px;}
  .service-strip::before{top:-20px;}
  .service-strip::after{bottom:-20px;}
  .service-card-title{font-size:12.5px;}
  .service-card-body{font-size:11.5px;}
  .whats-block{margin:40px auto 0;padding:0 16px;}
  .whats-block-inner{flex-direction:column;align-items:stretch;padding:22px 20px;gap:16px;text-align:left;}
  .whats-block-tit{font-size:22px;}
  .whatsapp-cta{justify-content:center;width:100%;}
  .site-footer-inner{padding:36px 16px 24px;gap:24px;}
  .site-footer-cols3{grid-template-columns:1fr;gap:24px;}
  .site-footer-logo img{width:170px;height:50px;}
  .site-footer-bottom{flex-direction:column;align-items:flex-start;gap:12px;}
}
`;
}

module.exports = homeStyles;
