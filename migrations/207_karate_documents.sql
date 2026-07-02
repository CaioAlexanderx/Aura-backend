-- ============================================================
-- AURA KARATÊ — Fase 2: anexos (documentos/imagens) para DOJÔ e PRATICANTE
--
-- Tabela de METADADOS apenas. O binário vive no R2 (src/utils/r2Storage.js).
-- A listagem vem desta tabela (não de listR2Files) para preservar
-- filename/note/data de upload original mesmo que a convenção de key mude.
--
-- Idempotente: seguro reaplicar.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id uuid NOT NULL,
  owner_type text NOT NULL CHECK (owner_type IN ('dojo','practitioner')),
  owner_id uuid NOT NULL,
  r2_key text NOT NULL,
  filename text NOT NULL,
  content_type text,
  size_bytes bigint,
  note text,
  uploaded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_karate_documents_owner
  ON karate_documents(federation_id, owner_type, owner_id);
