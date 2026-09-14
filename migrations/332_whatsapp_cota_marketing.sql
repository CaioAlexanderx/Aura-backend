-- ============================================================
-- 332 — Cota mensal de MARKETING e pacotes extras (Fase 8b)
--
-- Mudança de modelo comercial (14/09/2026): o WhatsApp oficial deixa de
-- ser um adicional de R$39 e passa a vir DENTRO dos planos Negócio e
-- Aura Dojô. Cobrança e lembretes (templates UTILITY, R$0,035 na Meta)
-- são "ilimitados" com uso justo silencioso; MARKETING (R$0,3217 na
-- Meta — quase 10x mais caro) tem cota: 100 mensagens por mês inclusas,
-- e quem precisar de mais compra um pacote de 100 por R$49.
--
-- wa_marketing_packs: cada compra de pacote é uma LINHA, não um
-- contador. O contador não responde "quando isso foi comprado, quanto
-- custou, quem pediu e o pagamento caiu?" — e essa é exatamente a
-- conversa que aparece no suporte quando a cota some. `status`
-- 'pending' é o pacote pedido e ainda não pago: ele NÃO conta na cota,
-- justamente para o pedido não virar crédito antes do dinheiro.
--
-- valid_until: o pacote não vira saldo eterno. 60 dias é o bastante
-- para atravessar a virada do mês (quem compra dia 28 usa em outubro)
-- sem transformar a cota mensal num acumulador infinito, que é o que
-- tornaria a conta da Meta imprevisível.
--
-- companies.wa_marketing_quota: exceção por cliente, NULL = padrão do
-- plano. Existe porque negociação comercial acontece (cliente âncora,
-- cortesia, plano personalizado) e a alternativa seria a Aura criar
-- pacotes falsos para simular uma cota maior.
--
-- Nada aqui é obrigatório para o backend subir: todas as consultas
-- novas são 42P01/42703-safe e, sem esta migration, a cota é a base do
-- plano e os pacotes simplesmente não existem.
-- ============================================================

-- ── Pacotes extras de mensagens de marketing ────────────────
CREATE TABLE IF NOT EXISTS wa_marketing_packs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  qty              INT NOT NULL CHECK (qty > 0),
  price_cents      INT NOT NULL DEFAULT 4900,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','active','cancelled')),
  valid_from       DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_until      DATE NOT NULL DEFAULT (CURRENT_DATE + 60),
  asaas_payment_id TEXT,
  payment_url      TEXT,
  source           TEXT NOT NULL DEFAULT 'app',
  created_by       UUID,
  activated_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE wa_marketing_packs IS
  'Pacotes extras de mensagens de MARKETING pelo WhatsApp oficial (100 por R$49). Só status=active e valid_until >= hoje somam na cota do mês.';
COMMENT ON COLUMN wa_marketing_packs.qty IS
  'Quantas mensagens de marketing o pacote acrescenta à cota do mês (100 por ora).';
COMMENT ON COLUMN wa_marketing_packs.status IS
  'pending = pedido, sem pagamento confirmado (NÃO conta na cota) | active = pago/liberado | cancelled = desfeito.';
COMMENT ON COLUMN wa_marketing_packs.valid_until IS
  'Último dia em que o pacote soma na cota. Default 60 dias: atravessa a virada do mês sem virar saldo eterno.';
COMMENT ON COLUMN wa_marketing_packs.asaas_payment_id IS
  'Cobrança avulsa no Asaas (externalReference wa-pack-<id>). O webhook de pagamento é quem ativa o pacote.';
COMMENT ON COLUMN wa_marketing_packs.source IS
  'app = o lojista comprou na tela | admin = a Aura liberou pela Gestão.';

-- A consulta quente é sempre a mesma: "quantas mensagens ativas e ainda
-- válidas esta empresa tem?". O índice cobre os três filtros dela.
CREATE INDEX IF NOT EXISTS idx_wa_marketing_packs_company
  ON wa_marketing_packs(company_id, status, valid_until);

-- O webhook do Asaas chega com o payment_id e precisa achar o pacote
-- por ele quando o externalReference não vier de volta.
CREATE INDEX IF NOT EXISTS idx_wa_marketing_packs_payment
  ON wa_marketing_packs(asaas_payment_id)
  WHERE asaas_payment_id IS NOT NULL;

-- ── Cota base por empresa (exceção comercial) ───────────────
ALTER TABLE companies ADD COLUMN IF NOT EXISTS wa_marketing_quota INT;
COMMENT ON COLUMN companies.wa_marketing_quota IS
  'Cota mensal de mensagens de MARKETING desta empresa. NULL = padrão do plano (env WA_MARKETING_MONTHLY_QUOTA, default 100). Pacotes ativos somam por cima.';
