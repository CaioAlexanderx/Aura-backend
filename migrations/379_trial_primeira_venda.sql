-- ============================================================
-- 379_trial_primeira_venda.sql — Trial contado da primeira venda (13/10/2026)
--
-- Por que: o self-service converteu 0 de 21 contas em 120 dias. O trial de
-- 7 dias corridos do cadastro terminava antes de a loja sentir valor (8 de 12
-- trials ativos so tinham carregado estoque quando o muro chegou).
--
-- Regra nova (constantes em src/services/trialRegra.js):
--   - cadastro self-service nasce com trial_ends_at = created_at + 15 dias
--     (teto) e trial_mode = 'primeira_venda';
--   - na primeira venda do Caixa: trial_started_by_sale_at = agora e
--     trial_ends_at = min(agora + 7 dias, created_at + 15 dias).
--
--   trial_mode                'fixo' (comportamento de sempre: trial_ends_at
--                             vale como esta) | 'primeira_venda'.
--                             DEFAULT 'fixo': NENHUMA conta existente muda.
--   trial_started_by_sale_at  quando a primeira venda disparou os 7 dias.
--                             NULL = ainda nao vendeu (ou conta 'fixo').
--
-- Sem backfill: so cadastros novos entram no modo 'primeira_venda'.
-- Idempotente. O backend sobe antes desta migration: o codigo trata 42703
-- como "tudo fixo" (cadastro segue com os 7 dias de antes).
-- ============================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS trial_mode TEXT NOT NULL DEFAULT 'fixo';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS trial_started_by_sale_at TIMESTAMPTZ NULL;

DO $$ BEGIN
  ALTER TABLE companies ADD CONSTRAINT companies_trial_mode_check
    CHECK (trial_mode IN ('fixo', 'primeira_venda'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN companies.trial_mode IS
  'fixo = trial_ends_at vale como esta; primeira_venda = 7 dias a partir da 1a venda, teto de 15 dias do cadastro (services/trialRegra).';
COMMENT ON COLUMN companies.trial_started_by_sale_at IS
  'Momento em que a primeira venda do Caixa disparou o trial (modo primeira_venda). NULL = ainda nao vendeu.';
