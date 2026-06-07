-- ============================================================
-- AURA KARATÊ — Migration 160: Cursos / seminários + inscrições
-- Carga horária conta para critério de promoção.
-- APLICADA em 07/06/2026 no Supabase hawtujkztrjpvvkihowb.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL CHECK (event_type IN ('oficial','chancelado','nacional')),
  name          TEXT NOT NULL,
  event_date    DATE,
  location      TEXT,
  hours         INT DEFAULT 0,
  fee_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('draft','open','closed','done')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_karate_events_federation ON karate_events(federation_id, event_date DESC);

CREATE TABLE IF NOT EXISTS karate_event_enrollments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES karate_events(id) ON DELETE CASCADE,
  student_id      UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  dojo_id         UUID REFERENCES companies(id) ON DELETE SET NULL,
  hours_completed INT DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled','attended','absent')),
  fee_paid        BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_karate_event_enrollments_event ON karate_event_enrollments(event_id);

DROP TRIGGER IF EXISTS trg_karate_events_updated_at ON karate_events;
CREATE TRIGGER trg_karate_events_updated_at BEFORE UPDATE ON karate_events FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE karate_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE karate_event_enrollments ENABLE ROW LEVEL SECURITY;

-- FIM DA MIGRATION 160
