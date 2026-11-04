-- ============================================================
-- 426 — Tipo de e-mail "fechamento_mes" em company_email_prefs
--
-- 03/11/2026: e-mail de fechamento do mês com a planilha de vendas por
-- numeração (services/fechamentoDoMes.js; aura-app docs/mockups/
-- relatorio-vendas-por-numeracao.html, tela 6). A preferência (ligar,
-- desligar, descadastro pelo link do e-mail) grava uma linha com
-- tipo = 'fechamento_mes', que o CHECK da migration 409 recusava.
-- Troca o CHECK pelo mesmo conjunto + o tipo novo. Idempotente.
-- ============================================================
ALTER TABLE company_email_prefs DROP CONSTRAINT IF EXISTS company_email_prefs_tipo_check;
ALTER TABLE company_email_prefs ADD CONSTRAINT company_email_prefs_tipo_check
  CHECK (tipo = ANY (ARRAY['relatorio', 'ajuda', 'acompanhamento', 'novidades', 'pedido_loja', 'fechamento_mes']));
