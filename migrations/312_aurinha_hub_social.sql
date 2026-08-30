-- ============================================================
-- 312 — AURINHA / HUB SOCIAL (MVP Instagram, piloto Finesse)
--
-- O agente de IA "Aurinha" responde DMs com dados reais da loja e o
-- hub unifica os canais (Instagram agora; WhatsApp e loja virtual nas
-- próximas fases — por isso `channel` já nasce multicanal).
--
--   hub_conversations  → uma linha por conversa (company + canal +
--                        id externo do cliente no canal). `status` diz
--                        quem está no comando (ia|precisa_humano|
--                        humano|resolvida); `category` é a triagem
--                        automática; `last_inbound_at` abre a janela
--                        de 24h da Meta.
--   ig_outbox          → fila de envio de DM Instagram, espelho da
--                        wa_outbox (307): retry/backoff, dedupe,
--                        skip auditável. `pending_approval` é o modo
--                        aprovação do piloto (lojista aprova antes).
--   hub_agent_events   → auditoria de tudo que a Aurinha fez
--                        (triagem, sugestão, handoff, aprovação).
--   hub_agent_settings → liga/desliga por company + modo aprovação.
--
-- FKs só para tabelas do diretório oficial: companies (base) e
-- ig_messages/hub_conversations (061/312). customer_id fica SEM FK de
-- propósito (vínculo lógico com customers, resolvido no runtime).
-- ============================================================

CREATE TABLE IF NOT EXISTS hub_conversations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  channel          TEXT NOT NULL CHECK (channel IN ('instagram','whatsapp','storefront')),
  external_id      TEXT NOT NULL,             -- IGSID (instagram) | telefone E.164 (whatsapp)
  customer_id      UUID,                      -- vínculo lógico com customers (sem FK — ver cabeçalho)
  customer_name    TEXT,                      -- nome/handle exibível do cliente no canal
  status           TEXT NOT NULL DEFAULT 'ia'
                     CHECK (status IN ('ia','precisa_humano','humano','resolvida')),
  category         TEXT CHECK (category IN ('produto','troca','entrega','pagamento','novidades')),
  handoff_reason   TEXT,
  assigned_user_id UUID,
  last_inbound_at  TIMESTAMPTZ,               -- abre a janela de 24h da Meta
  last_message_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, channel, external_id)
);
CREATE INDEX IF NOT EXISTS idx_hub_conv_company_recent
  ON hub_conversations(company_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_hub_conv_needs_human
  ON hub_conversations(company_id) WHERE status = 'precisa_humano';

-- Liga cada DM (061) à sua conversa. ig_messages é do diretório oficial,
-- FK segura. Coluna nova → runtime guarda 42703 até a migration aplicar.
ALTER TABLE ig_messages
  ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES hub_conversations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ig_messages_conversation
  ON ig_messages(conversation_id, created_at) WHERE conversation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ig_outbox (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  conversation_id  UUID REFERENCES hub_conversations(id) ON DELETE SET NULL,
  to_ig_id         TEXT NOT NULL,             -- IGSID do destinatário
  text_body        TEXT,
  payload          JSONB,                     -- cards estruturados (produto, pagamento) — fases futuras
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending_approval','pending','sending','sent','failed','skipped','rejected')),
  skip_reason      TEXT,                      -- 'SEM_CREDENCIAIS' | 'JANELA_FECHADA' | 'CONVERSA_NAO_IA'
  attempts         INT NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error       TEXT,
  ig_message_id    TEXT,                      -- mid devolvido pela Graph API
  source_type      TEXT,                      -- 'aurinha' | 'humano' | 'teste'
  source_id        TEXT,
  dedupe_key       TEXT,
  approved_by      UUID,                      -- user que aprovou/editou no modo aprovação
  edited_body      TEXT,                      -- texto final quando o humano editou a sugestão
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ig_outbox_dedupe
  ON ig_outbox(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ig_outbox_pending
  ON ig_outbox(next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_ig_outbox_approval
  ON ig_outbox(company_id, created_at DESC) WHERE status = 'pending_approval';
CREATE INDEX IF NOT EXISTS idx_ig_outbox_company
  ON ig_outbox(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hub_agent_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  conversation_id  UUID REFERENCES hub_conversations(id) ON DELETE CASCADE,
  type             TEXT NOT NULL CHECK (type IN
                     ('categorizada','resposta_sugerida','aprovada','editada','rejeitada',
                      'handoff','enviada','erro','assumida','resolvida','reaberta')),
  detail           JSONB,
  user_id          UUID,                      -- null quando o ator é a Aurinha
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hub_events_conversation
  ON hub_agent_events(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_hub_events_company
  ON hub_agent_events(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hub_agent_settings (
  company_id         UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  enabled            BOOLEAN NOT NULL DEFAULT false,
  approval_mode      BOOLEAN NOT NULL DEFAULT true,   -- piloto: Aurinha sugere, loja aprova
  model              TEXT,                             -- override do modelo (null = default do código)
  extra_instructions TEXT,                             -- instruções extras da loja no prompt (máx. controlado no runtime)
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- FIM DA MIGRATION 312
-- ============================================================
