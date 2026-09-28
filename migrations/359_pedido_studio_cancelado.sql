-- ============================================================
-- 359 — Pedido da vitrine Studio cancelado sai da produção
-- 28/09/2026 — QA final da vitrine Studio (LJ-33 e LJ-33/CL-46, P1)
--
-- # Sintoma
--
-- Depois de "Recusar pagamento", a API pública do pedido dizia
-- "cancelado", mas o painel Studio seguia com o pedido em "Aguardando
-- arte": selo do detalhe, hub, Produção (coluna Cancelados em 0), com
-- "Solicitar aprovação" e "Marcar como aprovado" ativos, e o pedido
-- contando em "Aguardando arte" e na "Receita 7d".
--
-- # Causa raiz
--
-- O pedido da vitrine tem DOIS status em digital_orders:
--   status                    o do pedido/pagamento (pending_payment,
--                             confirmed, cancelled...) — é o que a
--                             vitrine e o Canal Digital leem;
--   studio_production_status  a etapa da produção (pending_art,
--                             approved...) — é o que TODO o painel
--                             Studio lê (view studio_orders, hub, KDS).
-- Os três caminhos de cancelamento (reject-payment, PATCH /status
-- 'cancelled' e o job do Pix vencido) só mudam `status`. A etapa da
-- produção ficava onde parou. E o CHECK da migration 130 nem aceitava
-- 'cancelled' (nem 'awaiting_customization') em studio_production_status.
--
-- # Fix (na fonte, para qualquer caminho de cancelamento)
--
-- 1. CHECK de studio_production_status com as sete etapas que o código
--    usa, incluindo 'cancelled'. NOT VALID: vale para toda escrita nova
--    sem varrer (nem travar por) linhas antigas.
-- 2. cancel_kind / cancel_reason: o tipo do cancelamento e o motivo que
--    a loja escreveu. A vitrine mostra à cliente o motivo certo ("A loja
--    não confirmou o seu Pix" em vez de "o Pix não foi pago em 72 h").
--      pix_expirado         job do Pix vencido (payment_status 'expired')
--      pagamento_recusado   "Recusar pagamento" (grava o motivo)
--      cancelado_pela_loja  "Cancelar pedido" (PATCH /status)
-- 3. Trigger BEFORE UPDATE: pedido Studio com status 'cancelled' tem a
--    produção 'cancelled' — ao cancelar e em qualquer UPDATE posterior da
--    etapa (a aprovação da arte pelo link, um arraste no quadro), então
--    um pedido cancelado não volta para a fila. Sem cancel_kind gravado
--    pelo chamador, o trigger deduz: 'expired' → pix_expirado; senão
--    cancelado_pela_loja.
--
-- Sem backfill aqui: pedido já cancelado (legado) é lido como cancelado
-- pelo backend (o painel usa o `status` quando ele é 'cancelled'). O SQL
-- opcional de higiene está na descrição do PR.
--
-- Idempotente.
-- ============================================================

ALTER TABLE digital_orders ADD COLUMN IF NOT EXISTS cancel_kind   TEXT NULL;
ALTER TABLE digital_orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT NULL;

COMMENT ON COLUMN digital_orders.cancel_kind IS
  'Tipo do cancelamento: pix_expirado | pagamento_recusado | cancelado_pela_loja. NULL = não cancelado (ou cancelado antes da migration 359).';
COMMENT ON COLUMN digital_orders.cancel_reason IS
  'Motivo do cancelamento escrito pela loja (até 200 caracteres). A vitrine mostra à cliente.';

-- 1. CHECK da etapa da produção --------------------------------------
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.digital_orders'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%studio_production_status%'
  LOOP
    EXECUTE format('ALTER TABLE public.digital_orders DROP CONSTRAINT %I', c.conname);
  END LOOP;

  ALTER TABLE public.digital_orders
    ADD CONSTRAINT digital_orders_studio_production_status_check
    CHECK (studio_production_status IS NULL OR studio_production_status IN
      ('awaiting_customization', 'pending_art', 'approved', 'in_production',
       'ready', 'delivered', 'cancelled'))
    NOT VALID;
END $$;

-- 2 e 3. Cancelado é cancelado também na produção ---------------------
CREATE OR REPLACE FUNCTION public.fn_digital_orders_cancelamento()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status = 'cancelled' THEN
    IF OLD.status IS DISTINCT FROM 'cancelled' AND NEW.cancel_kind IS NULL THEN
      NEW.cancel_kind := CASE
        WHEN NEW.payment_status = 'expired' THEN 'pix_expirado'
        ELSE 'cancelado_pela_loja'
      END;
    END IF;
    IF NEW.vertical = 'studio' THEN
      NEW.studio_production_status := 'cancelled';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_digital_orders_cancelamento ON public.digital_orders;
CREATE TRIGGER trg_digital_orders_cancelamento
  BEFORE UPDATE OF status, studio_production_status ON public.digital_orders
  FOR EACH ROW EXECUTE FUNCTION public.fn_digital_orders_cancelamento();
