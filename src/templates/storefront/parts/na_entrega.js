// AURA. -- storefront/parts/na_entrega.js
// Pagar na entrega com forma escolhida e troco (tq-44, 29/10/2026).
// Desenho aprovado pela Nina em 19/10 (mockup "Delivery da adega").
//
// SO ENTRA NA PAGINA DA LOJA QUE MARCOU AS FORMAS (settings.
// pay_on_delivery_methods). Nas outras lojas o <script> sai byte a byte
// igual ao de antes — por isso este arquivo nao edita checkout.js: ele
// (1) acrescenta funcoes novas (EXTRA) e (2) troca trechos EXATOS do
// checkout (TROCAS). Cada trecho tem de existir uma vez so; se alguem
// mudar o checkout e o trecho sumir, aplicar() quebra no teste em vez de
// a vitrine sair sem a escolha da forma.
//
// Na tela: "Pagar na entrega" deixa de enviar o pedido no toque. Abre a
// escolha da forma (dinheiro, cartao na maquina, Pix na hora — so as que a
// loja liga) e, no dinheiro, "troco para quanto?", com o troco ja
// calculado. "Fazer pedido" envia. A tela final diz que a loja vai
// aceitar o pedido.
'use strict';

const EXTRA = `
// ── Pagar na entrega com forma e troco (tq-44) ──
var NA_ENTREGA={forma:null,troco:null,outro:false};
var ROTULOS_NA_ENTREGA={cash:'Dinheiro',card:'Cartão na máquina',pix:'Pix na hora'};
var DETALHES_NA_ENTREGA={cash:'Se precisar, diga para quanto é o troco.',card:'O entregador leva a maquininha.',pix:'Você paga com Pix quando o pedido chegar.'};
function formasNaEntrega(){
  var f=(SETTINGS && SETTINGS.pay_on_delivery_methods)||[];
  return f.filter(function(x){ return !!ROTULOS_NA_ENTREGA[x]; });
}
function textoDasFormasNaEntrega(){
  var f=formasNaEntrega().map(function(x){ return ROTULOS_NA_ENTREGA[x].toLowerCase(); });
  if(!f.length) return 'Combinado com a loja';
  var t=f.length===1?f[0]:f.slice(0,-1).join(', ')+' ou '+f[f.length-1];
  return t.charAt(0).toUpperCase()+t.slice(1);
}
function totalNaEntrega(){ return Math.round((getSubtotal()+getFee())*100)/100; }
function trocoNaEntrega(){
  if(NA_ENTREGA.forma!=='cash' || !NA_ENTREGA.troco) return 0;
  var t=Math.round((NA_ENTREGA.troco-totalNaEntrega())*100)/100;
  return t>0?t:0;
}
function estiloNaEntrega(){
  if(document.getElementById('estiloNaEntrega')) return;
  var css='.ne-chips{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 4px}'
    +'.ne-chip{padding:8px 14px;border-radius:999px;border:1px solid var(--border);background:transparent;color:var(--text-2);font:inherit;font-size:13px;font-weight:600;cursor:pointer}'
    +'.ne-chip.on{background:var(--primary);border-color:var(--primary);color:#fff}'
    +'.ne-label{font-size:13px;font-weight:700;color:var(--text-2);margin-top:14px}'
    +'.ne-linha{display:flex;justify-content:space-between;gap:8px;font-size:13px;margin-top:10px;color:var(--text-2)}'
    +'.ne-linha b{color:var(--text)}'
    +'.ne-trocar{background:none;border:0;padding:0;margin-top:14px;font:inherit;font-size:12px;color:var(--text-3);text-decoration:underline;cursor:pointer}';
  var st=document.createElement('style'); st.id='estiloNaEntrega'; st.textContent=css;
  document.head.appendChild(st);
}
function abrirPagarNaEntrega(){
  if(typeof enviandoPedido!=='undefined' && enviandoPedido) return;
  customerData.payment_method='on_delivery';
  var f=formasNaEntrega();
  if(f.length===1) NA_ENTREGA.forma=f[0];
  if(typeof renderResumoDoCheckout==='function') renderResumoDoCheckout();
  renderCheckoutStep();
}
function trocarFormaDePagamento(){
  if(typeof enviandoPedido!=='undefined' && enviandoPedido) return;
  customerData.payment_method=null;
  renderCheckoutStep();
}
function renderPagarNaEntrega(body,btn){
  estiloNaEntrega();
  var total=totalNaEntrega();
  var f=formasNaEntrega();
  var h='<div class="ne-label" style="margin-top:0">Como você vai pagar na entrega?</div><div class="delivery-opts" style="margin-top:8px">';
  f.forEach(function(x){
    var on=NA_ENTREGA.forma===x;
    h+='<div class="delivery-opt'+(on?' active':'')+'" data-forma="'+x+'" role="radio" aria-checked="'+on+'"><div class="delivery-opt-radio"></div><div class="delivery-opt-info"><div class="delivery-opt-name">'+esc(ROTULOS_NA_ENTREGA[x])+'</div><div class="delivery-opt-detail">'+esc(DETALHES_NA_ENTREGA[x])+'</div></div></div>';
  });
  h+='</div>';
  if(NA_ENTREGA.forma==='cash'){
    var notas=[20,50,100,200].filter(function(v){ return v>total; }).slice(0,2);
    h+='<div class="ne-label">Troco para quanto?</div><div class="ne-chips">';
    h+='<button type="button" class="ne-chip'+(!NA_ENTREGA.troco && !NA_ENTREGA.outro?' on':'')+'" data-troco="0">Não preciso</button>';
    notas.forEach(function(v){ h+='<button type="button" class="ne-chip'+(NA_ENTREGA.troco===v && !NA_ENTREGA.outro?' on':'')+'" data-troco="'+v+'">'+fmt(v)+'</button>'; });
    h+='<button type="button" class="ne-chip'+(NA_ENTREGA.outro?' on':'')+'" data-troco="outro">Outro valor</button></div>';
    if(NA_ENTREGA.outro){
      h+='<input class="field-input" type="text" id="inp_troco" inputmode="decimal" placeholder="Ex.: 150" value="'+(NA_ENTREGA.troco?String(NA_ENTREGA.troco).replace('.',','):'')+'" style="max-width:180px;margin-top:6px">';
    }
  }
  h+='<div class="ne-linha"><span>Total do pedido</span><b>'+fmt(total)+'</b></div>';
  h+='<div class="ne-linha" id="linhaTroco"'+(trocoNaEntrega()>0?'':' hidden')+'><span>O entregador leva de troco</span><b id="valorTroco">'+fmt(trocoNaEntrega())+'</b></div>';
  var nMetodos=(SETTINGS.has_pix?1:0)+(SETTINGS.has_card?1:0)+1;
  if(nMetodos>1) h+='<button type="button" class="ne-trocar" id="trocarForma">Escolher outra forma de pagamento</button>';
  body.innerHTML=h;
  body.querySelectorAll('[data-forma]').forEach(function(el){
    el.addEventListener('click',function(){
      if(typeof enviandoPedido!=='undefined' && enviandoPedido) return;
      NA_ENTREGA.forma=el.getAttribute('data-forma');
      if(NA_ENTREGA.forma!=='cash'){ NA_ENTREGA.troco=null; NA_ENTREGA.outro=false; }
      renderCheckoutStep();
    });
  });
  body.querySelectorAll('[data-troco]').forEach(function(el){
    el.addEventListener('click',function(){
      if(typeof enviandoPedido!=='undefined' && enviandoPedido) return;
      var v=el.getAttribute('data-troco');
      if(v==='outro'){ NA_ENTREGA.outro=true; NA_ENTREGA.troco=null; }
      else { NA_ENTREGA.outro=false; NA_ENTREGA.troco=Number(v)||null; }
      renderCheckoutStep();
      var inp=document.getElementById('inp_troco'); if(inp) inp.focus();
    });
  });
  var inpT=document.getElementById('inp_troco');
  if(inpT) inpT.addEventListener('input',function(){
    var v=Number(String(this.value||'').replace(/[^0-9,.]/g,'').replace(',','.'));
    NA_ENTREGA.troco=(isFinite(v) && v>0)?v:null;
    var t=trocoNaEntrega(), linha=document.getElementById('linhaTroco'), val=document.getElementById('valorTroco');
    if(linha) linha.hidden=!(t>0);
    if(val) val.textContent=fmt(t);
  });
  var tr=document.getElementById('trocarForma');
  if(tr) tr.addEventListener('click',trocarFormaDePagamento);
  btn.style.display='';
  btn.textContent='Fazer pedido';
  btn.className='next-btn green';
  btn.disabled=!NA_ENTREGA.forma;
}
function enviarPagarNaEntrega(){
  if(!NA_ENTREGA.forma){ showToast('Escolha como você vai pagar na entrega'); return; }
  if(NA_ENTREGA.forma==='cash' && NA_ENTREGA.outro){
    if(!NA_ENTREGA.troco){ showToast('Diga para quanto é o troco, ou toque em "Não preciso"'); return; }
    if(NA_ENTREGA.troco<totalNaEntrega()){ showToast('O valor para troco precisa ser maior que o total ('+fmt(totalNaEntrega())+')'); return; }
  }
  submitOrder();
}
function htmlDoPedidoAAceitar(){
  var ne=(currentOrder && currentOrder.na_entrega)||null;
  var forma=ne && ne.rotulo ? ne.rotulo : 'na entrega';
  var troco=ne && ne.troco ? ' O entregador leva '+fmt(ne.troco)+' de troco.' : '';
  return '<div class="confirm-title">Pedido enviado!</div>'
    +'<div class="confirm-desc">Pedido <strong>#'+esc(currentOrder.order_number)+'</strong>. Você vai pagar '+fmt(currentOrder.total)+' com '+esc(forma.toLowerCase())+' quando o pedido chegar.'+esc(troco)+'</div>'
    +'<p style="font-size:13px;color:var(--text-2);max-width:320px;margin:10px auto 0;">A loja vai confirmar o seu pedido e avisar pelo WhatsApp quanto tempo ele leva.</p>';
}
`;

