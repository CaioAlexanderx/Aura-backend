-- ============================================================
-- 307 — ONDA 5b: COBRANÇA POR WHATSAPP (Cloud API, sandbox-ready)
--
-- Três peças + o canal automático na régua do dojô:
--   wa_contacts  → opt-in/opt-out POR TELEFONE por company + janela de
--                  24h (last_inbound_at, atualizada pelo webhook).
--                  Palavras de saída (SAIR/PARAR/STOP) marcam opt-out.
--   wa_templates → registro dos templates HSM por company; o STATUS vem
--                  do webhook message_template_status_update (já
--                  assinado na Meta) — nunca "achamos" que está aprovado.
--   wa_outbox    → fila de envio com retry/backoff; o dispatcher
--                  (waDispatcherJob) processa; wa_message_id liga aos
--                  status sent→delivered→read do webhook.
--   karate_dojo_reminder_config.send_whatsapp_auto → a pista manual de
--                  WhatsApp da régua (wa.me) ganha modo AUTOMÁTICO.
--
-- FKs só para tabelas do diretório principal (companies). wa_messages e
-- companies.wa_* são de src/migrations/039 (fora do CI) — nenhuma
-- referência DDL a elas aqui; o runtime guarda 42703/42P01.
-- ============================================================

CREATE TABLE IF NOT EXISTS wa_contacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  phone           TEXT NOT NULL,              -- E.164 sem '+' (só dígitos)
  display_name    TEXT,
  opted_in_at     TIMESTAMPTZ,
  opted_out_at    TIMESTAMPTZ,
  opt_source      TEXT,                       -- 'inbound' | 'manual' | 'import'
  last_inbound_at TIMESTAMPTZ,                -- abre a janela de 24h
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_wa_contacts_company ON wa_contacts(company_id);

CREATE TABLE IF NOT EXISTS wa_templates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  language         TEXT NOT NULL DEFAULT 'pt_BR',
  category         TEXT,                      -- UTILITY | MARKETING | AUTHENTICATION
  body_preview     TEXT,
  meta_template_id TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending|APPROVED|REJECTED|PAUSED|...
  last_status_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name, language)
);

CREATE TABLE IF NOT EXISTS wa_outbox (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  to_phone          TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'template' CHECK (kind IN ('template','text')),
  template_name     TEXT,
  template_language TEXT DEFAULT 'pt_BR',
  components        JSONB,
  text_body         TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','sending','sent','delivered','read','failed','skipped')),
  skip_reason       TEXT,                     -- 'OPT_OUT' | 'SEM_CREDENCIAIS' | 'JANELA_FECHADA'
  attempts          INT NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error        TEXT,
  wa_message_id     TEXT,
  source_type       TEXT,                     -- ex.: 'dojo_mensalidade' | 'teste'
  source_id         TEXT,
  dedupe_key        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_outbox_dedupe
  ON wa_outbox(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wa_outbox_pending
  ON wa_outbox(next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_wa_outbox_company
  ON wa_outbox(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_outbox_wamid
  ON wa_outbox(wa_message_id) WHERE wa_message_id IS NOT NULL;

-- Régua do dojô (245): o canal WhatsApp ganha modo automático.
ALTER TABLE karate_dojo_reminder_config
  ADD COLUMN IF NOT EXISTS send_whatsapp_auto BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- FIM DA MIGRATION 307
-- ============================================================
