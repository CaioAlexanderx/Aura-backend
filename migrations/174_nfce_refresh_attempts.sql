-- ============================================================
-- AURA. — Migration 174: retry/backoff de notas 'processando' (S2.4)
-- Emissão própria NFC-e: contador de tentativas de consulta + última
-- tentativa, pro job nfceRefreshJob aplicar backoff exponencial.
-- Idempotente.
-- ============================================================

ALTER TABLE nfce_emissions
  ADD COLUMN IF NOT EXISTS refresh_attempts SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_refresh_at  TIMESTAMPTZ;

COMMENT ON COLUMN nfce_emissions.refresh_attempts IS 'Tentativas de consulta pós-emissão (backoff exponencial, cap 10) — S2.4';
COMMENT ON COLUMN nfce_emissions.last_refresh_at  IS 'Última consulta de situação pelo job/refresh manual — S2.4';

-- fila do job: só processando da emissão própria
CREATE INDEX IF NOT EXISTS idx_nfce_emissions_retry_queue
  ON nfce_emissions(company_id, created_at)
  WHERE status = 'processando' AND xml_signed IS NOT NULL;
