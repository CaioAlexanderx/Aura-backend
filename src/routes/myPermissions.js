// ============================================================
// AURA. — GET /auth/my-permissions
// Retorna role + permissions do membro logado na empresa atual
// Usado pelo frontend pra gate de modulos por membro
//
// FIX 2026-09-14 (Multi-CNPJ): a empresa vem do JWT (req.user.company,
// emitido por login/refresh e por POST /auth/switch-company), nao mais da
// empresa mais antiga do usuario. Antes: ORDER BY c.created_at ASC LIMIT 1
// — quem era dono de A (mais antiga) e so membro em B via, depois de trocar
// pra B, o papel e as permissoes de A (virava owner em B).
//
// Tres contextos, na ordem em que o JWT os declara:
//
//   1. Empresa especifica (company = id, consolidated_view = false)
//      Dono = companies.owner_id OU member row com role_label 'owner' (mesma
//      regra de /auth/me e /auth/switch-company). Membro = role/permissions da
//      member row DAQUELA empresa. Sem acesso (membro removido, empresa
//      inativa) -> fail-closed: permissions = {} e no_access = true; o
//      frontend esconde tudo alem do painel. Exceto role 'admin' da plataforma,
//      que requireCompanyAccess ja trata como acesso total.
//
//   2. "Todas as empresas" (consolidated_view = true, company = null)
//      As telas consolidadas somam dados de TODAS as empresas, entao um modulo
//      so aparece se estiver liberado em TODAS (intersecao). is_owner = true
//      so se o usuario for dono de todas. Em cada empresa, permissions null
//      (dono, ou membro sem restricao gravada) conta como "libera tudo"; a
//      chave painel ausente conta como liberada — o mesmo default do
//      useVisibleModules. Sem nenhuma empresa -> cai no contexto 3.
//
//   3. Sem empresa (company = null, fora do consolidado — ex.: cadastro sem
//      empresa) -> acesso total, comportamento historico.
// ============================================================
const router = require('express').Router();
const db     = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const FULL_ACCESS = { role: 'owner', permissions: null, is_owner: true };

function parsePermissions(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function isOwnerRow(row) {
  return row.is_company_owner === true || row.role_label === 'owner';
}

// Libera `key` numa empresa? null = sem restricao. painel ausente = liberado.
function allows(perms, key) {
  if (perms == null) return true;
  if (key === 'painel') return perms.painel === undefined || perms.painel === true;
  return !!perms[key];
}

// Intersecao das permissions de varias empresas (contexto 2).
// Devolve null quando nenhuma empresa restringe nada.
function intersectPermissions(permsList) {
  const restricted = permsList.filter((p) => p != null);
  if (!restricted.length) return null;
  const keys = new Set(['painel']);
  restricted.forEach((p) => Object.keys(p).forEach((k) => keys.add(k)));
  const out = {};
  keys.forEach((k) => { out[k] = permsList.every((p) => allows(p, k)); });
  return out;
}

const MEMBER_SELECT =
  `SELECT c.id AS company_id, c.plan,
          (c.owner_id = $1) AS is_company_owner,
          cm.role_label, cm.permissions
     FROM companies c
     LEFT JOIN company_members cm
       ON cm.company_id = c.id AND cm.user_id = $1
      AND cm.status = 'active' AND cm.is_active = true
    WHERE c.is_active = true
      AND (c.owner_id = $1 OR cm.user_id = $1)`;

router.get('/my-permissions', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const companyId = req.user.company || null;
    const consolidated = !!req.user.consolidated_view;

    // ── 1. Empresa especifica do JWT ──
    if (companyId && !consolidated) {
      const { rows } = await db.query(
        `${MEMBER_SELECT} AND c.id = $2 LIMIT 1`,
        [userId, companyId]
      );

      if (!rows.length) {
        if (req.user.role === 'admin') {
          return res.json({ ...FULL_ACCESS, company_id: companyId });
        }
        return res.json({
          role: null, permissions: {}, is_owner: false,
          company_id: companyId, no_access: true,
        });
      }

      const m = rows[0];
      const isOwner = isOwnerRow(m);
      return res.json({
        role: isOwner ? 'owner' : m.role_label,
        permissions: isOwner ? null : parsePermissions(m.permissions), // null = acesso total
        is_owner: isOwner,
        company_id: m.company_id,
        plan: m.plan,
      });
    }

    // ── 2. "Todas as empresas" ──
    if (consolidated) {
      const { rows } = await db.query(MEMBER_SELECT, [userId]);
      if (rows.length) {
        const allOwner = rows.every(isOwnerRow);
        const permissions = allOwner
          ? null
          : intersectPermissions(rows.map((r) => (isOwnerRow(r) ? null : parsePermissions(r.permissions))));
        return res.json({
          role: allOwner ? 'owner' : 'member',
          permissions,
          is_owner: allOwner,
          company_id: null,
          consolidated_view: true,
          companies_count: rows.length,
        });
      }
    }

    // ── 3. Sem empresa — acesso total (owner padrao) ──
    return res.json(FULL_ACCESS);
  } catch (err) {
    console.error('[my-permissions] error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar permissoes' });
  }
});

module.exports = router;
