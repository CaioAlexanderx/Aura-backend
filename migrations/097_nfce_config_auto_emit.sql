-- ============================================================
-- AURA. — Migration 097: nfce_config.auto_emit_nfce
--
-- Toggle por empresa. Se true, o front (PDV) dispara emissão NFC-e
-- automaticamente após finalizar venda — sem botão "Emitir NFC-e"
-- na SaleComplete. Default false: caixa decide manualmente.
--
-- Idempotente.
-- ============================================================

ALTER TABLE nfce_config
  ADD COLUMN IF NOT EXISTS auto_emit_nfce boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN nfce_config.auto_emit_nfce IS
  'Se true, NFC-e é emitida automaticamente após finalizar venda no PDV. Default false: caixa decide via botão.';
