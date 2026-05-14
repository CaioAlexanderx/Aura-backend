-- ============================================================
-- Migration 113 - agent (Vendedor IA Aura SDR conversacional B2B)
--
-- 14/05/2026: Fase 0 do Vendedor IA Aura.
--
-- Cria as 5 tabelas-base do modulo /agent:
--   - agent_leads          : cadastro de leads (Phibo + scraping + inbound)
--   - agent_conversations  : 1 por (lead, canal). Estado da conversa.
--   - agent_messages       : log append-only de cada turn (user/assistant/tool).
--   - agent_settings       : singleton por scope (scope='aura' = uso interno).
--   - agent_outbound_queue : fila de disparo respeitando warmup + caps.
--
-- E faz o seed inicial de agent_settings com scope='aura'.
--
-- Idempotente (CREATE TABLE IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING).
--
-- Doc: Aura/BACKLOG_VENDEDOR_IA_AURA.md
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_leads (
  id                      SERIAL PRIMARY KEY,
  source                  VARCHAR(30)  NOT NULL,
  phone                   VARCHAR(20),
  business_name           VARCHAR(200),
  contact_name            VARCHAR(120),
  vertical                VARCHAR(60),
  city                    VARCHAR(80),
  state                   VARCHAR(2),
  num_stores_estimate     INTEGER,
  revenue_band            VARCHAR(20),
  status                  VARCHAR(30)  NOT NULL DEFAULT 'new',
  qualification_score     INTEGER,
  qualification_notes     TEXT,
  assigned_to             VARCHAR(60),
  opted_out_at            TIMESTAMPTZ,
  opted_out_reason        VARCHAR(120),
  raw_payload             JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(source, phone)
);

CREATE INDEX IF NOT EXISTS idx_agent_leads_status   ON agent_leads(status);
CREATE INDEX IF NOT EXISTS idx_agent_leads_phone    ON agent_leads(phone);
CREATE INDEX IF NOT EXISTS idx_agent_leads_source   ON agent_leads(source);
CREATE INDEX IF NOT EXISTS idx_agent_leads_updated  ON agent_leads(updated_at DESC);

COMMENT ON TABLE  agent_leads                     IS 'Vendedor IA Aura - leads B2B (Phibo + GMaps + Instagram + inbound)';
COMMENT ON COLUMN agent_leads.source              IS 'phibo | gmaps | instagram | inbound_site | inbound_ig';
COMMENT ON COLUMN agent_leads.status              IS 'new | enriching | ready_to_contact | contacted | engaged | qualified | handed_off | opted_out | dead';
COMMENT ON COLUMN agent_leads.revenue_band        IS '<10k | 10-30k | 30-80k | 80-200k | 200k+';
COMMENT ON COLUMN agent_leads.qualification_score IS '0-100. >=70 = qualified (handoff humano)';


