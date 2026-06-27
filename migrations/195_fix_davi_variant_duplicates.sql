-- ============================================================
-- 195: Fix Davi Calcados duplicate variants (27/06/2026)
--
-- Davi reportou 27 grupos de variantes duplicadas (Matriz 2 +
-- Villa Branca 25), originadas de tentativas falhas de adicionar
-- cor a produtos mono-color: as primeiras tentativas geraram
-- variantes extras (mesmo combo cor+tamanho ativos), e o backend
-- /variant-image resolve por combinacao -> a query achava a errada
-- e a foto era persistida na variante "fantasma".
--
-- Esta migration:
--  (1) Adiciona coluna deactivated_reason em product_variants
--      pra rastreabilidade (NULLable, sem default).
--  (2) Consolida os 27 grupos do Davi: canonica = mais antiga por
--      created_at; soma stock_qty das extras na canonica; copia
--      image_url se canonica nao tem; desativa extras com
--      deactivated_reason='consolidated_dupe_davi_jun2026'.
--  (3) Cria trigger de protecao: AFTER INSERT em
--      product_variant_values, escaneia o produto afetado e
--      raise se existirem 2+ variantes ativas com mesmo
--      (cor, tamanho). Statement-level (escapa do
--      delete-then-insert do PUT /variations que executa
--      em transacao unica e fica consistente no final).
--
-- IDEMPOTENTE: roda 2x sem efeito (depende de is_active=true e
-- da existencia de extras nao consolidadas).
-- ============================================================

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS deactivated_reason TEXT;

-- ────────────────────────────────────────────────
-- (2) Consolidacao das 27 duplicatas Davi
-- ────────────────────────────────────────────────
DO $migration$
DECLARE
  v_dup        RECORD;
  v_canonical  UUID;
  v_extra_sum  NUMERIC := 0;
  v_extra_img  TEXT;
  v_groups     INT := 0;
  v_extras     INT := 0;
BEGIN
  FOR v_dup IN
    WITH davi_companies AS (
      SELECT id FROM companies WHERE name ILIKE 'davi%cal%'
    ),
    davi_active AS (
      SELECT pv.id AS variant_id, pv.product_id, pv.stock_qty,
             pv.image_url, pv.created_at
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
      WHERE p.company_id IN (SELECT id FROM davi_companies)
        AND pv.is_active = true
    ),
    with_combos AS (
      SELECT da.variant_id, da.product_id, da.stock_qty,
             da.image_url, da.created_at,
             COALESCE(MAX(CASE WHEN LOWER(pvv.attribute_name) IN ('cor','color')
                               THEN UPPER(pvv.value) END), '') AS color_v,
             COALESCE(MAX(CASE WHEN LOWER(pvv.attribute_name) IN ('tamanho','size')
                               THEN pvv.value END), '') AS size_v
      FROM davi_active da
      LEFT JOIN product_variant_values pvv ON pvv.variant_id = da.variant_id
      GROUP BY da.variant_id, da.product_id, da.stock_qty, da.image_url, da.created_at
    )
    SELECT product_id, color_v, size_v
    FROM with_combos
    GROUP BY product_id, color_v, size_v
    HAVING COUNT(*) > 1
  LOOP
    -- Identifica canonica (mais antiga por created_at, tiebreaker id ASC)
    SELECT pv.id INTO v_canonical
    FROM product_variants pv
    LEFT JOIN product_variant_values pvv_c
      ON pvv_c.variant_id = pv.id
     AND LOWER(pvv_c.attribute_name) IN ('cor','color')
    LEFT JOIN product_variant_values pvv_s
      ON pvv_s.variant_id = pv.id
     AND LOWER(pvv_s.attribute_name) IN ('tamanho','size')
    WHERE pv.product_id = v_dup.product_id
      AND pv.is_active = true
      AND COALESCE(UPPER(pvv_c.value), '') = v_dup.color_v
      AND COALESCE(pvv_s.value, '') = v_dup.size_v
    ORDER BY pv.created_at ASC, pv.id ASC
    LIMIT 1;

    IF v_canonical IS NULL THEN CONTINUE; END IF;

    SELECT COALESCE(SUM(pv.stock_qty), 0) INTO v_extra_sum
    FROM product_variants pv
    LEFT JOIN product_variant_values pvv_c
      ON pvv_c.variant_id = pv.id
     AND LOWER(pvv_c.attribute_name) IN ('cor','color')
    LEFT JOIN product_variant_values pvv_s
      ON pvv_s.variant_id = pv.id
     AND LOWER(pvv_s.attribute_name) IN ('tamanho','size')
    WHERE pv.product_id = v_dup.product_id
      AND pv.is_active = true
      AND COALESCE(UPPER(pvv_c.value), '') = v_dup.color_v
      AND COALESCE(pvv_s.value, '') = v_dup.size_v
      AND pv.id <> v_canonical;

    SELECT pv.image_url INTO v_extra_img
    FROM product_variants pv
    LEFT JOIN product_variant_values pvv_c
      ON pvv_c.variant_id = pv.id
     AND LOWER(pvv_c.attribute_name) IN ('cor','color')
    LEFT JOIN product_variant_values pvv_s
      ON pvv_s.variant_id = pv.id
     AND LOWER(pvv_s.attribute_name) IN ('tamanho','size')
    WHERE pv.product_id = v_dup.product_id
      AND pv.is_active = true
      AND COALESCE(UPPER(pvv_c.value), '') = v_dup.color_v
      AND COALESCE(pvv_s.value, '') = v_dup.size_v
      AND pv.id <> v_canonical
      AND pv.image_url IS NOT NULL
    LIMIT 1;

    UPDATE product_variants
    SET stock_qty = stock_qty + v_extra_sum,
        image_url = COALESCE(image_url, v_extra_img),
        updated_at = NOW()
    WHERE id = v_canonical;

    WITH to_deactivate AS (
      SELECT pv.id AS extra_id
      FROM product_variants pv
      LEFT JOIN product_variant_values pvv_c
        ON pvv_c.variant_id = pv.id
       AND LOWER(pvv_c.attribute_name) IN ('cor','color')
      LEFT JOIN product_variant_values pvv_s
        ON pvv_s.variant_id = pv.id
       AND LOWER(pvv_s.attribute_name) IN ('tamanho','size')
      WHERE pv.product_id = v_dup.product_id
        AND pv.is_active = true
        AND COALESCE(UPPER(pvv_c.value), '') = v_dup.color_v
        AND COALESCE(pvv_s.value, '') = v_dup.size_v
        AND pv.id <> v_canonical
    )
    UPDATE product_variants
    SET is_active = false,
        deactivated_reason = 'consolidated_dupe_davi_jun2026',
        updated_at = NOW()
    WHERE id IN (SELECT extra_id FROM to_deactivate);

    GET DIAGNOSTICS v_extras = ROW_COUNT;
    v_groups := v_groups + 1;

    RAISE NOTICE 'Grupo % (color=%, size=%): canonica=% +% stock; % extras desativadas',
      v_dup.product_id, v_dup.color_v, v_dup.size_v, v_canonical, v_extra_sum, v_extras;
  END LOOP;

  RAISE NOTICE 'CONSOLIDACAO COMPLETA: % grupos processados', v_groups;
