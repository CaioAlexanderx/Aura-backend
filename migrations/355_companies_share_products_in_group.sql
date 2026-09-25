-- ============================================================
-- 355 — Estoque separado por empresa dentro do grupo (multi-CNPJ)
--
-- Contexto (25/09/2026): o Luis Henrique tem dois CNPJs no mesmo grupo
-- de faturamento, uma adega e uma loja de roupas. O POST /products liga
-- is_group_shared sozinho para toda empresa em grupo (migration 100/102),
-- entao cada produto novo de uma loja aparecia no estoque e no PDV da
-- outra. O Davi (Matriz + Villa Branca) usa exatamente esse
-- compartilhamento, entao ele continua sendo o padrao.
--
-- DECISOES:
-- - true = compartilha (comportamento de hoje). DEFAULT true e sem
--   backfill: nenhuma empresa muda com esta migration.
-- - O grupo conta como SEPARADO se qualquer empresa dele estiver false.
--   A rota de configuracao (PATCH /me/companies/stock-sharing) grava o
--   valor em todas as empresas do grupo; ler "qualquer uma false" faz
--   com que um CNPJ novo (nasce true) ou uma troca de principal nao
--   reabram o compartilhamento sem o dono pedir.
-- - Ligar/desligar tambem acerta products.is_group_shared dos produtos
--   ja cadastrados no grupo (na rota, em transacao).
-- ============================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS share_products_in_group BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN companies.share_products_in_group IS
  'false = estoque separado por empresa no grupo multi-CNPJ. O grupo e separado se qualquer empresa dele for false.';

-- Auditoria da troca: a 082 fechou a lista de acoes com CHECK.
ALTER TABLE multicnpj_audit DROP CONSTRAINT IF EXISTS multicnpj_audit_action_check;
ALTER TABLE multicnpj_audit ADD CONSTRAINT multicnpj_audit_action_check CHECK (action IN (
  'add_company', 'remove_company', 'switch_company', 'transfer_primary', 'update_billing',
  'stock_sharing'
));
