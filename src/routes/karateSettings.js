// ============================================================
// AURA KARATÊ — Track H: Configurações da Federação
//
// Montado sob /federation/:id  (via src/routes/index.js).
// Todos os endpoints requerem federation_admin (adminOnly).
//
// Seções:
//   1. Modelos de anuidade — via karateFees.js (existente, GET/PUT /financial/fees)
//      [não duplicado aqui; wired no FE diretamente via karateApi.getAnnualFees]
//
//   2. Régua de cobrança — via karateReminders.js (existente, Track I)
//      [não duplicado aqui; wired no FE diretamente]
//
//   3. Equipe FPKT
//      GET  /settings/members           — lista membros da federação com role_label karatê
//      POST /settings/members/invite     — convite com papel karatê
//      PATCH /settings/members/:mid/role — edita papel do membro
//      DELETE /settings/members/:mid     — remove membro (suspend)
//
//   4. Recursos (feature flags)
//      GET  /settings/flags              — lê module_overrides (karatê)
//      PUT  /settings/flags              — salva module_overrides (karatê)
//
//   5. Identidade + Contato + Dados fiscais
//      GET  /settings/identity           — lê campos de identidade da federação
//      PUT  /settings/identity           — salva identidade + contato + fiscal
//
//   6. Logo da federação (upload)
//      POST   /settings/identity/logo    — sobe a logo (base64 → R2)
//      DELETE /settings/identity/logo    — remove a logo
//
// Defensivo: 42P01 (tabela ausente) e 42703 (coluna ausente) tratados.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { sendInviteEmail } = require('../services/mailer');
const { buildInviteUrl } = require('../services/members');
const { uploadToR2 } = require('../utils/r2Storage');

// ── Helpers ────────────────────────────────────────────────────

// Roles válidos de federação
const VALID_KARATE_ROLES = ['federation_admin', 'federation_staff', 'federation_examiner'];

const ROLE_LABEL = {
  federation_admin:    'Admin',
  federation_staff:    'Staff',
  federation_examiner: 'Examinador',
};

// ── karate_affiliation_prefix (migration 337) ───────────────────
// O prefixo do código de filiação dos dojôs (FPKT-001, JKA-001) deixou de
// ser hardcoded em karateService.js e virou coluna da federação. O backend
// sobe antes da migration ser aplicada, então a coluna entra no SELECT/UPDATE
// só enquanto a flag estiver ligada; o primeiro 42703 a desliga para o
// processo inteiro (cache module-level — sem try/catch por request).
let HAS_AFFILIATION_PREFIX_COL = true;

function affiliationPrefixCol() {
  return HAS_AFFILIATION_PREFIX_COL ? ', karate_affiliation_prefix' : '';
}

// Retorna true se a flag foi desligada agora — quem chamou deve repetir a
// consulta (affiliationPrefixCol() já reflete a mudança).
function disableMissingPrefixCol(e) {
  if (e.code !== '42703') return false;
  if (!HAS_AFFILIATION_PREFIX_COL) return false;
  if (!/karate_affiliation_prefix/.test(e.message || '')) return false;
  HAS_AFFILIATION_PREFIX_COL = false;
  return true;
}

// Prefixo aceito: A-Z e 0-9, 2 a 12 caracteres. Sem hífen — o hífen é o
// separador que o gerador acrescenta (PREFIXO-NNN); aceitá-lo aqui produziria
// 'JKA--001'. String vazia = "limpar" (volta a resolver na hora).
const AFFILIATION_PREFIX_RE = /^[A-Z0-9]{2,12}$/;

const REGIME_LABEL = {
  simples_nacional: 'Simples Nacional',
  lucro_presumido:  'Lucro Presumido',
  imune_isenta:     'Imune / Isenta',
};

// ============================================================
// SEÇÃO 3 — Equipe FPKT
// ============================================================

