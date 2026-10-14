-- ============================================================
-- 385 — LIVRO DE CONCESSÕES DA INDICAÇÃO (indicacao_concessoes)
--
-- Contexto (14/10/2026, cartão t2-19, fallback do t2-17; regras da Célia):
-- o indicador ganha o mês grátis quando o indicado paga a primeira cobrança.
-- Enquanto a automação não existe, a concessão é feita por um script manual
-- (scripts/indicacao-concessao.js) que EXCLUI a próxima cobrança futura e
-- pendente do indicador na Asaas. Cada exclusão precisa de uma linha própria
-- gravada ANTES da chamada à Asaas, amarrada ao id da cobrança (pay_...).
-- A Célia confere toda semana PAYMENT_DELETED sem concessão
-- (scripts/indicacao-relatorio.js) e a linha "desconto de indicação" do DRE
-- sai desta tabela.
--
-- Uma linha = uma concessão:
--   tipo 'padrao'     regra geral: teto de R$ 230 por mês e 3 por indicador
--                     por ano (aplicados pelo script).
--   tipo 'combinada'  as indicações combinadas antes de 15/10 (Jenny/Luis e
--                     Fernanda/Valen): um benefício por indicado, fora do teto.
--
--   status  registrada  gravada, chamada à Asaas ainda não confirmada
--                       (se ficar assim, alguém confere no painel da Asaas)
--           aplicada    a cobrança foi excluída na Asaas
--           falhou      a Asaas recusou a exclusão (a cobrança continua lá)
--           estornando  estorno gravado, criação da cobrança avulsa em curso
--           estornada   exclusão desfeita: cobrança avulsa de mesmo valor e
--                       vencimento criada (estorno_pay_id); sai do teto
--
-- Unicidade:
--   - uma concessão viva por cobrança (asaas_payment_id), "falhou" não conta;
--   - uma concessão viva por indicação (referral_id) e por indicado.
--
-- Nada é apagado nem alterado em tabela existente: referrals só ganha um
-- índice de leitura. Idempotente: IF NOT EXISTS em tudo.
-- ============================================================

CREATE TABLE IF NOT EXISTS indicacao_concessoes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo                  VARCHAR(20)  NOT NULL DEFAULT 'padrao'
                          CHECK (tipo IN ('padrao', 'combinada')),
  status                VARCHAR(20)  NOT NULL DEFAULT 'registrada'
                          CHECK (status IN ('registrada', 'aplicada', 'falhou', 'estornando', 'estornada')),
  referral_id           UUID REFERENCES referrals(id) ON DELETE SET NULL,
  indicador_company_id  UUID NOT NULL REFERENCES companies(id),
  indicado_company_id   UUID REFERENCES companies(id),
  data_concessao        DATE         NOT NULL DEFAULT CURRENT_DATE,
  valor                 NUMERIC(12,2) NOT NULL CHECK (valor > 0),
  -- cobrança do indicador excluída na Asaas
  asaas_payment_id      VARCHAR(40),
  cobranca_vencimento   DATE,
  cobranca_forma        VARCHAR(30),
  asaas_customer_id     VARCHAR(40),
  -- o que tornou a indicação elegível: primeira cobrança paga do indicado
  indicado_payment_id   VARCHAR(40),
  indicado_pago_em      DATE,
  -- estorno (Célia, 13/10): cobrança avulsa de mesmo valor e vencimento
  estorno_pay_id        VARCHAR(40),
  estornado_em          TIMESTAMPTZ,
  aplicada_em           TIMESTAMPTZ,
  erro                  TEXT,
  observacao            TEXT,
  criado_por            TEXT,
  criado_em             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  atualizado_em         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_indicacao_concessoes_cobranca
  ON indicacao_concessoes (asaas_payment_id)
  WHERE asaas_payment_id IS NOT NULL AND status <> 'falhou';

CREATE UNIQUE INDEX IF NOT EXISTS ux_indicacao_concessoes_referral
  ON indicacao_concessoes (referral_id)
  WHERE referral_id IS NOT NULL AND status IN ('registrada', 'aplicada', 'estornando');

CREATE UNIQUE INDEX IF NOT EXISTS ux_indicacao_concessoes_indicado
  ON indicacao_concessoes (indicado_company_id)
  WHERE indicado_company_id IS NOT NULL AND status IN ('registrada', 'aplicada', 'estornando');

CREATE INDEX IF NOT EXISTS idx_indicacao_concessoes_mes
  ON indicacao_concessoes (data_concessao, tipo, status);

CREATE INDEX IF NOT EXISTS idx_indicacao_concessoes_indicador
  ON indicacao_concessoes (indicador_company_id, data_concessao);

-- Leitura: o relatório cruza PAYMENT_DELETED com as concessões pelo id da
-- cobrança, e o script procura os pagamentos do indicado pelo company_id.
CREATE INDEX IF NOT EXISTS idx_webhook_logs_asaas_pagamento
  ON webhook_logs ((COALESCE(payload->'payment', payload)->>'id'))
  WHERE provider = 'asaas';

CREATE INDEX IF NOT EXISTS idx_referrals_referrer
  ON referrals (referrer_id);
