-- ============================================================
-- Migration 011 — Guia Fiscal Assistido
-- Feature: BE-26
-- Criado em: 24/03/2026
-- ============================================================
-- Armazena configurações dos guias passo a passo para
-- transmissão das obrigações fiscais (DASN-SIMEI, PGDAS-D,
-- DEFIS, eSocial). Permite atualização sem deploy de código.
-- ============================================================

-- Tabela principal: configuração de cada guia
CREATE TABLE IF NOT EXISTS guide_configs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT UNIQUE NOT NULL,          -- 'pgdas_d', 'dasn_simei', 'defis', 'esocial'
  title           TEXT NOT NULL,                  -- 'PGDAS-D — Apuração Mensal'
  subtitle        TEXT,                           -- 'Competência {period}'
  obligation_type TEXT NOT NULL,                  -- 'mei' | 'me' | 'both'
  deep_link       TEXT NOT NULL,                  -- URL do portal gov.br
  version         TEXT NOT NULL DEFAULT '1.0',    -- '2026-03-01' para rastrear mudanças
  is_active       BOOLEAN NOT NULL DEFAULT true,
  fallback_mode   BOOLEAN NOT NULL DEFAULT false, -- true = mostra só valores, sem screenshots
  -- steps: array JSONB com estrutura:
  -- { id, title, instruction, screenshot_url, annotation: {x,y,w,h},
  --   value_key (FK para valor calculado), deep_link_step (URL direta ao passo) }
  steps           JSONB NOT NULL DEFAULT '[]',
  -- Valores que o backend injeta dinamicamente (chaves dos campos calculados)
  value_keys      TEXT[] NOT NULL DEFAULT '{}',   -- ['receita_comercio', 'receita_servicos']
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índice para busca por tipo de obrigação (filtrar por regime do cliente)
CREATE INDEX IF NOT EXISTS idx_guide_configs_obligation_type
  ON guide_configs (obligation_type);

-- Completions: registra quando um cliente concluiu um guia para um período
CREATE TABLE IF NOT EXISTS guide_completions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  guide_slug  TEXT NOT NULL REFERENCES guide_configs(slug) ON DELETE CASCADE,
  period      TEXT NOT NULL,    -- 'anual-2025' | 'mensal-2026-02'
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  receipt_url  TEXT,            -- upload do comprovante (opcional)
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, guide_slug, period)
);

CREATE INDEX IF NOT EXISTS idx_guide_completions_company
  ON guide_completions (company_id, guide_slug);

-- Stale reports: cliente reporta que um passo está desatualizado
CREATE TABLE IF NOT EXISTS guide_stale_reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_slug  TEXT NOT NULL REFERENCES guide_configs(slug) ON DELETE CASCADE,
  step_id     TEXT NOT NULL,     -- ID do passo que mudou
  company_id  UUID REFERENCES companies(id) ON DELETE SET NULL,
  notes       TEXT,              -- descrição do que mudou (opcional)
  resolved    BOOLEAN NOT NULL DEFAULT false,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guide_stale_reports_resolved
  ON guide_stale_reports (resolved, guide_slug);

-- Trigger: atualiza updated_at automaticamente
CREATE OR REPLACE FUNCTION update_guide_configs_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guide_configs_updated_at
  BEFORE UPDATE ON guide_configs
  FOR EACH ROW EXECUTE FUNCTION update_guide_configs_updated_at();

-- ============================================================
-- SEED — 4 guias fiscais iniciais
-- Screenshots são placeholders (serão substituídos pelo admin)
-- ============================================================

INSERT INTO guide_configs (
  slug, title, subtitle, obligation_type, deep_link, version,
  value_keys, steps, notes
) VALUES

