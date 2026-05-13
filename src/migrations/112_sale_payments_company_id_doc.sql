-- ============================================================
-- Migration 112 - sale_payments.company_id semantica desacoplada
--
-- 12/05/2026: Doc-only migration (acompanha 111 - troca cross-filial).
--
-- Em troca cross-filial (Davi), sale_payments.company_id passa a
-- divergir de sales.company_id:
--
--   sales.company_id         = CNPJ origem da venda (Filial 1).
--                              NFC-e emitida sob esse CNPJ.
--   sale_payments.company_id = CNPJ fisico (Filial 2) onde o dinheiro
--                              efetivamente passou na maquininha.
--                              Necessario pra conciliacao bancaria
--                              bater (TEF deposita no CNPJ da maquininha).
--
-- Nenhuma alteracao estrutural. Atualiza apenas o COMMENT pra futuras
-- consultas entenderem que a divergencia e POR DESIGN. Em vendas normais
-- (POST /pdv/sale) os dois continuam coincidindo.
--
-- Idempotente (so re-roda COMMENT ON COLUMN).
--
-- Doc: Aura/BACKLOG_TROCA_CROSS_FILIAL.md
-- ============================================================

COMMENT ON COLUMN sale_payments.company_id IS
  'CNPJ onde o dinheiro fisicamente passou (maquininha/caixa fisico). Em vendas normais coincide com sales.company_id. Em troca cross-filial (migration 111+) PODE divergir: sales.company_id = CNPJ origem, sale_payments.company_id = CNPJ fisico do operador. Conciliacao bancaria e fechamento de caixa usam sale_payments.company_id, nao sales.company_id.';
