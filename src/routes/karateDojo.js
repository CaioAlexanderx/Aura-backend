// ============================================================
// AURA KARATÊ — Endpoints escopados ao Dojô (Fase 0 Keystone)
//
// Montado em /federation/:id (via index.js).
// Aceita Canal A (JWT Aura Dojô com dojo_id) e Canal B (dojo portal token).
// Ambos são resolvidos por requireDojoAccess → req.dojoId + req.federationId.
//
// Endpoints efetivos:
//   GET    /federation/:id/dojo/me       — contexto + cadastro completo do dojô
//   PATCH  /federation/:id/dojo/me       — o dojô edita o PRÓPRIO cadastro (Canal A)
//   POST   /federation/:id/dojo/me/logo  — upload da logo do dojô (Canal A)
//   DELETE /federation/:id/dojo/me/logo  — remove a logo do dojô (Canal A)
//   GET    /federation/:id/dojo/events
//   GET    /federation/:id/dojo/practitioners
//   GET    /federation/:id/dojo/annuity
//
// ── GATE DE CONEXÃO (polish 25/07/2026) ─────────────────────
// companies.karate_dojo_linked_at (migration 251, PR #420) é a CONEXÃO do
// dojô com a federação; federation_id é só vínculo TÉCNICO (roteamento +
// guard). O #420 fechou o lado da federação (ela não enxerga dojô não
// conectado); o QA de produção mostrou o buraco INVERSO — /dojo/events
// devolvia os exames/cursos reais da FPKT e /dojo/annuity falava em
// "filiação à federação" para um dojô que nunca se conectou.
//
// Regra: as superfícies FEDERATIVAS só existem depois da conexão.
//   /dojo/me      → sempre responde; ganha linked + linked_at (aditivo)
//   /dojo/events  → não conectado: 200 vazio + not_linked:true
//   /dojo/annuity → não conectado: 200 vazio + not_linked:true
// NUNCA 403: o front precisa distinguir "sem eventos" de "não conectado"
// para mostrar o estado explicativo certo (403 vira erro genérico).
//
// /dojo/practitioners NÃO é gateado: é a lista dos praticantes DO PRÓPRIO
// dojô — para um dojô não conectado ela simplesmente vem vazia, e não há
// conteúdo da federação vazando.
//
// ── QA 27/07/2026: /dojo/me estava incompleto ───────────────
// A tela de Configurações do dojô mostrava 11 campos "—" porque o /dojo/me
// devolvia só id/name/phone/federation_id/auth_channel. O cadastro do dojô
// é a PRÓPRIA linha de companies (o dojô tem registro próprio) e o bloco
// FEDERATIVO já existe nas colunas que a federação usa em karateDojos.js
// (fpkt_affiliation_id, affiliation_model, affiliation_since, region) —
// nada precisou ser inventado, só exposto.
//
// Divisão de responsabilidade do PATCH:
//   editável pelo dojô  → name (trade_name), cnpj, email, phone, founded_at
//   read-only (federação) → fpkt_affiliation_id, affiliation_status,
//                           affiliation_model, affiliated_since, region,
//                           practitioners_count, federation_*
// Campo federativo no body é IGNORADO EM SILÊNCIO (não vira 422): o front
// manda o objeto inteiro de volta e recusar o PATCH por causa de um campo
// que ele só está ecoando seria hostil.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireDojoAccess } = require('../middleware/requireDojoAccess');
const { getDojoLinkStatus } = require('../services/karateDojoLinkStatus');
const { uploadToR2 } = require('../utils/r2Storage');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// companies.dojo_founded_at chega na migration 254. O backend sobe ANTES
// da migration em deploy parcial (CLAUDE.md #1/#10): flag module-level +
// UMA retentativa degradada (nunca cadeia de retry).
let HAS_FOUNDED_AT_COL = true;

// Canal B (portal do dojô) é SOMENTE LEITURA — alterar o cadastro exige a
// conta do dojô (Canal A), mesmo padrão de karateDojoStudents/Billing.
function requireChannelA(req, res, next) {
  if (req.dojoAuthChannel !== 'A') {
    return res.status(403).json({
      error: 'O portal do dojô é somente leitura. Entre com a conta do dojô para alterar dados.',
      code: 'PORTAL_READ_ONLY',
    });
  }
  return next();
}

