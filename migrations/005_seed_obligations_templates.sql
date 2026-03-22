-- ============================================================
-- Seed — 18 Templates de Obrigações Fiscais Validados
-- Matriz: Regime × Tem funcionário × CNAE
-- Validado em: 22/03/2026
-- DCTFWeb/EFD-Reinf: excluídos do MVP (só CNAEs fora do público Aura)
-- DIRF: EXTINTA desde jan/2025 — não incluída
-- ============================================================

INSERT INTO obligations_templates (
  regime, has_employee, cnae_category, code, name_display, description,
  frequency, due_rule, due_month, due_day,
  responsible, filter_label, aura_action, user_action, time_estimate,
  checkpoint_total, sort_order
) VALUES

-- ── MEI SEM FUNCIONÁRIO (7 itens) ─────────────────────────

(
  'mei', false, 'general', 'DAS_MEI',
  'DAS-MEI — Guia mensal do Microempreendedor',
  'Contribuição mensal obrigatória: INSS + ISS ou ICMS conforme atividade',
  'monthly', 'day_20', NULL, 20,
  'aura', 'aura_resolve',
  'Calcula o valor automaticamente e gera QR Code Pix para pagamento',
  NULL, NULL, 3, 10
),
(
  'mei', false, 'general', 'NFE_MEI',
  'NF-e / NFS-e — Nota fiscal automática',
  'Emissão automática de nota fiscal em toda venda para pessoa jurídica',
  'per_event', 'per_event', NULL, NULL,
  'aura', 'aura_resolve',
  'Emite a nota fiscal automaticamente a cada venda registrada para PJ',
  NULL, NULL, 0, 20
),
(
  'mei', false, 'general', 'MEI_LIMIT',
  'Controle do limite de faturamento MEI (R$ 81 mil/ano)',
  'Monitoramento contínuo do faturamento acumulado vs limite anual',
  'continuous', 'continuous', NULL, NULL,
  'aura', 'aura_resolve',
  'Monitora o faturamento em tempo real e alerta quando se aproximar do limite',
  NULL, NULL, 0, 30
),
(
  'mei', false, 'general', 'DASN_SIMEI',
  'DASN-SIMEI — Declaração anual do MEI',
  'Declaração anual de faturamento do ano anterior. Vence 31/05.',
  'annual', 'may_31', 5, 31,
  'voce', 'voce_faz',
  'Consolida todo o faturamento do ano e abre o Portal do Empreendedor pré-preenchido',
  'Revisar os dados e confirmar a transmissão no portal', '5 min', 5, 40
),
(
  'mei', false, 'general', 'IRPF_MEI',
  'IRPF — Imposto de Renda do titular',
  'Declaração anual de IR do titular MEI, se renda total > R$ 33.888. Vence abril.',
  'annual', 'apr_30', 4, 30,
  'voce', 'voce_faz',
  'Alerta se você estiver obrigado com base na renda e gera relatório de retiradas do ano',
  'Declarar no site da Receita Federal com os dados fornecidos pela Aura', NULL, 0, 50
),
(
  'mei', false, 'icms', 'INSCRICAO_ESTADUAL',
  'Inscrição Estadual — obrigatória para comércio',
  'Empresas com atividade de comércio (ICMS) precisam de Inscrição Estadual',
  'per_event', 'per_event', NULL, NULL,
  'voce', 'voce_faz',
  'Identifica a obrigação com base no seu CNAE e orienta o processo de inscrição',
  'Realizar a inscrição na Secretaria da Fazenda do seu estado', NULL, 0, 60
),
(
  'mei', false, 'general', 'CADASTRO_MEI',
  'Atualização dos dados cadastrais',
  'Manter CNPJ atualizado no Portal do Empreendedor: endereço, atividade, dados pessoais',
  'annual', 'continuous', NULL, NULL,
  'voce', 'voce_faz',
  'Envia lembretes periódicos e verifica se os dados cadastrais estão atualizados',
  'Verificar e atualizar seus dados no Portal do Empreendedor quando necessário', '5 min', 0, 70
),

-- ── MEI COM FUNCIONÁRIO (6 itens adicionais) ──────────────

