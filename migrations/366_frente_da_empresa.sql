-- ============================================================
-- 366 — Frente da empresa (segment) escolhida no cadastro
--
-- Decisao do fundador (05/10/2026): o cadastro pergunta "Qual e o seu
-- ramo?", a Aura sugere pelo CNAE do CNPJ e o cliente confirma ou troca.
-- A frente escolhida ja nasce ligada (services/segment.js liga a chave
-- correspondente em pdv_settings). Uma frente por empresa (por CNPJ):
-- nada aqui e por usuario.
--
--   segment            varejo | matcon | otica | assistencia | studio | outro
--                      NULL = empresa anterior a esta migration (ou sem
--                      escolha): o app segue exatamente como hoje.
--   segment_source     de onde veio a frente gravada: cnae (sugestao aceita),
--                      landing (pagina do site por ramo), user (escolha
--                      manual no cadastro), staff (painel de gestao).
--   segment_suggested  o que o CNAE sugeriu no cadastro (para medir quantos
--                      trocam a sugestao). Mesma lista do segment.
--   cnae_principal     so digitos (ex.: 4774100), como veio da consulta.
--   cnae_descricao     descricao oficial da subclasse.
--   onboarding_dismissed_at  o dono fechou os "primeiros passos".
--
-- Idempotente. Sem backfill de segment: empresas existentes ficam NULL, que
-- e o comportamento atual (ver PR). A equipe define pelo painel.
-- ============================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS segment                 TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS segment_source          TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS segment_suggested       TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cnae_principal          TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cnae_descricao          TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS onboarding_dismissed_at TIMESTAMPTZ;

DO $$
BEGIN
  ALTER TABLE companies
    ADD CONSTRAINT chk_companies_segment
    CHECK (segment IS NULL OR segment IN ('varejo','matcon','otica','assistencia','studio','outro'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE companies
    ADD CONSTRAINT chk_companies_segment_suggested
    CHECK (segment_suggested IS NULL OR segment_suggested IN ('varejo','matcon','otica','assistencia','studio','outro'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE companies
    ADD CONSTRAINT chk_companies_segment_source
    CHECK (segment_source IS NULL OR segment_source IN ('cnae','landing','user','staff'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN companies.segment IS
  'Frente principal da empresa (varejo|matcon|otica|assistencia|studio|outro). NULL = legado, comportamento anterior. Ver services/segment.js.';
COMMENT ON COLUMN companies.segment_source IS
  'Origem da frente gravada: cnae | landing | user | staff.';
COMMENT ON COLUMN companies.segment_suggested IS
  'Frente sugerida pelo CNAE no cadastro (pode diferir da escolhida).';
COMMENT ON COLUMN companies.cnae_principal IS
  'CNAE principal (so digitos) informado no cadastro.';
COMMENT ON COLUMN companies.cnae_descricao IS
  'Descricao do CNAE principal informada no cadastro.';
COMMENT ON COLUMN companies.onboarding_dismissed_at IS
  'Quando o dono fechou o cartao de primeiros passos da frente.';