function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// ⚠️ O prefixo `SELECT c.id, c.legal_name` é ÂNCORA de mock em
// tests/integration/karateDojoNotLinked.test.js — mantenha-o.
// karate_dojo_linked_at NÃO entra aqui de propósito: fica no helper
// getDojoLinkStatus (query separada, fail-open) para a ausência da coluna
// não derrubar o /dojo/me inteiro com 42703.
function dojoSelectSql() {
  const foundedAt = HAS_FOUNDED_AT_COL
    ? "to_char(c.dojo_founded_at, 'YYYY-MM-DD') AS founded_at"
    : 'NULL::text AS founded_at';
  return `SELECT c.id, c.legal_name, c.trade_name, c.slug, c.cnpj, c.email, c.phone,
              c.federation_id, c.vertical, c.created_at, c.karate_logo_url,
              c.fpkt_affiliation_id, c.affiliation_model, c.region,
              to_char(c.affiliation_since, 'YYYY-MM-DD') AS affiliated_since,
              ${foundedAt},
              u.email AS owner_email,
              COALESCE(f.trade_name, f.legal_name) AS federation_name,
              f.slug AS federation_slug,
              (SELECT count(*) FROM customers cu WHERE cu.dojo_id = c.id)::int AS practitioners_count
         FROM companies c
         LEFT JOIN users u ON u.id = c.owner_id
         LEFT JOIN companies f ON f.id = c.federation_id
        WHERE c.id = $1
          AND c.federation_id = $2
          AND c.vertical = 'karate_dojo'
          AND c.is_active = true`;
}

function isFoundedAtSchemaError(e) {
  return Boolean(
    e && e.code === '42703' && HAS_FOUNDED_AT_COL && /dojo_founded_at/i.test(e.message || '')
  );
}

async function loadDojo(dojoId, federationId) {
  try {
    const { rows } = await db.query(dojoSelectSql(), [dojoId, federationId]);
    return rows[0] || null;
  } catch (e) {
    if (!isFoundedAtSchemaError(e)) throw e;
    HAS_FOUNDED_AT_COL = false;
    console.warn('[karateDojo] companies.dojo_founded_at ausente (migration 254 pendente) — founded_at virá null');
    const { rows } = await db.query(dojoSelectSql(), [dojoId, federationId]);
    return rows[0] || null;
  }
}

// affiliation_status NÃO é coluna (não existe em lugar nenhum do schema) —
// é DERIVADO da verdade que existe. Melhor um estado explicável do que um
// "—" eterno na tela, e melhor derivar do que criar coluna nova só para a
// federação esquecer de preencher.
function affiliationStatus(row, link) {
  if (row.fpkt_affiliation_id) return 'filiado';
  if (link && link.linked) return 'pendente';
  return 'nao_filiado';
}

function shapeDojo(row, { authChannel, link }) {
  return {
    id: row.id,
    name: row.trade_name || row.legal_name || null,
    slug: row.slug || null,
    cnpj: row.cnpj || null,
    // e-mail do CADASTRO do dojô (o que o PATCH edita). owner_email não
    // entra como fallback: depois de limpar o campo o dojô veria o e-mail
    // do dono "voltando" sozinho.
    email: row.email || null,
    phone: row.phone || null,
    founded_at: row.founded_at || null,
    // Na coluna é karate_logo_url (migration 147); no fio é logo_url — MESMO
    // nome que a identidade da federação já usa (karateSettings.js). Um nome
    // só para a mesma coisa: o app não deve ter que lembrar de qual lado veio.
    logo_url: row.karate_logo_url || null,
    // ── bloco FEDERATIVO (read-only para o dojô) ──
    federation_id: row.federation_id,
    federation_name: row.federation_name || null,
    federation_slug: row.federation_slug || null,
    fpkt_affiliation_id: row.fpkt_affiliation_id || null,
    affiliation_status: affiliationStatus(row, link),
    affiliation_model: row.affiliation_model || null,
    affiliated_since: row.affiliated_since || null,
    region: row.region || null,
    practitioners_count: row.practitioners_count != null ? Number(row.practitioners_count) : null,
    // ── contexto ──
    auth_channel: authChannel, // 'A' | 'B'
    linked: link.linked, // karate_dojo_linked_at IS NOT NULL
    linked_at: link.linked_at, // ISO 8601 UTC | null
  };
}

