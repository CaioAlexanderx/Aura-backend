// AURA. -- storefront/index.js
// Monta o <script> SPA da vitrine publica concatenando os modulos parts/*.
// Mantem assinatura compativel com o antigo storefrontScript.js:
//   buildScript(storeData, escapedSlug, apiBase) -> string <script>...</script>
// apiBase e opcional (default ''); quando setado, fetches usam URL absoluta.
'use strict';

const prelude       = require('./parts/prelude');
const init          = require('./parts/init');
const stateUtils    = require('./parts/state_utils');
// O cartao de produto: uma funcao pra grade e pra home (fase 3).
const card          = require('./parts/card');
const products      = require('./parts/products');
const categorias    = require('./parts/categorias');
const tiraCategorias = require('./parts/tira_categorias');
// A home que nasce do estoque + cabecalho novo (fase 3 do redesign).
// Depois de categorias e tira: usa CATEGORIAS, filhasDe, irParaCategoria.
const home          = require('./parts/home');
const filtros       = require('./parts/filtros');
// A sacola que sobrevive + o resumo do checkout (fase 6). Antes de cart:
// cart chama salvarSacola/renderResumoDoCheckout.
const sacola        = require('./parts/sacola');
const cart          = require('./parts/cart');
const checkout      = require('./parts/checkout');
const pix           = require('./parts/pix');
const productDetail = require('./parts/product_detail');
// tq-44: escolha da forma de pagar na entrega (so na loja que marcou as formas).
const naEntrega     = require('./parts/na_entrega');
const toast         = require('./parts/toast');
const bootstrap     = require('./parts/bootstrap');
// Regra da capa sem foto (iniciais + degrau do gradiente) — definida uma
// vez em storefrontCapa.js e serializada para o navegador.
const { fonteClienteIniciais } = require('../storefrontCapa');
// Parcelamento: mesma estrategia — a regra vive no servico e vai
// serializada, em vez de reescrita a mao no cliente.
const { fonteClienteParcelamento } = require('../../services/parcelamento');
// Cor: o mapa e a nomeacao moram no servico e vao serializados, porque o
// SERVIDOR tambem usa (pra agrupar as facetas). Duas copias divergiriam.
const { FONTE: fonteDasCores } = require('../../services/coresDaLoja');
// Faixas do filtro de preco: a regra mora no servico (testavel) e vai
// serializada, como parcelamento e cores.
const { FONTE: fonteDasFaixas } = require('../../services/faixasDePreco');
// Quais fotos a pagina do produto mostra (galeria por cor, migration 323).
// Mesma estrategia: a regra mora no servico, e testada la, e vai
// serializada — o navegador e o teste rodam o MESMO codigo.
const { FONTE: fonteDasFotos } = require('../../services/fotosDaVitrine');
// O numero do wa.me com o 55 (tq-61). Mesma estrategia: a regra mora no
// servico, testada la, e vai serializada — pix.js e product_detail.js
// chamam numeroDoWhatsapp() em vez de so tirar o que nao e digito.
const { FONTE: fonteDoWhatsapp } = require('../../services/whatsappDaLoja');

// tq-58: o titulo da descricao na pagina do produto pela frente da conta.
// O part e uma string fixa; a troca e feita aqui, no servidor, e SO quando
// o texto e outro — loja de roupa recebe o part intacto, byte a byte.
const ROTULO_SOBRE_DE_ROUPA = '<div class="sf-label">Sobre esta peça</div>';

function detalheDoProduto(textosDaFrente) {
  const rotulo = textosDaFrente && textosDaFrente.sobreProduto;
  if (!rotulo || rotulo === 'Sobre esta peça') return productDetail;
  const seguro = String(rotulo).replace(/[&<>"'\\]/g, '');
  return productDetail.split(ROTULO_SOBRE_DE_ROUPA).join('<div class="sf-label">' + seguro + '</div>');
}

function buildScript(storeData, escapedSlug, apiBase, textosDaFrente, opcoes) {
  const comNaEntrega = !!(opcoes && opcoes.naEntrega);
  return prelude(storeData, escapedSlug, apiBase)
       + init
       + stateUtils
       + fonteClienteIniciais()
       + fonteClienteParcelamento()
       + fonteDasCores
       + fonteDasFaixas
       + fonteDasFotos
       + fonteDoWhatsapp
       + card
       + products
       + categorias
       + tiraCategorias
       + home
       + filtros
       + sacola
       + cart
       + (comNaEntrega ? naEntrega.aplicar(checkout) : checkout)
       + pix
       + detalheDoProduto(textosDaFrente)
       + toast
       + bootstrap;
}

module.exports = buildScript;
// So pra teste: o rotulo que a troca procura tem que existir no part.
module.exports.ROTULO_SOBRE_DE_ROUPA = ROTULO_SOBRE_DE_ROUPA;
