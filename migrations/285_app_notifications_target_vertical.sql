-- ============================================================
-- 285 — Notificações do app: segmentação por shell (vertical)
--
-- Contexto: app_notifications / notification_reads nasceram FORA de
-- migrations (aplicadas direto na base em 13/06/2026). Este arquivo
-- recria as duas com IF NOT EXISTS — no-op em produção e, em ambiente
-- novo/CI, faz o schema passar a existir — e adiciona o que a expansão
-- para Aura Dojô / Aura Karatê / Aura Studio pede:
--
--   target_vertical — o banner só aparece no shell escolhido.
--     NULL = todos os shells (comportamento atual, preservado).
--     O valor casa com o "shell" da empresa, que é
--     COALESCE(companies.vertical_active, companies.vertical, 'negocio').
--     Valores: negocio | karate_dojo | karate_federation | studio |
--              odonto | barber | food | estetica | pet | academia
--     (mesma lista de src/services/appNotifications.js).
--
--   dedupe_key — chave opcional de idempotência para banner disparado
--     pelo BACKEND (services/appNotifications.js). Com o índice único
--     parcial abaixo, o mesmo evento não vira dois banners se o fluxo
--     de origem rodar duas vezes.
--
-- Idempotente: pode rodar quantas vezes for.
-- ============================================================

CREATE TABLE IF NOT EXISTS app_notifications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type              TEXT NOT NULL DEFAULT 'banner',
  title             TEXT NOT NULL,
  body              TEXT,
  html_content      TEXT,
  cta_label         TEXT,
  cta_url           TEXT,
  cta_route         TEXT,
  target_company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  target_plan       TEXT,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id UUID NOT NULL REFERENCES app_notifications(id) ON DELETE CASCADE,
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, company_id)
);

ALTER TABLE app_notifications ADD COLUMN IF NOT EXISTS target_vertical TEXT;
ALTER TABLE app_notifications ADD COLUMN IF NOT EXISTS dedupe_key      TEXT;

COMMENT ON COLUMN app_notifications.target_vertical IS
  'Shell alvo do banner. NULL = todos. Casa com COALESCE(companies.vertical_active, companies.vertical, ''negocio'').';
COMMENT ON COLUMN app_notifications.dedupe_key IS
  'Idempotência de banner disparado pelo backend (services/appNotifications.js). NULL = sem dedup.';

-- Dedup só vale para quem informou a chave: índice ÚNICO PARCIAL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_notifications_dedupe_key
  ON app_notifications (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- O GET /companies/:id/notifications roda a cada 30s em TODA empresa:
-- o filtro sempre começa por is_active.
CREATE INDEX IF NOT EXISTS idx_app_notifications_active
  ON app_notifications (is_active, created_at DESC);
