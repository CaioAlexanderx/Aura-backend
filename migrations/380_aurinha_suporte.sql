-- ============================================================
-- 380 — AURINHA DE PLANTÃO: persona de suporte e ferramentas
--
-- A 375 abriu o chão (WhatsApp da Aura no hub, relógio, fila). Esta abre o
-- que as ferramentas da persona de suporte gravam (services/aurinhaSuporte.js):
--
--   hub_agendamentos → pedido de conversa de 20 minutos com o Caio. A
--       Aurinha NÃO marca: grava duas opções de horário comercial e o Caio
--       confirma. company_id é a CONTA do cliente quando o telefone foi
--       identificado — pode ser NULL (quem ainda não é cliente também pede
--       conversa). hub_company_id é o tenant do hub (a Aura).
--   hub_agent_events.type → 2 tipos novos:
--       'pendencia_suporte'  → o que ficou para o Caio (problema técnico,
--                              "não sei", cobrança): detail = { tipo, resumo,
--                              detalhes, telefone, conta }.
--       'ferramenta_suporte' → auditoria de cada ferramenta usada. É também
--                              o que conta o limite de uso por conversa.
--   idx_audit_log_aurinha_trial → UMA extensão de trial pela Aurinha por
--       conta, para sempre. O código confere antes; o índice é a trava que
--       não depende do código (duas conversas ao mesmo tempo).
--
-- Tudo idempotente. FKs só para companies / hub_conversations. O runtime
-- guarda 42P01/42703/23514 até a migration subir.
-- ============================================================

CREATE TABLE IF NOT EXISTS hub_agendamentos (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hub_company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  conversation_id     UUID REFERENCES hub_conversations(id) ON DELETE SET NULL,
  company_id          UUID REFERENCES companies(id) ON DELETE SET NULL,
  telefone            TEXT NOT NULL,
  nome                TEXT,
  assunto             TEXT,
  duracao_minutos     INTEGER NOT NULL DEFAULT 20,
  opcoes              JSONB NOT NULL,                      -- ["2026-10-14T10:00:00-03:00", ...]
  status              TEXT NOT NULL DEFAULT 'pendente'
                        CHECK (status IN ('pendente','confirmado','cancelado','realizado')),
  horario_confirmado  TIMESTAMPTZ,
  origem              TEXT NOT NULL DEFAULT 'aurinha',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hub_agendamentos_status
  ON hub_agendamentos(hub_company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hub_agendamentos_telefone
  ON hub_agendamentos(telefone) WHERE status = 'pendente';

-- hub_agent_events.type é CHECK fechado (312 → 375 → 376). Recria com os 2 novos.
ALTER TABLE hub_agent_events DROP CONSTRAINT IF EXISTS hub_agent_events_type_check;
ALTER TABLE hub_agent_events
  ADD CONSTRAINT hub_agent_events_type_check CHECK (type IN
    ('categorizada','resposta_sugerida','aprovada','editada','rejeitada',
     'handoff','enviada','erro','assumida','resolvida','reaberta',
     'mensagem_recebida','mensagem_humana','resposta_agendada','resposta_enfileirada',
     'resumo_madrugada',
     'pendencia_suporte','ferramenta_suporte'));

CREATE INDEX IF NOT EXISTS idx_hub_events_pendencia_suporte
  ON hub_agent_events (company_id, created_at DESC) WHERE type = 'pendencia_suporte';

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_log_aurinha_trial
  ON audit_log (company_id) WHERE action = 'aurinha.trial_estendido';

-- ============================================================
-- FIM DA MIGRATION 380
-- ============================================================
