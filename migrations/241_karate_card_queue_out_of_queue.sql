-- ============================================================
-- migration 241: tirar carteirinha da fila de impressão SEM revogar
-- (novo print_status 'out_of_queue')
--
-- Contexto (Caio, 17/07/2026): "adicionar uma função de apagar a
-- carteirinha da fila de impressão, para a federação gerenciar melhor o
-- que deve ser impresso de fato." NÃO é revogação: karate_membership_cards
-- .status continua 'active', verifyByToken() (verificação pública / QR)
-- NÃO filtra por print_status — o praticante segue com carteirinha válida
-- normalmente. Só sai da FILA (a aba operacional que a federação usa pra
-- decidir o que mandar pra impressão).
--
-- Novo valor de print_status: 'out_of_queue' — mantém o padrão em inglês
-- de to_print/printed/delivered (migration 233).
--
-- out_of_queue_at: equivalente a issued_at/printed_at/delivered_at, para
-- a mesma regra de ordenação "gerado por último, visualizado primeiro"
-- (issued_at em to_print, printed_at em printed, delivered_at em
-- delivered — agora out_of_queue_at em out_of_queue), válida também
-- nesta aba nova.
--
-- print_status é restringido por CHECK constraint (chk_kmc_print_status,
-- migration 233), NÃO por enum type (confirmado via catálogo em prod:
-- CHECK ((print_status = ANY (ARRAY['to_print','printed','delivered'])))).
-- Postgres não tem "ALTER CHECK" — precisa DROP + ADD. DROP CONSTRAINT IF
-- EXISTS + ADD CONSTRAINT (sem bloco DO) já é idempotente por si só: a
-- segunda aplicação dropa a constraint (já com a definição nova) e recria
-- exatamente igual — nunca lança duplicate_object nem quebra em reapply.
--
-- Lembrete (armadilha nº1 do CLAUDE.md — schema antes da migration): o
-- backend sobe ANTES desta migration ser aplicada. O código em
-- karateCardService.js/karateCards.js que usa 'out_of_queue' e
-- out_of_queue_at tem fallback defensivo a 42703 até a migration rodar
-- em produção (ver comentários no service).
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'karate_membership_cards' AND column_name = 'out_of_queue_at'
  ) THEN
    ALTER TABLE karate_membership_cards ADD COLUMN out_of_queue_at timestamptz;
  END IF;
END $$;

ALTER TABLE karate_membership_cards DROP CONSTRAINT IF EXISTS chk_kmc_print_status;

ALTER TABLE karate_membership_cards
  ADD CONSTRAINT chk_kmc_print_status
  CHECK (print_status IN ('to_print','printed','delivered','out_of_queue'));

CREATE INDEX IF NOT EXISTS idx_kmc_out_of_queue_at
  ON karate_membership_cards(federation_id, out_of_queue_at)
  WHERE print_status = 'out_of_queue';
