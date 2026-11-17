// AURA. -- storefront/parts/quadro.js
// A ponte da loja comum com o personalizador do app (p-182, loja unica
// 3.3b, 17/11/2026). Desenho: mockup p-132, versao A (personalizador em
// quadro no desktop, tela cheia no celular, sacola mista).
//
// SO ENTRA NA LOJA COM `tem_personalizavel` (p-179). Nas outras o HTML sai
// byte a byte igual (__tests__/lojaSemPersonalizavel.fixture.test.js): este
// arquivo nao edita sacola.js nem cart.js. Ele troca trechos EXATOS (como
// promocao.js e personalizavel.js) e acrescenta a ponte (PONTE).
//
// Como funciona:
//   1. O botao "Personalizar" (p-180, parts/personalizavel.js) dispara o
//      evento cancelavel `aura:personalizar` na window. A ponte ouve,
//      chama preventDefault() e abre o quadro.
//   2. O quadro e um iframe com a casca do app servida pelo PROPRIO host
//      da loja (`/<slug>/personalizar/<id>`, routes/storefront.js): mesma
//      origem, `frame-src 'self'` na CSP, e dominio proprio funciona.
//   3. Mensagens (contrato do app, components/studio/storefront/quadro/
//      mensagensDoQuadro.ts, p-181). Toda mensagem que chega e conferida:
//      `event.origin === location.origin`, `event.source` e a janela do
//      quadro aberto e o envelope `{fonte:"aura:personalizador", versao:1}`.
//      O resto e ignorado em silencio. O que sai vai com targetOrigin =
//      location.origin, nunca "*".
//        pronto     -> mostra o quadro (e manda o `editar`, se for edicao)
//        confirmou  -> guarda o item na sacola da loja, com a miniatura e
//                      o resumo, e abre a sacola
//        cancelou   -> fecha
//        erro       -> oferece o WhatsApp da loja
//   4. "Editar" na sacola reabre o quadro e manda `editar` com a
//      `customization` e a quantidade do item; o `confirmou` com
//      `editando: true` troca o item no lugar.
//
// O preco do item e o que o quadro mostrou (preco.unitario, sem a arte, e
// preco.total, a linha inteira com a arte): so para a sacola. O pedido
// recota no servidor (p-184).
//
// p-183 (loja unica 3.3c, 17/11/2026): o checkout leva o personalizado.
//   - A linha vale `subtotal` (a arte e cobrada uma vez por linha, entao
//     price x qty nao fecha): totalDaLinha() em todo lugar que soma.
//   - A conferencia do preco de agora (p-124) manda o personalizado com o
//     `customization` (POST /sacola/precos, contrato do p-184) e acerta
//     `price` e `subtotal` pela resposta. O pedido criado acerta igual.
//   - Peca personalizavel na sacola SEM a escolha (sacola guardada antes
//     de a loja ter o personalizador; o servidor responde motivo
//     'personalizacao') ou com a escolha que nao passa mais (a lojista
//     mudou os campos) fica `pendente`: a linha pede "Personalizar" e o
//     pedido nao sai ate a cliente escolher. Era o 400 que a sacola antiga
//     recebia (risco deixado pelo p-182).
//   - O resumo do checkout e o pedido: parts/pedido_personalizado.js.
'use strict';