// GET /settings/members
router.get('/settings/members', ...guards.adminOnly(), async (req, res) => {
  const fed = req.params.id;
  try {
    const { rows } = await db.query(
      `SELECT
         m.id, m.role_label, m.status, m.is_active, m.invite_email, m.invited_at,
         u.id AS user_id, u.full_name AS name, u.email
       FROM company_members m
       LEFT JOIN users u ON u.id = m.user_id
       WHERE m.company_id = $1
         AND m.status != 'suspended'
         AND m.role_label IN ('federation_admin','federation_staff','federation_examiner')
       ORDER BY
         CASE m.role_label
           WHEN 'federation_admin' THEN 1
           WHEN 'federation_staff' THEN 2
           ELSE 3 END,
         COALESCE(u.full_name, m.invite_email)`,
      [fed]
    );
    const members = rows.map((m) => ({
      id:          m.id,
      user_id:     m.user_id,
      name:        m.name || m.invite_email || 'Pendente',
      email:       m.email || m.invite_email || '',
      role:        m.role_label,
      role_label:  ROLE_LABEL[m.role_label] || m.role_label,
      status:      m.status === 'pending' ? 'pendente' : 'ativo',
      is_pending:  m.status === 'pending',
    }));
    return res.json({ members });
  } catch (e) {
    console.error('[karateSettings] members list:', e.message);
    return res.status(500).json({ error: 'Erro ao listar equipe' });
  }
});

// POST /settings/members/invite
router.post('/settings/members/invite', ...guards.adminOnly(), async (req, res) => {
  const fed = req.params.id;
  const { email, role } = req.body || {};

  if (!email || !String(email).trim()) {
    return res.status(422).json({ error: 'email é obrigatório' });
  }
  if (!VALID_KARATE_ROLES.includes(role)) {
    return res.status(422).json({ error: 'Papel inválido. Use: federation_admin, federation_staff, federation_examiner' });
  }

  const emailClean = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailClean)) {
    return res.status(422).json({ error: 'E-mail inválido' });
  }

  try {
    // Verifica se já existe convite/membro ativo para este email
    const { rows: existing } = await db.query(
      `SELECT m.id, m.status FROM company_members m
       LEFT JOIN users u ON u.id = m.user_id
       WHERE m.company_id = $1
         AND m.status != 'suspended'
         AND (u.email = $2 OR m.invite_email = $2)`,
      [fed, emailClean]
    );
    if (existing.length) {
      return res.status(409).json({ error: 'Este e-mail já é membro ou tem convite pendente nesta federação' });
    }

    // Resolve user_id se o email já existe no sistema
    const { rows: userRows } = await db.query('SELECT id FROM users WHERE email = $1', [emailClean]);
    const userId = userRows[0]?.id || null;

    const inviteToken = uuidv4();
    const inviteUrl   = buildInviteUrl(inviteToken);

    const { rows: fed_rows } = await db.query(
      'SELECT COALESCE(name, slug, id::text) AS fed_name FROM companies WHERE id = $1', [fed]
    );
    const companyName = fed_rows[0]?.fed_name || 'Federação';

    const { rows: invited } = await db.query(
      `INSERT INTO company_members
         (company_id, user_id, role_label, permissions, invited_by, invited_at,
          invite_token, invite_email, status, is_active)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, 'pending', false)
       RETURNING id, role_label, invite_email, status`,
      [fed, userId, role, JSON.stringify({}), req.user?.id || null, inviteToken, emailClean]
    );

    // Envia email de convite (falha silenciosa — não bloqueia a resposta)
    sendInviteEmail(emailClean, inviteUrl, companyName, ROLE_LABEL[role] || role, req.user?.full_name || 'a federação')
      .then((r) => console.log('[karateSettings] invite email sent:', r?.id || '', 'to', emailClean))
      .catch((e) => console.error('[karateSettings] invite email failed:', e.message));

    return res.status(201).json({
      id:          invited[0].id,
      email:       emailClean,
      role:        invited[0].role_label,
      role_label:  ROLE_LABEL[invited[0].role_label] || invited[0].role_label,
      status:      'pendente',
      is_pending:  true,
      invite_url:  inviteUrl,
    });
  } catch (e) {
    console.error('[karateSettings] invite:', e.message);
    return res.status(500).json({ error: 'Erro ao enviar convite' });
  }
});

