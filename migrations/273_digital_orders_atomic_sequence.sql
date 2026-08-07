-- Fix race condition em next_digital_order_number(): a versão que estava
-- rodando em produção fazia SELECT MAX(order_number)+1 sem lock, então
-- dois checkouts concorrentes da mesma empresa podiam calcular o mesmo
-- próximo número e o segundo INSERT quebrava em
-- digital_orders_company_number_unique (23505).
--
-- Fix: tabela de contador por empresa + INSERT ... ON CONFLICT DO UPDATE
-- ... RETURNING, que usa lock de linha do Postgres pra serializar
-- corretamente chamadas concorrentes. Formato de saída (5 dígitos
-- zero-padded, sem prefixo) inalterado — é o que já está em produção hoje.

CREATE TABLE IF NOT EXISTS digital_order_sequences (
  company_id uuid PRIMARY KEY,
  last_seq integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Seed a partir dos dados existentes de digital_orders. Idempotente: só
-- insere empresas ainda não seedadas, e nunca reduz um contador existente
-- (GREATEST) — seguro rodar de novo sem regredir numeração já emitida.
INSERT INTO digital_order_sequences (company_id, last_seq)
SELECT company_id, MAX(order_number::int)
FROM digital_orders
WHERE order_number ~ '^\d+$'
GROUP BY company_id
ON CONFLICT (company_id) DO UPDATE
  SET last_seq = GREATEST(digital_order_sequences.last_seq, EXCLUDED.last_seq);

CREATE OR REPLACE FUNCTION public.next_digital_order_number(p_company_id uuid)
RETURNS text
LANGUAGE plpgsql
AS $function$
DECLARE
  v_seq INT;
BEGIN
  INSERT INTO digital_order_sequences (company_id, last_seq)
  VALUES (p_company_id, 1)
  ON CONFLICT (company_id) DO UPDATE
    SET last_seq = digital_order_sequences.last_seq + 1,
        updated_at = now()
  RETURNING last_seq INTO v_seq;

  RETURN LPAD(v_seq::TEXT, 5, '0');
END;
$function$;
