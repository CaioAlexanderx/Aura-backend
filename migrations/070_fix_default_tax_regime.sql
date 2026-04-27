-- ============================================================
-- Migration 070: Corrige default de tax_regime
--
-- BUG: migration 001 definiu DEFAULT 'mei' na coluna tax_regime
-- da tabela companies. Toda empresa criada sem completar o
-- step/regime do onboarding ficava classificada como MEI.
--
-- FIX:
--   1. Altera o DEFAULT para 'simples_nacional'
--   2. Backfill: empresas em onboarding incompleto (nunca
--      escolheram o regime) são atualizadas para simples_nacional
--      Empresas com onboarding_step = 'perfil' ou 'done' já
--      passaram pelo step/regime e escolheram deliberadamente,
--      portanto NÃO são alteradas.
-- ============================================================

-- 1. Corrige o default do banco
ALTER TABLE companies
  ALTER COLUMN tax_regime SET DEFAULT 'simples_nacional';

-- 2. Backfill apenas empresas que nunca completaram o step/regime
--    (onboarding_step = 'cnpj'  → nem CNPJ foi salvo ainda)
--    (onboarding_step = 'regime' → CNPJ salvo mas regime não escolhido)
UPDATE companies
SET    tax_regime = 'simples_nacional',
       updated_at = NOW()
WHERE  tax_regime = 'mei'
  AND  onboarding_step IN ('cnpj', 'regime');
