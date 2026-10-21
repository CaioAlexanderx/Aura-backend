-- ============================================================
-- 401 — Porta de entrada 1/5 (tq-66): handshake pelo WhatsApp e lead por etapa
--
-- Duas tabelas novas, nenhuma coluna nova em tabela existente:
--   signup_handshakes  código AURA-XXXX da conta nova (confirmação manual)
--   signup_leads       lead do cadastro gravado a cada etapa (quem abandona)
--
-- ── signup_handshakes ───────────────────────────────────────
--
-- Decisão do Caio (21/10/2026): toda conta nova de varejo informa o WhatsApp
-- da pessoa (validado no POST /auth/register) e recebe um código AURA-XXXX
-- para mandar no WhatsApp da Aura (5511956305269). A equipe confirma à mão
-- quando a mensagem chega: hoje o número da Aura não está na API, então não
-- há webhook de mensagem recebida. A conta NUNCA é bloqueada por isto.
--
-- O WhatsApp da pessoa fica em users.phone (coluna que já existe e que os
-- leitores de contato já usam primeiro: clients360, painel, receita, placar
-- do dia, Aurinha, Asaas). companies.phone continua sendo o telefone da loja.
-- Nenhuma coluna nova de telefone.
--
-- A origem do cadastro continua numa fonte só, companies.signup_origin
-- (migration 387); esta migration só atualiza o comentário para a chave nova
-- `ref` (código de indicação do link). Nenhuma coluna nova de origem.
--
-- Não toca em linha nenhuma: a tabela nasce vazia; contas antigas não têm
-- handshake (o painel mostra "sem handshake").
--
-- Idempotente: IF NOT EXISTS em tudo.
-- ── signup_leads ────────────────────────────────────────────
-- Pedido da Produto (21/10): o app grava o lead ao fim de cada etapa (POST
-- /auth/signup-lead, rota pública com limite por IP e por e-mail). Um lead
-- por e-mail (UNIQUE + upsert). O register liga o lead à conta pelo token
-- (company_id, user_id, convertido_em) e herda a origem. Tabela própria, e
-- não sales_leads: aquela é o CRM de prospecção, alimentado só pelo Worker
-- do site com token; uma rota pública do navegador não deve escrever nele.
-- Sem IP, sem user agent, sem senha. whatsapp_confirmado é sempre false aqui.
--
-- Idempotente: IF NOT EXISTS em tudo.
-- Caminho de volta:
--   DROP TABLE IF EXISTS signup_leads;
--   DROP TABLE IF EXISTS signup_handshakes;
-- (o código trata 42P01 como "sem handshake"/"sem lead" e o cadastro segue igual;
--  POST /auth/signup-lead responde 503 MIGRATION_PENDING.)
-- ============================================================

CREATE TABLE IF NOT EXISTS signup_handshakes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  codigo          TEXT NOT NULL CHECK (codigo ~ '^AURA-[A-Z0-9]{4}$'),
  whatsapp        TEXT NOT NULL,          -- 11 dígitos (DDD + 9 + 8), sem o 55
  estado          TEXT NOT NULL DEFAULT 'aguardando' CHECK (estado IN ('aguardando', 'confirmado')),
  confirmado_por  UUID REFERENCES users(id) ON DELETE SET NULL,   -- staff; NULL quando via = 'whatsapp'
  confirmado_via  TEXT CHECK (confirmado_via IN ('staff', 'whatsapp')),
  confirmado_em   TIMESTAMPTZ,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS signup_handshakes_codigo_key ON signup_handshakes (codigo);
CREATE INDEX IF NOT EXISTS idx_signup_handshakes_company ON signup_handshakes (company_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_signup_handshakes_aguardando ON signup_handshakes (criado_em DESC) WHERE estado = 'aguardando';

COMMENT ON TABLE signup_handshakes IS
  'Handshake do cadastro pelo WhatsApp da Aura (tq-66, 21/10/2026). Código AURA-XXXX; confirmação manual da equipe até o número entrar na API. Nunca bloqueia a conta.';

COMMENT ON COLUMN companies.signup_origin IS
  'Primeiro toque do site no cadastro (jsonb): utm_source, utm_medium, utm_campaign, utm_content, utm_term, landing_page, referrer (host), first_seen_at, ref (código de indicação do link). NULL = sem origem.';

CREATE TABLE IF NOT EXISTS signup_leads (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token                TEXT NOT NULL,                 -- 48 hex; trocado a cada etapa 1
  email                TEXT NOT NULL,                 -- minúsculo
  nome                 TEXT,
  termos_aceitos_em    TIMESTAMPTZ,
  termos_versao        TEXT,
  origem               JSONB,                         -- mesmo formato de companies.signup_origin
  documento_tipo       TEXT CHECK (documento_tipo IN ('cnpj', 'cpf')),
  documento            TEXT,                          -- só dígitos
  empresa              TEXT,
  whatsapp             TEXT,                          -- 11 dígitos, como digitado e validado
  whatsapp_confirmado  BOOLEAN NOT NULL DEFAULT false,
  etapa                SMALLINT NOT NULL DEFAULT 1 CHECK (etapa BETWEEN 1 AND 3),
  company_id           UUID REFERENCES companies(id) ON DELETE SET NULL,
  user_id              UUID REFERENCES users(id) ON DELETE SET NULL,
  convertido_em        TIMESTAMPTZ,
  criado_em            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS signup_leads_email_key ON signup_leads (email);
CREATE UNIQUE INDEX IF NOT EXISTS signup_leads_token_key ON signup_leads (token);
CREATE INDEX IF NOT EXISTS idx_signup_leads_abandonados ON signup_leads (atualizado_em DESC) WHERE convertido_em IS NULL;

COMMENT ON TABLE signup_leads IS
  'Lead do cadastro por etapa (tq-66, 21/10/2026): nome, e-mail, Termos, origem, documento e WhatsApp não confirmado. Não cria conta. O register liga pelo token (convertido_em).';
