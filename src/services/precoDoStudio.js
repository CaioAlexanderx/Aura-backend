// ============================================================
// AURA Studio — O preco de um pedido da vitrine, num lugar so
//
// ── POR QUE EXISTE (Fase 2 · 25/09/2026) ───────────────────────────────
// A conta do pedido morava inteira dentro de POST /studio/order, e o app
// mantinha uma COPIA dela (useStorefront.ts: lineUnitPrice, choicesDelta,
// backDelta, middleDelta) para mostrar o total antes de enviar. Toda
// regra nova de preco tinha de nascer duas vezes, em dois repositorios —
// e quando as copias divergiam o cliente via um total na sacola e levava
// 400/409 no pagamento (JORNADA_CLIENTE_VITRINE.md, D12).
//
// A saida e o servidor responder a pergunta "quanto fica?" com as MESMAS
// funcoes que ele usa para cobrar. POST /studio/order e POST
// /studio/cotacao chamam `cotarItens` e `totaisDoPedido` daqui; ha teste
// provando que, para o mesmo corpo, os dois dao o mesmo total.
//
// ── A ORDEM DA CONTA (nao mudar sem mudar os dois lados) ───────────────
//   1. faixa de quantidade (S6) sobre o preco de TABELA, por linha
//   2. + opcoes/cores escolhidas (price_delta), por unidade
//   3. + verso e + faixa central, por unidade
//   4. x quantidade
//   5. + servico de arte pago, UMA VEZ POR LINHA  ← Fase 2
//   6. desconto do Pix sobre o subtotal (frete fora)
//   7. + frete
//
// ── SERVICO DE ARTE: UMA VEZ POR LINHA (decisao do PO, 25/09/2026) ─────
// "Envio minha arte e voces ajustam" e "Criem a arte pra mim" sao
// trabalho feito uma vez: a lojista ajusta UMA arte, e ela sai em duas
// canecas iguais. Ate aqui o price_delta do campo `art_service` entrava
// no preco unitario e era multiplicado pela quantidade — duas canecas
// com a mesma foto pagavam o ajuste duas vezes.
//
// Exemplo (caneca R$ 39,90, ajuste R$ 10,00, 2 unidades):
//   antes: (39,90 + 10,00) x 2 = R$ 99,80
//   agora:  39,90 x 2 + 10,00  = R$ 89,80
// ============================================================
'use strict';

const { parseTiers, matchTier, unitPriceForQty, leadDaysForQty } = require('./studioQtyTiers');

/** Id canonico do campo (components/studio/artService.ts no app). */
const ART_SERVICE_FIELD_ID = 'art_service';

/**
 * O campo de servico de arte: `type: 'option'` marcado com
 * `config.is_art_service` ou com o id canonico. Mesma regra de
 * isArtServiceField (components/studio/customizationConfig.ts). O
 * briefing (`art_service_brief`) tambem carrega a marca, mas e texto —
 * por isso o tipo entra na regra.
 */
function ehCampoDeServicoDeArte(f) {
  if (!f || f.type !== 'option') return false;
  return f.id === ART_SERVICE_FIELD_ID || (f.config && f.config.is_art_service === true);
}

/** Soma os price_delta das choices selecionadas num campo. */
function deltaDoCampo(f, customization) {
  const choices = f.config && f.config.choices;
  if (!Array.isArray(choices) || choices.length === 0) return 0;
  const selected = customization[f.id];
  if (selected == null) return 0;
  // Suporta scalar ou array (multi-select futuro)
  const sels = Array.isArray(selected) ? selected : [selected];
  let delta = 0;
  for (const s of sels) {
    const c = choices.find((ch) => ch.value === s || ch.label === s);
    if (c && typeof c.price_delta === 'number' && !isNaN(c.price_delta)) {
      delta += c.price_delta;
    }
  }
  return delta;
}

// ─────────────────────────────────────────────
// computeChoicesDelta — soma price_delta de campos do tipo
// 'option' / 'color' baseado nos valores selecionados em
// `customization`. Cobrado POR UNIDADE.
//
// O servico de arte fica de fora: e cobrado por linha, em
// computeArtServiceDelta.
//
// Exemplo cfg.fields[i].config.choices = [
//   { value: 'p', label: 'Pequeno', price_delta: 0 },
//   { value: 'g', label: 'Grande',  price_delta: 5.00 }
// ]
// Se customization[fieldId] === 'g' → soma 5.00
// ─────────────────────────────────────────────
function computeChoicesDelta(cfg, customization) {
  if (!cfg || !Array.isArray(cfg.fields) || !customization) return 0;
  let delta = 0;
  for (const f of cfg.fields) {
    if (!f || (f.type !== 'option' && f.type !== 'color')) continue;
    if (ehCampoDeServicoDeArte(f)) continue;
    delta += deltaDoCampo(f, customization);
  }
  return delta;
}

