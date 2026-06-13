-- ============================================================
-- 192_app_notifications.sql
-- App Notifications — Endomarketing banners + Phase 2 push stubs
-- Criado: 13/06/2026
--
-- Scope: banners de endomarketing criados pela Gestão Aura.
--        Avisos de pedido (Canal Digital + Studio) são computados
--        dinamicamente na rota GET /notifications — sem INSERT aqui.
-- ============================================================

-- Banners de endomarketing
CREATE TABLE IF NOT EXISTS app_notifications (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  type              TEXT        NOT NULL DEFAULT 'banner',
  title             TEXT        NOT NULL,
  body              TEXT,
  html_content      TEXT,           -- HTML completo renderizado via WebView/dangerouslySetInnerHTML
  cta_label         TEXT,           -- texto do botão CTA (ex: "Ver oferta")
  cta_url           TEXT,           -- URL externa do CTA
  cta_route         TEXT,           -- rota interna do app (ex: "/canal")
  target_company_id UUID REFERENCES companies(id) ON DELETE CASCADE, -- NULL = todas as empresas
  target_plan       TEXT,           -- NULL = todos os planos; 'negocio', 'expansao'
  is_active         BOOLEAN     NOT NULL DEFAULT true,
  expires_at        TIMESTAMPTZ,    -- NULL = sem expiração
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Leituras/dismissals de banners por empresa
CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id UUID        NOT NULL REFERENCES app_notifications(id) ON DELETE CASCADE,
  company_id      UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (notification_id, company_id)
);

-- Phase 2: tokens de push (stub — não usado no MVP de polling)
CREATE TABLE IF NOT EXISTS push_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id     UUID,       -- referência opcional ao usuário
  token       TEXT        NOT NULL,
  platform    TEXT        NOT NULL DEFAULT 'expo', -- 'expo' | 'fcm' | 'apns'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, token)
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_app_notifications_active
  ON app_notifications (is_active, expires_at)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_app_notifications_target_company
  ON app_notifications (target_company_id)
  WHERE target_company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notification_reads_company
  ON notification_reads (company_id);

CREATE INDEX IF NOT EXISTS idx_push_tokens_company
  ON push_tokens (company_id);
