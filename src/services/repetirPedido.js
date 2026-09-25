// ============================================================
// AURA Studio — "Pedir outro igual" (Fase 4 · JORNADA §4.10)
//
// A cliente recebeu a caneca, gostou e quer outra para a irma. Hoje ela
// abre a loja e refaz tudo: escolhe o modelo, digita o nome, acha a foto
// no celular de novo. O botao "Pedir outro igual" do acompanhamento abre
// a pagina do produto com a personalizacao do pedido ja carregada — ela
// confere, ajusta e compra.
//
// GET /storefront/:slug/studio/pedido/:token/repetir devolve, por item,
// o produto, a quantidade e os VALORES da personalizacao. O token do
// pedido (digital_orders.public_token) e a credencial, como na
// confirmacao. Nada do cliente sai daqui: nem nome, nem contato, nem
// endereco, nem valores pagos — so o que a peca leva.
//
// FILTRADO PELO PRODUTO DE HOJE. A personalizacao foi gravada contra o
// configurador do dia da compra; a lojista pode ter tirado um campo, uma
// cor ou uma opcao desde entao. Um valor que o configurador atual nao
// conhece nao volta: repetir nao pode ressuscitar uma opcao que a loja
// deixou de vender, nem mandar um preco que o servidor recusaria.
//
// Pura de proposito: a rota busca as linhas, isto monta a resposta.
// ============================================================
'use strict';

// Tipos que guardam a ARTE como endereco (upload ou modelo da galeria).
const TIPOS_DE_ARTE = new Set(['image', 'template']);

const texto = (v) => typeof v === 'string' && v.trim() !== '';

function escolhasDe(campo) {
  const c = campo && campo.config;
  return c && Array.isArray(c.choices) ? c.choices : [];
}

/**
 * O valor de UM campo, se o configurador de hoje ainda o aceita; senao
 * `undefined` (o campo volta vazio e a cliente escolhe de novo).
 */
function valorDoCampo(campo, valor) {
  if (valor == null) return undefined;
  switch (campo.type) {
    case 'text': {
      if (!texto(valor)) return undefined;
      const max = campo.config && Number(campo.config.max_chars) > 0 ? Number(campo.config.max_chars) : null;
      return max ? String(valor).slice(0, max) : String(valor);
    }
    case 'color': {
      const cores = campo.config && Array.isArray(campo.config.colors) ? campo.config.colors : [];
      const v = String(valor).toLowerCase();
      return cores.some((c) => String(c).toLowerCase() === v) ? valor : undefined;
    }
    case 'option': {
      const aceitas = new Set(escolhasDe(campo).map((c) => c.value));
      if (Array.isArray(valor)) {
        const ok = valor.filter((v) => aceitas.has(v));
        return ok.length ? ok : undefined;
      }
      return aceitas.has(valor) ? valor : undefined;
    }
    case 'image':
    case 'template':
      // So endereco https: e o arquivo que a cliente mandou (ou o modelo
      // da galeria), e a pagina vai carregar isso numa <img>.
      return texto(valor) && /^https:\/\//i.test(String(valor).trim()) ? String(valor).trim() : undefined;
    default:
      return undefined;
  }
}

const HEX = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;

/**
 * Os valores de personalizacao de uma linha, filtrados pelo configurador
 * atual do produto.
 *
 * Alem dos campos, duas chaves laterais que o app grava:
 *   - `<campo>_cor`: a cor da letra de um campo de texto;
 *   - `art_service_brief`: o briefing do "criem a arte pra mim".
 */
function personalizacaoDaLinha(config, customization) {
  const v = customization && typeof customization === 'object' ? customization : {};
  const campos = config && Array.isArray(config.fields) ? config.fields : [];
  const valores = {};
  let temServicoDeArte = false;
  for (const campo of campos) {
    if (!campo || !campo.id) continue;
    const ok = valorDoCampo(campo, v[campo.id]);
    if (ok !== undefined) valores[campo.id] = ok;
    if (campo.type === 'text') {
      const cor = v[campo.id + '_cor'];
      if (typeof cor === 'string' && HEX.test(cor.trim())) valores[campo.id + '_cor'] = cor.trim();
    }
    if (campo.type === 'option' && campo.config && campo.config.is_art_service === true) temServicoDeArte = true;
  }
  if (temServicoDeArte && texto(v.art_service_brief)) {
    valores.art_service_brief = String(v.art_service_brief).slice(0, 1000);
  }
  // Verso e meio so voltam se o produto ainda os oferece.
  const verso = !!(config && config.has_back === true && v.has_back_selected === true);
  const meio = !!(config && config.has_middle === true && v.has_middle_selected === true);
  const temArte = campos.some((c) => c && TIPOS_DE_ARTE.has(c.type) && valores[c.id] !== undefined);
  return { valores, verso, meio, arte_enviada: temArte };
}

/**
 * @param {object} p
 * @param {object} p.pedido  linha de digital_orders (order_number)
 * @param {Array}  p.itens   linhas de digital_order_items (product_id, product_name, quantity, customization)
 * @param {Map|object} p.naVitrine  product_id -> { customization_config } dos produtos
 *                           que a vitrine mostra HOJE
 */
function montarRepeticao({ pedido, itens, naVitrine }) {
  const vitrine = naVitrine instanceof Map ? naVitrine : new Map(Object.entries(naVitrine || {}));
  return {
    numero: pedido && pedido.order_number != null ? String(pedido.order_number) : null,
    itens: (itens || []).map((i) => {
      const id = i.product_id != null ? String(i.product_id) : null;
      const produto = id ? vitrine.get(id) : null;
      const quantidade = Math.max(1, parseInt(i.quantity, 10) || 1);
      if (!produto) {
        // Saiu da vitrine (ocultada, inativa, apagada): a pagina avisa e
        // oferece falar com a loja. Sem valores — nao ha configurador
        // contra o qual conferi-los.
        return { product_id: id, nome: i.product_name || null, quantidade, indisponivel: true, personalizacao: null };
      }
      return {
        product_id: id,
        nome: i.product_name || null,
        quantidade,
        indisponivel: false,
        personalizacao: personalizacaoDaLinha(produto.customization_config, i.customization),
      };
    }),
  };
}

module.exports = { montarRepeticao, personalizacaoDaLinha, valorDoCampo };
