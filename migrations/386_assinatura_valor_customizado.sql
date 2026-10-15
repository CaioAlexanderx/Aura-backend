-- ============================================================
-- 386 — Assinatura com valor customizado por empresa
--
-- Contexto (14/10/2026, pedido do Caio): o checkout calcula plano + R$ 19 x
-- acessos extras e nao aceita um valor combinado com o cliente. Caso real:
-- empresa dona de 2 lojas que fechou o Negocio anual por R$ 211,20/mes
-- (R$ 140,83 de tabela + R$ 70,37 da segunda loja). O checkout continua
-- sendo o da Aura (PIX/cartao); quem define o valor e a equipe, na Gestao
-- Aura, e o cliente so o ve e paga no checkout normal.
--
-- Colunas (todas NULL = empresa sem valor combinado, tabela normal):
--   custom_subscription_value  valor MENSAL total da assinatura. Substitui
--                              plano + acessos extras (ja os inclui).
--   custom_subscription_plan   plano ao qual o valor vale (essencial/negocio/
--                              expansao). Outro plano: tabela normal.
--   custom_subscription_cycle  'monthly' ou 'annual'. Outro ciclo: tabela.
--   custom_subscription_note   o que foi combinado (so a equipe ve).
--   custom_subscription_set_at / _set_by  quem definiu e quando.
--
-- Regra de uso (services/billingPricing.valorDaAssinatura): o valor so vale
-- quando plano E ciclo escolhidos no checkout sao iguais aos gravados.
-- Independe de PIX/cartao e de extra_seats_granted. Enquanto vale, o sync de
-- acessos extras NAO mexe no valor da assinatura na Asaas
-- (services/seatSubscription).
--
-- Sem CHECK de proposito: a validacao (plano em PLANS, ciclo, valor >= minimo
-- do provedor) fica no PUT /admin/clients/:cid/custom-subscription, que e a
-- unica porta de escrita. O codigo trata 42703 (coluna ausente) como "sem
-- valor combinado": o backend pode subir antes desta migration.
--
-- Idempotente.
-- ============================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS custom_subscription_value NUMERIC(10,2) NULL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS custom_subscription_plan TEXT NULL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS custom_subscription_cycle TEXT NULL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS custom_subscription_note TEXT NULL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS custom_subscription_set_at TIMESTAMPTZ NULL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS custom_subscription_set_by UUID NULL;

COMMENT ON COLUMN companies.custom_subscription_value IS
  'Valor MENSAL total da assinatura combinado com o cliente (inclui acessos extras). Vale so quando plano e ciclo do checkout batem com custom_subscription_plan/_cycle. NULL = tabela.';
