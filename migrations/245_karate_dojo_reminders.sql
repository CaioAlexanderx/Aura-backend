-- ============================================================
-- AURA DOJÔ — Migration 245: régua de cobrança do dojô (F3c)
-- karate_dojo_reminder_config + karate_dojo_reminder_log
-- + karate_dojo_charges.pix_payload
-- ------------------------------------------------------------
-- NUMERAÇÃO: 240 (owner-invites), 241 (card_queue_out_of_queue +
-- tombstone 241_karate_dojo_students), 242 (students F2), 243 (billing
-- F3a) e 244 (baas F3b) já tomados — esta é a 245. Convenção CLAUDE.md:
-- numeração sequencial, incrementar.
--
-- DECISÃO CENTRAL (F3c Aura Dojô, 19/07/2026): a régua de cobrança
-- dojô→aluno é OPT-IN por dojô (karate_dojo_reminder_config.enabled,
-- default FALSE — nada dispara sozinho). Para cada offset configurado
-- (dias relativos ao vencimento: negativo = antes, 0 = no dia, positivo
-- = em atraso), a régua seleciona as cobranças pending cujo
-- (due_date + offset) = hoje e envia UM e-mail pt-BR ao responsável
-- pagador (guardian) ou, na ausência, ao próprio aluno.
--
-- IDEMPOTÊNCIA: UNIQUE(charge_id, offset_days, channel) no log — reenviar
-- o runner (no mesmo dia ou depois) nunca duplica um mesmo estágio.
--
-- ⚠️ COLUNA `offset_days` (não `offset`): OFFSET é palavra reservada no
-- Postgres e não pode ser nome de coluna sem aspas. A API expõe o campo
-- como `offset` (o service faz o alias na leitura) — o contrato do front
-- não muda; só o nome físico da coluna difere.
--
-- pix_payload: BR Code (copia-e-cola) já gerado para a cobrança, guardado
-- para REUSO. O e-mail da régua monta o link público de pagamento a partir
-- dele (token stateless, karatePixPublicToken) sem gerar um novo pagamento
-- a cada envio — crítico no caminho BaaS (subconta Asaas), onde recriar a
-- cobrança a cada clique geraria pagamentos duplicados.
--
-- Escopo por dojo_id (company vertical karate_dojo). NÃO aplicada em
-- produção neste PR (aplicar via MCP antes do deploy). Idempotente /
-- defensiva (IF NOT EXISTS + constraints em DO $$), padrão das 243/244.
-- ============================================================

-- ── Config da régua (opt-in por dojô) ──
CREATE TABLE IF NOT EXISTS karate_dojo_reminder_config (
  dojo_id     uuid PRIMARY KEY,
  enabled     boolean NOT NULL DEFAULT false,
  offsets     integer[] NOT NULL DEFAULT '{-3,0,3}',
  send_email  boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE karate_dojo_reminder_config
    ADD CONSTRAINT karate_dojo_reminder_config_dojo_id_fkey
    FOREIGN KEY (dojo_id) REFERENCES companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Log de envios (idempotência + histórico) ──
CREATE TABLE IF NOT EXISTS karate_dojo_reminder_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id      uuid NOT NULL,
  charge_id    uuid NOT NULL,
  offset_days  integer NOT NULL,
  channel      text NOT NULL DEFAULT 'email',
  status       text NOT NULL,
  recipient    text,
  sent_at      timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE karate_dojo_reminder_log
    ADD CONSTRAINT karate_dojo_reminder_log_dojo_id_fkey
    FOREIGN KEY (dojo_id) REFERENCES companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_reminder_log
    ADD CONSTRAINT karate_dojo_reminder_log_charge_id_fkey
    FOREIGN KEY (charge_id) REFERENCES karate_dojo_charges(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Idempotência: um envio por (cobrança, offset, canal).
DO $$ BEGIN
  ALTER TABLE karate_dojo_reminder_log
    ADD CONSTRAINT uq_karate_dojo_reminder_log_charge_offset_channel
    UNIQUE (charge_id, offset_days, channel);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_karate_dojo_reminder_log_dojo
  ON karate_dojo_reminder_log (dojo_id, sent_at DESC);

-- ── BR Code (copia-e-cola) guardado para reuso do link de pagamento ──
ALTER TABLE karate_dojo_charges ADD COLUMN IF NOT EXISTS pix_payload text;

-- ── COMMENTs (modelo) ──
COMMENT ON TABLE karate_dojo_reminder_config IS
  'F3c Aura Dojô: config da régua de cobrança dojô→aluno (opt-in por dojô). enabled default FALSE (nada dispara sozinho). offsets = dias relativos ao vencimento (negativo=antes, 0=no dia, positivo=atraso). send_email liga o canal e-mail.';
COMMENT ON COLUMN karate_dojo_reminder_config.offsets IS
  'Offsets em dias relativos ao due_date da cobrança. Para cada offset, envia quando (due_date + offset) = hoje. Validado no service: inteiros entre -15 e 30, 1..6 itens, únicos, ordenados.';
COMMENT ON TABLE karate_dojo_reminder_log IS
  'F3c Aura Dojô: log de envios da régua (idempotência + histórico). UNIQUE(charge_id, offset_days, channel) impede duplicar um mesmo estágio. status: sent | failed | skipped_no_email. offset_days = nome físico da coluna (OFFSET é reservado); a API expõe como offset.';
COMMENT ON COLUMN karate_dojo_charges.pix_payload IS
  'BR Code (copia-e-cola) já gerado para esta cobrança, guardado para REUSO. A régua monta o link público a partir dele sem recriar o pagamento a cada envio (crítico no caminho BaaS/subconta Asaas).';
