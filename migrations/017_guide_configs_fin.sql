-- ============================================================
-- AURA. — Migration 017: GUIDE-01 — Novos Guias Financeiros
-- pro_labore | fator_r | irpf_mei
-- Aplicar manualmente no Supabase SQL Editor
-- ============================================================

INSERT INTO guide_configs (
  slug, title, subtitle, obligation_type, deep_link, version,
  category, module, complexity, estimated_minutes, sort_order,
  plan_required, value_keys, steps, notes
) VALUES

-- ── 1. PRÓ-LABORE ────────────────────────────────────
(
  'pro_labore',
  'Calcular e registrar o pró-labore',
  'Quanto você pode retirar do negócio este mês',
  'both',
  'https://app.getaura.com.br/financeiro',
  '2026-03-26',
  'fiscal', 'financeiro', 'medium', 10, 10,
  'negocio',
  ARRAY['valor_prolabore_sugerido','inss_prolabore','valor_liquido','fator_r_percentual','anexo_resultado'],
  '[{
    "id": "o_que_e",
    "title": "O que é pró-labore e por que importa",
    "instruction": "Pró-labore é o salário do sócio-administrador — diferente da distribuição de lucros. No Simples Nacional, o valor do pró-labore afeta diretamente o Fator R: se ele for alto o suficiente (28% do faturamento dos últimos 12 meses), você fica no Anexo III e paga menos imposto. Se for baixo, migra para o Anexo V e paga mais.",
    "screenshot_url": null,
    "value_key": null
  },{
    "id": "verificar_fator_r",
    "title": "Ver o Fator R atual da Aura",
    "instruction": "A Aura calculou abaixo o Fator R atual com base nos seus lan\u00e7amentos dos \u00faltimos 12 meses. Se estiver abaixo de 28%, a sugest\u00e3o de pr\u00f3-labore j\u00e1 considera o valor necess\u00e1rio para subir ao Anexo III.",
    "screenshot_url": null,
    "value_key": "fator_r_percentual"
  },{
    "id": "calcular_inss",
    "title": "INSS sobre o pr\u00f3-labore (obrigat\u00f3rio)",
    "instruction": "O s\u00f3cio-administrador que retira pr\u00f3-labore precisa pagar INSS sobre esse valor (11%, com teto de R$\u00a07.786,02 em 2026). A Aura j\u00e1 descontou esse valor no c\u00e1lculo abaixo. O INSS do s\u00f3cio \u00e9 pago pela pr\u00f3pria empresa via GPS ou via folha.",
    "screenshot_url": null,
    "value_key": "inss_prolabore"
  },{
    "id": "registrar_aura",
    "title": "Registrar o pr\u00f3-labore na Aura",
    "instruction": "Acesse Financeiro \u2192 Pr\u00f3-labore e informe o valor que voc\u00ea vai retirar este m\u00eas. A Aura registra no hist\u00f3rico, atualiza o Fator R e lan\u00e7a automaticamente como despesa no financeiro do m\u00eas.",
    "screenshot_url": null,
    "value_key": "valor_prolabore_sugerido",
    "deep_link_step": "https://app.getaura.com.br/financeiro"
  },{
    "id": "lucros",
    "title": "O que sobra pode ser distribui\u00e7\u00e3o de lucros",
    "instruction": "Al\u00e9m do pr\u00f3-labore, voc\u00ea pode distribuir lucros — e sobre essa parte n\u00e3o incide INSS nem IRRF. Veja em Financeiro \u2192 Distribui\u00e7\u00e3o de Lucros o valor que a Aura calculou como dispon\u00edvel ap\u00f3s reservas.",
    "screenshot_url": null,
    "value_key": "valor_liquido"
  }]'::jsonb,
  'INSS obrigatório sobre o pró-labore: 11% (teto R$7.786,02 em 2026). Pró-labore ≠ distribuição de lucros.'
),

