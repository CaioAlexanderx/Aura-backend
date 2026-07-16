-- ============================================================
-- Migration 182 — Aura Karatê Track J
-- Certificados como fluxo de pedido (estados + entrega + histórico)
--
-- Cria:
--   karate_certificate_orders       — pedido de certificado por praticante
--   karate_certificate_order_history — log append-only de transições de estado
-- ============================================================

-- Status válidos para um pedido de certificado
DO $$ BEGIN
  CREATE TYPE karate_cert_status AS ENUM
    ('requested','in_production','printed','shipped','refused');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Tipo de entrega
DO $$ BEGIN
  CREATE TYPE karate_cert_delivery AS ENUM ('pickup','mail');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Tabela principal ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS karate_certificate_orders (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Contexto karatê
  federation_id     UUID        NOT NULL,  -- company.id da federação
  dojo_id           UUID        NOT NULL,  -- company.id do dojô
  practitioner_id   TEXT        NOT NULL,  -- customers.id (praticante)

  -- Snapshot da graduação no momento do pedido
  belt_level        TEXT        NOT NULL,  -- ex: 'preta', '1dan'
  belt_name         TEXT        NOT NULL,  -- ex: 'Shodan — 1º Dan'
  exam_date         DATE,                 -- data do exame (informativo)
  exam_ref          TEXT,                 -- ex: 'Exame de Dan · 17 mai 2026'

  -- Como será impresso
  nome_impresso     TEXT        NOT NULL,  -- nome que sai no certificado

  -- Entrega
  delivery_type     karate_cert_delivery NOT NULL DEFAULT 'pickup',
  addr_cep          TEXT,
  addr_logradouro   TEXT,
  addr_numero       TEXT,
  addr_complemento  TEXT,
  addr_cidade       TEXT,
  observacao        TEXT,

  -- Estado atual
  status            karate_cert_status NOT NULL DEFAULT 'requested',
  refusal_reason    TEXT,                 -- preenchido quando status='refused'

  -- Rastreabilidade
  created_by        TEXT,                 -- member id de quem criou
  created_by_name   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices de consulta frequente
CREATE INDEX IF NOT EXISTS idx_cert_orders_federation
  ON karate_certificate_orders(federation_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cert_orders_dojo
  ON karate_certificate_orders(dojo_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cert_orders_practitioner
  ON karate_certificate_orders(practitioner_id);

-- ── Log de transições (append-only) ──────────────────────────
CREATE TABLE IF NOT EXISTS karate_certificate_order_history (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     UUID        NOT NULL REFERENCES karate_certificate_orders(id) ON DELETE CASCADE,
  from_status  karate_cert_status,          -- NULL na criação
  to_status    karate_cert_status NOT NULL,
  who_id       TEXT,                         -- member id de quem fez a transição
  who_name     TEXT,
  org_name     TEXT,                         -- nome da organização (dojô ou federação)
  note         TEXT,                         -- motivo de recusa ou observação
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cert_history_order
  ON karate_certificate_order_history(order_id, created_at);

-- Trigger para atualizar updated_at automaticamente
CREATE OR REPLACE FUNCTION update_cert_order_ts()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cert_order_updated ON karate_certificate_orders;
CREATE TRIGGER cert_order_updated
  BEFORE UPDATE ON karate_certificate_orders
  FOR EACH ROW EXECUTE FUNCTION update_cert_order_ts();
