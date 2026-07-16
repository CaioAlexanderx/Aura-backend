-- ============================================================
-- AURA KARATÊ — Migration 201: Reconciliar banner <-> evento
--
-- karate_promo_banners.event_id foi criada (migration 198) com FK para
-- karate_events(id) — mas os "eventos" reais da federação são
-- karate_belt_exams (exame/curso/graus; status draft/open/closed),
-- NÃO karate_events (tabela legada). Um banner com event_id apontando
-- para um karate_belt_exams.id quebrava a FK (insert/update falhava
-- com violação de chave estrangeira) ou, na melhor das hipóteses,
-- nunca conseguia referenciar o evento certo.
--
-- Esta migration remove a FK, deixando event_id como UUID livre — pode
-- apontar para karate_belt_exams (uso atual/pretendido) sem deixar de
-- aceitar NULL (banner sem evento vinculado, puramente promocional).
-- Não há FK substituta de propósito porque o mesmo campo pode, no
-- futuro, referenciar outras entidades de "evento" (ex.: competições).
-- A coluna é mantida; nenhum dado é apagado.
--
-- Idempotente: DROP CONSTRAINT IF EXISTS.
-- Nome da constraint confirmado via Supabase (pg_constraint):
--   karate_promo_banners_event_id_fkey (nome auto-gerado pelo Postgres
--   para a FK inline declarada na migration 198).
-- Aplicar via Supabase MCP (apply_migration) antes de mergear o PR.
-- ============================================================

ALTER TABLE karate_promo_banners
  DROP CONSTRAINT IF EXISTS karate_promo_banners_event_id_fkey;

-- FIM DA MIGRATION 201