/**
 * O servico de arte escolhido na linha (`adjust` / `designer`), cobrado
 * UMA VEZ por linha da sacola, qualquer que seja a quantidade.
 */
function computeArtServiceDelta(cfg, customization) {
  if (!cfg || !Array.isArray(cfg.fields) || !customization) return 0;
  let delta = 0;
  for (const f of cfg.fields) {
    if (ehCampoDeServicoDeArte(f)) delta += deltaDoCampo(f, customization);
  }
  return delta;
}

// ─────────────────────────────────────────────
// computeBackDelta — retorna o valor cobrado pelo verso quando
// o cliente marca `customization.has_back_selected = true` E o
// produto tem cfg.has_back=true E cfg.back_charge_enabled=true.
// Retorna 0 em qualquer outro cenário (backwards-compatible).
// ─────────────────────────────────────────────
function computeBackDelta(cfg, customization) {
  if (!cfg || cfg.has_back !== true) return 0;
  if (cfg.back_charge_enabled !== true) return 0;
  if (!customization || customization.has_back_selected !== true) return 0;
  const v = cfg.back_price_delta;
  if (typeof v !== 'number' || !isFinite(v) || v <= 0) return 0;
  return v;
}

// ─────────────────────────────────────────────
// computeMiddleDelta — mesmo contrato do verso, para a faixa central /
// wrap 360 (caneca, copo). Cobrado so quando o cliente marca
// `customization.has_middle_selected = true` e a loja ligou a cobranca.
// ─────────────────────────────────────────────
function computeMiddleDelta(cfg, customization) {
  if (!cfg || cfg.has_middle !== true) return 0;
  if (cfg.middle_charge_enabled !== true) return 0;
  if (!customization || customization.has_middle_selected !== true) return 0;
  const v = cfg.middle_price_delta;
  if (typeof v !== 'number' || !isFinite(v) || v <= 0) return 0;
  return v;
}

/**
 * As faixas de quantidade da loja, relidas do banco — nunca aceitas do
 * cliente: preco de venda e decisao do servidor. Regra do produto vence;
 * sem ela, a regra global (`product_id IS NULL`), a mesma queda que a
 * listagem faz. Base sem a tabela/coluna: sem faixa (sem desconto).
 */
async function carregarFaixas(db, cid) {
  const faixas = {};
  try {
    const { rows } = await db.query(
      `SELECT product_id, qty_tiers
         FROM studio_pricing_rules
        WHERE company_id = $1 AND is_active IS NOT FALSE
          AND qty_tiers IS NOT NULL`,
      [cid]
    );
    rows.forEach((r) => { faixas[r.product_id] = r.qty_tiers; });
    if (faixas['null'] != null) faixas.__global = faixas['null'];
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
  }
  return faixas;
}

function faixasDoProduto(faixas, productId) {
  if (!faixas) return null;
  return faixas[productId] ?? faixas.__global ?? null;
}

/**
 * A faixa que a quantidade atingiu, no formato que a tela mostra
 * (`{ min_qty, pct }`), ou null quando nenhuma faixa baixa o preco.
 */
function faixaAplicada(listPrice, rawTiers, qty) {
  const base = Number(listPrice) || 0;
  if (base <= 0) return null;
  const tier = matchTier(parseTiers(rawTiers), qty);
  if (!tier) return null;
  const unit = unitPriceForQty(base, rawTiers, qty);
  if (!(unit < base)) return null;
  return { min_qty: tier.min_qty, pct: Math.round(((base - unit) / base) * 1000) / 10 };
}

/**
 * O preco de UMA linha. Pura: recebe o produto do banco, as faixas dele,
 * a quantidade e a personalizacao, e devolve cada parcela da conta.
 *
 * `preco_unitario` NAO inclui a arte (ela nao e por unidade); `total`
 * inclui. E o que vai para digital_order_items.unit_price e .subtotal.
 */
function precoDaLinha({ produto, faixas, quantidade, customization }) {
  const cfg = produto.customization_config;
  const listPrice = parseFloat(produto.price);
  // S6 — a faixa incide sobre o preco de tabela; os deltas de
  // personalizacao sao adicionais e entram DEPOIS.
  const base = unitPriceForQty(listPrice, faixas, quantidade);
  const opcoes = computeChoicesDelta(cfg, customization);
  const verso = computeBackDelta(cfg, customization);
  const meio = computeMiddleDelta(cfg, customization);
  const arte = computeArtServiceDelta(cfg, customization);
  const precoUnitario = base + opcoes + verso + meio;
  return {
    lista: listPrice,
    base,
    opcoes,
    verso,
    meio,
    arte,
    preco_unitario: precoUnitario,
    total: precoUnitario * quantidade + arte,
    faixa: faixaAplicada(listPrice, faixas, quantidade),
  };
}