-- 1. DASN-SIMEI (MEI apenas)
(
  'dasn_simei',
  'DASN-SIMEI — Declaração Anual do MEI',
  'Ano-calendário {year}',
  'mei',
  'https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/dasnsimei.app/',
  '2026-03-24',
  ARRAY['faturamento_comercio_anual', 'faturamento_servicos_anual', 'teve_funcionario'],
  '[
    {
      "id": "acesso_portal",
      "title": "Acessar o portal",
      "instruction": "Clique no botão abaixo para abrir a DASN-SIMEI. Faça login com seu CNPJ e código de acesso, ou com a conta Gov.br.",
      "screenshot_url": null,
      "annotation": null,
      "value_key": null,
      "deep_link_step": "https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/dasnsimei.app/"
    },
    {
      "id": "selecionar_ano",
      "title": "Selecionar o ano-calendário",
      "instruction": "Na tela inicial, selecione o ano {year} no campo Ano-Calendário e clique em Continuar.",
      "screenshot_url": null,
      "annotation": null,
      "value_key": null
    },
    {
      "id": "faturamento_comercio",
      "title": "Informar receita de comércio e indústria",
      "instruction": "No campo Receita de Comércio e Indústria, insira o valor total do ano. Se não teve vendas de produtos, deixe 0,00.",
      "screenshot_url": null,
      "annotation": null,
      "value_key": "faturamento_comercio_anual"
    },
    {
      "id": "faturamento_servicos",
      "title": "Informar receita de prestação de serviços",
      "instruction": "No campo Receita de Prestação de Serviços, insira o valor total do ano.",
      "screenshot_url": null,
      "annotation": null,
      "value_key": "faturamento_servicos_anual"
    },
    {
      "id": "funcionario",
      "title": "Informar se teve funcionário",
      "instruction": "Indique se você teve funcionário em algum mês do ano {year}. Se sim, informe o período.",
      "screenshot_url": null,
      "annotation": null,
      "value_key": "teve_funcionario"
    },
    {
      "id": "transmitir",
      "title": "Revisar e transmitir",
      "instruction": "Confira os valores na tela de resumo. Se estiverem corretos, clique em Transmitir. Salve o número do recibo!",
      "screenshot_url": null,
      "annotation": null,
      "value_key": null
    }
  ]'::jsonb,
  'Prazo: 31 de maio de cada ano. Obrigatório mesmo com faturamento zero.'
),

-- 2. PGDAS-D (ME/EPP)
(
  'pgdas_d',
  'PGDAS-D — Apuração Mensal do Simples Nacional',
  'Competência {month}/{year}',
  'me',
  'https://www8.receita.fazenda.gov.br/SimplesNacional/',
  '2026-03-24',
  ARRAY['receita_comercio', 'receita_servicos', 'fator_r', 'fator_r_percentual', 'anexo_servicos', 'iss_retido', 'valor_das_estimado'],
  '[
    {
      "id": "acesso_portal",
      "title": "Acessar o PGDAS-D",
      "instruction": "Clique no botão abaixo para abrir o portal. Acesse Declaração Mensal → Declarar/Retificar. Selecione a competência {month}/{year}.",
      "screenshot_url": null,
      "annotation": null,
      "value_key": null,
      "deep_link_step": "https://www8.receita.fazenda.gov.br/SimplesNacional/"
    },
    {
      "id": "receita_comercio",
      "title": "Informar receita de comércio",
      "instruction": "No campo Comércio, Indústria e demais atividades, insira o valor abaixo. Se não houve, coloque 0,00.",
      "screenshot_url": null,
      "annotation": null,
      "value_key": "receita_comercio"
    },
    {
      "id": "receita_servicos",
      "title": "Informar receita de serviços",
      "instruction": "No campo Prestação de Serviços, insira o valor abaixo.",
      "screenshot_url": null,
      "annotation": null,
      "value_key": "receita_servicos"
    },
    {
      "id": "fator_r_verificacao",
      "title": "Verificar Fator R e anexo aplicado",
      "instruction": "O sistema vai calcular automaticamente o Fator R. Verifique se suas atividades de serviço estão no Anexo correto.",
      "screenshot_url": null,
      "annotation": null,
      "value_key": "fator_r_percentual"
    },
    {
      "id": "iss_retido",
      "title": "Informar ISS retido na fonte (se houver)",
      "instruction": "Se algum cliente reteve ISS ao pagar suas notas de serviço, informe o valor total aqui. Isso reduz o DAS.",
      "screenshot_url": null,
      "annotation": null,
      "value_key": "iss_retido"
    },
    {
      "id": "transmitir",
      "title": "Gerar e pagar o DAS",
      "instruction": "Clique em Calcular para gerar o DAS. Confira o valor — deve ser próximo de {valor_das_estimado}. Clique em Gerar DAS e efetue o pagamento até o dia 20.",
      "screenshot_url": null,
      "annotation": null,
      "value_key": "valor_das_estimado"
    }
  ]'::jsonb,
  'Prazo: dia 20 do mês seguinte. Multa a partir do 1º dia de atraso desde jan/2026.'
),

