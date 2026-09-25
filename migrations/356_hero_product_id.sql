-- ============================================================
-- 356 — A peça do destaque da vitrine Studio (Fase 5)
--
-- POR QUE: sem banner cadastrado, a home da vitrine Studio mostra o
-- título da loja e uma peça com o mockup girando e as artes trocando
-- (docs/mockups/studio-vitrine-05-home.html, tela 2; decisão 10 do PO em
-- 25/09/2026). A peça automática é a primeira com prévia 3D na ordem de
-- destaque; a lojista pode escolher outra na aba Design do painel.
--
-- NULL = automático. ON DELETE SET NULL: peça apagada volta para o
-- automático em vez de deixar a home apontando para o nada.
--
-- Idempotente. O backend tolera a coluna ausente (42703): o PUT pula a
-- gravação e a vitrine segue no automático.
-- ============================================================

ALTER TABLE digital_channel_config
  ADD COLUMN IF NOT EXISTS hero_product_id uuid NULL;

DO $$ BEGIN
  ALTER TABLE digital_channel_config
    ADD CONSTRAINT digital_channel_config_hero_product_id_fkey
    FOREIGN KEY (hero_product_id) REFERENCES products(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN digital_channel_config.hero_product_id IS
  'Vitrine Studio: a peça que gira no destaque da home quando não há banner. NULL = a primeira com prévia 3D na ordem de destaque.';
