-- ============================================================
-- AURA. — Migration 105: weekly_report_enabled (allowlist)
--
-- Adiciona flag explicito por empresa para o cron de relatorio
-- semanal. Default false — nenhuma empresa entra no batch sem
-- aprovacao expressa. Evita disparo acidental para contas de
-- teste, admin ou inativas em onboarding.
--
-- Aplicada via Supabase MCP em 11/05/2026 ~01h.
-- ============================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS weekly_report_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN companies.weekly_report_enabled IS
  'Allowlist do cron de relatorio semanal. Default false. Setar true explicitamente para liberar envio.';

-- Habilitar para os 3 clientes-foco do go-live 12/05/2026:
-- Finesse, Encanto Presentes, Davi Calcados (Matriz + Villa Branca consolidados)
UPDATE companies SET weekly_report_enabled = true
WHERE id IN (
  'ba768cfa-cce5-4a7b-bcc9-3279b305cb70', -- Finesse (Eryca)
  '2461b205-5047-4ef5-beb1-9bf39e944c62', -- Encanto Presentes (Alynne, owner Vitoria)
  '08c05f0e-b75b-4c12-870e-d7fb65f1dca0', -- Davi Calcados Matriz
  'ea68b4d2-f051-46b1-9ac5-b8438c6cd5fc'  -- Davi Calcados Villa Branca
);