const PONTE = `
// ── O personalizador no quadro (p-182) ──
var QUADRO=null;
var ESPERA_DO_QUADRO=25000;
var FONTE_DO_QUADRO='aura:personalizador', FONTE_DA_LOJA='aura:loja', VERSAO_DO_QUADRO=1;
var ID_DA_PECA_PZ=/^[0-9a-fA-F-]{8,64}$/;

function escAtributoPz(s){ return esc(String(s==null?'':s)).replace(/"/g,'&quot;'); }

/** O caminho do quadro no host por onde a loja foi aberta. */
function caminhoDoQuadro(id){
  var p=String(location.pathname||'/').toLowerCase(), s=String(SLUG).toLowerCase(), base='';
  if(p.indexOf('/api/v1/storefront/'+s+'/')===0) base='/api/v1/storefront/'+s;
  else if(p==='/'+s||p.indexOf('/'+s+'/')===0) base='/'+s;
  return base+'/personalizar/'+encodeURIComponent(id);
}
/** O endereco do quadro, com a origem e o tema da loja (p-181). */
function enderecoDoQuadro(id){
  return caminhoDoQuadro(id)
    +'?origem='+encodeURIComponent(location.origin)
    +'&cor='+encodeURIComponent(SITE.primary_color||'')
    +'&modo='+(SITE.dark_mode?'escuro':'claro')
    +'&fonte='+encodeURIComponent(SITE.font_family||'');
}

/** A mensagem, se veio do quadro aberto e no formato do contrato; senao null. */
function lerMensagemDoQuadro(ev,janela){
  if(!ev||!janela||ev.source!==janela||ev.origin!==location.origin) return null;
  var d=ev.data;
  if(!d||typeof d!=='object'||d.fonte!==FONTE_DO_QUADRO||d.versao!==VERSAO_DO_QUADRO) return null;
  if(d.tipo!=='pronto'&&d.tipo!=='confirmou'&&d.tipo!=='cancelou'&&d.tipo!=='erro') return null;
  return d;
}

/** So data:image/ ou https:, sem nada que saia do atributo. */
function miniaturaSegura(m){
  if(typeof m!=='string'||/["'<>\\s]/.test(m)) return null;
  if(m.indexOf('data:image/')===0) return m.length<=600000?m:null;
  if(m.indexOf('https://')===0) return m.length<=2000?m:null;
  return null;
}
function resumoSeguro(r){
  return (Array.isArray(r)?r:[]).filter(function(x){ return typeof x==='string'&&x.trim(); })
    .slice(0,12).map(function(x){ x=x.trim(); return x.length>140?x.slice(0,140):x; });
}
function customizationSegura(c){
  if(!c||typeof c!=='object'||Array.isArray(c)) return null;
  try{ if(JSON.stringify(c).length>1000000) return null; }catch(_){ return null; }
  return c;
}

/** A linha inteira do personalizado (com a arte), ou o reserva. */
function subtotalValido(v,reserva){
  var n=(v==null||v==='')?NaN:Number(v);
  return (isFinite(n)&&n>=0)?Math.round(n*100)/100:reserva;
}
/** O que a linha da sacola soma. O personalizado vale o subtotal (p-183). */
function totalDaLinha(i){
  if(i&&i.personalizado&&i.subtotal!=null&&isFinite(Number(i.subtotal))) return Number(i.subtotal);
  return i.price*i.qty;
}
/** A peca vai pelo personalizador e ainda nao tem a escolha que vale. */
function linhaPendente(i){ return !!(i&&i.pendente); }
var REV_DO_PZ=0;

/** O item da sacola a partir do confirmou, ou null se ele nao fecha. */
function itemDoConfirmado(d,produtoId){
  if(!d||d.produto_id!==produtoId) return null;
  var c=customizationSegura(d.customization); if(!c) return null;
  var q=Math.floor(Number(d.quantidade)); if(!(q>=1)) return null;
  var preco=d.preco||{}, unit=Number(preco.unitario);
  if(!isFinite(unit)||unit<0) return null;
  var p=PROD_MAP[produtoId];
  var nome=(typeof d.nome==='string'&&d.nome.trim())?d.nome.trim().slice(0,160):(p?p.name:'Peça personalizada');
  return { product_id:produtoId, variant_id:null, name:nome, price:Math.round(unit*100)/100,
    subtotal:subtotalValido(preco.total,Math.round(unit*q*100)/100),
    image_url:miniaturaSegura(d.miniatura)||(p?miniaturaSegura(p.thumb_url||p.image_url):null),
    qty:Math.min(q,9999), personalizado:true, customization:c, resumo:resumoSeguro(d.resumo),
    preco_fonte:preco.fonte==='servidor'?'servidor':'estimativa' };
}

/** Cada personalizado e uma linha propria da sacola, mesmo da mesma peca. */
function novaChavePz(produtoId){ return 'pz-'+produtoId+'-'+Date.now().toString(36)+Math.random().toString(36).slice(2,6); }

/** Guarda o item; com 'chave' de um personalizado, troca no lugar (Editar). */
function guardarPersonalizado(item,chave){
  if(chave&&cart[chave]&&cart[chave].personalizado){ item.key=chave; }
  else { item.key=novaChavePz(item.product_id); }
  // A assinatura da conferencia de preco (p-124) muda com a escolha nova.
  item.rev=++REV_DO_PZ;
  if(typeof erroDaPersonalizacao!=='undefined') erroDaPersonalizacao='';
  cart[item.key]=item;
  updateCartUI();
  if(typeof renderProducts==='function') renderProducts();
  var b=document.getElementById('cartBadge');
  if(b){ b.classList.add('pulse'); setTimeout(function(){ b.classList.remove('pulse'); },300); }
  return item.key;
}

/** A sacola guardada no navegador: o personalizado volta com o que escolheu. */
function itemPersonalizadoDaSacola(item,salvo){
  var c=customizationSegura(salvo&&salvo.customization);
  if(!c||!/^pz-/.test(String(salvo.key))||!ID_DA_PECA_PZ.test(String(salvo.product_id))) return false;
  item.personalizado=true; item.customization=c; item.variant_id=null;
  item.resumo=resumoSeguro(salvo.resumo);
  item.image_url=miniaturaSegura(salvo.image_url);
  item.preco_fonte=salvo.preco_fonte==='servidor'?'servidor':'estimativa';
  item.subtotal=subtotalValido(salvo.subtotal,Math.round(item.price*item.qty*100)/100);
  if(typeof salvo.name==='string'&&salvo.name.trim()) item.name=salvo.name.trim().slice(0,160);
  return true;
}

/**
 * O item como o servidor le (POST /order e POST /sacola/precos, p-184): o
 * personalizado vai com o customization e sem variante; o resto, como
 * sempre. A linha pendente sem escolha vai como peca comum e volta com o
 * motivo 'personalizacao'.
 */
function itemParaOServidor(i){
  if(i.personalizado&&i.customization) return { product_id:i.product_id, quantity:i.qty, customization:i.customization };
  return { product_id:i.product_id, variant_id:i.variant_id||null, quantity:i.qty };
}

/**
 * A resposta do servidor para uma linha (conferencia ou pedido criado).
 * null = nao e assunto do personalizado (segue a regra de sempre).
 * 'mudou' / 'igual' = tratada aqui. Subiu: entra em subiram pela linha.
 */
function tratarLinhaPersonalizada(i,r,subiram){
  var recusou=r.disponivel===false&&r.motivo==='personalizacao';
  if(!i.personalizado){
    if(!recusou) return null;
    if(i.pendente) return 'igual';
    i.pendente=true; return 'mudou';
  }
  if(recusou){ if(i.pendente) return 'igual'; i.pendente=true; return 'mudou'; }
  if(r.preco==null||r.subtotal==null) return 'igual';
  var preco=Number(r.preco), sub=Number(r.subtotal);
  if(!isFinite(preco)||preco<0||!isFinite(sub)||sub<0) return 'igual';
  var antes=totalDaLinha(i), era=i.pendente;
  i.pendente=false;
  if(centavosDe(sub)===centavosDe(antes)&&centavosDe(preco)===centavosDe(i.price)) return era?'mudou':'igual';
  if(centavosDe(sub)>centavosDe(antes)) subiram.push({ nome:i.name, de:antes, para:sub });
  i.price=centavosDe(preco)/100; i.subtotal=centavosDe(sub)/100;
  return 'mudou';
}

/** A linha do personalizado na sacola: miniatura, resumo, Editar e Remover. */
function htmlDoItemPersonalizado(i){
  var img=i.image_url?'<img src="'+escAtributoPz(i.image_url)+'" alt="">':'<span class="product-ph-initials" style="font-size:22px;">'+esc(INICIAIS(i.name))+'</span>';
  var un=i.qty===1?'1 unidade':i.qty+' unidades';
  return '<div class="cart-item pzq-item'+(linhaPendente(i)?' pzq-pendente':'')+'"><div class="cart-item-img">'+img+'</div>'
    +'<div class="cart-item-info"><div class="cart-item-name">'+esc(i.name)+' <span class="pzq-pill">Personalizada</span></div>'
    +'<div class="pzq-resumo">'+textoDoResumoPz(i)+un+'</div>'
    +acoesDoPz(i)+'</div>'
    +'<div class="cart-item-right"><div class="cart-item-total">'+fmt(totalDaLinha(i))+'</div></div></div>';
}
/** O que a cliente escolheu, ou o que falta (linha pendente). Com <br> no fim. */
function textoDoResumoPz(i){
  if(linhaPendente(i)){
    return '<span class="pzq-falta">'+(i.personalizado
      ?'Revise a personalização desta peça antes de finalizar.'
      :'Falta escolher a personalização desta peça.')+'</span><br>';
  }
  var resumo=(i.resumo||[]).map(function(r){ return esc(r); }).join(' · ');
  return resumo?resumo+'<br>':'';
}
/** "Editar" (ou "Personalizar", sem a escolha) e "Remover". */
function acoesDoPz(i){
  var rotulo=(linhaPendente(i)&&!i.personalizado)?'Personalizar':'Editar';
  return '<div class="pzq-acoes"><button type="button" data-pzq-editar="'+escAtributoPz(i.key)+'">'+rotulo+'</button>'
    +'<button type="button" data-pzq-remover="'+escAtributoPz(i.key)+'">Remover</button></div>';
}
function avisoDoPersonalizado(){
  var tem=Object.values(cart).some(function(i){ return i.personalizado||linhaPendente(i); });
  return tem?'<p class="pzq-aviso">Peças personalizadas são feitas sob encomenda. Depois do pagamento, a gente mostra a arte para você aprovar, e só então produz.</p>':'';
}

function enviarAoQuadro(m){
  if(!QUADRO||!QUADRO.iframe.contentWindow) return;
  var env={ fonte:FONTE_DA_LOJA, versao:VERSAO_DO_QUADRO };
  for(var k in m){ if(Object.prototype.hasOwnProperty.call(m,k)) env[k]=m[k]; }
  QUADRO.iframe.contentWindow.postMessage(env,location.origin);
}

/** Abre o quadro da peca. 'chave' = o item da sacola que esta sendo editado. */
function abrirQuadro(produtoId,chave){
  if(!ID_DA_PECA_PZ.test(String(produtoId||''))) return false;
  fecharQuadro(true);
  var p=PROD_MAP[produtoId];
  var veu=document.createElement('div');
  veu.className='pzq-veu';
  veu.setAttribute('role','dialog');
  veu.setAttribute('aria-modal','true');
  veu.setAttribute('aria-label','Personalizar'+(p?' '+p.name:''));
  veu.innerHTML='<div class="pzq-caixa">'
    +'<div class="pzq-espera" role="status"><span class="pzq-giro" aria-hidden="true"></span>'
    +'<span class="pzq-espera-tx">Abrindo o personalizador…</span><div class="pzq-saida" hidden></div></div>'
    +'<button type="button" class="pzq-x" data-pzq-fechar aria-label="Fechar o personalizador">&#215;</button>'
    +'<iframe class="pzq-iframe" title="'+escAtributoPz('Personalizar '+(p?p.name:'a peça'))+'"></iframe>'
    +'</div>';
  document.body.appendChild(veu);
  var iframe=veu.querySelector('iframe');
  QUADRO={ veu:veu, iframe:iframe, produto_id:produtoId, chave:chave||null, pronto:false,
    foco:document.activeElement, overflow:document.body.style.overflow, timer:null,
    doCheckout:checkoutAbertoPz() };
  document.body.style.overflow='hidden';
  iframe.addEventListener('load',function(){ conferirQuadroCarregado(iframe); });
  QUADRO.timer=setTimeout(function(){ if(QUADRO&&!QUADRO.pronto) mostrarSaidaDoQuadro('demora'); },ESPERA_DO_QUADRO);
  iframe.src=enderecoDoQuadro(produtoId);
  try{ veu.querySelector('.pzq-x').focus(); }catch(_){}
  return true;
}

/** A pagina de falha do quadro (mesma origem) traz uma marca: sai na hora. */
function conferirQuadroCarregado(iframe){
  if(!QUADRO||QUADRO.iframe!==iframe||QUADRO.pronto) return;
  try{
    var doc=iframe.contentDocument;
    var m=doc&&doc.querySelector('meta[name="aura-quadro"]');
    if(m&&m.getAttribute('content')==='indisponivel') mostrarSaidaDoQuadro('erro');
  }catch(_){}
}

/** Sem quadro: o WhatsApp da loja, como a loja comum ja faz sem checkout. */
function mostrarSaidaDoQuadro(motivo){
  if(!QUADRO) return;
  var veu=QUADRO.veu, p=PROD_MAP[QUADRO.produto_id];
  if(motivo!=='demora'){ QUADRO.pronto=false; veu.classList.remove('pzq-pronto'); var g=veu.querySelector('.pzq-giro'); if(g) g.hidden=true; }
  veu.querySelector('.pzq-espera-tx').textContent=motivo==='demora'
    ?'O personalizador está demorando para abrir.'
    :'Não deu para abrir o personalizador agora.';
  var n=(typeof numeroDoWhatsapp==='function')?numeroDoWhatsapp(CONTACT.whatsapp):'';
  var html='';
  if(n) html+='<a class="pzq-btn" target="_blank" rel="noopener" href="https://wa.me/'+escAtributoPz(n)+'?text='+encodeURIComponent('Oi! Quero personalizar "'+(p?p.name:'uma peça')+'"')+'">Personalizar pelo WhatsApp</a>';
  html+='<button type="button" class="pzq-btn sec" data-pzq-fechar>Voltar para a loja</button>';
  var saida=veu.querySelector('.pzq-saida');
  saida.innerHTML=html; saida.hidden=false;
}

function fecharQuadro(semFoco){
  if(!QUADRO) return;
  var q=QUADRO; QUADRO=null;
  if(q.timer) clearTimeout(q.timer);
  if(q.veu.parentNode) q.veu.parentNode.removeChild(q.veu);
  document.body.style.overflow=q.overflow||'';
  if(!semFoco&&q.foco&&typeof q.foco.focus==='function'){ try{ q.foco.focus(); }catch(_){} }
}

function tratarMensagemDoQuadro(d){
  if(!QUADRO) return;
  if(d.tipo==='pronto'){
    if(d.produto_id!==QUADRO.produto_id) return;
    QUADRO.pronto=true;
    if(QUADRO.timer){ clearTimeout(QUADRO.timer); QUADRO.timer=null; }
    QUADRO.veu.classList.add('pzq-pronto');
    var item=QUADRO.chave&&cart[QUADRO.chave];
    if(item&&item.personalizado&&item.customization) enviarAoQuadro({ tipo:'editar', customization:item.customization, quantidade:item.qty });
    try{ QUADRO.iframe.focus(); }catch(_){}
    return;
  }
  if(d.tipo==='confirmou'){
    var novo=itemDoConfirmado(d,QUADRO.produto_id);
    if(!novo){ if(typeof showToast==='function') showToast('Não deu para guardar a peça. Tente de novo.'); return; }
    // A linha sem a escolha (sacola antiga) sai: a nova toma o lugar dela.
    var alvo=QUADRO.chave, antiga=alvo&&cart[alvo];
    if(antiga&&!antiga.personalizado&&linhaPendente(antiga)){ delete cart[alvo]; alvo=null; }
    else if(d.editando!==true) alvo=null;
    var doCheckout=QUADRO.doCheckout;
    guardarPersonalizado(novo,alvo);
    fecharQuadro(true);
    // Do resumo do checkout, a cliente volta para o checkout (p-183).
    if(doCheckout){ if(typeof aposMudarOPreco==='function') aposMudarOPreco(); }
    else openCart();
    return;
  }
  if(d.tipo==='cancelou'){ fecharQuadro(); return; }
  if(d.tipo==='erro') mostrarSaidaDoQuadro('erro');
}

// O botao "Personalizar" (p-180) pede; a ponte atende.
window.addEventListener('aura:personalizar',function(ev){
  var d=(ev&&ev.detail)||{};
  if(d.produto_id&&abrirQuadro(String(d.produto_id),null)) ev.preventDefault();
});
window.addEventListener('message',function(ev){
  if(!QUADRO) return;
  var d=lerMensagemDoQuadro(ev,QUADRO.iframe.contentWindow);
  if(d) tratarMensagemDoQuadro(d);
});
document.addEventListener('click',function(ev){
  var t=ev.target&&ev.target.closest?ev.target.closest('[data-pzq-editar],[data-pzq-remover],[data-pzq-fechar]'):null;
  if(!t) return;
  if(t.hasAttribute('data-pzq-fechar')){ fecharQuadro(); return; }
  var k=t.getAttribute('data-pzq-editar')||t.getAttribute('data-pzq-remover');
  var i=cart[k]; if(!i||!(i.personalizado||linhaPendente(i))) return;
  if(t.hasAttribute('data-pzq-remover')){
    changeQty(k,-i.qty);
    if(checkoutAbertoPz()&&typeof aposMudarOPreco==='function') aposMudarOPreco();
    return;
  }
  closeCart();
  abrirQuadro(i.product_id,k);
});
/** O checkout esta aberto? (Editar pelo resumo dele, p-183.) */
function checkoutAbertoPz(){
  var ov=document.getElementById('checkoutOverlay');
  return !!(ov&&ov.classList&&ov.classList.contains('open'));
}
document.addEventListener('keydown',function(ev){ if(QUADRO&&ev.key==='Escape') fecharQuadro(); });
`;

