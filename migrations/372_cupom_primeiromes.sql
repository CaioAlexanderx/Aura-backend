-- ============================================================
-- AURA. — migration 372: cupom de campanha PRIMEIROMES
--
-- 13/10/2026 — "Primeiro mes pelo calendario: quem assinar ate 31/10 nao paga
-- novembro". O sistema de cupons ja tem validade, limite por empresa
-- (coupon_redemptions, indice unico da 228) e dias gratis; so faltava a LINHA
-- do codigo em access_codes, que e o que o resgate referencia (code_id).
--
-- Prazo, data da 1a cobranca e elegibilidade vivem em src/services/promocoes.js
-- — de proposito NAO ha expires_at aqui, para a data nao existir em dois
-- lugares. Fora do prazo o codigo e recusado pelo backend.
--
-- plan/trial_days espelham o cadastro self-service (Negocio, 7 dias): quem digitar
-- o codigo no /auth/register recebe exatamente o que receberia sem codigo. No
-- checkout o backend IGNORA esses dois campos e troca por "sem cobranca ate
-- 01/12" (periodo de calendario) — ver promocoes.aplicarCampanha.
--
-- max_uses alto: o limite real e "uma vez por empresa".
--
-- Idempotente (padrao do repo).
-- ============================================================

INSERT INTO access_codes (code, type, plan, discount_pct, trial_days, max_uses, uses, is_active)
VALUES ('PRIMEIROMES', 'promo', 'negocio', 0, 7, 1000000, 0, true)
ON CONFLICT (code) DO NOTHING;
