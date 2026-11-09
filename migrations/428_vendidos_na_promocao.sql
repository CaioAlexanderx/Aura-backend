-- ============================================================
-- 428 — Vendidos na promocao (p-92, 08/11/2026)
--
-- O item vendido passa a guardar se saiu na promocao De/Por (427):
--   sale_items.preco_lista  o "De" (preco normal) na hora da venda
--   sale_items.em_promocao  true = a promocao valia na hora da venda;
--                           false = o produto foi conferido e nao estava;
--                           NULL = nao sabemos (venda anterior a esta
--                           migration, item avulso, data retroativa)
--
-- Quem grava: POST /pdv/sale (e /sale-com-sinal) e os itens novos da troca
-- (services/vendaNaPromocao.js). Nada muda no unit_price nem nos totais.
-- Quem le: GET /companies/:id/products/promotions/vendidos.
--
-- Aditiva: colunas nulas, sem DEFAULT e sem preencher o passado (nao
-- reescreve a tabela; so muda o catalogo). Sem indice novo: o resumo
-- chega pelos indices de sales (empresa, data) e sale_items(sale_id).
-- Idempotente. O runner aplica com SET LOCAL lock_timeout.
--
-- Caminho de volta (depois de reverter o PR; as colunas podem ficar):
--   ALTER TABLE sale_items DROP COLUMN IF EXISTS em_promocao,
--     DROP COLUMN IF EXISTS preco_lista;
-- ============================================================

ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS preco_lista NUMERIC(12,2) NULL;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS em_promocao BOOLEAN NULL;
