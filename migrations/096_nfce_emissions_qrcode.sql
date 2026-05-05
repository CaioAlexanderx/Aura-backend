-- ============================================================
-- AURA. — Migration 096: NFC-e — qr_code + url_consulta
--
-- Nuvem Fiscal devolve em infNFeSupl o qrCode (string completa
-- com parâmetros pra gerar a imagem do QR) e a urlChave (URL pública
-- de consulta na SEFAZ). Persistimos pra renderizar na tela do PDV
-- (SaleComplete) sem precisar reconsultar a API.
--
-- Idempotente.
-- ============================================================

ALTER TABLE nfce_emissions
  ADD COLUMN IF NOT EXISTS qr_code      text,
  ADD COLUMN IF NOT EXISTS url_consulta text;
