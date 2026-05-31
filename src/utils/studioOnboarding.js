// ============================================================
// AURA Studio · helper de persistência do onboarding
//
// Item #2 da análise UX/UI: a home tem checklist, mas nada
// gravava o estado em companies.studio_settings.onboarding.{key}.
// Resultado: usuário concluía passos e o card nunca chegava a 100%.
//
// Uso:
//   const { markStudioOnboarding } = require('../utils/studioOnboarding');
//   await markStudioOnboarding(db, companyId, 'gallery');
//
// Idempotente; best-effort (não derruba a request se falhar).
// ============================================================

const VALID_KEYS = new Set([
  'product',    // cadastrou primeiro produto personalizável
  'gallery',    // subiu primeiro template à galeria
  'sla',        // configurou prazos
  'test-sale',  // fez venda teste
  'wa',         // gerou primeiro link de aprovação
]);

async function markStudioOnboarding(db, companyId, key) {
  if (!companyId || !key) return false;
  if (!VALID_KEYS.has(key)) {
    console.warn('[studioOnboarding] chave inválida:', key);
    return false;
  }
  try {
    // jsonb_set garante criação do path inteiro se ainda não existir
    await db.query(
      `UPDATE companies
          SET studio_settings = jsonb_set(
                COALESCE(studio_settings, '{}'::jsonb),
                ARRAY['onboarding', $1],
                'true'::jsonb,
                true
              ),
              updated_at = NOW()
        WHERE id = $2
          AND (
            studio_settings IS NULL
            OR COALESCE((studio_settings->'onboarding'->>$1)::boolean, false) = false
          )`,
      [key, companyId]
    );
    return true;
  } catch (err) {
    console.warn('[studioOnboarding] update falhou:', err.message);
    return false;
  }
}

module.exports = { markStudioOnboarding, VALID_KEYS };
