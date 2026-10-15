-- ============================================================
-- 387 — Origem do cadastro (primeiro toque do site)
--
-- Contexto (15/10/2026, cartão t2-09, pedido do Marketing/Léo): hoje o
-- painel só sabe se o cadastro veio "do site" ou de um código. Não sabe de
-- qual anúncio, busca ou página. O site (aura-site, js/origem.js) passa a
-- guardar o PRIMEIRO TOQUE do visitante por 30 dias e a mandar no corpo do
-- POST /auth/register um objeto opcional `origem`.
--
-- companies.signup_origin (jsonb) guarda esse objeto já sanitizado pelo
-- backend (services/signupOrigem.js). Chaves possíveis, todas texto curto:
--   utm_source, utm_medium, utm_campaign, utm_content, utm_term,
--   landing_page   (só o caminho; sem query nem #)
--   referrer       (só o host)
--   first_seen_at  (ISO da primeira página)
-- Sem dado pessoal. NULL = cadastro sem origem (app, convite, antes do site
-- mandar). Nenhuma empresa existente muda.
--
-- Idempotente. O backend pode subir antes desta migration: o código grava
-- atrás de SAVEPOINT e trata 42703 (coluna ausente) como "sem origem".
-- ============================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS signup_origin JSONB NULL;

COMMENT ON COLUMN companies.signup_origin IS
  'Primeiro toque do site no cadastro (jsonb): utm_source, utm_medium, utm_campaign, utm_content, utm_term, landing_page, referrer (host), first_seen_at. NULL = sem origem.';
