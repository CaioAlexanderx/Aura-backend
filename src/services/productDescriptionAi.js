// ============================================================
// AURA. — Geração de descrição de produto por IA (F0 → F1)
//
// Só o miolo: recebe produtos, devolve descrições. Não toca no banco —
// quem persiste é src/routes/productDescriptions.js. Assim o serviço é
// testável sem banco e sem rede (o cliente Claude é injetável).
//
// ── DUAS DECISÕES DE CUSTO, MEDIDAS EM 18/08/2026 ───────────
//
// 1. EMPACOTAR PRODUTOS POR REQUEST é o único lever que importa.
//    Um produto por chamada paga o prompt de instrução uma vez por
//    produto; a 20 por chamada ele dilui e a entrada praticamente some
//    da conta. Descrever os 4.734 produtos sem texto da base inteira
//    custa ~US$ 5 no Sonnet 5 empacotado.
//
// 2. NÃO CONTAMOS COM PROMPT CACHING aqui, de propósito. O mínimo
//    cacheável do Haiku 4.5 é 4.096 tokens e o do Sonnet 5 é 1.024 —
//    um prompt de instrução deste tamanho não cachearia no Haiku, e
//    silenciosamente (sem erro, só cache_creation_input_tokens = 0).
//    O empacotamento resolve o mesmo problema sem essa dependência.
//
// MODELO: Sonnet 5, explícito. O DEFAULT_MODEL do claudeClient ainda é
// o Sonnet 4 (deprecado) e é compartilhado com aiChat/DANFE/odonto —
// trocar lá mudaria o comportamento daquelas rotas, o que não é escopo
// desta feature. A diferença de custo entre Haiku e Sonnet no catálogo
// inteiro é de ~US$ 5: aqui a qualidade do texto É o produto, então não
// se economiza centavo no que o cliente publica na vitrine.
// ============================================================
'use strict';

const { callClaude, parseJsonResponse } = require('./claudeClient');

const MODEL = 'claude-sonnet-5';
const PACK_SIZE = 20;      // produtos por request (ver decisão 1 acima)
const MAX_TOKENS = 8000;   // ~20 × 180 tokens de saída + folga do JSON
const MAX_CHARS = 600;     // teto por descrição, aparado no serviço

const SYSTEM = [
  'Voce escreve descricoes curtas de produto para a loja virtual de um lojista brasileiro.',
  '',
  'REGRAS INEGOCIAVEIS:',
  '1. Use SOMENTE os dados fornecidos. Nunca invente material, medida, composicao,',
  '   origem, garantia, tecnologia ou beneficio que nao esteja no dado de entrada.',
  '2. Nunca cite preco, desconto, frete, prazo de entrega ou disponibilidade de estoque.',
  '3. Nunca prometa resultado ("emagrece", "dura para sempre", "o mais confortavel do mercado").',
  '4. Portugues brasileiro, tom de loja: direto, concreto, sem jargao de marketing.',
  '5. Dois paragrafos curtos, no maximo 90 palavras no total.',
  '6. Nao repita o nome do produto na primeira palavra de cada paragrafo.',
  '7. Se o dado for pobre demais para escrever algo honesto, devolva string vazia',
  '   no campo description. Texto generico e pior que texto nenhum.',
  '',
  'SAIDA: um array JSON e nada mais. Cada item: {"id": "<id recebido>", "description": "<texto>"}.',
  'Devolva exatamente um item por produto recebido, na mesma ordem. Sem markdown, sem comentario.',
].join('\n');

// Só os campos que o modelo pode usar. Enviar a linha inteira de products
// convidaria o modelo a citar preço/estoque — proibidos pela regra 2.
function toPayload(p) {
  const out = { id: String(p.id), nome: p.name || '' };
  if (p.brand)    out.marca     = p.brand;
  if (p.category) out.categoria = p.category;
  if (p.color)    out.cor       = p.color;
  if (p.size)     out.tamanho   = p.size;
  if (p.unit)     out.unidade   = p.unit;
  return out;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function clean(text) {
  if (typeof text !== 'string') return '';
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > MAX_CHARS ? t.slice(0, MAX_CHARS).replace(/\s+\S*$/, '') : t;
}

/**
 * Gera descrições para uma lista de produtos.
 *
 * Nunca lança por falha de um lote: um lote que quebra vira uma entrada em
 * `errors` e os demais seguem. Descrever catálogo é trabalho em massa — um
 * timeout no lote 7 não pode perder os lotes 1 a 6.
 *
 * @param {Array} products  linhas de products (id, name, brand, category, color, size, unit)
 * @param {object} [opts]
 * @param {Function} [opts.call]  injeção do cliente Claude (testes)
 * @param {string}   [opts.model]
 * @returns {Promise<{results: Array, errors: Array, usage: object}>}
 */
async function generateDescriptions(products, opts = {}) {
  const call  = opts.call || callClaude;
  const model = opts.model || MODEL;

  const list = (products || []).filter(p => p && p.id && p.name);
  if (!list.length) {
    return { results: [], errors: [], usage: { input_tokens: 0, output_tokens: 0, requests: 0 } };
  }

  const results = [];
  const errors  = [];
  const usage   = { input_tokens: 0, output_tokens: 0, requests: 0 };

  for (const lote of chunk(list, PACK_SIZE)) {
    // Mapa id -> produto do PRÓPRIO lote: o modelo só pode devolver ids que
    // recebeu. Qualquer id fora daqui é alucinação e é descartado.
    const doLote = new Map(lote.map(p => [String(p.id), p]));

    try {
      const resp = await call({
        model,
        system: SYSTEM,
        maxTokens: MAX_TOKENS,
        messages: [{
          role: 'user',
          content: 'Produtos:\n' + JSON.stringify(lote.map(toPayload), null, 0),
        }],
      });

      usage.requests      += 1;
      usage.input_tokens  += resp.inputTokens  || 0;
      usage.output_tokens += resp.outputTokens || 0;

      // stop_reason max_tokens = JSON truncado; parseJsonResponse quebraria
      // com erro de sintaxe e esconderia a causa real.
      if (resp.stopReason === 'max_tokens') {
        errors.push({ product_ids: lote.map(p => p.id), error: 'resposta truncada (max_tokens)' });
        continue;
      }

      const parsed = parseJsonResponse(resp.text);
      const items  = Array.isArray(parsed) ? parsed : (parsed && parsed.items) || [];

      for (const item of items) {
        const id = item && item.id != null ? String(item.id) : null;
        if (!id || !doLote.has(id)) continue;   // id que não foi pedido
        const description = clean(item.description);
        if (!description) continue;             // regra 7: vazio é resposta válida
        results.push({
          product_id: doLote.get(id).id,
          description,
          model: resp.model || model,
          input_tokens: resp.inputTokens || 0,
          output_tokens: resp.outputTokens || 0,
        });
        doLote.delete(id);
      }

      // Quem sobrou não voltou no JSON — registra sem derrubar o lote.
      if (doLote.size) {
        errors.push({ product_ids: [...doLote.values()].map(p => p.id), error: 'sem descricao na resposta' });
      }
    } catch (err) {
      errors.push({ product_ids: lote.map(p => p.id), error: err.message });
    }
  }

  return { results, errors, usage };
}

module.exports = {
  MODEL,
  PACK_SIZE,
  MAX_CHARS,
  SYSTEM,
  generateDescriptions,
};
