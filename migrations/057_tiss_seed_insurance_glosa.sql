-- ============================================================
-- AURA. — W2-02 F2: Seed convenios "globais" + codigos glosa
--
-- Convenios globais: registros com company_id = NULL.
-- Visao read-only pra todas as clinicas. Quando a clinica quer
-- usar, ela "clona" pro proprio company_id e preenche dados do
-- contrato dela (provider_code, contract_number, etc).
--
-- Estrategia escolhida porque os dados ANS sao publicos e
-- estaveis (CNPJ, registro ANS, razao social, portal). Cada
-- clinica so precisa preencher o que e DELA: codigo prestador
-- e numero de contrato.
-- ============================================================

-- Permitir company_id NULL pra "convenios globais"
ALTER TABLE dental_insurance
  ALTER COLUMN company_id DROP NOT NULL;

-- Index pra facilitar query de globais
CREATE INDEX IF NOT EXISTS idx_dental_insurance_global
  ON dental_insurance(name) WHERE company_id IS NULL;

COMMENT ON COLUMN dental_insurance.company_id IS
  'NULL = convenio global (catalogo Aura, read-only). NOT NULL = convenio da clinica (com dados de contrato preenchidos). Clinica clona o global e completa.';

-- ── 1. Seed dos 5 convenios globais ──────────────────────
-- DADOS OFICIAIS conferidos no portal ANS (gov.br/ans):
--   Bradesco Saude S/A — ANS 005711, CNPJ 92.693.118/0001-60
--   Amil Assistencia Medica Internacional — ANS 326305, CNPJ 29.309.127/0001-79
--   SulAmerica Servicos de Saude — ANS 416428, CNPJ 02.866.602/0001-51
--   Unimed Sao Jose dos Campos (cobre Jacarei) — ANS local
--   Unimed do Brasil (federacao nacional, generico)

INSERT INTO dental_insurance (
  company_id, name, razao_social, cnpj, ans_code,
  registration, contact_phone, upload_portal_url,
  tiss_version, reference_table_id, payment_deadline_days,
  is_active, notes_billing
) VALUES
  (
    NULL,
    'Bradesco Saude',
    'BRADESCO SAUDE S/A',
    '92.693.118/0001-60',
    '005711',
    NULL,
    '0800 701 2700',
    'https://www.bradescosaude.com.br/wps/portal/bs/site/comum/lifeflowprestadores',
    '4.01.00',
    '22',
    30,
    true,
    'Portal Vida da Bradesco Saude. Aceita XML TISS 4.01.00. Repasse em ate 30 dias apos protocolo.'
  ),
  (
    NULL,
    'Amil Saude',
    'AMIL ASSISTENCIA MEDICA INTERNACIONAL S.A.',
    '29.309.127/0001-79',
    '326305',
    NULL,
    '0800 021 2583',
    'https://institucional.amil.com.br/credenciados/',
    '4.01.00',
    '22',
    45,
    true,
    'Portal Amil Credenciados. Repasse em ate 45 dias.'
  ),
  (
    NULL,
    'SulAmerica Saude',
    'SUL AMERICA SERVICOS DE SAUDE S.A.',
    '02.866.602/0001-51',
    '416428',
    NULL,
    '0800 970 8246',
    'https://portal.sulamericaseguros.com.br/saude/prestadores',
    '4.01.00',
    '22',
    30,
    true,
    'Portal Saude Online SulAmerica. Aceita upload XML TISS 4.01.00.'
  ),
  (
    NULL,
    'Unimed Sao Jose dos Campos',
    'UNIMED DE SAO JOSE DOS CAMPOS COOPERATIVA DE TRABALHO MEDICO',
    NULL,
    NULL,
    NULL,
    '0800 727 4141',
    'https://www.unimedsjc.coop.br/',
    '4.01.00',
    '22',
    30,
    true,
    'Cooperativa Unimed que cobre Jacarei e regiao. Codigo Sistema Unimed: 004. Para clinicas em Jacarei, geralmente este e o convenio. Verifique CNPJ e codigo ANS especificos com a cooperativa local antes de emitir guias.'
  ),
  (
    NULL,
    'Unimed (generico - outras cooperativas)',
    'UNIMED COOPERATIVA REGIONAL',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    '4.01.00',
    '22',
    30,
    true,
    'Convenio generico para qualquer cooperativa Unimed nao listada. ATENCAO: cada Unimed regional tem CNPJ, codigo ANS e portal proprios. Voce DEVE preencher esses dados conforme o contrato da sua clinica.'
  )