function notFound(res) {
  return res.status(404).json({
    error: 'Dojô não encontrado ou não pertence a esta federação',
    code: 'DOJO_NOT_FOUND',
  });
}

// GET /federation/:id/dojo/me
// Contexto + cadastro do dojô autenticado. Usado pelo app (Canal A) e pelo
// portal off-app (Canal B) para hidratar a tela de Configurações.
router.get('/dojo/me', requireDojoAccess, async (req, res) => {
  try {
    const dojo = await loadDojo(req.dojoId, req.federationId);
    if (!dojo) return notFound(res);

    const link = await getDojoLinkStatus(req.dojoId);

    res.json({
      dojo: shapeDojo(dojo, { authChannel: req.dojoAuthChannel, link }),
      // Espelhados no topo para o front não precisar cavar o objeto só
      // para decidir se renderiza a área da federação.
      linked: link.linked,
      linked_at: link.linked_at,
    });
  } catch (err) {
    console.error('[karateDojo] /dojo/me error:', err.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Só estes cinco campos existem para o PATCH. Qualquer outra chave do body
// (inclusive o bloco federativo inteiro) é ignorada sem erro.
function validateDojoPatch(body) {
  const b = body || {};
  const errors = [];
  const data = {};

  if (b.name !== undefined) {
    const v = b.name != null ? String(b.name).trim() : '';
    if (!v) errors.push('name não pode ficar vazio');
    else data.trade_name = v;
  }

  if (b.cnpj !== undefined) {
    if (b.cnpj === null || String(b.cnpj).trim() === '') {
      data.cnpj = null;
    } else {
      const digits = String(b.cnpj).replace(/\D/g, '');
      if (digits.length !== 14) errors.push('cnpj inválido (esperados 14 dígitos)');
      else data.cnpj = digits;
    }
  }

  if (b.email !== undefined) {
    if (b.email === null || String(b.email).trim() === '') {
      data.email = null;
    } else {
      const v = String(b.email).trim();
      if (!EMAIL_RE.test(v)) errors.push('email inválido');
      else data.email = v;
    }
  }

  if (b.phone !== undefined) {
    if (b.phone === null || String(b.phone).trim() === '') {
      data.phone = null;
    } else {
      const digits = String(b.phone).replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 11) errors.push('phone inválido (esperados 10 ou 11 dígitos)');
      else data.phone = digits;
    }
  }

  if (b.founded_at !== undefined) {
    if (b.founded_at === null || String(b.founded_at).trim() === '') {
      data.founded_at = null;
    } else {
      const v = String(b.founded_at).trim().slice(0, 10);
      if (!isValidDateStr(v)) errors.push('founded_at deve ser uma data válida no formato YYYY-MM-DD');
      else data.founded_at = v;
    }
  }

  return { errors, data };
}

// UPDATE escopado por (id, federation_id, vertical) — o dojô do GUARD,
// nunca id vindo do body. Statement único, sem BEGIN (nada de tx-poison).
async function updateDojo(dojoId, federationId, data, { withFoundedAt } = {}) {
  const useFoundedAt = withFoundedAt === undefined ? HAS_FOUNDED_AT_COL : withFoundedAt;
  const sets = [];
  const vals = [];

  for (const col of ['trade_name', 'cnpj', 'email', 'phone']) {
    if (data[col] === undefined) continue;
    vals.push(data[col]);
    sets.push(`${col} = $${vals.length}`);
  }

  if (data.founded_at !== undefined) {
    vals.push(data.founded_at);
    const p = `$${vals.length}::date`;
    if (useFoundedAt) sets.push(`dojo_founded_at = ${p}`);
    // Espelha o ANO na coluna que a FEDERAÇÃO já lê (karateDojos.js) —
    // sem isso a tela dela continuaria mostrando o ano antigo.
    sets.push(`dojo_founded_year = EXTRACT(YEAR FROM ${p})::smallint`);
  }

  if (!sets.length) return true; // PATCH vazio = no-op (devolve o estado atual)

  sets.push('updated_at = now()');
  vals.push(dojoId, federationId);

  const { rows } = await db.query(
    `UPDATE companies SET ${sets.join(', ')}
      WHERE id = $${vals.length - 1}
        AND federation_id = $${vals.length}
        AND vertical = 'karate_dojo'
      RETURNING id`,
    vals
  );
  return rows.length > 0;
}

// PATCH /federation/:id/dojo/me (Canal A)
// Resposta 200 com o MESMO shape do GET.
router.patch('/dojo/me', requireDojoAccess, requireChannelA, async (req, res) => {
  const { errors, data } = validateDojoPatch(req.body);
  if (errors.length) {
    return res.status(422).json({ error: errors[0], errors, code: 'VALIDATION_ERROR' });
  }

  try {
    let ok;
    try {
      ok = await updateDojo(req.dojoId, req.federationId, data);
    } catch (e) {
      if (!isFoundedAtSchemaError(e)) throw e;
      HAS_FOUNDED_AT_COL = false;
      console.warn('[karateDojo] companies.dojo_founded_at ausente (migration 254 pendente) — gravando só o ano');
      ok = await updateDojo(req.dojoId, req.federationId, data, { withFoundedAt: false });
    }
    if (!ok) return notFound(res);

    const dojo = await loadDojo(req.dojoId, req.federationId);
    if (!dojo) return notFound(res);
    const link = await getDojoLinkStatus(req.dojoId);

    return res.json({
      dojo: shapeDojo(dojo, { authChannel: req.dojoAuthChannel, link }),
      linked: link.linked,
      linked_at: link.linked_at,
    });
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'Já existe uma empresa com este CNPJ', code: 'DUPLICATE_CNPJ' });
    }
    console.error('[karateDojo] PATCH /dojo/me error:', err.message);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// ============================================================
// LOGO DO DOJÔ — POST/DELETE /federation/:id/dojo/me/logo (Canal A)
//
// QA 27/08/2026: a sidebar do dojô mostrava a logo da FPKT acima do nome do
// dojô — a federação ocupando a identidade de quem entrou. O dojô é dono da
// própria marca; a FPKT continua sendo a marca DELA (KarateShell.tsx).
//
// REUSA o mecanismo de upload do aluno do dojô (POST /dojo/students/:sid/photo)
// e do praticante: JSON + base64 → uploadToR2, MESMOS tipos e MESMO limite de
// 5 MB herdado de express.json({ limit: '5mb' }) em src/app.js. Nenhum segundo
// caminho de upload de arquivo.
//
// SEM MIGRATION: companies.karate_logo_url já existe desde a 147 — é a mesma
// coluna que a federação escreve pelo PATCH /dojos/:dojoId (karateDojos.js) e
// que o portal Canal B já lê. O que faltava era o dojô poder escrever nela.
//
// Body JSON:
//   content      {string}  Imagem em base64 (obrigatório).
//   content_type {string?} MIME. Default: "image/jpeg".
//                          Aceitos: image/jpeg, image/png, image/webp.
//
// Resposta: o MESMO shape do GET /dojo/me (o front rehidrata a tela inteira
// com uma resposta só, sem um segundo GET para ver a logo nova).
// ============================================================
const LOGO_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// A chave é DETERMINÍSTICA por dojô — trocar a logo sobrescreve o objeto em
// vez de acumular lixo no R2. O preço é que a URL não muda entre uploads: sem
// o ?v= abaixo, o navegador e o CDN continuariam servindo a logo ANTIGA e o
// sensei juraria que o upload não funcionou.
function logoKey(dojoId, ext) {
  return 'karate/dojos/' + dojoId + '/logo.' + ext;
}

async function respondWithDojo(req, res) {
  const dojo = await loadDojo(req.dojoId, req.federationId);
  if (!dojo) return notFound(res);
  const link = await getDojoLinkStatus(req.dojoId);
  return res.json({
    dojo: shapeDojo(dojo, { authChannel: req.dojoAuthChannel, link }),
    linked: link.linked,
    linked_at: link.linked_at,
  });
}

// Escopado por (id, federation_id, vertical) — o dojô do GUARD, nunca do body.
async function setDojoLogo(dojoId, federationId, url) {
  const { rows } = await db.query(
    `UPDATE companies SET karate_logo_url = $1, updated_at = now()
      WHERE id = $2
        AND federation_id = $3
        AND vertical = 'karate_dojo'
      RETURNING id`,
    [url, dojoId, federationId]
  );
  return rows.length > 0;
}

router.post('/dojo/me/logo', requireDojoAccess, requireChannelA, async (req, res) => {
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
    // Confirma que o dojô existe (e é DESTA federação) ANTES de gastar um
    // upload no R2 — mesma ordem de karateDojoStudents: valida, depois sobe.
    const dojo = await loadDojo(req.dojoId, req.federationId);
    if (!dojo) return notFound(res);

    const result = await uploadToR2(logoKey(req.dojoId, ext), content, mime);
    if (!result.success) {
      console.error('[karateDojo] logo R2 error:', result.error);
      return res.status(500).json({ error: 'Erro no armazenamento da imagem' });
    }

    const ok = await setDojoLogo(req.dojoId, req.federationId, result.url + '?v=' + Date.now());
    if (!ok) return notFound(res);

    return await respondWithDojo(req, res);
  } catch (err) {
    console.error('[karateDojo] POST /dojo/me/logo error:', err.message);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// Remove a logo. Só limpa a coluna — o objeto no R2 fica e é sobrescrito no
// próximo upload (chave determinística). Apagar do R2 exigiria adivinhar a
// extensão do arquivo antigo, e uma logo órfã não é dado sensível.
router.delete('/dojo/me/logo', requireDojoAccess, requireChannelA, async (req, res) => {
  try {
    const ok = await setDojoLogo(req.dojoId, req.federationId, null);
    if (!ok) return notFound(res);
    return await respondWithDojo(req, res);
  } catch (err) {
    console.error('[karateDojo] DELETE /dojo/me/logo error:', err.message);
    return res.status(500).json({ error: 'Erro interno' });
  }
});

// GET /federation/:id/dojo/events
// Lista eventos (exames/cursos) ABERTOS da federação — consulta read-only
// para o painel do sensei. A inscrição é intermediada pela federação.
// Dojô NÃO conectado: 200 vazio + not_linked:true (nunca 403 — ver topo).
router.get('/dojo/events', requireDojoAccess, async (req, res) => {
  try {
    const link = await getDojoLinkStatus(req.dojoId);
    if (!link.linked) {
      // Mesmas chaves do caso conectado (`events`, `count`, `federation`)
      // + `data` (alias) para o front novo. Nada da federação é lido.
      return res.json({
        events: [],
        data: [],
        count: 0,
        federation: null,
        not_linked: true,
      });
    }

    const { rows } = await db.query(
      `SELECT id, name, exam_type, event_date, location, fee_amount, status
         FROM karate_belt_exams
        WHERE federation_id = $1 AND status = 'open'
        ORDER BY event_date ASC NULLS LAST
        LIMIT 50`,
      [req.federationId]
    );

    // Contato da federação (best-effort) para o sensei solicitar inscrição.
    let federation = null;
    try {
      const fed = await db.query(
        `SELECT COALESCE(c.trade_name, c.legal_name) AS name, c.phone,
                u.email AS email
           FROM companies c
           LEFT JOIN users u ON u.id = c.owner_id
          WHERE c.id = $1
          LIMIT 1`,
        [req.federationId]
      );
      if (fed.rows.length) {
        federation = {
          name: fed.rows[0].name || null,
          email: fed.rows[0].email || null,
          phone: fed.rows[0].phone || null,
        };
      }
    } catch (_) { /* contato opcional — degradacao graceful */ }

    res.json({
      events: rows.map(e => ({
        id: e.id,
        name: e.name,
        exam_type: e.exam_type || 'exame',
        event_date: e.event_date,
        location: e.location || null,
        fee_amount: e.fee_amount != null ? Number(e.fee_amount) : null,
        status: e.status,
      })),
      count: rows.length,
      federation,
    });
  } catch (err) {
    console.error('[karateDojo] /dojo/events error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar eventos' });
  }
});

// GET /federation/:id/dojo/practitioners
// Lista nominal (read-only) dos praticantes do dojô + faixa atual.
router.get('/dojo/practitioners', requireDojoAccess, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT cu.id AS practitioner_id, cu.name, cu.is_active,
              cb.belt_level, cb.belt_name
         FROM customers cu
         LEFT JOIN karate_current_belt cb
                ON cb.student_id = cu.id AND cb.federation_id = $1
        WHERE cu.dojo_id = $2
        ORDER BY cu.name ASC`,
      [req.federationId, req.dojoId]
    );
    res.json({
      practitioners: rows.map(r => ({
        practitioner_id: r.practitioner_id,
        name: r.name,
        is_active: r.is_active !== false,
        belt_level: r.belt_level || null,
        belt_name: r.belt_name || null,
      })),
      count: rows.length,
    });
  } catch (err) {
    console.error('[karateDojo] /dojo/practitioners error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar praticantes' });
  }
});

// GET /federation/:id/dojo/annuity
// Situacao + historico da anuidade do dojo (read-only) + chave PIX da
// federacao para pagamento. "Pago" = paid_at nao-nulo. Degradacao graceful
// se a tabela/coluna ainda nao existir.
// A anuidade AQUI é a da FILIAÇÃO à federação (não a mensalidade que o
// dojô cobra dos alunos — essa é F3a, interna, e não é gateada). Dojô NÃO
// conectado: 200 vazio + not_linked:true, mesmas chaves de sempre.
router.get('/dojo/annuity', requireDojoAccess, async (req, res) => {
  try {
    const link = await getDojoLinkStatus(req.dojoId);
    if (!link.linked) {
      return res.json({
        pending: null,
        history: [],
        pix: null,
        not_linked: true,
      });
    }

    let history = [];
    try {
      const { rows } = await db.query(
        `SELECT id, reference_period, amount, status, paid_at, due_date
           FROM karate_dojo_annuity_history
          WHERE dojo_id = $1 AND federation_id = $2
          ORDER BY reference_period DESC
          LIMIT 24`,
        [req.dojoId, req.federationId]
      );
      history = rows;
    } catch (_) { /* tabela ausente — degradacao graceful */ }

    const pending = history.find(h => !h.paid_at) || null;

    let pix = null;
    try {
      const { rows: dcc } = await db.query(
        `SELECT pix_key, pix_key_type, pix_holder_name
           FROM digital_channel_config WHERE company_id = $1 LIMIT 1`,
        [req.federationId]
      );
      if (dcc.length && dcc[0].pix_key) {
        pix = {
          key: dcc[0].pix_key,
          key_type: dcc[0].pix_key_type || null,
          holder_name: dcc[0].pix_holder_name || null,
        };
      }
    } catch (_) { /* pix opcional */ }

    res.json({
      pending: pending ? {
        annuity_history_id: pending.id,
        reference_period: pending.reference_period,
        amount: pending.amount != null ? Number(pending.amount) : null,
        status: pending.status,
        due_date: pending.due_date || null,
      } : null,
      history: history.map(h => ({
        annuity_history_id: h.id,
        reference_period: h.reference_period,
        amount: h.amount != null ? Number(h.amount) : null,
        status: h.status,
        paid_at: h.paid_at || null,
        due_date: h.due_date || null,
      })),
      pix,
    });
  } catch (err) {
    console.error('[karateDojo] /dojo/annuity error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar anuidade' });
  }
});

module.exports = router;
