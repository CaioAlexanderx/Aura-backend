-- ============================================================
-- AURA KARATÊ — Migration 227: rastro de ações financeiras (G3)
-- ------------------------------------------------------------
-- Contexto: num QA, um clique acidental marcou 3 anuidades reais como
-- pagas em produção. Só foi possível reconstruir o que aconteceu porque
-- alguém olhou karate_dojo_annuity_history.updated_at no minuto seguinte.
-- Sem autor registrado, uma baixa errada (sensei ou admin) vira mistério.
--
-- karate_finance_audit_log é o rastro de QUEM fez, QUANDO e O QUE havia
-- antes/depois em toda ação que mexe em dinheiro de anuidade: baixa manual
-- de parcela, confirmação de PIX (manual OU webhook), baixa em lote,
-- remoção de cobrança (void/void-batch), criação de cobrança (charge/
-- campanha/batch), alteração de parcela, troca de plano e envio de
-- e-mail de cobrança.
--
-- actor_user_id é NULLABLE de propósito: ações de sistema (webhook de
-- pagamento, campanha disparada por rotina) não têm um usuário Aura por
-- trás — actor_label carrega o rótulo legível nesses casos ('webhook',
-- 'sistema') e o nome/e-mail do usuário nos demais.
--
-- ⚠️ Esta migration é PURAMENTE ADITIVA — observabilidade, não regra de
-- negócio. Não altera is_active, não altera nenhum valor de anuidade
-- existente, não muda nenhum agregado de karate_dojo_standing/
-- karate_member_standing. Idempotente de ponta a ponta.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_finance_audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id   uuid NOT NULL,
  action          text NOT NULL,
  target_type     text NOT NULL,
  target_id       uuid,
  dojo_id         uuid,
  practitioner_id uuid,
  actor_user_id   uuid,
  actor_label     text NOT NULL,
  source          text NOT NULL,
  before          jsonb,
  after           jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE karate_finance_audit_log
    ADD CONSTRAINT karate_finance_audit_log_target_type_check
    CHECK (target_type IN ('annuity','installment'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_finance_audit_log
    ADD CONSTRAINT karate_finance_audit_log_source_check
    CHECK (source IN ('ui','batch','campaign','webhook','api'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- FKs defensivas (ON DELETE SET NULL — o log sobrevive mesmo se o usuário,
-- dojô ou praticante forem removidos depois; a trilha histórica não pode
-- desaparecer por causa de um cascade em outra tabela).
DO $$ BEGIN
  ALTER TABLE karate_finance_audit_log
    ADD CONSTRAINT karate_finance_audit_log_actor_user_id_fkey
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_finance_audit_log
    ADD CONSTRAINT karate_finance_audit_log_dojo_id_fkey
    FOREIGN KEY (dojo_id) REFERENCES companies(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_finance_audit_log
    ADD CONSTRAINT karate_finance_audit_log_practitioner_id_fkey
    FOREIGN KEY (practitioner_id) REFERENCES customers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Índices de leitura: timeline por federação (endpoint GET .../audit) e
-- histórico por alvo (parcela ou anuidade específica, expandido na UI).
CREATE INDEX IF NOT EXISTS idx_kfal_federation_created
  ON karate_finance_audit_log (federation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kfal_target
  ON karate_finance_audit_log (target_id);
