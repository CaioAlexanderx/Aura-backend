-- ============================================================
-- 435 — Endereco de entrega da venda (09/11/2026)
--
-- "Endereco do cliente para entrega", parte 2. A venda com frete do
-- Caixa passa a guardar PARA ONDE vai a entrega: quem recebe (nome e
-- telefone), o endereco, o ponto de referencia e o recado.
--
-- E um RETRATO tirado no momento da venda: o papel de entrega
-- reimpresso depois sai igual, mesmo que o cadastro do cliente mude.
-- Por isso jsonb na propria venda, e nao um id de endereco.
--
-- Formato (src/services/entregaDaVenda.js):
--   { name, phone, zip_code, street, number, complement, neighborhood,
--     city, state, address_reference, note }
--
-- So ADITIVA e idempotente: coluna nulavel, sem default, sem backfill,
-- sem indice. Sem reescrita de tabela. NULL = venda sem endereco (todas
-- as vendas de antes desta migration).
-- ============================================================

ALTER TABLE sales ADD COLUMN IF NOT EXISTS delivery_address jsonb;

COMMENT ON COLUMN sales.delivery_address IS
  'Retrato do endereco de entrega no momento da venda (nome, telefone, endereco, referencia, recado). Migration 435.';