END
$migration$;

-- ────────────────────────────────────────────────
-- (3) Trigger anti-duplicacao (statement-level em product_variant_values)
-- ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_no_active_variant_duplicates()
RETURNS TRIGGER AS $trigger$
DECLARE
  v_dup_count INT;
BEGIN
  SELECT COUNT(*) INTO v_dup_count
  FROM (
    SELECT pv.product_id,
           COALESCE(MAX(CASE WHEN LOWER(pvv.attribute_name) IN ('cor','color')
                             THEN UPPER(pvv.value) END), '') AS color_v,
           COALESCE(MAX(CASE WHEN LOWER(pvv.attribute_name) IN ('tamanho','size')
                             THEN pvv.value END), '') AS size_v,
           pv.id AS variant_id
    FROM product_variants pv
    LEFT JOIN product_variant_values pvv ON pvv.variant_id = pv.id
    WHERE pv.is_active = true
      AND pv.product_id IN (
        SELECT DISTINCT pv2.product_id
        FROM product_variants pv2
        WHERE pv2.id IN (SELECT variant_id FROM affected_variants)
      )
    GROUP BY pv.id, pv.product_id
  ) per_variant
  GROUP BY product_id, color_v, size_v
  HAVING COUNT(*) > 1
  LIMIT 1;

  IF v_dup_count IS NOT NULL AND v_dup_count > 0 THEN
    RAISE EXCEPTION 'product_variants: combinacao duplicada (cor+tamanho) na mesma referencia (product_id=%)',
      (SELECT DISTINCT pv2.product_id FROM product_variants pv2
       WHERE pv2.id IN (SELECT variant_id FROM affected_variants) LIMIT 1)
      USING ERRCODE = '23505';
  END IF;

  RETURN NULL;
END;
$trigger$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_no_active_variant_dupes_ins ON product_variant_values;
CREATE TRIGGER trg_no_active_variant_dupes_ins
AFTER INSERT ON product_variant_values
REFERENCING NEW TABLE AS affected_variants
FOR EACH STATEMENT
EXECUTE FUNCTION check_no_active_variant_duplicates();

DROP TRIGGER IF EXISTS trg_no_active_variant_dupes_upd ON product_variant_values;
CREATE TRIGGER trg_no_active_variant_dupes_upd
AFTER UPDATE ON product_variant_values
REFERENCING NEW TABLE AS affected_variants
FOR EACH STATEMENT
EXECUTE FUNCTION check_no_active_variant_duplicates();

COMMENT ON FUNCTION check_no_active_variant_duplicates() IS
  'Statement-level trigger fn que garante unicidade de combo (cor,tamanho) entre variantes ativas do mesmo produto. Tolera o padrao delete+insert do PUT /variations (que roda em transacao e fica consistente no final do statement). Migration 195.';

COMMENT ON COLUMN product_variants.deactivated_reason IS
  'Motivo da desativacao (is_active=false). Adicionado em 195 pra rastrear consolidacoes; usar valores curtos snake_case.';
