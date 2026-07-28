-- 259_categories_triggers
-- F0 Loja Digital v2 - Bloco A
-- Cinco triggers. Ordem de disparo em BEFORE e alfabetica pelo nome do trigger:
-- trg_category_cycle_check (c) roda ANTES de trg_category_path_maintain (p).
-- Isso e proposital: validar ciclo antes de tentar montar path evita recursao infinita.

-- ============================================================
-- (b) CICLO - roda primeiro
-- ============================================================
CREATE OR REPLACE FUNCTION category_cycle_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_id uuid := NEW.parent_id;
BEGIN
  WHILE v_id IS NOT NULL LOOP
    IF v_id = NEW.id THEN
      RAISE EXCEPTION 'CATEGORY_CYCLE';
    END IF;
    SELECT parent_id INTO v_id FROM product_categories WHERE id = v_id;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_category_cycle_check ON product_categories;
CREATE TRIGGER trg_category_cycle_check
  BEFORE UPDATE OF parent_id ON product_categories
  FOR EACH ROW EXECUTE FUNCTION category_cycle_check();

-- ============================================================
-- (a) SLUG / PATH / DEPTH / TYPE - roda depois do ciclo
-- ============================================================
CREATE OR REPLACE FUNCTION category_path_maintain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_parent_path  text := '';
  v_parent_depth smallint := -1;
  v_parent_type  text;
  v_base text;
  v_slug text;
  v_n int := 1;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    SELECT path, depth, type
      INTO v_parent_path, v_parent_depth, v_parent_type
      FROM product_categories WHERE id = NEW.parent_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'CATEGORY_PARENT_NOT_FOUND';
    END IF;

    -- filho de um type nunca pende de pai de outro type
    IF v_parent_type IS DISTINCT FROM NEW.type THEN
      RAISE EXCEPTION 'CATEGORY_TYPE_MISMATCH';
    END IF;

    NEW.depth := (v_parent_depth + 1)::smallint;
  ELSE
    NEW.depth := 0;
    v_parent_path := '';
  END IF;

  v_base := category_slugify(NEW.name);
  IF v_base IS NULL OR v_base = '' THEN
    v_base := 'categoria';
  END IF;

  -- sufixo numerico em colisao de slug entre irmaos do mesmo type
  v_slug := v_base;
  WHILE EXISTS (
    SELECT 1 FROM product_categories
     WHERE company_id = NEW.company_id
       AND type = NEW.type
       AND COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)
           = COALESCE(NEW.parent_id, '00000000-0000-0000-0000-000000000000'::uuid)
       AND slug = v_slug
       AND id IS DISTINCT FROM NEW.id
  ) LOOP
    v_n := v_n + 1;
    v_slug := v_base || '-' || v_n;
  END LOOP;

  NEW.slug := v_slug;
  NEW.path := v_parent_path || '/' || v_slug;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_category_path_maintain ON product_categories;
CREATE TRIGGER trg_category_path_maintain
  BEFORE INSERT OR UPDATE OF name, parent_id ON product_categories
  FOR EACH ROW EXECUTE FUNCTION category_path_maintain();

-- cascata nos descendentes quando o path do no muda.
-- Sem LIKE: '_' e curinga e slug pode conter underscore.
CREATE OR REPLACE FUNCTION category_path_cascade() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.path IS DISTINCT FROM OLD.path THEN
    UPDATE product_categories c
       SET path  = NEW.path || substring(c.path from length(OLD.path) + 1),
           depth = (c.depth + (NEW.depth - OLD.depth))::smallint
     WHERE c.company_id = NEW.company_id
       AND c.type = NEW.type
       AND c.id <> NEW.id
       AND left(c.path, length(OLD.path) + 1) = OLD.path || '/';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_category_path_cascade ON product_categories;
CREATE TRIGGER trg_category_path_cascade
  AFTER UPDATE OF name, parent_id ON product_categories
  FOR EACH ROW EXECUTE FUNCTION category_path_cascade();

-- ============================================================
-- (c) GUARD MULTI-TENANT no link
-- Nao da para expressar via FK: a tabela cruza duas entidades.
-- ============================================================
CREATE OR REPLACE FUNCTION link_tenant_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_prod uuid; v_cat uuid;
BEGIN
  SELECT company_id INTO v_prod FROM products WHERE id = NEW.product_id;
  SELECT company_id INTO v_cat  FROM product_categories WHERE id = NEW.category_id;
  IF v_prod IS NULL OR v_cat IS NULL OR v_prod <> v_cat THEN
    RAISE EXCEPTION 'CATEGORY_CROSS_TENANT';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_link_tenant_guard ON product_category_links;
CREATE TRIGGER trg_link_tenant_guard
  BEFORE INSERT OR UPDATE ON product_category_links
  FOR EACH ROW EXECUTE FUNCTION link_tenant_guard();

-- ============================================================
-- (d) DUAL-WRITE em products.category - tres gatilhos
-- Regra explicita: ausencia de primaria = ausencia de categoria.
-- ============================================================
CREATE OR REPLACE FUNCTION sync_legacy_category_from_link() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_primary THEN
      UPDATE products SET category = NULL, updated_at = now()
       WHERE id = OLD.product_id;
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.is_primary THEN
    UPDATE products p
       SET category = c.name, updated_at = now()
      FROM product_categories c
     WHERE p.id = NEW.product_id AND c.id = NEW.category_id;
  ELSIF TG_OP = 'UPDATE' AND OLD.is_primary AND NOT NEW.is_primary THEN
    IF NOT EXISTS (
      SELECT 1 FROM product_category_links
       WHERE product_id = NEW.product_id AND is_primary
    ) THEN
      UPDATE products SET category = NULL, updated_at = now()
       WHERE id = NEW.product_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_sync_legacy_category ON product_category_links;
CREATE TRIGGER trg_sync_legacy_category
  AFTER INSERT OR UPDATE OR DELETE ON product_category_links
  FOR EACH ROW EXECUTE FUNCTION sync_legacy_category_from_link();

-- renomear o no re-sincroniza products.category dos vinculados.
-- Aposenta a cascata manual que a rota legada fazia (src/routes/productCategories.js).
CREATE OR REPLACE FUNCTION sync_legacy_category_on_rename() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE products p
       SET category = NEW.name, updated_at = now()
      FROM product_category_links l
     WHERE l.category_id = NEW.id
       AND l.is_primary
       AND p.id = l.product_id;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_sync_legacy_category_rename ON product_categories;
CREATE TRIGGER trg_sync_legacy_category_rename
  AFTER UPDATE OF name ON product_categories
  FOR EACH ROW EXECUTE FUNCTION sync_legacy_category_on_rename();

-- ============================================================
-- (e) CONTAGEM DIRETA por no
-- ============================================================
CREATE OR REPLACE FUNCTION category_count_maintain() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE product_categories SET product_count = product_count + 1
     WHERE id = NEW.category_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE product_categories SET product_count = GREATEST(product_count - 1, 0)
     WHERE id = OLD.category_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_category_count ON product_category_links;
CREATE TRIGGER trg_category_count
  AFTER INSERT OR DELETE ON product_category_links
  FOR EACH ROW EXECUTE FUNCTION category_count_maintain();
