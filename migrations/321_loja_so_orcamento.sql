-- ============================================================
-- 321 — Modo "so orcamento" e data-limite de pedidos
--
-- POR QUE: em dezembro e em maio a lojista vende o que nao consegue
-- produzir. O pedido entra, ela nao da conta, e vira reembolso e
-- avaliacao ruim — o oposto do que o pico deveria render.
--
-- Hoje a unica saida dela e DESPUBLICAR a loja, o que joga fora tambem
-- a vitrine: quem chega pelo Instagram nao ve nem os produtos, e ela
-- perde o orcamento que poderia produzir em janeiro.
--
-- Duas colunas, um conceito: "ate quando eu aceito pedido".
--
--   pedidos_pausados  — a lojista fecha na mao, agora
--   pedidos_ate       — a data em que fecha sozinho
--
-- A data existe para o caso que ela nao vai lembrar de fazer: no dia 20
-- de dezembro, as 23h, ninguem vai abrir o painel para fechar a loja.
-- Passada a data, a vitrine continua no ar e o botao vira orcamento.
-- ============================================================

ALTER TABLE digital_channel_config
  ADD COLUMN IF NOT EXISTS pedidos_pausados boolean NOT NULL DEFAULT false;

ALTER TABLE digital_channel_config
  ADD COLUMN IF NOT EXISTS pedidos_ate date;

COMMENT ON COLUMN digital_channel_config.pedidos_pausados IS
  'Loja no ar, mas sem aceitar pedido novo — so orcamento. Ver services/modoDaLoja.js.';
COMMENT ON COLUMN digital_channel_config.pedidos_ate IS
  'Ultimo dia em que a loja aceita pedido. Passada a data, vira so orcamento sozinha.';