// [trecho exato do checkout.js, o que entra no lugar]
const TROCAS = [
  // O toque em "Pagar na entrega" abre a escolha da forma.
  [
    "if(eod) eod.addEventListener('click',function(){chooseMethod('on_delivery');});",
    "if(eod) eod.addEventListener('click',function(){abrirPagarNaEntrega();});",
  ],
  // A opcao diz as formas que a loja aceita.
  [
    '<div class="delivery-opt-detail">Dinheiro ou maquininha, combinado com a loja</div>',
    '<div class="delivery-opt-detail">\'+esc(textoDasFormasNaEntrega())+\'</div>',
  ],
  // Loja so com pagar na entrega: vai para a escolha da forma, nao envia.
  [
    "customerData.payment_method='on_delivery'; submitOrder();",
    "customerData.payment_method='on_delivery'; checkoutStep=3; renderCheckoutStep();",
  ],
  // Etapa 3 com pagar na entrega e sem pedido ainda: a escolha da forma.
  [
    "    btn.style.display='';\n\n    if(customerData.payment_method==='on_delivery' && currentOrder){",
    "    btn.style.display='';\n\n    if(customerData.payment_method==='on_delivery' && !currentOrder){ renderPagarNaEntrega(body,btn); return; }\n    if(customerData.payment_method==='on_delivery' && currentOrder){",
  ],
  // O botao da escolha da forma ("Fazer pedido") envia o pedido.
  [
    "    if(pm==='on_delivery'){ closeCheckout();",
    "    if(pm==='on_delivery' && !currentOrder){ enviarPagarNaEntrega(); return; }\n    if(pm==='on_delivery'){ closeCheckout();",
  ],
  // Tela final: a loja vai aceitar o pedido.
  [
    "        +'<div class=\"confirm-title\">Pedido confirmado!</div>'\n        +'<div class=\"confirm-desc\">Pedido <strong>#'+esc(currentOrder.order_number)+'</strong>. Você pagará '+fmt(currentOrder.total)+' na entrega.</div>'",
    "        +htmlDoPedidoAAceitar()",
  ],
  // A forma e o troco vao no pedido; o servidor confere de novo.
  [
    '    idempotency_key:chaveDaTentativa(),\n',
    "    idempotency_key:chaveDaTentativa(),\n    pay_on_delivery_method:customerData.payment_method==='on_delivery'?NA_ENTREGA.forma:null,\n    change_for:(customerData.payment_method==='on_delivery' && NA_ENTREGA.forma==='cash' && NA_ENTREGA.troco)?NA_ENTREGA.troco:null,\n",
  ],
];

/** checkout.js com as trocas do pagar na entrega. Quebra se um trecho sumir. */
function aplicar(checkoutSrc) {
  let src = checkoutSrc;
  for (const [de, para] of TROCAS) {
    const n = src.split(de).length - 1;
    if (n !== 1) {
      throw new Error(`na_entrega: trecho do checkout encontrado ${n} vezes (esperado 1): ${de.slice(0, 80)}`);
    }
    src = src.replace(de, () => para);
  }
  return src + EXTRA;
}

module.exports = { aplicar, EXTRA, TROCAS };
