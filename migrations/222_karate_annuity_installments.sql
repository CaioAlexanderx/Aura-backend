-- ============================================================
-- AURA KARATÊ — Migration 222: Fase F1 do plano de anuidades
-- Modelo de parcelas + planos + recriação das views canônicas
-- ------------------------------------------------------------
-- Contexto de negócio:
--   Planos de DOJÔ: anual 1x R$500 (venc. Mai) / semestral 2x R$280
--   (Mai, Nov) / trimestral 4x R$150 (Fev, Mai, Ago, Nov). Praticante:
--   só faixa-preta paga, 1x R$60 (venc. Mai) — modelo idêntico ao dojô
--   com N=1. Valores/meses vêm de karate_annual_fees (configurável).
--   Vencimento = último dia do mês de vencimento, no ano da temporada.
--
-- O que esta migration faz:
--   a) Cria karate_annuity_installments (as parcelas em si).
--   b) Estende karate_dojo_annuity_history para ser o "header" de
--      QUALQUER anuidade (dojô OU praticante) — dojo_id vira opcional,
--      ganha practitioner_id, CHECK xor.
--   c) Estende karate_annual_fees com plan + due_months; size_tier
--      vira legado (deixa de ser exigido, inclusive para fee_type='dojo').
--   d) BACKFILL idempotente: linhas existentes de dojô viram plan='anual'
--      + 1 parcela; as 3.278 cobranças CPF legadas (transactions
--      category='annuity_cpf') viram header (practitioner_id) + 1 parcela.
--   e) RECRIA karate_dojo_standing e karate_member_standing sobre
--      parcelas, preservando os nomes de coluna existentes e somando
--      valor_em_aberto (tudo não pago) e valor_atrasado (só vencido).
--   f) Cria a view karate_annuities como nome canônico novo (a tabela
--      karate_dojo_annuity_history passa a conter também linhas de
--      praticante — nome antigo fica "mentiroso").
--
-- Idempotente de ponta a ponta (IF NOT EXISTS / DO $$ EXCEPTION / NOT
-- EXISTS nos INSERTs de backfill). Seguro rodar mais de uma vez.
--
-- ⚠️ NÃO ALTERA is_active de ninguém. "suspended" continua sendo
--    RÓTULO derivado em leitura, nunca persistido (só 'pending'/'paid'
--    são persistidos em installments.status).
-- ============================================================

-- ============================================================
-- (a) karate_annuity_installments
-- ============================================================
CREATE TABLE IF NOT EXISTS karate_annuity_installments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  annuity_id     uuid NOT NULL REFERENCES karate_dojo_annuity_history(id) ON DELETE CASCADE,
  federation_id  uuid NOT NULL,
  seq            smallint NOT NULL,
  amount         numeric(12,2) NOT NULL CHECK (amount > 0),
  due_date       date,
  paid_at        timestamptz,
  payment_method text,
  transaction_id uuid REFERENCES transactions(id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'pending',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (annuity_id, seq)
);

