-- ============================================================
-- 220: Loja Virtual F1 (Alcance) — analytics do lojista na vitrine
-- Colunas para GA4 e Meta Pixel configuráveis por loja.
-- Idempotente. Aplicada via Supabase MCP em 09/07/2026.
-- ============================================================
ALTER TABLE digital_channel_config ADD COLUMN IF NOT EXISTS ga4_measurement_id TEXT;
ALTER TABLE digital_channel_config ADD COLUMN IF NOT EXISTS meta_pixel_id TEXT;
