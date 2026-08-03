-- ============================================================
-- AURA. — Migration 267: Credito Livre (leads de crediario quitado)
-- ============================================================
-- Fase 1 do epico "Credito Livre": lista de clientes que ja compraram
-- no crediario e hoje estao com saldo zero, para virar lead de venda.
--
-- Mudancas:
--   1. coupons              : RECONCILIACAO de schema (ver NOTA 1)
--   2. coupons_source_check : + 'credit_lead'
--   3. credit_lead_contacts : NEW — log de contato com o lead
--
-- ------------------------------------------------------------
-- NOTA 1 — por que a parte de reconciliacao existe
-- ------------------------------------------------------------
-- A migration 065 cria `coupons` com as colunas `valid_from`,
-- `valid_until`, `uses_count` e `max_discount`. Mas o codigo em
-- producao (src/routes/coupons.js, src/routes/birthday.js) usa
-- `expires_at` e `current_uses` — e NENHUMA migration cria essas duas.
--
-- Conferido no banco de producao em 02/08/2026: a tabela real tem
-- expires_at + current_uses e NAO tem valid_until/uses_count. Ou seja,
-- `coupons` ja existia antes da 065 (criada fora do versionamento), o
-- CREATE TABLE IF NOT EXISTS da 065 virou no-op la, e so os ALTERs dela
-- pegaram (customer_id, source, constraint).
--
-- Efeito pratico: num banco LIMPO (CI), a 065 cria a tabela na forma
-- ERRADA e coupons.js/birthday.js quebram com 42703 na primeira query.
-- Esta migration fecha essa divergencia nos dois sentidos: adiciona o
-- que falta e migra o dado das colunas legadas, se existirem.
--
-- Colunas legadas NAO sao removidas de proposito — em prod elas nao
-- existem (nada a fazer) e num banco limpo remove-las seria destrutivo
-- sem ganho. Ficam orfas e inofensivas (nullable ou com default).
--
-- ------------------------------------------------------------
-- NOTA 2 — chave de idempotencia do log de contato
-- ------------------------------------------------------------
-- birthday_messages_sent usa UNIQUE (company_id, customer_id,
-- birthday_year), porque aniversario tem um ciclo anual obvio. Aqui nao
-- existe analogo: o cliente pode quitar um segundo carne a qualquer
-- momento e deve poder ser contatado de novo.
--
-- Decisao: trava por DIA (contact_day). Isso (a) impede log duplicado de
-- duplo-clique, (b) permite recontato no dia seguinte, (c) nao precisa
-- inventar um conceito de "ciclo de quitacao" que o schema nao tem.
-- Consistente com a decisao de produto de NAO remover da fila quem ja
-- foi contatado — a lista mostra o marcador, nao esconde a linha.
--
-- Padrao idempotente: IF NOT EXISTS / DROP-then-ADD em constraint.
-- ============================================================

-- ------------------------------------------------------------
-- 1. coupons — reconciliacao de schema
-- ------------------------------------------------------------
ALTER TABLE coupons
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL;

ALTER TABLE coupons
  ADD COLUMN IF NOT EXISTS current_uses INT NOT NULL DEFAULT 0;

-- Migra dado das colunas legadas quando elas existirem (caso banco limpo
-- que rodou a 065). Em producao este bloco e no-op: as colunas nao existem.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'coupons'
      AND column_name = 'valid_until'
  ) THEN
    EXECUTE 'UPDATE coupons SET expires_at = valid_until
             WHERE expires_at IS NULL AND valid_until IS NOT NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'coupons'
      AND column_name = 'uses_count'
  ) THEN
    EXECUTE 'UPDATE coupons SET current_uses = uses_count
             WHERE COALESCE(current_uses, 0) = 0 AND COALESCE(uses_count, 0) <> 0';
    -- Solta o NOT NULL da legada pra nao travar INSERT do codigo atual,
    -- que nao menciona essa coluna.
    EXECUTE 'ALTER TABLE coupons ALTER COLUMN uses_count DROP NOT NULL';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_coupons_expires_at
  ON coupons(expires_at) WHERE expires_at IS NOT NULL;

-- ------------------------------------------------------------
-- 2. coupons.source — nova origem 'credit_lead'
-- ------------------------------------------------------------
ALTER TABLE coupons
  DROP CONSTRAINT IF EXISTS coupons_source_check;

ALTER TABLE coupons
  ADD CONSTRAINT coupons_source_check
  CHECK (source IN ('manual', 'birthday', 'campaign', 'reactivation', 'credit_lead'));

-- ------------------------------------------------------------
-- 3. credit_lead_contacts — log de contato com o lead
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_lead_contacts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  coupon_id    UUID NULL     REFERENCES coupons(id)   ON DELETE SET NULL,
  method       TEXT NOT NULL DEFAULT 'wa_link',
  user_id      UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  message      TEXT NULL,
  -- Foto do lead no momento do contato: permite medir depois sem
  -- reconstruir o passado (o saldo do cliente muda quando ele recompra).
  balance_at_contact       NUMERIC(12,2) NULL,
  total_debited_at_contact NUMERIC(12,2) NULL,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Dia em SP — base da trava de idempotencia (ver NOTA 2)
  contact_day  DATE NOT NULL DEFAULT ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date)
);

ALTER TABLE credit_lead_contacts
  DROP CONSTRAINT IF EXISTS credit_lead_contacts_method_check;

ALTER TABLE credit_lead_contacts
  ADD CONSTRAINT credit_lead_contacts_method_check
  CHECK (method IN ('wa_link', 'wa_api', 'sms', 'email'));

-- Trava de duplo-clique: um log por cliente por dia.
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_lead_contact_per_day
  ON credit_lead_contacts(company_id, customer_id, contact_day);

-- Lookup "quando falei com esse cliente pela ultima vez" (usado na lista)
CREATE INDEX IF NOT EXISTS idx_credit_lead_contacts_lookup
  ON credit_lead_contacts(company_id, customer_id, sent_at DESC);

-- ------------------------------------------------------------
-- NOTA 3 — por que NAO tem indice pro predicado "saldo zerado"
-- ------------------------------------------------------------
-- customer_credit_balances e uma VIEW agregadora (GROUP BY sobre
-- customer_credit_transactions). Nao da pra indexar um predicado sobre
-- agregado de view — e nao e preciso: o EXPLAIN em producao (02/08/2026)
-- mostra o planner empurrando o filtro de company_id para dentro da view
-- e usando idx_credit_tx_company, com a agregacao ja restrita a empresa.
-- 14ms para a maior empresa da base. O custo escala com transacoes POR
-- EMPRESA, exatamente como a rota de carteira que ja esta no ar — esta
-- feature nao introduz classe nova de custo.
-- ============================================================