// [trecho exato, o que entra no lugar]. Cada trecho tem de existir uma vez.
const TROCAS_DA_SACOLA = [
  // A sacola guardada no navegador volta com o que a cliente escolheu.
  [
    'cart[i.key]={ key:i.key, product_id:i.product_id, variant_id:i.variant_id||null, name:nome, price:Number(i.price), image_url:i.image_url||null, qty:Math.round(i.qty) };\n',
    'cart[i.key]={ key:i.key, product_id:i.product_id, variant_id:i.variant_id||null, name:nome, price:Number(i.price), image_url:i.image_url||null, qty:Math.round(i.qty) };\n'
      + '      if(i.personalizado&&!itemPersonalizadoDaSacola(cart[i.key],i)) delete cart[i.key];\n',
  ],
  // p-183: a conferencia do preco de agora (p-124) leva o personalizado
  // com o customization (POST /sacola/precos aceita desde o p-184).
  [
    "function assinaturaDaSacola(){ return Object.values(cart).map(function(i){ return i.key+'x'+i.qty; }).join('|'); }",
    "function assinaturaDaSacola(){ return Object.values(cart).map(function(i){ return i.key+'x'+i.qty+(i.personalizado?'~'+(i.rev||0):''); }).join('|'); }",
  ],
  [
    "  var corpo={ items:itens.map(function(i){ return { product_id:i.product_id, variant_id:i.variant_id||null, quantity:i.qty }; }) };",
    "  var corpo={ items:itens.map(itemParaOServidor) };",
  ],
  // A resposta do personalizado traz subtotal (com a arte) e o motivo.
  [
    "    return { key:key, preco:r[campo] };",
    "    return { key:key, preco:r[campo], subtotal:r.subtotal, disponivel:r.disponivel, motivo:r.motivo };",
  ],
  // O personalizado e a linha pendente seguem tratarLinhaPersonalizada.
  [
    "    if(!r||r.preco==null) return;\n    var i=cart[r.key]; if(!i) return;\n",
    "    if(!r) return;\n    var pz=cart[r.key]?tratarLinhaPersonalizada(cart[r.key],r,subiram):null;\n    if(pz){ if(pz==='mudou') mudou=true; return; }\n    if(r.preco==null) return;\n    var i=cart[r.key]; if(!i) return;\n",
  ],
];

