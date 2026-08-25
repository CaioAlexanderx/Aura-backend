-- ============================================================
-- 309 — Reconcilia a dupla contagem deixada pelo saldo de pagamento parcial
--
-- CONTEXTO
--   applyPayment, ao receber menos que o recebivel aberto, criava o saldo
--   remanescente com a chave 'pdv-credit-receivable-<saleId>-rest-<ts>'. Todas
--   as consultas de crediario casavam recebivel com venda por igualdade exata,
--   entao a chave com sufixo nunca casava: o saldo ficava invisivel pro FIFO e
--   NUNCA quitava. Quando o cliente pagava de novo, o pagamento entrava como
--   receita avulsa ('credit-payment-...-legacy') mas o pendente nao baixava.
--   Resultado: o Financeiro passou a mostrar como "a receber" um valor que o
--   ledger de credito ja considerava pago.
--
--   O codigo foi corrigido antes desta migration (PR #608, join por prefixo +
--   reference_id). Ela trata SO o residuo ja gravado.
--
-- O QUE FAZ
--   Para cada cliente, compara o pendente no Financeiro com a divida real no
--   ledger (customer_credit_transactions). O excesso e baixado consumindo APENAS
--   linhas '-rest-', da mais antiga pra mais nova:
--     - linha totalmente coberta pelo excesso  -> status 'cancelled'
--     - linha parcialmente coberta             -> amount reduzido
--   Recebivel normal nunca e tocado.
--
-- O QUE NAO FAZ
--   Nao usa 'confirmed': a receita desses pagamentos JA entrou pela via
--   '-legacy'. Confirmar duplicaria receita — o oposto do conserto.
--   Nao mexe no excesso sem lastro em '-rest-' (medido em 21/08: R$ 867,00).
--   Essa e outra divergencia, de causa distinta, e precisa de investigacao
--   propria antes de qualquer baixa.
--
-- ESCOPO MEDIDO (producao, 21/08/2026)
--   29 clientes, R$ 4.293,55. Em 12 deles a divida real e ZERO — pagaram tudo
--   e o Financeiro ainda mostrava saldo. Os numeros mudam a cada pagamento;
--   a migration recalcula na hora em que roda, nao usa valores fixos.
--
-- IDEMPOTENTE
--   Depois de rodar, o excesso vira zero e a re-execucao nao encontra nada.
--   Nao ha valores hardcoded.
--
-- ORDEM OBRIGATORIA
--   So rodar com o PR #608 JA EM PRODUCAO. Com o codigo antigo no ar, cada
--   pagamento parcial continua fabricando caso novo durante a reconciliacao.
-- ============================================================

BEGIN;

-- Trilha de auditoria: guarda o estado ANTES, pra permitir conferencia (e
-- reversao manual) depois. Idempotente.
CREATE TABLE IF NOT EXISTS crediario_reconciliacao_309 (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id  UUID        NOT NULL,
  company_id      UUID        NOT NULL,
  customer_id     UUID,
  idempotency_key TEXT,
  amount_antes    NUMERIC(12,2) NOT NULL,
  amount_depois   NUMERIC(12,2) NOT NULL,
  status_antes    TEXT        NOT NULL,
  status_depois   TEXT        NOT NULL,
  executado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

WITH fin AS (
  -- Pendente por cliente, ja com o join CORRIGIDO (prefixo).
  SELECT t.company_id,
         s.customer_id,
         SUM(t.amount) AS fin_pendente,
         COALESCE(SUM(t.amount) FILTER (WHERE t.idempotency_key LIKE '%-rest-%'), 0) AS resgatavel
    FROM transactions t
    JOIN sales s
      ON t.idempotency_key LIKE 'pdv-credit-receivable-' || s.id::text || '%'
   WHERE t.category ILIKE 'Crediario%A Receber%'
     AND t.status = 'pending'
   GROUP BY 1, 2
),
ledger AS (
  SELECT company_id, customer_id,
         SUM(CASE WHEN type = 'debit' THEN amount ELSE -amount END) AS divida_real
    FROM customer_credit_transactions
   GROUP BY 1, 2
),
excesso AS (
  SELECT f.company_id,
         f.customer_id,
         LEAST(
           GREATEST(f.fin_pendente - GREATEST(COALESCE(l.divida_real, 0), 0), 0),
           f.resgatavel
         ) AS a_baixar
    FROM fin f
    LEFT JOIN ledger l USING (company_id, customer_id)
),
-- Linhas '-rest-' do cliente, da mais antiga pra mais nova, com o acumulado
-- ANTES de cada uma (pra saber quanto do excesso ja foi consumido).
alvo AS (
  SELECT t.id,
         t.company_id,
         s.customer_id,
         t.idempotency_key,
         t.amount,
         t.status,
         COALESCE(SUM(t.amount) OVER (
           PARTITION BY t.company_id, s.customer_id
           ORDER BY t.created_at, t.id
           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
         ), 0) AS acumulado_antes
    FROM transactions t
    JOIN sales s
      ON t.idempotency_key LIKE 'pdv-credit-receivable-' || s.id::text || '%'
   WHERE t.category ILIKE 'Crediario%A Receber%'
     AND t.status = 'pending'
     AND t.idempotency_key LIKE '%-rest-%'
),
plano AS (
  SELECT a.*,
         e.a_baixar,
         -- Quanto do excesso sobra quando chega nesta linha.
         GREATEST(e.a_baixar - a.acumulado_antes, 0) AS restante
    FROM alvo a
    JOIN excesso e USING (company_id, customer_id)
   WHERE e.a_baixar > 0.005
),
decisao AS (
  SELECT id, company_id, customer_id, idempotency_key, amount, status,
         CASE
           -- Linha inteiramente coberta: o VALOR fica (pra trilha e pra
           -- conferencia do lojista); quem a tira da conta e o status.
           WHEN restante >= amount - 0.005 THEN amount
           -- Parcialmente coberta: sobra so o que ainda e devido.
           ELSE ROUND(amount - restante, 2)
         END AS amount_depois,
         CASE
           WHEN restante >= amount - 0.005 THEN 'cancelled'
           ELSE 'pending'
         END AS status_depois
    FROM plano
   WHERE restante > 0.005
),
registro AS (
  INSERT INTO crediario_reconciliacao_309
    (transaction_id, company_id, customer_id, idempotency_key,
     amount_antes, amount_depois, status_antes, status_depois)
  SELECT id, company_id, customer_id, idempotency_key,
         amount, amount_depois, status::text, status_depois
    FROM decisao
  RETURNING transaction_id, amount_depois, status_depois
)
UPDATE transactions t
   SET amount     = r.amount_depois,
       status     = r.status_depois::transaction_status,
       notes      = COALESCE(t.notes || ' | ', '')
                    || 'Reconciliado pela migration 309 (saldo de pagamento parcial ja quitado no ledger)',
       updated_at = NOW()
  FROM registro r
 WHERE t.id = r.transaction_id;

COMMIT;

-- Conferencia sugerida apos rodar (deve voltar 0 linhas):
--   WITH fin AS (...), ledger AS (...)  -- mesmas CTEs acima
--   SELECT * FROM fin f LEFT JOIN ledger l USING (company_id, customer_id)
--    WHERE f.fin_pendente > GREATEST(COALESCE(l.divida_real,0),0) + 0.005
--      AND f.resgatavel > 0.005;
