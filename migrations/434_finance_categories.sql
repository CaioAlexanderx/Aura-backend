-- ============================================================
-- 434 — Categorias e subcategorias do Financeiro
--
-- Criado: 09/11/2026 (aprovado pelo Caio; mockup
-- mockup-categorias-financeiro.html, secoes A a E)
--
-- Ate hoje a categoria de um lancamento era so texto
-- (transactions.category) escolhido numa lista fixa do app. Agora cada loja
-- tem as proprias categorias, com subcategorias (2 niveis no maximo).
--
-- SO ADITIVA. Nada aqui reescreve lancamento:
--   - transactions.category CONTINUA guardando o nome da categoria-MAE.
--     Tudo que casa por nome (Vendas, Taxas de cartao, Crediario%A Receber%,
--     fornecedores/troca/devolucao do resultado do periodo) segue igual.
--   - transactions.category_id nasce NULL. Quem liga os lancamentos antigos
--     e o script scripts/migrar-categorias-financeiro.js (dry-run por padrao),
--     quando o Caio decidir.
--   - As categorias padrao sao semeadas pelo backend na primeira leitura de
--     cada empresa (src/services/financeCategories.js), nao aqui.
--
-- Desenho copiado de product_categories (257/318): unico entre irmaos por
-- name_norm. Diferencas: name_norm tira acento (o "Servicos" antigo casa com
-- "Servicos" com cedilha), e o indice vale so entre as NAO arquivadas
-- (arquivar libera o nome).
--
-- dre_line substitui o dre_category_map (0 linhas em producao). O /dre
-- antigo (src/routes/dre.js) e codigo morto e nao foi tocado.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS unaccent;

-- Normalizacao canonica do nome: sem acento, minusculas, espacos colapsados.
-- STABLE porque unaccent() e STABLE (mesma ressalva da category_slugify, 257).
-- O espelho em JS e normalizarNome() em src/services/financeCategories.js.
CREATE OR REPLACE FUNCTION finance_category_norm(p_name text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT lower(regexp_replace(unaccent(btrim(coalesce(p_name, ''))), '\s+', ' ', 'g'));
$$;

CREATE TABLE IF NOT EXISTS finance_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('income', 'expense')),
  parent_id   uuid REFERENCES finance_categories(id) ON DELETE RESTRICT,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  name_norm   text NOT NULL,
  color       text,
  dre_line    text,
  is_system   boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT NOW(),
  updated_at  timestamptz NOT NULL DEFAULT NOW()
);

-- Unico entre irmaos (mesma loja, mesmo tipo, mesmo pai), so entre as nao
-- arquivadas. COALESCE no parent_id: NULLs sao distintos em indice unico.
CREATE UNIQUE INDEX IF NOT EXISTS finance_categories_unique_sibling
  ON finance_categories (
    company_id,
    kind,
    COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    name_norm
  )
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS finance_categories_company_idx
  ON finance_categories (company_id, kind, parent_id, sort_order);

-- name_norm e updated_at pelo gatilho (unaccent nao pode em coluna gerada) e
-- a trava de 2 niveis: o pai tem que ser de primeiro nivel, da mesma loja e
-- do mesmo tipo.
CREATE OR REPLACE FUNCTION finance_categories_before_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  pai finance_categories%ROWTYPE;
BEGIN
  NEW.name := regexp_replace(btrim(NEW.name), '\s+', ' ', 'g');
  NEW.name_norm := finance_category_norm(NEW.name);
  NEW.updated_at := NOW();
  IF NEW.parent_id IS NOT NULL THEN
    IF NEW.parent_id = NEW.id THEN
      RAISE EXCEPTION 'finance_categories: categoria nao pode ser pai dela mesma'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO pai FROM finance_categories WHERE id = NEW.parent_id;
    IF NOT FOUND OR pai.parent_id IS NOT NULL OR pai.company_id <> NEW.company_id OR pai.kind <> NEW.kind THEN
      RAISE EXCEPTION 'finance_categories: subcategoria so vale sob uma categoria de primeiro nivel da mesma loja e do mesmo tipo'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS finance_categories_before_write ON finance_categories;
CREATE TRIGGER finance_categories_before_write
  BEFORE INSERT OR UPDATE ON finance_categories
  FOR EACH ROW EXECUTE FUNCTION finance_categories_before_write();

-- Ligacao do lancamento com a categoria ou subcategoria escolhida. Nulavel:
-- lancamento antigo e lancamento gravado fora do app (Caixa, crediario,
-- importacao, IA) seguem so com o texto ate o script ligar.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES finance_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS transactions_company_category_id_idx
  ON transactions (company_id, category_id)
  WHERE category_id IS NOT NULL;
