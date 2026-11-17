-- ============================================================
-- 456 — Venda do Caixa com peça personalizável, no Negócio, cai em
--       "Aguardando personalização" (p-177, 17/11/2026)
--
-- O trigger trg_sales_studio_status (migration 176) marca toda venda do
-- Caixa que tem produto personalizável com studio_production_status =
-- 'pending_art' ("Aguardando arte"). No Studio isso está certo: o Caixa do
-- Studio pede o texto e a arte na hora e grava logo depois (PATCH
-- /studio/sale-items/:id/customization).
--
-- O Caixa do Negócio não pede nada disso. Para a empresa com a frente
-- Personalizados ligada DENTRO do Negócio, a venda tem de cair em
-- 'awaiting_customization' ("Aguardando personalização"), e a lojista
-- registra depois a arte e o texto pela Fila de produção (POST
-- /studio/orders/:oid/personalizacao, que move para 'pending_art').
--
-- Regra nova (só muda o VALOR gravado, nunca quando grava):
--   empresa com vertical_active diferente de 'studio'
--   E pdv_settings.studio_enabled = true (boolean)  -> 'awaiting_customization'
--   qualquer outro caso                              -> 'pending_art' (como hoje)
--
-- "Frente ligada" é a mesma conta do backend (services/personalizadosAtivacao
-- frenteLigada): vertical Studio OU studio_enabled true. A vertical Studio
-- continua em 'pending_art'.
--
-- Efeito hoje: nenhum. Conferido em produção em 17/11/2026 (só leitura):
-- studio_enabled = true só existe nas 6 empresas com vertical_active =
-- 'studio'; as outras 46 com a chave têm false. A definição de produção da
-- função é idêntica à da 176 (retrato em
-- tests/fixtures/studio/fn_sales_studio_production_status.prod.sql).
--
-- Venda sem produto personalizável: o IF EXISTS é o mesmo de antes, nada
-- muda (nem uma consulta a mais). A leitura de companies só acontece
-- dentro do IF, por chave primária.
--
-- O trigger em si não muda (AFTER INSERT em sale_items, FOR EACH ROW).
-- Idempotente: CREATE OR REPLACE da função.
--
-- Caminho de volta: reaplicar o corpo da 176 (o retrato acima).
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_sales_studio_production_status()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM products p
     WHERE p.id = NEW.product_id
       AND p.is_personalizable = true
  ) THEN
    UPDATE sales
       SET studio_production_status = CASE
             WHEN EXISTS (
               SELECT 1 FROM companies c
                WHERE c.id = sales.company_id
                  AND c.vertical_active::text IS DISTINCT FROM 'studio'
                  AND c.pdv_settings->'studio_enabled' = 'true'::jsonb
             ) THEN 'awaiting_customization'
             ELSE 'pending_art'
           END
     WHERE id = NEW.sale_id
       AND studio_production_status IS NULL;
  END IF;
  RETURN NEW;
END;
$function$;
