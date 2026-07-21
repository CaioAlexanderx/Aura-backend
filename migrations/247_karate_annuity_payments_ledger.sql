-- ============================================================
-- AURA KARATÊ — Migration 247: F1 da reforma da anuidade
-- amount_paid + kind na parcela, status ganha 'partial', e o ledger
-- karate_annuity_payments (extrato/auditoria de cada recebimento).
-- ------------------------------------------------------------
-- Contexto de negócio (decisões fechadas com o Caio, F1):
--   A anuidade vira RECEBÍVEL: cada parcela (karate_annuity_installments)
--   passa a ter devido (amount, já existia) x recebido (amount_paid, NOVO).
--   A baixa aceita valor livre/parcial (não precisa quitar a parcela
--   inteira de uma vez). Cada recebimento fica registrado em um ledger
--   (karate_annuity_payments) para extrato/auditoria — a parcela guarda só
--   o agregado (amount_paid), o ledger guarda o histórico de CADA baixa.
--
--   Renegociação/ajuste do valor devido (amount) e carteira de crédito
--   (saldo credor reutilizável) estão FORA DE ESCOPO nesta fase — ver
--   src/services/karateAnnuityLedger.js (applyAnnuityPayment), que RECUSA
--   pagamento acima do saldo em aberto em vez de gerar crédito.
--
--   'kind' (NOVO) distingue anuidade normal de filiação (parcela avulsa
--   de outra natureza que passou a correr pelo mesmo trilho de parcelas/
--   FIFO) — ver aplyAnnuityPayment: ambas participam do FIFO igualmente,
--   'kind' é só rótulo.
--
-- Esta migration NÃO é aplicada em produção neste PR (padrão das
-- 241/243/244/245/246 — aplicar via Supabase MCP depois do merge).
-- Idempotente de ponta a ponta.
-- ============================================================

-- ============================================================
-- (a) karate_annuity_installments ganha amount_paid + kind
-- ============================================================
ALTER TABLE karate_annuity_installments
  ADD COLUMN IF NOT EXISTS amount_paid numeric NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE karate_annuity_installments
    ADD CONSTRAINT karate_annuity_installments_amount_paid_check
    CHECK (amount_paid >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE karate_annuity_installments
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'anuidade';

DO $$ BEGIN
  ALTER TABLE karate_annuity_installments
    ADD CONSTRAINT karate_annuity_installments_kind_check
    CHECK (kind IN ('anuidade', 'filiacao'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- (b) status ganha 'partial' — Postgres não tem ALTER CHECK, precisa
-- DROP + ADD. Nome real confirmado no catálogo em prod (17/07/2026,
-- projeto hawtujkztrjpvvkihowb): karate_annuity_installments_status_check
-- (criado na migration 222). Mantém 'pending'/'paid' — NÃO renomear, há
-- código legado (deriveInstallmentStatus, computeAnnuityListStatus,
-- computeAggregateFinanceiro em karateAnnuityService.js e as views
-- karate_dojo_standing/karate_member_standing) lendo esses dois valores
-- exatos. DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT (sem bloco DO) já é
-- idempotente por si só — mesmo padrão da migration 241
-- (chk_kmc_print_status).
-- ============================================================
ALTER TABLE karate_annuity_installments
  DROP CONSTRAINT IF EXISTS karate_annuity_installments_status_check;

ALTER TABLE karate_annuity_installments
  ADD CONSTRAINT karate_annuity_installments_status_check
  CHECK (status IN ('pending', 'partial', 'paid'));

-- ============================================================
-- (c) karate_annuity_payments — o ledger (extrato/auditoria de cada
-- recebimento aplicado por applyAnnuityPayment). Uma parcela pode ter
-- N linhas aqui (N baixas parciais); amount_paid da parcela = SUM
-- deste ledger para aquele installment_id (documentado no service).
-- ============================================================
CREATE TABLE IF NOT EXISTS karate_annuity_payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id  uuid NOT NULL,
  installment_id uuid NOT NULL,
  annuity_id     uuid NOT NULL,
  amount         numeric NOT NULL,
  paid_at        timestamptz NOT NULL,
  payment_method text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE karate_annuity_payments
    ADD CONSTRAINT karate_annuity_payments_amount_check
    CHECK (amount > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_annuity_payments
    ADD CONSTRAINT karate_annuity_payments_installment_id_fkey
    FOREIGN KEY (installment_id) REFERENCES karate_annuity_installments(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_annuity_payments
    ADD CONSTRAINT karate_annuity_payments_annuity_id_fkey
    FOREIGN KEY (annuity_id) REFERENCES karate_dojo_annuity_history(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_kap_annuity_id
  ON karate_annuity_payments (annuity_id);

CREATE INDEX IF NOT EXISTS idx_kap_installment_id
  ON karate_annuity_payments (installment_id);

-- ============================================================
-- (d) FECHA GAP encontrado durante o levantamento de schema deste F1
-- (17-21/07/2026): karate_annuity_installments_payment_method_check
-- (migration 222) NUNCA foi atualizada quando 'credito_cbkt' virou método
-- válido em karateAnnuityService.js/karateAnnuities.js (PR #408, hoje) —
-- a constraint no banco continuava só ('pix','dinheiro','transferencia',
-- 'outro'). Isso já deixava QUALQUER baixa por parcela com
-- payment_method='credito_cbkt' (rota POST .../installments/:id/pay,
-- karateAnnuities.js ~L2186) quebrando em 23514 (check_violation) — bug
-- pré-existente, não introduzido por este PR. applyAnnuityPayment
-- (karateAnnuityLedger.js, este PR) também escreve payment_method direto
-- em karate_annuity_installments, então herdaria o mesmo bug para
-- 'credito_cbkt' E para o novo 'credito_exame' se a constraint não for
-- alinhada aqui. DROP + ADD (mesmo motivo de sempre: Postgres não tem
-- ALTER CHECK) trazendo a constraint para o mesmo conjunto de
-- VALID_PAYMENT_METHODS do app (pix, dinheiro, transferencia,
-- credito_cbkt, credito_exame, outro).
-- ============================================================
ALTER TABLE karate_annuity_installments
  DROP CONSTRAINT IF EXISTS karate_annuity_installments_payment_method_check;

ALTER TABLE karate_annuity_installments
  ADD CONSTRAINT karate_annuity_installments_payment_method_check
  CHECK (payment_method IS NULL OR payment_method IN
    ('pix', 'dinheiro', 'transferencia', 'credito_cbkt', 'credito_exame', 'outro'));

-- ============================================================
-- FIM DA MIGRATION 247
-- ============================================================
