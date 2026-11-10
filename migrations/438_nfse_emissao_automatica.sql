-- ============================================================
-- 438 — Emissão automática da NFS-e (venda no Caixa, OS concluída,
-- pagamento recebido).
--
-- Por quê: hoje nenhuma venda, OS ou recebimento chama o emissor; só a rota
-- manual POST /companies/:id/nfse. A emissão automática (services/
-- nfseAutomatica.js) precisa de três coisas que o banco não tem:
--   1. opt-in por empresa (nfse_config.emissao_automatica, desligado) e a
--      data em que foi ligado (nada anterior a ela sai sozinho);
--   2. um registro por PRESTAÇÃO (origem + código de tributação) que diga se
--      a nota já saiu, está saindo, falta dado do tomador ou deu erro — é o
--      que impede o segundo gatilho da mesma prestação de emitir de novo;
--   3. em nfse, o id da origem (source_id) ao lado do source_type que existe
--      desde a 058, para achar a nota de uma venda/OS e reimprimir.
--
-- Aditiva: só tabela e colunas novas, sem backfill. Sem a flag
-- NFSE_AUTOMATICA_ENABLED e sem o opt-in nada lê estas colunas.
--
-- Caminho de volta (manual):
--   DROP TABLE IF EXISTS nfse_automatica;
--   DROP INDEX IF EXISTS uq_nfse_origem_ativa;
--   DROP INDEX IF EXISTS idx_nfse_origem;
--   ALTER TABLE nfse DROP COLUMN IF EXISTS source_id;
--   ALTER TABLE nfse_config DROP COLUMN IF EXISTS emissao_automatica,
--     DROP COLUMN IF EXISTS emissao_automatica_desde;
-- ============================================================

-- ── 1. opt-in por empresa ───────────────────────────────────
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS emissao_automatica       boolean NOT NULL DEFAULT false;
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS emissao_automatica_desde timestamptz;

COMMENT ON COLUMN nfse_config.emissao_automatica IS
  'Opt-in da emissão automática da NFS-e (venda com serviço, OS concluída, pagamento recebido). Só vale com NFSE_AUTOMATICA_ENABLED e provider nacional.';
COMMENT ON COLUMN nfse_config.emissao_automatica_desde IS
  'Quando o opt-in foi ligado. Venda/OS anterior a esta data não emite sozinha (o recebimento de uma venda antiga não gera nota retroativa).';

-- ── 2. nfse: id da origem ───────────────────────────────────
ALTER TABLE nfse ADD COLUMN IF NOT EXISTS source_id uuid;

COMMENT ON COLUMN nfse.source_id IS
  'Id da origem da nota (sales.id para source_type pdv_sale, service_orders.id para service_order). Preenchido pela emissão automática.';

CREATE INDEX IF NOT EXISTS idx_nfse_origem
  ON nfse(company_id, source_type, source_id) WHERE source_id IS NOT NULL;

-- Uma nota viva por prestação e código: cancelada/rejeitada/erro liberam
-- uma nova tentativa (que tem outra chave de idempotência).
CREATE UNIQUE INDEX IF NOT EXISTS uq_nfse_origem_ativa
  ON nfse(company_id, source_type, source_id, service_code)
  WHERE source_id IS NOT NULL AND status NOT IN ('cancelada', 'rejeitada', 'erro');

-- ── 3. nfse_automatica: estado de cada prestação ────────────
CREATE TABLE IF NOT EXISTS nfse_automatica (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- A prestação: a venda do Caixa ou a OS. O pagamento nunca é origem —
  -- ele aponta para a venda que está pagando (vinculos).
  origem_tipo      varchar(10) NOT NULL CHECK (origem_tipo IN ('venda', 'os')),
  origem_id        uuid NOT NULL,
  ctribnac         varchar(6) NOT NULL,
  -- quem criou o registro: venda | os | pagamento | manual (app)
  gatilho          varchar(12) NOT NULL CHECK (gatilho IN ('venda', 'os', 'pagamento', 'manual')),
  status           varchar(16) NOT NULL DEFAULT 'emitindo'
                   CHECK (status IN ('emitindo', 'emitida', 'pendente_dados', 'erro', 'rejeitada', 'cancelada')),
  motivo           text,          -- texto para a lojista ("falta CPF/CNPJ de quem contratou")
  motivo_codigo    varchar(40),   -- estável para o app (SEM_TOMADOR, CONFIG_NAO_APTA, ...)
  tentativa        integer NOT NULL DEFAULT 1 CHECK (tentativa >= 1),
  idempotency_key  varchar(120),
  nfse_id          uuid REFERENCES nfse(id) ON DELETE SET NULL,
  customer_id      uuid,
  tomador          jsonb,         -- tomador completado pelo app (vale mais que o cadastro)
  nota             jsonb,         -- exatamente o que foi ao emissor (retomada usa o mesmo)
  itens            jsonb NOT NULL DEFAULT '[]'::jsonb,
  valor            numeric(12, 2),
  -- outros gatilhos da mesma prestação que encontraram este registro:
  -- [{ "gatilho": "pagamento", "ref": "<id>", "em": "<iso>" }]
  vinculos         jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT NOW(),
  updated_at       timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_nfse_automatica_prestacao
  ON nfse_automatica(company_id, origem_tipo, origem_id, ctribnac);
CREATE INDEX IF NOT EXISTS idx_nfse_automatica_status
  ON nfse_automatica(company_id, status, updated_at DESC);

COMMENT ON TABLE nfse_automatica IS
  'Emissão automática da NFS-e: um registro por prestação (venda/OS) e código de tributação. O UNIQUE impede dois gatilhos de emitirem a mesma prestação.';

DROP TRIGGER IF EXISTS trg_nfse_automatica_updated_at ON nfse_automatica;
CREATE TRIGGER trg_nfse_automatica_updated_at
  BEFORE UPDATE ON nfse_automatica
  FOR EACH ROW EXECUTE FUNCTION update_nfse_updated_at();
