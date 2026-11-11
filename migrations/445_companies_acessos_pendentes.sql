-- ============================================================
-- 445 — Acessos de funcionário escolhidos no checkout (card p-106).
--
-- Por quê: a loja passa a escolher no checkout quantos acessos de
-- funcionário adicionais quer (0 a 10). Os acessos só liberam com o
-- pagamento confirmado. O POST /billing/subscribe NÃO mexe em
-- companies.extra_seats_granted: guarda a quantidade aqui, ligada à
-- assinatura e à 1ª cobrança criadas na Asaas. O webhook da Asaas
-- (PAYMENT_CONFIRMED / PAYMENT_RECEIVED) daquela assinatura ou cobrança
-- aplica: extra_seats_granted = pendente + acessos de temporada ativos,
-- limpa a pendência e grava em audit_log (services/acessosPendentes.js).
--
--   pending_extra_seats                  quantidade PERMANENTE escolhida (0 a 10)
--   pending_extra_seats_subscription_id  assinatura criada na Asaas (sub_...)
--   pending_extra_seats_payment_id       1ª cobrança criada na Asaas (pay_...)
--   pending_extra_seats_at               quando a pendência foi gravada
--
-- Pix gerado e não pago: a pendência nunca vira acesso. Assinar de novo
-- grava a pendência nova por cima (a assinatura anterior é apagada pelo
-- próprio /subscribe, como já era).
--
-- Aditiva: só colunas novas, nulas, sem DEFAULT e sem backfill.
--
-- Caminho de volta (manual):
--   ALTER TABLE companies
--     DROP CONSTRAINT IF EXISTS companies_pending_extra_seats_range,
--     DROP COLUMN IF EXISTS pending_extra_seats,
--     DROP COLUMN IF EXISTS pending_extra_seats_subscription_id,
--     DROP COLUMN IF EXISTS pending_extra_seats_payment_id,
--     DROP COLUMN IF EXISTS pending_extra_seats_at;
-- ============================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS pending_extra_seats                 integer;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS pending_extra_seats_subscription_id text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS pending_extra_seats_payment_id      text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS pending_extra_seats_at              timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'companies_pending_extra_seats_range'
  ) THEN
    ALTER TABLE companies
      ADD CONSTRAINT companies_pending_extra_seats_range
      CHECK (pending_extra_seats IS NULL OR (pending_extra_seats >= 0 AND pending_extra_seats <= 10));
  END IF;
END $$;

COMMENT ON COLUMN companies.pending_extra_seats IS
  'p-106: acessos de funcionário PERMANENTES escolhidos no checkout, aguardando o pagamento confirmado da assinatura/cobrança abaixo. NULL = nada pendente.';
COMMENT ON COLUMN companies.pending_extra_seats_subscription_id IS
  'p-106: assinatura da Asaas cuja cobrança confirmada libera pending_extra_seats.';
COMMENT ON COLUMN companies.pending_extra_seats_payment_id IS
  'p-106: 1ª cobrança da Asaas cuja confirmação libera pending_extra_seats.';
