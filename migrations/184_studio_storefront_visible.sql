-- 184_studio_storefront_visible.sql
-- 16/06/2026 — Visibilidade de item na Loja Virtual (Studio storefront).
--
-- Permite ao lojista escolher quais produtos personalizaveis aparecem na
-- vitrine publica (/storefront/:slug/studio). Coluna DEDICADA: NAO reusa
-- is_active (que desativa o produto em todo o sistema). Default TRUE preserva
-- o comportamento atual — todos os personalizaveis continuam aparecendo; o
-- lojista oculta os que nao quiser pelo configurador do produto (Estoque Studio).
--
-- Idempotente (ADD COLUMN IF NOT EXISTS). Postgres 11+ adiciona coluna com
-- default sem reescrever a tabela.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS studio_storefront_visible boolean NOT NULL DEFAULT true;
