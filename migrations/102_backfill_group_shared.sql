-- ============================================================
-- 102_backfill_group_shared.sql
-- Backfill is_group_shared=true para produtos cujas empresas
-- estão em billing group (matriz com subsidiárias OU subsidiária
-- de uma matriz).
--
-- Bug Davi (08/05/2026): produto criado em Villa Branca (cnpj2)
-- ficava invisível na Matriz porque visibilidade do GET era
-- unidirecional (subsidiária via matriz, mas matriz não via
-- subsidiária). Migration 102 + bidir-fix em products.js (PR #43)
-- corrigem o problema. Para clientes em produção que já tinham
-- produtos cadastrados antes desse fix, esta migration marca
-- todos eles como shared para que apareçam corretamente.
--
-- Idempotente: SET is_group_shared = true só nas rows onde já é
-- false. Roda múltiplas vezes sem efeito colateral.
--
-- Escopo: somente produtos de empresas que pertencem a um grupo
-- (matriz ou subsidiária). Empresas standalone NÃO são afetadas.
-- ============================================================

UPDATE products
SET    is_group_shared = true
WHERE  is_group_shared = false
  AND  company_id IN (
    SELECT id FROM companies c
    WHERE
      -- empresa é subsidiária (tem billing_owner != self)
      (c.billing_owner_company_id IS NOT NULL AND c.billing_owner_company_id != c.id)
      -- ou empresa é matriz (tem subsidiárias apontando pra ela)
      OR EXISTS (
        SELECT 1 FROM companies sub
        WHERE sub.billing_owner_company_id = c.id
          AND sub.id != c.id
      )
  );

-- Sanity check: log quantos produtos foram afetados (visível no
-- output do migration runner).
DO $$
DECLARE
  affected INTEGER;
BEGIN
  SELECT COUNT(*) INTO affected
  FROM products p
  WHERE p.is_group_shared = true
    AND p.company_id IN (
      SELECT id FROM companies c
      WHERE (c.billing_owner_company_id IS NOT NULL AND c.billing_owner_company_id != c.id)
         OR EXISTS (SELECT 1 FROM companies sub WHERE sub.billing_owner_company_id = c.id AND sub.id != c.id)
    );
  RAISE NOTICE '[migration 102] produtos shared em billing groups: %', affected;
END
$$;
