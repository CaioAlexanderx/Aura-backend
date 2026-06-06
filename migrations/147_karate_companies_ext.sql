-- ============================================================
-- AURA KARATÊ — Migration 147: Extensão companies
-- Adiciona colunas para federações e dojôs de karatê
-- Padrão: ADD COLUMN IF NOT EXISTS (idempotente)
-- ============================================================

-- vertical: identifica o tipo de entidade karatê
-- 'karate_federation' → a federação (ex: FPKT)
-- 'karate_dojo'       → dojô filiado
-- NULL                → empresa comum Aura (sem karatê)
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS vertical TEXT;

-- FK auto-referencial: dojô aponta para sua federação
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS federation_id UUID REFERENCES companies(id) ON DELETE SET NULL;

-- Número oficial de afiliação (ex: 'FPKT-014')
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS fpkt_affiliation_id TEXT;

-- Modelo de cobrança da anuidade do dojô
-- 'annual' | 'biannual' | 'quarterly'
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS affiliation_model TEXT;

-- Data desde quando o dojô é filiado à federação
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS affiliation_since DATE;

-- Região geográfica do dojô (ex: 'Capital', 'Grande SP', 'Litoral')
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS region TEXT;

-- Ano de fundação do dojô
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS dojo_founded_year SMALLINT;

-- URL do logotipo/emblema do dojô/federação
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS karate_logo_url TEXT;

-- Índices
CREATE INDEX IF NOT EXISTS idx_companies_vertical
  ON companies(vertical)
  WHERE vertical IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_companies_federation_id
  ON companies(federation_id)
  WHERE federation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_companies_fpkt_affiliation
  ON companies(fpkt_affiliation_id)
  WHERE fpkt_affiliation_id IS NOT NULL;

-- ============================================================
-- FIM DA MIGRATION 147
-- ============================================================
