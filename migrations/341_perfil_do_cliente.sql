-- ============================================================
-- 341 — Perfil do cliente (Fase 1 do CRM de varejo)
--
-- Contexto (16/09/2026): a ficha do cliente deixa de ser uma linha e vira
-- uma tela 360º com linha do tempo. Entram tags, preferências, datas
-- importantes, notas e a mesclagem de cadastros duplicados.
--
-- O QUE ESTA MIGRATION FAZ
--   1. customers.tags            text[]  + índice GIN (filtro por tag)
--   2. customers.preferences     jsonb   objeto de chaves livres. Uso
--      previsto: tamanho, numeracao, marcas (array), estilo, observacoes
--   3. customers.important_dates jsonb   array de {label, date}
--   4. customers.phone_e164      text    telefone só com dígitos e DDI 55,
--      mantido por trigger a partir de customers.phone + backfill
--   5. customers.merged_into_id  uuid    cadastro mesclado aponta para o
--      sobrevivente (e fica is_active = false)
--   6. customer_notes                    notas da ficha (manuais e as
--      automáticas da mesclagem)
--
-- Não havia tabela equivalente a customer_notes: customers.notes é um campo
-- único de texto (continua existindo), company_admin_notes é do painel
-- interno da Aura e dental_* é prontuário.
--
-- REGRA DO TELEFONE (public.aura_phone_e164_br — espelho exato de
-- src/utils/phone.js; o teste de paridade roda os dois sobre a mesma lista)
--   a. fica só com os dígitos; vazio -> NULL
--   b. prefixo internacional "00" é removido e o resto precisa começar
--      com 55; prefixo de tronco "0" é removido e, se sobrarem 12 ou 13
--      dígitos, os 2 primeiros são o código da operadora (0 XX DDD número)
--   c. 12 ou 13 dígitos começando com 55 -> tira o DDI
--   d. sobra DDD (2 dígitos, nenhum deles 0) + número de 8 ou 9 dígitos;
--      qualquer outro tamanho -> NULL (número estrangeiro ou lixo)
--   e. NONO DÍGITO: número de 9 dígitos precisa começar com 9 (celular).
--      Número de 8 dígitos começando com 6, 7, 8 ou 9 é celular no formato
--      antigo (antes da migração do nono dígito, concluída em 2016) e
--      GANHA o 9 na frente. 8 dígitos começando com 2, 3, 4 ou 5 é fixo
--      e fica como está. 8 dígitos começando com 0 ou 1 -> NULL.
--   f. resultado: 55 + DDD + número (12 dígitos fixo, 13 celular)
--
-- BACKFILL: UPDATE ... WHERE phone_e164 IS NULL — idempotente, seguro para
-- reexecução e no-op numa tabela vazia (CI). O UPDATE dispara os triggers
-- existentes de customers (set_updated_at bumpa updated_at; o espelho
-- odonto da 069 reescreve os mesmos valores em dental_patients) — nenhum
-- dos dois muda dado de negócio.
--
-- Idempotente: IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS e
-- blocos DO com EXCEPTION para constraints.
-- ============================================================

-- ── 1-5. Colunas novas em customers ─────────────────────────
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tags            TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS preferences     JSONB  NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS important_dates JSONB  NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_e164      TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS merged_into_id  UUID NULL
  REFERENCES customers(id) ON DELETE SET NULL;

