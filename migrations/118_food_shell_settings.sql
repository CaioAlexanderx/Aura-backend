-- ============================================================
-- AURA. -- Migration 118: Fase 0 Food (shell + settings)
-- Adiciona toggles do modo food em companies.pdv_settings (JSONB).
--
-- food_mode_enabled (default false): quando true, o PDV passa
-- a operar em "modo fechar mesa" em vez de "venda avulsa".
-- Toggle visivel em Configuracoes > PDV > Politicas do Caixa
-- (so aparece para empresas com vertical_active=food).
--
-- service_fee_pct (default 10): taxa de servico aplicada
-- automaticamente sobre o subtotal da comanda. 0 = desativado.
-- Aparece no fechamento da mesa como linha separada.
--
-- Aplicar manualmente no Supabase SQL Editor (Aura-backend NAO
-- roda migrations no boot — toda nova coluna e responsabilidade
-- do dev aplicar antes do deploy).
--
-- Idempotente: usa COALESCE no JSONB para nao sobrescrever
-- valores ja configurados pela empresa.
-- ============================================================

UPDATE companies
SET pdv_settings = COALESCE(pdv_settings, '{}'::jsonb)
                || jsonb_build_object(
                     'food_mode_enabled', COALESCE((pdv_settings->>'food_mode_enabled')::boolean, false),
                     'service_fee_pct',   COALESCE((pdv_settings->>'service_fee_pct')::numeric,   10)
                   )
WHERE pdv_settings IS NULL
   OR NOT (pdv_settings ? 'food_mode_enabled')
   OR NOT (pdv_settings ? 'service_fee_pct');

-- Note: nao alteramos o default da coluna pdv_settings (ainda
-- continua '{"require_seller": false, "require_customer": false}').
-- Empresas novas que ativarem vertical=food vao receber os toggles
-- via UI (PdvSettingsCard) quando o usuario salvar pela 1a vez, ou
-- via re-run desta migration apos cadastro.
