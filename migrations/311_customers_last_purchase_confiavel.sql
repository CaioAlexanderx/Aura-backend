-- ============================================================
-- 311 — customers.last_purchase_at confiavel + indice de recencia
--
-- Contexto (QA de usabilidade, 29/08/2026): o seletor de cliente do PDV
-- abre em ordem alfabetica (Abbey, Abdel, Adamo...), a ordenacao menos
-- util possivel com o cliente na frente do balcao. Pra abrir por
-- "atendidos recentemente" a coluna last_purchase_at precisa ser
-- verdade — e nao era.
--
-- O QUE ESTAVA ERRADO (funcao update_customer_metrics, migrations 001 e
-- 137). Ela gravava `last_purchase_at = NOW()` fixo. Duas consequencias:
--
--   1. CANCELAR uma venda marcava o cliente como atendido AGORA. Desde a
--      137 a trigger dispara tambem em UPDATE OF status; o cancelamento
--      recalcula total_purchases/total_spent corretamente (ignora
--      canceladas) e, na mesma tacada, empurra last_purchase_at pra
--      NOW(). Um cliente cuja unica venda foi cancelada virava o mais
--      recente da lista.
--
--   2. Venda LANCADA COM DATA RETROATIVA (POST /pdv/sale com sale_date,
--      import de historico, DANFE) gravava last_purchase_at = hoje. A
--      coluna media "quando alguem mexeu nesta venda", nao "quando o
--      cliente comprou".
--
-- O FIX: derivar de MAX(created_at) / MIN(created_at) das vendas nao
-- canceladas, exatamente o mesmo predicado que a 137 ja usa pra
-- total_purchases/total_spent. O escopo (customer_id + company_id) fica
-- IDENTICO ao de hoje de proposito — mudar o escopo aqui mexeria em
-- total_spent, que alimenta LTV e ranking, e nao e o assunto deste PR.
--
-- Efeito colateral bom: cancelar a unica venda de um cliente agora
-- devolve last_purchase_at pra NULL (MAX de conjunto vazio), em vez de
-- deixar uma data mentirosa.
--
-- Idempotente (CREATE OR REPLACE + IF NOT EXISTS).
-- ============================================================

CREATE OR REPLACE FUNCTION public.update_customer_metrics()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_customer UUID;
  target_company  UUID;
BEGIN
  -- Em UPDATE, customer_id pode ter mudado; cobre OLD e NEW.
  target_customer := COALESCE(NEW.customer_id, OLD.customer_id);
  target_company  := COALESCE(NEW.company_id, OLD.company_id);

  IF target_customer IS NOT NULL THEN
    UPDATE customers SET
      total_purchases  = (SELECT COUNT(*) FROM sales
                            WHERE customer_id = target_customer
                              AND company_id = target_company
                              AND COALESCE(status, 'completed') != 'cancelled'),
      total_spent      = (SELECT COALESCE(SUM(total_amount), 0) FROM sales
                            WHERE customer_id = target_customer
                              AND company_id = target_company
                              AND COALESCE(status, 'completed') != 'cancelled'),
      -- 311: derivado das vendas, nao NOW(). Ver cabecalho da migration.
      last_purchase_at = (SELECT MAX(created_at) FROM sales
                            WHERE customer_id = target_customer
                              AND company_id = target_company
                              AND COALESCE(status, 'completed') != 'cancelled'),
      first_purchase_at = (SELECT MIN(created_at) FROM sales
                            WHERE customer_id = target_customer
                              AND company_id = target_company
                              AND COALESCE(status, 'completed') != 'cancelled'),
      updated_at       = NOW()
    WHERE id = target_customer;
  END IF;
  RETURN NEW;
END;
$function$;

-- Trigger recriada pra garantir que aponta pra funcao nova mesmo se um
-- ambiente antigo tiver perdido o DROP/CREATE da 137.
DROP TRIGGER IF EXISTS trg_sale_update_customer ON sales;
CREATE TRIGGER trg_sale_update_customer
  AFTER INSERT OR UPDATE OF status ON sales
  FOR EACH ROW
  EXECUTE FUNCTION update_customer_metrics();

-- ── Backfill: corrige as datas ja envenenadas ───────────────
-- Agrega uma vez sobre sales (GROUP BY) em vez de duas subqueries
-- correlacionadas por cliente -- em base grande a diferenca e de ordens
-- de grandeza.
--
-- So mexe em cliente QUE TEM venda. Cliente sem venda nenhuma fica como
-- esta de proposito: base importada de outro sistema pode ter
-- last_purchase_at preenchido sem sales correspondentes, e apagar isso
-- destruiria justamente o sinal de recencia que este PR quer usar. Da
-- migration pra frente a trigger cuida do resto.
DO $$
DECLARE
  v_rows BIGINT;
BEGIN
  WITH agg AS (
    SELECT s.customer_id,
           s.company_id,
           MAX(s.created_at) AS ultima,
           MIN(s.created_at) AS primeira
      FROM sales s
     WHERE s.customer_id IS NOT NULL
       AND COALESCE(s.status, 'completed') != 'cancelled'
     GROUP BY s.customer_id, s.company_id
  )
  UPDATE customers c
     SET last_purchase_at  = agg.ultima,
         first_purchase_at = agg.primeira
    FROM agg
   WHERE c.id = agg.customer_id
     AND c.company_id = agg.company_id
     AND (c.last_purchase_at  IS DISTINCT FROM agg.ultima
       OR c.first_purchase_at IS DISTINCT FROM agg.primeira);

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE '[migration 311] backfill: % clientes com datas corrigidas', v_rows;
END
$$;

-- ── Indice pro sort=recent ──────────────────────────────────
-- A listagem de clientes e owner-scoped (company_id = ANY(...)), entao o
-- indice comeca por company_id. NULLS LAST casa com o ORDER BY da rota:
-- quem nunca comprou vai pro fim, nao pro topo.
CREATE INDEX IF NOT EXISTS idx_customers_last_purchase
  ON customers (company_id, last_purchase_at DESC NULLS LAST);

COMMENT ON COLUMN customers.last_purchase_at IS
  'Data da ultima venda NAO cancelada do cliente na empresa dele. Derivada por trigger (migration 311) — antes era NOW() fixo, que mentia em cancelamento e em venda retroativa. Alimenta o sort=recent do seletor de cliente do PDV.';

COMMENT ON COLUMN customers.first_purchase_at IS
  'Data da primeira venda NAO cancelada do cliente na empresa dele. Derivada por trigger (migration 311).';
