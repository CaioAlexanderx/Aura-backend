-- ============================================================
-- AURA — F5: vincula o cliente das vendas do Studio que ficaram orfas
-- 17/08/2026
--
-- O PDV do Studio mandava o nome do CLIENTE em `seller_name` (o campo do
-- VENDEDOR) e nunca preenchia customer_id. Corrigido daqui pra frente em
-- routes/pdv.js (resolveInlineCustomer). Esta migration cuida do que ja
-- estava gravado.
--
-- ESCOPO: SO empresas com vertical_active = 'studio'.
--
-- Isso e o coracao da migration, nao um detalhe. Nas empresas do varejo o
-- `seller_name` e o nome do VENDEDOR de verdade -- e o proposito do campo.
-- Um levantamento antes desta migration mostrou 381 vendas com seller_name
-- e customer_id nulo na base inteira, das quais 58 "casariam" com algum
-- cliente em empresas NAO-Studio. Vincular aquelas ligaria a venda ao
-- vendedor como se fosse o cliente, corrompendo dado que hoje esta certo.
-- O bug e exclusivo do useStudioCheckout.ts, entao o reparo tambem e.
--
-- CONSERVADOR de proposito: so vincula quando ha UM unico cliente
-- candidato na mesma empresa. Nada e criado -- se o cliente nao existe no
-- cadastro, a venda fica como esta. Criar cadastro so com nome (sem
-- telefone nem CPF) geraria registros que o find-or-create nao acha
-- depois, virando duplicata na proxima venda da mesma pessoa.
--
-- Match, nesta ordem:
--   1. nome normalizado identico (minusculas, espacos colapsados)
--   2. nome do cliente COMECA com o seller_name + espaco
--      ("Maria" -> "Maria Silva"), so quando ha exatamente um
--
-- seller_name e limpo nas linhas vinculadas: aquele nome nunca foi de um
-- vendedor, e mante-lo faria a tela de Vendas exibir o cliente no titulo E
-- na posicao de quem vendeu.
--
-- Idempotente: so toca linhas com customer_id IS NULL. Rodar de novo e
-- no-op. Nao apaga nem cria nada -- so preenche vinculo.
--
-- Efeito colateral esperado: o trigger trg_sale_update_customer
-- (migration 137) recalcula total_purchases/total_spent dos clientes
-- vinculados. E o comportamento correto -- a compra sempre foi deles.
-- ============================================================

WITH orfas AS (
  SELECT s.id AS sale_id, s.company_id,
         REGEXP_REPLACE(LOWER(TRIM(s.seller_name)), '\s+', ' ', 'g') AS nome
    FROM sales s
    JOIN companies co ON co.id = s.company_id
   WHERE s.customer_id IS NULL
     AND NULLIF(TRIM(s.seller_name), '') IS NOT NULL
     AND COALESCE(s.status, 'completed') <> 'cancelled'
     AND co.vertical_active = 'studio'
),
candidatos AS (
  SELECT o.sale_id,
         (SELECT ARRAY_AGG(c.id) FROM customers c
           WHERE c.company_id = o.company_id AND c.name IS NOT NULL
             AND REGEXP_REPLACE(LOWER(TRIM(c.name)), '\s+', ' ', 'g') = o.nome) AS ids_exato,
         (SELECT ARRAY_AGG(c.id) FROM customers c
           WHERE c.company_id = o.company_id AND c.name IS NOT NULL
             AND REGEXP_REPLACE(LOWER(TRIM(c.name)), '\s+', ' ', 'g') LIKE o.nome || ' %') AS ids_prefixo
    FROM orfas o
),
resolvidos AS (
  SELECT sale_id, COALESCE(ids_exato[1], ids_prefixo[1]) AS customer_id
    FROM candidatos
   WHERE COALESCE(ARRAY_LENGTH(ids_exato, 1), 0) = 1
      OR (COALESCE(ARRAY_LENGTH(ids_exato, 1), 0) = 0
          AND COALESCE(ARRAY_LENGTH(ids_prefixo, 1), 0) = 1)
)
UPDATE sales s
   SET customer_id = r.customer_id,
       seller_name = NULL,
       updated_at  = NOW()
  FROM resolvidos r
 WHERE s.id = r.sale_id
   AND s.customer_id IS NULL;
