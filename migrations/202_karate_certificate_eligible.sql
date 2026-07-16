-- ============================================================
-- AURA KARATÊ — Migration 202: Elegibilidade a certificado
--
-- Workflow de certificados (Bloco C) — SEM geração de arte. Apenas
-- marca quem está elegível a receber certificado quando o evento
-- fecha, para a federação consultar/listar depois:
--   - curso (exam_type='curso')  -> TODOS os inscritos/participantes
--   - exame/graus                -> apenas candidatos com status='approved'
--
-- certificate_eligible em karate_belt_exam_candidates cobre exames E
-- cursos modelados como karate_belt_exams (exam_type='curso', Bloco
-- anterior que ampliou exam_type). karate_event_enrollments também
-- recebe a coluna pois é o fluxo de inscrição da tabela legada
-- karate_events (curso "antigo") — mesma semântica: marcado elegível
-- quando o evento fecha.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS.
-- Aplicar via Supabase MCP (apply_migration) antes de mergear o PR.
-- ============================================================

ALTER TABLE karate_belt_exam_candidates
  ADD COLUMN IF NOT EXISTS certificate_eligible boolean NOT NULL DEFAULT false;

ALTER TABLE karate_event_enrollments
  ADD COLUMN IF NOT EXISTS certificate_eligible boolean NOT NULL DEFAULT false;

-- FIM DA MIGRATION 202
