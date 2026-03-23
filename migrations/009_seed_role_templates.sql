-- ============================================================
-- Seed — Templates de Role Globais (company_id = NULL)
-- ============================================================

INSERT INTO role_templates (company_id, name, description, permissions, is_default) VALUES

(NULL, 'Vendedor', 'Acesso ao PDV e clientes. Sem acesso financeiro.',
  '{"pdv":true,"estoque":true,"clientes":true,"financeiro":false,"relatorios":false,"folha":false,"configuracoes":false}',
  true),

(NULL, 'Gerente', 'Acesso completo exceto configurações da conta.',
  '{"pdv":true,"estoque":true,"clientes":true,"financeiro":true,"relatorios":true,"folha":true,"configuracoes":false}',
  true),

(NULL, 'Caixa', 'Apenas PDV e fechamento de caixa.',
  '{"pdv":true,"estoque":false,"clientes":false,"financeiro":false,"relatorios":false,"folha":false,"configuracoes":false}',
  true),

(NULL, 'Estoquista', 'Gestão de produtos e estoque.',
  '{"pdv":false,"estoque":true,"clientes":false,"financeiro":false,"relatorios":false,"folha":false,"configuracoes":false}',
  true);
