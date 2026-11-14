-- ============================================================
-- 451 — Falhas de conexão relatadas pelo app (14/11/2026)
--
-- Quando o app não consegue resposta do servidor ("Não conseguimos falar
-- com a Aura agora"), o pedido nem chega aqui e não deixa rastro nos logs.
-- O app anota a falha (quando, em que tela, que chamada, se o navegador se
-- achava online) e manda assim que a conexão volta. Serve para o suporte
-- saber se foi a internet da loja ou o nosso lado.
--
-- Idempotente: o app gera um id por falha (client_id); reenvio não duplica.
-- ============================================================
CREATE TABLE IF NOT EXISTS connection_failures (
  id            BIGSERIAL PRIMARY KEY,
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  client_id     TEXT NOT NULL,
  ocorreu_em    TIMESTAMPTZ NOT NULL,
  method        TEXT,
  path          TEXT,
  code          TEXT NOT NULL,          -- 'network' (sem resposta) | 'timeout'
  screen        TEXT,
  online        BOOLEAN,                -- navigator.onLine no momento (null = não sabe)
  attempts      INT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_connection_failures_client
  ON connection_failures (company_id, client_id);
CREATE INDEX IF NOT EXISTS idx_connection_failures_company_quando
  ON connection_failures (company_id, ocorreu_em DESC);
