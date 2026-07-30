-- ============================================================
-- AURA DOJÔ — Migration 263: trilha da FICHA do praticante (F7.1)
-- karate_identity_audit
-- ------------------------------------------------------------
-- POR QUE ESTA TABELA EXISTE
-- A partir da F7.1 o DOJÔ passa a poder sobrescrever a ficha de um
-- praticante da FEDERAÇÃO (é o significado da adoção:
-- customers.karate_identity_managed_by = 'dojo', migration 262). Num modelo
-- em que um terceiro escreve no seu cadastro, NÃO TER HISTÓRICO é
-- inaceitável: a federação precisa poder responder "quem mudou o nome deste
-- praticante, quando, e qual era o valor antes".
--
-- ── O QUE JÁ EXISTIA NO REPO (auditado em 30/07/2026, produção) ──
-- Procurei tabela de auditoria aproveitável ANTES de criar esta:
--
--   karate_finance_audit_log  → estrutura quase perfeita (actor, before,
--       after, target), mas tem
--       CHECK (target_type IN ('annuity','installment')). Reaproveitar
--       exigiria AFOUXAR o CHECK de uma trilha FINANCEIRA para caber
--       identidade — misturar dinheiro com cadastro na mesma trilha é
--       exatamente o tipo de acoplamento que depois ninguém desfaz. NÃO.
--
--   karate_dojo_roster_events → sem CHECK em `event`, já escrita pelo
--       approve-create (linkDojoStudentOnApprove). Serve tecnicamente, mas
--       é a trilha do ELENCO do dojô: não tem practitioner_id (só um jsonb
--       `affected`), então "histórico da ficha DESTE praticante" viraria
--       varredura de jsonb. É boa como REDE, não como trilha canônica —
--       e é exatamente esse o papel que o código dá a ela: enquanto esta
--       migration 263 não for aplicada, karateStudentIdentityLink.js grava
--       o rastro em karate_dojo_roster_events (event='identity_adopted' /
--       'identity_released'). Nenhuma adoção acontece sem rastro.
--
--   audit_log / audit_logs  → genéricas, de plataforma (company_id/user_id),
--       sem federation_id/dojo_id/practitioner_id. Consultar a ficha de um
--       praticante por elas seria filtro por jsonb sem índice. NÃO.
--
-- ── DECISÕES ────────────────────────────────────────────────
-- 1) TODAS as FKs são ON DELETE SET NULL — NUNCA CASCADE. Uma trilha que
--    some quando o objeto some não é trilha. Por isso também guardamos os
--    rótulos desnormalizados (practitioner_label, fpkt_number,
--    student_label): o registro continua LEGÍVEL depois que a linha de
--    origem for apagada.
-- 2) `changes` é jsonb NOT NULL DEFAULT '[]' — lista de
--    { field, label, winner, dojo_before, dojo_after,
--      federation_before, federation_after }. Só entram os campos que
--    REALMENTE mudaram (aplicar um valor idêntico não é um evento).
-- 3) `action` com CHECK curto e fechado. 'sync' já entra agora porque é a
--    F7.2 (sincronização contínua dojô → federação) — abrir o CHECK depois
--    seria uma migration só para isso.
-- 4) Sem UNIQUE nenhuma: trilha é append-only, repetição é informação.
--
-- NÃO aplicada em produção neste PR (aplicar via MCP antes do deploy).
-- Aditiva e idempotente. Zero DROP, zero ALTER de tabela existente.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_identity_audit (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- QUEM É O DONO DO EVENTO
  federation_id      uuid,
  dojo_id            uuid,

  -- SOBRE QUEM (os dois lados da mesma pessoa)
  practitioner_id    uuid,
  practitioner_label text,          -- nome na federação NO MOMENTO do evento
  fpkt_number        text,          -- matrícula NO MOMENTO do evento
  student_id         uuid,
  student_label      text,          -- nome no dojô NO MOMENTO do evento

  -- O QUE ACONTECEU
  action             text NOT NULL,
  source             text NOT NULL DEFAULT 'dojo_federate',
  changes            jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- QUEM FEZ
  actor_user_id      uuid,
  actor_label        text,

  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ── CHECK de vocabulário ────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE karate_identity_audit
    ADD CONSTRAINT karate_identity_audit_action_check
    CHECK (action IN ('adopt', 'release', 'sync'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_identity_audit
    ADD CONSTRAINT karate_identity_audit_source_check
    CHECK (source IN ('dojo_federate', 'dojo_unfederate', 'federation_admin', 'sync_job', 'import'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── FKs: SEMPRE ON DELETE SET NULL (a trilha sobrevive ao objeto) ──
DO $$ BEGIN
  ALTER TABLE karate_identity_audit
    ADD CONSTRAINT karate_identity_audit_practitioner_fkey
    FOREIGN KEY (practitioner_id) REFERENCES customers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR undefined_table THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_identity_audit
    ADD CONSTRAINT karate_identity_audit_student_fkey
    FOREIGN KEY (student_id) REFERENCES karate_dojo_students(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR undefined_table THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_identity_audit
    ADD CONSTRAINT karate_identity_audit_dojo_fkey
    FOREIGN KEY (dojo_id) REFERENCES companies(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR undefined_table THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_identity_audit
    ADD CONSTRAINT karate_identity_audit_federation_fkey
    FOREIGN KEY (federation_id) REFERENCES companies(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR undefined_table THEN NULL; END $$;

-- actor_user_id segue o padrão de karate_finance_audit_log (users.id).
DO $$ BEGIN
  ALTER TABLE karate_identity_audit
    ADD CONSTRAINT karate_identity_audit_actor_fkey
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object OR undefined_table THEN NULL; END $$;

-- ── Índices: as duas perguntas reais ────────────────────────
-- "o que aconteceu com a ficha DESTE praticante?" (tela da federação)
CREATE INDEX IF NOT EXISTS idx_karate_identity_audit_practitioner
  ON karate_identity_audit (practitioner_id, created_at DESC)
  WHERE practitioner_id IS NOT NULL;

-- "o que ESTE dojô andou sobrescrevendo?" (fiscalização da federação)
CREATE INDEX IF NOT EXISTS idx_karate_identity_audit_dojo
  ON karate_identity_audit (dojo_id, created_at DESC)
  WHERE dojo_id IS NOT NULL;

-- ── COMMENTs (o modelo mora no banco também) ────────────────
COMMENT ON TABLE karate_identity_audit IS
  'F7.1: trilha append-only da FICHA do praticante. Existe porque o dojô passou a poder sobrescrever o cadastro da federação (customers.karate_identity_managed_by = ''dojo'', migration 262). Toda adoção/devolução/sincronização deixa uma linha aqui. Enquanto esta tabela não existir, karateStudentIdentityLink.js grava o rastro em karate_dojo_roster_events — NENHUMA adoção acontece sem rastro.';

COMMENT ON COLUMN karate_identity_audit.action IS
  'adopt = o dojô assumiu a ficha (managed_by federation→dojo). release = devolveu à federação (desvincular). sync = sobrescrita contínua da F7.2.';

COMMENT ON COLUMN karate_identity_audit.changes IS
  'Lista jsonb de { field, label, winner, dojo_before, dojo_after, federation_before, federation_after }. Só os campos que REALMENTE mudaram. winner = ''dojo'' | ''federation'' (quem venceu a resolução daquele campo).';

COMMENT ON COLUMN karate_identity_audit.practitioner_label IS
  'Nome do praticante NO MOMENTO do evento. Desnormalizado de propósito: as FKs são ON DELETE SET NULL e a trilha precisa continuar legível depois que o praticante for apagado.';
