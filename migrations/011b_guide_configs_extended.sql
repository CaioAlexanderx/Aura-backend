-- ============================================================
-- Migration 011b — Guia Assistido Universal
-- Feature: BE-26 (extensão) + BE-29 (eSocial ME)
-- Criado em: 24/03/2026
-- fix(B-03): ARRAY[] → ARRAY[]::text[] para evitar erro de tipo em PG
-- ============================================================

ALTER TABLE guide_configs
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'fiscal',
  ADD COLUMN IF NOT EXISTS module TEXT NOT NULL DEFAULT 'contabilidade',
  ADD COLUMN IF NOT EXISTS plan_required TEXT,
  ADD COLUMN IF NOT EXISTS complexity TEXT NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS estimated_minutes INT NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 99;

CREATE INDEX IF NOT EXISTS idx_guide_configs_category ON guide_configs (category, is_active);
CREATE INDEX IF NOT EXISTS idx_guide_configs_module   ON guide_configs (module, is_active);

UPDATE guide_configs SET category='fiscal',      module='contabilidade', complexity='low',    estimated_minutes=5,  sort_order=1 WHERE slug='dasn_simei';
UPDATE guide_configs SET category='fiscal',      module='contabilidade', complexity='medium', estimated_minutes=10, sort_order=2 WHERE slug='pgdas_d';
UPDATE guide_configs SET category='fiscal',      module='contabilidade', complexity='medium', estimated_minutes=15, sort_order=3 WHERE slug='defis';
UPDATE guide_configs SET category='trabalhista', module='folha',         complexity='low',    estimated_minutes=10, sort_order=1 WHERE slug='esocial_admissao';

