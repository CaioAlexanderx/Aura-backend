-- ============================================================
-- 430 — credit_collection_events alinhada com a producao (09/11/2026)
--
-- A tabela de producao foi criada a mao, antes da 136, e tem outro
-- formato: company_id uuid NOT NULL, customer_id uuid NOT NULL,
-- channel/template/days_relative NOT NULL e sent_at timestamptz NOT NULL
-- DEFAULT now() -- e NAO tem created_at. A 136 usa CREATE TABLE IF NOT
-- EXISTS, entao em producao ela nao fez nada; num banco limpo (CI) ela
-- cria a versao antiga, sem company_id, customer_id nem sent_at.
--
-- Esta migration so faz o banco limpo ganhar as colunas que a producao
-- ja tem, para o codigo (que agora grava company_id/customer_id) rodar
-- igual nos dois. Em producao tudo aqui e no-op.
--
-- So ADITIVA e idempotente:
--   - company_id / customer_id entram NULAVEIS (NOT NULL exigiria
--     backfill; em producao ja sao NOT NULL e o IF NOT EXISTS nao mexe);
--   - sent_at NOT NULL DEFAULT now(): now() e estavel, entao o PG 11+
--     nao reescreve a tabela; em producao a coluna ja existe;
--   - indice (company_id, sent_at) para o historico por loja.
-- Nada de DROP, nada de UPDATE, nenhum dado existente muda.
-- O runner aplica com SET LOCAL lock_timeout.
--
-- Caminho de volta (depois de reverter o PR; em producao NAO rodar o
-- DROP COLUMN -- as colunas sao da tabela original):
--   DROP INDEX IF EXISTS idx_cce_company_sent;
-- ============================================================

ALTER TABLE credit_collection_events ADD COLUMN IF NOT EXISTS company_id  UUID NULL;
ALTER TABLE credit_collection_events ADD COLUMN IF NOT EXISTS customer_id UUID NULL;
ALTER TABLE credit_collection_events ADD COLUMN IF NOT EXISTS sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_cce_company_sent ON credit_collection_events (company_id, sent_at);
