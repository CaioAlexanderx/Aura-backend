// AURA. — CSS da vitrine pública
// buildStyles(primary, heroStyle, coverUrl) → string CSS
function buildStyles(primary, heroStyle, coverUrl) {
  return `*,*::before,*::after{margin:0;padding:0;box-sizing:border-box;}
:root{--primary:${primary};--primary-dark:${primary};--primary-light:rgba(124,58,237,.1);--primary-mid:rgba(124,58,237,.07);--text:#1a1a2e;--text-2:#4a4a6a;--text-3:#888;--bg:#fafafa;--card-bg:#fff;--border:#e8e8f0;--green:#10b981;--green-light:#d1fae5;--shadow-md:0 4px 20px rgba(0,0,0,.10);--shadow-lg:0 12px 40px rgba(0,0,0,.16);--r:14px;--r-sm:10px;}
html{scroll-behavior:smooth;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden;}
.topbar{position:sticky;top:0;z-index:100;background:rgba(255,255,255,.96);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);padding:0 20px;height:60px;display:flex;align-items:center;justify-content:space-between;gap:12px;}
.topbar-brand{display:flex;align-items:center;gap:10px;text-decoration:none;}
.topbar-logo{width:36px;height:36px;border-radius:10px;background:var(--primary);display:flex;align-items:center;justify-content:center;font-size:15px;color:#fff;font-weight:800;flex-shrink:0;overflow:hidden;}
.topbar-logo img{width:100%;height:100%;object-fit:cover;}
.topbar-name{font-size:16px;font-weight:800;color:var(--text);}
.topbar-right{display:flex;align-items:center;gap:10px;}
.search-pill{display:flex;align-items:center;gap:8px;background:var(--bg);border:1.5px solid var(--border);border-radius:24px;padding:7px 14px;font-size:13px;color:var(--text-3);cursor:pointer;transition:border-color .2s;min-width:130px;}
.search-pill:hover{border-color:var(--primary);}
.cart-btn{position:relative;width:42px;height:42px;border-radius:12px;background:var(--primary-mid);border:1.5px solid transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .2s;color:var(--primary);}
.cart-btn:hover{background:var(--primary-light);border-color:var(--primary);}
.cart-badge{position:absolute;top:-4px;right:-4px;background:var(--primary);color:#fff;width:18px;height:18px;border-radius:50%;font-size:10px;font-weight:700;display:none;align-items:center;justify-content:center;border:2px solid #fff;}
.cart-badge.visible{display:flex;}
.hero{position:relative;${heroStyle}color:#fff;padding:48px 20px 40px;text-align:center;overflow:hidden;}
.hero-overlay{position:absolute;inset:0;${coverUrl?'background:linear-gradient(135deg,rgba(0,0,0,.35),rgba(0,0,0,.45));':'background:linear-gradient(135deg,rgba(0,0,0,.08),rgba(0,0,0,.18));'}pointer-events:none;}
.hero-content{position:relative;z-index:1;max-width:520px;margin:0 auto;}
.hero-logo-wrap{width:72px;height:72px;border-radius:18px;background:rgba(255,255,255,.2);border:2px solid rgba(255,255,255,.35);margin:0 auto 16px;display:flex;align-items:center;justify-content:center;font-size:26px;overflow:hidden;backdrop-filter:blur(4px);}
.hero-logo-wrap img{width:100%;height:100%;object-fit:cover;border-radius:16px;}
.hero h1{font-size:28px;font-weight:800;margin-bottom:8px;line-height:1.2;}
.hero p{font-size:14px;opacity:.9;line-height:1.6;max-width:380px;margin:0 auto 20px;}
.hero-pills{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;}
.hero-pill{background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.28);border-radius:20px;padding:5px 14px;font-size:12px;font-weight:600;backdrop-filter:blur(4px);}
.cats-wrap{padding:12px 20px 0;display:flex;gap:8px;overflow-x:auto;scrollbar-width:none;position:sticky;top:60px;z-index:50;background:var(--bg);border-bottom:1px solid var(--border);}
.cats-wrap::-webkit-scrollbar{display:none;}
.cat-chip{white-space:nowrap;padding:7px 16px;border-radius:20px;font-size:12px;font-weight:600;background:#fff;border:1.5px solid var(--border);color:var(--text-2);cursor:pointer;transition:all .18s;flex-shrink:0;margin-bottom:10px;}
.cat-chip:hover{border-color:var(--primary);color:var(--primary);}
.cat-chip.active{background:var(--primary);border-color:var(--primary);color:#fff;}
.search-bar-wrap{padding:10px 20px;display:none;position:sticky;top:60px;z-index:49;background:var(--bg);}
.search-bar-wrap.open{display:block;}
.search-bar{display:flex;align-items:center;gap:10px;background:#fff;border:1.5px solid var(--border);border-radius:12px;padding:10px 14px;}
.search-bar input{flex:1;border:none;outline:none;font-size:14px;color:var(--text);background:transparent;}
.products-section{padding:20px;max-width:960px;margin:0 auto;}
.products-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;}
.products-header h2{font-size:16px;font-weight:700;}
.products-count{font-size:12px;color:var(--text-3);}
.products-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;}
.product-card{background:var(--card-bg);border-radius:var(--r);border:1.5px solid var(--border);overflow:hidden;transition:transform .2s,box-shadow .2s;cursor:pointer;display:flex;flex-direction:column;}
.product-card:hover{transform:translateY(-3px);box-shadow:var(--shadow-md);border-color:var(--primary);}
.product-img{width:100%;aspect-ratio:1;background:var(--primary-light);position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;}
.product-img img{width:100%;height:100%;object-fit:cover;}
.product-body{padding:12px;flex:1;display:flex;flex-direction:column;}
.product-cat{font-size:10px;color:var(--primary);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;}
.product-name{font-size:13px;font-weight:700;color:var(--text);line-height:1.35;margin-bottom:4px;}
.product-desc{font-size:11px;color:var(--text-3);line-height:1.45;margin-bottom:10px;flex:1;}
.product-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;}
.product-price{font-size:16px;font-weight:800;color:var(--text);}
.add-btn{background:var(--primary);color:#fff;border:none;border-radius:var(--r-sm);width:34px;height:34px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .18s;flex-shrink:0;font-size:20px;line-height:1;}
.add-btn:hover{background:var(--primary-dark);transform:scale(1.08);}
.qty-ctrl{display:flex;align-items:center;gap:6px;background:var(--primary-light);border-radius:10px;padding:3px;}
.qty-btn{width:28px;height:28px;border-radius:8px;background:var(--primary);color:#fff;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;}
.qty-num{font-size:13px;font-weight:700;color:var(--primary);min-width:18px;text-align:center;}
.cart-overlay{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.45);opacity:0;pointer-events:none;transition:opacity .25s;}
.cart-overlay.open{opacity:1;pointer-events:all;}
.cart-drawer{position:fixed;top:0;right:0;bottom:0;z-index:201;width:100%;max-width:400px;background:#fff;transform:translateX(100%);transition:transform .3s cubic-bezier(.25,.46,.45,.94);display:flex;flex-direction:column;box-shadow:var(--shadow-lg);}
.cart-drawer.open{transform:translateX(0);}
.cart-header{padding:20px 20px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}
.cart-title{font-size:17px;font-weight:800;}
.cart-close{width:36px;height:36px;border-radius:10px;background:var(--bg);border:1.5px solid var(--border);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text-2);font-size:18px;}
.cart-close:hover{background:var(--primary-light);border-color:var(--primary);color:var(--primary);}
.cart-items{flex:1;overflow-y:auto;padding:16px 20px;}
.cart-item{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--border);}
.cart-item:last-child{border-bottom:none;}
.cart-item-img{width:52px;height:52px;border-radius:10px;background:var(--primary-light);display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;}
.cart-item-img img{width:100%;height:100%;object-fit:cover;}
.cart-item-info{flex:1;}
.cart-item-name{font-size:13px;font-weight:700;margin-bottom:2px;}
.cart-item-price{font-size:12px;color:var(--text-3);}
.cart-item-right{display:flex;flex-direction:column;align-items:flex-end;gap:6px;}
.cart-item-total{font-size:14px;font-weight:800;color:var(--primary);}
.cart-footer{padding:16px 20px 24px;border-top:1px solid var(--border);flex-shrink:0;}
.cart-summary-row{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:var(--text-2);margin-bottom:8px;}
.cart-summary-row.total{font-size:17px;font-weight:800;color:var(--text);margin-bottom:14px;}
.checkout-btn{width:100%;padding:15px;background:var(--primary);color:#fff;border:none;border-radius:var(--r);font-size:15px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;}
.checkout-btn:hover{background:var(--primary-dark);}
.checkout-overlay{position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.5);display:none;align-items:flex-end;justify-content:center;}
.checkout-overlay.open{display:flex;}
@media(min-width:600px){.checkout-overlay{align-items:center;}}
.checkout-sheet{width:100%;max-width:480px;max-height:90vh;background:#fff;border-radius:20px 20px 0 0;overflow:hidden;display:flex;flex-direction:column;animation:slideUp .3s ease;}
@media(min-width:600px){.checkout-sheet{border-radius:20px;}}
@keyframes slideUp{from{transform:translateY(40px);opacity:0;}to{transform:translateY(0);opacity:1;}}
.checkout-head{padding:20px 20px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-shrink:0;}
.checkout-back{width:34px;height:34px;border-radius:10px;border:1.5px solid var(--border);background:var(--bg);display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:18px;color:var(--text-2);}
.checkout-head-info{flex:1;}
.checkout-title{font-size:17px;font-weight:800;}
.checkout-subtitle{font-size:12px;color:var(--text-3);margin-top:1px;}
.steps-bar{padding:14px 20px;display:flex;align-items:center;gap:6px;border-bottom:1px solid var(--border);flex-shrink:0;}
.step{display:flex;flex-direction:column;align-items:center;gap:4px;}
.step-dot{width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;background:var(--border);color:var(--text-3);transition:all .2s;}
.step-dot.done{background:var(--green);color:#fff;}
.step-dot.active{background:var(--primary);color:#fff;box-shadow:0 0 0 4px var(--primary-light);}
.step-label{font-size:10px;font-weight:600;color:var(--text-3);}
.step-label.active{color:var(--primary);}
.checkout-body{flex:1;overflow-y:auto;padding:20px;}
.field-group{margin-bottom:16px;}
.field-label{font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:6px;display:block;}
.field-input{width:100%;padding:11px 14px;border:1.5px solid var(--border);border-radius:var(--r-sm);font-size:14px;color:var(--text);background:var(--bg);outline:none;transition:border-color .18s;}
.field-input:focus{border-color:var(--primary);background:#fff;}
.field-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.delivery-opts{display:flex;flex-direction:column;gap:8px;margin-bottom:16px;}
.delivery-opt{display:flex;align-items:center;gap:12px;padding:14px;border-radius:var(--r);border:1.5px solid var(--border);background:#fff;cursor:pointer;transition:all .18s;}
.delivery-opt.active{border-color:var(--primary);background:var(--primary-light);}
.delivery-opt-radio{width:18px;height:18px;border-radius:50%;border:2px solid var(--border);display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.delivery-opt.active .delivery-opt-radio{border-color:var(--primary);background:var(--primary);}
.delivery-opt.active .delivery-opt-radio::after{content:'';width:6px;height:6px;background:#fff;border-radius:50%;}
.delivery-opt-icon{font-size:22px;flex-shrink:0;}
.delivery-opt-info{flex:1;}
.delivery-opt-name{font-size:13px;font-weight:700;}
.delivery-opt-detail{font-size:11px;color:var(--text-3);margin-top:2px;}
.delivery-opt-price{font-size:13px;font-weight:700;color:var(--primary);flex-shrink:0;}
.pix-box{background:var(--bg);border:1.5px solid var(--border);border-radius:var(--r);padding:20px;text-align:center;}
.pix-qr{width:170px;height:170px;margin:0 auto 16px;background:#fff;border-radius:12px;border:1.5px solid var(--border);display:flex;align-items:center;justify-content:center;overflow:hidden;}
.pix-key-box{background:#fff;border:1.5px solid var(--border);border-radius:var(--r-sm);padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px;}
.pix-key{font-size:11px;font-weight:600;color:var(--text);font-family:monospace;word-break:break-all;text-align:left;}
.pix-copy{font-size:12px;font-weight:700;color:var(--primary);cursor:pointer;white-space:nowrap;flex-shrink:0;}
.pix-timer{display:inline-flex;align-items:center;gap:5px;background:var(--primary-light);color:var(--primary);font-size:12px;font-weight:700;padding:5px 12px;border-radius:20px;margin-top:12px;}
.order-summary{background:var(--bg);border:1.5px solid var(--border);border-radius:var(--r);padding:14px;margin-bottom:16px;}
.summary-row{display:flex;justify-content:space-between;font-size:12px;color:var(--text-2);margin-bottom:6px;}
.summary-row.total{font-size:15px;font-weight:800;color:var(--text);border-top:1px solid var(--border);padding-top:8px;margin-top:4px;}
.checkout-foot{padding:16px 20px 24px;border-top:1px solid var(--border);flex-shrink:0;}
.next-btn{width:100%;padding:15px;background:var(--primary);color:#fff;border:none;border-radius:var(--r);font-size:15px;font-weight:700;cursor:pointer;transition:background .18s;display:flex;align-items:center;justify-content:center;gap:8px;}
.next-btn:hover{background:var(--primary-dark);}
.next-btn:disabled{background:var(--border);color:var(--text-3);cursor:not-allowed;}
.next-btn.green{background:var(--green);}
.next-btn.green:hover{background:#059669;}
.confirm-screen{text-align:center;padding:40px 20px;}
.confirm-icon{width:72px;height:72px;border-radius:50%;background:var(--green-light);display:flex;align-items:center;justify-content:center;font-size:36px;margin:0 auto 20px;animation:popIn .4s ease;}
@keyframes popIn{from{transform:scale(.5);opacity:0;}to{transform:scale(1);opacity:1;}}
.confirm-title{font-size:22px;font-weight:800;margin-bottom:8px;}
.confirm-desc{font-size:13px;color:var(--text-2);line-height:1.6;max-width:300px;margin:0 auto 20px;}
.whats-btn{display:inline-flex;align-items:center;gap:8px;background:#25D366;color:#fff;padding:12px 24px;border-radius:var(--r);font-size:14px;font-weight:700;text-decoration:none;border:none;cursor:pointer;}
.contact-bar{background:#fff;border-top:1px solid var(--border);padding:20px;text-align:center;}
.contact-bar p{font-size:12px;color:var(--text-3);margin-bottom:12px;}
.whatsapp-cta{display:inline-flex;align-items:center;gap:8px;background:#25D366;color:#fff;padding:11px 22px;border-radius:var(--r);font-size:14px;font-weight:700;text-decoration:none;}
.site-footer{background:var(--text);color:rgba(255,255,255,.6);padding:28px 20px;text-align:center;font-size:12px;line-height:1.8;margin-top:40px;}
.site-footer strong{color:rgba(255,255,255,.8);}
.powered{margin-top:8px;font-size:11px;}
.powered a{color:var(--primary);font-weight:700;text-decoration:none;}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(100px);background:var(--text);color:#fff;padding:10px 20px;border-radius:24px;font-size:13px;font-weight:600;z-index:999;transition:transform .3s ease;pointer-events:none;white-space:nowrap;}
.toast.show{transform:translateX(-50%) translateY(0);}
@keyframes pulse{0%,100%{transform:scale(1);}50%{transform:scale(1.2);}}
.pulse{animation:pulse .3s ease;}
@media(max-width:480px){.topbar-name{font-size:14px;}.search-pill span{display:none;}.hero h1{font-size:22px;}.products-grid{grid-template-columns:repeat(2,1fr);gap:10px;}}`;
}
module.exports = buildStyles;
