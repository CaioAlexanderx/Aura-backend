-- ============================================================
-- Migration 107 — Drop UNIQUE (sale_id, method) em sale_payments
-- Data: 2026-05-11
--
-- A constraint sale_payments_sale_id_method_key impedia:
--   1) Modelo NOVO de troca: 1 sale_payment NEGATIVO (devolução) +
--      1 sale_payment POSITIVO (diferença paga) — ambos com o MESMO
--      method (ex: ambos débito quando cliente paga a diferença no
--      cartão débito).
--   2) Split-payment hipotético com método repetido — ex: R$ 100
--      no cartão débito da maquininha A + R$ 50 cartão débito da
--      maquininha B. Limitação artificial pra cenários reais.
--
-- Idempotente. Drop é seguro porque nenhum código depende da
-- unicidade (id é PK, ON CONFLICT DO NOTHING dos INSERTs usa
-- conflito implícito por PK e funciona normalmente sem essa key).
-- ============================================================

ALTER TABLE sale_payments
  DROP CONSTRAINT IF EXISTS sale_payments_sale_id_method_key;

-- Caso o índice tenha sido criado separadamente
DROP INDEX IF EXISTS sale_payments_sale_id_method_key;
