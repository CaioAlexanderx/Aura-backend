-- ============================================================
-- 433 — Ponto de referencia do endereco do cliente (09/11/2026)
--
-- "Endereco do cliente para entrega", parte 1. O cadastro do varejo
-- passa a gravar o endereco nas colunas que customers ja tem desde a
-- 001/073 (zip_code, street, number, complement, neighborhood, city,
-- state). Falta so o ponto de referencia ("portao azul, ao lado da
-- padaria"), que o papel de entrega (parte 2) imprime.
--
-- Canonicos: number e zip_code. address_number e postal_code (073)
-- estao vazios em 100% dos clientes do varejo e nao sao tocados aqui.
--
-- So ADITIVA e idempotente: coluna nulavel, sem default, sem backfill.
-- Sem reescrita de tabela.
-- ============================================================

ALTER TABLE customers ADD COLUMN IF NOT EXISTS address_reference text;

COMMENT ON COLUMN customers.address_reference IS
  'Ponto de referencia do endereco de entrega (ex.: portao azul). Migration 433.';
