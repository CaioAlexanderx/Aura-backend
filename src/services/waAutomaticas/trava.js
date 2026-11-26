// ============================================================
// AURA — WhatsApp: a TRAVA das automáticas novas (tela nova, 26/11/2026)
//
// WA_AUTOMATICAS_ENABLED desligado = o job novo não roda. Enquanto estiver
// desligado, nada da tela nova pode tirar uma loja dos jobs antigos
// (aniversário, reativação, régua do crediário) nem ser ligado: senão a
// cobrança antiga para e a nova não roda. Módulo à parte (sem dependências)
// para o job, as rotas e os jobs antigos lerem a mesma resposta.
// ============================================================
'use strict';

function ligada() {
  return ['1', 'true', 'sim', 'on'].includes(String(process.env.WA_AUTOMATICAS_ENABLED || '').trim().toLowerCase());
}

module.exports = { ligada };
