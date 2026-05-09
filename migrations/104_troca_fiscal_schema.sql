-- ============================================================
-- 104_troca_fiscal_schema.sql
-- Schema-only: adiciona colunas de rastreio fiscal nas trocas.
-- Suporta 2 estrategias:
--   * 'cancel_reissue': cancela NFC-e original + emite nova NFC-e
--     pela nova venda (troca <24h)
--   * 'devolucao_55':  emite NF-e modelo 55 finalidade=4 referenciando
--     NFC-e original + emite nova NFC-e pela nova venda (troca >24h
--     ou parcial)
--   * 'none': nenhuma operação fiscal (legado/cliente sem NFC-e)
--
-- Vendas comuns (type != 'troca') ficam com todos esses campos NULL.
-- Idempotente via IF NOT EXISTS — pode rodar múltiplas vezes sem efeito.
-- ============================================================

-- 1. sales: estratégia escolhida + chaves dos documentos fiscais emitidos
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS nfce_strategy TEXT NULL;

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS nfce_original_chave TEXT NULL;

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS nfce_devolucao_chave TEXT NULL;

-- Constraint defensiva: valores válidos para nfce_strategy.
-- Bloco DO pra ser idempotente (DROP+ADD vs ADD only).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_sales_nfce_strategy'
  ) THEN
    ALTER TABLE sales
      ADD CONSTRAINT chk_sales_nfce_strategy
      CHECK (nfce_strategy IS NULL OR nfce_strategy IN ('cancel_reissue', 'devolucao_55', 'none'));
  END IF;
END
$$;

COMMENT ON COLUMN sales.nfce_strategy IS
  'Estratégia fiscal da troca: cancel_reissue (cancela NFC-e original + reemite), devolucao_55 (NF-e modelo 55 finalidade=4 + nova NFC-e), none (sem operação fiscal). NULL para vendas que não são trocas.';

COMMENT ON COLUMN sales.nfce_original_chave IS
  'Chave de acesso da NFC-e da venda original referenciada na troca. 44 dígitos quando preenchida.';

COMMENT ON COLUMN sales.nfce_devolucao_chave IS
  'Chave de acesso do documento de devolução emitido (NFC-e cancelada na cancel_reissue, ou NF-e modelo 55 finalidade=4 na devolucao_55).';

-- 2. nfce_emissions: finalidade SEFAZ + referência a documento original
ALTER TABLE nfce_emissions
  ADD COLUMN IF NOT EXISTS finalidade SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE nfce_emissions
  ADD COLUMN IF NOT EXISTS ref_chave_nfe TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_nfce_emissions_finalidade'
  ) THEN
    ALTER TABLE nfce_emissions
      ADD CONSTRAINT chk_nfce_emissions_finalidade
      CHECK (finalidade IN (1, 2, 3, 4));
  END IF;
END
$$;

COMMENT ON COLUMN nfce_emissions.finalidade IS
  'Finalidade SEFAZ: 1=Normal (default), 2=Complementar, 3=Ajuste, 4=Devolução. Apenas modelo 55 (NF-e) usa finalidade=4 referenciando nfe_emissions.ref_chave_nfe.';

COMMENT ON COLUMN nfce_emissions.ref_chave_nfe IS
  'Chave de acesso (44 dígitos) do documento referenciado quando finalidade=4 (devolução). Aponta para a NFC-e original que está sendo "devolvida" via NF-e modelo 55.';

-- 3. Índices parciais — só rows que efetivamente têm rastreio fiscal
CREATE INDEX IF NOT EXISTS idx_sales_nfce_strategy
  ON sales (nfce_strategy)
  WHERE nfce_strategy IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_nfce_emissions_finalidade
  ON nfce_emissions (finalidade, ref_chave_nfe)
  WHERE finalidade != 1;

-- Sanity check: log das colunas adicionadas
DO $$
DECLARE
  cnt_sales INTEGER;
  cnt_emiss INTEGER;
BEGIN
  SELECT COUNT(*) INTO cnt_sales
  FROM information_schema.columns
  WHERE table_name = 'sales'
    AND column_name IN ('nfce_strategy', 'nfce_original_chave', 'nfce_devolucao_chave');

  SELECT COUNT(*) INTO cnt_emiss
  FROM information_schema.columns
  WHERE table_name = 'nfce_emissions'
    AND column_name IN ('finalidade', 'ref_chave_nfe');

  RAISE NOTICE '[migration 104] colunas em sales: %/3, em nfce_emissions: %/2', cnt_sales, cnt_emiss;
END
$$;