// PATCH /settings/members/:mid/role
router.patch('/settings/members/:mid/role', ...guards.adminOnly(), async (req, res) => {
  const fed = req.params.id;
  const mid = req.params.mid;
  const { role } = req.body || {};

  if (!VALID_KARATE_ROLES.includes(role)) {
    return res.status(422).json({ error: 'Papel inválido' });
  }

  try {
    const { rows } = await db.query(
      `UPDATE company_members SET role_label = $1
       WHERE id = $2 AND company_id = $3
         AND role_label IN ('federation_admin','federation_staff','federation_examiner')
       RETURNING id, role_label`,
      [role, mid, fed]
    );
    if (!rows.length) return res.status(404).json({ error: 'Membro não encontrado' });
    return res.json({ id: rows[0].id, role: rows[0].role_label, role_label: ROLE_LABEL[rows[0].role_label] || rows[0].role_label });
  } catch (e) {
    console.error('[karateSettings] patch role:', e.message);
    return res.status(500).json({ error: 'Erro ao atualizar papel' });
  }
});

// DELETE /settings/members/:mid
router.delete('/settings/members/:mid', ...guards.adminOnly(), async (req, res) => {
  const fed = req.params.id;
  const mid = req.params.mid;

  try {
    const { rows } = await db.query(
      `SELECT id, user_id, status FROM company_members
       WHERE id = $1 AND company_id = $2
         AND role_label IN ('federation_admin','federation_staff','federation_examiner')`,
      [mid, fed]
    );
    if (!rows.length) return res.status(404).json({ error: 'Membro não encontrado' });

    // Protege contra auto-remoção
    if (rows[0].user_id && req.user && rows[0].user_id === req.user.id) {
      return res.status(400).json({ error: 'Você não pode remover a si mesmo' });
    }

    if (rows[0].status === 'pending') {
      await db.query('DELETE FROM company_members WHERE id = $1', [mid]);
      return res.json({ removed: true });
    } else {
      await db.query(
        `UPDATE company_members SET status = 'suspended', is_active = false WHERE id = $1`, [mid]
      );
      return res.json({ removed: true });
    }
  } catch (e) {
    console.error('[karateSettings] delete member:', e.message);
    return res.status(500).json({ error: 'Erro ao remover membro' });
  }
});

// ============================================================
// SEÇÃO 4 — Recursos (feature flags via module_overrides)
// ============================================================

// Flags karatê suportados (espelha mockup)
const KARATE_FLAGS = ['competicoes', 'carteirinha', 'conexao', 'portal'];

// GET /settings/flags
router.get('/settings/flags', ...guards.adminOnly(), async (req, res) => {
  const fed = req.params.id;
  try {
    const { rows } = await db.query(
      `SELECT module_overrides FROM companies WHERE id = $1`, [fed]
    );
    if (!rows.length) return res.status(404).json({ error: 'Federação não encontrada' });
    const overrides = rows[0].module_overrides || {};
    // Defaults: competicoes=true, carteirinha=true, conexao=false, portal=true
    const defaults = { competicoes: true, carteirinha: true, conexao: false, portal: true };
    const flags = {};
    for (const key of KARATE_FLAGS) {
      flags[key] = overrides['karate_' + key] !== undefined
        ? !!overrides['karate_' + key]
        : defaults[key] !== undefined ? defaults[key] : false;
    }
    return res.json({ flags });
  } catch (e) {
    if (e.code === '42703') {
      // module_overrides coluna ausente — defensivo
      return res.json({ flags: { competicoes: true, carteirinha: true, conexao: false, portal: true } });
    }
    console.error('[karateSettings] flags get:', e.message);
    return res.status(500).json({ error: 'Erro ao ler recursos' });
  }
});

