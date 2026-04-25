-- ============================================================
-- AURA. — W2-03 F1: NFS-e (Nota Fiscal de Servicos eletronica)
--
-- Cross-vertical: nao prefixa com dental_ porque qualquer
-- vertical (odonto, barber, food, estetica, pet) emite NFS-e
-- por servico prestado.
--
-- Adapter pattern: provider (nuvem_fiscal | norte_notas | mock)
-- e configurado por empresa em nfse_config. Aura traduz a
-- chamada interna pra API do provider via NfseProvider service.
--
-- Fluxo manual: clinica clica "Emitir NFS-e" em Cobrancas/PDV/
-- BillingDashboard. Sem auto-emit por webhook (decisao W2-03).
-- ============================================================

-- ── 1. nfse_config: config do provider por empresa ───────
CREATE TABLE IF NOT EXISTS nfse_config (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,

  -- Provider
  provider           varchar(20) NOT NULL DEFAULT 'nuvem_fiscal',
  -- nuvem_fiscal | norte_notas | mock
  ambiente           varchar(15) NOT NULL DEFAULT 'homologacao',
  -- producao | homologacao
  api_key_encrypted  text,           -- API key cifrada (app cifra antes de salvar)
  api_secret         varchar(200),   -- alguns providers usam secret separado
  certificate_url    text,           -- URL R2 do certificado A1 .pfx
  certificate_pwd    varchar(200),   -- senha do certificado (cifrada)

  -- Dados fiscais da empresa (snapshot pra evitar lookup constante)
  inscricao_municipal     varchar(40),
  regime_tributario       varchar(40) DEFAULT 'simples_nacional',
  -- simples_nacional | simples_excesso | normal | mei
  regime_especial         varchar(40),
  -- micro_empresa_municipal | estimativa | sociedade_profissional | cooperativa | mei | me_epp_simples_nacional
  optante_simples_nacional boolean    NOT NULL DEFAULT true,
  incentivador_cultural    boolean    NOT NULL DEFAULT false,

  -- Codigo de servico padrao (pode ser sobrescrito por nota)
  default_service_code    varchar(20),
  -- Codigo da Lista de Servicos (LC 116/2003) ou codigo municipal
  default_cnae            varchar(10),
  -- 8630-5/04 = Atividades de servicos de complementacao diagnostica e terapeutica
  -- 8630-5/03 = Atividades medicas ambulatoriais restritas
  -- 8630-5/04 ou 8630-5/06 sao os comuns pra odonto
  default_iss_rate        numeric(5, 2) DEFAULT 2.00,
  -- Aliquota ISS padrao (em %). Jacarei=2%. Cada municipio tem o seu.

  -- Series e numeracao
  serie                   varchar(10) DEFAULT '1',
  next_rps_number         int         NOT NULL DEFAULT 1,
  -- Numero do RPS (Recibo Provisorio de Servicos) sequencial.
  -- Cada NFS-e e gerada a partir de um RPS.

  is_active               boolean     NOT NULL DEFAULT false,
  -- false = config nao terminada/desativada. Bloqueia emissao.

  created_at              timestamptz NOT NULL DEFAULT NOW(),
  updated_at              timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nfse_config_company
  ON nfse_config(company_id);

COMMENT ON TABLE nfse_config IS
  'Config NFS-e por empresa. Provider abstraido (Nuvem Fiscal | Norte Notas | mock). Cross-vertical.';
COMMENT ON COLUMN nfse_config.next_rps_number IS
  'Sequencial do proximo RPS (Recibo Provisorio Servicos). Cada NFS-e e gerada a partir de um RPS unico. NUNCA decrementa, mesmo se nota for cancelada (regra fiscal).';
COMMENT ON COLUMN nfse_config.regime_especial IS
  'Regime especial conforme tabela ABRASF: 1=Microempresa Municipal, 2=Estimativa, 3=Sociedade Profissionais, 4=Cooperativa, 5=ME/EPP Simples, 6=MEI.';

-- ── 2. nfse: notas emitidas ──────────────────────────────
CREATE TABLE IF NOT EXISTS nfse (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Origem (qualquer entidade que gera servico)
  customer_id        uuid        REFERENCES customers(id) ON DELETE SET NULL,
  appointment_id     uuid,       -- generico, nao FK pra ficar cross-vertical
  treatment_plan_id  uuid,       -- generico, idem
  payment_id         uuid,       -- ref ao pagamento que originou a nota
  source_type        varchar(30),
  -- 'manual' | 'dental_appointment' | 'dental_treatment_plan' | 'pdv_sale' | 'recurring' | etc

  -- Numeracao
  rps_number         int         NOT NULL,
  rps_serie          varchar(10) NOT NULL DEFAULT '1',
  nfse_number        varchar(40),     -- numero da NFS-e (devolvido pela prefeitura)
  verification_code  varchar(60),     -- codigo de verificacao (devolvido)

  -- Status
  status             varchar(20) NOT NULL DEFAULT 'pendente',
  -- pendente | processando | autorizada | rejeitada | cancelada
  rejection_reason   text,            -- mensagem de erro se status=rejeitada

  -- Datas
  issued_at          timestamptz,     -- data de emissao na prefeitura
  competence_date    date,            -- data competencia (mes referencia)
  cancelled_at       timestamptz,
  cancel_reason      text,

  -- Tomador (quem recebe a nota / paga)
  recipient_type     varchar(2)  NOT NULL DEFAULT 'pf',
  -- pf | pj
  recipient_name     varchar(200) NOT NULL,
  recipient_doc      varchar(20),     -- CPF/CNPJ (so digitos)
  recipient_email    varchar(200),
  recipient_phone    varchar(30),
  recipient_address  jsonb,
  -- {logradouro, numero, complemento, bairro, municipio, uf, cep, codigo_municipio}

  -- Servico
  service_code       varchar(20) NOT NULL,
  service_description text       NOT NULL,
  service_amount     numeric(12, 2) NOT NULL,
  iss_rate           numeric(5, 2) NOT NULL,
  iss_value          numeric(12, 2) NOT NULL,
  iss_retained       boolean     NOT NULL DEFAULT false,

  -- Deducoes / outros tributos
  deductions         numeric(12, 2) DEFAULT 0,
  inss_value         numeric(12, 2) DEFAULT 0,
  ir_value           numeric(12, 2) DEFAULT 0,
  csll_value         numeric(12, 2) DEFAULT 0,
  cofins_value       numeric(12, 2) DEFAULT 0,
  pis_value          numeric(12, 2) DEFAULT 0,
  net_amount         numeric(12, 2),
  -- Calculado: service_amount - deductions - (iss se retido) - inss - ir - csll - cofins - pis

  -- Provider response (audit trail)
  provider           varchar(20),     -- snapshot do provider usado (caso troque depois)
  provider_id        varchar(100),    -- ID interno do provider (Nuvem Fiscal retorna um UUID)
  provider_response  jsonb,           -- response completa pra debug
  pdf_url            text,            -- URL do PDF (R2 ou direto do provider)
  xml_url            text,            -- URL do XML

  created_at         timestamptz NOT NULL DEFAULT NOW(),
  updated_at         timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nfse_company_status
  ON nfse(company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nfse_customer
  ON nfse(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nfse_payment
  ON nfse(payment_id) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_nfse_rps
  ON nfse(company_id, rps_serie, rps_number);

COMMENT ON TABLE nfse IS
  'Notas Fiscais de Servicos eletronicas emitidas. Cross-vertical (odonto/barber/food/etc). source_type identifica origem.';
COMMENT ON COLUMN nfse.rps_number IS
  'Numero do RPS na serie. UNIQUE por (company_id, rps_serie, rps_number) — sequencial nao pode repetir, regra fiscal.';
COMMENT ON COLUMN nfse.iss_retained IS
  'Se true, ISS e retido pelo tomador (cliente PJ retem do prestador). Se false, prestador recolhe.';

-- ── 3. Trigger updated_at ────────────────────────────────
CREATE OR REPLACE FUNCTION update_nfse_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_nfse_config_updated_at ON nfse_config;
CREATE TRIGGER trg_nfse_config_updated_at
  BEFORE UPDATE ON nfse_config
  FOR EACH ROW EXECUTE FUNCTION update_nfse_updated_at();

DROP TRIGGER IF EXISTS trg_nfse_updated_at ON nfse;
CREATE TRIGGER trg_nfse_updated_at
  BEFORE UPDATE ON nfse
  FOR EACH ROW EXECUTE FUNCTION update_nfse_updated_at();

-- ── 4. Funcao auxiliar pra incrementar rps_number atomicamente ──
-- Usada pelo BE quando emite uma NFS-e — evita race condition
-- entre dois requests simultaneos pegando o mesmo numero.
CREATE OR REPLACE FUNCTION nfse_next_rps(p_company_id uuid)
RETURNS int AS $$
DECLARE
  v_next int;
BEGIN
  UPDATE nfse_config
     SET next_rps_number = next_rps_number + 1
   WHERE company_id = p_company_id
   RETURNING next_rps_number - 1 INTO v_next;

  IF v_next IS NULL THEN
    RAISE EXCEPTION 'Empresa % nao tem nfse_config configurado', p_company_id;
  END IF;

  RETURN v_next;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION nfse_next_rps IS
  'Atomicamente incrementa next_rps_number e retorna o numero atual. Usado pelo BE no momento de emitir NFS-e pra evitar race condition.';
