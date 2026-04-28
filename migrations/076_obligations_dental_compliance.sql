-- ============================================================
-- 076_obligations_dental_compliance.sql
-- PR36 (2026-04-28): obrigacoes especificas saude/odontologia.
-- Aplicaveis a qualquer regime quando cnae_category='saude'.
-- Calendar resolver no backend deve fazer UNION com regime do company
-- + cnae_category='saude' quando vertical_active='odonto'.
-- ============================================================

INSERT INTO obligations_templates (regime, has_employee, cnae_category, code, name_display, description, frequency, due_rule, due_month, due_day, responsible, filter_label, aura_action, user_action, time_estimate, checkpoint_total, active, sort_order)
VALUES
  ('both', NULL, 'saude', 'CRO_ANUIDADE_PJ', 'CRO Anuidade PJ', 'Anuidade do Conselho Regional de Odontologia para a clinica (PJ).', 'annual', NULL, 3, 31, 'voce', 'voce_faz', 'Lembramos do prazo e do valor estimado', 'Emitir guia no portal do CRO do seu estado e pagar', '10min', 2, true, 100),
  ('both', NULL, 'saude', 'CRO_ANUIDADE_RT', 'CRO Anuidade RT', 'Anuidade do Responsavel Tecnico (dentista) registrado no CRO.', 'annual', NULL, 3, 31, 'voce', 'voce_faz', 'Lembramos do prazo', 'Pagar anuidade do RT no portal do CRO', '10min', 2, true, 101),
  ('both', NULL, 'saude', 'CNES_UPDATE', 'CNES - Atualizacao Mensal', 'Cadastro Nacional de Estabelecimentos de Saude.', 'monthly', NULL, NULL, 28, 'voce', 'voce_faz', 'Lembramos quando ha mudanca cadastrada', 'Acessar cnes.datasus.gov.br e revisar dados', '15min', 3, true, 102),
  ('both', NULL, 'saude', 'ALVARA_VIGILANCIA', 'Alvara da Vigilancia Sanitaria', 'Alvara municipal obrigatorio para clinica funcionar.', 'annual', 'manual_renewal', NULL, NULL, 'voce', 'voce_faz', 'Cadastre a data de validade nas configuracoes; lembramos 60/30/7 dias antes', 'Renovar antes do vencimento no portal da Vigilancia Sanitaria municipal', '30min', 4, true, 103),
  ('both', true, 'saude', 'PCMSO_NR7', 'PCMSO Anual', 'NR-7: Programa de Controle Medico de Saude Ocupacional.', 'annual', NULL, NULL, NULL, 'voce', 'voce_faz', 'Lembramos do vencimento e ASOs proximos', 'Contratar medico do trabalho para elaborar/atualizar PCMSO', '60min', 3, true, 104),
  ('both', true, 'saude', 'PGR_NR1', 'PGR Anual', 'NR-1: Programa de Gerenciamento de Riscos.', 'annual', NULL, NULL, NULL, 'voce', 'voce_faz', 'Lembramos do vencimento', 'Contratar tecnico de seguranca do trabalho para elaborar PGR', '60min', 3, true, 105),
  ('both', NULL, 'saude', 'SNGPC_NOTIFICACAO', 'SNGPC - Notificacao Mensal', 'Sistema da Anvisa para controle de medicamentos.', 'monthly', NULL, NULL, 15, 'voce', 'voce_faz', 'Lembramos se voce usa medicamentos controlados', 'Acessar sngpc.anvisa.gov.br e enviar inventario', '20min', 3, true, 106),
  ('both', NULL, 'saude', 'LIVRO_RECEITUARIO', 'Livro de Receituarios Controlados', 'Livro fisico de registro de receituarios controlados.', 'continuous', NULL, NULL, NULL, 'voce', 'voce_faz', 'Lembramos a cada 3 meses para conferencia', 'Conferir livro fisico contra receitas emitidas', '20min', 1, true, 107);
