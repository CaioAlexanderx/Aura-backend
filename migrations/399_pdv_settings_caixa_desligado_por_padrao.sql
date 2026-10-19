-- ============================================================
-- 399 — companies.pdv_settings: caixa desligado por padrao na conta nova
--
-- Decisao do Caio em 19/10/2026: para conta nova, o controle de caixa (abrir
-- o caixa antes de vender), o vendedor obrigatorio e o cliente obrigatorio
-- vem DESLIGADOS. Os tres juntos eram o "bloqueador gigantesco da primeira
-- venda": a lojista entrava, tentava vender e esbarrava num caixa fechado.
--
-- Medido: o DEFAULT_SETTINGS de src/routes/pdvSettings.js ja devolve
-- caixa_enabled=false, mas a COLUNA nasce com
--   {"caixa_enabled": true, "require_seller": false,
--    "require_customer": false, "crediario_enabled": true}
-- e nenhum INSERT de companies (auth.js, userCompanies.js, dojo, federacao)
-- grava pdv_settings: toda empresa nova herdava o caixa ligado do default
-- da coluna. O banco manda mais que o default do GET.
--
-- O que esta migration faz: troca SO o default da coluna. Nao toca em linha
-- nenhuma — quem ja existe (e quem salvou uma escolha) fica como esta; as
-- 150 contas em teste ja foram ajustadas a parte (backup em
-- bkp_pdv_settings_trial_20261019). crediario_enabled continua true.
--
-- Idempotente: ALTER ... SET DEFAULT repetido grava o mesmo valor.
-- Caminho de volta: o mesmo ALTER com "caixa_enabled": true.
-- ============================================================

ALTER TABLE companies
  ALTER COLUMN pdv_settings
  SET DEFAULT '{"caixa_enabled": false, "require_seller": false, "require_customer": false, "crediario_enabled": true}'::jsonb;
