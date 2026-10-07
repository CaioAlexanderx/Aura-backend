-- ============================================================
-- 367 — Crediario: debito do lancamento manual passa a incluir os juros
--       · 07/10/2026
--
-- O /manual-entry gravava o debito pelo PRINCIPAL e as parcelas pelo total
-- COM juros: R$1.000 a 30% nascia com saldo de R$1.000 no razao e uma
-- parcela de R$1.300. O lojista cobra a parcela; o razao reconhecia menos, e
-- quem pagasse tudo terminava com "credito". O codigo foi corrigido no mesmo
-- PR; aqui os lancamentos antigos sao igualados as proprias parcelas.
--
-- So entra o caso que da para provar pela linha:
--   - debito manual (source='manual', sem venda);
--   - com parcelas ligadas a ELE por transaction_id (migration 324);
--   - nenhuma delas cancelada (renegociacao/desfazer reescrevem o
--     cronograma -- ai a soma deixa de ser "o que este debito gerou");
--   - parcelas somando MAIS que o debito.
-- Em producao em 07/10/2026: 7 lancamentos, todos de uma loja, todos 1,30x.
--
-- Idempotente: depois de igualado, o debito nao casa mais com o filtro.
-- ============================================================

UPDATE customer_credit_transactions t
   SET amount = s.total
  FROM (
    SELECT i.transaction_id,
           SUM(i.amount_due)                                 AS total,
           COUNT(*) FILTER (WHERE i.status = 'cancelled')    AS cancelled
      FROM credit_installments i
     WHERE i.transaction_id IS NOT NULL
     GROUP BY i.transaction_id
  ) s
 WHERE s.transaction_id = t.id
   AND t.type = 'debit'
   AND t.sale_id IS NULL
   AND t.source = 'manual'
   AND s.cancelled = 0
   AND s.total - t.amount > 0.05;

-- credit_used e derivado do saldo (ledger._updateCreditUsed): acompanha.
UPDATE customer_credit_profiles p
   SET credit_used = GREATEST(0, cb.balance),
       updated_at  = NOW()
  FROM customer_credit_balances cb
 WHERE cb.company_id  = p.company_id
   AND cb.customer_id = p.customer_id
   AND p.credit_used IS DISTINCT FROM GREATEST(0, cb.balance)
   AND EXISTS (
     SELECT 1
       FROM customer_credit_transactions t
       JOIN credit_installments i ON i.transaction_id = t.id
      WHERE t.company_id = p.company_id AND t.customer_id = p.customer_id
        AND t.type = 'debit' AND t.sale_id IS NULL AND t.source = 'manual'
   );
