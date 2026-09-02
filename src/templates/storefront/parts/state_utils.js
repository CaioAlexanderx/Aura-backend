// AURA. -- storefront/parts/state_utils.js
// Estado global do app (cart, currentCat, customerData, etc) + helpers (fmt, esc, cartKey, getProductCartQty, productHasVariants).
'use strict';

module.exports = `// cart é indexado por chave composta: productId OU productId:variantId
// Cada entrada: {key, product_id, variant_id|null, name, price, image_url, qty}
var cart={},currentCat='Todos',searchTerm='';
var checkoutStep=1,selectedDelivery=SETTINGS.pickup_enabled!==false?'pickup':'delivery';
var customerData={},currentOrder=null,pollInterval=null,timerInterval=null;
var paymentMarked=false;

function fmt(v){return 'R$ '+Number(v).toFixed(2).replace('.',',');}
function esc(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML;}
function cartKey(pid,vid){return pid+(vid?':'+vid:'');}
function getProductCartQty(pid){return Object.values(cart).filter(function(i){return i.product_id===pid;}).reduce(function(s,i){return s+i.qty;},0);}
function productHasVariants(p){return !!(p&&p.variants&&p.variants.length>0);}
/** "azul marinho" (como a lojista digitou) vira "Azul marinho" na loja. */
function primeiraMaiuscula(s){s=String(s==null?'':s).trim();return s?s.charAt(0).toUpperCase()+s.slice(1):s;}
`;
