-- ============================================================
-- migration 233: fila de impressão de carteirinhas (karate_membership_cards)
--
-- Contexto (Caio): a federação gera carteirinha e imprime sem controle
-- nenhum ("passando de 50 já ficaria muito complicado"). Este migration
-- adiciona o ESTADO da fila à MESMA tabela karate_membership_cards
-- (migration 164 + revoked_at da 191) — não cria tabela paralela.
--
-- Três etapas (print_status):
--   'to_print'  — carteirinha gerada, esperando (default; entra aqui ao emitir)
--   'printed'   — a federação clicou "imprimir" (achamos que imprimiu — NÃO é
--                 prova de impressão; por isso existe o caminho de volta)
--   'delivered' — chegou na mão do praticante (SÓ confirmação manual)
--
-- print_count: nº de vezes que a carteirinha foi de fato marcada como
-- impressa (via ação "Imprimir selecionadas"). Base da cópia de "via":
-- print_count=1 → "1ª via"; print_count=2 → "2ª via" (reimpressão), etc.
-- "Não saiu / reimprimir" e "Reimprimir" (perdeu/rasgou/graduou) devolvem
-- para 'to_print' SEM alterar print_count — só a próxima impressão de fato
-- incrementa. Isso é o que conserta o furo do onafterprint (ver front).
--
-- Idempotente: todo o backfill roda dentro de um bloco que só executa na
-- PRIMEIRA aplicação (checa se a coluna já existe antes de criar). Uma
-- segunda aplicação (reapply) é no-op — sem isso, reaplicar varreria
-- qualquer carteirinha 'to_print' legítima para 'delivered' de novo.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'karate_membership_cards' AND column_name = 'print_status'
  ) THEN
    ALTER TABLE karate_membership_cards ADD COLUMN print_status text NOT NULL DEFAULT 'to_print';
    ALTER TABLE karate_membership_cards ADD COLUMN printed_at timestamptz;
    ALTER TABLE karate_membership_cards ADD COLUMN delivered_at timestamptz;
    ALTER TABLE karate_membership_cards ADD COLUMN delivered_by uuid;
    ALTER TABLE karate_membership_cards ADD COLUMN print_count integer NOT NULL DEFAULT 0;

    -- Backfill único: cartões ATIVOS emitidos antes desta feature já foram
    -- impressos/entregues manualmente pela federação, fora de qualquer
    -- controle. Sem isso a fila "A imprimir" nasceria com centenas de
    -- cartões antigos represados (decisão Caio: fila é só emissão nova +
    -- reimpressão, não uma leva histórica).
    UPDATE karate_membership_cards
    SET print_status = 'delivered',
        printed_at   = issued_at,
        delivered_at = issued_at,
        print_count  = 1
    WHERE status = 'active';
  END IF;
END $$;

DO $$
BEGIN
  ALTER TABLE karate_membership_cards
    ADD CONSTRAINT chk_kmc_print_status CHECK (print_status IN ('to_print','printed','delivered'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_kmc_print_status ON karate_membership_cards(federation_id, print_status);
CREATE INDEX IF NOT EXISTS idx_kmc_dojo_print    ON karate_membership_cards(dojo_id, print_status);