INSERT INTO guide_configs (
  slug, title, subtitle, obligation_type, deep_link, version,
  category, module, complexity, estimated_minutes, sort_order,
  plan_required, value_keys, steps, notes
) VALUES
(
  'esocial_admissao_me',
  'Registro de novo funcionário',
  'Deve ser feito antes do 1° dia de trabalho',
  'me', 'https://login.esocial.gov.br/login.aspx', '2026-03-24',
  'trabalhista', 'folha', 'high', 20, 2, 'negocio',
  ARRAY['nome_funcionario','cpf_funcionario','data_admissao','salario','cargo','jornada'],
  '[{"id":"alerta_prazo","title":"Registre antes do primeiro dia de trabalho","instruction":"O registro do funcionário no sistema do governo precisa ser feito antes de ele começar a trabalhar. Se deixar para depois, sua empresa fica sujeita a multa de R$3.000 por trabalhador.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"certificado","title":"Separar o certificado digital da empresa","instruction":"Para acessar o sistema do governo com 2 ou mais funcionários, você precisa do certificado digital da empresa (e-CNPJ). Se ainda não tem, veja o guia de como obter antes de continuar.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"acesso_portal","title":"Acessar o eSocial Empresarial","instruction":"Clique no botão abaixo para abrir o sistema. Faça login usando o certificado digital da empresa (e-CNPJ).","screenshot_url":null,"annotation":null,"value_key":null,"deep_link_step":"https://login.esocial.gov.br/login.aspx"},{"id":"cadastro_empregado","title":"Cadastrar o funcionário","instruction":"Acesse: Envio de Eventos → Eventos Não Periódicos → S-2200 Admissão. Preencha o CPF do funcionário — o sistema busca o nome automaticamente.","screenshot_url":null,"annotation":null,"value_key":"cpf_funcionario"},{"id":"dados_contrato","title":"Preencher dados do contrato","instruction":"Informe: data de admissão, cargo, salário e jornada de trabalho. Para tipo de contrato, escolha Prazo Indeterminado na maioria dos casos.","screenshot_url":null,"annotation":null,"value_key":"data_admissao"},{"id":"transmitir","title":"Enviar e salvar o recibo","instruction":"Revise os dados e clique em Enviar. O sistema vai confirmar com um número de recibo (protocolo). Guarde esse número — é a prova do registro.","screenshot_url":null,"annotation":null,"value_key":null}]'::jsonb,
  'Multa por funcionário não registrado: R$3.000 (dobro em reincidência). Certificado e-CNPJ obrigatório para 2+ funcionários.'
),
(
  'esocial_folha_mensal',
  'Enviar folha de pagamento ao governo',
  'Competência {month}/{year} — prazo dia 15',
  'me', 'https://login.esocial.gov.br/login.aspx', '2026-03-24',
  'trabalhista', 'folha', 'high', 15, 3, 'negocio',
  ARRAY['total_salarios','total_inss_funcionarios','total_irrf','total_fgts','num_funcionarios'],
  '[{"id":"alerta_sequencia","title":"A sequência importa","instruction":"O sistema do governo exige enviar os dados na ordem certa. Primeiro: os salários de cada funcionário (S-1200). Depois: o fechamento da folha (S-1299). Sem o fechamento, a guia do FGTS não é gerada.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"acesso_portal","title":"Acessar o eSocial com certificado digital","instruction":"Clique no botão abaixo. Faça login com o certificado digital da empresa (e-CNPJ).","screenshot_url":null,"annotation":null,"value_key":null,"deep_link_step":"https://login.esocial.gov.br/login.aspx"},{"id":"enviar_remuneracoes","title":"Enviar remunerações (S-1200)","instruction":"Acesse: Envio de Eventos → Eventos Periódicos → S-1200 Remuneração. Preencha os salários de cada funcionário do mês.","screenshot_url":null,"annotation":null,"value_key":"total_salarios"},{"id":"fechar_folha","title":"Fechar a folha (S-1299) — obrigatório","instruction":"Após enviar as remunerações, vá em: Envio de Eventos → S-1299 Fechamento. Selecione o mês e clique em Enviar.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"confirmar","title":"Confirmar e anotar os recibos","instruction":"Anote o número do recibo do S-1200 e do S-1299. Agora aguarde — a guia do FGTS Digital fica disponível em minutos.","screenshot_url":null,"annotation":null,"value_key":null}]'::jsonb,
  'Enviar até dia 15 do mês seguinte. Ordem obrigatória: S-1200 antes do S-1299. Sem S-1299, FGTS Digital não é gerado.'
),
(
  'esocial_demissao',
  'Registrar saída de funcionário',
  'Prazo: até 10 dias após o desligamento',
  'me', 'https://login.esocial.gov.br/login.aspx', '2026-03-24',
  'trabalhista', 'folha', 'high', 20, 4, 'negocio',
  ARRAY['nome_funcionario','cpf_funcionario','data_demissao','motivo_demissao','saldo_fgts','verbas_rescisorias'],
  '[{"id":"alerta_prazo","title":"Prazo: 10 dias após o desligamento","instruction":"O registro da saída do funcionário precisa ser enviado ao governo em até 10 dias após o último dia de trabalho.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"acesso_portal","title":"Acessar o eSocial","instruction":"Acesse o sistema com o certificado digital e vá em: Envio de Eventos → Eventos Não Periódicos → S-2299 Desligamento.","screenshot_url":null,"annotation":null,"value_key":null,"deep_link_step":"https://login.esocial.gov.br/login.aspx"},{"id":"dados_demissao","title":"Informar data e motivo da saída","instruction":"Preencha a data do último dia de trabalho e o motivo.","screenshot_url":null,"annotation":null,"value_key":"data_demissao"},{"id":"verbas","title":"Confirmar verbas rescisórias","instruction":"O sistema vai calcular automaticamente os valores a pagar.","screenshot_url":null,"annotation":null,"value_key":"verbas_rescisorias"},{"id":"transmitir","title":"Enviar e gerar guia de FGTS rescisório","instruction":"Clique em Enviar e salve o recibo.","screenshot_url":null,"annotation":null,"value_key":null}]'::jsonb,
  'Prazo: 10 dias após desligamento ou dia 15 do mês seguinte, o que vier primeiro.'
),
(
  'dctfweb',
  'Pagar contribuição previdenciária (INSS)',
  'Competência {month}/{year} — prazo dia 20',
  'me', 'https://cav.receita.fazenda.gov.br/autenticacao/login', '2026-03-24',
  'trabalhista', 'folha', 'medium', 10, 5, 'negocio',
  ARRAY['valor_inss_patronal','valor_inss_funcionarios','valor_irrf','valor_total_dctfweb'],
  '[{"id":"pre_requisito","title":"Antes: a folha precisa estar fechada","instruction":"A guia de pagamento do INSS é gerada automaticamente pelo governo depois que você enviou e fechou a folha no eSocial (S-1200 + S-1299).","screenshot_url":null,"annotation":null,"value_key":null},{"id":"acesso_ecac","title":"Acessar o portal da Receita Federal (e-CAC)","instruction":"Clique no botão abaixo para abrir o e-CAC.","screenshot_url":null,"annotation":null,"value_key":null,"deep_link_step":"https://cav.receita.fazenda.gov.br/autenticacao/login"},{"id":"localizar_dctfweb","title":"Localizar a declaração do mês","instruction":"No e-CAC, acesse: DCTFWeb → Declarações.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"transmitir_dctfweb","title":"Transmitir a declaração","instruction":"Clique em Transmitir na declaração do mês.","screenshot_url":null,"annotation":null,"value_key":"valor_total_dctfweb"},{"id":"pagar_darf","title":"Gerar e pagar o boleto (DARF)","instruction":"Após transmitir, clique em Emitir DARF. Pague via Pix ou boleto até o dia 20.","screenshot_url":null,"annotation":null,"value_key":"valor_total_dctfweb"}]'::jsonb,
  'Prazo: dia 20 do mês seguinte. Pré-requisito: folha fechada no eSocial (S-1299 enviado).'
),
(
  'fgts_digital',
  'Pagar FGTS dos funcionários',
  'Competência {month}/{year} — prazo dia 20',
  'me', 'https://fgts.economia.gov.br', '2026-03-24',
  'trabalhista', 'folha', 'medium', 10, 6, 'negocio',
  ARRAY['valor_fgts_total','num_funcionarios'],
  '[{"id":"pre_requisito","title":"Antes: a folha precisa estar fechada","instruction":"A guia do FGTS é gerada automaticamente após o envio do fechamento da folha (S-1299) no eSocial.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"acesso_portal","title":"Acessar o FGTS Digital","instruction":"Clique no botão abaixo. Faça login com o certificado digital da empresa.","screenshot_url":null,"annotation":null,"value_key":null,"deep_link_step":"https://fgts.economia.gov.br"},{"id":"localizar_guia","title":"Localizar a guia do mês","instruction":"No FGTS Digital, vá em: Recolhimentos → Guias.","screenshot_url":null,"annotation":null,"value_key":"valor_fgts_total"},{"id":"pagar_gfd","title":"Pagar via Pix ou boleto","instruction":"Clique em Pagar. O pagamento precisa ser feito até o dia 20 do mês.","screenshot_url":null,"annotation":null,"value_key":null}]'::jsonb,
  'Prazo: dia 20 do mês seguinte. 8% do salário bruto de cada funcionário. Pré-requisito: S-1299 enviado.'
),
(
  'certificado_digital',
  'Obter o certificado digital da empresa',
  'Necessário para 2 ou mais funcionários',
  'me', 'https://www.serasa.com.br/certificado-digital/', '2026-03-24',
  'onboarding', 'configuracoes', 'low', 30, 1, 'negocio',
  ARRAY[]::text[],
  '[{"id":"o_que_e","title":"O que é e para que serve","instruction":"O certificado digital da empresa (e-CNPJ) é como uma assinatura eletrônica oficial.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"qual_tipo","title":"Qual tipo comprar","instruction":"Para a maioria das empresas, o tipo A1 (arquivo no computador, válido por 1 ano) é o mais prático. Custa entre R$219 e R$275 por ano.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"como_comprar","title":"Como comprar e emitir","instruction":"Acesse o site da emissora escolhida, selecione e-CNPJ A1 (12 meses) e pague online.","screenshot_url":null,"annotation":null,"deep_link_step":"https://www.serasa.com.br/certificado-digital/","value_key":null},{"id":"instalar","title":"Receber e guardar o arquivo","instruction":"Após a videoconferência, você receberá um arquivo .pfx. Salve em local seguro e anote a senha.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"pronto","title":"Pronto — agora você pode usar o eSocial","instruction":"Com o certificado em mãos, você já pode acessar o eSocial, o FGTS Digital e o e-CAC.","screenshot_url":null,"annotation":null,"value_key":null}]'::jsonb,
  'Custo: R$219–275/ano (e-CNPJ A1). Emissão 100% online por videoconferência. Prazo: 1–3 dias úteis.'
),
(
  'nfe_configuracao',
  'Configurar emissão de Nota Fiscal',
  'Feito uma vez — vale para todas as vendas',
  'both', 'https://getaura.com.br', '2026-03-24',
  'onboarding', 'configuracoes', 'medium', 20, 2, NULL,
  ARRAY['cnpj','inscricao_estadual','regime_tributario'],
  '[{"id":"dados_empresa","title":"Confirmar dados da empresa","instruction":"Verifique em Configurações → Minha Empresa: CNPJ, razão social, endereço completo e regime tributário.","screenshot_url":null,"annotation":null,"value_key":"cnpj"},{"id":"tipo_nota","title":"Entender qual tipo de Nota Fiscal você emite","instruction":"Se você vende produtos: emite NF-e. Se você presta serviços: emite NFS-e.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"ativar_automatico","title":"Ativar emissão automática","instruction":"Na Aura, vá em Configurações → Nota Fiscal e ative a opção Emitir automaticamente.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"primeira_nota","title":"Emitir a primeira nota de teste","instruction":"Faça uma venda pequena no Caixa de Vendas para uma empresa e veja a nota ser gerada automaticamente.","screenshot_url":null,"annotation":null,"value_key":null}]'::jsonb,
  'Feito uma vez. Após configurado, a Nota Fiscal é emitida automaticamente em toda venda para empresa.'
),
(
  'importacao_clientes',
  'Trazer seus clientes para a Aura',
  'De planilha Excel ou Google Sheets',
  'both', 'https://app.getaura.com.br/clientes/importar', '2026-03-24',
  'importacao', 'clientes', 'low', 15, 1, NULL,
  ARRAY[]::text[],
  '[{"id":"baixar_modelo","title":"Baixar o modelo de importação","instruction":"Clique em Baixar modelo para obter uma planilha Excel formatada com as colunas corretas.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"preparar_planilha","title":"Preparar sua planilha","instruction":"Os únicos campos obrigatórios são: nome e telefone.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"upload","title":"Carregar o arquivo","instruction":"Clique em Selecionar arquivo ou arraste sua planilha para a área indicada.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"mapear_colunas","title":"Conferir o mapeamento de colunas","instruction":"A Aura vai sugerir o mapeamento automaticamente.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"importar","title":"Importar e conferir","instruction":"Clique em Importar X clientes.","screenshot_url":null,"annotation":null,"value_key":null}]'::jsonb,
  'Formatos aceitos: Excel (.xlsx), CSV. Duplicatas detectadas por CPF ou por nome + telefone.'
),
(
  'importacao_estoque',
  'Trazer seus produtos para a Aura',
  'De planilha Excel ou de Nota Fiscal de compra',
  'both', 'https://app.getaura.com.br/estoque/importar', '2026-03-24',
  'importacao', 'estoque', 'low', 15, 2, NULL,
  ARRAY[]::text[],
  '[{"id":"escolher_metodo","title":"Escolher como importar","instruction":"Você tem duas opções: (A) Planilha Excel ou (B) Nota Fiscal de compra — XML.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"baixar_modelo","title":"Baixar o modelo de planilha (opção A)","instruction":"Baixe o modelo com as colunas: nome do produto, preço de venda, preço de custo, quantidade e código de barras (opcional).","screenshot_url":null,"annotation":null,"value_key":null},{"id":"upload","title":"Carregar o arquivo","instruction":"Arraste sua planilha ou o arquivo XML da Nota Fiscal para a área indicada.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"conferir","title":"Conferir os produtos antes de salvar","instruction":"A Aura vai exibir uma lista com todos os produtos detectados.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"importar","title":"Confirmar importação","instruction":"Clique em Importar X produtos.","screenshot_url":null,"annotation":null,"value_key":null}]'::jsonb,
  'Formatos aceitos: Excel (.xlsx), CSV, XML de Nota Fiscal de compra (NF-e).'
),
(
  'importacao_nfe_xml',
  'Criar estoque a partir de uma Nota Fiscal de compra',
  'Arraste o XML e o estoque é preenchido automaticamente',
  'both', 'https://app.getaura.com.br/estoque/importar-nfe', '2026-03-24',
  'importacao', 'estoque', 'low', 5, 3, NULL,
  ARRAY[]::text[],
  '[{"id":"onde_esta_xml","title":"Onde encontrar o arquivo XML","instruction":"Quando você compra de um fornecedor, ele emite uma Nota Fiscal eletrônica. O arquivo XML chega por e-mail.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"upload_xml","title":"Arrastar o arquivo XML","instruction":"Arraste o arquivo .xml para a área indicada.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"definir_preco_venda","title":"Definir o preço de venda","instruction":"O XML traz o preço de custo. Para cada produto, informe o preço de venda que você pratica.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"confirmar","title":"Confirmar e adicionar ao estoque","instruction":"Clique em Adicionar ao estoque.","screenshot_url":null,"annotation":null,"value_key":null}]'::jsonb,
  'Este é o método mais rápido para popular o estoque. Um XML de NF-e com 50 produtos leva menos de 2 minutos.'
),
(
  'importacao_extrato',
  'Importar extrato bancário para o Financeiro',
  'Registrar todas as movimentações do banco de uma vez',
  'both', 'https://app.getaura.com.br/financeiro/importar-extrato', '2026-03-24',
  'importacao', 'financeiro', 'medium', 20, 4, NULL,
  ARRAY[]::text[],
  '[{"id":"exportar_banco","title":"Exportar o extrato do seu banco","instruction":"Entre no aplicativo ou site do seu banco e procure a opção de exportar o extrato em formato OFX (.ofx).","screenshot_url":null,"annotation":null,"value_key":null},{"id":"upload","title":"Carregar o arquivo na Aura","instruction":"Arraste o arquivo .ofx para a área indicada.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"conferir","title":"Conferir o que vai ser importado","instruction":"A Aura mostra cada movimentação com o status: Nova, Duplicada ou Já existe.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"categorizar","title":"Categorizar as movimentações (opcional)","instruction":"Você pode categorizar cada lançamento. A Aura tenta sugerir a categoria automaticamente.","screenshot_url":null,"annotation":null,"value_key":null},{"id":"importar","title":"Importar e atualizar o Financeiro","instruction":"Clique em Importar X lançamentos.","screenshot_url":null,"annotation":null,"value_key":null}]'::jsonb,
  'Formatos aceitos: OFX (.ofx) — padrão exportado por Bradesco, Itaú, Nubank, Caixa, Inter, BB, Santander.'
)
ON CONFLICT (slug) DO NOTHING;
