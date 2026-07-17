-- ============================================================
-- Migration 238: nfce_config.provider aceita NULL (= modo AUTO do Aura Notas)
-- NULL → engine própria quando a empresa está apta (A1 vigente + CSC),
--        senão gateway (fallback automático cobre falhas em runtime).
-- 'nuvemfiscal' segue como kill-switch explícito; 'sefaz_sp' força engine.
-- Aplicada no Supabase em 17/07/2026 (cutover Davi). Idempotente.
-- ============================================================
ALTER TABLE nfce_config ALTER COLUMN provider DROP NOT NULL;
ALTER TABLE nfce_config ALTER COLUMN provider DROP DEFAULT;
