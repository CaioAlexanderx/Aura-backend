-- ============================================================
-- AURA KARATÊ — Migration 293: VOID + AUDITORIA de correção de
-- transferências de praticante (follow-up da Onda 1 do QA — PR #541).
--
-- CONTEXTO
--   A tabela karate_practitioner_transfers é append-only/imutável
--   (trigger BEFORE UPDATE/DELETE, migration 180). O PR #541 habilitou
--   editar/excluir UM registro pelo escape hatch de GUC da migration 221
--   (SET LOCAL app.allow_transfer_purge='on'). Isso consertou o 500, mas:
--     • tornou um trilho append-only mutável na marra;
--     • o DELETE apagava a linha SEM deixar rastro da correção;
--     • o DELETE não revertia customers.dojo_id (apagar o rastro não move
--       o praticante de volta), deixando o estado "sem explicação".
--
-- O QUE ESTA MIGRATION FAZ (puramente aditiva)
--   1) Colunas de VOID (soft-delete) em karate_practitioner_transfers:
--        voided_at / voided_by / void_reason.
--      O DELETE da rota vira VOID: marca voided_* em vez de apagar. Toda
--      LEITURA de transferências passa a filtrar voided_at IS NULL — a
--      linha continua no banco (append-only preservado), só some das
--      listagens/relatórios/contagens.
--   2) Tabela de auditoria karate_practitioner_transfer_audit: quem/quando/
--      o-que-mudou de CADA correção (PATCH grava before/after; VOID grava
--      a intenção). É o rastro que faltava.
--
-- O QUE ELA **NÃO** FAZ
--   Não mexe na trigger de imutabilidade (a 221 continua sendo o único
--   caminho de UPDATE/DELETE, via SET LOCAL). VOID e PATCH continuam
--   precisando do escape hatch para o UPDATE passar pela trigger.
--   Não reverte customers.dojo_id: a reversão de dojô se faz por nova
--   transferência ou editando a ficha. O VOID só some da leitura.
--
-- IDEMPOTENTE de ponta a ponta (ADD COLUMN IF NOT EXISTS / CREATE TABLE
-- IF NOT EXISTS / DO $$ ... duplicate_object).
-- ============================================================

-- ── 1) Colunas de VOID (soft-delete) ────────────────────────
ALTER TABLE karate_practitioner_transfers ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ;
ALTER TABLE karate_practitioner_transfers ADD COLUMN IF NOT EXISTS voided_by   UUID;
ALTER TABLE karate_practitioner_transfers ADD COLUMN IF NOT EXISTS void_reason TEXT;

COMMENT ON COLUMN karate_practitioner_transfers.voided_at IS
  'Quando o registro foi anulado (VOID/soft-delete). NULL = ativo. Toda leitura filtra voided_at IS NULL — a linha permanece (append-only), só some das listagens.';
COMMENT ON COLUMN karate_practitioner_transfers.voided_by IS
  'users.id de quem anulou. Sem FK de propósito: o carimbo sobrevive à remoção da conta.';
COMMENT ON COLUMN karate_practitioner_transfers.void_reason IS
  'Motivo da anulação (trilha, não texto de UI).';

-- Índice parcial: as leituras ativas são "WHERE ... AND voided_at IS NULL".
CREATE INDEX IF NOT EXISTS idx_practitioner_transfers_active
  ON karate_practitioner_transfers(practitioner_id, transferred_at DESC)
  WHERE voided_at IS NULL;

-- ── 2) Auditoria de correção (quem/quando/o-que-mudou) ───────
CREATE TABLE IF NOT EXISTS karate_practitioner_transfer_audit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id     uuid NOT NULL,          -- o registro corrigido (sem FK: sobrevive ao purge do praticante)
  federation_id   uuid NOT NULL,
  practitioner_id uuid,
  action          text NOT NULL,          -- 'patch' | 'void'
  actor_user_id   uuid,
  actor_label     text NOT NULL,
  before          jsonb,
  after           jsonb,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE karate_practitioner_transfer_audit
    ADD CONSTRAINT karate_practitioner_transfer_audit_action_check
    CHECK (action IN ('patch','void'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- FK só no ator (ON DELETE SET NULL — o log sobrevive à remoção do usuário).
-- transfer_id/practitioner_id ficam SEM FK: a auditoria não pode sumir por
-- um cascade que purga o praticante (exclusão definitiva em cascata).
DO $$ BEGIN
  ALTER TABLE karate_practitioner_transfer_audit
    ADD CONSTRAINT karate_practitioner_transfer_audit_actor_fkey
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_ktransfer_audit_transfer
  ON karate_practitioner_transfer_audit (transfer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ktransfer_audit_federation
  ON karate_practitioner_transfer_audit (federation_id, created_at DESC);

-- ============================================================
-- FIM DA MIGRATION 293
-- ============================================================
