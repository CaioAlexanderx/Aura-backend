-- ============================================================
-- 349 — refresh_tokens.app_mode: por onde a pessoa entrou (PWA Fase 2)
--
-- Criada: 22/09/2026
--
-- O painel passou a ser instalável como app no celular (aura-app, PWA
-- Fase 1). Para saber se alguém está usando pelo app, o front manda o
-- cabeçalho X-Aura-App: standalone em toda requisição quando abriu pelo
-- ícone. O login grava isso aqui, ao lado do user_agent que já guardava.
--
-- Contar quem usa pelo app vira uma consulta:
--   SELECT app_mode, COUNT(DISTINCT user_id)
--     FROM refresh_tokens
--    WHERE created_at > now() - interval '30 days'
--    GROUP BY 1;
--
-- Valores: 'standalone' (abriu pelo ícone), 'browser' (aba do navegador),
-- NULL (cliente antigo ou não informou). Idempotente.
-- ============================================================

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS app_mode VARCHAR(20);

COMMENT ON COLUMN refresh_tokens.app_mode IS
  'Como o cliente abriu o painel neste login: standalone (app instalado), browser, ou NULL. Vem do cabeçalho X-Aura-App.';

-- Índice parcial: só as linhas que informaram, ordenadas por data, que é
-- exatamente o corte da consulta de uso.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_app_mode_created
  ON refresh_tokens (app_mode, created_at)
  WHERE app_mode IS NOT NULL;
