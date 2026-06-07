-- ============================================================
-- AURA KARATÊ — Migration 161: elegibilidade soft + critérios provisórios
-- Decisão FPKT: elegibilidade é apenas AVISO (admin decide), nunca hard block.
-- E os critérios são provisórios até confirmação da federação (revisão ~anual).
-- APLICADA em 07/06/2026 no Supabase hawtujkztrjpvvkihowb.
-- ============================================================

ALTER TABLE karate_belt_requirements ALTER COLUMN is_hard_block SET DEFAULT false;
UPDATE karate_belt_requirements SET is_hard_block = false WHERE is_hard_block = true;

ALTER TABLE karate_belt_requirements ADD COLUMN IF NOT EXISTS confirmed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE karate_belt_requirements ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

COMMENT ON COLUMN karate_belt_requirements.confirmed IS
  'Critério confirmado pela federação. false = provisório (a FPKT revisa ~anualmente). UI deve sinalizar valores não confirmados.';
COMMENT ON COLUMN karate_belt_requirements.is_hard_block IS
  'Sempre false por decisão da FPKT: elegibilidade é apenas aviso, o admin decide a inscrição.';

-- FIM DA MIGRATION 161
