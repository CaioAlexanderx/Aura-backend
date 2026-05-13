-- ============================================================
-- Migration 111 - sales.exchange_seller_id + exchange_employee_id
--
-- 12/05/2026: Troca cross-filial (pedido cliente Davi - PR backend).
-- Cliente compra na Filial 1, vai trocar fisicamente na Filial 2.
--
-- Decisao D1 (BACKLOG_TROCA_CROSS_FILIAL.md): sales row da troca
-- registra no CNPJ de ORIGEM (Filial 1) pra cancel_reissue de NFC-e
-- funcionar (mesmo CNPJ cancela propria NFC-e) e evitar NF-e modelo 55
-- de devolucao + NF-e de transferencia inter-CNPJ.
--
-- Decisao D2: vendedor original (Filial 1) fica em seller_id apenas em
-- cross-filial; vendedor que atendeu a troca presencialmente (Filial 2)
-- vai em exchange_seller_id. Em troca same-filial mantemos o
-- comportamento atual (seller_id = req.user.id) pra nao quebrar ranking
-- existente. Comissao: vendedor 1 fica com returnedValue neutralizado
-- (entrega <-> devolucao), vendedor 2 fica com netAmount.
--
-- Idempotente (IF NOT EXISTS em coluna + indice).
--
-- Doc: Aura/BACKLOG_TROCA_CROSS_FILIAL.md
-- ============================================================

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS exchange_seller_id UUID
    REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS exchange_employee_id UUID
    REFERENCES employees(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sales_exchange_seller
  ON sales(exchange_seller_id)
  WHERE exchange_seller_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sales_exchange_employee
  ON sales(exchange_employee_id)
  WHERE exchange_employee_id IS NOT NULL;

COMMENT ON COLUMN sales.exchange_seller_id IS
  'Vendedor (users) que atendeu a troca presencialmente. NULL em vendas type=sale e em troca same-filial. Diverge de seller_id em troca cross-filial - seller_id herda do vendedor da venda original. Migration 111 (troca cross-filial - Davi 12/05/2026).';

COMMENT ON COLUMN sales.exchange_employee_id IS
  'Funcionario (employees) que atendeu a troca presencialmente. NULL em vendas type=sale e em troca same-filial. Diverge de employee_id em troca cross-filial. Migration 111.';
