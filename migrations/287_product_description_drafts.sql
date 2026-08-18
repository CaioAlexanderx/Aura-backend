-- ============================================================
-- 287 — Rascunhos de descrição de produto gerados por IA (F0 → F1)
--
-- POR QUE UMA TABELA DE RASCUNHO, E NÃO ESCRITA DIRETA EM
-- products.description:
--   A descrição é a vitrine pública do lojista. Texto gerado que entra
--   direto no catálogo publica erro sem ninguém ver. O fluxo é sempre
--   gerar → revisar → aprovar, e só o aprovar escreve em
--   products.description. Sem aprovação, o catálogo não muda.
--
-- Medido em 18/08/2026, o que motiva a fase: 4.734 produtos ativos na
-- base inteira estão sem descrição — a Davi Calçados (piloto) está com
-- 100% do catálogo sem texto (1.434 de 1.434 na matriz).
--
-- `status`:
--   pendente  — gerado, aguardando revisão do lojista
--   aprovado  — copiado para products.description
--   rejeitado — descartado; libera o produto para nova geração
--
-- O índice único parcial garante NO MÁXIMO UM rascunho pendente por
-- produto: gerar duas vezes seguidas não empilha rascunho, e a rota de
-- geração pula quem já tem um pendente.
--
-- Idempotente: pode rodar quantas vezes for.
-- ============================================================

CREATE TABLE IF NOT EXISTS product_description_drafts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id    UUID NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
  draft         TEXT NOT NULL,
  model         TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  status        TEXT NOT NULL DEFAULT 'pendente',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at   TIMESTAMPTZ,
  reviewed_by   UUID
);

DO $$ BEGIN
  ALTER TABLE product_description_drafts
    ADD CONSTRAINT product_description_drafts_status_chk
    CHECK (status IN ('pendente', 'aprovado', 'rejeitado'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- No máximo um rascunho PENDENTE por produto.
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_description_drafts_pendente
  ON product_description_drafts (product_id)
  WHERE status = 'pendente';

-- A listagem do lojista é sempre por empresa + status, mais recente primeiro.
CREATE INDEX IF NOT EXISTS idx_product_description_drafts_company_status
  ON product_description_drafts (company_id, status, created_at DESC);

COMMENT ON TABLE product_description_drafts IS
  'Descrições de produto geradas por IA aguardando revisão. Só o approve escreve em products.description.';
