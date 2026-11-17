// AURA. -- storefront/parts/pedido_personalizado.js
// O checkout da loja comum com a peca personalizada (p-183, loja unica
// 3.3c, 17/11/2026). Mockup p-132, versao A (sacola mista, resumo e
// checkout). Contrato do pedido: p-184 (routes/storefront.js, POST /order).
//
// SO ENTRA NA LOJA COM `tem_personalizavel` (p-179), junto da ponte do
// quadro (parts/quadro.js, que define itemParaOServidor, totalDaLinha,
// linhaPendente, textoDoResumoPz, acoesDoPz e escAtributoPz). Nas outras
// lojas o HTML sai byte a byte igual (__tests__/lojaSemPersonalizavel
// .fixture.test.js): este arquivo nao edita checkout.js nem sacola.js; ele
// troca trechos EXATOS (como na_entrega.js e promocao.js) e acrescenta as
// funcoes novas (EXTRA). Trecho que sumir quebra no teste, nao na loja.
//
// O que muda, so nessas lojas:
//   - o POST /order leva o personalizado com o `customization` (o mesmo
//     objeto do POST /studio/order) e sem variante, na MESMA lista da
//     prateleira: a sacola mista vira um pedido so;
//   - o resumo do checkout mostra o personalizado com a miniatura, o
//     resumo da escolha, "Editar" (reabre o quadro por cima do checkout) e
//     "Remover", e o aviso "Voce aprova a arte antes da producao" com o
//     prazo do Pix (72 h, D10; sem sinal, D11);
//   - o 400 de personalizacao (mensagem da vitrine Studio, 'Personalizacao
//     de "Caneca": campo "Nome" obrigatorio') aparece para a cliente no
//     resumo e no aviso curto, e a linha da peca fica marcada para ela
//     revisar; linha pendente nem chega a ir ao servidor;
//   - a tela do pedido criado repete o prazo do Pix e o aviso da arte.
//
// A arte enviada pela cliente: o personalizador do quadro (app#1300, p-181,
// fields/FieldImage.tsx) sobe o arquivo em POST /storefront/:slug/studio/
// upload no momento em que ela escolhe, e o campo guarda a URL devolvida.
// O `customization` do confirmou ja chega com a URL; a loja comum nao sobe
// nada nem tem rota nova.
'use strict';

const { PRAZO_HORAS_STUDIO } = require('../../../jobs/lojaPixExpiradoJob');

const EXTRA = `
// ── O pedido com personalizado (p-183) ──
var erroDaPersonalizacao='';
var HORAS_DO_PIX_PZ=${PRAZO_HORAS_STUDIO};
function temPersonalizadoNaSacola(){ return Object.values(cart).some(function(i){ return i.personalizado||linhaPendente(i); }); }

/**
 * O texto da cliente para o 400 de personalizacao do servidor (mensagem da
 * vitrine Studio: 'Personalizacao de "Caneca": campo "Nome" obrigatorio').
 * '' quando o erro e outro.
 */
function mensagemDaPersonalizacao(erro){
  var m=/^Personalizacao de "(.*)": (.*)$/.exec(String(erro||''));
  if(!m) return '';
  var nome=m[1], motivo=m[2];
  if(motivo==='customization obrigatoria') return 'Falta escolher a personalização de "'+nome+'". Toque em Personalizar na sacola.';
  return 'Revise a personalização de "'+nome+'": '+motivo.replace(/obrigatori([oa])/g,'obrigatóri$1')+'.';
}

/** O 400 e de personalizacao? Mostra, marca a linha e devolve true. */
function tratarErroDaPersonalizacao(d){
  var t=mensagemDaPersonalizacao(d&&d.error);
  if(!t) return false;
  erroDaPersonalizacao=t;
  showToast(t);
  // A conferencia de agora devolve o motivo 'personalizacao' da linha.
  if(typeof ultimaConferencia!=='undefined') ultimaConferencia=null;
  if(typeof conferirPrecosDaSacola==='function') conferirPrecosDaSacola();
  renderResumoDoCheckout();
  return true;
}

/** Linha que ainda nao tem a escolha que vale: o pedido espera por ela. */
function barrarPendenteDaPersonalizacao(){
  var p=Object.values(cart).filter(linhaPendente)[0];
  if(!p){ erroDaPersonalizacao=''; return false; }
  erroDaPersonalizacao=p.personalizado
    ?'Revise a personalização de "'+p.name+'" antes de finalizar.'
    :'Falta escolher a personalização de "'+p.name+'". Toque em Personalizar.';
  showToast(erroDaPersonalizacao);
  renderResumoDoCheckout();
  return true;
}

function htmlDoErroDaPersonalizacao(){
  if(!erroDaPersonalizacao||!temPersonalizadoNaSacola()) return '';
  return '<p class="aviso-fechada pzq-erro" role="alert">'+esc(erroDaPersonalizacao)+'</p>';
}

/** A linha do personalizado no resumo do checkout. Com o pedido criado, sem acoes. */
function htmlDoResumoPersonalizado(i){
  var img=i.image_url?'<img src="'+escAtributoPz(i.image_url)+'" alt="">':'<span class="product-ph-initials" style="font-size:22px;">'+esc(INICIAIS(i.name))+'</span>';
  return '<div class="resumo-item pzq-resumo-item'+(linhaPendente(i)?' pzq-pendente':'')+'"><div class="resumo-thumb">'+img+'</div>'
    +'<div class="resumo-info"><span class="resumo-nome">'+esc(i.name)+' <span class="pzq-pill">Personalizada</span></span>'
    +'<span class="sf-caption">'+textoDoResumoPz(i)+i.qty+' un.</span>'
    +'<span class="mono resumo-preco">'+fmt(totalDaLinha(i))+'</span>'
    +(pedidoDoResumo?'':acoesDoPz(i))+'</div></div>';
}

/** Antes de pagar: a arte e aprovada antes da producao, e o prazo do Pix. */
function avisoDoResumoPersonalizado(){
  if(!temPersonalizadoNaSacola()) return '';
  return '<p class="pzq-aviso pzq-aviso-resumo"><b>Você aprova a arte antes da produção.</b> '
    +'Peças personalizadas são feitas sob encomenda: depois do pagamento, a gente mostra a arte para você aprovar, e só então produz.'
    +(SETTINGS.has_pix?' O Pix deste pedido vale por '+HORAS_DO_PIX_PZ+' horas.':'')+'</p>';
}

/** O pedido criado com personalizado (a resposta traz personalizado: true). */
function avisoDoPedidoPersonalizado(){
  if(typeof currentOrder==='undefined'||!currentOrder||currentOrder.personalizado!==true) return '';
  var pixAPagar=customerData&&customerData.payment_method==='pix'&&!(typeof paymentMarked!=='undefined'&&paymentMarked);
  return '<p class="pzq-aviso pzq-aviso-pedido">'+(pixAPagar
    ?'<b>Você tem até '+HORAS_DO_PIX_PZ+' horas para pagar o Pix.</b> Depois do pagamento, a gente mostra a arte para você aprovar, e só então produz.'
    :'<b>Você aprova a arte antes da produção.</b> A loja vai mostrar a arte para você conferir, e só então produz.')+'</p>';
}
`;

