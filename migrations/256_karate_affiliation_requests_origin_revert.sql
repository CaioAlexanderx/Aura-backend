-- ============================================================
-- 256 — Aura Dojô: reverte origem do pedido de filiação (migration 255)
-- ------------------------------------------------------------
-- CONTEXTO: decisão de produto do dono (27/07/2026) — a FEDERAÇÃO NUNCA
-- abre um pedido de filiação espontaneamente. É SEMPRE o dojô que assina
-- a Aura quem inicia (self-serve, POST /federation/:id/dojo/connection).
-- O caminho "federação abre pelo dojô" (migration 255, PR #433,
-- POST /federation/:id/affiliation-requests, origin='federation') virou
-- dead code e foi revertido no backend (src/services/
-- karateAffiliationRequestService.js, src/routes/
-- karateAffiliationRequestsAdmin.js — a rota POST base, a função
-- createFederationInitiatedRequest e o pending_by_origin de
-- requestMetrics foram removidos). Esta migration reverte o schema
-- correspondente.
--
-- SEGURANÇA DO DROP: nenhuma linha em produção tem origin='federation' —
-- 100% dos registros existentes são origin='dojo' (o único caminho que
-- sempre existiu; a via 'federation' nunca chegou a ser usada em
-- produção antes de a rota ser revertida). Dropar as colunas não perde
-- nenhum dado de negócio.
--
-- Idempotente: DROP INDEX/CONSTRAINT/COLUMN todos com IF EXISTS. Ordem:
-- índice → constraints → colunas.
-- ============================================================

DROP INDEX IF EXISTS idx_karate_affiliation_requests_fed_origin;

ALTER TABLE karate_affiliation_requests DROP CONSTRAINT IF EXISTS karate_affiliation_requests_origin_check;
ALTER TABLE karate_affiliation_requests DROP CONSTRAINT IF EXISTS karate_affiliation_requests_requested_by_fkey;

ALTER TABLE karate_affiliation_requests DROP COLUMN IF EXISTS origin;
ALTER TABLE karate_affiliation_requests DROP COLUMN IF EXISTS requested_by;

-- FIM DA MIGRATION 256
