-- ============================================================
-- AURA KARATÊ — Migration 199: Permitir edição/exclusão de graduação
--
-- Migration 149 criou karate_belt_history como append-only/imutável,
-- com triggers (trg_belt_history_no_update / trg_belt_history_no_delete)
-- que bloqueiam QUALQUER UPDATE ou DELETE com RAISE EXCEPTION.
--
-- Em 23/06 e 25/06/2026 (ver comentários no topo de
-- src/routes/karatePractitioners.js) o produto passou a oferecer edição e
-- exclusão POR ITEM da trajetória de faixas — decisão Caio, "liberdade
-- total da federação" — via:
--   PATCH  /federation/:id/practitioners/:practitionerId/graduations/:graduationId
--   DELETE /federation/:id/practitioners/:practitionerId/graduations/:graduationId
--
-- Essas rotas fazem UPDATE/DELETE direto em karate_belt_history, mas os
-- triggers de imutabilidade da migration 149 nunca foram removidos —
-- toda chamada às rotas acima falha com a exceção do trigger (500).
--
-- Esta migration remove os dois triggers de bloqueio. A tabela continua
-- protegida por escrita só via rotas com guards.staffWrite() (admin/staff
-- da federação); não há mais proteção a nível de trigger contra
-- UPDATE/DELETE arbitrário, pois o próprio produto agora exige isso.
--
-- Idempotente — IF EXISTS em ambos os DROPs.
-- NÃO aplicada a nenhum banco por esta migration; aplicar via Supabase MCP
-- (apply_migration) antes de mergear o PR do backend.
-- ============================================================

DROP TRIGGER IF EXISTS trg_belt_history_no_update ON karate_belt_history;
DROP TRIGGER IF EXISTS trg_belt_history_no_delete ON karate_belt_history;

-- A função karate_belt_history_immutable() é deixada intacta (não é mais
-- referenciada por nenhum trigger após este DROP), caso algum outro lugar
-- precise dela no futuro ou para auditoria histórica do que ela fazia.

-- ============================================================
-- FIM DA MIGRATION 199
-- ============================================================