-- 3. DEFIS (ME/EPP — dentro do PGDAS-D)
(
  'defis',
  'DEFIS — Declaração Anual de Informações do Simples',
  'Ano-calendário {year}',
  'me',
  'https://www8.receita.fazenda.gov.br/SimplesNacional/',
  '2026-03-24',
  ARRAY['faturamento_anual_comercio', 'faturamento_anual_servicos', 'media_funcionarios', 'socios'],
  '[
    {
      "id": "acesso_portal",
      "title": "Acessar o PGDAS-D → DEFIS",
      "instruction": "A DEFIS está dentro do portal do Simples Nacional. Acesse o link abaixo, entre com suas credenciais e clique em DEFIS no menu principal.",
      "screenshot_url": null,
      "annotation": null,
      "value_key": null,
      "deep_link_step": "https://www8.receita.fazenda.gov.br/SimplesNacional/"
    },
    {
      "id": "selecionar_ano",
      "title": "Selecionar o ano-calendário",
      "instruction": "Na tela do DEFIS, selecione o ano {year} no campo Ano-Calendário e clique em Avançar.",
      "screenshot_url": null,
      "annotation": null,
      "value_key": null
    },
    {
      "id": "receita_anual",
      "title": "Informar receita bruta anual por tipo",
      "instruction": "Informe os totais anuais separados por tipo de atividade. Use os valores abaixo calculados pela Aura.",
      "screenshot_url": null,
      "annotation": null,
      "value_key": "faturamento_anual_comercio"
    },
    {
      "id": "funcionarios",
      "title": "Informar dados de funcionários",
      "instruction": "Informe a média de funcionários por mês. Se não teve funcionários, coloque 0 em todos os meses.",
      "screenshot_url": null,
      "annotation": null,
      "value_key": "media_funcionarios"
    },
    {
      "id": "socios",
      "title": "Confirmar dados dos sócios",
      "instruction": "Verifique se os dados dos sócios estão corretos (nome, CPF, participação). Se a empresa é Unipessoal, aparece apenas o titular.",
      "screenshot_url": null,
      "annotation": null,
      "value_key": null
    },
    {
      "id": "transmitir",
      "title": "Revisar e transmitir",
      "instruction": "Confira o resumo e clique em Transmitir. Salve o número do recibo da DEFIS.",
      "screenshot_url": null,
      "annotation": null,
      "value_key": null
    }
  ]'::jsonb,
  'Prazo: 31 de março. Multa mínima R$500 por atraso — iniciar alertas a partir de janeiro.'
),

-- 4. eSocial MEI/ME
(
  'esocial_admissao',
  'eSocial — Registro de Funcionário',
  'Admissão antes do 1º dia de trabalho',
  'both',
  'https://login.esocial.gov.br/login.aspx',
  '2026-03-24',
  ARRAY['nome_funcionario', 'cpf_funcionario', 'data_admissao', 'salario', 'cargo'],
  '[
    {
      "id": "alerta_prazo",
      "title": "⚠ Atenção: registre ANTES do 1º dia de trabalho",
      "instruction": "A admissão no eSocial precisa ser feita antes do primeiro dia de trabalho do funcionário. Fazer depois pode gerar multa e passivo trabalhista.",
      "screenshot_url": null,
      "annotation": null,
      "value_key": null
    },
    {
      "id": "acesso_portal",
      "title": "Acessar o eSocial",
      "instruction": "Clique no link abaixo e faça login com sua conta Gov.br. MEI e ME com até 1 funcionário não precisam de certificado digital.",
      "screenshot_url": null,
      "annotation": null,
      "value_key": null,
      "deep_link_step": "https://login.esocial.gov.br/login.aspx"
    },
    {
      "id": "cadastro_empregado",
      "title": "Cadastrar o funcionário (S-2200)",
      "instruction": "Acesse Tabelas → Trabalhadores → Incluir. Preencha o CPF e os dados do funcionário.",
      "screenshot_url": null,
      "annotation": null,
      "value_key": "cpf_funcionario"
    },
    {
      "id": "dados_admissao",
      "title": "Informar dados de admissão",
      "instruction": "Preencha: data de admissão, cargo, salário, jornada de trabalho e tipo de contrato (prazo indeterminado é o mais comum).",
      "screenshot_url": null,
      "annotation": null,
      "value_key": "data_admissao"
    },
    {
      "id": "transmitir",
      "title": "Enviar e confirmar",
      "instruction": "Clique em Enviar. O sistema vai confirmar o recebimento. Salve o recibo de protocolo.",
      "screenshot_url": null,
      "annotation": null,
      "value_key": null
    }
  ]'::jsonb,
  'MEI sem funcionário: não precisa do eSocial. Certificado digital só obrigatório para ME com 2+ funcionários.'
)
ON CONFLICT (slug) DO NOTHING;
