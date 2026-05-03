-- ============================================================
-- AURA. -- Mirror SQL: companies.pdv_settings
-- Drift fix: coluna existia em prod via Supabase MCP sem mirror.
-- Data do mirror: 03/05/2026 (Multi-CNPJ Sessao 2 closeout).
-- Ja aplicado em prod; este arquivo existe apenas para CI.
--
-- Configuracoes do PDV por empresa (require_seller, require_customer,
-- defaults de pagamento, etc.). Schema flexivel via JSONB.
-- Default: nao exige vendedor nem cliente identificado na venda.
-- ============================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS pdv_settings JSONB DEFAULT '{"require_seller": false, "require_customer": false}'::jsonb;
