-- ========================================================================
-- Migration 374 · seat_passes (assento de temporada)
--
-- 13/10/2026: aposta da temporada de fim de ano. Vendedor extra e' a
-- realidade da loja em dezembro; o assento de temporada e' um acesso extra
-- (R$ 19/mes, o mesmo de sempre) com VALIDADE: de 01/11/2026 a 31/01/2027
-- (datas na constante unica services/temporada.js), que expira sozinho.
--
-- Por que tabela nova e nao colunas em companies.extra_seats_granted:
-- aquela coluna e' um INTEIRO unico ("quantos acessos extras a empresa
-- paga"), sem validade, lido por checkout, sync da assinatura, membros e
-- /auth/me. Nao ha onde pendurar data de fim nem saber QUAL parte do total
-- veio do passe. Entao o passe vive aqui, com a validade, e enquanto esta
-- aplicado (applied_at preenchido) o job/rota SOMA qty em extra_seats_granted
-- — assim todos os gates e a cobranca na Asaas continuam funcionando sem
-- mudanca. No fim, o job diario (jobs/seatPassScheduler.js) marca 'expirado'
-- e SUBTRAI qty na mesma instrucao SQL.
--
-- Estados:
--   status      ativo | expirado | cancelado
--   applied_at  quando os assentos foram somados a extra_seats_granted.
--               NULL + status 'ativo' = passe contratado que ainda nao
--               comecou (contratou em outubro; comeca em 01/11).
--   cortesia    concedido pela Gestao Aura a empresa SEM assinatura na
--               Asaas: os assentos valem, nada e' cobrado.
--   sync_pendente  o ajuste do valor da assinatura na Asaas falhou por motivo
--               transitorio; o job tenta de novo no proximo ciclo.
--   asaas_ref   id da assinatura na Asaas cujo valor foi ajustado.
-- ========================================================================

CREATE TABLE IF NOT EXISTS seat_passes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  qty            INTEGER NOT NULL CHECK (qty > 0),
  starts_at      DATE NOT NULL,
  ends_at        DATE NOT NULL,
  status         TEXT NOT NULL DEFAULT 'ativo'
                 CHECK (status IN ('ativo', 'expirado', 'cancelado')),
  asaas_ref      TEXT,
  season         TEXT NOT NULL DEFAULT '2026-2027',
  source         TEXT NOT NULL DEFAULT 'loja' CHECK (source IN ('loja', 'admin')),
  cortesia       BOOLEAN NOT NULL DEFAULT FALSE,
  unit_price     NUMERIC(10,2) NOT NULL DEFAULT 0,
  applied_at     TIMESTAMPTZ,
  ended_at       TIMESTAMPTZ,
  ended_reason   TEXT,
  sync_pendente  BOOLEAN NOT NULL DEFAULT FALSE,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT seat_passes_ends_after_start CHECK (ends_at >= starts_at)
);

CREATE INDEX IF NOT EXISTS idx_seat_passes_company
  ON seat_passes (company_id, status);

-- Varredura do job diario: so as linhas vivas.
CREATE INDEX IF NOT EXISTS idx_seat_passes_ativos
  ON seat_passes (ends_at, starts_at) WHERE status = 'ativo';

CREATE INDEX IF NOT EXISTS idx_seat_passes_sync_pendente
  ON seat_passes (id) WHERE sync_pendente;

COMMENT ON TABLE seat_passes IS
  'Assento de temporada (374): acesso extra com validade fixa. Enquanto aplicado, qty esta somado em companies.extra_seats_granted; o job diario expira e subtrai.';
