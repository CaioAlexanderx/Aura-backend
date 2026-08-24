-- ============================================================
-- 303 — KATA por 5 NOTAS (uma por árbitro) — regra real FPKT/JKA
--
-- karate_kata_scores.nota passa a ser o TOTAL COMPUTADO (soma cortando a
-- maior e a menor); as notas individuais dos árbitros ficam em `notas`
-- (JSONB, array de números) para auditoria e para a cascata de desempate
-- (somar de volta a menor; depois a maior; persistindo → novo kata).
-- Retrocompatível: linhas antigas seguem com nota única e notas NULL.
--
-- karate_kata_scores nasce na 183 (mesmo diretório) — sem guard.
-- ============================================================

ALTER TABLE karate_kata_scores
  ADD COLUMN IF NOT EXISTS notas JSONB;

-- ============================================================
-- FIM DA MIGRATION 303
-- ============================================================