DO $$ BEGIN
  ALTER TABLE customers ADD CONSTRAINT customers_preferences_is_object
    CHECK (jsonb_typeof(preferences) = 'object');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE customers ADD CONSTRAINT customers_important_dates_is_array
    CHECK (jsonb_typeof(important_dates) = 'array');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE customers ADD CONSTRAINT customers_merged_into_not_self
    CHECK (merged_into_id IS NULL OR merged_into_id <> id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_customers_tags
  ON customers USING GIN (tags);

CREATE INDEX IF NOT EXISTS idx_customers_phone_e164
  ON customers (company_id, phone_e164)
  WHERE phone_e164 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_merged_into
  ON customers (merged_into_id)
  WHERE merged_into_id IS NOT NULL;

COMMENT ON COLUMN customers.tags IS
  'Etiquetas livres da ficha (Fase 1 CRM, migration 341). Filtro via índice GIN.';
COMMENT ON COLUMN customers.preferences IS
  'Preferências de compra, chaves livres: tamanho, numeracao, marcas (array), estilo, observacoes (migration 341).';
COMMENT ON COLUMN customers.important_dates IS
  'Datas importantes além do aniversário: array de {label, date} (migration 341).';
COMMENT ON COLUMN customers.phone_e164 IS
  'Telefone normalizado: só dígitos, DDI 55, regra do nono dígito. Mantido por trigger a partir de phone (migration 341).';
COMMENT ON COLUMN customers.merged_into_id IS
  'Cadastro mesclado: aponta para o cliente sobrevivente. O mesclado fica is_active = false (migration 341).';

-- ── 4a. Normalizador de telefone (espelho de src/utils/phone.js) ──
CREATE OR REPLACE FUNCTION public.aura_phone_e164_br(raw TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $fn$
DECLARE
  d   TEXT;
  ddd TEXT;
  num TEXT;
BEGIN
  IF raw IS NULL THEN
    RETURN NULL;
  END IF;

  d := regexp_replace(raw, '[^0-9]', '', 'g');
  IF d = '' THEN
    RETURN NULL;
  END IF;

  IF left(d, 2) = '00' THEN
    -- prefixo internacional: só aceita Brasil
    d := substr(d, 3);
    IF left(d, 2) <> '55' THEN
      RETURN NULL;
    END IF;
  ELSIF left(d, 1) = '0' THEN
    -- prefixo de tronco; 0 + operadora (2) + DDD + número
    d := substr(d, 2);
    IF length(d) IN (12, 13) THEN
      d := substr(d, 3);
    END IF;
  END IF;

  IF length(d) IN (12, 13) AND left(d, 2) = '55' THEN
    d := substr(d, 3);
  END IF;

  IF length(d) NOT IN (10, 11) THEN
    RETURN NULL;
  END IF;

  ddd := left(d, 2);
  num := substr(d, 3);

  IF ddd !~ '^[1-9][1-9]$' THEN
    RETURN NULL;
  END IF;

  IF length(num) = 9 THEN
    IF left(num, 1) <> '9' THEN
      RETURN NULL;
    END IF;
  ELSIF left(num, 1) IN ('6', '7', '8', '9') THEN
    num := '9' || num;          -- nono dígito
  ELSIF left(num, 1) NOT IN ('2', '3', '4', '5') THEN
    RETURN NULL;
  END IF;

  RETURN '55' || ddd || num;
END
$fn$;

COMMENT ON FUNCTION public.aura_phone_e164_br(TEXT) IS
  'Normaliza telefone brasileiro para 55+DDD+número com a regra do nono dígito. Espelho de src/utils/phone.js (migration 341).';

-- ── 4b. Trigger: phone_e164 acompanha phone em qualquer caminho de escrita
-- (cadastro, PDV relâmpago, pedido digital, importação, karatê...).
CREATE OR REPLACE FUNCTION public.customers_sync_phone_e164()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.phone_e164 := public.aura_phone_e164_br(NEW.phone);
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_customers_phone_e164 ON customers;
CREATE TRIGGER trg_customers_phone_e164
  BEFORE INSERT OR UPDATE OF phone ON customers
  FOR EACH ROW
  EXECUTE FUNCTION public.customers_sync_phone_e164();

-- ── 4c. Backfill (idempotente; no-op em tabela vazia) ────────
DO $$
DECLARE
  v_rows BIGINT;
BEGIN
  UPDATE customers
     SET phone_e164 = public.aura_phone_e164_br(phone)
   WHERE phone_e164 IS NULL
     AND phone IS NOT NULL
     AND public.aura_phone_e164_br(phone) IS NOT NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE '[migration 341] backfill phone_e164: % clientes', v_rows;
END
$$;

-- ── 6. customer_notes ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  author_id   UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  -- 'manual' = escrita na ficha; 'merge' = gravada pela mesclagem (auditoria,
  -- não pode ser apagada pela rota)
  kind        TEXT NOT NULL DEFAULT 'manual',
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE customer_notes ADD CONSTRAINT customer_notes_kind_check
    CHECK (kind IN ('manual', 'merge'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE customer_notes ADD CONSTRAINT customer_notes_body_check
    CHECK (length(btrim(body)) > 0 AND length(body) <= 5000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_customer_notes_customer
  ON customer_notes (company_id, customer_id, created_at DESC);

ALTER TABLE customer_notes ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE customer_notes IS
  'Notas da ficha do cliente, exibidas na linha do tempo (migration 341). kind=merge é a nota automática da mesclagem.';
