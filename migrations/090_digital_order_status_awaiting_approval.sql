-- ============================================================
-- 090_digital_order_status_awaiting_approval.sql
-- AURA. — Adicionar 'awaiting_approval' ao enum digital_order_status
--
-- CONTEXTO: Migration 070 criou o ENUM digital_order_status sem
-- 'awaiting_approval'. O fluxo Pix manual (introduzido em 088) usa
-- esse status quando o cliente clica "Ja paguei" e fica aguardando
-- aprovacao do lojista.
--
-- Em PROD a coluna digital_orders.status foi convertida pra TEXT em
-- algum momento (e o ENUM nem existe mais), entao o partial index do
-- 088 funcionou. Mas no CI/DB novo o ENUM existe e o partial index
-- com WHERE status = 'awaiting_approval' explode porque o valor nao
-- esta no enum.
--
-- Esta migration:
--   1. Adiciona 'awaiting_approval' ao enum SE o enum existir
--      (no-op em prod onde virou TEXT)
--   2. (Re)cria o partial index que 088 nao conseguiu criar no CI
-- ============================================================

-- 1. Adiciona valor ao enum apenas se o enum existir
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'digital_order_status') THEN
    -- ALTER TYPE ADD VALUE IF NOT EXISTS e suportado a partir do PG 9.6
    -- e pode rodar fora de transacao explicita (psql auto-commit).
    EXECUTE 'ALTER TYPE digital_order_status ADD VALUE IF NOT EXISTS ''awaiting_approval''';
  END IF;
END $$;

-- 2. (Re)cria index parcial — em prod ja existe (criado por 088), em
--    CI sera criado agora que o enum aceita o valor.
--    Em PG, o novo enum value criado acima nao e visivel na MESMA
--    transacao em que foi adicionado. Como cada statement no psql
--    auto-commita, o DO acima ja foi commitado antes deste CREATE
--    INDEX, entao o WHERE consegue resolver 'awaiting_approval'.
CREATE INDEX IF NOT EXISTS digital_orders_awaiting_approval_idx
  ON digital_orders (company_id, status, created_at DESC)
  WHERE status = 'awaiting_approval';
