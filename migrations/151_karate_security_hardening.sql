-- ============================================================
-- AURA KARATÊ — Migration 151: Hardening de segurança (P0)
-- Resolve advisors: security_definer_view + function_search_path_mutable
-- Não-destrutiva e idempotente. APLICADA em 06/06/2026 no projeto
-- Supabase hawtujkztrjpvvkihowb. Commitar para manter o repo em sync.
-- ============================================================

-- V2: a view passa a respeitar RLS (roda como o caller, não como owner).
-- Backend usa service_role (bypassa RLS), então não há quebra; acesso
-- direto anon/authenticated fica negado — postura de segurança desejada.
ALTER VIEW public.karate_current_belt SET (security_invoker = on);

-- V3: pinar search_path das funções karatê (elimina hijack de schema).
-- A função imutável só faz RAISE → search_path vazio é seguro.
ALTER FUNCTION public.karate_belt_history_immutable() SET search_path = '';

-- A função de seed faz INSERT em tabela do schema public → pinar em public
-- (mantém o corpo funcionando sem requalificar as tabelas).
ALTER FUNCTION public.karate_seed_fpkt_requirements(uuid) SET search_path = public;

-- ============================================================
-- FIM DA MIGRATION 151
-- ============================================================
