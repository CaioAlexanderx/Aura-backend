-- ============================================================
-- 142_fix_nfce_emissions_devolucao_columns.sql
--
-- Caso Davi (01/06/2026): a troca com NF-e 55 de devolucao (devolucao_55)
-- nao registrava NADA — nem venda, nem baixa de estoque — e o DANFE dava 404.
--
-- Causa: services/trocaV2.js insere uma emissao pendente assim:
--   INSERT INTO nfce_emissions (company_id, sale_id, tipo, status, notes)
--   VALUES ($1, $2, 'nfe_devolucao', 'pendente', 'devolucao_55 origem=...')
-- mas o schema real da tabela era incompativel em 3 pontos:
--   1) coluna `notes` nao existia            -> 42703 undefined_column
--   2) `numero` era NOT NULL sem default     -> 23502 not_null_violation
--   3) `tipo` era varchar(10) < 'nfe_devolucao' (13 chars) -> 22001 string_data_right_truncation
-- Qualquer erro DENTRO da transacao da troca a aborta; o catch "non-fatal"
-- do codigo seguia ate o COMMIT, que num tx abortado vira ROLLBACK. Resultado:
-- a troca inteira (sale + sale_items + estoque + sale_payments + transactions)
-- era descartada silenciosamente, e o frontend ainda recebia um "sucesso" com
-- um sale_id inexistente (dai o 404 do DANFE).
--
-- Fix idempotente. Aplicado em prod via Supabase MCP em 01/06; este arquivo
-- existe para rastreabilidade / deploys limpos.
-- ============================================================

ALTER TABLE nfce_emissions ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE nfce_emissions ALTER COLUMN numero DROP NOT NULL;
ALTER TABLE nfce_emissions ALTER COLUMN tipo TYPE varchar(30);
