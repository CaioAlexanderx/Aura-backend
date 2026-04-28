-- ============================================================
-- 074_customers_photo_url.sql
--
-- PR30 (2026-04-28): adiciona coluna photo_url em customers
-- pra suportar foto do paciente capturada via webcam.
--
-- Aceita:
--   - Data URL (data:image/jpeg;base64,...) - quando capturada
--     pelo WebcamCapture e enviada inline. Limite logico ~3MB
--     (jpeg quality 0.85 a 1280x720).
--   - URL externa (https://...) - se no futuro tivermos object
--     storage e o frontend uplodar pra la primeiro.
--
-- text sem limite formal; em prod, caller deve validar tamanho
-- antes de PATCH pra nao explodir o row.
--
-- Idempotente (IF NOT EXISTS).
-- ============================================================

ALTER TABLE customers ADD COLUMN IF NOT EXISTS photo_url text;

COMMENT ON COLUMN customers.photo_url IS 'Foto do paciente: data URL (base64 inline) ou URL externa. PR30 #13.';