-- ── 2. FATOR R ─────────────────────────────────────────
(
  'fator_r',
  'Entender e otimizar o Fator R',
  'Reduza o imposto pagando a alíquota mínima (~6%)',
  'me',
  'https://app.getaura.com.br/financeiro',
  '2026-03-26',
  'fiscal', 'financeiro', 'medium', 15, 11,
  'negocio',
  ARRAY['fator_r_percentual','fator_r_gap','anexo_resultado','valor_prolabore_sugerido','economia_mensal_estimada'],
  '[{
    "id": "o_que_e",
    "title": "O que \u00e9 o Fator R",
    "instruction": "Fator R = Folha de pagamento (incluindo pr\u00f3-labore) dos \u00faltimos 12 meses \u00f7 Faturamento bruto dos \u00faltimos 12 meses. Se o resultado for 28% ou mais, sua empresa de servi\u00e7os fica no Anexo III (al\u00edquota inicial ~6%). Se for abaixo, fica no Anexo V (al\u00edquota inicial ~15,5%).",
    "screenshot_url": null,
    "value_key": null
  },{
    "id": "fator_r_atual",
    "title": "Fator R da sua empresa agora",
    "instruction": "A Aura calculou abaixo o Fator R atual com base nos seus lan\u00e7amentos. Se estiver abaixo de 28%, veja o passo a seguir para saber quanto pr\u00f3-labore aumentar para chegar ao Anexo III.",
    "screenshot_url": null,
    "value_key": "fator_r_percentual"
  },{
    "id": "quanto_aumentar",
    "title": "Quanto aumentar o pr\u00f3-labore",
    "instruction": "Para subir ao Anexo III, voc\u00ea precisa que o pr\u00f3-labore dos \u00faltimos 12 meses represente pelo menos 28% do seu faturamento no mesmo per\u00edodo. A Aura calculou abaixo o valor sugerido para este m\u00eas. Aten\u00e7\u00e3o: aumentar o pr\u00f3-labore eleva o INSS do s\u00f3cio (11%). O ganho l\u00edquido costuma ser positivo se o faturamento for acima de R$25.000/m\u00eas.",
    "screenshot_url": null,
    "value_key": "valor_prolabore_sugerido"
  },{
    "id": "economia",
    "title": "Economia estimada ao migrar para o Anexo III",
    "instruction": "A diferen\u00e7a entre o Anexo III (~6%) e o Anexo V (~15,5%) pode ser significativa. A Aura estimou abaixo quanto voc\u00ea economizaria por m\u00eas no DAS se j\u00e1 estivesse no Anexo III.",
    "screenshot_url": null,
    "value_key": "economia_mensal_estimada"
  },{
    "id": "aplicar",
    "title": "Como aplicar a mudan\u00e7a",
    "instruction": "1. Acesse Financeiro \u2192 Pr\u00f3-labore e ajuste o valor para o sugerido acima. 2. Registre o pr\u00f3-labore mensalmente. 3. Em 1 a 3 meses, o Fator R sobe e voc\u00ea muda de Anexo automaticamente na pr\u00f3xima apura\u00e7\u00e3o do PGDAS-D. Importante: esta mudan\u00e7a \u00e9 gradual \u2014 o Fator R \u00e9 calculado sempre nos \u00faltimos 12 meses.",
    "screenshot_url": null,
    "value_key": null,
    "deep_link_step": "https://app.getaura.com.br/financeiro"
  }]'::jsonb,
  'Fator R só afeta empresas de serviços no Simples Nacional. Comércio sempre fica no Anexo I. A mudança de Anexo é gradual (12 meses móveis).'
),

