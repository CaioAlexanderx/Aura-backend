-- ============================================================
-- 116_sales_liquid_view.sql
-- View canonica de "venda liquida" — resolve a armadilha de
-- armadilha_trocas_inflam_agregados de uma vez:
--
--   sales.total_amount nas vendas type='troca' guarda newValue
--   (valor dos itens NOVOS, nao o liquido). SUM(total_amount) sem
--   filtrar type='troca' superestima receita.
--
-- A view abaixo expoe:
--   - gross_total   = sales.total_amount (cru)
--   - returned_value = soma de troca_returned_items quando troca
--   - net_total     = gross - returned (no caso de troca);
--                     = gross (no caso de venda normal)
--
-- Uso recomendado: SUBSTITUIR SUM(sales.total_amount) por
--   SUM(net_total) em relatorios, ranking, faturamento, DRE etc.
-- Filtra cancelled tambem pra simplificar — caller nao precisa
-- mais lembrar de checar status.
--
-- Doc: Aura/AUDITORIA_TROCA_PDV_2026-05-17.docx (Fase 1)
-- ============================================================

CREATE OR REPLACE VIEW sales_liquid AS
SELECT
  s.id              AS sale_id,
  s.company_id,
  s.customer_id,
  s.seller_id,
  s.employee_id,
  s.created_at,
  COALESCE(s.type, 'sale') AS type,
  s.status,
  s.payment_method,
  s.exchange_of_sale_id,
  s.total_amount    AS gross_total,
  -- returned_value: soma os returned_items quando troca; 0 senao.
  COALESCE((
    SELECT SUM(tri.quantity * tri.unit_price)
      FROM troca_returned_items tri
     WHERE tri.troca_sale_id = s.id
  ), 0)::NUMERIC(12,2) AS returned_value,
  -- net_total:
  --   troca → total_amount (newValue) − returnedValue
  --   sale  → total_amount
  CASE
    WHEN COALESCE(s.type, 'sale') = 'troca'
      THEN (s.total_amount - COALESCE((
        SELECT SUM(tri.quantity * tri.unit_price)
          FROM troca_returned_items tri
         WHERE tri.troca_sale_id = s.id
      ), 0))::NUMERIC(12,2)
    ELSE s.total_amount::NUMERIC(12,2)
  END AS net_total
FROM sales s
WHERE s.status != 'cancelled';

COMMENT ON VIEW sales_liquid IS
  'Visao canonica de venda liquida — evita SUM(total_amount) descuidado. '
  'Em trocas, net_total desconta returnedValue. Filtra cancelled. '
  'Doc: armadilha_trocas_inflam_agregados (memoria).';
