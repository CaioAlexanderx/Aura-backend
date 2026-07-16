-- ============================================================
-- Migration 210 — Bracket scores (Track M — edição total de chave)
--
-- Permite lançar placar (aka/shiro) por partida do bracket de kumite,
-- além do vencedor já suportado. Usado pelo PUT .../bracket/matches
-- (edição em lote), POST .../bracket/reset e POST .../bracket/advance
-- (com aka_score/shiro_score opcionais).
--
-- Idempotente via IF NOT EXISTS.
-- ============================================================

ALTER TABLE karate_bracket_matches ADD COLUMN IF NOT EXISTS aka_score INT NULL;
ALTER TABLE karate_bracket_matches ADD COLUMN IF NOT EXISTS shiro_score INT NULL;
