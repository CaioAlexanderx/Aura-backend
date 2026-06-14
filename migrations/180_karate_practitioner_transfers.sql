-- ============================================================
-- AURA KARATÊ — Migration 180: Transferência de praticante (Track N)
-- Histórico de transferências de praticante entre dojôs da MESMA federação.
-- Tabela append-only e IMUTÁVEL — nunca permite UPDATE ou DELETE.
-- Espelha o padrão de 149_karate_belt_history (trigger de imutabilidade).
-- DDL idempotente (IF NOT EXISTS / CREATE OR REPLACE).
--
-- Nota: a reatribuição do dojô atual do praticante é feita em
-- customers.dojo_id pela rota (UPDATE transacional). O histórico de faixas
-- (karate_belt_history) e de presenças são chaveados por student_id/customer
-- e NÃO são tocados — preservados na íntegra.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_practitioner_transfers (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Praticante transferido (é um customer)
  practitioner_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- Federação dona do registro (transferência é sempre intra-federação)
  federation_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Dojô de origem (pode ser NULL se o praticante ainda não tinha dojô)
  origin_dojo_id      UUID REFERENCES companies(id) ON DELETE SET NULL,

  -- Dojô de destino (obrigatório). RESTRICT: coluna é NOT NULL, então SET NULL
  -- violaria a constraint ao excluir o dojô; o histórico é imutável e mantém o
  -- vínculo (o snapshot do nome cobre o caso de rename).
  destination_dojo_id UUID NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,

  -- Snapshot dos nomes no momento da transferência (resiliente a rename/exclusão)
  origin_dojo_name      TEXT,
  destination_dojo_name TEXT,

  -- Motivo opcional informado por quem iniciou
  reason          TEXT,

  -- Data efetiva da transferência (pode ser retroativa; default hoje)
  transferred_at  DATE NOT NULL DEFAULT CURRENT_DATE,

  -- Quem iniciou (auditoria)
  initiated_by    UUID REFERENCES users(id) ON DELETE SET NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()

  -- NÃO tem updated_at: tabela append-only e imutável.
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_practitioner_transfers_practitioner
  ON karate_practitioner_transfers(practitioner_id, transferred_at DESC);

CREATE INDEX IF NOT EXISTS idx_practitioner_transfers_federation
  ON karate_practitioner_transfers(federation_id, transferred_at DESC);

CREATE INDEX IF NOT EXISTS idx_practitioner_transfers_destination
  ON karate_practitioner_transfers(destination_dojo_id);

CREATE INDEX IF NOT EXISTS idx_practitioner_transfers_origin
  ON karate_practitioner_transfers(origin_dojo_id);

-- ============================================================
-- TRIGGER DE IMUTABILIDADE
-- Impede qualquer UPDATE ou DELETE nesta tabela.
-- O histórico de transferências é append-only por design e por contrato.
-- ============================================================

CREATE OR REPLACE FUNCTION karate_practitioner_transfers_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'karate_practitioner_transfers é append-only e imutável. '
    'Use INSERT para registrar novas transferências. '
    'Contate o administrador para correções excepcionais.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_practitioner_transfers_no_update ON karate_practitioner_transfers;
CREATE TRIGGER trg_practitioner_transfers_no_update
  BEFORE UPDATE ON karate_practitioner_transfers
  FOR EACH ROW EXECUTE FUNCTION karate_practitioner_transfers_immutable();

DROP TRIGGER IF EXISTS trg_practitioner_transfers_no_delete ON karate_practitioner_transfers;
CREATE TRIGGER trg_practitioner_transfers_no_delete
  BEFORE DELETE ON karate_practitioner_transfers
  FOR EACH ROW EXECUTE FUNCTION karate_practitioner_transfers_immutable();

-- ============================================================
-- FIM DA MIGRATION 180
-- ============================================================
