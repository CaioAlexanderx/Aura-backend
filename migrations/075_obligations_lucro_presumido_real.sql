-- ============================================================
-- 075_obligations_lucro_presumido_real.sql
-- PR36 (2026-04-28): obrigacoes Lucro Presumido + Lucro Real.
-- Antes: normalizeRegime no front colapsava em 'simples'. Agora
-- backend tem o calendar real desses regimes.
--
-- 075a: expandir CHECK constraints
-- 075b: seed das obligations
-- ============================================================

-- 075a: expandir CHECKs
ALTER TABLE obligations_templates DROP CONSTRAINT IF EXISTS obligations_templates_regime_check;
ALTER TABLE obligations_templates ADD CONSTRAINT obligations_templates_regime_check
  CHECK (regime = ANY (ARRAY['mei'::text, 'simples_nacional'::text, 'lucro_presumido'::text, 'lucro_real'::text, 'pessoa_fisica'::text, 'both'::text]));

ALTER TABLE obligations_templates DROP CONSTRAINT IF EXISTS obligations_templates_cnae_category_check;
ALTER TABLE obligations_templates ADD CONSTRAINT obligations_templates_cnae_category_check
  CHECK (cnae_category = ANY (ARRAY['general'::text, 'icms'::text, 'saude'::text]));

-- 075b: Lucro Presumido (10 obrigacoes principais)
INSERT INTO obligations_templates (regime, has_employee, cnae_category, code, name_display, description, frequency, due_rule, due_month, due_day, responsible, filter_label, aura_action, user_action, time_estimate, checkpoint_total, active, sort_order)
VALUES
  ('lucro_presumido', NULL, 'general', 'DCTFWEB_LP', 'DCTFWeb', 'Declaracao de Debitos e Creditos Tributarios Federais Previdenciarios', 'monthly', 'last_business_day', NULL, 15, 'aura', 'aura_resolve', 'Geramos e enviamos automaticamente', 'Confirmar valores de retencoes', '5min', 2, true, 10),
  ('lucro_presumido', NULL, 'general', 'IRPJ_LP', 'IRPJ Trimestral', 'IRPJ presumido sobre receita (32% servico)', 'monthly', 'quarterly_30', NULL, 30, 'aura', 'aura_resolve', 'Calculamos pelo presumido e geramos DARF', 'Conferir e pagar', '5min', 2, true, 11),
  ('lucro_presumido', NULL, 'general', 'CSLL_LP', 'CSLL Trimestral', 'Contribuicao Social sobre o Lucro Liquido', 'monthly', 'quarterly_30', NULL, 30, 'aura', 'aura_resolve', 'Calculamos e geramos DARF', 'Conferir e pagar', '5min', 2, true, 12),
  ('lucro_presumido', NULL, 'general', 'PIS_LP', 'PIS Mensal', 'PIS 0,65% sobre faturamento', 'monthly', NULL, NULL, 25, 'aura', 'aura_resolve', 'Calculamos e geramos DARF', 'Pagar DARF', '3min', 1, true, 13),
  ('lucro_presumido', NULL, 'general', 'COFINS_LP', 'COFINS Mensal', 'COFINS 3% sobre faturamento', 'monthly', NULL, NULL, 25, 'aura', 'aura_resolve', 'Calculamos e geramos DARF', 'Pagar DARF', '3min', 1, true, 14),
  ('lucro_presumido', NULL, 'general', 'ISS_NFSE_LP', 'ISS / NFS-e Municipal', 'ISS retido em NFS-e ou recolhimento proprio', 'monthly', NULL, NULL, 10, 'voce', 'voce_faz', 'Lembramos de emitir e recolher', 'Emitir NFS-e e recolher ISS no portal municipal', '15min', 3, true, 15),
  ('lucro_presumido', NULL, 'general', 'EFD_CONTRIB_LP', 'EFD-Contribuicoes', 'Escrituracao trimestral de PIS/COFINS', 'monthly', 'quarterly_15', NULL, 15, 'aura', 'aura_resolve', 'Geramos e transmitimos', 'Validar antes do envio', '10min', 2, true, 16),
  ('lucro_presumido', NULL, 'general', 'ECF_LP', 'ECF Anual', 'Escrituracao Contabil Fiscal', 'annual', NULL, 7, 31, 'aura', 'aura_resolve', 'Preparamos com base no historico', 'Conferir e assinar com certificado digital', '30min', 4, true, 17),
  ('lucro_presumido', NULL, 'general', 'ECD_LP', 'ECD Anual', 'Escrituracao Contabil Digital', 'annual', NULL, 6, 30, 'aura', 'aura_resolve', 'Geramos a partir das transacoes', 'Validar e assinar', '30min', 3, true, 18),
  ('lucro_presumido', NULL, 'general', 'DCTF_LP', 'DCTF Mensal', 'Declaracao de Debitos e Creditos Tributarios Federais', 'monthly', NULL, NULL, 21, 'aura', 'aura_resolve', 'Transmitimos automaticamente', 'Conferir', '5min', 1, true, 19);

