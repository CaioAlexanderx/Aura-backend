-- ============================================================
-- 103_sale_payments_sessao_id.sql
-- Schema-only: garante coluna sale_payments.sessao_id (já criada
-- na migration 093 do módulo de caixa, mas re-aplicamos defensivamente
-- com IF NOT EXISTS para clientes em bases que tenham o caixa
-- desativado e não rodaram 093).
--
-- Backfill de DADOS (criar sale_payments retroativos, vincular
-- sessao_id em rows antigas) NÃO faz parte desta migration. Esses
-- dados são pontuais e ficam em scripts/backfill_sale_payments_<cliente>.sql
-- aplicados sob demanda. Razão: nem todo cliente em produção quer
-- ver fechamentos antigos "corrigidos" se o relatório histórico
-- já foi exportado/contabilizado de outra forma.
-- ============================================================

ALTER TABLE sale_payments
  ADD COLUMN IF NOT EXISTS sessao_id UUID
    REFERENCES caixa_sessoes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sale_payments_sessao
  ON sale_payments(sessao_id)
  WHERE sessao_id IS NOT NULL;

COMMENT ON COLUMN sale_payments.sessao_id IS
  'Vínculo direto com a sessão de caixa aberta no momento da venda. '
  'NULL = venda sem caixa aberto OU vinculada por fallback de período. '
  'Preenchido pelo PDV (pdv.js POST /sale) consultando a sessão aberta.';