-- ── 3. IRPF DO TITULAR MEI ─────────────────────────────
(
  'irpf_mei',
  'Declarar o Imposto de Renda Pessoa Física (MEI)',
  'Vencimento: 31/05 de cada ano',
  'mei',
  'https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda',
  '2026-03-26',
  'fiscal', 'contabilidade', 'high', 30, 5,
  NULL,
  ARRAY['rendimentos_isentos','rendimentos_tributaveis','obrigado_declarar','limite_rendimento'],
  '[{
    "id": "quem_precisa_declarar",
    "title": "Quem precisa declarar?",
    "instruction": "O MEI normalmente n\u00e3o precisa declarar IRPF s\u00f3 por ter empresa. Mas como pessoa f\u00edsica, voc\u00ea precisa declarar se: (1) Rendimentos tribut\u00e1veis (sal\u00e1rio, aluguel, etc.) acima de R$33.888,00 em 2025. (2) Rendimentos isentos (lucros do MEI) acima de R$200.000,00. (3) Teve bens acima de R$800.000,00. (4) Operou na bolsa de valores.",
    "screenshot_url": null,
    "value_key": "obrigado_declarar"
  },{
    "id": "lucros_isentos",
    "title": "Lucros do MEI s\u00e3o isentos (com limite)",
    "instruction": "Os lucros que voc\u00ea retira do MEI s\u00e3o isentos de IR at\u00e9 um valor calculado sobre o faturamento: 8% para com\u00e9rcio e ind\u00fastria, 16% para transporte de carga, 32% para servi\u00e7os. O restante \u00e9 consider\u00e9 rendimento tribut\u00e1vel. Exemplo: MEI de servi\u00e7os com R$81.000 de faturamento \u2192 at\u00e9 R$25.920 isentos (32%).",
    "screenshot_url": null,
    "value_key": "rendimentos_isentos"
  },{
    "id": "documentos",
    "title": "Documentos necess\u00e1rios",
    "instruction": "Separe antes de abrir o programa: (1) CPF e dados pessoais. (2) DASN-SIMEI do ano anterior (mostra o faturamento). (3) Informes de rendimentos de outros empregos ou bancos. (4) Notas de bens (im\u00f3veis, ve\u00edculos) comprados ou vendidos no ano. (5) Recibos m\u00e9dicos e de escola (se quiser deduzir).",
    "screenshot_url": null,
    "value_key": null
  },{
    "id": "baixar_programa",
    "title": "Baixar o Programa do IR da Receita Federal",
    "instruction": "Acesse o link abaixo para baixar o Programa Gerador da Declara\u00e7\u00e3o (PGD) do ano correspondente. Instale no computador (Windows ou Mac). A declara\u00e7\u00e3o n\u00e3o pode ser feita pelo celular.",
    "screenshot_url": null,
    "value_key": null,
    "deep_link_step": "https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda"
  },{
    "id": "preencher",
    "title": "O que preencher no programa",
    "instruction": "No programa, voc\u00ea vai informar: (A) Rendimentos isentos \u2192 Aba Rendimentos Isentos \u2192 Lucros e dividendos recebidos pelo titular da MEI. (B) Bens \u2192 Informe CNPJ e valor do MEI. (C) D\u00edvidas? Seu analista Aura pode orientar, mas a transmiss\u00e3o \u00e9 sua responsabilidade ou de um contador.",
    "screenshot_url": null,
    "value_key": "rendimentos_isentos"
  },{
    "id": "transmitir",
    "title": "Transmitir e guardar o recibo",
    "instruction": "Clique em Entregar Declara\u00e7\u00e3o no programa. Anote o n\u00famero do recibo \u2014 ele \u00e9 a prova de envio. O prazo \u00e9 31/05. Quem atrasa paga multa m\u00ednima de R$165,74.",
    "screenshot_url": null,
    "value_key": null
  }]'::jsonb,
  'A Aura NUNCA transmite o IRPF — essa é uma obrigação pessoal do titular ou de um contador. Este guia é apenas orientativo. Multa por atraso: mínimo R$165,74.'
)
ON CONFLICT (slug) DO NOTHING;

-- Total de guias após esta migration: 18
-- Novos: pro_labore, fator_r, irpf_mei
-- esocial_demissao já existia na 011b
