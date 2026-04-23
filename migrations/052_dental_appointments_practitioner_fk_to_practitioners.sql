-- ============================================================
-- AURA. — Migration 052: corrige FK dental_appointments.practitioner_id
-- Era: FK -> employees(id)  (legado, pre-dental_practitioners)
-- Agora: FK -> dental_practitioners(id) ON DELETE SET NULL
--
-- Contexto: quando adicionaram practitioner_id em dental_appointments, a
-- tabela dental_practitioners ainda nao existia, entao a FK apontava pra
-- employees. Com o modulo odonto usando dental_practitioners como fonte
-- de verdade (settings.chair_practitioner_ids tambem aponta pra la), a FK
-- precisa ser realinhada.
--
-- Aplicada em producao via MCP Supabase em 23/04/2026.
-- ============================================================

ALTER TABLE dental_appointments
  DROP CONSTRAINT IF EXISTS dental_appointments_practitioner_id_fkey;

ALTER TABLE dental_appointments
  ADD CONSTRAINT dental_appointments_practitioner_id_fkey
  FOREIGN KEY (practitioner_id)
  REFERENCES dental_practitioners(id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_dental_appointments_practitioner
  ON dental_appointments(practitioner_id);
