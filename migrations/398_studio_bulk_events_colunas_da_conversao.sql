-- ============================================================
-- AURA Studio. Colunas da conversao de evento em lote (tq-24)
--
-- O cabecalho de src/routes/studioBulkConvert.js diz que a "migration 134"
-- adicionou estas duas colunas, mas nenhum arquivo do repositorio as cria
-- (a 134 e studio_input_variant_multiplier). Elas EXISTEM no banco de
-- producao (conferido em 19/10/2026: tipos uuid e timestamptz, anulaveis),
-- entao la esta migration e um no-op. Em banco recriado do zero (CI,
-- ambiente novo) a conversao do lote falhava com
-- `column "digital_order_id" does not exist`.
--
-- Idempotente: so cria o que falta.
-- ============================================================

ALTER TABLE studio_bulk_event_items
  ADD COLUMN IF NOT EXISTS digital_order_id UUID DEFAULT NULL
    REFERENCES digital_orders(id) ON DELETE SET NULL;

ALTER TABLE studio_bulk_events
  ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ DEFAULT NULL;
