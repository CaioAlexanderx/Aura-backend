-- ========================================================================
-- Migration 110 · companies.extra_seats_granted
--
-- 12/05/2026: Caso Alynne (Encanto Presentes) — cliente Essencial paga
-- por 1 acesso extra (R$19/mes) mas nao havia onde marcar isso no
-- backend. memberSeats so conhecia o plano hardcoded (1/3/5/999), entao
-- /unified retornava at_limit=true e o frontend bloqueava convite.
--
-- Solucao: coluna numerica em companies que soma ao seats_included do
-- plano. Caio marca via Gestao Aura conforme pagamento confirmado.
-- ========================================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS extra_seats_granted INTEGER NOT NULL DEFAULT 0;

-- CHECK separado pra ficar idempotente (ADD CHECK CONSTRAINT nao tem IF NOT EXISTS
-- no Postgres < 16; usamos DO block pra checar antes).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'companies_extra_seats_granted_nonneg'
  ) THEN
    ALTER TABLE companies
      ADD CONSTRAINT companies_extra_seats_granted_nonneg
      CHECK (extra_seats_granted >= 0);
  END IF;
END $$;

COMMENT ON COLUMN companies.extra_seats_granted IS
  'Acessos extras pagos manualmente pelo cliente (R$19/seat). Soma ao seats_included do plano em memberSeats.summarizeSeats. Gerenciado via Gestao Aura.';
