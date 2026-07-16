-- ============================================================
-- AURA KARATÊ — Migration 179: aplicação idempotente de sync (Track K)
--
-- Lado CONSUMIDOR da fila da Track F (karate_sync_events). Duas tabelas:
--
--  1) karate_sync_applied — trilha de DEDUPLICAÇÃO. Garante que cada FATO de
--     negócio (não cada linha de evento — o webhook cria uma nova linha a
--     cada re-entrega) seja aplicado NO MÁXIMO uma vez. A chave dedupe_key é
--     sha1(federation_id|dojo_id|event_type|identidade-do-fato), calculada em
--     src/services/karateApplyEvent.js (buildDedupeKey). UNIQUE(dedupe_key)
--     é o arbiter do ON CONFLICT DO NOTHING que reivindica o evento ANTES de
--     mutar, dentro da mesma transação.
--
--  2) karate_attendance — frequência de treino do praticante, alimentada
--     pelo evento 'attendance' do dojô. UNIQUE(federation_id, practitioner_id,
--     session_date) idempotentiza a presença do dia.
--
-- NUMERAÇÃO: 178 já está reservada pela PR aberta do crediário
-- (178_fix_cct_idempotency_full_unique_index.sql); 180/181 reservadas para
-- outras tracks paralelas. Track K usa 179 (livre em main).
--
-- IDEMPOTENTE (CREATE ... IF NOT EXISTS). NÃO aplicada ainda — só versionada.
-- O backend não roda migrations no boot; o código consumidor é defensivo a
-- 42P01/42703, então o PR é seguro de mergear antes desta migration rodar.
-- ============================================================

-- ── 1) Trilha de deduplicação ───────────────────────────────
CREATE TABLE IF NOT EXISTS karate_sync_applied (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key    TEXT NOT NULL,
  federation_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  dojo_id       UUID REFERENCES companies(id) ON DELETE SET NULL,
  connection_id UUID REFERENCES karate_dojo_connections(id) ON DELETE SET NULL,
  event_id      UUID REFERENCES karate_sync_events(id) ON DELETE SET NULL,
  event_type    TEXT,
  kind          TEXT,          -- practitioner | attendance | annuity | parked
  target_table  TEXT,          -- tabela mutada (auditoria)
  target_id     UUID,          -- id do registro afetado (auditoria)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Arbiter do ON CONFLICT (dedupe). Índice único CHEIO (igual transactions).
CREATE UNIQUE INDEX IF NOT EXISTS idx_karate_sync_applied_dedupe
  ON karate_sync_applied(dedupe_key);

CREATE INDEX IF NOT EXISTS idx_karate_sync_applied_fed
  ON karate_sync_applied(federation_id, created_at DESC);

ALTER TABLE karate_sync_applied ENABLE ROW LEVEL SECURITY;

-- ── 2) Frequência de treino ─────────────────────────────────
CREATE TABLE IF NOT EXISTS karate_attendance (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  dojo_id         UUID REFERENCES companies(id) ON DELETE SET NULL,
  practitioner_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  session_date    DATE NOT NULL,
  present         BOOLEAN NOT NULL DEFAULT TRUE,
  class_label     TEXT,
  source          TEXT NOT NULL DEFAULT 'sync',   -- 'sync' | 'manual'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Uma presença por praticante por dia (idempotentiza o evento 'attendance').
CREATE UNIQUE INDEX IF NOT EXISTS idx_karate_attendance_unique
  ON karate_attendance(federation_id, practitioner_id, session_date);

CREATE INDEX IF NOT EXISTS idx_karate_attendance_dojo
  ON karate_attendance(dojo_id, session_date DESC);

ALTER TABLE karate_attendance ENABLE ROW LEVEL SECURITY;

-- FIM DA MIGRATION 179
