-- 260_categories_migration_staging
-- F0 Loja Digital v2 - Bloco A
-- Estado do wizard de migracao, no SERVIDOR. E o que permite abandono seguro:
-- fechar o app no meio nao perde nada e o wizard reabre de onde parou.
-- SEM COLUNAS DE IA: kind e target_path sao preenchidos pelo LOJISTA (spec v2 secao 5).

CREATE TABLE IF NOT EXISTS category_migration_staging (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  raw_value            text,               -- 'Sandalia Feminina' | NULL para a linha orfa
  product_count        integer NOT NULL DEFAULT 0,
  sample_product_names text[],             -- ate 5, para o lojista reconhecer
  kind                 text,               -- decidido pelo lojista; NULL enquanto pendente
  target_path          text,               -- 'Feminino > Calcados > Sandalias'
  status               text NOT NULL DEFAULT 'pending',
  resolved_category_id uuid REFERENCES product_categories(id) ON DELETE SET NULL,
  resolved_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Idempotencia do analyze: uma linha por valor-texto distinto + uma linha orfa.
CREATE UNIQUE INDEX IF NOT EXISTS category_migration_staging_unique
  ON category_migration_staging (company_id, COALESCE(raw_value, '__NULL__'));

DO $$
BEGIN
  ALTER TABLE category_migration_staging
    ADD CONSTRAINT category_migration_staging_kind_chk
    CHECK (kind IS NULL OR kind IN ('category','brand','attribute','collection','discard'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE category_migration_staging
    ADD CONSTRAINT category_migration_staging_status_chk
    CHECK (status IN ('pending','approved','rejected','applied'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE category_migration_staging ENABLE ROW LEVEL SECURITY;
