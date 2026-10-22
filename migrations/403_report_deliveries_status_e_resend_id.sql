-- ============================================================
-- 403 — report_deliveries: colunas do status de entrega (tq-72)
--
-- O relatório semanal de 19/10 saiu (sent=3 errors=0), mas cada
-- envio registrou "updateDelivery error: inconsistent types deduced
-- for parameter $2" e as linhas ficaram 'pending'. A correção está
-- no código (src/services/reportGenerator.js, updateDelivery). Esta
-- migration só garante que as colunas que o UPDATE grava existem.
--
-- A tabela nasceu em src/migrations/103_report_deliveries.sql, fora
-- da pasta do runner, aplicada à mão. Ela já declara resend_id,
-- attempts, last_error e sent_at; como não há como provar daqui que
-- o banco de produção está igual ao arquivo, a 403 repete o que o
-- código precisa, sem mexer em nada que já exista:
--   - CREATE TABLE IF NOT EXISTS: o banco do CI (que só aplica
--     migrations/) passa a ter a tabela; em produção é no-op.
--   - ADD COLUMN IF NOT EXISTS: no-op quando a coluna já existe.
--
-- Não toca em linha nenhuma. Não muda tipo, CHECK nem default de
-- coluna existente. Desfazer: nada a desfazer além de, se quiser,
-- remover colunas que a 403 tenha criado (o código antigo não as lê).
-- ============================================================

CREATE TABLE IF NOT EXISTS report_deliveries (
  id             SERIAL PRIMARY KEY,
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  report_type    VARCHAR(10) NOT NULL CHECK (report_type IN ('weekly', 'monthly')),
  period_start   DATE NOT NULL,
  status         VARCHAR(20) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'sent', 'failed')),
  resend_id      VARCHAR(100),
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  sent_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE report_deliveries ADD COLUMN IF NOT EXISTS resend_id  VARCHAR(100);
ALTER TABLE report_deliveries ADD COLUMN IF NOT EXISTS attempts   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE report_deliveries ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE report_deliveries ADD COLUMN IF NOT EXISTS sent_at    TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_report_deliveries_company_type_period
  ON report_deliveries (company_id, report_type, period_start);

CREATE INDEX IF NOT EXISTS idx_report_deliveries_status
  ON report_deliveries (status)
  WHERE status != 'sent';