const TROCAS_DO_CARRINHO = [
  // A linha do personalizado (miniatura, resumo, Editar, Remover).
  [
    "+Object.values(cart).map(function(i){\n",
    "+Object.values(cart).map(function(i){\n    if(i.personalizado||linhaPendente(i)) return htmlDoItemPersonalizado(i);\n",
  ],
  // p-183: a linha do personalizado vale o subtotal (a arte entra uma vez).
  [
    "function getSubtotal(){return Object.values(cart).reduce(function(s,i){return s+i.price*i.qty;},0);}",
    "function getSubtotal(){return Object.values(cart).reduce(function(s,i){return s+totalDaLinha(i);},0);}",
  ],
  // O aviso da aprovacao da arte, depois dos itens (mockup p-132).
  [
    "  }).join('');\n  document.getElementById('cartSubtotal')",
    "  }).join('')+avisoDoPersonalizado();\n  document.getElementById('cartSubtotal')",
  ],
];

function trocar(src, trocas, nome) {
  let out = src;
  for (const [de, para] of trocas) {
    const n = out.split(de).length - 1;
    if (n !== 1) {
      throw new Error(`quadro: trecho do ${nome} encontrado ${n} vezes (esperado 1): ${de.slice(0, 80)}`);
    }
    out = out.replace(de, () => para);
  }
  return out;
}

