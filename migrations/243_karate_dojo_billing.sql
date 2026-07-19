-- ============================================================
-- AURA DOJÔ — Migration 243: motor de mensalidades (F3a, CHARGE-BASED)
-- karate_dojo_billing_plans + karate_dojo_subscriptions + karate_dojo_charges
-- ------------------------------------------------------------
-- NUMERAÇÃO: 240 (owner-invites), 241 (card_queue_out_of_queue + tombstone
-- 241_karate_dojo_students) e 242 (karate_dojo_students, F2) já tomados —
-- esta é a 243. Convenção CLAUDE.md: numeração sequencial, incrementar.
--
-- DECISÃO CENTRAL (F3a Aura Dojô, 19/07/2026): a mensalidade do dojô é
-- CHARGE-BASED — o dojô gera a cobrança do mês (competência 'YYYY-MM') e o
-- aluno paga UM PIX por cobrança. Pix Automático (débito recorrente) só
-- entra em outubro; até lá NÃO há assinatura de cartão no provider. O
-- RECEBEDOR do PIX é a chave do PRÓPRIO dojô (digital_channel_config do
-- company do dojô, campos da migration 088) — BaaS Asaas (subconta + split)
-- é OPCIONAL/FUTURO atrás do karatePaymentProvider.
--
-- A "assinatura" (karate_dojo_subscriptions) é só o CONTRATO local do aluno
-- (valor + dia de vencimento + responsável pagador) do qual as cobranças
-- mensais são geradas — não é uma assinatura de cartão. Uma assinatura
-- ATIVA por aluno (UNIQUE parcial WHERE canceled_at IS NULL). Cancelar seta
-- canceled_at (não apaga — preserva o histórico das cobranças já geradas).
--
-- Cobrança (karate_dojo_charges): idempotência por UNIQUE (subscription_id,
-- competence) — regerar o mês não duplica. amount e guardian_id são
-- SNAPSHOT no momento da geração (mudar o plano depois não reescreve
-- cobrança já emitida). status guarda só pending/paid/cancelled; 'overdue'
-- é DERIVADO na leitura (due_date < hoje && pending) — nunca gravado.
--
-- Escopo por dojo_id (company vertical karate_dojo). NÃO aplicada em
-- produção neste PR (aplicar via MCP antes do deploy). Idempotente /
-- defensiva (IF NOT EXISTS + constraints em DO $$), padrão das 240/242.
-- ============================================================

