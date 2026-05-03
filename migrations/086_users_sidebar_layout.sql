-- ============================================================
-- AURA. -- Mirror SQL: users.sidebar_layout
-- Drift fix: coluna existia em prod via Supabase MCP sem mirror.
-- Data do mirror: 03/05/2026 (Multi-CNPJ Sessao 2 closeout).
-- Ja aplicado em prod; este arquivo existe apenas para CI.
--
-- Permite ao usuario customizar a ordem/visibilidade dos itens da
-- sidebar (drag-and-drop). NULL = layout padrao do plano.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS sidebar_layout JSONB DEFAULT NULL;