/** sacola.js com o personalizado guardado e na conferencia de preco (p-183). */
function aplicarNaSacola(sacolaSrc) {
  return trocar(sacolaSrc, TROCAS_DA_SACOLA, 'sacola');
}

/** cart.js com a linha do personalizado e o aviso. */
function aplicarNoCarrinho(cartSrc) {
  return trocar(cartSrc, TROCAS_DO_CARRINHO, 'carrinho');
}

// ── CSS (no <head>, so na loja com personalizavel) ──────────────
// Cores do tema da loja (--sf-*). Desktop: quadro por cima da loja.
// Celular (ate 640 px): tela cheia; o app desenha o "voltar" (p-181).
const CSS = [
  '.pzq-veu{position:fixed;inset:0;z-index:1000;background:rgba(20,16,12,.55);display:flex;align-items:center;justify-content:center;padding:22px}',
  '.pzq-veu [hidden]{display:none!important}',
  '.pzq-caixa{position:relative;width:min(960px,100%);height:min(760px,calc(100vh - 44px));height:min(760px,calc(100dvh - 44px));background:var(--sf-bg);color:var(--sf-ink);border:1px solid var(--sf-border);border-radius:18px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.35)}',
  '.pzq-iframe{position:absolute;inset:0;width:100%;height:100%;border:0;opacity:0;pointer-events:none;background:transparent}',
  '.pzq-pronto .pzq-iframe{opacity:1;pointer-events:auto}',
  '.pzq-pronto .pzq-espera,.pzq-pronto .pzq-x{display:none}',
  '.pzq-espera{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:24px;text-align:center;font-size:14px;line-height:1.5}',
  '.pzq-giro{display:block;width:28px;height:28px;border-radius:50%;border:3px solid var(--sf-border);border-top-color:var(--sf-ink);animation:pzq-giro .9s linear infinite}',
  '@keyframes pzq-giro{to{transform:rotate(360deg)}}',
  '@media (prefers-reduced-motion:reduce){.pzq-giro{animation:none}}',
  '.pzq-saida{display:flex;flex-direction:column;gap:8px;width:min(320px,100%)}',
  '.pzq-btn{display:block;padding:12px 18px;border-radius:12px;font:inherit;font-size:14px;font-weight:700;text-align:center;text-decoration:none;background:var(--sf-ink);color:var(--sf-bg);border:1px solid var(--sf-ink);cursor:pointer}',
  '.pzq-btn.sec{background:transparent;color:var(--sf-ink);border-color:var(--sf-border)}',
  '.pzq-x{position:absolute;top:12px;right:12px;width:36px;height:36px;border-radius:50%;border:1px solid var(--sf-border);background:var(--sf-bg-card);color:var(--sf-ink);font-size:18px;line-height:1;cursor:pointer;z-index:1}',
  '.pzq-pill{display:inline-block;margin-left:4px;padding:2px 8px;border-radius:999px;background:var(--sf-brand-wash);color:var(--sf-ink);font-family:inherit;font-size:10.5px;font-weight:700;letter-spacing:0;vertical-align:middle}',
  '.pzq-resumo{font-size:12px;color:var(--sf-ink-2);line-height:1.45;margin-top:2px}',
  '.pzq-acoes{display:flex;gap:16px;margin-top:4px}',
  '.pzq-acoes button{background:none;border:0;padding:0;min-height:32px;font:inherit;font-size:12.5px;font-weight:700;color:var(--sf-ink);text-decoration:underline;text-underline-offset:3px;cursor:pointer}',
  '.pzq-aviso{margin:12px 0 0;padding:11px 13px;border-radius:12px;background:var(--sf-brand-wash);border:1px solid var(--sf-border);font-size:13px;line-height:1.5;color:var(--sf-ink)}',
  '@media (max-width:640px){.pzq-veu{padding:0}.pzq-caixa{width:100%;height:100%;border:0;border-radius:0;box-shadow:none}}',
].join('');

module.exports = {
  PONTE, CSS, aplicarNaSacola, aplicarNoCarrinho, TROCAS_DA_SACOLA, TROCAS_DO_CARRINHO,
};
