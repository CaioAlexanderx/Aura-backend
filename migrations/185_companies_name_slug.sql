-- ============================================================
-- AURA KARATÊ — Migration 185: companies.name + companies.slug
-- ============================================================
-- As rotas da vertical karatê (karateFederation.js, karateDojos.js,
-- karateAnnuities.js, karateCompetitions.js, etc.) referenciam
-- companies.name e companies.slug ~79×, inclusive nos INSERTs de
-- criação de federação/dojô. Essas colunas nunca existiram na
-- tabela companies (que usa legal_name/trade_name), então TODA rota
-- karatê estoura `column "name" does not exist` (500) em produção.
-- Os testes não pegaram porque mockam o pool do Postgres.
--
-- Fix aditivo e idempotente: cria as duas colunas e faz backfill de
-- name a partir de trade_name/legal_name (defensivo — não há empresa
-- karatê em prod ainda). slug fica livre; unicidade só é exigida
-- entre federações de karatê (a rota de setup faz dedupe por slug).
-- ============================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS slug TEXT;

-- Backfill: garante que c.name nunca volte NULL nas listagens karatê.
UPDATE companies
   SET name = COALESCE(name, trade_name, legal_name)
 WHERE name IS NULL;

-- Slug único apenas entre federações de karatê (dedupe da rota
-- POST /karate/federation/setup, que checa slug + vertical).
CREATE UNIQUE INDEX IF NOT EXISTS uq_companies_slug_karate_federation
  ON companies (slug)
  WHERE slug IS NOT NULL AND vertical = 'karate_federation';

-- ============================================================
-- FIM DA MIGRATION 185
-- ============================================================
