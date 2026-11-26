-- ============================================================
-- 472 — Saldo do WhatsApp: tres saldos com limite RIGIDO (26/11/2026)
--
-- Tela nova do WhatsApp. Cada mensagem que custa dinheiro sai de um de tres
-- saldos, e sem saldo nada entra na fila:
--   novidades  (MARKETING)  Aniversario, Venda+ e oferta do Crediario
--   avisos     (UTILITY)    parcelas do crediario e convites de conversa fechada
--   aurinha                 cada conversa que a Aurinha atende
--
-- wa_saldo_lancamentos e o LIVRO-RAZAO: cada linha e um credito (+) ou um
-- debito (-) de UM saldo. O saldo nunca e um contador que se atualiza no
-- lugar — e a soma das linhas —, entao "por que a loja ficou sem saldo?"
-- sempre tem resposta. O debito nasce na MESMA transacao do INSERT na
-- wa_outbox (servico waSaldo.reservar), sob um advisory lock por
-- (empresa, saldo): dois envios simultaneos nunca gastam a mesma mensagem.
--
--   kind   consumo      debito (qty < 0), guarda a mensagem
--          estorno      devolucao (qty > 0) quando o envio falha de vez
--          pacote       credito de pacote PAGO (so entra com o dinheiro)
--          boas_vindas  presente unico do Essencial (nao renova)
--   fonte  franquia     cota mensal do plano (renova; vale no `periodo`)
--          boas_vindas  o presente
--          pacote       saldo comprado (nao vence)
--   ref_key  chave de idempotencia, UNICA por empresa. Ex.: outbox:<id>,
--          estorno:outbox:<id>, pacote:<id do pacote>, boas_vindas:avisos.
--          Webhook repetido ou retry nao credita nem debita duas vezes.
--
-- A franquia mensal NAO e gravada como credito: o total vem do plano da
-- empresa na hora da leitura, e o `periodo` (1o dia do mes em Sao Paulo)
-- separa o uso de cada mes. Virou o mes, o uso do mes novo comeca em zero.
--
-- wa_marketing_packs (332) passa a servir aos tres saldos: ganha `bucket`.
-- Os pacotes que ja estavam ativos viram credito no livro-razao (backfill
-- abaixo, idempotente pelo ref_key).
--
-- Nada aqui liga o limite: o servico so barra com WA_SALDO_ATIVO ligado.
-- Aditiva e idempotente; sem CONCURRENTLY. Caminho de volta:
--   DROP TABLE IF EXISTS wa_saldo_lancamentos;
--   ALTER TABLE wa_marketing_packs DROP COLUMN IF EXISTS bucket;
-- ============================================================

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS wa_saldo_lancamentos (
  id          BIGSERIAL   PRIMARY KEY,
  company_id  UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bucket      TEXT        NOT NULL CHECK (bucket IN ('novidades','avisos','aurinha')),
  kind        TEXT        NOT NULL CHECK (kind IN ('consumo','estorno','pacote','boas_vindas')),
  fonte       TEXT        NOT NULL CHECK (fonte IN ('franquia','boas_vindas','pacote')),
  qty         INT         NOT NULL,
  periodo     DATE,
  ref_key     TEXT        NOT NULL,
  outbox_id   UUID,
  pack_id     UUID,
  conversa_id UUID,
  meta        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT wa_saldo_lanc_sinal CHECK (
    (kind = 'consumo' AND qty < 0) OR (kind <> 'consumo' AND qty > 0)
  ),
  CONSTRAINT wa_saldo_lanc_periodo CHECK (fonte <> 'franquia' OR periodo IS NOT NULL),
  CONSTRAINT wa_saldo_lanc_fonte CHECK (
    (kind = 'pacote' AND fonte = 'pacote') OR (kind = 'boas_vindas' AND fonte = 'boas_vindas')
    OR kind IN ('consumo','estorno')
  ),
  UNIQUE (company_id, ref_key)
);

COMMENT ON TABLE wa_saldo_lancamentos IS
  'Livro-razao dos saldos do WhatsApp (novidades, avisos, aurinha). Saldo = soma das linhas; debito nasce na mesma transacao do enfileirar (waSaldo.reservar).';

-- Leitura quente: soma por (empresa, saldo, fonte, periodo).
CREATE INDEX IF NOT EXISTS idx_wa_saldo_lanc_saldo
  ON wa_saldo_lancamentos(company_id, bucket, fonte, periodo);

-- Devolver o debito de uma mensagem que falhou de vez acha a linha pelo outbox.
CREATE INDEX IF NOT EXISTS idx_wa_saldo_lanc_outbox
  ON wa_saldo_lancamentos(outbox_id) WHERE outbox_id IS NOT NULL;

-- Aurinha: "esta conversa ja foi contada nas ultimas 24 h?"
CREATE INDEX IF NOT EXISTS idx_wa_saldo_lanc_conversa
  ON wa_saldo_lancamentos(company_id, conversa_id, created_at DESC) WHERE conversa_id IS NOT NULL;

-- Um pacote credita UMA vez, qualquer que seja o caminho (webhook ou Gestao).
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_saldo_lanc_pacote
  ON wa_saldo_lancamentos(pack_id) WHERE kind = 'pacote' AND pack_id IS NOT NULL;

-- ── Pacotes: o mesmo fluxo da 332 serve aos tres saldos ─────
ALTER TABLE wa_marketing_packs
  ADD COLUMN IF NOT EXISTS bucket TEXT NOT NULL DEFAULT 'novidades'
    CHECK (bucket IN ('novidades','avisos','aurinha'));

COMMENT ON COLUMN wa_marketing_packs.bucket IS
  'Saldo que o pacote credita: novidades (marketing) | avisos (utility) | aurinha. Pacotes anteriores a 472 sao de novidades.';

-- ── Backfill: pacotes de novidades ja pagos e ainda validos ──
-- Idempotente: o ref_key (e o indice unico por pack_id) impede repetir.
INSERT INTO wa_saldo_lancamentos (company_id, bucket, kind, fonte, qty, ref_key, pack_id, meta)
SELECT p.company_id, p.bucket, 'pacote', 'pacote', p.qty, 'pacote:' || p.id::text, p.id,
       jsonb_build_object('origem', 'backfill_472')
  FROM wa_marketing_packs p
 WHERE p.status = 'active'
   AND p.valid_until >= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
ON CONFLICT DO NOTHING;
