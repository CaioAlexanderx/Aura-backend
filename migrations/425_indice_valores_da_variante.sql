-- ============================================================
-- 425 — Índice em product_variant_values(variant_id)
--
-- 03/11/2026: o relatório "Vendas por produto e numeração" (aura-app
-- docs/mockups/relatorio-vendas-por-numeracao.html) lê a numeração de cada
-- variante. A tabela não tinha índice NENHUM (conferido em produção com
-- pg_indexes): toda leitura de atributo por variante varria a tabela
-- inteira. O índice também atende as outras leituras de atributo
-- (bipe, etiquetas, grade do cadastro). Aditiva e idempotente.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_product_variant_values_variant
  ON product_variant_values(variant_id);
