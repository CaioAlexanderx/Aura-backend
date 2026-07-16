-- 213_karate_payment_ledger_agnostic.sql
-- Fase 0 (BaaS foundation): tornar karate_payment_intents um ledger de cobrança
-- agnóstico de provider, capaz de reconciliar qualquer origem (evento, anuidade,
-- competição) e qualquer provider (static_brcode hoje; Asaas/BaaS Aura no futuro).
-- Sem ativar BaaS. Colunas aditivas nullable — não quebra os INSERTs existentes.

ALTER TABLE karate_payment_intents ADD COLUMN IF NOT EXISTS amount      NUMERIC(12,2);
ALTER TABLE karate_payment_intents ADD COLUMN IF NOT EXISTS source_type TEXT;   -- 'event_registration' | 'dojo_annuity' | 'cpf_annuity' | 'competition' | ...
ALTER TABLE karate_payment_intents ADD COLUMN IF NOT EXISTS source_id   UUID;   -- id da inscrição/histórico que originou a cobrança
ALTER TABLE karate_payment_intents ADD COLUMN IF NOT EXISTS txid        TEXT;   -- txid usado no BR Code (antes só embutido no payload)
ALTER TABLE karate_payment_intents ADD COLUMN IF NOT EXISTS description TEXT;

CREATE INDEX IF NOT EXISTS idx_kpi_source ON karate_payment_intents(source_type, source_id);
