-- ============================================================
-- 304 — SÚMULA GRAVÁVEL (Onda B, dia do evento)
--
-- Os campos preenchidos à mão na folha real (shuchin, mesário, duração)
-- passam a ser graváveis pela mesa: JSONB na chave da categoria
-- (karate_brackets), preenchido via PATCH .../scoresheet — inclusive
-- pela MESA PÚBLICA do mesário (escopo do koto). A impressão continua
-- mostrando linha em branco quando o campo não foi preenchido.
--
-- karate_brackets nasce na 181 (mesmo diretório) — sem guard.
-- ============================================================

ALTER TABLE karate_brackets
  ADD COLUMN IF NOT EXISTS sumula JSONB;

-- ============================================================
-- FIM DA MIGRATION 304
-- ============================================================