-- Lucro Real (9 principais)
INSERT INTO obligations_templates (regime, has_employee, cnae_category, code, name_display, description, frequency, due_rule, due_month, due_day, responsible, filter_label, aura_action, user_action, time_estimate, checkpoint_total, active, sort_order)
VALUES
  ('lucro_real', NULL, 'general', 'DCTFWEB_LR', 'DCTFWeb', 'Declaracao Previdenciaria', 'monthly', 'last_business_day', NULL, 15, 'aura', 'aura_resolve', 'Geramos automaticamente', 'Confirmar', '5min', 2, true, 20),
  ('lucro_real', NULL, 'general', 'IRPJ_LR', 'IRPJ Trimestral', 'IRPJ apurado pelo lucro real', 'monthly', NULL, NULL, 30, 'aura', 'aura_resolve', 'Calculamos sobre o lucro real', 'Conferir e pagar DARF', '15min', 3, true, 21),
  ('lucro_real', NULL, 'general', 'CSLL_LR', 'CSLL Trimestral', 'CSLL apurada pelo lucro real', 'monthly', NULL, NULL, 30, 'aura', 'aura_resolve', 'Calculamos e geramos DARF', 'Pagar', '5min', 1, true, 22),
  ('lucro_real', NULL, 'general', 'PIS_LR', 'PIS Mensal Nao-cumulativo', 'PIS 1,65% com creditos', 'monthly', NULL, NULL, 25, 'aura', 'aura_resolve', 'Apuramos com credito de insumos', 'Pagar DARF', '5min', 1, true, 23),
  ('lucro_real', NULL, 'general', 'COFINS_LR', 'COFINS Mensal Nao-cumulativa', 'COFINS 7,6% com creditos', 'monthly', NULL, NULL, 25, 'aura', 'aura_resolve', 'Apuramos com creditos', 'Pagar DARF', '5min', 1, true, 24),
  ('lucro_real', NULL, 'general', 'ISS_NFSE_LR', 'ISS / NFS-e Municipal', 'Imposto Sobre Servicos', 'monthly', NULL, NULL, 10, 'voce', 'voce_faz', 'Lembramos do prazo', 'Emitir NFS-e e recolher ISS', '15min', 3, true, 25),
  ('lucro_real', NULL, 'general', 'EFD_CONTRIB_LR', 'EFD-Contribuicoes Mensal', 'Escrituracao mensal PIS/COFINS', 'monthly', NULL, NULL, 15, 'aura', 'aura_resolve', 'Geramos e transmitimos', 'Validar', '10min', 2, true, 26),
  ('lucro_real', NULL, 'general', 'ECF_LR', 'ECF Anual', 'Escrituracao Contabil Fiscal', 'annual', NULL, 7, 31, 'aura', 'aura_resolve', 'Preparamos', 'Assinar', '30min', 4, true, 27),
  ('lucro_real', NULL, 'general', 'ECD_LR', 'ECD Anual', 'Escrituracao Contabil Digital', 'annual', NULL, 6, 30, 'aura', 'aura_resolve', 'Geramos', 'Assinar', '30min', 3, true, 28);
