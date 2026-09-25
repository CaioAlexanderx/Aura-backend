-- ============================================================
-- 355 — Recado da lojista quando a loja fecha para pedidos
--
-- POR QUE: a migration 321 deu a lojista o "fechar para pedidos"
-- (pedidos_pausados) e a data-limite (pedidos_ate), mas o texto que a
-- vitrine mostra era fixo em services/modoDaLoja.js. A tela "Pedidos pela
-- loja" do painel (Fase 1 da vitrine Studio, mockup 01 tela 7) deixa ela
-- escrever o proprio recado — "Voltamos em 6 de janeiro" diz mais do que
-- "a loja esta fechada".
--
-- NULL = usa o texto padrao de modoDaLoja. Ate 280 caracteres: cabe em
-- duas linhas do celular. A rota valida antes (routes/digitalChannel.js,
-- services/pedidosPelaLoja.js); o CHECK e a ultima linha de defesa.
--
-- Idempotente. O backend tolera a coluna ausente (42703) enquanto esta
-- migration nao for aplicada: o recado nao e gravado e a vitrine segue
-- com o texto padrao.
-- ============================================================

ALTER TABLE digital_channel_config
  ADD COLUMN IF NOT EXISTS pedidos_recado text;

DO $$ BEGIN
  ALTER TABLE digital_channel_config
    ADD CONSTRAINT digital_channel_config_pedidos_recado_len
    CHECK (pedidos_recado IS NULL OR char_length(pedidos_recado) <= 280);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- GA4 e Pixel: as colunas existem em producao desde a migration 220, mas
-- nenhum arquivo deste repositorio as cria — um banco montado so pelas
-- migrations (o da CI) nao as tinha, e o PUT da loja (BE-3) as grava.
-- Mesmo tipo de producao; IF NOT EXISTS nao toca o que ja existe.
ALTER TABLE digital_channel_config
  ADD COLUMN IF NOT EXISTS ga4_measurement_id text,
  ADD COLUMN IF NOT EXISTS meta_pixel_id text;

COMMENT ON COLUMN digital_channel_config.pedidos_recado IS
  'Recado da lojista na vitrine quando a loja nao aceita pedido (pausada ou depois de pedidos_ate). NULL = texto padrao. Ver services/modoDaLoja.js.';