DO $$ BEGIN
  ALTER TABLE karate_annuity_installments
    ADD CONSTRAINT karate_annuity_installments_payment_method_check
    CHECK (payment_method IS NULL OR payment_method IN ('pix','dinheiro','transferencia','outro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_annuity_installments
    ADD CONSTRAINT karate_annuity_installments_status_check
    CHECK (status IN ('pending','paid'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_kai_federation_due
  ON karate_annuity_installments (federation_id, due_date);

CREATE INDEX IF NOT EXISTS idx_kai_annuity
  ON karate_annuity_installments (annuity_id);

DROP TRIGGER IF EXISTS trg_karate_annuity_installments_updated_at ON karate_annuity_installments;
CREATE TRIGGER trg_karate_annuity_installments_updated_at
  BEFORE UPDATE ON karate_annuity_installments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- (b) karate_dojo_annuity_history vira header genérico (dojô OU praticante)
-- ============================================================
ALTER TABLE karate_dojo_annuity_history ADD COLUMN IF NOT EXISTS plan text;
DO $$ BEGIN
  ALTER TABLE karate_dojo_annuity_history
    ADD CONSTRAINT karate_dojo_annuity_history_plan_check
    CHECK (plan IS NULL OR plan IN ('anual','semestral','trimestral'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE karate_dojo_annuity_history ADD COLUMN IF NOT EXISTS practitioner_id uuid;
DO $$ BEGIN
  ALTER TABLE karate_dojo_annuity_history
    ADD CONSTRAINT karate_dojo_annuity_history_practitioner_id_fkey
    FOREIGN KEY (practitioner_id) REFERENCES customers(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- dojo_id deixa de ser obrigatório (praticante não tem dojo_id no header).
-- DROP NOT NULL é naturalmente idempotente (no-op se já nullable).
ALTER TABLE karate_dojo_annuity_history ALTER COLUMN dojo_id DROP NOT NULL;

-- Dedupe ANTES dos índices únicos (idempotente — hoje há 0 duplicatas,
-- mas roda sempre; mantém a linha mais recente por created_at/id).
DELETE FROM karate_dojo_annuity_history t
USING karate_dojo_annuity_history t2
WHERE t.dojo_id IS NOT NULL
  AND t2.dojo_id IS NOT NULL
  AND t.dojo_id = t2.dojo_id
  AND t.reference_period = t2.reference_period
  AND t.id <> t2.id
  AND (t.created_at, t.id) < (t2.created_at, t2.id);

DELETE FROM karate_dojo_annuity_history t
USING karate_dojo_annuity_history t2
WHERE t.practitioner_id IS NOT NULL
  AND t2.practitioner_id IS NOT NULL
  AND t.practitioner_id = t2.practitioner_id
  AND t.reference_period = t2.reference_period
  AND t.id <> t2.id
  AND (t.created_at, t.id) < (t2.created_at, t2.id);

-- CHECK xor: exatamente um de dojo_id/practitioner_id preenchido.
DO $$ BEGIN
  ALTER TABLE karate_dojo_annuity_history
    ADD CONSTRAINT karate_dojo_annuity_history_dojo_xor_practitioner_check
    CHECK ((dojo_id IS NULL) <> (practitioner_id IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Índices únicos parciais (substituem qualquer unicidade implícita antiga).
CREATE UNIQUE INDEX IF NOT EXISTS uq_kdah_dojo_period
  ON karate_dojo_annuity_history (dojo_id, reference_period) WHERE dojo_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_kdah_practitioner_period
  ON karate_dojo_annuity_history (practitioner_id, reference_period) WHERE practitioner_id IS NOT NULL;

-- ============================================================
-- (c) karate_annual_fees: plan + due_months; size_tier vira legado
-- ============================================================
ALTER TABLE karate_annual_fees ADD COLUMN IF NOT EXISTS plan text;
DO $$ BEGIN
  ALTER TABLE karate_annual_fees
    ADD CONSTRAINT karate_annual_fees_plan_check
    CHECK (plan IS NULL OR plan IN ('anual','semestral','trimestral'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE karate_annual_fees ADD COLUMN IF NOT EXISTS due_months smallint[];

-- size_tier era obrigatório para fee_type='dojo' (chk_fee_tier). Passa a ser
-- legado/opcional para os dois fee_types — a segmentação de preço agora é
-- por `plan`, não mais por porte do dojô.
ALTER TABLE karate_annual_fees DROP CONSTRAINT IF EXISTS chk_fee_tier;

-- Seed idempotente dos planos canônicos para federações já existentes
-- (não sobrescreve valores já configurados — só preenche o que falta).
INSERT INTO karate_annual_fees (federation_id, fee_type, plan, size_tier, amount, due_months, effective_from)
SELECT c.id, 'dojo', p.plan, NULL, p.amount, p.due_months, CURRENT_DATE
FROM companies c
CROSS JOIN (VALUES
  ('anual',      500.00::numeric, ARRAY[5]::smallint[]),
  ('semestral',  280.00::numeric, ARRAY[5,11]::smallint[]),
  ('trimestral', 150.00::numeric, ARRAY[2,5,8,11]::smallint[])
) AS p(plan, amount, due_months)
WHERE c.vertical = 'karate_federation'
  AND NOT EXISTS (
    SELECT 1 FROM karate_annual_fees f
    WHERE f.federation_id = c.id AND f.fee_type = 'dojo' AND f.plan = p.plan
  );

-- Fee CPF (praticante faixa-preta): plan único 'anual', 1x R$60, venc. Mai.
-- Se já existir uma linha cpf sem plan (legado), completa plan/due_months nela
-- em vez de duplicar.
UPDATE karate_annual_fees
   SET plan = 'anual', due_months = ARRAY[5]::smallint[]
 WHERE fee_type = 'cpf' AND plan IS NULL;

INSERT INTO karate_annual_fees (federation_id, fee_type, plan, size_tier, amount, due_months, effective_from)
SELECT c.id, 'cpf', 'anual', NULL, 60.00, ARRAY[5]::smallint[], CURRENT_DATE
FROM companies c
WHERE c.vertical = 'karate_federation'
  AND NOT EXISTS (
    SELECT 1 FROM karate_annual_fees f
    WHERE f.federation_id = c.id AND f.fee_type = 'cpf' AND f.plan = 'anual'
  );

-- ============================================================
-- (d) BACKFILL — cada header de dojô existente ganha plan='anual' + 1 parcela
-- ============================================================
UPDATE karate_dojo_annuity_history
   SET plan = 'anual'
 WHERE dojo_id IS NOT NULL AND plan IS NULL;

INSERT INTO karate_annuity_installments
  (annuity_id, federation_id, seq, amount, due_date, paid_at, payment_method, transaction_id, status)
SELECT h.id, h.federation_id, 1, h.amount, h.due_date, h.paid_at, h.payment_method, h.transaction_id,
       CASE WHEN h.status = 'paid' THEN 'paid' ELSE 'pending' END
FROM karate_dojo_annuity_history h
WHERE h.dojo_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM karate_annuity_installments i WHERE i.annuity_id = h.id AND i.seq = 1
  );

-- ── BACKFILL — anuidades CPF legadas (transactions category='annuity_cpf') ──
-- Cria 1 header (practitioner_id, plan NULL) + 1 parcela por transaction,
-- ligada à própria transaction. Idempotente via NOT EXISTS no header
-- (dojo_id, reference_period) — aqui (practitioner_id, reference_period).
INSERT INTO karate_dojo_annuity_history
  (dojo_id, federation_id, practitioner_id, reference_period, plan, amount, due_date, paid_at, status, transaction_id, created_at)
SELECT NULL, t.federation_id, t.reference_id,
       EXTRACT(YEAR FROM t.due_date)::text,
       NULL,
       t.amount,
       t.due_date,
       t.paid_at::date,
       CASE WHEN t.status = 'confirmed' OR t.paid_at IS NOT NULL THEN 'paid' ELSE 'pending' END,
       t.id,
       t.created_at
FROM transactions t
WHERE t.category = 'annuity_cpf'
  AND t.status <> 'cancelled'
  AND t.reference_type = 'customer'
  AND NOT EXISTS (
    SELECT 1 FROM karate_dojo_annuity_history h
    WHERE h.practitioner_id = t.reference_id
      AND h.reference_period = EXTRACT(YEAR FROM t.due_date)::text
  );

INSERT INTO karate_annuity_installments
  (annuity_id, federation_id, seq, amount, due_date, paid_at, payment_method, transaction_id, status)
SELECT h.id, h.federation_id, 1, h.amount, h.due_date, h.paid_at, h.payment_method, h.transaction_id,
       CASE WHEN h.status = 'paid' THEN 'paid' ELSE 'pending' END
FROM karate_dojo_annuity_history h
WHERE h.practitioner_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM karate_annuity_installments i WHERE i.annuity_id = h.id AND i.seq = 1
  );

-- ============================================================
-- (f) nome canônico novo — karate_dojo_annuity_history ficou "mentirosa"
-- (também guarda linhas de praticante). Código novo deve preferir esta view.
-- ============================================================
-- DROP+CREATE (nao CREATE OR REPLACE): elimina de vez o 42P16 (nao e possivel
-- mudar tipo de coluna de saida existente via REPLACE) independentemente do
-- tipo/ordem de colunas herdado do ambiente (prod teve views aplicadas via MCP
-- fora do repo, com tipos divergentes do que este arquivo produzia). Atomico
-- dentro da transacao da migration. Confirmado via pg_depend que nenhuma outra
-- view depende de karate_annuities/karate_dojo_standing/karate_member_standing
-- -- sem necessidade de CASCADE. GRANTs sao reemitidos no fim do arquivo porque
-- DROP VIEW descarta as permissoes concedidas antes.
DROP VIEW IF EXISTS karate_annuities;
CREATE VIEW karate_annuities AS
SELECT * FROM karate_dojo_annuity_history;

-- ============================================================
-- (e) RECRIA AS DUAS VIEWS CANÔNICAS sobre parcelas
-- ============================================================
-- karate_dojo_standing — mesmas colunas de saída de hoje (dojo_id,
-- federation_id, nome, is_active, reference_year, annuity_id, paid_amount,
-- paid_at, financeiro) + valor_em_aberto/valor_atrasado novos.
-- Gate preservado: sem cobrança no período → 'sem_cobranca' (neutro, hoje é
-- um bug ausente na view atual — corrigido aqui). Nenhuma parcela vencida em
-- aberto → 'em_dia'. >=1 parcela vencida não paga → 'atrasado'. Todas pagas
-- → 'paid'. Dojô inativo sem cobrança continua 'sem_cobranca' (não gera
-- cobrança, mas não é papel desta view decidir "nao_aplicavel" para dojô —
-- mantém paridade com o comportamento anterior de 'inativo' via is_active).
--
-- ⚠️ Semântica de coluna (checada em review pós-F1 — ver karate_member_standing
-- abaixo para o bug irmão que ESTA view não tinha):
--   paid_amount     = valor já PAGO da anuidade corrente (SUM só das parcelas
--                      com status='paid'). Nome já era coerente com o dado
--                      pré-F1 (1 transaction paga = 1 valor); mantido sem
--                      alteração nesta migration.
--   valor_em_aberto = SUM de todas as parcelas NÃO pagas (vencidas ou não).
--   valor_atrasado  = SUM das parcelas NÃO pagas E já vencidas (due_date <=
--                      CURRENT_DATE).
-- Esta view NÃO expõe "valor total cobrado" (equivalente a annuity_amount de
-- karate_member_standing). Se algum consumidor futuro precisar do total
-- cobrado, adicionar coluna nova explícita — não reaproveitar paid_amount
-- para isso.
--
-- ⚠️ POST-MORTEM (aplicação em 2026-07-11): CREATE OR REPLACE VIEW não permite
-- mudar o tipo de uma coluna de SAÍDA já existente. SUM(numeric(12,2)) no
-- Postgres devolve numeric sem precisão/escala — quebrava paid_amount
-- (42P16). Cast explícito ::numeric(12,2) em toda coluna monetária agregada
-- nas três views, sem exceção.
--
-- ⚠️ POST-MORTEM 3 (CI, mesmo dia): mesmo com os casts acima, o CI (que
-- reconstrói o banco do zero a partir de migrations/*.sql) quebrou de novo
-- com o MESMO 42P16 em annuity_amount — porque essa migration já tinha sido
-- aplicada em produção via Supabase MCP com um cast diferente do que estava
-- neste arquivo (drift entre repo e prod: o tipo "correto" varia por
-- ambiente dependendo do histórico de CREATE OR REPLACE já aplicado nele).
-- Cast coluna-a-coluna não resolve a classe do problema — sempre existe a
-- possibilidade de o ambiente já ter um tipo diferente do que o arquivo
-- produz. A correção definitiva é DROP VIEW IF EXISTS + CREATE VIEW (em vez
-- de CREATE OR REPLACE): sem coluna de saída pré-existente, não há tipo para
-- "mudar" — 42P16 deixa de ser possível independentemente do estado do
-- ambiente. Os dois ambientes (repo/CI e prod) convergem no mesmo tipo
-- (numeric(12,2) em toda coluna monetária, inclusive valor_em_aberto de
-- karate_member_standing, que antes era numeric sem precisão/escala em
-- prod). DROP VIEW descarta GRANTs — reemitidos no fim do arquivo.
DROP VIEW IF EXISTS karate_dojo_standing;
CREATE VIEW karate_dojo_standing AS
SELECT
  c.id AS dojo_id,
  c.federation_id,
  COALESCE(c.trade_name, c.legal_name) AS nome,
  COALESCE(c.is_active, false) AS is_active,
  EXTRACT(year FROM now())::integer AS reference_year,
  h.id AS annuity_id,
  h.paid_amount::numeric(12,2) AS paid_amount,
  h.paid_at,
  CASE
    WHEN h.id IS NULL THEN 'sem_cobranca'
    WHEN h.all_paid THEN 'em_dia'
    WHEN h.overdue_open_count > 0 THEN 'atrasado'
    ELSE 'em_dia'
  END AS financeiro,
  COALESCE(h.valor_em_aberto, 0::numeric)::numeric(12,2) AS valor_em_aberto,
  COALESCE(h.valor_atrasado, 0::numeric)::numeric(12,2) AS valor_atrasado
FROM companies c
LEFT JOIN LATERAL (
  SELECT
    hh.id,
    hh.paid_at,
    SUM(CASE WHEN i.status = 'paid' THEN i.amount ELSE 0 END) AS paid_amount,
    bool_and(i.status = 'paid') AS all_paid,
    COUNT(*) FILTER (WHERE i.status <> 'paid' AND i.due_date IS NOT NULL AND i.due_date <= CURRENT_DATE) AS overdue_open_count,
    SUM(CASE WHEN i.status <> 'paid' THEN i.amount ELSE 0 END) AS valor_em_aberto,
    SUM(CASE WHEN i.status <> 'paid' AND i.due_date IS NOT NULL AND i.due_date <= CURRENT_DATE THEN i.amount ELSE 0 END) AS valor_atrasado
  FROM karate_dojo_annuity_history hh
  JOIN karate_annuity_installments i ON i.annuity_id = hh.id
  WHERE hh.dojo_id = c.id AND hh.reference_period = EXTRACT(year FROM now())::text
  GROUP BY hh.id, hh.paid_at
  ORDER BY (bool_and(i.status = 'paid')) DESC, hh.paid_at DESC NULLS LAST
  LIMIT 1
) h ON true
WHERE c.federation_id IS NOT NULL;

-- karate_member_standing — mesmas colunas de saída de hoje (student_id,
-- federation_id, dojo_id, full_name, karate_registration_number, whatsapp,
-- is_active, belt_level, belt_name, is_black_belt, reference_year,
-- annuity_tx_id, annuity_amount, annuity_due_date, annuity_paid, financeiro,
-- valor_em_aberto) + valor_atrasado e annuity_paid_amount novos. Gates
-- preservados: faixa != preta ou inativo → 'nao_aplicavel' (e valor 0 nos
-- dois campos); sem cobrança no período → 'sem_cobranca'; todas as parcelas
-- pagas → 'em_dia'; >=1 parcela vencida não paga → 'atrasado' (parcela
-- futura NÃO torna ninguém atrasado).
--
-- ⚠️ Semântica de coluna (não confiar no nome sem ler isto — bug pego em
-- review antes de aplicar a migration):
--   annuity_amount      = valor TOTAL COBRADO da anuidade na temporada (SUM
--                          de TODAS as parcelas, pagas ou não). Pré-F1 já
--                          significava isto (1 transaction = 1 valor
--                          cobrado); PRESERVADO propositalmente.
--   annuity_paid_amount = valor já PAGO na temporada (SUM só das parcelas
--                          com status='paid'). Coluna NOVA desta migration.
--                          Um rascunho anterior desta view redefiniu
--                          acidentalmente "annuity_amount" para este
--                          significado (preta inadimplente => annuity_amount
--                          = 0), o que teria armadilhado qualquer consumidor
--                          futuro que confiasse no nome antigo. Corrigido
--                          antes de aplicar. Confirmado via grep que, até
--                          esta migration, nenhuma rota de backend nem tela
--                          do frontend lê annuity_amount ou
--                          annuity_paid_amount desta view — sem consumidor
--                          quebrado pela correção.
--
-- ⚠️ POST-MORTEM 2: a primeira versão desta view inseria
-- annuity_paid_amount NO MEIO da lista de colunas (entre annuity_amount e
-- annuity_due_date). CREATE OR REPLACE VIEW exige mesmo nome/ordem/tipo
-- para toda coluna já existente — só pode ANEXAR colunas novas no fim.
-- Isso deslocava annuity_due_date/annuity_paid/financeiro/valor_em_aberto
-- uma posição, o que teria quebrado a migration de novo (nome/tipo
-- incompatível) logo após corrigir o erro original de paid_amount.
-- Corrigido: annuity_paid_amount movida para o fim da lista, junto com
-- valor_atrasado; ordem das colunas pré-existentes preservada.
--   valor_em_aberto      = SUM de parcelas NÃO pagas (vencidas ou não).
--   valor_atrasado       = SUM de parcelas NÃO pagas E já vencidas (due_date
--                          <= CURRENT_DATE).
DROP VIEW IF EXISTS karate_member_standing;
CREATE VIEW karate_member_standing AS
SELECT
  c.id AS student_id,
  c.federation_id,
  c.dojo_id,
  c.name AS full_name,
  c.karate_registration_number,
  c.phone AS whatsapp,
  COALESCE(c.is_active, true) AS is_active,
  cb.belt_level,
  cb.belt_name,
  cb.belt_level = 'preta'::text AS is_black_belt,
  EXTRACT(year FROM now())::integer AS reference_year,
  fin.tx_id AS annuity_tx_id,
  fin.amount::numeric(12,2) AS annuity_amount,
  fin.due_date AS annuity_due_date,
  fin.paid AS annuity_paid,
  CASE
    WHEN cb.belt_level <> 'preta'::text THEN 'nao_aplicavel'::text
    WHEN NOT COALESCE(c.is_active, true) THEN 'nao_aplicavel'::text
    WHEN fin.tx_id IS NULL THEN 'sem_cobranca'::text
    WHEN fin.paid THEN 'em_dia'::text
    WHEN fin.overdue_open_count > 0 THEN 'atrasado'::text
    ELSE 'em_dia'::text
  END AS financeiro,
  (CASE
    WHEN cb.belt_level = 'preta'::text AND COALESCE(c.is_active, true)
         AND fin.tx_id IS NOT NULL THEN COALESCE(fin.valor_em_aberto, 0::numeric)
    ELSE 0::numeric
  END)::numeric(12,2) AS valor_em_aberto,
  fin.paid_amount::numeric(12,2) AS annuity_paid_amount,
  (CASE
    WHEN cb.belt_level = 'preta'::text AND COALESCE(c.is_active, true)
         AND fin.tx_id IS NOT NULL THEN COALESCE(fin.valor_atrasado, 0::numeric)
    ELSE 0::numeric
  END)::numeric(12,2) AS valor_atrasado
FROM customers c
JOIN karate_current_belt cb ON cb.student_id = c.id
LEFT JOIN LATERAL (
  SELECT
    hh.id AS tx_id,
    SUM(i.amount) AS amount,
    SUM(CASE WHEN i.status = 'paid' THEN i.amount ELSE 0 END) AS paid_amount,
    MIN(i.due_date) AS due_date,
    bool_and(i.status = 'paid') AS paid,
    COUNT(*) FILTER (WHERE i.status <> 'paid' AND i.due_date IS NOT NULL AND i.due_date <= CURRENT_DATE) AS overdue_open_count,
    SUM(CASE WHEN i.status <> 'paid' THEN i.amount ELSE 0 END) AS valor_em_aberto,
    SUM(CASE WHEN i.status <> 'paid' AND i.due_date IS NOT NULL AND i.due_date <= CURRENT_DATE THEN i.amount ELSE 0 END) AS valor_atrasado
  FROM karate_dojo_annuity_history hh
  JOIN karate_annuity_installments i ON i.annuity_id = hh.id
  WHERE hh.practitioner_id = c.id
    AND hh.reference_period = EXTRACT(year FROM now())::text
  GROUP BY hh.id
  ORDER BY (bool_and(i.status = 'paid')) DESC, MIN(i.due_date) DESC NULLS LAST
  LIMIT 1
) fin ON true;

-- ============================================================
-- GRANTs -- reemitidos porque DROP VIEW descarta permissoes concedidas antes.
-- Confirmado em producao (information_schema.role_table_grants) que as tres
-- views tinham GRANT ALL (SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/
-- TRIGGER) para anon, authenticated, service_role e postgres (owner).
--
-- Condicional por role (pg_roles): em producao (Supabase) esses roles
-- existem e os GRANTs sao aplicados; no CI (container postgres:16 generico,
-- sem stack Supabase) nenhum desses roles existe -- GRANT direto para um
-- role inexistente e erro fatal (42704), quebraria a migration do zero.
-- Idempotente: GRANT pode ser reemitido sem problema.
-- ============================================================
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'postgres'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT ALL ON TABLE karate_annuities TO %I', r);
      EXECUTE format('GRANT ALL ON TABLE karate_dojo_standing TO %I', r);
      EXECUTE format('GRANT ALL ON TABLE karate_member_standing TO %I', r);
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- FIM DA MIGRATION 222
-- ============================================================
