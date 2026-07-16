-- 214_karate_banner_has_text.sql
-- Banner adaptativo: sinaliza que o banner já contém texto/arte completa.
-- Quando true, a landing esconde a sobreposição de título/data/badge.
ALTER TABLE karate_promo_banners ADD COLUMN IF NOT EXISTS has_text BOOLEAN NOT NULL DEFAULT false;