// PUT /settings/flags
router.put('/settings/flags', ...guards.adminOnly(), async (req, res) => {
  const fed = req.params.id;
  const { flags } = req.body || {};

  if (!flags || typeof flags !== 'object') {
    return res.status(422).json({ error: 'flags deve ser um objeto' });
  }

  try {
    // Lê module_overrides atual para merge (não sobrescreve flags não-karatê)
    const { rows } = await db.query(
      `SELECT module_overrides FROM companies WHERE id = $1`, [fed]
    );
    if (!rows.length) return res.status(404).json({ error: 'Federação não encontrada' });

    const current = rows[0].module_overrides || {};
    const updated = { ...current };
    for (const key of KARATE_FLAGS) {
      if (flags[key] !== undefined) {
        updated['karate_' + key] = !!flags[key];
      }
    }

    await db.query(
      `UPDATE companies SET module_overrides = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(updated), fed]
    );

    // Retorna os valores salvos
    const saved = {};
    for (const key of KARATE_FLAGS) {
      saved[key] = updated['karate_' + key] !== undefined ? !!updated['karate_' + key]
        : (key === 'conexao' ? false : true);
    }
    return res.json({ flags: saved });
  } catch (e) {
    if (e.code === '42703') {
      return res.status(503).json({ error: 'module_overrides não disponível (coluna ausente)' });
    }
    console.error('[karateSettings] flags put:', e.message);
    return res.status(500).json({ error: 'Erro ao salvar recursos' });
  }
});

// ============================================================
// SEÇÃO 5 — Identidade + Contato + Dados fiscais
// ============================================================

// GET /settings/identity
router.get('/settings/identity', ...guards.adminOnly(), async (req, res) => {
  const fed = req.params.id;
  try {
    const { rows } = await readIdentity(fed);
    if (!rows.length) return res.status(404).json({ error: 'Federação não encontrada' });
    const r = rows[0];
    return res.json({
      name:                r.name,
      slug:                r.slug,
      logo_url:            r.karate_logo_url,
      // null = ainda não declarado; karateService resolve na hora a partir
      // dos dojôs existentes (ou do slug, para federação nova).
      affiliation_prefix:  r.karate_affiliation_prefix || null,
      wa_phone_display:    r.wa_phone_display,
      secretary_email:     r.secretary_email,
      cnpj:                r.cnpj,
      legal_name:          r.legal_name,
      inscricao_municipal: r.inscricao_municipal,
      regime_tributario:   r.regime_tributario,
      regime_label:        REGIME_LABEL[r.regime_tributario] || null,
      city:                r.city,
      state:               r.state,
    });
  } catch (e) {
    console.error('[karateSettings] identity get:', e.message);
    return res.status(500).json({ error: 'Erro ao ler identidade' });
  }
});

// PUT /settings/identity
router.put('/settings/identity', ...guards.adminOnly(), async (req, res) => {
  const fed = req.params.id;
  const body = req.body || {};

  // Campos permitidos + validações
  const UPDATABLE = [
    'name', 'slug', 'karate_logo_url', 'karate_affiliation_prefix', 'wa_phone_display',
    'email', 'cnpj', 'legal_name', 'inscricao_municipal',
    'regime_tributario', 'city', 'state',
  ];

  const REGIME_VALID = ['simples_nacional', 'lucro_presumido', 'imune_isenta', null, ''];

  if (body.regime_tributario !== undefined && !REGIME_VALID.includes(body.regime_tributario)) {
    return res.status(422).json({ error: 'regime_tributario inválido. Use: simples_nacional, lucro_presumido, imune_isenta' });
  }

  if (body.slug && !/^[a-z0-9_-]+$/.test(body.slug)) {
    return res.status(422).json({ error: 'Slug inválido (use apenas letras minúsculas, números, hífens e underscores)' });
  }

  // affiliation_prefix é normalizado ANTES de validar: o admin digita "jka"
  // ou "JKA-" e o que importa é o resultado.
  if (body.affiliation_prefix !== undefined && body.affiliation_prefix !== null) {
    const norm = String(body.affiliation_prefix).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (norm && !AFFILIATION_PREFIX_RE.test(norm)) {
      return res.status(422).json({
        error: 'Prefixo de filiação inválido (use 2 a 12 letras ou números, sem hífen)',
        code: 'VALIDATION_ERROR',
      });
    }
    body.affiliation_prefix = norm; // '' quando o admin limpa o campo
  }

  // Mapeia campo FE → coluna DB
  const FE_TO_DB = {
    secretary_email: 'email',
    logo_url: 'karate_logo_url',
  };

  const fields = [];
  const values = [];
  let idx = 1;

  // Campos da identidade frontend
  const fieldMap = {
    name:                'name',
    slug:                'slug',
    logo_url:            'karate_logo_url',
    affiliation_prefix:  'karate_affiliation_prefix',
    wa_phone_display:    'wa_phone_display',
    secretary_email:     'email',
    cnpj:                'cnpj',
    legal_name:          'legal_name',
    inscricao_municipal: 'inscricao_municipal',
    regime_tributario:   'regime_tributario',
    city:                'city',
    state:               'state',
  };

  for (const [feKey, dbCol] of Object.entries(fieldMap)) {
    // Migration 337 pendente: ignora o campo em vez de derrubar o PUT inteiro
    // (o resto da identidade continua salvável).
    if (dbCol === 'karate_affiliation_prefix' && !HAS_AFFILIATION_PREFIX_COL) continue;
    if (body[feKey] !== undefined) {
      fields.push(`${dbCol} = $${idx++}`);
      values.push(body[feKey] === '' ? null : body[feKey]);
    }
  }

  if (!fields.length) return res.status(422).json({ error: 'Nenhum campo para atualizar' });

  fields.push('updated_at = NOW()');
  values.push(fed);

  try {
    await db.query(
      `UPDATE companies SET ${fields.join(', ')} WHERE id = $${idx}`,
      values
    );
    // Retorna o estado atualizado
    return res.json({ updated: true });
  } catch (e) {
    if (disableMissingPrefixCol(e)) {
      // Migration 337 pendente. Desligada a flag, o próximo PUT já grava o
      // resto da identidade — mas ESTE não gravou nada (o UPDATE é atômico),
      // então o cliente precisa saber que deve repetir.
      return res.status(503).json({
        error: 'Prefixo de filiação ainda não disponível (migration 337 pendente) — tente de novo',
        code: 'COLUMN_MISSING',
      });
    }
    if (e.code === '42703') {
      // Coluna ausente (inscricao_municipal ou regime_tributario) — migration 181 pendente
      return res.status(503).json({ error: 'Coluna ausente (migration 181 pendente)' });
    }
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Este slug já está em uso' });
    }
    console.error('[karateSettings] identity put:', e.message);
    return res.status(500).json({ error: 'Erro ao salvar identidade' });
  }
});

// ── Leitura da identidade (compartilhada pelo GET e pelo upload de logo) ──
// Uma consulta só, defensiva a 42703 da coluna nova: no primeiro erro a flag
// é desligada e a consulta repetida SEM a coluna.
async function readIdentity(fed) {
  try {
    return await db.query(
      `SELECT
         name,
         slug,
         karate_logo_url${affiliationPrefixCol()},
         wa_phone_display,
         email AS secretary_email,
         cnpj,
         COALESCE(legal_name, name) AS legal_name,
         (SELECT inscricao_municipal FROM companies c2 WHERE c2.id = c.id) AS inscricao_municipal,
         (SELECT regime_tributario  FROM companies c2 WHERE c2.id = c.id) AS regime_tributario,
         city, state
       FROM companies c
       WHERE id = $1`,
      [fed]
    );
  } catch (e) {
    if (!disableMissingPrefixCol(e)) throw e;
    return readIdentity(fed);
  }
}

// ============================================================
// SEÇÃO 6 — Logo da federação (upload)
//
// A marca da federação é o que o app do dojô e do praticante mostram no topo.
// Até aqui só dava para trocá-la colando uma URL pronta em PUT
// /settings/identity — ou seja, só quem já tivesse hospedado a imagem em
// algum lugar. O dojô tem upload próprio desde o PR da logo do dojô
// (POST /federation/:id/dojo/me/logo); a federação não tinha.
//
// ESPELHA o caminho do dojô (src/routes/karateDojo.js): JSON + base64 →
// uploadToR2, MESMOS tipos, MESMO limite de 5 MB herdado de
// express.json({ limit: '5mb' }) em src/app.js. Nenhum segundo mecanismo de
// upload de arquivo.
//
// SEM MIGRATION: companies.karate_logo_url existe desde a migration 147 — é a
// mesma coluna que PUT /settings/identity já escreve e que
// GET /federation/:id/identity lê.
//
// adminOnly: trocar a marca da federação é ato de administração, não de
// operação (quem só LÊ a identidade usa GET /federation/:id/identity).
//
//   POST   /federation/:id/settings/identity/logo   { content, content_type? }
//   DELETE /federation/:id/settings/identity/logo
// ============================================================
const LOGO_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Chave DETERMINÍSTICA por federação — trocar a logo sobrescreve o objeto em
// vez de acumular lixo no R2. O preço é que a URL não muda entre uploads: sem
// o ?v= de baixo, navegador e CDN continuariam servindo a logo ANTIGA e o
// admin juraria que o upload não funcionou.
function federationLogoKey(federationId, ext) {
  return 'karate/federations/' + federationId + '/logo.' + ext;
}

// Escopado por (id, vertical): só grava se o :id for mesmo uma federação.
async function setFederationLogo(federationId, url) {
  const { rows } = await db.query(
    `UPDATE companies SET karate_logo_url = $1, updated_at = NOW()
      WHERE id = $2
        AND vertical = 'karate_federation'
      RETURNING karate_logo_url`,
    [url, federationId]
  );
  return rows.length ? rows[0] : null;
}

router.post('/settings/identity/logo', ...guards.adminOnly(), async (req, res) => {
  const fed = req.params.id;
  const { content, content_type } = req.body || {};

  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({
      error: 'Campo content (imagem em base64) é obrigatório',
      code: 'VALIDATION_ERROR',
    });
  }

  const mime = ((content_type || 'image/jpeg') + '').toLowerCase().split(';')[0].trim();
  if (!LOGO_ALLOWED_TYPES.includes(mime)) {
    return res.status(400).json({
      error: 'Tipo de imagem não suportado: ' + mime + '. Use image/jpeg, image/png ou image/webp.',
      code: 'INVALID_CONTENT_TYPE',
    });
  }
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';

  try {
    // Confirma que o :id é uma federação ANTES de gastar um upload no R2 —
    // mesma ordem do upload do dojô: valida, depois sobe.
    const { rows } = await db.query(
      `SELECT id FROM companies WHERE id = $1 AND vertical = 'karate_federation' LIMIT 1`,
      [fed]
    );
    if (!rows.length) return res.status(404).json({ error: 'Federação não encontrada' });

    const result = await uploadToR2(federationLogoKey(fed, ext), content, mime);
    if (!result.success) {
      console.error('[karateSettings] logo R2 error:', result.error);
      return res.status(500).json({ error: 'Erro no armazenamento da imagem' });
    }

    const saved = await setFederationLogo(fed, result.url + '?v=' + Date.now());
    if (!saved) return res.status(404).json({ error: 'Federação não encontrada' });

    return res.json({ logo_url: saved.karate_logo_url });
  } catch (e) {
    console.error('[karateSettings] identity logo post:', e.message);
    return res.status(500).json({ error: 'Erro ao salvar a logo' });
  }
});

// Remove a logo. Só limpa a coluna — o objeto no R2 fica e é sobrescrito no
// próximo upload (chave determinística). Apagar do R2 exigiria adivinhar a
// extensão do arquivo antigo, e uma logo órfã não é dado sensível.
router.delete('/settings/identity/logo', ...guards.adminOnly(), async (req, res) => {
  try {
    const saved = await setFederationLogo(req.params.id, null);
    if (!saved) return res.status(404).json({ error: 'Federação não encontrada' });
    return res.json({ logo_url: null });
  } catch (e) {
    console.error('[karateSettings] identity logo delete:', e.message);
    return res.status(500).json({ error: 'Erro ao remover a logo' });
  }
});

module.exports = router;
