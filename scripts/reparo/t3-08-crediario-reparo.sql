-- ============================================================
-- t3-08 -- REPARO de dado antigo do crediario (razao x parcelas)
--
-- NAO E MIGRATION. NAO RODA SOZINHO. Fica fora de migrations/ de proposito:
-- a Celia e o Caio decidem se e quando rodar, depois de ler a lista de casos.
--
-- Como rodar (producao, depois da decisao):
--   1. Rodar a "Conferencia antes" (no fim deste arquivo) e guardar o resultado.
--   2. psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/reparo/t3-08-crediario-reparo.sql
--      (o arquivo abre e fecha a propria transacao: ou entra tudo, ou nada)
--   3. Rodar a "Conferencia depois".
-- Caminho de volta: toda linha alterada fica em crediario_reparo_t308 com o
-- valor de antes (ver "Desfazer" no fim).
--
-- O QUE FAZ (so o que da para provar pela linha; o resto e so listado)
--   A. Parcela ORFA de lancamento REFEITO: o cronograma nasceu sem debito no
--      razao (o debito foi apagado pelo "Excluir" antigo da timeline, antes
--      do Aura-backend#690) e a lojista lancou de novo o MESMO valor depois.
--      As parcelas abertas que descendem dele (atravessando renegociacoes)
--      sao canceladas. Guardas: nenhuma delas recebeu pagamento
--      (covered_amount = 0) e o total cancelado nao passa do excesso de
--      parcelas sobre o saldo do cliente.
--   B. Juros de lancamento manual anterior a 367 que a 367 nao alcancou
--      porque o cronograma foi renegociado SEM mudar o total: o debito sobe
--      para o total das parcelas (mesma regra da 367, decisao de 07/10).
--      Guarda: o cronograma vivo que descende dele soma exatamente o total
--      com juros e a renegociacao nao lancou nada no razao.
--   C. Pagamento que saiu do razao e nao abateu parcela: (1) pagamento
--      direcionado a carne ja quitado (corrigido no codigo neste PR) e
--      (2) cobertura de parcela cancelada sem substituta (desfazer
--      lancamento) que nao voltou para parcela criada depois. A cobertura e
--      reaplicada FIFO (vencimento mais antigo primeiro) nas parcelas abertas
--      que NAO sao orfas. Guarda: nunca acima do excesso de parcelas sobre o
--      saldo, ja descontada a parte orfa que ficou.
--
-- O QUE NAO FAZ (lista no fim, para decidir com a lojista)
--   - orfa SEM lancamento refeito: pode ser divida real (repor o debito) ou
--     lancamento abandonado (cancelar). So a lojista sabe.
--   - orfa com pagamento ja aplicado.
--   - saldo credor (razao negativo): pagamento digitado a mais, estorno de
--     renegociacao sobre parcela orfa. Mexer no razao e decisao de gente.
--   - venda crediario 1x sem parcela: e o gate deliberado do PDV, nao defeito.
--
-- IDEMPOTENTE: depois de rodar, A nao acha parcela aberta orfa refeita, B nao
-- acha debito abaixo do proprio cronograma e C nao acha excesso para cobrir.
-- Rodar de novo nao muda nada (coberto pelo teste
-- __tests__/credito.reparoT308.banco.test.js).
--
-- Instantes sempre comparados em SQL (created_at tem microssegundo).
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS crediario_reparo_t308 (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  etapa          TEXT        NOT NULL,           -- 'A' | 'B' | 'C'
  company_id     UUID        NOT NULL,
  customer_id    UUID        NOT NULL,
  installment_id UUID,
  transaction_id UUID,
  campo          TEXT        NOT NULL,
  antes          TEXT,
  depois         TEXT,
  executado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- Linhagem das parcelas. Renegociar / juntar carnes / unificar cancelam as
-- parcelas antigas com updated_at = NOW() e criam as novas com created_at =
-- o mesmo NOW(): essa igualdade e a aresta pai -> filho.
-- ------------------------------------------------------------
DROP TABLE IF EXISTS t308_tree;
CREATE TEMP TABLE t308_tree ON COMMIT DROP AS
WITH RECURSIVE
edge AS (
  SELECT DISTINCT p.id AS parent_id, c.id AS child_id
    FROM credit_installments c
    JOIN credit_installments p
      ON p.company_id = c.company_id AND p.customer_id = c.customer_id
     AND p.status = 'cancelled' AND p.updated_at = c.created_at AND p.id <> c.id
   WHERE c.transaction_id IS NULL),
root AS (
  SELECT i.id FROM credit_installments i
   WHERE NOT EXISTS (SELECT 1 FROM edge e WHERE e.child_id = i.id)),
tree AS (
  SELECT r.id AS root_id, r.id AS node_id FROM root r
  UNION
  SELECT t.root_id, e.child_id FROM tree t JOIN edge e ON e.parent_id = t.node_id)
SELECT * FROM tree;

-- ------------------------------------------------------------
-- Eventos raiz orfaos: cronograma nascido sem debito no razao.
-- ------------------------------------------------------------
DROP TABLE IF EXISTS t308_orfa;
CREATE TEMP TABLE t308_orfa ON COMMIT DROP AS
WITH
root AS (
  SELECT i.* FROM credit_installments i
   WHERE EXISTS (SELECT 1 FROM t308_tree t WHERE t.root_id = i.id)),
ev AS (
  SELECT r.company_id, r.customer_id, r.account_id, r.created_at,
         SUM(r.amount_due) AS ev_amount,
         bool_or(r.transaction_id IS NOT NULL) AS has_tx,
         bool_or(r.sale_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM customer_credit_transactions t
              WHERE t.sale_id = r.sale_id AND t.type = 'debit')) AS sale_ok,
         array_agg(r.id) AS root_ids
    FROM root r GROUP BY 1,2,3,4),
ev_orfa AS (
  SELECT ev.*,
         -- refeito = a lojista lancou de novo o MESMO valor depois
         EXISTS (SELECT 1 FROM customer_credit_transactions t
                  WHERE t.company_id = ev.company_id AND t.customer_id = ev.customer_id
                    AND t.type = 'debit' AND t.created_at > ev.created_at
                    AND abs(t.amount - ev.ev_amount) <= 0.01) AS refeito
    FROM ev
   WHERE NOT has_tx AND NOT sale_ok
     AND NOT EXISTS (SELECT 1 FROM customer_credit_transactions t
                      WHERE t.company_id = ev.company_id AND t.customer_id = ev.customer_id
                        AND t.created_at = ev.created_at)
     -- lancamento manual retroativo anterior a 324: o debito existe com outra hora
     AND NOT EXISTS (SELECT 1 FROM customer_credit_transactions t
                      WHERE t.company_id = ev.company_id AND t.customer_id = ev.customer_id
                        AND t.type = 'debit' AND t.source = 'manual'
                        AND t.account_id IS NOT DISTINCT FROM ev.account_id
                        AND t.amount <= ev.ev_amount + 0.01
                        AND NOT EXISTS (SELECT 1 FROM credit_installments x
                                         WHERE x.transaction_id = t.id)))
SELECT DISTINCT n.id AS installment_id, n.company_id, n.customer_id,
       o.created_at AS evento, o.ev_amount, o.refeito,
       GREATEST(n.amount_due - COALESCE(n.covered_amount, 0), 0) AS aberto,
       COALESCE(n.covered_amount, 0) AS coberto
  FROM ev_orfa o
  JOIN t308_tree t ON t.root_id = ANY (o.root_ids)
  JOIN credit_installments n ON n.id = t.node_id
 WHERE n.status IN ('pending', 'overdue');

-- Excesso de parcelas abertas sobre o saldo do razao, por cliente (agora).
CREATE OR REPLACE FUNCTION pg_temp.t308_excesso(p_company UUID, p_customer UUID)
RETURNS NUMERIC LANGUAGE sql STABLE AS $f$
  SELECT COALESCE((SELECT SUM(GREATEST(amount_due - COALESCE(covered_amount, 0), 0))
                     FROM credit_installments
                    WHERE company_id = p_company AND customer_id = p_customer
                      AND status IN ('pending', 'overdue')), 0)
       - COALESCE((SELECT balance FROM customer_credit_balances
                    WHERE company_id = p_company AND customer_id = p_customer), 0)
$f$;

-- ------------------------------------------------------------
-- A. Orfa de lancamento refeito, sem pagamento -> cancelada.
-- ------------------------------------------------------------
WITH por_cliente AS (
  SELECT company_id, customer_id,
         SUM(aberto) AS total, bool_and(coberto < 0.005) AS sem_pagamento
    FROM t308_orfa WHERE refeito
   GROUP BY 1,2),
alvo AS (
  SELECT o.installment_id
    FROM t308_orfa o
    JOIN por_cliente p USING (company_id, customer_id)
   WHERE o.refeito AND p.sem_pagamento
     AND p.total <= pg_temp.t308_excesso(o.company_id, o.customer_id) + 0.01),
upd AS (
  UPDATE credit_installments i
     SET status = 'cancelled', updated_at = NOW(),
         notes = concat_ws(' | ', NULLIF(i.notes, ''),
                 'Reparo t3-08: parcela sem lancamento no razao (lancamento refeito)')
    FROM alvo
   WHERE i.id = alvo.installment_id
     AND i.status IN ('pending', 'overdue')
     AND COALESCE(i.covered_amount, 0) = 0
  RETURNING i.id, i.company_id, i.customer_id)
INSERT INTO crediario_reparo_t308 (etapa, company_id, customer_id, installment_id, campo, antes, depois)
SELECT 'A', company_id, customer_id, id, 'status', 'aberta', 'cancelled' FROM upd;

-- ------------------------------------------------------------
-- B. Juros fora do debito (manual anterior a 367, renegociado sem mudar total).
-- ------------------------------------------------------------
WITH deb AS (
  SELECT t.id, t.company_id, t.customer_id, t.amount,
         (SELECT SUM(i.amount_due) FROM credit_installments i WHERE i.transaction_id = t.id) AS nasceu,
         (SELECT bool_and(i.status = 'cancelled') FROM credit_installments i WHERE i.transaction_id = t.id) AS tudo_cancelado
    FROM customer_credit_transactions t
   WHERE t.type = 'debit' AND t.source = 'manual' AND t.sale_id IS NULL),
vivo AS (
  -- cronograma que descende das parcelas do debito e segue vivo
  SELECT d.id AS debit_id,
         SUM(n.amount_due) FILTER (WHERE n.status <> 'cancelled') AS total_vivo,
         bool_or(EXISTS (SELECT 1 FROM customer_credit_transactions r
                          WHERE r.company_id = n.company_id AND r.customer_id = n.customer_id
                            AND r.source = 'reschedule' AND r.created_at = n.created_at)) AS renegociou_com_ajuste
    FROM deb d
    JOIN credit_installments i0 ON i0.transaction_id = d.id
    JOIN t308_tree t ON t.root_id = i0.id
    JOIN credit_installments n ON n.id = t.node_id AND n.id <> i0.id
   GROUP BY d.id),
alvo AS (
  SELECT d.*
    FROM deb d JOIN vivo v ON v.debit_id = d.id
   WHERE d.tudo_cancelado
     AND d.nasceu - d.amount > 0.05
     AND abs(v.total_vivo - d.nasceu) <= 0.01
     AND NOT v.renegociou_com_ajuste
     AND d.nasceu - d.amount <= pg_temp.t308_excesso(d.company_id, d.customer_id) + 0.01),
upd AS (
  UPDATE customer_credit_transactions t
     SET amount = alvo.nasceu
    FROM alvo
   WHERE t.id = alvo.id AND t.amount = alvo.amount
  RETURNING t.id, t.company_id, t.customer_id, alvo.amount AS antes, t.amount AS depois)
INSERT INTO crediario_reparo_t308 (etapa, company_id, customer_id, transaction_id, campo, antes, depois)
SELECT 'B', company_id, customer_id, id, 'amount', antes::text, depois::text FROM upd;

-- ------------------------------------------------------------
-- C. Pagamento que saiu do razao e nao abateu parcela -> cobertura FIFO.
-- ------------------------------------------------------------
DO $c$
DECLARE
  r      RECORD;
  inst   RECORD;
  resto  NUMERIC;
  cobre  NUMERIC;
  novo   NUMERIC;
BEGIN
  FOR r IN
    WITH
    pag_carne AS (
      SELECT company_id, customer_id, account_id, SUM(amount) AS pago
        FROM customer_credit_transactions
       WHERE type = 'payment' AND account_id IS NOT NULL
       GROUP BY 1,2,3),
    cabe_carne AS (
      SELECT company_id, customer_id, account_id, SUM(amount_due) AS cabe
        FROM credit_installments
       WHERE status <> 'cancelled' AND account_id IS NOT NULL
       GROUP BY 1,2,3),
    -- limite inferior pelo carne: pagamentos do carne acima do que as
    -- parcelas vivas dele somam (vale tambem antes de 15/09)
    f_carne AS (
      SELECT p.company_id, p.customer_id, SUM(GREATEST(p.pago - COALESCE(c.cabe, 0), 0)) AS v
        FROM pag_carne p
        LEFT JOIN cabe_carne c USING (company_id, customer_id, account_id)
       GROUP BY 1,2),
    -- exato desde 15/09 (credit_payment_allocations): o que o pagamento do
    -- carne nao distribuiu em parcela nenhuma
    f_exato AS (
      SELECT t.company_id, t.customer_id, SUM(t.amount - COALESCE(a.s, 0)) AS v
        FROM customer_credit_transactions t
        LEFT JOIN LATERAL (SELECT SUM(principal_paid + charges_paid) AS s
                             FROM credit_payment_allocations x
                            WHERE x.transaction_id = t.id) a ON true
       WHERE t.type = 'payment' AND t.account_id IS NOT NULL
         AND t.created_at >= (SELECT MIN(created_at) FROM credit_payment_allocations)
         AND t.amount - COALESCE(a.s, 0) > 0.01
       GROUP BY 1,2),
    f AS (
      SELECT company_id, customer_id, MAX(v) AS v
        FROM (SELECT * FROM f_carne UNION ALL SELECT * FROM f_exato) y
       GROUP BY 1,2),
    g AS (
      SELECT i.company_id, i.customer_id, SUM(a.principal_paid) AS v
        FROM credit_payment_allocations a
        JOIN credit_installments i ON i.id = a.installment_id
       WHERE i.status = 'cancelled'
         AND NOT EXISTS (SELECT 1 FROM credit_installments c
                          WHERE c.company_id = i.company_id AND c.customer_id = i.customer_id
                            AND c.created_at = i.updated_at AND c.id <> i.id)
       GROUP BY 1,2),
    cap AS (
      SELECT company_id, customer_id, SUM(v) AS v
        FROM (SELECT * FROM f UNION ALL SELECT * FROM g) x
       GROUP BY 1,2),
    orfa_resto AS (
      SELECT o.company_id, o.customer_id, SUM(o.aberto) AS v
        FROM t308_orfa o
        JOIN credit_installments i ON i.id = o.installment_id
       WHERE i.status IN ('pending', 'overdue')
       GROUP BY 1,2)
    SELECT cap.company_id, cap.customer_id,
           round(LEAST(cap.v,
                       pg_temp.t308_excesso(cap.company_id, cap.customer_id) - COALESCE(o.v, 0)), 2) AS alocar
      FROM cap
      LEFT JOIN orfa_resto o USING (company_id, customer_id)
     WHERE cap.v > 0.01
  LOOP
    CONTINUE WHEN r.alocar IS NULL OR r.alocar <= 0.01;
    resto := r.alocar;
    FOR inst IN
      SELECT id, amount_due, COALESCE(covered_amount, 0) AS covered_amount
        FROM credit_installments
       WHERE company_id = r.company_id AND customer_id = r.customer_id
         AND status IN ('pending', 'overdue')
         AND id NOT IN (SELECT installment_id FROM t308_orfa)
       ORDER BY due_date ASC, installment_number ASC
       FOR UPDATE
    LOOP
      EXIT WHEN resto <= 0.005;
      cobre := round(LEAST(resto, inst.amount_due - inst.covered_amount), 2);
      CONTINUE WHEN cobre <= 0.005;
      novo := inst.covered_amount + cobre;
      UPDATE credit_installments
         SET covered_amount = novo,
             status  = CASE WHEN novo >= amount_due - 0.005 THEN 'paid' ELSE status END,
             paid_at = CASE WHEN novo >= amount_due - 0.005 THEN NOW() ELSE paid_at END,
             updated_at = NOW(),
             notes = concat_ws(' | ', NULLIF(notes, ''),
                     'Reparo t3-08: pagamento ja recebido que nao tinha abatido parcela')
       WHERE id = inst.id;
      INSERT INTO crediario_reparo_t308 (etapa, company_id, customer_id, installment_id, campo, antes, depois)
      VALUES ('C', r.company_id, r.customer_id, inst.id, 'covered_amount',
              inst.covered_amount::text, novo::text);
      resto := resto - cobre;
    END LOOP;
  END LOOP;
END
$c$;

-- credit_used acompanha o saldo (ledger._updateCreditUsed), como na 367.
UPDATE customer_credit_profiles p
   SET credit_used = GREATEST(0, cb.balance), updated_at = NOW()
  FROM customer_credit_balances cb
 WHERE cb.company_id = p.company_id AND cb.customer_id = p.customer_id
   AND p.credit_used IS DISTINCT FROM GREATEST(0, cb.balance)
   AND EXISTS (SELECT 1 FROM crediario_reparo_t308 r
                WHERE r.company_id = p.company_id AND r.customer_id = p.customer_id
                  AND r.etapa = 'B');

COMMIT;

-- ============================================================
-- Conferencia antes / depois (so leitura). Por loja: clientes com parcela
-- aberta acima do saldo e a soma do excesso.
--
--   WITH i AS (SELECT company_id, customer_id,
--                     SUM(GREATEST(amount_due - covered_amount, 0)) AS aberto
--                FROM credit_installments WHERE status IN ('pending','overdue')
--               GROUP BY 1,2)
--   SELECT co.trade_name, count(*) AS clientes, round(sum(i.aberto - COALESCE(b.balance,0)),2) AS excesso
--     FROM i JOIN companies co ON co.id = i.company_id
--     LEFT JOIN customer_credit_balances b USING (company_id, customer_id)
--    WHERE i.aberto - COALESCE(b.balance,0) > 0.01
--    GROUP BY 1 ORDER BY 3 DESC;
--
-- O que ficou para decidir com a lojista (depois de rodar):
--   SELECT * FROM credit_installments WHERE status IN ('pending','overdue')
--      AND customer_id IN (...)   -- lista do corpo do PR
--
-- Desfazer (caminho de volta), dentro de uma transacao:
--   UPDATE credit_installments i SET status = 'pending', updated_at = NOW()
--     FROM crediario_reparo_t308 r
--    WHERE r.etapa = 'A' AND r.installment_id = i.id AND i.status = 'cancelled';
--   UPDATE customer_credit_transactions t SET amount = r.antes::numeric
--     FROM crediario_reparo_t308 r
--    WHERE r.etapa = 'B' AND r.transaction_id = t.id AND t.amount = r.depois::numeric;
--   UPDATE credit_installments i
--      SET covered_amount = r.antes::numeric,
--          status = CASE WHEN r.antes::numeric >= i.amount_due - 0.005 THEN 'paid' ELSE 'pending' END
--     FROM crediario_reparo_t308 r
--    WHERE r.etapa = 'C' AND r.installment_id = i.id AND i.covered_amount = r.depois::numeric;
--   (depois: o cron de atraso devolve 'overdue' as que venceram)
-- ============================================================
