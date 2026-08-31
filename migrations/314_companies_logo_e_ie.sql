-- ============================================================
-- 314 — companies.logo_url e companies.inscricao_estadual
--
-- DERIVA DE SCHEMA (descoberta em 31/08/2026, ao montar a Ordem de Servico).
--
-- Estas duas colunas existem em PRODUCAO e o codigo depende delas ha meses:
--   - src/routes/company.js:12    SELECT ... logo_url
--   - src/routes/nfce.js:749      SELECT ... inscricao_estadual ... logo_url
--   - buildDanfeNfceHtml.js       imprime o logo no topo do cupom fiscal
--
-- Mas NENHUMA migration as cria. Foram adicionadas direto no Supabase, e
-- `migrations/` — que e a fonte de verdade do schema pro CI e pra qualquer
-- ambiente novo — nunca soube delas.
--
-- POR QUE NINGUEM VIU: __tests__/sqlDosTemplates.test.js manda todo SQL
-- literal pro Postgres do CI, mas so reprova em 42601 (erro de SINTAXE);
-- coluna ausente (42703) e tratada como "migration ainda nao aplicada" e
-- ignorada de proposito. O SELECT do DANFE portanto passa no CI ha meses
-- consultando uma coluna que, naquele banco, nao existe.
--
-- O QUE ISSO QUEBRA NA PRATICA: em ambiente novo (CI, staging recriado, um
-- Supabase de outra regiao) o SELECT estoura 42703 em runtime e a impressao
-- morre — a DANFE hoje, e a Ordem de Servico a partir de agora, que tem a
-- logo do lojista no cabecalho como requisito explicito do pedido.
--
-- Em producao este arquivo e no-op: as colunas ja estao la e o
-- IF NOT EXISTS nao toca em nada. O valor dele e fazer `migrations/` voltar
-- a descrever o banco de verdade.
--
-- Idempotente (padrao do repo).
-- ============================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS logo_url           TEXT,
  ADD COLUMN IF NOT EXISTS inscricao_estadual TEXT;

COMMENT ON COLUMN companies.logo_url IS
  'URL do logotipo do lojista (R2). Vai no topo da DANFE NFC-e e da Ordem de Servico. Sem ele, os documentos caem no fallback de iniciais.';

COMMENT ON COLUMN companies.inscricao_estadual IS
  'IE do emitente. Impressa no cabecalho da DANFE NFC-e e da Ordem de Servico.';