(
  'mei', true, 'general', 'ESOCIAL_ADMISSAO',
  'eSocial — Admissão de funcionário',
  'Comunicação de contratação no eSocial deve ser feita até D-1 da admissão',
  'per_event', 'per_event', NULL, NULL,
  'voce', 'voce_faz',
  'Monta o arquivo XML de admissão pronto para transmissão no Gov.br',
  'Transmitir o arquivo no Portal do eSocial (Gov.br) com conta Prata ou Ouro', '5 min', 3, 110
),
(
  'mei', true, 'general', 'FOLHA_MEI',
  'Folha de pagamento — INSS + FGTS + Holerite',
  'Cálculo mensal de salário, INSS patronal (3%), FGTS (8%) e emissão de holerite',
  'monthly', 'day_7', NULL, 7,
  'aura', 'aura_resolve',
  'Calcula automaticamente INSS, FGTS e emite o holerite digital do funcionário',
  NULL, NULL, 2, 120
),
(
  'mei', true, 'general', 'DAE_ESOCIAL',
  'DAE — Guia de pagamento eSocial',
  'Documento de Arrecadação do eSocial: INSS + FGTS do funcionário. Vence dia 7.',
  'monthly', 'day_7', NULL, 7,
  'aura', 'aura_resolve',
  'Gera a guia DAE automaticamente junto com a folha de pagamento',
  NULL, NULL, 2, 130
),
(
  'mei', true, 'general', 'FERIAS',
  'Férias — cálculo e aviso',
  'Aviso de férias com 30 dias de antecedência e pagamento até 2 dias antes',
  'per_event', 'per_event', NULL, NULL,
  'voce', 'voce_faz',
  'Calcula os valores de férias + 1/3 constitucional e alerta o prazo do aviso',
  'Comunicar e registrar as férias no eSocial', '10 min', 0, 140
),
(
  'mei', true, 'general', 'DECIMO_TERCEIRO',
  '13º salário — 1ª e 2ª parcela',
  '1ª parcela em novembro, 2ª parcela até 20/dezembro',
  'annual', 'nov_dec', NULL, NULL,
  'aura', 'aura_resolve',
  'Calcula as duas parcelas do 13º e alerta os prazos automaticamente',
  NULL, NULL, 0, 150
),
(
  'mei', true, 'general', 'DASN_SIMEI_FUNC',
  'DASN-SIMEI com funcionário — Declaração anual',
  'Declaração anual inclui o funcionário. Vence 31/05.',
  'annual', 'may_31', 5, 31,
  'voce', 'voce_faz',
  'Consolida o faturamento do ano e os dados do funcionário, abre portal pré-preenchido',
  'Revisar os dados e confirmar a transmissão no portal', '5 min', 5, 160
),

-- ── ME / SIMPLES NACIONAL (6 itens) ───────────────────────

(
  'simples_nacional', NULL, 'general', 'DAS_SN',
  'DAS — Guia mensal do Simples Nacional',
  'Estimativa do DAS mensal com base na receita bruta e faturamento acumulado 12 meses',
  'monthly', 'day_20', NULL, 20,
  'aura', 'aura_resolve',
  'Estima o DAS com base no faturamento e gera QR Code para referência (valor informativo)',
  NULL, NULL, 3, 210
),
(
  'simples_nacional', NULL, 'general', 'PGDAS_D',
  'PGDAS-D — Apuração mensal do Simples Nacional',
  'Apuração oficial da receita bruta por anexo e geração do DAS. Vence dia 20.',
  'monthly', 'day_20', NULL, 20,
  'voce', 'voce_faz',
  'Segrega suas receitas por anexo do Simples e pré-preenche o portal para você',
  'Acessar o Portal do Simples Nacional e confirmar a apuração', '10 min', 3, 220
),
(
  'simples_nacional', NULL, 'general', 'DEFIS',
  'DEFIS — Declaração anual do Simples Nacional',
  'Declaração de Informações Socioeconômicas e Fiscais. Vence 31/03.',
  'annual', 'mar_31', 3, 31,
  'voce', 'voce_faz',
  'Consolida todo o histórico do ano e pré-preenche a DEFIS no portal',
  'Revisar os dados e confirmar a transmissão no Portal do Simples Nacional', '15 min', 5, 230
),
(
  'simples_nacional', NULL, 'general', 'NFE_SN',
  'NF-e / NFS-e — Nota fiscal automática',
  'Emissão automática de nota fiscal em toda venda para pessoa jurídica',
  'per_event', 'per_event', NULL, NULL,
  'aura', 'aura_resolve',
  'Emite a nota fiscal automaticamente a cada venda registrada para PJ',
  NULL, NULL, 0, 240
),
(
  'simples_nacional', NULL, 'general', 'IRPF_SOCIOS',
  'IRPF — Imposto de Renda dos sócios',
  'Declaração anual de IR dos sócios com base na distribuição de lucros e pró-labore. Vence abril.',
  'annual', 'apr_30', 4, 30,
  'voce', 'voce_faz',
  'Alerta os sócios e gera relatório detalhado de retiradas, pró-labore e lucros do ano',
  'Cada sócio declara individualmente no site da Receita Federal', NULL, 0, 250
),
(
  'simples_nacional', NULL, 'general', 'FATOR_R',
  'Fator R — Monitoramento de pró-labore',
  'Manter pró-labore ≥ 28% do faturamento para permanecer no Anexo III (alíquota menor)',
  'continuous', 'continuous', NULL, NULL,
  'aura', 'aura_resolve',
  'Monitora continuamente a relação pró-labore × faturamento e alerta se o Fator R cair abaixo de 28%',
  NULL, NULL, 0, 260
);
