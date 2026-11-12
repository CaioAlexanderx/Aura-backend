// ============================================================
// AURA. — Prazo do vale-troca da loja (12/11/2026)
//
// O vale-troca no cupom (aura-app#1056) nasceu como campanha de fim de ano,
// com datas fixas no app. A partir de 12/11/2026 vira funcao permanente: o
// lojista escolhe em Politicas do Caixa o prazo para troca em DIAS, e o cupom
// imprime "Troca ate DD/MM/AAAA" = dia da venda + N dias.
//
// A chave `vale_troca_prazo_dias` mora em companies.pdv_settings (jsonb, sem
// migration): inteiro de 1 a 365. Ausente (loja que nunca escolheu) = 30.
// A validacao do PUT fica em routes/pdvSettings.js; aqui e so a LEITURA,
// tolerante, para quem le o jsonb cru (ex.: GET /pdv/sales-for-troca, que
// devolve o prazo da loja DA VENDA -- no grupo multi-CNPJ a venda pode ser
// de outra filial).
//
// O cupom continua sendo montado pelo app: o backend nao imprime o vale.
// ============================================================

const CHAVE = 'vale_troca_prazo_dias';
const PRAZO_PADRAO_DIAS = 30;
const PRAZO_MIN_DIAS = 1;
const PRAZO_MAX_DIAS = 365;

/**
 * Prazo em dias a partir de um valor cru (numero ou texto, como sai de
 * `pdv_settings->>'vale_troca_prazo_dias'`). Fora da faixa, nao inteiro,
 * ausente ou lixo => padrao (30). Nunca lanca.
 */
function prazoDoValeEmDias(raw) {
  if (raw === null || raw === undefined || typeof raw === 'boolean') return PRAZO_PADRAO_DIAS;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n < PRAZO_MIN_DIAS || n > PRAZO_MAX_DIAS) return PRAZO_PADRAO_DIAS;
  return n;
}

/** Prazo da loja a partir do objeto pdv_settings (null/ausente => 30). */
function lerPrazoDoVale(pdvSettings) {
  if (!pdvSettings || typeof pdvSettings !== 'object') return PRAZO_PADRAO_DIAS;
  return prazoDoValeEmDias(pdvSettings[CHAVE]);
}

module.exports = {
  CHAVE,
  PRAZO_PADRAO_DIAS,
  PRAZO_MIN_DIAS,
  PRAZO_MAX_DIAS,
  prazoDoValeEmDias,
  lerPrazoDoVale,
};
