-- ============================================================
-- 391 — Telas visitadas: separar a abertura que vem do login (card t2-14)
--
-- Contexto (17/10/2026, pedido da Nina): a medição de telas (POST
-- /usage/screens, desde 13/10) contava a primeira tela aberta logo depois do
-- login (quase sempre o Painel) como uma visita igual a um retorno do
-- usuário. Quem só entra e sai inflava "uso" do Painel.
--
-- O app agora manda, por tela, `apos_login`: quantas das `count` visitas do
-- lote foram a primeira tela depois de um login/cadastro. O backend soma isso
-- em views_login. `views` continua sendo o TOTAL (login + retorno), então
-- nada do que já lê `views` muda. Retorno = views - views_login.
--
-- Para ler:
--   SELECT screen, SUM(views) AS total, SUM(views_login) AS apos_login,
--          SUM(views) - SUM(views_login) AS retorno
--     FROM screen_views WHERE dia > CURRENT_DATE - 7 GROUP BY screen ORDER BY total DESC;
--
-- Idempotente. O backend pode subir antes desta migration: o INSERT trata
-- 42703 (coluna ausente) gravando só `views`, sem a marca de origem. As
-- linhas anteriores a esta migration ficam com 0 (sem origem conhecida).
-- ============================================================

ALTER TABLE screen_views
  ADD COLUMN IF NOT EXISTS views_login INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN screen_views.views_login IS 'Das views do dia, quantas foram a primeira tela aberta logo apos login/cadastro (o resto e retorno).';
