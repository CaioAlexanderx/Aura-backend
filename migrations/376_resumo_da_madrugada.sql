-- ============================================================
-- 376 — RESUMO DA MADRUGADA (bloco Contatos do painel + e-mail das 8h)
--
-- O WhatsApp da Aura (375) já grava as conversas no hub. Esta migration só
-- abre o chão para o resumo das 8h do que chegou entre 21h e 8h:
--
--   hub_agent_events.type → ganha 'resumo_madrugada'. É o registro do
--       resumo do dia: detail = { dia, total, itens, texto, entrega }.
--   idx_hub_events_resumo_madrugada_dia → UM resumo por (empresa, dia).
--       É a trava de idempotência: duas instâncias, ou o job rodando de
--       novo depois de um deploy, nunca mandam o e-mail duas vezes.
--   idx_hub_messages_company_created → o bloco Contatos e o alerta leem as
--       mensagens do WhatsApp por janela de tempo (a 375 só indexou por
--       conversa).
--
-- Tudo idempotente. Nenhuma tabela nova.
-- ============================================================

ALTER TABLE hub_agent_events DROP CONSTRAINT IF EXISTS hub_agent_events_type_check;
ALTER TABLE hub_agent_events
  ADD CONSTRAINT hub_agent_events_type_check CHECK (type IN
    ('categorizada','resposta_sugerida','aprovada','editada','rejeitada',
     'handoff','enviada','erro','assumida','resolvida','reaberta',
     'mensagem_recebida','mensagem_humana','resposta_agendada','resposta_enfileirada',
     'resumo_madrugada'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_hub_events_resumo_madrugada_dia
  ON hub_agent_events (company_id, (detail->>'dia'))
  WHERE type = 'resumo_madrugada';

CREATE INDEX IF NOT EXISTS idx_hub_messages_company_created
  ON hub_messages (company_id, created_at);

-- ============================================================
-- FIM DA MIGRATION 376
-- ============================================================
