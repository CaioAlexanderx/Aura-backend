// ============================================================
// AURA Studio — Serviço de arte como padrão da loja (28/09/2026)
//
// ── POR QUE EXISTE ─────────────────────────────────────────────────────
// Cada produto personalizável tem o campo `art_service` (type 'option',
// config.is_art_service) com as choices 'none', 'adjust' e 'designer',
// cada uma com price_delta. A lojista digitava os dois preços pagos
// produto a produto. Decisão do PO (Caio, 28/09/2026): os preços viram
// PADRÃO DA LOJA, com exceção por produto.
//
// ── COMO FUNCIONA ──────────────────────────────────────────────────────
// - O padrão mora em companies.studio_settings.art_service_defaults:
//   { adjust_price, design_price } em R$.
// - O app grava no customization_config do produto a chave de raiz
//   `art_service_use_store_default: true` quando o produto segue o
//   padrão. Ausente/false = preços próprios, não mexemos.
// - Quando o padrão muda (PATCH /studio/settings), o backend reescreve o
//   price_delta das choices 'adjust' e 'designer' dos produtos que seguem
//   o padrão. A vitrine e o cálculo de preço (precoDoStudio.js) continuam
//   lendo SÓ o price_delta das choices: nada muda neles.
// ============================================================
'use strict';

const { ehCampoDeServicoDeArte } = require('./precoDoStudio');

/** Flag de raiz no customization_config: o produto segue o padrão da loja. */
const FLAG_SEGUE_PADRAO = 'art_service_use_store_default';

/** Choice → chave do padrão da loja. 'none' fica de fora (é sempre 0). */
const PRECO_POR_CHOICE = { adjust: 'adjust_price', designer: 'design_price' };

function precoValido(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return false;
  // No máximo 2 casas (tolerância de ponto flutuante: 0.1 + 0.2 etc.)
  return Math.abs(Math.round(v * 100) - v * 100) < 1e-6;
}

/**
 * Valida o body `art_service_defaults` do PATCH /settings.
 * Aceita números ou strings numéricas ("12.50"); normaliza para número.
 * @returns {{ ok: true, value: { adjust_price: number, design_price: number } } | { ok: false, error: string }}
 */
function validarPadraoDoServicoDeArte(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'art_service_defaults deve ser um objeto { adjust_price, design_price }' };
  }
  const out = {};
  for (const [chave, rotulo] of [['adjust_price', 'ajustar a arte'], ['design_price', 'criar do zero']]) {
    let v = raw[chave];
    if (typeof v === 'string' && v.trim() !== '') v = Number(v.trim().replace(',', '.'));
    if (!precoValido(v)) {
      return {
        ok: false,
        error: `art_service_defaults.${chave} (preço de "${rotulo}") deve ser um número ≥ 0 com no máximo 2 casas decimais`,
      };
    }
    out[chave] = Math.round(v * 100) / 100;
  }
  return { ok: true, value: out };
}

/**
 * Aplica o padrão da loja ao customization_config de um produto.
 * Função pura: não altera o `config` recebido.
 *
 * @param {object} config   customization_config do produto
 * @param {{ adjust_price: number, design_price: number }} defaults
 * @returns {object|null}   config novo, ou null se nada mudou (produto sem
 *                          a flag, sem o campo art_service, ou já com os
 *                          mesmos preços)
 */
function aplicarPadraoDoServicoDeArte(config, defaults) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  if (config[FLAG_SEGUE_PADRAO] !== true) return null;
  if (!Array.isArray(config.fields) || !defaults) return null;

  let mudou = false;
  const fields = config.fields.map((f) => {
    if (!ehCampoDeServicoDeArte(f)) return f;
    const choices = f.config && f.config.choices;
    if (!Array.isArray(choices)) return f;
    const novasChoices = choices.map((c) => {
      const chave = c && PRECO_POR_CHOICE[c.value];
      if (!chave) return c;
      const preco = defaults[chave];
      if (typeof preco !== 'number' || !Number.isFinite(preco)) return c;
      if (c.price_delta === preco) return c;
      mudou = true;
      return { ...c, price_delta: preco };
    });
    return { ...f, config: { ...f.config, choices: novasChoices } };
  });

  return mudou ? { ...config, fields } : null;
}

module.exports = {
  FLAG_SEGUE_PADRAO,
  validarPadraoDoServicoDeArte,
  aplicarPadraoDoServicoDeArte,
};
