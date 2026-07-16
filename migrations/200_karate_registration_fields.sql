-- ============================================================
-- AURA KARATÊ — Migration 200: Formulário de inscrição configurável
--
-- Bloco A — federação define campos extras de inscrição por evento
-- (exame OU curso), e o praticante responde no fluxo público de
-- inscrição. Os campos ficam em karate_belt_exams.registration_fields
-- (array de { key, label, type, required, options? }) e as respostas
-- do candidato/inscrito ficam em registration_responses ({key: value}).
--
-- karate_event_enrollments também recebe registration_responses pois
-- o fluxo público de inscrição (POST /:slug/inscricao/:eventId) trata
-- exame e curso no mesmo endpoint — curso usa karate_events como
-- "evento", mas os campos configuráveis hoje só existem em
-- karate_belt_exams (exame). Mantemos registration_responses em
-- karate_event_enrollments para já guardar a resposta do inscrito
-- mesmo quando os campos forem futuramente estendidos a karate_events.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS.
-- NÃO aplicada a nenhum banco por esta migration; aplicar via Supabase MCP
-- (apply_migration) antes de mergear o PR do backend.
-- ============================================================

ALTER TABLE karate_belt_exams
  ADD COLUMN IF NOT EXISTS registration_fields jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE karate_belt_exam_candidates
  ADD COLUMN IF NOT EXISTS registration_responses jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE karate_event_enrollments
  ADD COLUMN IF NOT EXISTS registration_responses jsonb NOT NULL DEFAULT '{}'::jsonb;

-- FIM DA MIGRATION 200
