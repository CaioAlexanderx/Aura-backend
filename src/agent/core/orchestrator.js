// ============================================================
// AURA. - Vendedor IA - Orchestrator (stub Fase 0)
// ============================================================
// Entry point que recebe um turn de conversa e devolve a resposta
// (ou silencio quando killswitch). Fase 0 nao integra o LLM ainda
// — apenas registra turn em agent_messages e responde com stub.
//
// Fase 1 vai implementar:
//   - PromptBuilder (system + KB cacheada + historico)
//   - ToolDispatcher (searchAuraKb, qualifyLead, markForHumanHandoff, ...)
//   - Chamada Anthropic Haiku 4.5 com prompt-caching
//   - Loop tool-calling ate resposta final
//
// Doc: Aura/BACKLOG_VENDEDOR_IA_AURA.md secao 2.1
// ============================================================

const pool = require('../../config/database');
const guardrails = require('./guardrails');

async function handleTurn(input) {
  const conversationId = input && input.conversationId;
  const leadId         = input && input.leadId;
  const userMessage    = (input && input.userMessage) || '';

  if (!conversationId) {
    return { status: 'error', reason: 'missing_conversationId', response: null };
  }

  // Killswitch global
  if (await guardrails.isKillswitchActive()) {
    return { status: 'killed', reason: 'killswitch_global', response: null };
  }

  // Opt-out do lead
  if (leadId && await guardrails.isLeadOptedOut(leadId)) {
    return { status: 'blocked', reason: 'lead_opted_out', response: null };
  }

  // Registra turn do usuario
  await pool.query(
    `INSERT INTO agent_messages (conversation_id, role, content)
     VALUES ($1, 'user', $2)`,
    [conversationId, userMessage]
  );

  // Fase 0: stub. Fase 1 substitui por chamada Anthropic real.
  const stubResponse = '[stub fase 0] turn registrado; LLM nao integrado ainda';

  await pool.query(
    `INSERT INTO agent_messages (conversation_id, role, content, model)
     VALUES ($1, 'assistant', $2, NULL)`,
    [conversationId, stubResponse]
  );

  await pool.query(
    'UPDATE agent_conversations SET last_message_at = NOW() WHERE id = $1',
    [conversationId]
  );

  return { status: 'ok', response: stubResponse };
}

module.exports = { handleTurn };
