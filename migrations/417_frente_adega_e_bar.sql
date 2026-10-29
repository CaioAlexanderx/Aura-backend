-- ============================================================
-- 417 — Frente "Adega e bar" (companies.segment = 'adega') (29/10/2026, tq-50)
--
-- Decisao do fundador (19/10/2026, "Pode incluir"): adega e bar passam a ser
-- uma frente propria no cadastro, no check-in e no cartao "Sua frente".
-- A frente nasce SEM modulo, plano ou menu novo: os primeiros passos sao os
-- do varejo (services/segment.js / onboardingFirstSteps.js).
--
-- O que esta migration faz: acrescenta 'adega' aos dois CHECKs da migration
-- 366 (segment e segment_suggested). segment_source nao muda.
--
-- Nenhuma linha muda. O CHECK novo aceita tudo o que o antigo aceitava, entao
-- recria-lo nao reprova nenhuma linha existente. Idempotente: DROP IF EXISTS
-- seguido do ADD, com a mesma tolerancia a duplicate_object da 366.
--
-- Ordem de deploy: esta migration ANTES do codigo do backend/app (o codigo
-- novo grava 'adega'; sem a migration o banco recusa).
--
-- Caminho de volta (so depois de reverter o PR do backend e SE nenhuma
-- empresa tiver gravado 'adega' — senao o ADD falha, e e o que se quer):
--   SELECT count(*) FROM companies WHERE segment = 'adega' OR segment_suggested = 'adega';  -- tem de dar 0
--   ALTER TABLE companies DROP CONSTRAINT IF EXISTS chk_companies_segment;
--   ALTER TABLE companies ADD CONSTRAINT chk_companies_segment
--     CHECK (segment IS NULL OR segment IN ('varejo','matcon','otica','assistencia','studio','outro'));
--   ALTER TABLE companies DROP CONSTRAINT IF EXISTS chk_companies_segment_suggested;
--   ALTER TABLE companies ADD CONSTRAINT chk_companies_segment_suggested
--     CHECK (segment_suggested IS NULL OR segment_suggested IN ('varejo','matcon','otica','assistencia','studio','outro'));
-- ============================================================

ALTER TABLE companies DROP CONSTRAINT IF EXISTS chk_companies_segment;

DO $$
BEGIN
  ALTER TABLE companies
    ADD CONSTRAINT chk_companies_segment
    CHECK (segment IS NULL OR segment IN ('varejo','matcon','otica','assistencia','studio','adega','outro'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE companies DROP CONSTRAINT IF EXISTS chk_companies_segment_suggested;

DO $$
BEGIN
  ALTER TABLE companies
    ADD CONSTRAINT chk_companies_segment_suggested
    CHECK (segment_suggested IS NULL OR segment_suggested IN ('varejo','matcon','otica','assistencia','studio','adega','outro'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN companies.segment IS
  'Frente principal da empresa (varejo|matcon|otica|assistencia|studio|adega|outro). NULL = legado, comportamento anterior. Ver services/segment.js.';
