-- ============================================================
-- 373 — Extrato bancario da Aura (OFX) conciliado com a Asaas
--
-- Contexto (13/10/2026): a receita do painel da Gestao Aura vem da Asaas
-- (webhook_logs PAYMENT_RECEIVED/CONFIRMED). Para a dupla checagem, o Caio
-- anexa o OFX mensal da conta bancaria da Aura e cada credito e casado com um
-- pagamento da Asaas (valor + janela de +-3 dias; com taxa ate 5%).
--
--   aura_extratos             um arquivo importado por mes de referencia.
--   aura_extrato_lancamentos  as linhas do arquivo. `conciliado_com` e o id do
--                             pagamento na Asaas (pay_...) ou, quando o payload
--                             nao traz id, o id do webhook_log. `com_taxa`
--                             marca o credito que chegou liquido (menor que o
--                             valor cobrado).
--
-- Reimportar o mesmo OFX nao duplica: (extrato_id, fitid) e unico e a rota
-- pula o FITID que ja existe em outro extrato do mesmo mes.
--
-- Rotas: /admin/painel/ofx (routes/adminPainelOfx.js). Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS aura_extratos (
  id              BIGSERIAL PRIMARY KEY,
  mes             DATE NOT NULL,                 -- sempre dia 1 do mes de referencia
  nome_arquivo    TEXT,
  importado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  importado_por   UUID,
  total_creditos  NUMERIC(14,2) NOT NULL DEFAULT 0,
  linhas          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_aura_extratos_mes
  ON aura_extratos (mes DESC);

CREATE TABLE IF NOT EXISTS aura_extrato_lancamentos (
  id              BIGSERIAL PRIMARY KEY,
  extrato_id      BIGINT NOT NULL REFERENCES aura_extratos(id) ON DELETE CASCADE,
  data            DATE NOT NULL,
  valor           NUMERIC(14,2) NOT NULL,
  descricao       TEXT,
  fitid           TEXT NOT NULL,
  tipo            TEXT NOT NULL CHECK (tipo IN ('credito', 'debito')),
  conciliado_com  TEXT,
  com_taxa        BOOLEAN NOT NULL DEFAULT false,
  status          TEXT NOT NULL DEFAULT 'pendente'
                  CHECK (status IN ('conciliado', 'pendente', 'ignorado'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_aura_extrato_lancamentos_extrato_fitid
  ON aura_extrato_lancamentos (extrato_id, fitid);

-- Um pagamento so casa com um credito — e tambem o "este pagamento ja foi
-- casado?" da conciliacao automatica.
CREATE UNIQUE INDEX IF NOT EXISTS uq_aura_extrato_lancamentos_conciliado
  ON aura_extrato_lancamentos (conciliado_com) WHERE conciliado_com IS NOT NULL;