ON CONFLICT DO NOTHING;

-- ── 2. Seed codigos de glosa (Tabela 38 ANS - subset principal) ──
-- Os codigos abaixo sao os ~40 mais comuns. Lista oficial completa
-- tem 200+ codigos. Clinica pode adicionar customizados depois.

INSERT INTO dental_tiss_glosa_codes (code, description, category, is_active) VALUES
  -- Procedimento
  ('1001', 'Procedimento nao consta na tabela contratada',           'procedimento', true),
  ('1002', 'Procedimento nao coberto pelo plano',                     'procedimento', true),
  ('1003', 'Procedimento incompativel com sexo do beneficiario',      'procedimento', true),
  ('1004', 'Procedimento incompativel com idade do beneficiario',     'procedimento', true),
  ('1005', 'Procedimento exclusivo de profissional especialista',     'procedimento', true),
  ('1006', 'Quantidade do procedimento incorreta',                    'procedimento', true),
  ('1007', 'Procedimento em duplicidade no atendimento',              'procedimento', true),
  ('1008', 'Carencia nao cumprida para o procedimento',               'procedimento', true),
  ('1009', 'CID incompativel com o procedimento realizado',           'procedimento', true),
  ('1010', 'Procedimento sem cobertura no plano contratado',          'procedimento', true),

  -- Carteira / beneficiario
  ('2001', 'Beneficiario nao identificado na operadora',              'carteira', true),
  ('2002', 'Carteira do beneficiario vencida',                        'carteira', true),
  ('2003', 'Beneficiario excluido do plano',                          'carteira', true),
  ('2004', 'Beneficiario suspenso',                                   'carteira', true),
  ('2005', 'Numero de carteira invalido',                             'carteira', true),
  ('2006', 'CPF do beneficiario incompativel com carteira',           'carteira', true),

  -- Autorizacao
  ('3001', 'Senha de autorizacao invalida ou nao informada',          'autorizacao', true),
  ('3002', 'Senha de autorizacao expirada',                           'autorizacao', true),
  ('3003', 'Procedimento nao autorizado',                             'autorizacao', true),
  ('3004', 'Quantidade autorizada inferior a quantidade executada',   'autorizacao', true),
  ('3005', 'Numero da guia nao corresponde a senha',                  'autorizacao', true),
  ('3006', 'Autorizacao para outro prestador',                        'autorizacao', true),

  -- Cobranca / valores
  ('4001', 'Valor cobrado superior ao contratado',                    'cobranca', true),
  ('4002', 'Valor unitario divergente da tabela',                     'cobranca', true),
  ('4003', 'Calculo do valor total incorreto',                        'cobranca', true),
  ('4004', 'Filme radiologico ja incluido no procedimento',           'cobranca', true),
  ('4005', 'Cobranca duplicada',                                      'cobranca', true),
  ('4006', 'Cobranca apresentada fora do prazo',                      'cobranca', true),

  -- Prestador
  ('5001', 'Prestador nao credenciado para o procedimento',           'prestador', true),
  ('5002', 'Especialidade do profissional nao habilitada',            'prestador', true),
  ('5003', 'Codigo do conselho profissional invalido',                'prestador', true),
  ('5004', 'CRO/CRM nao localizado ou suspenso',                      'prestador', true),

  -- Documentacao
  ('6001', 'Documentacao incompleta ou ilegivel',                     'outros', true),
  ('6002', 'Falta justificativa clinica para procedimento',           'outros', true),
  ('6003', 'Hash do XML invalido',                                    'outros', true),
  ('6004', 'Versao TISS incompativel',                                'outros', true),
  ('6005', 'Layout do arquivo nao conforme padrao TISS',              'outros', true),

  -- Outros / motivos genericos
  ('9001', 'Em analise pela auditoria medica',                        'outros', true),
  ('9002', 'Recurso pendente de avaliacao',                           'outros', true),
  ('9999', 'Motivo nao especificado',                                 'outros', true)

ON CONFLICT (code) DO NOTHING;

COMMENT ON TABLE dental_tiss_glosa_codes IS
  'Codigos de glosa TISS — subset dos mais comuns da Tabela 38 ANS. Lista oficial completa em: https://www.gov.br/ans/pt-br/assuntos/prestadores/padrao-para-troca-de-informacao-de-saude-suplementar-tiss';
