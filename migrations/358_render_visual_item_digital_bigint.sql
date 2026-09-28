-- ============================================================
-- AURA Studio — Fix: "Gerar do pedido (motor visual)" dava 500
-- 28/09/2026 — QA pos-deploy da vitrine (LJ-36, P1)
--
-- # Sintoma
--
-- POST /companies/:id/studio/visual-renders respondia 500 logo depois do
-- upload-mockup 201. O log do Postgres, no mesmo minuto:
--   ERROR 22P02: invalid input syntax for type uuid: "43"
--
-- # Causa raiz
--
-- A 208 criou studio_visual_renders.digital_order_item_id como UUID, mas
-- digital_order_items.id e BIGINT (BIGSERIAL, src/migrations/043 — e o
-- tipo em producao). O painel manda o id do item do pedido (43) e o
-- INSERT quebra. Nenhum render de pedido da vitrine jamais foi gravado.
--
-- # Fix
--
-- A coluna passa a ter o MESMO tipo de digital_order_items.id (lido do
-- catalogo, nao escrito aqui: se um dia o id mudar, a migration continua
-- certa). Um UUID que tenha entrado nela so pode ser id de sale_items (o
-- painel manda o id do item tambem nos pedidos do Caixa); ele e movido
-- para sale_item_id antes da troca, em vez de ser apagado.
-- ============================================================

DO $$
DECLARE
  tipo_do_item   text;
  tipo_do_render text;
BEGIN
  IF to_regclass('public.studio_visual_renders') IS NULL
     OR to_regclass('public.digital_order_items') IS NULL THEN
    RETURN;
  END IF;

  SELECT format_type(atttypid, atttypmod) INTO tipo_do_item
    FROM pg_attribute
   WHERE attrelid = 'public.digital_order_items'::regclass AND attname = 'id' AND NOT attisdropped;
  SELECT format_type(atttypid, atttypmod) INTO tipo_do_render
    FROM pg_attribute
   WHERE attrelid = 'public.studio_visual_renders'::regclass AND attname = 'digital_order_item_id' AND NOT attisdropped;

  IF tipo_do_item IS NULL OR tipo_do_render IS NULL OR tipo_do_item = tipo_do_render THEN
    RETURN;
  END IF;

  IF tipo_do_render = 'uuid' THEN
    UPDATE public.studio_visual_renders
       SET sale_item_id          = COALESCE(sale_item_id, digital_order_item_id),
           digital_order_item_id = NULL
     WHERE digital_order_item_id IS NOT NULL;
    EXECUTE format(
      'ALTER TABLE public.studio_visual_renders ALTER COLUMN digital_order_item_id TYPE %s USING NULL',
      tipo_do_item);
  ELSE
    EXECUTE format(
      'ALTER TABLE public.studio_visual_renders ALTER COLUMN digital_order_item_id TYPE %1$s USING digital_order_item_id::text::%1$s',
      tipo_do_item);
  END IF;
END $$;
