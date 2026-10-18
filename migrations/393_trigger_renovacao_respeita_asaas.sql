-- ============================================================
-- 393 — Trigger de renovação respeita o próximo vencimento informado
-- (cartão ti-03, 18/10/2026)
--
-- A função e o trigger nasceram fora do repositório, em 21/06/2026, pela
-- migration do Supabase 20260621153451 "billing_reminder_log_and_renewal_
-- trigger" (aplicada direto no banco). Esta migration traz os dois para o
-- repo: no CI eles passam a existir, e em produção o CREATE OR REPLACE troca
-- só o corpo da função.
--
-- Antes: sempre que last_payment_date mudava para um valor não nulo,
--   next_billing_date := OLD.next_billing_date + 1 mês
-- jogando fora a data que o UPDATE acabou de gravar. Dois efeitos:
--   1. O webhook da Asaas grava o próximo vencimento que a própria Asaas
--      devolve; o trigger descartava essa data.
--   2. Com OLD.next_billing_date nulo o resultado era nulo (Luis Henrique,
--      17/10, corrigido à mão para 16/11).
--
-- Agora, quando last_payment_date muda para um valor não nulo:
--   a) se o UPDATE informou uma data nova (não nula e diferente da anterior),
--      ela fica;
--   b) senão, next_billing_date := COALESCE(anterior, data do pagamento)
--      + 1 mês.
--   billing_status vira 'active', como antes.
--
-- Caso de borda: a data informada IGUAL à que já estava gravada é tratada
-- como "não informou" e soma 1 mês (o trigger não distingue as duas coisas).
-- Ver a descrição do PR.
--
-- Idempotente: CREATE OR REPLACE da função; o trigger só é criado se faltar.
-- Caminho de volta: o corpo anterior da função está no fim deste arquivo.
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_billing_renewal_from_due_date()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Dispara somente quando last_payment_date recebe um novo valor
  IF NEW.last_payment_date IS DISTINCT FROM OLD.last_payment_date
     AND NEW.last_payment_date IS NOT NULL
  THEN
    -- Quem atualizou informou o próximo vencimento (ex.: webhook com a data
    -- da Asaas, checkout com o nextDueDate da assinatura): mantém.
    IF NEW.next_billing_date IS NOT NULL
       AND NEW.next_billing_date IS DISTINCT FROM OLD.next_billing_date
    THEN
      NULL;
    ELSE
      -- Não informou: vencimento anterior + 1 mês; sem vencimento anterior,
      -- a data do pagamento + 1 mês.
      NEW.next_billing_date :=
        (COALESCE(OLD.next_billing_date, NEW.last_payment_date) + INTERVAL '1 month')::date;
    END IF;
    NEW.billing_status := 'active';
  END IF;
  RETURN NEW;
END;
$$;

-- O trigger já existe em produção (mesma definição de 21/06): só é criado
-- onde falta (CI, banco novo). Sem DROP, a migration não pede lock exclusivo
-- em companies em produção.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'tr_billing_renewal_from_due_date'
       AND tgrelid = 'public.companies'::regclass
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER tr_billing_renewal_from_due_date
    BEFORE UPDATE ON public.companies
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_billing_renewal_from_due_date();
  END IF;
END
$$;

-- ------------------------------------------------------------
-- Caminho de volta (NÃO executar junto): restaura a função como estava em
-- produção até esta migration (pg_get_functiondef em 18/10/2026).
--
-- CREATE OR REPLACE FUNCTION public.fn_billing_renewal_from_due_date()
--  RETURNS trigger
--  LANGUAGE plpgsql
-- AS $function$
-- BEGIN
--   -- Dispara somente quando last_payment_date recebe um novo valor
--   IF NEW.last_payment_date IS DISTINCT FROM OLD.last_payment_date
--      AND NEW.last_payment_date IS NOT NULL
--   THEN
--     -- Próximo vencimento = vencimento ORIGINAL + 1 mês (não = data do pagamento + 1 mês)
--     NEW.next_billing_date := OLD.next_billing_date + INTERVAL '1 month';
--     NEW.billing_status    := 'active';
--   END IF;
--   RETURN NEW;
-- END;
-- $function$;
-- ------------------------------------------------------------
