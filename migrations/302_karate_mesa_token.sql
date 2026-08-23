-- ============================================================
-- 302 — P2.1 Modo Mesário FORA DO SHELL: token de MESA por convocado
--
-- Cada linha de karate_competition_officials (a convocação de um oficial
-- para um campeonato) pode ter UM token de mesa ativo. O mesário abre a
-- mesa pelo link (?t=<token>) SEM login Aura; o servidor deriva
-- federação/competição/koto do token — o cliente nunca escolhe o escopo.
-- O escopo segue o area_id ATUAL da convocação a cada request: a federação
-- troca o mesário de koto (PATCH já existente) e o acesso acompanha.
--
-- Segurança: mesmo padrão do link fixo do portal do dojô (migration 239) —
-- no banco vai APENAS o hash SHA-256(segredo + token); revogação individual
-- via mesa_token_revoked_at; kill switch global = trocar o segredo
-- (KARATE_MESA_TOKEN_SECRET, fallback JWT_SECRET).
--
-- karate_competition_officials nasce na 298 (mesmo diretório migrations/,
-- aplicada pelo CI antes desta) — não precisa de guard de existência.
-- ============================================================

ALTER TABLE karate_competition_officials
  ADD COLUMN IF NOT EXISTS mesa_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS mesa_token_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mesa_token_revoked_at TIMESTAMPTZ;

-- Busca por hash só interessa em tokens ativos.
CREATE INDEX IF NOT EXISTS idx_kco_mesa_token_hash
  ON karate_competition_officials (mesa_token_hash)
  WHERE mesa_token_hash IS NOT NULL AND mesa_token_revoked_at IS NULL;

-- ============================================================
-- FIM DA MIGRATION 302
-- ============================================================
