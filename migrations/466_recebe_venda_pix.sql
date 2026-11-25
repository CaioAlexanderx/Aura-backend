-- ============================================================
-- AURA. — Migration 466: Recebe na Aura — Pix do Caixa com confirmação (RA-10)
-- recebe_venda_pix
-- ------------------------------------------------------------
-- 25/11/2026. Uma linha por cobrança Pix do Recebe na Aura feita para uma
-- venda do Caixa. A venda continua sendo gravada como sempre (POST /pdv/sale,
-- forma 'pix'); esta tabela guarda só o estado do Pix dela: criada na
-- subconta da loja, aguardando, confirmada pelo aviso da Asaas
-- (PAYMENT_RECEIVED / PAYMENT_CONFIRMED, ligado pela externalReference
-- recebe:venda:<sale_id>) ou cancelada.
--
-- status:
--   criando      reservada; a cobrança está sendo criada na Asaas agora
--                (trava contra clique duplo: só quem reservou chama a Asaas)
--   aguardando   cobrança criada, esperando o aviso de pagamento
--   confirmado   aviso de pagamento chegou (uma vez só)
--   cancelado    a lojista desistiu (cobrança apagada na Asaas) ou a venda
--                foi cancelada antes do pagamento
--
-- atencao (para a lojista resolver; a Aura NUNCA move dinheiro):
--   pago_depois_de_cancelar      o Pix caiu depois de a cobrança ser cancelada
--   pago_com_venda_cancelada     o Pix caiu, mas a venda já estava cancelada
--   venda_cancelada_com_pix_pago a venda foi cancelada depois do Pix pago
--   estornado                    a Asaas avisou estorno/contestação
--
-- No máximo UMA cobrança viva (criando/aguardando/confirmado) por venda:
-- índice único parcial. Cancelada não conta: dá para gerar de novo.
--
-- Só aditiva: tabela nova, nada nas tabelas existentes. Sem backfill.
-- Idempotente: IF NOT EXISTS + constraints em DO $$.
-- Aplicar manualmente, com OK do Caio (o repo não roda migrations).
-- ============================================================

CREATE TABLE IF NOT EXISTS recebe_venda_pix (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sale_id             uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  status              text NOT NULL DEFAULT 'criando',
  asaas_payment_id    text,
  external_reference  text NOT NULL,
  value               numeric(12,2) NOT NULL,
  aura_fee            numeric(12,2),
  pix_payload         text,
  pix_expires_at      text,
  confirmed_at        timestamptz,
  confirmed_event_id  text,
  cancelled_at        timestamptz,
  cancelled_by        uuid,
  atencao             text,
  atencao_at          timestamptz,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE recebe_venda_pix
    ADD CONSTRAINT recebe_venda_pix_status_chk
    CHECK (status IN ('criando', 'aguardando', 'confirmado', 'cancelado'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE recebe_venda_pix
    ADD CONSTRAINT recebe_venda_pix_atencao_chk
    CHECK (atencao IS NULL OR atencao IN (
      'pago_depois_de_cancelar', 'pago_com_venda_cancelada',
      'venda_cancelada_com_pix_pago', 'estornado'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Uma cobrança viva por venda (a trava do clique duplo).
CREATE UNIQUE INDEX IF NOT EXISTS uq_recebe_venda_pix_viva
  ON recebe_venda_pix (sale_id)
  WHERE status IN ('criando', 'aguardando', 'confirmado');

-- O aviso da Asaas acha a linha pelo id do pagamento.
CREATE UNIQUE INDEX IF NOT EXISTS uq_recebe_venda_pix_payment
  ON recebe_venda_pix (asaas_payment_id)
  WHERE asaas_payment_id IS NOT NULL;

-- Lista da loja: aguardando e o que pede atenção.
CREATE INDEX IF NOT EXISTS idx_recebe_venda_pix_company
  ON recebe_venda_pix (company_id, created_at DESC);

ALTER TABLE recebe_venda_pix ENABLE ROW LEVEL SECURITY;
