-- ============================================================
-- AURA. — Hub Social: Instagram (P11 S3)
-- Aplicada em producao via MCP Supabase em 25/04/2026.
-- Arquivo espelho criado conforme regra de migration da sessao.
--
-- Tabelas para armazenar DMs, comentarios e mencoes recebidas
-- via webhook do Instagram Graph API.
-- ============================================================

-- ig_account_id na tabela companies (vinculo empresa <-> conta IG)
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS ig_account_id       varchar(30),
  ADD COLUMN IF NOT EXISTS ig_access_token     text,
  ADD COLUMN IF NOT EXISTS ig_token_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_companies_ig_account
  ON companies(ig_account_id) WHERE ig_account_id IS NOT NULL;

-- Mensagens diretas (DMs)
CREATE TABLE IF NOT EXISTS ig_messages (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  direction      varchar(10) NOT NULL CHECK (direction IN ('inbound','outbound')),
  ig_message_id  varchar(80) NOT NULL UNIQUE,
  from_ig_id     varchar(30),
  to_ig_id       varchar(30),
  content        text,
  status         varchar(20) NOT NULL DEFAULT 'received',
  metadata       jsonb,
  created_at     timestamptz NOT NULL DEFAULT NOW(),
  updated_at     timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ig_messages_company
  ON ig_messages(company_id, created_at DESC);

-- Comentarios em posts
CREATE TABLE IF NOT EXISTS ig_comments (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ig_comment_id   varchar(80) NOT NULL UNIQUE,
  ig_media_id     varchar(80),
  from_ig_id      varchar(30),
  text            text,
  replied_at      timestamptz,
  reply_text      text,
  created_at      timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ig_comments_company
  ON ig_comments(company_id, created_at DESC);

-- Mencoes (buscadas via Graph API polling)
CREATE TABLE IF NOT EXISTS ig_mentions (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ig_media_id       varchar(80) NOT NULL,
  mentioned_by_ig_id varchar(30),
  media_type        varchar(20),
  caption           text,
  permalink         text,
  fetched_at        timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, ig_media_id)
);

CREATE INDEX IF NOT EXISTS idx_ig_mentions_company
  ON ig_mentions(company_id, fetched_at DESC);
