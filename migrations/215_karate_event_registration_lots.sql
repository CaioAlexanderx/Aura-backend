-- 215_karate_event_registration_lots.sql
-- Fase 2: lotes de inscrição do evento (lote × filiado/não-filiado).
-- Cada evento (karate_belt_exams) pode ter até N lotes, cada um com preço de
-- filiado e de não-filiado e uma data de virada (ends_at). O lote "atual" é o
-- primeiro lote ativo (por sort_order) ainda não vencido.
CREATE TABLE IF NOT EXISTS karate_event_registration_lots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES karate_belt_exams(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  price_member    NUMERIC(12,2) NOT NULL DEFAULT 0,   -- filiado
  price_nonmember NUMERIC(12,2) NOT NULL DEFAULT 0,   -- não-filiado
  ends_at         TIMESTAMPTZ,                         -- virada de lote (null = sem prazo)
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kerl_event ON karate_event_registration_lots(event_id);
ALTER TABLE karate_event_registration_lots ENABLE ROW LEVEL SECURITY;

-- Flag de convidado (não-filiado) — usado na inscrição pública da Fase 2B.
-- Aditivo agora para não exigir nova migration depois. Guests são excluídos
-- das listas/contagens de filiados.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_guest BOOLEAN NOT NULL DEFAULT false;
