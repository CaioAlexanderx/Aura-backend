// ============================================================
// AURA KARATÊ — RBAC (Wave 0 / Fundação)
// Drop-in para src/config/karateRoles.js.
//
// Decisão de arquitetura (validada lendo src/middleware/auth.js):
//  - Roles de empresa já vivem em company_members.role_label (texto).
//    => NÃO precisa de migration. Os papéis karatê são apenas valores
//       de role_label e reaproveitam requireCompanyAccess({ roles }).
//  - Feature flags (exames online, ranking público, carteirinha) usam o
//    requireFeature(...) já existente.
//  - 'practitioner' NÃO é company_member: o praticante é um customer.
//    O portal do praticante usa auth própria (token/OTP), não estes guards.
//    Ver requirePractitionerToken (a implementar na Fase 3) — fora daqui.
// ============================================================

const { requireAuth, requireCompanyAccess, requireFeature } = require('../middleware/auth');

// ── Papéis (valores de company_members.role_label) ──────────
const KARATE_ROLES = Object.freeze({
  FEDERATION_ADMIN:    'federation_admin',    // tudo: config, financeiro, resultados, export
  FEDERATION_STAFF:    'federation_staff',    // cadastros, exames, competições (sem config/financeiro sensível)
  FEDERATION_VIEWER:   'federation_viewer',   // leitura geral
  FEDERATION_EXAMINER: 'federation_examiner', // só lançar resultados de banca
  DOJO_OWNER:          'dojo_owner',          // visão do próprio dojô + inscrições
  SENSEI:              'sensei',              // idem dojo_owner
  // 'practitioner' é tratado fora deste módulo (auth de portal)
});

// ── Grupos de conveniência (quem pode o quê) ────────────────
const GROUPS = Object.freeze({
  // escrita administrativa plena
  ADMIN_ONLY: [KARATE_ROLES.FEDERATION_ADMIN],
  // operação: criar/editar cadastros, exames, competições
  STAFF_WRITE: [KARATE_ROLES.FEDERATION_ADMIN, KARATE_ROLES.FEDERATION_STAFF],
  // lançar resultados de exame
  EXAM_RESULTS: [KARATE_ROLES.FEDERATION_ADMIN, KARATE_ROLES.FEDERATION_EXAMINER],
  // qualquer papel da federação pode ler
  FEDERATION_READ: [
    KARATE_ROLES.FEDERATION_ADMIN,
    KARATE_ROLES.FEDERATION_STAFF,
    KARATE_ROLES.FEDERATION_VIEWER,
    KARATE_ROLES.FEDERATION_EXAMINER,
  ],
  // visão de dojô (escopo restrito ao próprio dojô — reforçar no handler)
  DOJO_SCOPE: [KARATE_ROLES.DOJO_OWNER, KARATE_ROLES.SENSEI],
});

// ── Guards prontos (componíveis com requireAuth) ────────────
// Uso: router.post('/federation/:id/dojos', ...requireFederation(GROUPS.STAFF_WRITE), handler)
// requireCompanyAccess já: 1) deixa req.user.role==='admin' (plataforma) passar;
// 2) resolve owner/role_label no :id; 3) seta req.companyRole; 4) 403 se fora de opts.roles.
function requireFederation(roles) {
  return [requireAuth, requireCompanyAccess({ roles })];
}

const guards = {
  adminOnly:   () => requireFederation(GROUPS.ADMIN_ONLY),
  staffWrite:  () => requireFederation(GROUPS.STAFF_WRITE),
  examResults: () => requireFederation(GROUPS.EXAM_RESULTS),
  read:        () => requireFederation(GROUPS.FEDERATION_READ),
  dojoScope:   () => requireFederation([...GROUPS.FEDERATION_READ, ...GROUPS.DOJO_SCOPE]),
};

// ── Feature flags karatê (usar com requireFeature) ──────────
const KARATE_FEATURES = Object.freeze({
  ONLINE_EXAMS:    'karate_online_exams',
  PUBLIC_RANKING:  'karate_public_ranking',
  DIGITAL_CARD:    'karate_digital_card',
  AUTO_NFSE:       'karate_auto_nfse',
  WHATSAPP_RULES:  'karate_whatsapp_rules',
});

// ── Track G (acesso real): contexto karatê derivado da company ──────
// Função PURA (sem DB). Recebe a row de company já carregada em
// resolveDefaultContext / /auth/me / /auth/register e devolve o
// federationId real + o papel karatê normalizado.
//
// Espera os campos: { id, vertical_active, federation_id, member_role }.
//
//  - federação (vertical_active='karate_federation') → federation_id = company.id
//  - dojô       (vertical_active='karate_dojo')       → federation_id = company.federation_id (pai)
//  - outro vertical                                   → { null, null }
//  - member_role 'owner' vira federation_admin (federação) / dojo_owner (dojô);
//    demais papéis vêm crus de company_members.role_label.
function resolveKarateContext(company) {
  const empty = { federation_id: null, karate_role: null };
  if (!company) return empty;
  const v = company.vertical_active;
  if (v !== 'karate_federation' && v !== 'karate_dojo') return empty;
  const isFederation = v === 'karate_federation';
  const federation_id = isFederation
    ? (company.id || null)
    : (company.federation_id || null);
  const raw = company.member_role || 'owner';
  const karate_role = raw === 'owner'
    ? (isFederation ? KARATE_ROLES.FEDERATION_ADMIN : KARATE_ROLES.DOJO_OWNER)
    : raw;
  return { federation_id, karate_role };
}

module.exports = {
  KARATE_ROLES,
  GROUPS,
  guards,
  requireFederation,
  requireFeature, // reexport para conveniência nas rotas
  KARATE_FEATURES,
  resolveKarateContext,
};

// ── Exemplo de uso numa rota (src/routes/karateDojos.js) ────
//
//   const { guards } = require('../config/karateRoles');
//   router.get   ('/federation/:id/dojos',        ...guards.read(),       listDojos);
//   router.post  ('/federation/:id/dojos',        ...guards.staffWrite(), createDojo);
//   router.patch ('/federation/:id/dojos/:dojoId',...guards.staffWrite(), updateDojo);
//
// Resultado: federation_viewer lê; staff/admin escrevem; examiner não
// cria dojô; dojo_owner/sensei só entram via guards.dojoScope() onde o
// handler ainda filtra pelo dojo_id do próprio usuário.
