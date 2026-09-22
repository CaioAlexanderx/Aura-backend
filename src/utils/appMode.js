// ============================================================
// AURA. — appMode: por onde o cliente abriu o painel
//
// Criado: 22/09/2026 (PWA Fase 2)
//
// O front manda X-Aura-App: standalone quando o painel foi aberto pelo
// ícone do app instalado (display-mode: standalone). Aqui o valor vira um
// dos dois que a coluna refresh_tokens.app_mode aceita, ou null. Qualquer
// coisa fora da lista é ignorada: cabeçalho é entrada do cliente.
// ============================================================
'use strict';

const VALORES = new Set(['standalone', 'browser']);

/**
 * @param {unknown} valor o cabeçalho X-Aura-App como veio
 * @returns {'standalone'|'browser'|null}
 */
function appModeDoCabecalho(valor) {
  if (typeof valor !== 'string') return null;
  const v = valor.trim().toLowerCase();
  return VALORES.has(v) ? v : null;
}

module.exports = { appModeDoCabecalho, VALORES_DE_APP_MODE: VALORES };
