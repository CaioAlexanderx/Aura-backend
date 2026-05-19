-- ============================================================
-- Migration 120: sub_vertical em companies + market_benchmarks
-- ============================================================
-- Fase B1 do redesign Financeiro (19/05/2026):
-- - Adiciona companies.sub_vertical (TEXT) — sub-segmentação manual
--   pelo Gestão Aura. Útil pra varejo (vertical_active=NULL é saco de
--   gatos: calçados, moda, perfumaria, etc). Sem este campo, benchmark
--   agruparia produtos completamente diferentes.
-- - Cria tabela market_benchmarks — percentis P25/P50/P75 por bucket
--   (vertical + sub_vertical + tax_regime_bucket + size_bucket), por
--   mês de referência. Alimentada via cron mensal. Anonimização LGPD:
--   sample_size mínimo de 10 por bucket (filtrado no cron).
-- ============================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS sub_vertical TEXT;

CREATE INDEX IF NOT EXISTS idx_companies_sub_vertical
  ON companies(vertical_active, sub_vertical)
  WHERE sub_vertical IS NOT NULL;

CREATE TABLE IF NOT EXISTS market_benchmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vertical TEXT,                  -- match com companies.vertical_active (NULL = varejo)
  sub_vertical TEXT,              -- match com companies.sub_vertical (pode ser NULL)
  tax_regime_bucket TEXT,         -- 'mei' | 'simples' | 'presumido' | 'real' (NULL = qualquer)
  size_bucket TEXT,               -- 'micro' (<100k/mes) | 'small' (100k-500k) | 'medium' (500k-2M) | 'large' (>2M)
  reference_month DATE NOT NULL,  -- primeiro dia do mês de referência (YYYY-MM-01)
  metric_name TEXT NOT NULL,      -- 'avg_ticket' | 'margin_pct' | 'revenue_growth_mom'
  p25 NUMERIC NOT NULL,
  p50 NUMERIC NOT NULL,
  p75 NUMERIC NOT NULL,
  sample_size INT NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Uniqueness: 1 row por (bucket, mes, metrica). COALESCE pra tratar NULLs
-- como valores comparáveis (NULL = qualquer no bucket).
CREATE UNIQUE INDEX IF NOT EXISTS uq_market_benchmarks_bucket_month_metric
  ON market_benchmarks (
    COALESCE(vertical, ''),
    COALESCE(sub_vertical, ''),
    COALESCE(tax_regime_bucket, ''),
    COALESCE(size_bucket, ''),
    reference_month,
    metric_name
  );

-- Lookup index — usado pelo GET /benchmarks/me (filtra por vertical+sub_vertical+metric+mes recente)
CREATE INDEX IF NOT EXISTS idx_market_benchmarks_lookup
  ON market_benchmarks (vertical, sub_vertical, reference_month DESC, metric_name);

COMMENT ON TABLE market_benchmarks IS
  'Percentis P25/P50/P75 por bucket (vertical+sub_vertical+regime+tamanho+mes) por metrica. Alimentado por cron mensal. sample_size minimo 10 (LGPD).';
COMMENT ON COLUMN companies.sub_vertical IS
  'Sub-segmentacao manual (preenchida via Gestao Aura). Varejo: calcados | moda | perfumaria | acessorios | presentes | papelaria | eletronicos | brinquedos | casa | esportes | outros. NULL = sem sub-segmentacao.';
