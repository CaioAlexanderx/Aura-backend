-- ============================================================
-- 375 — AURINHA DE PLANTÃO: WhatsApp da Aura no hub
--
-- Fase 3 do plano de 13/10/2026. O número do site (WhatsApp pessoal do
-- Caio, ligado à Cloud API em coexistência) passa a cair no hub como um
-- canal 'whatsapp' do tenant Aura, e a Aurinha atende de madrugada.
-- Esta migration só abre o chão para isso; nada liga sozinho:
--
--   hub_agent_settings.wa_phone_number_id → o phone_number_id da Meta
--       que o webhook deve ROTEAR para o hub (em vez do fluxo das lojas).
--       Único. Não é editável pelo PUT /hub/settings de propósito: se
--       fosse, uma loja poderia apontar para o número de outra.
--   hub_agent_settings.plantao            → relógio de plantão (jsonb):
--       { ativo, noite_inicio, noite_fim, espera_minutos, template }.
--       Vazio = defaults do código (21:00–08:00, 15 min).
--   hub_conversations.aguardando_resposta_desde → o cliente falou e
--       ninguém (nem a Aurinha, nem o humano) respondeu ainda. É o que o
--       job por minuto reavalia. Declarado, não deduzido das mensagens.
--   hub_conversations.ultima_mensagem_humana_em → última vez que um
--       HUMANO falou (eco do app do celular em coexistência, ou resposta
--       pelo painel). Entra no relógio de plantão.
--   hub_messages       → mensagens do hub em canais que não têm tabela
--       própria (whatsapp). ig_messages continua sendo do Instagram.
--       Único por (company, canal, id da mensagem na Meta): é a
--       idempotência do webhook.
--   wa_outbox.hub_conversation_id → "origem hub": a linha da fila nasceu
--       de uma conversa do hub. A janela de 24h dela vem da conversa
--       (hub_conversations.last_inbound_at), não de wa_contacts.
--   hub_agent_events.type → 4 tipos novos (roteamento e plantão).
--
-- Tudo idempotente. FKs só para companies / hub_* / wa_outbox (307) — todas
-- do diretório oficial. O runtime guarda 42703/42P01 até a migration subir.
-- ============================================================

ALTER TABLE hub_agent_settings
  ADD COLUMN IF NOT EXISTS wa_phone_number_id TEXT,
  ADD COLUMN IF NOT EXISTS plantao            JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS idx_hub_settings_wa_phone_number_id
  ON hub_agent_settings(wa_phone_number_id) WHERE wa_phone_number_id IS NOT NULL;

ALTER TABLE hub_conversations
  ADD COLUMN IF NOT EXISTS aguardando_resposta_desde  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ultima_mensagem_humana_em  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_hub_conv_aguardando
  ON hub_conversations(aguardando_resposta_desde) WHERE aguardando_resposta_desde IS NOT NULL;

CREATE TABLE IF NOT EXISTS hub_messages (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  conversation_id      UUID NOT NULL REFERENCES hub_conversations(id) ON DELETE CASCADE,
  channel              TEXT NOT NULL,                       -- 'whatsapp'
  direction            TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  author               TEXT NOT NULL CHECK (author IN ('cliente','aurinha','humano')),
  external_message_id  TEXT,                                -- wamid da Meta
  content              TEXT,
  metadata             JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hub_messages_external
  ON hub_messages(company_id, channel, external_message_id) WHERE external_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hub_messages_conversation
  ON hub_messages(conversation_id, created_at);

ALTER TABLE wa_outbox
  ADD COLUMN IF NOT EXISTS hub_conversation_id UUID REFERENCES hub_conversations(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_wa_outbox_hub_conversation
  ON wa_outbox(hub_conversation_id) WHERE hub_conversation_id IS NOT NULL;

-- hub_agent_events.type é CHECK fechado (312). Recria com os 4 tipos novos.
ALTER TABLE hub_agent_events DROP CONSTRAINT IF EXISTS hub_agent_events_type_check;
ALTER TABLE hub_agent_events
  ADD CONSTRAINT hub_agent_events_type_check CHECK (type IN
    ('categorizada','resposta_sugerida','aprovada','editada','rejeitada',
     'handoff','enviada','erro','assumida','resolvida','reaberta',
     'mensagem_recebida','mensagem_humana','resposta_agendada','resposta_enfileirada'));

-- ============================================================
-- FIM DA MIGRATION 375
-- ============================================================
