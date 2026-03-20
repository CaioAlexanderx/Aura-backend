-- ============================================================
-- AURA. — Seed 001: Dados Iniciais 2026
-- Rodar APÓS migration 001
-- ============================================================

-- ============================================================
-- TABELAS FISCAIS 2026 — INSS Empregado
-- Tabela progressiva vigente (Portaria MPS)
-- ATENÇÃO: atualizar se houver reajuste via Portaria
-- ============================================================

INSERT INTO tax_inss_brackets (year_base, min_salary, max_salary, rate) VALUES
  (2026,     0.00,  1518.00, 0.0750),   -- 7,5%
  (2026,  1518.01,  2793.88, 0.0900),   -- 9%
  (2026,  2793.89,  4190.83, 0.1200),   -- 12%
  (2026,  4190.84,  8157.41, 0.1400),   -- 14% (teto INSS 2026)
  (2026,  8157.42,      NULL, 0.1400);  -- acima do teto: alíquota teto

-- ============================================================
-- TABELAS FISCAIS 2026 — IRRF Mensal (tabela progressiva)
-- Vigente desde 01/2025 (ajuste mai/2023 + correção 2025)
-- ============================================================

INSERT INTO tax_irrf_brackets (year_base, min_base, max_base, rate, deduction) VALUES
  (2026,     0.00,  2259.20, 0.0000,    0.00),   -- isento
  (2026,  2259.21,  2826.65, 0.0750,  169.44),   -- 7,5%
  (2026,  2826.66,  3751.05, 0.1500,  381.44),   -- 15%
  (2026,  3751.06,  4664.68, 0.2250,  662.77),   -- 22,5%
  (2026,  4664.69,      NULL, 0.2750,  896.00);  -- 27,5%

-- ============================================================
-- USUÁRIO ADMIN PADRÃO (fundador / analista CRC)
-- IMPORTANTE: trocar a senha via hash antes de ir para produção
-- Senha padrão: "Aura@2026" → hash gerado pelo backend no login
-- ============================================================

INSERT INTO users (
  id, email, full_name, password_hash, role, crc_number, is_active
) VALUES (
  uuid_generate_v4(),
  'joao@getaura.com.br',
  'João Mendes',
  -- PLACEHOLDER: o backend vai substituir com bcrypt no primeiro login
  '$2b$12$PLACEHOLDER_HASH_CHANGE_BEFORE_PROD_xxxxxxxxxxxxxxxxxx',
  'analyst',
  'CRC/SP-000000',   -- substituir pelo CRC real após abertura PJ
  true
);

-- ============================================================
-- EMPRESA DEMO (para testes e onboarding)
-- ============================================================

INSERT INTO companies (
  id,
  owner_id,
  legal_name,
  trade_name,
  email,
  city,
  state,
  zip_code,
  tax_regime,
  plan,
  is_active
) VALUES (
  'aaaaaaaa-0000-0000-0000-000000000001',
  (SELECT id FROM users WHERE email = 'joao@getaura.com.br'),
  'Empresa Demo Aura Ltda',
  'Demo Aura',
  'demo@getaura.com.br',
  'Jacareí',
  'SP',
  '12300-000',
  'simples_nacional',
  'expansao',
  true
);

-- ============================================================
-- ATRIBUTOS DE VARIANTE — sugestões por vertical (BE-16)
-- vertical_hint NULL = sugestão global (todos os segmentos)
-- ============================================================

INSERT INTO product_variant_attributes (company_id, name, vertical_hint, sort_order) VALUES

  -- Moda / Varejo
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Cor',          'moda',   1),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tamanho',       'moda',   2),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tipo de Peça',  'moda',   3),

  -- Pet Shop
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Peso',          'pet',    1),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Sabor',         'pet',    2),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Raça Alvo',     'pet',    3),

  -- Barbearia / Salão
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tipo de Cabelo', 'salao', 1),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Comprimento',    'salao', 2),

  -- Estética
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tipo de Pele',   'estetica', 1),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Volume',         'estetica', 2),

  -- Food Service
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Tamanho',        'food',  1),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Temperatura',    'food',  2),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Ponto',          'food',  3);

-- ============================================================
-- PRODUTO DEMO (para teste do PDV e barcode)
-- ============================================================

INSERT INTO products (
  id, company_id, name, category, sku,
  barcode, barcode_format,
  price, cost_price, stock_qty, stock_min,
  is_active
) VALUES (
  'bbbbbbbb-0000-0000-0000-000000000001',
  'aaaaaaaa-0000-0000-0000-000000000001',
  'Camiseta Básica',
  'Vestuário',
  'CAM-001',
  '7891234567890',   -- EAN-13 demo (não é produto real)
  'EAN-13',
  59.90,
  25.00,
  10,
  2,
  true
);

-- Variantes demo do produto
WITH v1 AS (
  INSERT INTO product_variants (product_id, sku_suffix, price_override, stock_qty, barcode, barcode_format)
  VALUES (
    'bbbbbbbb-0000-0000-0000-000000000001',
    'BRAN-P', NULL, 3, '7891234567891', 'EAN-13'
  ) RETURNING id
)
INSERT INTO product_variant_values (variant_id, attribute_name, value)
SELECT id, 'Cor', 'Branco' FROM v1
UNION ALL
SELECT id, 'Tamanho', 'P' FROM v1;

WITH v2 AS (
  INSERT INTO product_variants (product_id, sku_suffix, price_override, stock_qty, barcode, barcode_format)
  VALUES (
    'bbbbbbbb-0000-0000-0000-000000000001',
    'BRAN-M', NULL, 4, '7891234567892', 'EAN-13'
  ) RETURNING id
)
INSERT INTO product_variant_values (variant_id, attribute_name, value)
SELECT id, 'Cor', 'Branco' FROM v2
UNION ALL
SELECT id, 'Tamanho', 'M' FROM v2;

WITH v3 AS (
  INSERT INTO product_variants (product_id, sku_suffix, price_override, stock_qty, barcode, barcode_format)
  VALUES (
    'bbbbbbbb-0000-0000-0000-000000000001',
    'PRET-G', NULL, 3, '7891234567893', 'EAN-13'
  ) RETURNING id
)
INSERT INTO product_variant_values (variant_id, attribute_name, value)
SELECT id, 'Cor', 'Preto' FROM v3
UNION ALL
SELECT id, 'Tamanho', 'G' FROM v3;

-- ============================================================
-- OBRIGAÇÕES FISCAIS DEMO — 2026
-- (empresa demo, regime Simples Nacional)
-- ============================================================

INSERT INTO fiscal_obligations (
  company_id, code, description, due_date, reference_period,
  status, checkpoint_total, checkpoint_done
) VALUES
  (
    'aaaaaaaa-0000-0000-0000-000000000001',
    'PGDAS_D',
    'Apuração PGDAS-D — estimativa mensal',
    '2026-03-20',
    '2026-02',
    'pending', 3, 0
  ),
  (
    'aaaaaaaa-0000-0000-0000-000000000001',
    'DEFIS',
    'Declaração DEFIS — ano-base 2025',
    '2026-03-31',
    '2025',
    'pending', 5, 2
  ),
  (
    'aaaaaaaa-0000-0000-0000-000000000001',
    'PGDAS_D',
    'Apuração PGDAS-D — estimativa mensal',
    '2026-04-20',
    '2026-03',
    'pending', 3, 0
  );

-- ============================================================
-- FIM DO SEED 001
-- ============================================================
