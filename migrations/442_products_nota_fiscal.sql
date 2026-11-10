-- ============================================================
-- 442 — O item escolhe a nota: "Sai em" NFC-e ou NFS-e (10/11/2026)
--
-- Contexto: ate aqui "vai para a NFS-e" era sinonimo de products.unit =
-- 'srv' (Servico), e servico nao tem estoque. Uma grafica vende carimbo sob
-- encomenda: e ISS, sai em NFS-e (13.05.01), mas a mecanica do carimbo e
-- peca comprada que precisa de controle de estoque.
--
-- Decisao do dono: separar a NOTA do TIPO do item. Coluna nova:
--   nota_fiscal = 'nfce' -> o item sai no cupom fiscal (NFC-e/NF-e);
--   nota_fiscal = 'nfse' -> o item sai na nota de servico (NFS-e);
--   nota_fiscal = NULL   -> segue o tipo, como hoje: produto na NFC-e,
--                           servico (unit 'srv') na NFS-e.
-- Regra unica no backend: src/services/notaDoItem.js (vaiNaNfse/vaiNaNfce).
-- A baixa de estoque NAO muda: continua pelo tipo do item.
--
-- DECISOES:
-- - Nulavel, sem default e sem backfill: NULL = comportamento de hoje.
--   Nenhum dado existente muda.
-- - CHECK so com os dois valores; a validacao com mensagem gentil fica na
--   rota (src/routes/products.js).
--
-- So ADITIVA e idempotente. Sem reescrita de tabela, sem indice.
--
-- Caminho de volta (e reverter o PR: o codigo le e grava a coluna com
-- degrau 42703 para base sem ela):
--   ALTER TABLE products DROP CONSTRAINT IF EXISTS products_nota_fiscal_check;
--   ALTER TABLE products DROP COLUMN IF EXISTS nota_fiscal;
-- ============================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS nota_fiscal text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'products_nota_fiscal_check'
       AND conrelid = 'products'::regclass
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_nota_fiscal_check
      CHECK (nota_fiscal IN ('nfce', 'nfse'));
  END IF;
END $$;

COMMENT ON COLUMN products.nota_fiscal IS
  'Em que nota o item sai: nfce (cupom fiscal) ou nfse (nota de servico). NULL = segue o tipo (produto na NFC-e, unit srv na NFS-e). Nao muda a baixa de estoque. Migration 442.';
