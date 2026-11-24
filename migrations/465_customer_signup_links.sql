-- ============================================================
-- 465 — Cadastro do cliente por link (p-209, 23/11/2026)
--
-- Pedido de uma ótica (via Caio, 23/11): em vez de ditar nome,
-- nascimento, CPF e endereço no balcão, o lojista manda um link pelo
-- WhatsApp (envio MANUAL, wa.me) e o cliente preenche no celular. Os
-- dados caem sozinhos no cadastro.
--
-- Uma linha por link. O token NUNCA é gravado: só o sha256 dele
-- (token_hash). Link de uso único (used_at), validade de 7 dias
-- (expires_at), revogado quando a loja gera outro para o mesmo cliente
-- (revoked_at).
--
-- pending_changes: o que o cliente mandou DIFERENTE do que já estava no
-- cadastro. Nada é sobrescrito: o lojista aceita ou mantém, campo a campo.
-- Pode conter CPF e endereço, como o próprio customers; só sai na ficha
-- autenticada do cliente, nunca em listagem, log ou rota pública.
--
-- consent_version / consent_at: o aceite do aviso de privacidade, com a
-- versão do texto que o cliente viu.
--
-- Só aditiva e idempotente. Nenhuma linha existente muda.
-- Caminho de volta (depois de reverter o PR do backend):
--   DROP TABLE IF EXISTS customer_signup_links;
-- ============================================================

CREATE TABLE IF NOT EXISTS customer_signup_links (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_hash          TEXT NOT NULL,
  created_by          UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL,
  used_at             TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  -- Nome provisório do cliente criado pelo próprio link (só telefone):
  -- enquanto o nome do cadastro for este, o nome enviado entra sem virar
  -- pendência.
  placeholder_name    TEXT,
  consent_version     TEXT,
  consent_at          TIMESTAMPTZ,
  -- Só os NOMES dos campos que o envio preencheu (nunca os valores).
  filled_fields       TEXT[],
  pending_changes     JSONB,
  pending_resolved_at TIMESTAMPTZ,
  CONSTRAINT csl_token_hash_len CHECK (char_length(token_hash) = 64)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_csl_token_hash ON customer_signup_links (token_hash);
CREATE INDEX IF NOT EXISTS idx_csl_customer ON customer_signup_links (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_csl_company ON customer_signup_links (company_id, created_at DESC);