-- ── Planos de mensalidade do dojô ──
CREATE TABLE IF NOT EXISTS karate_dojo_billing_plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id     uuid NOT NULL,
  name        text NOT NULL,
  amount      numeric(10,2) NOT NULL,
  due_day     integer NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE karate_dojo_billing_plans
    ADD CONSTRAINT karate_dojo_billing_plans_dojo_id_fkey
    FOREIGN KEY (dojo_id) REFERENCES companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_billing_plans
    ADD CONSTRAINT karate_dojo_billing_plans_amount_check CHECK (amount > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_billing_plans
    ADD CONSTRAINT karate_dojo_billing_plans_due_day_check CHECK (due_day BETWEEN 1 AND 28);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_karate_dojo_billing_plans_dojo
  ON karate_dojo_billing_plans (dojo_id);

-- ── Assinaturas (contrato local do aluno — NÃO é assinatura de cartão) ──
CREATE TABLE IF NOT EXISTS karate_dojo_subscriptions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id           uuid NOT NULL,
  student_id        uuid NOT NULL,
  plan_id           uuid,
  amount            numeric(10,2) NOT NULL,
  due_day           integer NOT NULL,
  payer_guardian_id uuid,
  active_from       date NOT NULL DEFAULT CURRENT_DATE,
  canceled_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE karate_dojo_subscriptions
    ADD CONSTRAINT karate_dojo_subscriptions_dojo_id_fkey
    FOREIGN KEY (dojo_id) REFERENCES companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_subscriptions
    ADD CONSTRAINT karate_dojo_subscriptions_student_id_fkey
    FOREIGN KEY (student_id) REFERENCES karate_dojo_students(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_subscriptions
    ADD CONSTRAINT karate_dojo_subscriptions_plan_id_fkey
    FOREIGN KEY (plan_id) REFERENCES karate_dojo_billing_plans(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_subscriptions
    ADD CONSTRAINT karate_dojo_subscriptions_payer_guardian_id_fkey
    FOREIGN KEY (payer_guardian_id) REFERENCES karate_dojo_guardians(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_subscriptions
    ADD CONSTRAINT karate_dojo_subscriptions_amount_check CHECK (amount > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_subscriptions
    ADD CONSTRAINT karate_dojo_subscriptions_due_day_check CHECK (due_day BETWEEN 1 AND 28);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_karate_dojo_subscriptions_dojo
  ON karate_dojo_subscriptions (dojo_id);
CREATE INDEX IF NOT EXISTS idx_karate_dojo_subscriptions_student
  ON karate_dojo_subscriptions (student_id);

-- Uma assinatura ATIVA por aluno (parcial WHERE canceled_at IS NULL —
-- histórico de assinaturas canceladas é permitido).
CREATE UNIQUE INDEX IF NOT EXISTS uq_karate_dojo_subscriptions_active_student
  ON karate_dojo_subscriptions (student_id) WHERE canceled_at IS NULL;

-- ── Cobranças mensais (charge-based) ──
CREATE TABLE IF NOT EXISTS karate_dojo_charges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id          uuid NOT NULL,
  subscription_id  uuid NOT NULL,
  student_id       uuid NOT NULL,
  guardian_id      uuid,
  competence       text NOT NULL,
  amount           numeric(10,2) NOT NULL,
  due_date         date NOT NULL,
  status           text NOT NULL DEFAULT 'pending',
  paid_at          timestamptz,
  payment_method   text,
  pix_txid         text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE karate_dojo_charges
    ADD CONSTRAINT karate_dojo_charges_dojo_id_fkey
    FOREIGN KEY (dojo_id) REFERENCES companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_charges
    ADD CONSTRAINT karate_dojo_charges_subscription_id_fkey
    FOREIGN KEY (subscription_id) REFERENCES karate_dojo_subscriptions(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_charges
    ADD CONSTRAINT karate_dojo_charges_student_id_fkey
    FOREIGN KEY (student_id) REFERENCES karate_dojo_students(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_charges
    ADD CONSTRAINT karate_dojo_charges_guardian_id_fkey
    FOREIGN KEY (guardian_id) REFERENCES karate_dojo_guardians(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_charges
    ADD CONSTRAINT karate_dojo_charges_amount_check CHECK (amount > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_charges
    ADD CONSTRAINT karate_dojo_charges_status_check
    CHECK (status IN ('pending', 'paid', 'cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_charges
    ADD CONSTRAINT karate_dojo_charges_competence_check
    CHECK (competence ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Idempotência da geração: uma cobrança por (assinatura, competência).
DO $$ BEGIN
  ALTER TABLE karate_dojo_charges
    ADD CONSTRAINT uq_karate_dojo_charges_subscription_competence
    UNIQUE (subscription_id, competence);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_karate_dojo_charges_dojo
  ON karate_dojo_charges (dojo_id);
CREATE INDEX IF NOT EXISTS idx_karate_dojo_charges_dojo_competence
  ON karate_dojo_charges (dojo_id, competence);
CREATE INDEX IF NOT EXISTS idx_karate_dojo_charges_dojo_status
  ON karate_dojo_charges (dojo_id, status);

-- ── COMMENTs (modelo) ──
COMMENT ON TABLE karate_dojo_billing_plans IS
  'F3a Aura Dojô: planos de mensalidade do dojô (nome + valor + dia de vencimento). Escopo por dojo_id (company karate_dojo).';
COMMENT ON TABLE karate_dojo_subscriptions IS
  'F3a Aura Dojô: contrato LOCAL de mensalidade do aluno (valor + due_day + responsável pagador) do qual as cobranças mensais são geradas. NÃO é assinatura de cartão — Pix Automático só em outubro. Uma assinatura ATIVA por aluno (UNIQUE parcial WHERE canceled_at IS NULL).';
COMMENT ON TABLE karate_dojo_charges IS
  'F3a Aura Dojô: cobrança mensal charge-based. Idempotente por (subscription_id, competence). amount/guardian_id são SNAPSHOT da geração. status guarda pending/paid/cancelled; overdue é DERIVADO na leitura (due_date < hoje && pending), nunca gravado. pix_txid = txid do BR Code gerado (recebedor = chave PIX do próprio dojô).';
COMMENT ON COLUMN karate_dojo_charges.competence IS
  'Competência da cobrança no formato YYYY-MM.';
COMMENT ON COLUMN karate_dojo_charges.pix_txid IS
  'txid do BR Code PIX gerado para esta cobrança (best-effort — pra conciliação futura). Recebedor = chave PIX do próprio dojô (digital_channel_config, migration 088).';
