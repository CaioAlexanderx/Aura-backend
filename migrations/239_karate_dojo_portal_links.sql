-- ============================================================
-- 239_karate_dojo_portal_links.sql
-- AURA KARATÊ — F0 Canal B: link FIXO revogável do portal do dojô
--
-- Contexto: o front (aura-app — services/karateDojoPortalApi.ts +
-- app/karate/[slug]/dojo) já implementa o Canal B por LINK FIXO
-- (?t=<token>, decisão de produto do doc ESCOPO 19/06), mas o backend só
-- tinha o fluxo OTP (migrations 185/186, karateDojoPublic.js) que ninguém
-- consome — o portal do dojô dava 404 em todas as chamadas.
--
-- Esta tabela guarda o token do link APENAS como hash (SHA-256 + segredo —
-- ver src/services/karateDojoPortalLinkService.js; mesmo espírito do portal
-- de roster, migrations 220/225: token opaco escopado ao dojô). O token em
-- claro é devolvido UMA única vez no POST /federation/:id/dojos/:dojoId/
-- portal-link e nunca mais é recuperável.
--
-- Rotação: gerar um link novo revoga o ativo anterior (revoked_at = NOW()).
-- Nunca se deleta linha — o histórico de emissões/revogações fica íntegro.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_dojo_portal_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id       UUID NOT NULL,
  federation_id UUID NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ,          -- NULL = link ativo
  created_by    UUID                  -- users.id de quem gerou (auditoria)
);

-- Status/rotação/revogação consultam por dojô.
CREATE INDEX IF NOT EXISTS idx_kdpl_dojo_id ON karate_dojo_portal_links(dojo_id);

-- A resolução do token no caminho público filtra revoked_at IS NULL sobre o
-- índice implícito do UNIQUE(token_hash) — não precisa de índice extra.
