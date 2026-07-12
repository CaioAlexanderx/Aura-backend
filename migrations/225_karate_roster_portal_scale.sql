-- ============================================================
-- AURA KARATÊ — Migration 225: Portal do sensei em escala
-- (G1 — 12/07/2026)
--
-- Suporta:
--  - token de auto-atendimento do PRÓPRIO praticante (self_service_token),
--    SEPARADO do token do sensei (karate_dojo_roster_validation.token).
--    Decisão de segurança: o token do sensei dá poder pleno (inativar,
--    editar qualquer campo); o self_service_token só circula em rotas que
--    aceitam campo de contato. São segredos DIFERENTES para que vazar o
--    link do grupo do dojô (self-service) nunca dê ao aluno o mesmo poder
--    do sensei — mesmo reusando a MESMA linha/escopo de dojô.
--  - last_accessed_at: último acesso do sensei ao portal (GET ou PATCH
--    granular), usado pelo painel de progresso da federação (item 7) para
--    diferenciar "não aberto" de "em andamento".
--
-- Idempotente: ADD COLUMN IF NOT EXISTS em tudo.
-- ============================================================

ALTER TABLE karate_dojo_roster_validation
  ADD COLUMN IF NOT EXISTS self_service_token text;

ALTER TABLE karate_dojo_roster_validation
  ADD COLUMN IF NOT EXISTS self_service_token_expires_at timestamptz;

ALTER TABLE karate_dojo_roster_validation
  ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_kdrv_self_service_token
  ON karate_dojo_roster_validation (self_service_token);

-- ============================================================
-- FIM DA MIGRATION 225
-- ============================================================
