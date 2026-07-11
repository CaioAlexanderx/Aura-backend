-- ============================================================
-- AURA KARATÊ — Cascata de status dojô→praticantes + validação de quadro
--
-- Registro de arquivo para uma migration JÁ APLICADA em produção (via
-- Supabase MCP). Idempotente — seguro rodar novamente em qualquer ambiente
-- (dev/CI) onde ainda não exista.
--
-- karate_dojo_roster_events        — auditoria (inactivate_cascade,
--   reactivate_restore, validation_requested, validated). `affected` é um
--   array jsonb de { student_id, was_active }.
-- karate_dojo_roster_validation    — estado de validação de quadro por
--   dojô (status null|pending|validated), com token opaco para o portal
--   público do sensei (sem login).
--
-- karate_member_standing (view, migration original não versionada neste
-- repo) foi atualizada para não gerar cobrança de anuidade quando o
-- praticante está inativo (COALESCE(c.is_active, true) entra no CASE de
-- financeiro/valor_em_aberto). Replicada aqui via CREATE OR REPLACE.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_dojo_roster_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id       uuid,
  federation_id uuid,
  event         text,
  affected      jsonb DEFAULT '[]',
  actor_id      uuid,
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kdre_dojo
  ON karate_dojo_roster_events (dojo_id, created_at DESC);

CREATE TABLE IF NOT EXISTS karate_dojo_roster_validation (
  dojo_id          uuid PRIMARY KEY,
  federation_id     uuid,
  status            text,
  requested_at      timestamptz,
  validated_at      timestamptz,
  validated_by      text,
  token             text,
  token_expires_at  timestamptz,
  updated_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kdrv_token
  ON karate_dojo_roster_validation (token);

-- karate_member_standing: inativo (customers.is_active = false) não gera
-- cobrança de anuidade — financeiro/valor_em_aberto caem para
-- 'nao_aplicavel'/0 quando o praticante está inativo, mesmo sendo faixa-preta.
CREATE OR REPLACE VIEW karate_member_standing AS
SELECT
  c.id AS student_id,
  c.federation_id,
  c.dojo_id,
  c.name AS full_name,
  c.karate_registration_number,
  c.phone AS whatsapp,
  COALESCE(c.is_active, true) AS is_active,
  cb.belt_level,
  cb.belt_name,
  cb.belt_level = 'preta'::text AS is_black_belt,
  EXTRACT(year FROM now())::integer AS reference_year,
  fin.tx_id AS annuity_tx_id,
  fin.amount AS annuity_amount,
  fin.due_date AS annuity_due_date,
  fin.paid AS annuity_paid,
  CASE
    WHEN cb.belt_level <> 'preta'::text THEN 'nao_aplicavel'::text
    WHEN NOT COALESCE(c.is_active, true) THEN 'nao_aplicavel'::text
    WHEN fin.tx_id IS NULL THEN 'sem_cobranca'::text
    WHEN fin.paid THEN 'em_dia'::text
    ELSE 'atrasado'::text
  END AS financeiro,
  CASE
    WHEN cb.belt_level = 'preta'::text AND COALESCE(c.is_active, true)
         AND fin.tx_id IS NOT NULL AND NOT fin.paid THEN COALESCE(fin.amount, 0::numeric)
    ELSE 0::numeric
  END AS valor_em_aberto
FROM customers c
JOIN karate_current_belt cb ON cb.student_id = c.id
LEFT JOIN LATERAL (
  SELECT t.id AS tx_id, t.amount, t.due_date,
         t.status = 'confirmed'::transaction_status OR t.paid_at IS NOT NULL AS paid
  FROM transactions t
  WHERE t.category = 'annuity_cpf'::text
    AND t.reference_type = 'customer'::text
    AND t.reference_id = c.id
    AND EXTRACT(year FROM t.due_date) = EXTRACT(year FROM now())
  ORDER BY (t.status = 'confirmed'::transaction_status OR t.paid_at IS NOT NULL) DESC,
           t.created_at DESC
  LIMIT 1
) fin ON true;
