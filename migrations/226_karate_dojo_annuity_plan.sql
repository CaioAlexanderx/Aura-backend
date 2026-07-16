-- ============================================================
-- AURA KARATÊ — Migration 226: plano de anuidade DO DOJÔ
-- ------------------------------------------------------------
-- Contexto (o bug que esta migration fecha):
--   Os 3 planos de anuidade de dojô (anual 1x R$500-mai / semestral 2x
--   R$280-mai,nov / trimestral 4x R$150-fev,mai,ago,nov) sempre existiram
--   como VIGÊNCIA DE PREÇO em karate_annual_fees (migration 222), mas até
--   aqui não havia NENHUM lugar que dissesse qual plano cada dojô
--   efetivamente assinou. karateAnnuityCampaign.js e o /charge individual
--   assumiam 'anual' como default sempre que nada era informado — um dojô
--   trimestral (R$600/ano) seria cobrado como se fosse anual (R$500), sem
--   erro nenhum (18 cobranças plausíveis e erradas, protegidas pelo índice
--   único parcial contra reexecução — silenciosas e persistentes).
--
-- ⚠️ NÃO CONFUNDIR com companies.affiliation_model (annual/biannual/
--    quarterly): esse campo já existe, é obrigatório no cadastro do dojô e
--    tem rótulos parecidos ("Anual · R$500 · vence em Maio" etc. — ver
--    MODELS em DojoFichaModal.tsx no app), mas é METADADO DECORATIVO —
--    computeDojoStatus (karateService.js) nem usa o valor dele, e NENHUMA
--    rota de billing (karateAnnuities.js, karateAnnuityCampaign.js) jamais
--    leu affiliation_model. É exatamente o tipo de campo que engana um dev
--    apressado a achar que "o plano já existe em algum lugar" — não existe.
--    karate_annuity_plan (esta migration) é o campo REAL que os endpoints
--    de cobrança passam a consultar.
--
-- Deliberadamente NULLABLE e SEM BACKFILL/DEFAULT: NULL significa "a
-- federação ainda não definiu o plano deste dojô" — um estado real e
-- esperado (hoje, 100% dos dojôs existentes caem aqui, já que a coluna é
-- nova). NÃO setamos 'anual' como default aqui nem no INSERT/UPDATE — isso
-- só reproduziria o bug dentro do banco. A ausência de plano deve aparecer
-- para o operador (preview da campanha: plano_indefinido=true), nunca ser
-- mascarada. Ver karateAnnuityService.js / karateAnnuityCampaign.js /
-- karateAnnuities.js para a ordem de precedência (plan explícito no
-- request > karate_annuity_plan do dojô > bloqueia/avisa, nunca assume).
-- ============================================================

DO $$
BEGIN
  ALTER TABLE companies ADD COLUMN karate_annuity_plan text;
EXCEPTION
  WHEN duplicate_column THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE companies
    ADD CONSTRAINT chk_companies_karate_annuity_plan
    CHECK (karate_annuity_plan IS NULL OR karate_annuity_plan IN ('anual', 'semestral', 'trimestral'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN companies.karate_annuity_plan IS
  'Plano de anuidade que o DOJÔ assinou (anual|semestral|trimestral), NULL = federação ainda não definiu. Só aplicável a vertical_active=karate_dojo. NÃO confundir com affiliation_model (decorativo, não usado em billing). Fonte de verdade para karateAnnuityCampaign.js e POST /annuities/dojos/:id/charge — nunca defaultar para anual quando NULL.';
