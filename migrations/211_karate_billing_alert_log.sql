-- Aviso interno "vence em 2 dias" enviado a contato@getaura.com.br para
-- acompanhar o pagamento da federação. Tabela de log garante idempotência
-- (um e-mail por federação+vencimento), no espírito de karate_reminder_log.
CREATE TABLE IF NOT EXISTS karate_billing_alert_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id uuid NOT NULL,
  due_date      date NOT NULL,
  kind          text NOT NULL DEFAULT 'due_2d',
  sent_at       timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_karate_billing_alert') THEN
    ALTER TABLE karate_billing_alert_log
      ADD CONSTRAINT uq_karate_billing_alert UNIQUE (federation_id, due_date, kind);
  END IF;
END $$;
