-- ============================================================
-- AURA. — Migration 347: e-mail das notificações de empresa específica
--
-- Mockup aprovado pelo Caio em 18/09/2026.
--
-- A Gestão Aura (Endomarketing) passa a poder mandar por e-mail um banner
-- que tem target_company_id — só esses; "Todos" e "Por plano" continuam
-- só no sino. Cada envio para cada destinatário vira uma linha aqui:
-- quem mandou, para quem, com que assunto, e o que o provedor respondeu.
-- A lista de banners lê daqui o "e-mail enviado dd/mm hh:mm".
--
-- Sem política de RLS: só o backend (service role) lê e escreve.
-- ============================================================

CREATE TABLE IF NOT EXISTS app_notification_emails (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID        NOT NULL REFERENCES app_notifications(id) ON DELETE CASCADE,
  company_id      UUID        REFERENCES companies(id) ON DELETE SET NULL,
  recipient       TEXT        NOT NULL,
  subject         TEXT        NOT NULL,
  status          TEXT        NOT NULL CHECK (status IN ('sent', 'failed')),
  provider_id     TEXT,           -- id devolvido pelo Resend
  error           TEXT,           -- motivo quando status = 'failed'
  sent_by         UUID,           -- users.id de quem clicou em enviar
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_notification_emails_notification
  ON app_notification_emails (notification_id, created_at DESC);

ALTER TABLE app_notification_emails ENABLE ROW LEVEL SECURITY;
