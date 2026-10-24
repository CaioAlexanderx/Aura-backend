-- ============================================================
-- AURA. — Migration 407: registro de envios de e-mail (tq-74, 24/10/2026)
--
-- Uma linha por e-mail enviado (src/services/emailLog.js). É a base da
-- idempotência dos e-mails do ciclo (cobrança, recibo, cartão recusado,
-- régua de atraso): cada envio novo tem chave_idempotencia única, reservada
-- ANTES de mandar. Reenvio do webhook da Asaas, reinício do processo ou dois
-- ticks do job nunca mandam o mesmo e-mail duas vezes.
--
-- Os demais e-mails (verificação, senha, convite, pedido, relatório) gravam
-- linha sem chave (NULL não conflita no UNIQUE).
--
--   status        reserved = chave tomada, envio em andamento
--                 sent     = o provedor aceitou (resend_id preenchido)
--                 failed   = o provedor recusou (erro); pode ser tentada de
--                            novo até 3 vezes pela mesma chave
--   delivered_at / bounced_at / complained_at / last_event
--                 para o webhook do Resend (tq-90), pela resend_id
--
-- Idempotente. Sem política de RLS: só o backend (service role) lê e grava.
-- ============================================================

CREATE TABLE IF NOT EXISTS email_log (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID        REFERENCES companies(id) ON DELETE SET NULL,
  user_id             UUID        REFERENCES users(id) ON DELETE SET NULL,
  tipo                TEXT        NOT NULL,
  destinatario        TEXT,
  assunto             TEXT,
  chave_idempotencia  TEXT        UNIQUE,
  status              TEXT        NOT NULL DEFAULT 'reserved'
                                  CHECK (status IN ('reserved', 'sent', 'failed')),
  resend_id           TEXT,
  erro                TEXT,
  tentativas          INTEGER     NOT NULL DEFAULT 0,
  metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  sent_at             TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  bounced_at          TIMESTAMPTZ,
  complained_at       TIMESTAMPTZ,
  last_event          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_log_company_data
  ON email_log (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_log_resend_id
  ON email_log (resend_id)
  WHERE resend_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_email_log_tipo_data
  ON email_log (tipo, created_at DESC);

ALTER TABLE email_log ENABLE ROW LEVEL SECURITY;
