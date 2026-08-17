-- ============================================================
-- AURA — Taxa da maquininha (PDV)
-- 17/08/2026
--
-- Toggle novo em Configuracoes > PDV, valendo pro Shell Negocio e pro
-- Shell Studio. Ligado, a lojista informa quanto a adquirente retem e
-- toda venda no cartao gera a despesa sozinha (categoria "Taxas de cartao",
-- idempotency_key pdv-card-fee-<sale_id>).
--
-- Chaves (dentro do JSONB companies.pdv_settings, seguindo o padrao da
-- memory toggles_pdv_settings e o precedente do service_fee_pct — flags
-- novos vivem no JSONB existente, sem migration nova a cada toggle):
--   card_fee_enabled     : boolean (default false) — liga o lancamento
--   card_fee_credit_pct  : numeric (default 0)     — aliquota do CREDITO ("cartao")
--   card_fee_debit_pct   : numeric (default 0)     — aliquota do DEBITO  ("debito")
--
-- Credito e debito tem aliquotas SEPARADAS: a adquirente cobra diferente
-- em cada um. Dinheiro, Pix e crediario nao geram taxa.
--
-- A receita bruta fica INTACTA: a taxa e uma despesa separada, lancada na
-- competencia da venda (status 'confirmed'), nao um abatimento da receita.
--
-- Idempotente: COALESCE preserva valor ja gravado; rodar de novo nao zera
-- configuracao de ninguem.
-- ============================================================

UPDATE companies
SET pdv_settings = COALESCE(pdv_settings, '{}'::jsonb)
                || jsonb_build_object(
                     'card_fee_enabled',    COALESCE(pdv_settings->'card_fee_enabled',    'false'::jsonb),
                     'card_fee_credit_pct', COALESCE(pdv_settings->'card_fee_credit_pct', '0'::jsonb),
                     'card_fee_debit_pct',  COALESCE(pdv_settings->'card_fee_debit_pct',  '0'::jsonb)
                   );

COMMENT ON COLUMN companies.pdv_settings IS
  'Configuracoes do PDV/Caixa (JSONB): require_customer, require_seller, caixa_enabled, '
  'crediario_enabled, cash_tender_modal_enabled, studio_*, food_*, service_fee_pct, '
  'food_service_fee_pct e (17/08/2026) card_fee_enabled / card_fee_credit_pct / '
  'card_fee_debit_pct — taxa da maquininha por aliquota de credito e debito.';
