-- 143_commercial_dates.sql
-- Calendário comercial: catálogo global de datas que movimentam o comércio
-- + camada de override por empresa + datas próprias do lojista.
-- Idempotente. Seed via INSERT ... ON CONFLICT DO NOTHING.

-- 1) Catálogo global (curado pela Aura, igual para todas as empresas)
CREATE TABLE IF NOT EXISTS commercial_dates (
  id                 SERIAL PRIMARY KEY,
  slug               TEXT UNIQUE NOT NULL,
  name               TEXT NOT NULL,
  description        TEXT,
  default_intensity  SMALLINT NOT NULL CHECK (default_intensity BETWEEN 1 AND 3),
  rule_type          TEXT NOT NULL CHECK (rule_type IN ('fixed','nth_weekday','easter_offset')),
  rule_config        JSONB NOT NULL,
  is_period          BOOLEAN NOT NULL DEFAULT false,
  window_before_days SMALLINT,
  vertical_intensity JSONB NOT NULL DEFAULT '{}'::jsonb,
  icon               TEXT,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  sort_hint          SMALLINT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2) Override por empresa (intensidade ajustada / ocultar / nota)
CREATE TABLE IF NOT EXISTS company_commercial_date_settings (
  id                 SERIAL PRIMARY KEY,
  company_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  commercial_date_id INTEGER NOT NULL REFERENCES commercial_dates(id) ON DELETE CASCADE,
  intensity_override SMALLINT CHECK (intensity_override BETWEEN 1 AND 3),
  is_hidden          BOOLEAN NOT NULL DEFAULT false,
  notes              TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, commercial_date_id)
);
CREATE INDEX IF NOT EXISTS idx_ccds_company ON company_commercial_date_settings(company_id);

-- 3) Datas próprias do lojista (aniversário da loja, promoções locais)
CREATE TABLE IF NOT EXISTS company_custom_commercial_dates (
  id                 SERIAL PRIMARY KEY,
  company_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  description        TEXT,
  intensity          SMALLINT NOT NULL DEFAULT 1 CHECK (intensity BETWEEN 1 AND 3),
  rule_type          TEXT NOT NULL DEFAULT 'fixed' CHECK (rule_type IN ('fixed','nth_weekday','easter_offset')),
  rule_config        JSONB NOT NULL,
  is_period          BOOLEAN NOT NULL DEFAULT false,
  window_before_days SMALLINT,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cccd_company ON company_custom_commercial_dates(company_id);

COMMENT ON TABLE commercial_dates IS 'Catálogo global de datas comerciais (calendário comercial). Regra: fixed {month,day} | nth_weekday {month,weekday(0=dom),nth(-1=ultimo),offset_days?} | easter_offset {offset_days}. Janela default por intensidade: 3=60d, 2=30d, 1=20d.';

-- Seed do catálogo. weekday: 0=domingo .. 6=sabado (convenção JS getUTCDay).
INSERT INTO commercial_dates (slug, name, description, default_intensity, rule_type, rule_config, is_period, sort_hint) VALUES
  ('natal',              'Natal',                  'Pico absoluto do varejo no ano.',                          3, 'fixed',        '{"month":12,"day":25}',                          false, 10),
  ('black-friday',       'Black Friday',           'Maior data de descontos; dia seguinte ao Thanksgiving.',   3, 'nth_weekday',  '{"month":11,"weekday":4,"nth":4,"offset_days":1}',false, 20),
  ('dia-das-maes',       'Dia das Mães',           'Maior data de presentes do 1º semestre.',                  3, 'nth_weekday',  '{"month":5,"weekday":0,"nth":2}',                false, 30),
  ('dia-dos-namorados',  'Dia dos Namorados',      'Alta procura em presentes, moda e joias.',                 3, 'fixed',        '{"month":6,"day":12}',                           false, 40),
  ('dia-dos-pais',       'Dia dos Pais',           'Forte em presentes masculinos e moda.',                    3, 'nth_weekday',  '{"month":8,"weekday":0,"nth":2}',                false, 50),
  ('dia-das-criancas',   'Dia das Crianças',       'Brinquedos, vestuário e calçado infantil.',                2, 'fixed',        '{"month":10,"day":12}',                          false, 60),
  ('dia-do-consumidor',  'Dia do Consumidor',      'A "Black Friday" do 1º semestre.',                         2, 'fixed',        '{"month":3,"day":15}',                           false, 70),
  ('pascoa',             'Páscoa',                 'Chocolate, food e mercado.',                               2, 'easter_offset','{"offset_days":0}',                              false, 80),
  ('carnaval',           'Carnaval',               'Bebidas, moda praia e fantasias.',                         2, 'easter_offset','{"offset_days":-47}',                            true,  90),
  ('volta-as-aulas',     'Volta às aulas',         'Período de material, mochila e uniforme (jan–fev).',       2, 'fixed',        '{"month":2,"day":1}',                            true,  100),
  ('festa-junina',       'Festas Juninas',         'Pico em São João; food e bebidas.',                        2, 'fixed',        '{"month":6,"day":24}',                           true,  110),
  ('cyber-monday',       'Cyber Monday',           'Cauda da Black Friday no e-commerce.',                     2, 'nth_weekday',  '{"month":11,"weekday":4,"nth":4,"offset_days":4}',false, 120),
  ('liquidacao-pos-natal','Liquidação pós-Natal',  'Queima de estoque de fim de ano.',                         2, 'fixed',        '{"month":12,"day":26}',                          true,  130),
  ('dia-da-mulher',      'Dia da Mulher',          'Beleza, moda e presentes.',                                1, 'fixed',        '{"month":3,"day":8}',                            false, 140),
  ('dia-do-cliente',     'Dia do Cliente',         'Promoções de relacionamento.',                             1, 'fixed',        '{"month":9,"day":15}',                           false, 150),
  ('dia-dos-avos',       'Dia dos Avós',           'Nicho de presentes.',                                      1, 'fixed',        '{"month":7,"day":26}',                           false, 160),
  ('halloween',          'Halloween',              'Crescente; fantasia, doces e festa.',                      1, 'fixed',        '{"month":10,"day":31}',                          false, 170),
  ('semana-do-brasil',   'Semana do Brasil',       'Ação nacional de varejo em setembro.',                     1, 'fixed',        '{"month":9,"day":7}',                            true,  180),
  ('reveillon',          'Réveillon',              'Moda (branco), bebidas e mercado.',                        1, 'fixed',        '{"month":12,"day":31}',                          false, 190),
  ('sexta-feira-santa',  'Sexta-feira Santa',      'Peixe e mercado; comércio costuma fechar.',                1, 'easter_offset','{"offset_days":-2}',                             false, 200),
  ('corpus-christi',     'Corpus Christi',         'Feriado nacional; varia por cidade.',                      1, 'easter_offset','{"offset_days":60}',                             false, 210)
ON CONFLICT (slug) DO NOTHING;
