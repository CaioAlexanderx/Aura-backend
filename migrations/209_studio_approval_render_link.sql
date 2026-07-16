-- ============================================================
-- 209 — Aura Studio · Visual Engine F2
--
-- Vincula o render HD (studio_visual_renders, migration 208) ao link
-- de aprovação EXISTENTE (studio_approval_links, migration 132).
-- Decisão 03/07: estender o sistema de aprovação F5 em vez de criar
-- um paralelo. O render carrega content_hash = prova imutável do que
-- o cliente aprovou (template@version + customization canônica).
--
-- Soft reference (sem FK) — mesmo racional do visual_template_key:
-- não travar CI/seed nem ordenar deploy.
-- Idempotente. Aplicar via Supabase MCP antes do merge.
-- ============================================================

ALTER TABLE studio_approval_links
  ADD COLUMN IF NOT EXISTS render_id UUID;

COMMENT ON COLUMN studio_approval_links.render_id IS
  'studio_visual_renders.id do render HD gerado pelo Visual Engine (F2). NULL = mockup enviado manualmente (fluxo antigo).';
