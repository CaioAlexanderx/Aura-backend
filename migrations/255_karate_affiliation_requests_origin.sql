-- ============================================================
-- 255 — Aura Dojô: origem do pedido de filiação (dojô × federação)
-- ------------------------------------------------------------
-- CONTEXTO: karate_affiliation_requests (migration 252) só cobria o pedido
-- SELF-SERVE (o dojô pede via POST /federation/:id/dojo/connection). Não
-- existia caminho para a FEDERAÇÃO iniciar o mesmo pedido do lado dela
-- (ex.: sensei ligou, a federação já sabe do dojô e quer puxar o cadastro
-- pra fila em vez de esperar o self-serve). Investigação confirmou que
-- karate_dojo_connections (migration 170) NÃO é esse caminho: é
-- configuração de MODO DE SINCRONIA (native/manual) de um dojô que já
-- está linkado (karate_dojo_linked_at IS NOT NULL) — está parqueada/
-- dormente para handshake externo (ver header de src/routes/
-- karateConnections.js) e permanece intacta, fora desta migration.
--
-- Esta migration só ACRESCENTA a origem ao MESMO inbox (karate_affiliation
-- _requests), sem duplicar tabela nem semântica de approve/reject/FPKT:
--
--   origin        'dojo' (default, self-serve — comportamento existente
--                 preservado) | 'federation' (a federação abriu o pedido
--                 pelo próprio dojô que ela já enxerga tecnicamente,
--                 companies.federation_id = federação, mas ainda sem
--                 karate_dojo_linked_at).
--   requested_by  usuário da FEDERAÇÃO que abriu o pedido quando
--                 origin='federation'. NULL para origin='dojo' (quem pediu
--                 ali é o próprio dojô, já identificado por dojo_id).
--
-- Aditiva e idempotente: ADD COLUMN IF NOT EXISTS + DO $$ ... EXCEPTION
-- WHEN duplicate_object para a constraint. Backfill seguro: toda linha
-- existente é self-serve (única via até aqui) → DEFAULT 'dojo' já cobre,
-- UPDATE explícito abaixo é só para deixar o dado histórico redundante-
-- mente explícito (idempotente: recolocar 'dojo' onde já é 'dojo' é
-- inofensivo).
-- ============================================================

ALTER TABLE karate_affiliation_requests ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'dojo';
ALTER TABLE karate_affiliation_requests ADD COLUMN IF NOT EXISTS requested_by UUID;

DO $$ BEGIN
  ALTER TABLE karate_affiliation_requests
    ADD CONSTRAINT karate_affiliation_requests_origin_check
    CHECK (origin IN ('dojo','federation'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_affiliation_requests
    ADD CONSTRAINT karate_affiliation_requests_requested_by_fkey
    FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill seguro: pedidos existentes são todos self-serve (a via
-- 'federation' só passa a existir a partir desta migration).
UPDATE karate_affiliation_requests SET origin = 'dojo' WHERE origin IS NULL;

CREATE INDEX IF NOT EXISTS idx_karate_affiliation_requests_fed_origin
  ON karate_affiliation_requests (federation_id, origin);

COMMENT ON COLUMN karate_affiliation_requests.origin IS
  'dojo (self-serve, POST /federation/:id/dojo/connection) | federation (a federação abriu pelo dojô via POST /federation/:id/affiliation-requests). Mesmo inbox, mesmo approve/reject/FPKT — só muda quem iniciou.';

COMMENT ON COLUMN karate_affiliation_requests.requested_by IS
  'Usuário da federação que abriu o pedido quando origin=federation. NULL quando origin=dojo (o próprio dojô é o solicitante, identificado por dojo_id).';

-- FIM DA MIGRATION 255