CREATE TABLE IF NOT EXISTS agent_conversations (
  id                      SERIAL PRIMARY KEY,
  lead_id                 INTEGER REFERENCES agent_leads(id) ON DELETE CASCADE,
  channel                 VARCHAR(20)  NOT NULL,
  external_thread_id      VARCHAR(120),
  mode                    VARCHAR(20)  NOT NULL DEFAULT 'bot',
  killswitch_active       BOOLEAN      NOT NULL DEFAULT false,
  started_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_message_at         TIMESTAMPTZ,
  human_handoff_at        TIMESTAMPTZ,
  closed_at               TIMESTAMPTZ,
  outcome                 VARCHAR(30),
  UNIQUE(channel, external_thread_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_conv_lead ON agent_conversations(lead_id);
CREATE INDEX IF NOT EXISTS idx_agent_conv_mode ON agent_conversations(mode);
CREATE INDEX IF NOT EXISTS idx_agent_conv_last ON agent_conversations(last_message_at DESC);

COMMENT ON TABLE  agent_conversations          IS 'Vendedor IA Aura - 1 conversa por (lead, canal)';
COMMENT ON COLUMN agent_conversations.channel  IS 'whatsapp | instagram';
COMMENT ON COLUMN agent_conversations.mode     IS 'bot (IA respondendo) | human (Caio assumiu) | paused (killswitch)';
COMMENT ON COLUMN agent_conversations.outcome  IS 'qualified | not_qualified | no_response | opted_out';


CREATE TABLE IF NOT EXISTS agent_messages (
  id                      BIGSERIAL PRIMARY KEY,
  conversation_id         INTEGER     NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  role                    VARCHAR(20) NOT NULL,
  content                 TEXT,
  tool_name               VARCHAR(60),
  tool_args               JSONB,
  tool_result             JSONB,
  model                   VARCHAR(40),
  tokens_in               INTEGER,
  tokens_out              INTEGER,
  cost_usd                NUMERIC(10,6),
  latency_ms              INTEGER,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_conv ON agent_messages(conversation_id, created_at);

COMMENT ON TABLE  agent_messages          IS 'Vendedor IA Aura - log append-only de cada turn (audit + replay)';
COMMENT ON COLUMN agent_messages.role     IS 'user | assistant | tool | system';
COMMENT ON COLUMN agent_messages.model    IS 'claude-haiku-4-5 (Haiku-only por design, ver backlog)';


CREATE TABLE IF NOT EXISTS agent_settings (
  id                      SERIAL PRIMARY KEY,
  scope                   VARCHAR(40) NOT NULL DEFAULT 'aura',
  tone                    VARCHAR(30) NOT NULL DEFAULT 'casual_br',
  business_hours_start    TIME        NOT NULL DEFAULT '08:00',
  business_hours_end      TIME        NOT NULL DEFAULT '20:00',
  daily_outbound_cap      INTEGER     NOT NULL DEFAULT 20,
  per_lead_max_messages   INTEGER     NOT NULL DEFAULT 4,
  killswitch_global       BOOLEAN     NOT NULL DEFAULT false,
  model                   VARCHAR(40) NOT NULL DEFAULT 'claude-haiku-4-5',
  config                  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(scope)
);

COMMENT ON TABLE  agent_settings                   IS 'Vendedor IA Aura - settings por scope. scope=aura uso interno; scope=company:<id> feature B2C futura';
COMMENT ON COLUMN agent_settings.scope             IS 'aura (uso interno B2B SDR) | company:<id> (feature paga futura)';
COMMENT ON COLUMN agent_settings.killswitch_global IS 'Toggle global. Quando true, agente PARA de responder e conversas viram fila humana';

-- Seed: linha unica scope='aura'
INSERT INTO agent_settings (scope, tone, daily_outbound_cap, per_lead_max_messages, killswitch_global, model)
VALUES ('aura', 'casual_br', 20, 4, false, 'claude-haiku-4-5')
ON CONFLICT (scope) DO NOTHING;


CREATE TABLE IF NOT EXISTS agent_outbound_queue (
  id                      SERIAL PRIMARY KEY,
  lead_id                 INTEGER     NOT NULL REFERENCES agent_leads(id) ON DELETE CASCADE,
  template_name           VARCHAR(80) NOT NULL,
  scheduled_for           TIMESTAMPTZ NOT NULL,
  status                  VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempt_count           INTEGER     NOT NULL DEFAULT 0,
  last_error              TEXT,
  sent_at                 TIMESTAMPTZ,
  meta_message_id         VARCHAR(120),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbound_queue_status ON agent_outbound_queue(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_outbound_queue_lead   ON agent_outbound_queue(lead_id);

COMMENT ON TABLE  agent_outbound_queue        IS 'Vendedor IA Aura - fila de disparo outbound (warmup + caps)';
COMMENT ON COLUMN agent_outbound_queue.status IS 'pending | sent | failed | cancelled';