// [trecho exato, o que entra no lugar]. Cada trecho tem de existir uma vez.
const TROCAS_DO_CHECKOUT = [
  // Linha sem a escolha que vale: o pedido nem sai (o servidor recusaria).
  [
    '  if(enviandoPedido) return;\n  // p-124:',
    '  if(enviandoPedido) return;\n  if(barrarPendenteDaPersonalizacao()) return;\n  // p-124:',
  ],
  // O personalizado vai com o customization, na mesma lista: um pedido so.
  [
    '  var items=Object.values(cart).map(function(i){return{product_id:i.product_id,variant_id:i.variant_id||null,quantity:i.qty};});',
    '  var items=Object.values(cart).map(itemParaOServidor);',
  ],
  // O 400 de personalizacao aparece para a cliente e marca a linha.
  [
    "      showToast((res.data && res.data.error)||'Erro ao criar pedido');destravarEnvio();return;",
    "      if(tratarErroDaPersonalizacao(res.data)){ destravarEnvio(); return; }\n      showToast((res.data && res.data.error)||'Erro ao criar pedido');destravarEnvio();return;",
  ],
  // A tela do pedido criado: o prazo do Pix e o aviso da arte.
  [
    "  return t?'<p class=\"aviso-fechada\">'+esc(t)+'</p>':'';\n}\nfunction openCheckout(){",
    "  return (t?'<p class=\"aviso-fechada\">'+esc(t)+'</p>':'')+avisoDoPedidoPersonalizado();\n}\nfunction openCheckout(){",
  ],
];

const TROCAS_DO_RESUMO = [
  // O resumo do checkout: o erro, a linha do personalizado e o aviso.
  [
    '  var linhas=itens.map(function(i){\n',
    '  var linhas=itens.map(function(i){\n    if(i.personalizado||linhaPendente(i)) return htmlDoResumoPersonalizado(i);\n',
  ],
  [
    '    +htmlDoAvisoDePreco()\n    +linhas\n',
    '    +htmlDoAvisoDePreco()\n    +htmlDoErroDaPersonalizacao()\n    +linhas\n    +avisoDoResumoPersonalizado()\n',
  ],
];

function trocar(src, trocas, nome) {
  let out = src;
  for (const [de, para] of trocas) {
    const n = out.split(de).length - 1;
    if (n !== 1) {
      throw new Error(`pedido_personalizado: trecho do ${nome} encontrado ${n} vezes (esperado 1): ${de.slice(0, 80)}`);
    }
    out = out.replace(de, () => para);
  }
  return out;
}

/** checkout.js (ja com o pagar na entrega, se a loja usa) com o personalizado. */
function aplicarNoCheckout(checkoutSrc) {
  return trocar(checkoutSrc, TROCAS_DO_CHECKOUT, 'checkout');
}

/** sacola.js (ja com as trocas do quadro) com o resumo do checkout. */
function aplicarNoResumo(sacolaSrc) {
  return trocar(sacolaSrc, TROCAS_DO_RESUMO, 'resumo');
}

// ── CSS (no <head>, so na loja com personalizavel) ──────────────
const CSS = [
  '.pzq-erro{margin:0}',
  '.pzq-falta{color:var(--sf-ink);font-weight:600}',
  '.pzq-pendente .pzq-pill{background:transparent;border:1px solid var(--sf-border)}',
  '.pzq-resumo-item .pzq-acoes{margin-top:2px}',
  '.pzq-aviso-resumo{margin:0}',
  '.pzq-aviso-pedido{margin:12px auto 0;max-width:360px;text-align:left}',
].join('');

module.exports = {
  EXTRA, CSS, aplicarNoCheckout, aplicarNoResumo, TROCAS_DO_CHECKOUT, TROCAS_DO_RESUMO,
};