/**
 * Valida e precifica os itens de um pedido (ou de uma cotacao).
 *
 * `produtos` e o mapa id → linha de products ja filtrada pela visibilidade
 * da loja; `validar(cfg, customization)` e a validacao de campos
 * obrigatorios da rota (injetada para este modulo nao depender dela).
 *
 * Devolve `{ erro, indice }` no primeiro item recusado — com a MESMA
 * mensagem que o pedido sempre deu — ou `{ linhas, subtotal }`.
 */
function cotarItens({ items, produtos, faixas, validar }) {
  const linhas = [];
  let subtotal = 0;
  for (let indice = 0; indice < items.length; indice++) {
    const item = items[indice] || {};
    const p = produtos[item.product_id];
    if (!p) return { erro: `Produto ${item.product_id} nao encontrado`, indice };
    if (p.is_active === false) return { erro: `Produto "${p.name}" nao esta disponivel`, indice };
    if (!p.is_personalizable) {
      return { erro: `Produto "${p.name}" nao e personalizavel — use /storefront/:slug/order`, indice };
    }

    const qty = parseInt(item.quantity) || 1;
    if (qty < 1) return { erro: `Quantidade invalida para "${p.name}"`, indice };

    const valErr = validar ? validar(p.customization_config, item.customization) : null;
    if (valErr) return { erro: `Personalizacao de "${p.name}": ${valErr}`, indice };

    const preco = precoDaLinha({
      produto: p,
      faixas: faixasDoProduto(faixas, p.id),
      quantidade: qty,
      customization: item.customization,
    });
    subtotal += preco.total;
    linhas.push({ indice, produto: p, quantidade: qty, customization: item.customization || null, preco });
  }
  return { linhas, subtotal };
}

/**
 * Desconto do Pix — a MESMA conta da loja comum (storefront.js): o
 * percentual e da loja, incide so sobre o subtotal (frete fora) e so
 * quando a forma de pagamento e Pix.
 */
function descontoDoPix(subtotal, pixPct) {
  const pct = Number(pixPct) || 0;
  return pct > 0 ? Math.round(subtotal * pct) / 100 : 0;
}

function totaisDoPedido({ subtotal, pixPct, formaDePagamento, frete }) {
  const descontoPix = descontoDoPix(subtotal, pixPct);
  const desconto = formaDePagamento === 'pix' ? descontoPix : 0;
  const fee = Number(frete) || 0;
  return {
    subtotal,
    desconto_pix: descontoPix,
    discount_amount: desconto,
    frete: fee,
    total: subtotal - desconto + fee,
    total_pix: subtotal - descontoPix + fee,
  };
}

/**
 * Dias uteis que a loja promete para a sacola: o maior entre as linhas.
 * Cada linha vale o prazo da faixa em que caiu (lead_days) ou, sem ele,
 * o prazo padrao da loja (studio_settings.default_sla_days, 3 se vazio).
 * Mesma leitura do checkout no mockup ("pelo maior prazo das faixas").
 */
function prazoDaSacola(slaBase, linhas) {
  const padrao = Number.isFinite(Number(slaBase)) && Number(slaBase) > 0 ? parseInt(slaBase, 10) : 3;
  let prazo = 0;
  for (const l of linhas || []) {
    const lead = leadDaysForQty(l.faixas, l.quantidade);
    prazo = Math.max(prazo, lead != null ? lead : padrao);
  }
  return prazo || padrao;
}

/** Centavos, para resposta. A conta interna nao arredonda no meio. */
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * Os itens como o Mercado Pago cobra no cartao: a arte vira um item
 * proprio de quantidade 1. Somar a arte no unit_price dividiria R$ 10 em
 * tres canecas (3,333...) e o MP arredondaria cada uma.
 */
function itensParaCobranca(orderItems) {
  const out = [];
  for (const it of orderItems) {
    out.push(it);
    if (it._art_delta > 0) {
      out.push({
        product_id: it.product_id,
        product_name: `Servico de arte — ${it.product_name}`,
        unit_price: it._art_delta,
        quantity: 1,
      });
    }
  }
  return out;
}

module.exports = {
  ART_SERVICE_FIELD_ID,
  ehCampoDeServicoDeArte,
  computeChoicesDelta,
  computeArtServiceDelta,
  computeBackDelta,
  computeMiddleDelta,
  carregarFaixas,
  faixasDoProduto,
  faixaAplicada,
  precoDaLinha,
  cotarItens,
  descontoDoPix,
  totaisDoPedido,
  prazoDaSacola,
  itensParaCobranca,
  r2,
};
