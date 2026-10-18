-- ============================================================
-- 397 — Impressão de etiqueta: uma linha por empresa e dia (card tq-23)
--
-- Contexto (18/10/2026): imprimir etiqueta é um GET
-- (/companies/:id/products/:pid/label/print) que não gravava nada, então o
-- bloco "Uso por funcionalidade" da Gestão Aura mostrava Etiquetas "sem
-- medida". Esta tabela é o rastro mínimo: quantas vezes a loja abriu a
-- impressão no dia e quantas etiquetas pediu. NENHUM dado de produto, nome,
-- preço ou código entra aqui.
--
-- `dia` é o dia de Brasília. A rota faz upsert (company_id, dia) e nunca
-- espera nem falha por causa dele. Idempotente; o backend pode subir antes
-- desta migration (a rota engole 42P01).
--
-- Para ler:
--   SELECT dia, COUNT(*) AS lojas, SUM(prints) AS impressoes, SUM(labels) AS etiquetas
--     FROM label_print_days WHERE dia > CURRENT_DATE - 30 GROUP BY dia ORDER BY dia;
-- ============================================================

CREATE TABLE IF NOT EXISTS label_print_days (
  company_id uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  dia        date        NOT NULL,
  prints     integer     NOT NULL DEFAULT 0,
  labels     integer     NOT NULL DEFAULT 0,
  last_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, dia)
);

COMMENT ON TABLE label_print_days IS 'Uso da impressao de etiqueta por empresa e dia (Brasilia). Sem dado de produto.';
COMMENT ON COLUMN label_print_days.prints IS 'Vezes que a impressao foi aberta no dia.';
COMMENT ON COLUMN label_print_days.labels IS 'Soma das etiquetas pedidas (qty) nessas aberturas.';
