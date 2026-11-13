-- ============================================================
-- AURA. — Migration 449: Recebe na Aura — avisos da Asaas das SUBCONTAS (RA-07)
-- recebe_webhook_events
-- ------------------------------------------------------------
-- 13/11/2026. Um registro por EVENTO da Asaas que chega na rota própria do
-- Recebe na Aura (/webhooks/asaas-recebe), separada do webhook das
-- assinaturas da Aura (webhook_logs continua só delas).
--
-- Idempotência pelo id do evento (evt_...): a Asaas entrega "at least once"
-- e o id do evento se repete no reenvio (docs.asaas.com, "Como implementar
-- idempotência em Webhooks"). A constraint única em asaas_event_id é a trava:
-- o handler faz INSERT ... ON CONFLICT (asaas_event_id) DO NOTHING e só quem
-- inseriu processa. Reenvio e corrida entre duas entregas iguais caem no
-- conflito e não processam de novo.
--
-- company_id fica NULL quando a subconta não é conhecida (o evento é
-- registrado e não processado) e também quando a flag estava desligada antes
-- de identificar a empresa. ON DELETE SET NULL: o registro do aviso sobrevive
-- à empresa.
--
-- outcome:
--   processing         reservado, sendo processado agora
--   processed          efeito aplicado (situação da conta gravada)
--   registered         só registrado (pagamentos: o efeito vem no RA-09/RA-10)
--   ignored            evento que o Recebe não trata (registrado)
--   stale              retrato mais velho que o gravado (não sobrescreveu)
--   unknown_account    subconta desconhecida (sem empresa, não processado)
--   flag_off           RECEBE_NA_AURA_ENABLED desligada (não processado)
--   error              falhou ao processar; o reenvio da Asaas pode retomar
--
-- Só aditiva: tabela nova, nada nas tabelas existentes. Sem backfill.
-- Idempotente: IF NOT EXISTS + constraints em DO $$.
-- ============================================================

CREATE TABLE IF NOT EXISTS recebe_webhook_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asaas_event_id     text NOT NULL,
  event              text NOT NULL,
  company_id         uuid,
  asaas_account_id   text,
  asaas_payment_id   text,
  external_reference text,
  event_created_at   timestamptz,
  payload            jsonb NOT NULL,
  outcome            text NOT NULL DEFAULT 'processing',
  detail             text,
  attempts           integer NOT NULL DEFAULT 1,
  received_at        timestamptz NOT NULL DEFAULT now(),
  claimed_at         timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz
);

-- A trava da idempotência: o mesmo evento nunca entra (nem é processado) duas vezes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_recebe_webhook_events_event_id
  ON recebe_webhook_events (asaas_event_id);

-- Leitura por empresa (tela da equipe, conciliação) e pelos pagamentos (RA-09/RA-10).
CREATE INDEX IF NOT EXISTS idx_recebe_webhook_events_company
  ON recebe_webhook_events (company_id, received_at DESC)
  WHERE company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_recebe_webhook_events_payment
  ON recebe_webhook_events (asaas_payment_id)
  WHERE asaas_payment_id IS NOT NULL;

-- Avisos sem empresa (subconta desconhecida) para a equipe conferir.
CREATE INDEX IF NOT EXISTS idx_recebe_webhook_events_sem_empresa
  ON recebe_webhook_events (received_at DESC)
  WHERE company_id IS NULL;

DO $$ BEGIN
  ALTER TABLE recebe_webhook_events
    ADD CONSTRAINT recebe_webhook_events_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE recebe_webhook_events
    ADD CONSTRAINT recebe_webhook_events_outcome_check
    CHECK (outcome IN ('processing', 'processed', 'registered', 'ignored', 'stale',
                       'unknown_account', 'flag_off', 'error'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON TABLE recebe_webhook_events IS
  'Recebe na Aura (RA-07): avisos da Asaas das subcontas das lojas, um por id de evento (UNIQUE = idempotência). Separado de webhook_logs (assinaturas da Aura).';
COMMENT ON COLUMN recebe_webhook_events.asaas_event_id IS
  'id do evento da Asaas (evt_...). Repete no reenvio; a constraint única impede processar duas vezes.';
COMMENT ON COLUMN recebe_webhook_events.company_id IS
  'Empresa dona da subconta (company_baas_accounts.asaas_account_id = account.id do aviso). NULL = subconta desconhecida ou flag desligada.';
COMMENT ON COLUMN recebe_webhook_events.payload IS
  'Corpo do aviso como chegou (sem o header de autenticação).';
COMMENT ON COLUMN recebe_webhook_events.outcome IS
  'processing | processed | registered | ignored | stale | unknown_account | flag_off | error. Só error (ou processing parado há mais de 5 min) é retomado no reenvio.';
COMMENT ON COLUMN recebe_webhook_events.claimed_at IS
  'Quando a entrega atual reservou o evento para processar (primeira vez ou retomada de error/processing parado).';
COMMENT ON COLUMN recebe_webhook_events.external_reference IS
  'payment.externalReference: aponta para a origem (pedido/venda) da cobrança criada pelo RA-08; o RA-09/RA-10 ligam.';
