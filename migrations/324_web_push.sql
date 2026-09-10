-- ============================================================
-- 324 — Web Push do painel
-- 10/09/2026
--
-- POR QUE: o aviso de pedido novo nunca chegou a ninguem fora do sino. O
-- push "de celular" (Expo) depende de token de app nativo, e a base inteira
-- tem ZERO tokens — o painel e web. Web Push entrega no navegador da
-- lojista mesmo com a aba fechada.
--
-- web_push_config: o par de chaves VAPID da Aura, linha unica (id = 1).
--   Gerado pelo backend no primeiro uso quando VAPID_PUBLIC_KEY e
--   VAPID_PRIVATE_KEY nao estao no ambiente — sem passo manual no Railway.
--   A chave publica nao pode mudar depois: toda inscricao existente foi
--   feita com ela.
--
-- web_push_subscriptions: um navegador inscrito por EMPRESA. O mesmo
--   navegador pode receber de duas empresas (quem administra as duas), por
--   isso a unicidade e (endpoint, company_id). O backend apaga a linha
--   quando o servico de push responde 404/410 (inscricao morta).
--
-- RLS ligado e sem politica: a chave privada nao pode sair pela API do
-- Supabase. O backend conecta como dono das tabelas e nao e afetado.
-- ============================================================

CREATE TABLE IF NOT EXISTS web_push_config (
  id          smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  public_key  text NOT NULL,
  private_key text NOT NULL,
  subject     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS web_push_subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  endpoint        text NOT NULL,
  p256dh          text NOT NULL,
  auth            text NOT NULL,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  CONSTRAINT web_push_subscriptions_endpoint_company_key UNIQUE (endpoint, company_id)
);

CREATE INDEX IF NOT EXISTS web_push_subscriptions_company_idx
  ON web_push_subscriptions (company_id);

ALTER TABLE web_push_config        ENABLE ROW LEVEL SECURITY;
ALTER TABLE web_push_subscriptions ENABLE ROW LEVEL SECURITY;
