-- ============================================================
-- Migration 115 — Canal Digital v2 (redesign Shopify-grade)
-- Idempotente. Adiciona em digital_channel_config:
--   accent_color       — cor de destaque (paleta complementar)
--   dark_mode          — tema escuro
--   font_family        — classic|modern (Instrument vs Fraunces)
--   card_style         — editorial|minimal|image-heavy
--   banners            — JSONB array de até 3 banners flutuantes
--                        { kicker, headline, body, cta, tone, tint, image_url, enabled }
--   announcement_bar   — texto do strip superior (ex: "Frete grátis acima de R$ 250")
--
-- Notas:
-- - secondary_color é mantido pra retrocompat (legacy storefront). v2 lê
--   accent_color e cai em secondary_color como fallback.
-- - banners é fonte da verdade do carrossel da home (até 3 ativos). Cada
--   banner tem image_url próprio (R2 em ${cid}/canal/banner_N.${ext}).
-- ============================================================

ALTER TABLE digital_channel_config
  ADD COLUMN IF NOT EXISTS accent_color TEXT,
  ADD COLUMN IF NOT EXISTS dark_mode BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS font_family TEXT NOT NULL DEFAULT 'classic',
  ADD COLUMN IF NOT EXISTS card_style TEXT NOT NULL DEFAULT 'editorial',
  ADD COLUMN IF NOT EXISTS banners JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS announcement_bar TEXT;

-- font_family enum-like check (não usa ENUM real pra evitar migrations de valor)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='digital_channel_config_font_family_chk') THEN
    ALTER TABLE digital_channel_config
      ADD CONSTRAINT digital_channel_config_font_family_chk
      CHECK (font_family IN ('classic','modern','humanist'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='digital_channel_config_card_style_chk') THEN
    ALTER TABLE digital_channel_config
      ADD CONSTRAINT digital_channel_config_card_style_chk
      CHECK (card_style IN ('editorial','minimal','image-heavy'));
  END IF;
END $$;

-- Backfill accent_color: usar secondary_color quando existir (loja legacy
-- mantém destaque atual). Default Aura violeta caso ambos NULL.
UPDATE digital_channel_config
  SET accent_color = COALESCE(secondary_color, '#a78bfa')
  WHERE accent_color IS NULL;

-- Backfill banners[]: gerar 1 banner default a partir de cover_url+tagline
-- pra lojistas que já tinham vitrine (não perdem o cover existente).
UPDATE digital_channel_config
  SET banners = jsonb_build_array(
    jsonb_build_object(
      'kicker', '',
      'headline', COALESCE(NULLIF(tagline, ''), 'Bem-vindo à nossa loja'),
      'body', COALESCE(NULLIF(description, ''), ''),
      'cta', 'Ver produtos',
      'tone', 'split',
      'tint', 'brand',
      'image_url', cover_url,
      'enabled', true
    )
  )
  WHERE banners = '[]'::jsonb
    AND (cover_url IS NOT NULL OR tagline IS NOT NULL OR description IS NOT NULL);

COMMENT ON COLUMN digital_channel_config.accent_color    IS 'Cor de destaque (paleta complementar). Default Aura violeta. Usado em CTAs accent, badges -%, etc.';
COMMENT ON COLUMN digital_channel_config.dark_mode       IS 'Tema escuro da loja pública. Inverte fundo/texto mantendo paleta.';
COMMENT ON COLUMN digital_channel_config.font_family     IS 'classic (Instrument Serif) | modern (Fraunces) | humanist (DM Sans). Aplicado nos heads.';
COMMENT ON COLUMN digital_channel_config.card_style      IS 'editorial (default, serif name + price abaixo) | minimal (compact) | image-heavy (overlay sobre imagem).';
COMMENT ON COLUMN digital_channel_config.banners         IS 'Array de até 3 banners flutuantes do hero. {kicker,headline,body,cta,tone,tint,image_url,enabled}.';
COMMENT ON COLUMN digital_channel_config.announcement_bar IS 'Strip de anúncio no topo do header (desktop). Ex: "Frete grátis acima de R$ 250".';
