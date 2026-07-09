-- ============================================================
-- AURA KARATÊ — Migration 198: Banners promocionais da federação
-- Tabela karate_promo_banners: banners de imagem exibidos no Hub
-- do portal do praticante, na tela de inscrição ou em ambos.
-- Suporta janela de exibição (starts_at/ends_at), ordenação,
-- ativação/desativação e vínculo opcional a um evento (karate_events).
-- Idempotente: IF NOT EXISTS / DO $$ ... EXCEPTION em tudo.
-- Aplicar via Supabase MCP antes do merge do PR de frontend.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_promo_banners (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title         TEXT,
  image_url     TEXT NOT NULL,
  format        TEXT NOT NULL CHECK (format IN ('square', 'story', 'landscape')),
  event_id      UUID REFERENCES karate_events(id) ON DELETE SET NULL,
  placement     TEXT NOT NULL DEFAULT 'hub' CHECK (placement IN ('hub', 'inscricao', 'ambos')),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order    INT NOT NULL DEFAULT 0,
  starts_at     TIMESTAMPTZ,
  ends_at       TIMESTAMPTZ,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índice principal: busca de banners ativos por federação (hot path público)
CREATE INDEX IF NOT EXISTS idx_karate_promo_banners_federation_active
  ON karate_promo_banners (federation_id, active);

-- Índice auxiliar: banners vinculados a um evento (consultas admin)
CREATE INDEX IF NOT EXISTS idx_karate_promo_banners_event_id
  ON karate_promo_banners (event_id);

-- FIM DA MIGRATION 198
