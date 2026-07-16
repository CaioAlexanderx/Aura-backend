// ============================================================
// AURA KARATÊ — Portal público do sensei (atualização cadastral por token)
// (10/07/2026 — cascata de status dojô→praticantes + validação de quadro)
// (11/07/2026 — POST /:token/practitioner: sensei adiciona praticante novo
//   direto pelo portal, sem expirar o token)
// (12/07/2026 — G1: portal em escala. 400 praticantes era um paredão —
//   agora: (1) cada praticante devolve `missing` (o que falta de essencial:
//   telefone/e-mail), (2) a lista vem ordenada por consequência (faixa-preta
//   ATIVA em aberto > ativo sem nenhum contato > resto) com contagens
//   essenciais/demais, (3) PATCH granular por praticante (autosave campo a
//   campo, inclui inativar), (4) export/import só do que falta, casando por
//   matrícula FPKT (nunca por nome). O link de auto-atendimento do PRÓPRIO
//   praticante vive em karateRosterSelfServicePublic.js — token SEPARADO
//   (ver migration 225), só aceita contato.
// (13/07/2026 — G1 fechamento: GET /:token agora devolve `self_service_url`
//   pronto. Quem compartilha o link de auto-atendimento com os alunos é o
//   SENSEI (cola no grupo do WhatsApp do dojô) — não a federação. Exigir
//   que a federação copiasse o link e reenviasse ao sensei manualmente
//   condenava a feature a não ser usada. DECISÃO DE SEGURANÇA: os tokens
//   continuam SEPARADOS (karateRosterSelfServicePublic.js) — isso não muda;
//   vazar o link de auto-atendimento nunca deve dar poder de sensei. Mas o
//   inverso não é um downgrade de segurança: quem já possui o token do
//   SENSEI (poder pleno — inativar, editar qualquer campo, adicionar
//   praticante, confirmar o quadro) recebendo também o link de
//   auto-atendimento (poder mínimo — só o próprio contato) é a hierarquia
//   natural, não uma escalada. Se o self_service_token ainda não existir
//   para o dojô (ou já expirou), este endpoint GERA um NOVO sob demanda,
//   de forma idempotente (só regenera quando ausente/expirado — ver
//   ensureSelfServiceUrl abaixo).
//
// (14/07/2026 — H2b: decisão fechada com o Caio — "solicitar novo
//   praticante" mora AQUI, no link público, não atrás de JWT. A H2 tinha
//   posto esse fluxo no Portal do Sensei autenticado (solicitacoes.tsx)
//   por engano: o link público É o canal principal de atualização
//   cadastral, e exigir login pra abrir uma ficha de matrícula nova
//   condena a feature a não ser usada pelos senseis que só têm o link.
//   POST /:token/practitioner já virava SOLICITAÇÃO desde H1/H2 (nunca
//   insere em customers) — o que faltava era paridade de campos com a
//   ficha completa do painel autenticado (cpf/rg/sexo/endereço/
//   responsável) e os dois endpoints token-gated que só existiam
//   JWT-gated: auto-localizar por FPKT e status das solicitações do
//   dojô. Os dois são NOVOS abaixo, espelhando
//   karateDojoPractitionerRequests.js 1:1 (mesmo service de dedup,
//   mesmo shape de resposta), só trocando requireDojoAccess (JWT) por
//   resolveToken (token opaco).
//
// SEM auth (mesmo padrão de dentalPortalPublic.js / studioApprovalPublic.js):
// o token opaco de karate_dojo_roster_validation É a autenticação. Todo
// acesso — leitura, escrita e export — é escopado ao dojo_id do token;
// dojo_id/federation_id do body são SEMPRE ignorados (nunca aceitos de fora).
//
//   GET   /public/roster-update/:token                          — quadro do dojô
//                                                                   (ordenado, com missing/counts/progress/self_service_url)
//   GET   /public/roster-update/:token/practitioners/:studentId — ficha completa
//                                                                   ("ver ficha completa" da UI)
//   PATCH /public/roster-update/:token/practitioners/:studentId — autosave granular
//                                                                   (inclui is_active = "não treina mais")
//   POST  /public/roster-update/:token                           — confirma o quadro (fecha o ciclo,
//                                                                   expira o token; aceita updates[] de is_active)
//   POST  /public/roster-update/:token/practitioner               — H2b: abre uma SOLICITAÇÃO de
//                                                                   praticante novo (ficha completa),
//                                                                   NUNCA cria em customers direto
//                                                                   (NÃO expira o token)
//   GET   /public/roster-update/:token/fpkt-lookup?number=       — H2b: auto-localizar nº FPKT,
//                                                                   escopado à federação do token
//                                                                   (equivalente token-gated de
//                                                                   karateDojoPractitionerRequests.js)
//   GET   /public/roster-update/:token/practitioner-requests     — H2b: status das solicitações
//                                                                   do PRÓPRIO dojô (pendente/
//                                                                   aprovada/rejeitada + motivo)
//   GET   /public/roster-update/:token/export                    — CSV do quadro inteiro
//   GET   /public/roster-update/:token/export-missing             — CSV só de quem falta algo
//                                                                   (matrícula + nome + telefone + e-mail)
//   POST  /public/roster-update/:token/import                    — reimporta a planilha de export-missing
//                                                                   preenchida (casamento por matrícula;
//                                                                   {atualizados, ignorados, erros[]})
//
// Token inválido ou com token_expires_at <= now() → 404 (não existe) /
// 410 (existe mas expirou) — nunca vaza dado do dojô nesses casos.
// ============================================================
'use strict';

const router = require('express').Router();
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../config/database');
const { parseCSVLine } = require('../services/karateService');
const { buildDedupKey, lookupByFpktNumber, normalizeFpktNumber, toIsoDate } = require('../services/karatePractitionerDedup');
const { validatePractitionerRequestPayload } = require('../services/karatePractitionerRequestValidation');
const { uploadToR2 } = require('../utils/r2Storage');

let multer;
try { multer = require('multer'); } catch (_) { multer = null; }
const upload = multer ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }) : null;

const isTestEnv = () => process.env.NODE_ENV === 'test';

// Chave de rate limit = token + IP (mesmo padrão de
// karateRosterSelfServicePublic.js): throttle por dojô E por origem, sem
// um IP compartilhado (rede da escola/ginásio) travar todo mundo por
// causa de um dojô barulhento em outro token.
function keyByTokenAndIp(req) {
  return `${req.params.token || 'no-token'}:${req.ip || 'no-ip'}`;
}

// Auto-localizar é uma BUSCA (o sensei pode digitar vários números
// testando) — mesmo teto do lookup-fpkt autenticado
// (karateDojoPractitionerRequests.js): 60/10min.
const fpktLookupLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByTokenAndIp,
  skip: () => isTestEnv(),
});

// QA H5: POST /:token/practitioner (H2b) herdava só o globalLimiter
// genérico (300/min por IP) — quem tem o link (pode vazar num print de
// WhatsApp) conseguia inundar a fila de moderação com centenas de
// solicitações de identidades distintas (nome+nascimento variam
// livremente, o índice de dedup parcial não segura volume). Mesmo teto do
// irmão autenticado createLimiter (karateDojoPractitionerRequests.js):
// 30/10min — dá folga generosa para matrícula em lote legítima de um
// dojô real sem abrir porta para flood. Chave por token+IP (mesmo padrão
// de fpktLookupLimiter acima).
const practitionerCreateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByTokenAndIp,
  skip: () => isTestEnv(),
  message: { error: 'Muitas solicitações de praticante para este link. Tente novamente em alguns minutos.', code: 'RATE_LIMITED' },
});

// Mesma base de karateRosterValidation.js (APP_URL, default
// https://app.getaura.com.br) — mantém as duas URLs (sensei/self-service)
// consistentes entre os dois arquivos.
// Upload de foto na solicitação (item 9) — mesmo perfil de abuso do
// practitionerCreateLimiter (base64 de até 5MB, canal público token+IP),
// teto um pouco mais folgado porque um mesmo dojô pode reenviar a foto
// (qualidade ruim, tentar de novo) sem que isso seja abuso.
const photoUploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByTokenAndIp,
  skip: () => isTestEnv(),
  message: { error: 'Muitos envios de foto para este link. Tente novamente em alguns minutos.', code: 'RATE_LIMITED' },
});

const APP_URL = process.env.APP_URL || 'https://app.getaura.com.br';

function rosterSelfServiceUrl(token) {
  return `${APP_URL}/karate/roster-self/${token}`;
}

// ── Garante (idempotente) um self_service_token válido para o dojô e
// devolve a URL pronta. Só GERA um token novo quando o dojô ainda não tem
// nenhum (schema recém-migrado, ou dojô que nunca teve
// request-roster-update chamado depois da migration 225) ou quando o que
// existe já expirou — uma única query, sem round-trip de leitura antes.
// Concorrência: duas chamadas simultâneas nesse estado "ausente/expirado"
// podem gerar tokens diferentes, mas a última a commitar é a que vale (não
// há perda de escopo/segurança, só o link antigo para de funcionar) — e
// assim que EXISTE um token válido, chamadas seguintes caem no ramo ELSE e
// preservam o mesmo token (não invalida um link que o sensei já colou no
// grupo do dojô).
async function ensureSelfServiceUrl(dojoId) {
  const candidateToken = crypto.randomBytes(24).toString('hex');
  try {
    const { rows } = await db.query(
      `UPDATE karate_dojo_roster_validation
       SET self_service_token = CASE
             WHEN self_service_token IS NULL
                  OR self_service_token_expires_at IS NULL
                  OR self_service_token_expires_at <= NOW()
             THEN $2
             ELSE self_service_token
           END,
           self_service_token_expires_at = CASE
             WHEN self_service_token IS NULL
                  OR self_service_token_expires_at IS NULL
                  OR self_service_token_expires_at <= NOW()
             THEN NOW() + INTERVAL '30 days'
             ELSE self_service_token_expires_at
           END
       WHERE dojo_id = $1
       RETURNING self_service_token`,
      [dojoId, candidateToken]
    );
    if (!rows.length || !rows[0].self_service_token) return null;
    return rosterSelfServiceUrl(rows[0].self_service_token);
  } catch (e) {
    if (e.code === '42703' || e.code === '42P01') {
      // Migration 225 pendente — degrada para null (mesmo padrão dos
      // outros handlers deste arquivo), nunca derruba o GET do quadro.
      console.warn('[karateRosterPortalPublic] self_service_token schema pendente:', e.message);
      return null;
    }
    console.error('[karateRosterPortalPublic] ensureSelfServiceUrl error:', e.message);
    return null;
  }
}

// ── Resolve token do SENSEI → { dojo_id, federation_id, status, dojo_nome, expired } ──
// Toca last_accessed_at (best-effort) quando o token é válido — é o sinal
// que alimenta GET /federation/:id/dojos/roster-progress (item 7: "não
// aberto" vs "em andamento").
async function resolveToken(token, { touch = true } = {}) {
  if (!token || typeof token !== 'string') return null;

  const { rows } = await db.query(
    `SELECT v.dojo_id, v.federation_id, v.status, v.token_expires_at,
            COALESCE(c.name, c.trade_name, c.legal_name) AS dojo_nome
     FROM karate_dojo_roster_validation v
     JOIN companies c ON c.id = v.dojo_id
     WHERE v.token = $1
     LIMIT 1`,
    [token]
  );
  if (!rows.length) return null;

  const row = rows[0];
  const expired = !row.token_expires_at || new Date(row.token_expires_at) <= new Date();

  if (touch && !expired) {
    try {
      await db.query(
        `UPDATE karate_dojo_roster_validation SET last_accessed_at = NOW() WHERE dojo_id = $1`,
        [row.dojo_id]
      );
    } catch (e) {
      if (e.code !== '42703' && e.code !== '42P01') throw e;
      console.warn('[karateRosterPortalPublic] last_accessed_at ausente (schema pendente):', e.message);
    }
  }

  return { ...row, expired };
}

// ── Classificação por praticante ────────────────────────────
// missing: campos essenciais faltando (telefone/e-mail) — item 1.
// priority_group: 'a' faixa-preta ATIVA com anuidade em aberto na temporada
//                 (fonte única: karate_member_standing.financeiro — não
//                 reimplementa a regra); 'b' ativo sem NENHUM contato;
//                 'c' o resto. Ordenação/contagens do item 2 usam isso.
// Item 4 (revisão Atualização Cadastral, 15/07/2026) — BUG real do Caio:
// apagou nascimento/e-mail/celular, preencheu só e-mail e celular, e o
// sistema marcou como OK — porque "missing" só olhava telefone/e-mail.
// "Todos os campos", como decidido aqui: os campos que o PORTAL edita
// (PORTAL_EDITABLE_FIELDS abaixo) menos `complement`, que é modificador
// opcional do endereço (nem toda casa tem apto/fundos) — o mesmo corte já
// usado pela grade de completude do front (COMPLETENESS_COLUMNS em
// app/karate/roster-update/[token].tsx: nascimento, CPF, RG, telefone,
// e-mail, endereço). `endereco` é um grupo único (rua+cidade+UF — mesmo
// mínimo que a grade já usa) para não punir número/bairro/CEP ausentes
// isoladamente. Responsável fica de fora: não é editável por este PATCH
// (segue somente leitura no portal, ver FullRecordPanel), exigi-lo aqui
// deixaria o praticante permanentemente "incompleto" sem nenhum jeito de
// resolver pelo link.
function classifyPraticante(row) {
  const hasPhone = !!(row.phone && String(row.phone).trim());
  const hasEmail = !!(row.email && String(row.email).trim());
  const hasBirthDate = !!row.birth_date;
  const hasCpf = !!(row.cpf_cnpj && String(row.cpf_cnpj).trim());
  const hasRg = !!(row.rg && String(row.rg).trim());
  const hasAddress = !!(
    row.street && String(row.street).trim() &&
    row.city && String(row.city).trim() &&
    row.state && String(row.state).trim()
  );

  const missing = [];
  if (!hasPhone) missing.push('telefone');
  if (!hasEmail) missing.push('email');
  if (!hasBirthDate) missing.push('nascimento');
  if (!hasCpf) missing.push('cpf');
  if (!hasRg) missing.push('rg');
  if (!hasAddress) missing.push('endereco');

  const isActive = row.is_active !== false;
  const isBlackBeltOverdue = isActive && row.is_black_belt === true && row.financeiro === 'atrasado';
  const noContact = isActive && !hasPhone && !hasEmail;

  let group = 'c';
  if (isBlackBeltOverdue) group = 'a';
  else if (noContact) group = 'b';

  return { missing, group };
}

const GROUP_ORDER = { a: 0, b: 1, c: 2 };

// Busca + classifica + ordena o quadro do dojô. Reusa karate_member_standing
// (LEFT JOIN — praticante sem faixa/histórico não desaparece da lista, só
// não participa do grupo 'a').
async function fetchQuadro(dojoId, federationId) {
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.karate_registration_number, c.is_active,
            c.phone, c.email, c.birth_date, c.cpf_cnpj, c.rg, c.street, c.city, c.state,
            cb.belt_name,
            kms.financeiro, COALESCE(kms.is_black_belt, false) AS is_black_belt
     FROM customers c
     LEFT JOIN karate_current_belt cb ON cb.student_id = c.id AND cb.federation_id = $2
     LEFT JOIN karate_member_standing kms ON kms.student_id = c.id
     WHERE c.dojo_id = $1 AND c.is_guest = false
     ORDER BY c.name ASC`,
    [dojoId, federationId]
  );

  const praticantes = rows.map((r) => {
    const { missing, group } = classifyPraticante(r);
    return {
      id: r.id,
      name: r.name,
      karate_registration_number: r.karate_registration_number || null,
      belt_name: r.belt_name || null,
      is_active: r.is_active !== false,
      phone: r.phone || null,
      email: r.email || null,
      missing,
      priority_group: group,
    };
  });

  praticantes.sort((a, b) => {
    const gd = GROUP_ORDER[a.priority_group] - GROUP_ORDER[b.priority_group];
    if (gd !== 0) return gd;
    return String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR');
  });

  const essenciais = praticantes.filter((p) => p.priority_group === 'a' || p.priority_group === 'b').length;
  const demais = praticantes.length - essenciais;

  // Progresso (item 4 — barra de progresso/retomada): stateless por
  // desenho (sem tabela de baseline). "essenciais_total" = universo ainda
  // sob revisão (praticantes ATIVOS); "essenciais_resolvidos" = quantos já
  // têm telefone E e-mail. Inativar (item 3) e completar contato (item 4)
  // são os dois jeitos de mover esse número — 400 -> 120 é literalmente o
  // denominador encolhendo.
  const ativos = praticantes.filter((p) => p.is_active);
  const resolvidos = ativos.filter((p) => p.missing.length === 0).length;

  return {
    praticantes,
    counts: { essenciais, demais },
    progress: { essenciais_total: ativos.length, essenciais_resolvidos: resolvidos },
  };
}

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",;\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ── GET /public/roster-update/:token ────────────────────────
router.get('/:token', async (req, res) => {
  try {
    const resolved = await resolveToken(req.params.token);
    if (!resolved) return res.status(404).json({ error: 'Link inválido' });
    if (resolved.expired) return res.status(410).json({ error: 'Link expirado. Solicite uma nova atualização cadastral à federação.' });

    const quadro = await fetchQuadro(resolved.dojo_id, resolved.federation_id);
    const selfServiceUrl = await ensureSelfServiceUrl(resolved.dojo_id);

    res.json({
      dojo_nome: resolved.dojo_nome,
      status: resolved.status,
      praticantes: quadro.praticantes,
      counts: quadro.counts,
      progress: quadro.progress,
      self_service_url: selfServiceUrl,
    });
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') {
      console.warn('[karateRosterPortalPublic] schema pendente:', err.message);
      return res.status(404).json({ error: 'Link inválido' });
    }
    console.error('[karateRosterPortalPublic] GET error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar quadro do dojô' });
  }
});

// ── GET /public/roster-update/:token/practitioners/:studentId ──────────
// Ficha completa — a UI esconde isso atrás de "ver ficha completa" (item 1:
// não tratar todo campo como igualmente importante no payload da lista).
router.get('/:token/practitioners/:studentId', async (req, res) => {
  try {
    const resolved = await resolveToken(req.params.token, { touch: false });
    if (!resolved) return res.status(404).json({ error: 'Link inválido' });
    if (resolved.expired) return res.status(410).json({ error: 'Link expirado. Solicite uma nova atualização cadastral à federação.' });

    const { rows } = await db.query(
      `SELECT c.id, c.name, c.karate_registration_number, c.is_active,
              c.phone, c.email, c.cpf_cnpj, c.rg, c.birth_date,
              c.street, c.number, c.complement, c.neighborhood, c.city, c.state, c.zip_code,
              c.guardian_name, c.guardian_phone, c.guardian_relationship,
              cb.belt_name, cb.belt_level
       FROM customers c
       LEFT JOIN karate_current_belt cb ON cb.student_id = c.id AND cb.federation_id = $3
       WHERE c.id = $1 AND c.dojo_id = $2
       LIMIT 1`,
      [req.params.studentId, resolved.dojo_id, resolved.federation_id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Praticante não encontrado neste dojô', code: 'NOT_FOUND' });
    }
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') {
      console.warn('[karateRosterPortalPublic] ficha schema pendente:', err.message);
      return res.status(404).json({ error: 'Link inválido' });
    }
    console.error('[karateRosterPortalPublic] ficha GET error:', err.message);
    res.status(500).json({ error: 'Erro ao carregar ficha do praticante' });
  }
});

// ── PATCH /public/roster-update/:token/practitioners/:studentId ────────
// Autosave granular (item 4): um praticante, um subconjunto de campos,
// idempotente. Inclui is_active (item 3 — "não treina mais"). Campo de
// faixa NÃO entra aqui (vive em karate_belt_history, append-only — mesma
// regra do cadastro autenticado).
const PORTAL_EDITABLE_FIELDS = {
  phone: 'phone',
  email: 'email',
  cpf: 'cpf_cnpj',
  rg: 'rg',
  birth_date: 'birth_date',
  street: 'street',
  number: 'number',
  complement: 'complement',
  neighborhood: 'neighborhood',
  city: 'city',
  state: 'state',
  zip_code: 'zip_code',
};

router.patch('/:token/practitioners/:studentId', async (req, res) => {
  const token = req.params.token;
  const studentId = req.params.studentId;
  const body = req.body || {};

  const setClauses = [];
  const params = [studentId];
  let n = 2;
  const changedFields = [];
  // Item 8 (revisão Atualização Cadastral, 15/07/2026): a federação pedia
  // "o que o sensei mudou" e só via "concluído" — o evento gravava os
  // NOMES dos campos alterados, nunca o valor antes/depois. `newValueByCol`
  // guarda o valor novo por coluna (o valor ANTIGO vem de uma leitura antes
  // do UPDATE, abaixo) para montar o diff exposto em
  // GET /federation/:id/dojos/:dojoId/roster-events (karateRosterValidation.js).
  const newValueByCol = {};

  for (const [key, col] of Object.entries(PORTAL_EDITABLE_FIELDS)) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      let val = body[key];
      val = val === null ? null : (String(val).trim() || null);
      setClauses.push(`${col} = $${n}`);
      params.push(val);
      n++;
      changedFields.push(key);
      newValueByCol[col] = val;
    }
  }

  let isActiveProvided = false;
  let isActiveValue = null;
  if (Object.prototype.hasOwnProperty.call(body, 'is_active')) {
    isActiveProvided = true;
    isActiveValue = body.is_active === true || body.is_active === 'true' || body.is_active === 1;
    setClauses.push(`is_active = $${n}`);
    params.push(isActiveValue);
    n++;
    changedFields.push('is_active');
    newValueByCol.is_active = isActiveValue;
  }

  if (!setClauses.length) {
    return res.status(422).json({ error: 'Nenhum campo para atualizar', code: 'VALIDATION_ERROR' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const tokRes = await client.query(
      `SELECT dojo_id, federation_id, token_expires_at
       FROM karate_dojo_roster_validation
       WHERE token = $1
       FOR UPDATE`,
      [token]
    );
    if (!tokRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Link inválido' });
    }
    const { dojo_id: dojoId, federation_id: federationId, token_expires_at: tokenExpiresAt } = tokRes.rows[0];
    const expired = !tokenExpiresAt || new Date(tokenExpiresAt) <= new Date();
    if (expired) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'Link expirado. Solicite uma nova atualização cadastral à federação.' });
    }

    params.push(dojoId);
    const dojoParamIdx = params.length;

    // Valor ANTIGO das colunas alteradas — lido ANTES do UPDATE, na mesma
    // transação (já estamos com a linha do token sob FOR UPDATE, sem
    // corrida possível entre a leitura e a escrita abaixo). Alimenta o
    // diff do evento de auditoria (item 8) — sem isso a federação só via
    // QUE algo mudou, nunca de que valor para qual.
    const changedCols = Object.keys(newValueByCol);
    let oldRow = {};
    if (changedCols.length) {
      const oldRes = await client.query(
        `SELECT name, ${changedCols.join(', ')} FROM customers WHERE id = $1 AND dojo_id = $2`,
        [studentId, dojoId]
      );
      oldRow = oldRes.rows[0] || {};
    }

    // ESCOPO: só acerta praticante do dojô deste token (mesmo padrão do
    // POST /:token acima) — nunca aceita dojo_id/federation_id do body.
    const updateRes = await client.query(
      `UPDATE customers SET ${setClauses.join(', ')}, updated_at = NOW()
       WHERE id = $1 AND dojo_id = $${dojoParamIdx}
       RETURNING id, name, phone, email, is_active, birth_date, cpf_cnpj, rg, street, city, state`,
      params
    );
    if (!updateRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Praticante não encontrado neste dojô', code: 'NOT_FOUND' });
    }
    const updated = updateRes.rows[0];

    // Diff antes/depois por campo (item 8) — usa o NOME do campo do
    // PATCH (ex.: "cpf", "birth_date"), não a coluna SQL, pra bater com o
    // que a UI já rotula (MISSING_LABEL/EditFieldRow no front). birth_date
    // vem do driver pg como objeto Date — nunca interpolar/comparar direto
    // (armadilha conhecida, ver CLAUDE.md: String(dateObj) vira "Sun Apr
    // 17", não "2011-04-18"); toIsoDate (karatePractitionerDedup.js) é a
    // fonte única de normalização de data já usada no resto do backend.
    const normalizeForDiff = (col, v) => (col === 'birth_date' ? toIsoDate(v) : (v === undefined ? null : v));
    const changes = [];
    for (const [key, col] of Object.entries(PORTAL_EDITABLE_FIELDS)) {
      if (!Object.prototype.hasOwnProperty.call(newValueByCol, col)) continue;
      const from = normalizeForDiff(col, oldRow[col]);
      const to = normalizeForDiff(col, newValueByCol[col]);
      if (from !== to) changes.push({ field: key, from, to });
    }
    if (isActiveProvided) {
      const from = oldRow.is_active !== false;
      const to = isActiveValue;
      if (from !== to) changes.push({ field: 'is_active', from, to });
    }

    // Auditoria — best-effort via SAVEPOINT (mesmo padrão dos demais
    // endpoints deste arquivo). Regra invadiável: inativar aqui NUNCA gera
    // cobrança — is_active só afeta customers; karate_member_standing já
    // trata is_active=false como 'nao_aplicavel'/0 (view existente, não
    // mexida por este PATCH).
    await client.query('SAVEPOINT sp_granular_event');
    try {
      const eventName = isActiveProvided
        ? (isActiveValue ? 'practitioner_reactivated' : 'practitioner_inactivated')
        : 'practitioner_updated';
      await client.query(
        `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
         VALUES ($1, $2, $3, $4::jsonb, NULL)`,
        [dojoId, federationId, eventName, JSON.stringify([{
          student_id: studentId,
          student_name: oldRow.name || updated.name || null,
          fields: changedFields,
          // Item 8: antes/depois por campo — a federação pedia isso
          // explicitamente ("ela precisa ver o que o sensei mudou, de
          // que valor para qual, quando"); `created_at` da própria linha
          // já cobre o "quando".
          changes,
          source: 'sensei_portal',
        }])]
      );
      await client.query('RELEASE SAVEPOINT sp_granular_event');
    } catch (e) {
      if (e.code === '42P01') {
        await client.query('ROLLBACK TO SAVEPOINT sp_granular_event');
        console.warn('[karateRosterPortalPublic] karate_dojo_roster_events ausente (schema pendente)');
      } else {
        throw e;
      }
    }

    await client.query('SAVEPOINT sp_touch_access');
    try {
      await client.query(
        `UPDATE karate_dojo_roster_validation SET last_accessed_at = NOW() WHERE dojo_id = $1`,
        [dojoId]
      );
      await client.query('RELEASE SAVEPOINT sp_touch_access');
    } catch (e) {
      if (e.code === '42703') {
        await client.query('ROLLBACK TO SAVEPOINT sp_touch_access');
      } else {
        throw e;
      }
    }

    await client.query('COMMIT');

    // Progresso do dojô pós-alteração (para a UI atualizar a barra sem
    // precisar de um novo GET do quadro inteiro).
    let progress = null;
    try {
      // Item 4: mesma régua de completude de classifyPraticante (todos os
      // campos que o portal edita, exceto complement — endereço é
      // rua+cidade+UF, mesmo mínimo da grade de completude do front).
      const q = await db.query(
        `SELECT COUNT(*) FILTER (WHERE is_active)::int AS total,
                COUNT(*) FILTER (
                  WHERE is_active
                    AND phone IS NOT NULL AND btrim(phone) <> ''
                    AND email IS NOT NULL AND btrim(email) <> ''
                    AND birth_date IS NOT NULL
                    AND cpf_cnpj IS NOT NULL AND btrim(cpf_cnpj) <> ''
                    AND rg IS NOT NULL AND btrim(rg) <> ''
                    AND street IS NOT NULL AND btrim(street) <> ''
                    AND city IS NOT NULL AND btrim(city) <> ''
                    AND state IS NOT NULL AND btrim(state) <> ''
                )::int AS resolved
         FROM customers WHERE dojo_id = $1 AND is_guest = false`,
        [dojoId]
      );
      progress = {
        essenciais_total: q.rows[0].total,
        essenciais_resolvidos: q.rows[0].resolved,
      };
    } catch (_) { /* best-effort — não falha o PATCH por causa do resumo */ }

    const { missing } = classifyPraticante({ ...updated, is_black_belt: false, financeiro: null });

    res.json({
      id: updated.id,
      name: updated.name,
      phone: updated.phone || null,
      email: updated.email || null,
      is_active: updated.is_active !== false,
      missing,
      progress,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateRosterPortalPublic] granular update error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar alteração' });
  } finally {
    client.release();
  }
});

// ── POST /public/roster-update/:token ───────────────────────
// Body: { updates: [{ student_id, is_active }], validated_by?: string }
// Fecha o ciclo (confirma o quadro) e EXPIRA o token — continua existindo
// para o fluxo de revisão em lote / confirmação final; o PATCH granular
// acima é o novo caminho de autosave campo a campo durante a sessão.
router.post('/:token', async (req, res) => {
  const token = req.params.token;
  const body = req.body || {};
  const updates = Array.isArray(body.updates) ? body.updates : [];
  const validatedBy = body.validated_by ? String(body.validated_by).trim().slice(0, 200) : null;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const tokRes = await client.query(
      `SELECT dojo_id, federation_id, token_expires_at
       FROM karate_dojo_roster_validation
       WHERE token = $1
       FOR UPDATE`,
      [token]
    );
    if (!tokRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Link inválido' });
    }
    const { dojo_id: dojoId, federation_id: federationId, token_expires_at: tokenExpiresAt } = tokRes.rows[0];
    const expired = !tokenExpiresAt || new Date(tokenExpiresAt) <= new Date();
    if (expired) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'Link expirado. Solicite uma nova atualização cadastral à federação.' });
    }

    const applied = [];
    const skipped = [];

    for (const raw of updates) {
      const studentId = raw && raw.student_id;
      if (!studentId || typeof raw.is_active === 'undefined') {
        skipped.push({ student_id: studentId || null, reason: 'payload inválido' });
        continue;
      }
      const isActive = raw.is_active === true || raw.is_active === 'true' || raw.is_active === 1;

      const upd = await client.query(
        `UPDATE customers SET is_active = $1, updated_at = NOW()
         WHERE id = $2 AND dojo_id = $3
         RETURNING id`,
        [isActive, studentId, dojoId]
      );
      if (upd.rows.length) {
        applied.push({ student_id: studentId, was_active: isActive });
      } else {
        skipped.push({ student_id: studentId, reason: 'fora do dojô deste link' });
      }
    }

    await client.query('SAVEPOINT sp_validated_event');
    try {
      await client.query(
        `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
         VALUES ($1, $2, 'validated', $3::jsonb, NULL)`,
        [dojoId, federationId, JSON.stringify(applied)]
      );
      await client.query('RELEASE SAVEPOINT sp_validated_event');
    } catch (e) {
      if (e.code === '42P01') {
        await client.query('ROLLBACK TO SAVEPOINT sp_validated_event');
        console.warn('[karateRosterPortalPublic] karate_dojo_roster_events ausente (schema pendente)');
      } else {
        throw e;
      }
    }

    const finalRes = await client.query(
      `UPDATE karate_dojo_roster_validation
       SET status = 'validated', validated_at = NOW(), validated_by = $2,
           token_expires_at = NOW(), updated_at = NOW()
       WHERE dojo_id = $1
       RETURNING status, validated_at, validated_by`,
      [dojoId, validatedBy]
    );

    await client.query('COMMIT');

    res.json({
      status: finalRes.rows[0].status,
      validated_at: finalRes.rows[0].validated_at,
      validated_by: finalRes.rows[0].validated_by,
      applied,
      skipped,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateRosterPortalPublic] POST error:', err.message);
    res.status(500).json({ error: 'Erro ao salvar atualização cadastral' });
  } finally {
    client.release();
  }
});

// ── POST /public/roster-update/:token/practitioner ──────────
// (14/07/2026 — H2: este endpoint NÃO cria mais o praticante direto em
//   `customers`. O número FPKT é emitido pela FEDERAÇÃO, fora do sistema
//   (regra fechada com o Caio, ver migration 231 / H1) — o quick-add do
//   sensei era o único caminho restante que ainda inventava um número
//   (nextPractitionerRegistrationNumber). Agora ele cria uma SOLICITAÇÃO
//   em `karate_practitioner_requests` — a MESMA tabela/fluxo do portal
//   novo do sensei (karateDojoPractitionerRequests.js) — que fica pendente
//   até a federação aprovar (atribuindo o número real) ou rejeitar. Opção
//   (a) do H2 em vez de desabilitar o botão: o esforço foi razoável porque
//   a tabela/dedup/aprovação já existiam prontas da H1, e assim o sensei
//   não perde a conveniência de "adicionar rápido pelo portal" — só deixa
//   de sair com um número inventado. dojo_id/federation_id SEMPRE do
//   token (nunca do body), mesma regra do resto deste arquivo. Continua
//   NÃO expirando o token.
const VALID_SEX_VALUES = ['M', 'F', 'other'];

// ── POST /public/roster-update/:token/practitioner ──────────
// H2b: ficha COMPLETA, mesmo contrato de campos de
// POST /federation/:id/dojo/practitioner-requests (karateDojoPractitionerRequests.js)
// — só troca requireDojoAccess (JWT) por resolveToken (token opaco do
// link público). full_name é o único campo obrigatório (mesma régua do
// endpoint autenticado); `name`/`belt_level`/`belt_name` continuam aceitos
// como fallback para não quebrar chamador antigo, mas o corpo canônico
// agora é full_name/claimed_belt.
router.post('/:token/practitioner', practitionerCreateLimiter, async (req, res) => {
  const token = req.params.token;
  const b = req.body || {};

  const full_name = (b.full_name != null ? String(b.full_name) : (b.name != null ? String(b.name) : '')).trim();
  if (!full_name) {
    return res.status(422).json({ error: 'Nome é obrigatório', code: 'VALIDATION_ERROR' });
  }

  const birth_date = (typeof b.birth_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.birth_date))
    ? b.birth_date
    : null;
  if (b.birth_date && !birth_date) {
    return res.status(422).json({ error: 'birth_date deve ser YYYY-MM-DD', code: 'VALIDATION_ERROR' });
  }

  if (b.sex !== undefined && b.sex !== null && b.sex !== '' && !VALID_SEX_VALUES.includes(b.sex)) {
    return res.status(422).json({ error: `sex inválido. Use: ${VALID_SEX_VALUES.join(', ')}`, code: 'VALIDATION_ERROR' });
  }

  const cpf = b.cpf != null ? String(b.cpf).trim() || null : null;
  const rg = b.rg != null ? String(b.rg).trim() || null : null;
  const phone = b.phone != null ? String(b.phone).trim() || null : null;
  const email = b.email != null ? String(b.email).trim() || null : null;
  // claimed_belt é o campo canônico (ficha completa); belt_name/belt_level
  // seguem aceitos como fallback (contrato antigo do quick-add).
  const claimed_belt = (b.claimed_belt != null ? String(b.claimed_belt).trim() : '')
    || (b.belt_name != null ? String(b.belt_name).trim() : '')
    || (b.belt_level != null ? String(b.belt_level).trim() : '')
    || null;
  const fpktClaimed = b.fpkt_number_claimed != null ? normalizeFpktNumber(b.fpkt_number_claimed) || null : null;

  // Ficha completa (nome, nascimento, CPF, RG, telefone, e-mail, faixa
  // alegada, endereço, responsável se menor) — mesmo shape do payload do
  // endpoint autenticado (karateDojoPractitionerRequests.js). dojo_id/
  // federation_id NUNCA entram aqui — vêm sempre do token, resolvido
  // dentro da transação abaixo (FOR UPDATE, nunca do body).
  const payload = {
    full_name, birth_date, cpf, rg, phone, email, sex: b.sex || null,
    claimed_belt, fpkt_number_claimed: fpktClaimed,
    street: b.street || null, number: b.number || null, complement: b.complement || null,
    neighborhood: b.neighborhood || null, city: b.city || null, state: b.state || null, zip_code: b.zip_code || null,
    guardian_name: b.guardian_name || null, guardian_cpf: b.guardian_cpf || null,
    guardian_phone: b.guardian_phone || null, guardian_relationship: b.guardian_relationship || null,
    source: 'roster_portal_public_request',
  };

  // Item 6 (revisão Atualização Cadastral, 15/07/2026): mesma validação do
  // canal autenticado (karateDojoPractitionerRequests.js) — TODOS os
  // campos da ficha obrigatórios, validado no BACKEND (não só no front).
  const validationErrors = validatePractitionerRequestPayload(payload);
  if (validationErrors.length) {
    return res.status(422).json({
      error: validationErrors[0],
      errors: validationErrors,
      code: 'VALIDATION_ERROR',
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const tokRes = await client.query(
      `SELECT dojo_id, federation_id, token_expires_at
       FROM karate_dojo_roster_validation
       WHERE token = $1
       FOR UPDATE`,
      [token]
    );
    if (!tokRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Link inválido' });
    }
    const { dojo_id: dojoId, federation_id: federationId, token_expires_at: tokenExpiresAt } = tokRes.rows[0];
    const expired = !tokenExpiresAt || new Date(tokenExpiresAt) <= new Date();
    if (expired) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'Link expirado. Solicite uma nova atualização cadastral à federação.' });
    }

    // Mesma chave de idempotência do portal de solicitação novo: dojô +
    // nome normalizado + nascimento (karatePractitionerDedup.buildDedupKey).
    const dedupKey = buildDedupKey(full_name, birth_date);

    const insertRes = await client.query(
      `INSERT INTO karate_practitioner_requests
         (federation_id, dojo_id, full_name, birth_date, cpf, rg, phone, email,
          claimed_belt, payload, fpkt_number_claimed, dedup_key, requested_by_channel)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,'roster_portal_sensei')
       ON CONFLICT (dojo_id, dedup_key) WHERE status = 'pendente' DO NOTHING
       RETURNING id, status, created_at`,
      [federationId, dojoId, full_name, birth_date, cpf, rg, phone, email, claimed_belt, JSON.stringify(payload), fpktClaimed, dedupKey]
    );

    let request = insertRes.rows[0];
    let alreadyPending = false;

    if (!request) {
      // Já existe uma solicitação PENDENTE idêntica (mesmo dojô + nome +
      // nascimento) — idempotente: não duplica, devolve a existente.
      alreadyPending = true;
      const existingRes = await client.query(
        `SELECT id, status, created_at FROM karate_practitioner_requests
          WHERE dojo_id = $1 AND dedup_key = $2 AND status = 'pendente'
          LIMIT 1`,
        [dojoId, dedupKey]
      );
      request = existingRes.rows[0];
    }

    await client.query('SAVEPOINT sp_practitioner_request_event');
    try {
      await client.query(
        `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
         VALUES ($1, $2, 'practitioner_request_created', $3::jsonb, NULL)`,
        [dojoId, federationId, JSON.stringify([{ request_id: request.id, full_name }])]
      );
      await client.query('RELEASE SAVEPOINT sp_practitioner_request_event');
    } catch (e) {
      if (e.code === '42P01') {
        await client.query('ROLLBACK TO SAVEPOINT sp_practitioner_request_event');
        console.warn('[karateRosterPortalPublic] karate_dojo_roster_events ausente (schema pendente)');
      } else {
        throw e;
      }
    }

    await client.query('COMMIT');

    // Hint imediato (best-effort, fora da transação — nunca bloqueia a
    // solicitação já commitada): se o sensei já digitou um número FPKT,
    // avisa na hora se ele já pertence a alguém (provável transferência).
    let fpktHint = null;
    if (fpktClaimed && !alreadyPending) {
      try {
        fpktHint = await lookupByFpktNumber(db, { federationId, number: fpktClaimed });
      } catch (e) {
        console.error('[karateRosterPortalPublic] fpkt hint falhou (não bloqueia):', e.message);
      }
    }

    res.status(alreadyPending ? 200 : 201).json({
      id: request.id,
      status: request.status,
      created_at: request.created_at,
      already_pending: alreadyPending,
      claimed_belt,
      fpkt_lookup: fpktHint,
      message: alreadyPending
        ? 'Já existe uma solicitação pendente para esta pessoa neste dojô.'
        : 'Solicitação enviada à federação. Ela vai validar e emitir o número FPKT — este praticante ainda não está no quadro.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '42P01') {
      console.warn('[karateRosterPortalPublic] karate_practitioner_requests ausente (schema pendente)');
      return res.status(503).json({ error: 'Solicitação de praticante ainda não disponível (migração pendente)', code: 'MIGRATION_PENDING' });
    }
    console.error('[karateRosterPortalPublic] add practitioner error:', err.message);
    res.status(500).json({ error: 'Erro ao adicionar praticante' });
  } finally {
    client.release();
  }
});

// ── POST /public/roster-update/:token/practitioner/:requestId/photo ──
// Item 9 (revisão Atualização Cadastral, 15/07/2026): foto do praticante
// novo, pelo MESMO canal público que abre a solicitação — reusa
// uploadToR2 (mesmo mecanismo de karatePractitioners.js/
// karateDojoPractitionerRequests.js, nenhum upload novo inventado). O
// portal público NÃO tem JWT (é token-gated, como todo o resto deste
// arquivo) — por isso este endpoint fica AQUI, escopado ao token/dojô,
// em vez do endpoint autenticado guards.staffWrite() de
// karatePractitioners.js (que exige um customer já existente e sessão de
// federação — nenhum dos dois existe no fluxo do sensei sem login).
const PHOTO_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

router.post('/:token/practitioner/:requestId/photo', photoUploadLimiter, async (req, res) => {
  const token = req.params.token;
  const { requestId } = req.params;
  const { content, content_type } = req.body || {};

  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'Campo content (imagem em base64) é obrigatório', code: 'VALIDATION_ERROR' });
  }
  const mime = ((content_type || 'image/jpeg') + '').toLowerCase().split(';')[0].trim();
  if (!PHOTO_ALLOWED_TYPES.includes(mime)) {
    return res.status(400).json({
      error: 'Tipo de imagem não suportado: ' + mime + '. Use image/jpeg, image/png ou image/webp.',
      code: 'INVALID_CONTENT_TYPE',
    });
  }
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';

  try {
    const resolved = await resolveToken(token, { touch: false });
    if (!resolved) return res.status(404).json({ error: 'Link inválido' });
    if (resolved.expired) return res.status(410).json({ error: 'Link expirado. Solicite uma nova atualização cadastral à federação.' });

    // ESCOPO: só a solicitação DESTE dojô (nunca de outro dojô, mesmo na
    // mesma federação) — mesma regra de todo o resto deste arquivo.
    const reqRes = await db.query(
      `SELECT id FROM karate_practitioner_requests WHERE id = $1 AND dojo_id = $2 LIMIT 1`,
      [requestId, resolved.dojo_id]
    );
    if (!reqRes.rows.length) {
      return res.status(404).json({ error: 'Solicitação não encontrada neste dojô', code: 'NOT_FOUND' });
    }

    const key = 'karate/practitioner-requests/' + requestId + '.' + ext;
    const result = await uploadToR2(key, content, mime);
    if (!result.success) {
      console.error('[karateRosterPortalPublic] photo R2 error:', result.error);
      return res.status(500).json({ error: 'Erro no armazenamento da imagem' });
    }

    await db.query(`UPDATE karate_practitioner_requests SET photo_url = $1 WHERE id = $2`, [result.url, requestId]);

    res.json({ photo_url: result.url });
  } catch (e) {
    if (e.code === '42703') {
      console.warn('[karateRosterPortalPublic] photo_url ausente (migration 232 pendente)');
      return res.status(503).json({ error: 'Foto na solicitação ainda não disponível (migração pendente)', code: 'MIGRATION_PENDING' });
    }
    if (e.code === '42P01') {
      return res.status(503).json({ error: 'Solicitação de praticante ainda não disponível (migração pendente)', code: 'MIGRATION_PENDING' });
    }
    console.error('[karateRosterPortalPublic] photo error:', e.message);
    return res.status(500).json({ error: 'Erro ao anexar foto à solicitação' });
  }
});

// ── GET /public/roster-update/:token/fpkt-lookup?number= ────
// H2b: auto-localizar token-gated — equivalente de
// GET /federation/:id/dojo/practitioner-requests/lookup-fpkt (H1), sem
// JWT. Escopado à FEDERAÇÃO do token (não só o dojô — o praticante pode
// estar em outro dojô da mesma federação); devolve o MÍNIMO (nome + dojô
// atual) — o bastante pro sensei reconhecer "isto é transferência", nunca
// mais que isso (nenhum contato/CPF/endereço de terceiro).
router.get('/:token/fpkt-lookup', fpktLookupLimiter, async (req, res) => {
  const number = req.query.number != null ? String(req.query.number).trim() : '';
  if (!number) {
    return res.status(422).json({ error: 'Parâmetro number é obrigatório', code: 'VALIDATION_ERROR' });
  }
  try {
    const resolved = await resolveToken(req.params.token, { touch: false });
    if (!resolved) return res.status(404).json({ error: 'Link inválido' });
    if (resolved.expired) return res.status(410).json({ error: 'Link expirado. Solicite uma nova atualização cadastral à federação.' });

    const result = await lookupByFpktNumber(db, { federationId: resolved.federation_id, number });
    return res.json(result);
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') {
      console.warn('[karateRosterPortalPublic] fpkt-lookup schema pendente:', err.message);
      return res.status(404).json({ error: 'Link inválido' });
    }
    console.error('[karateRosterPortalPublic] fpkt-lookup error:', err.message);
    res.status(500).json({ error: 'Erro ao consultar número FPKT' });
  }
});

// ── GET /public/roster-update/:token/practitioner-requests ──
// H2b: status das solicitações do PRÓPRIO dojô, sem login — equivalente
// token-gated de GET /federation/:id/dojo/practitioner-requests (H1).
// QA H5: reusa fpktLookupLimiter (60/10min por token+IP) em vez de criar
// um terceiro limiter quase idêntico — é uma leitura de status, mesmo
// perfil de uso (consulta repetida durante uma sessão de matrícula) do
// fpkt-lookup logo acima, e o teto de leitura já é mais folgado que o de
// criação (practitionerCreateLimiter, 30/10min).
router.get('/:token/practitioner-requests', fpktLookupLimiter, async (req, res) => {
  const status = ['pendente', 'aprovada', 'rejeitada'].includes(req.query.status) ? req.query.status : null;
  try {
    const resolved = await resolveToken(req.params.token, { touch: false });
    if (!resolved) return res.status(404).json({ error: 'Link inválido' });
    if (resolved.expired) return res.status(410).json({ error: 'Link expirado. Solicite uma nova atualização cadastral à federação.' });

    const { rows } = await db.query(
      `SELECT r.id, r.status, r.resolution, r.reject_reason, r.full_name, r.birth_date,
              r.claimed_belt, r.fpkt_number_claimed, r.resolved_practitioner_id, r.photo_url,
              r.created_at, r.resolved_at,
              c.karate_registration_number AS resolved_fpkt_number,
              c.name AS resolved_practitioner_name
         FROM karate_practitioner_requests r
         LEFT JOIN customers c ON c.id = r.resolved_practitioner_id
        WHERE r.dojo_id = $1
          AND ($2::text IS NULL OR r.status = $2)
        ORDER BY r.created_at DESC
        LIMIT 200`,
      [resolved.dojo_id, status]
    );
    return res.json({
      data: rows.map((r) => ({
        id: r.id,
        status: r.status,
        resolution: r.resolution || null,
        reject_reason: r.reject_reason || null,
        full_name: r.full_name,
        birth_date: r.birth_date || null,
        claimed_belt: r.claimed_belt || null,
        fpkt_number_claimed: r.fpkt_number_claimed || null,
        photo_url: r.photo_url || null,
        resolved_practitioner_id: r.resolved_practitioner_id || null,
        resolved_fpkt_number: r.resolved_fpkt_number || null,
        resolved_practitioner_name: r.resolved_practitioner_name || null,
        created_at: r.created_at,
        resolved_at: r.resolved_at || null,
      })),
    });
  } catch (err) {
    if (err.code === '42P01') return res.json({ data: [] });
    if (err.code === '42703') {
      console.warn('[karateRosterPortalPublic] practitioner-requests schema pendente:', err.message);
      return res.status(404).json({ error: 'Link inválido' });
    }
    console.error('[karateRosterPortalPublic] practitioner-requests list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar solicitações' });
  }
});

// ── GET /public/roster-update/:token/export ─────────────────
router.get('/:token/export', async (req, res) => {
  try {
    const resolved = await resolveToken(req.params.token, { touch: false });
    if (!resolved) return res.status(404).json({ error: 'Link inválido' });
    if (resolved.expired) return res.status(410).json({ error: 'Link expirado. Solicite uma nova atualização cadastral à federação.' });

    const quadro = await fetchQuadro(resolved.dojo_id, resolved.federation_id);

    const header = ['Nome', 'Registro FPKT', 'Faixa', 'Situação'];
    const lines = [header.map(csvEscape).join(';')];
    for (const p of quadro.praticantes) {
      lines.push([
        p.name || '',
        p.karate_registration_number || '',
        p.belt_name || '',
        p.is_active ? 'Ativo' : 'Inativo',
      ].map(csvEscape).join(';'));
    }
    const csv = '﻿' + lines.join('\r\n') + '\r\n';

    const safeName = (resolved.dojo_nome || 'quadro').replace(/[^a-zA-Z0-9-_]+/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="quadro-${safeName}.csv"`);
    res.send(csv);
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') {
      console.warn('[karateRosterPortalPublic] schema pendente:', err.message);
      return res.status(404).json({ error: 'Link inválido' });
    }
    console.error('[karateRosterPortalPublic] export error:', err.message);
    res.status(500).json({ error: 'Erro ao exportar quadro do dojô' });
  }
});

// ── GET /public/roster-update/:token/export-missing ─────────
// Item 5 — só quem falta algo, só as colunas essenciais (que são,
// coincidentemente, as únicas colunas que este endpoint jamais exporta em
// branco de propósito: telefone/e-mail) + identificador estável (matrícula
// FPKT) para o casamento na volta.
router.get('/:token/export-missing', async (req, res) => {
  try {
    const resolved = await resolveToken(req.params.token, { touch: false });
    if (!resolved) return res.status(404).json({ error: 'Link inválido' });
    if (resolved.expired) return res.status(410).json({ error: 'Link expirado. Solicite uma nova atualização cadastral à federação.' });

    const quadro = await fetchQuadro(resolved.dojo_id, resolved.federation_id);
    const faltando = quadro.praticantes.filter((p) => p.missing.length > 0);

    const header = ['Matrícula FPKT', 'Nome', 'Telefone', 'E-mail'];
    const lines = [header.map(csvEscape).join(';')];
    for (const p of faltando) {
      lines.push([
        p.karate_registration_number || '',
        p.name || '',
        p.phone || '',
        p.email || '',
      ].map(csvEscape).join(';'));
    }
    const csv = '﻿' + lines.join('\r\n') + '\r\n';

    const safeName = (resolved.dojo_nome || 'quadro').replace(/[^a-zA-Z0-9-_]+/g, '_');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="faltantes-${safeName}.csv"`);
    res.send(csv);
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') {
      console.warn('[karateRosterPortalPublic] export-missing schema pendente:', err.message);
      return res.status(404).json({ error: 'Link inválido' });
    }
    console.error('[karateRosterPortalPublic] export-missing error:', err.message);
    res.status(500).json({ error: 'Erro ao exportar planilha de pendências' });
  }
});

// ── POST /public/roster-update/:token/import ─────────────────
// Reimporta a planilha de export-missing preenchida. Casamento por
// identificador estável (matrícula FPKT) — NUNCA por nome (item 5).
// Idempotente; erro em uma linha não aborta o lote (SAVEPOINT por linha).
const IDENTIFIER_HEADER_ALIASES = ['matricula fpkt', 'matricula', 'registro fpkt', 'registro', 'karate_registration_number', 'fpkt'];
const PHONE_HEADER_ALIASES = ['telefone', 'phone', 'fone', 'celular'];
const EMAIL_HEADER_ALIASES = ['email', 'e-mail'];

function normalizeHeader(h) {
  return String(h || '').toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function resolveImportColumns(headers) {
  const map = {};
  for (const h of headers) {
    const norm = normalizeHeader(h);
    if (!map.identifier && IDENTIFIER_HEADER_ALIASES.some((a) => norm === normalizeHeader(a))) map.identifier = h;
    else if (!map.phone && PHONE_HEADER_ALIASES.some((a) => norm === normalizeHeader(a))) map.phone = h;
    else if (!map.email && EMAIL_HEADER_ALIASES.some((a) => norm === normalizeHeader(a))) map.email = h;
  }
  return map;
}

async function doImport(token, csvText, res) {
  if (!csvText || !String(csvText).trim()) {
    return res.status(422).json({ error: 'csv_content vazio', code: 'VALIDATION_ERROR' });
  }
  const stripped = String(csvText).replace(/^﻿/, '');
  const lines = stripped.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    return res.status(422).json({ error: 'CSV sem linhas de dados', code: 'VALIDATION_ERROR' });
  }

  const delim = lines[0].includes(';') ? ';' : ',';
  const splitLine = (line) => (delim === ';' ? line.split(';').map((s) => s.trim()) : parseCSVLine(line));
  const headers = splitLine(lines[0]);
  const colMap = resolveImportColumns(headers);

  if (!colMap.identifier) {
    return res.status(422).json({ error: 'Coluna de matrícula (identificador estável) não encontrada no CSV', code: 'VALIDATION_ERROR' });
  }

  const client = await db.connect();
  const erros = [];
  const applied = [];
  let atualizados = 0;
  let ignorados = 0;

  try {
    await client.query('BEGIN');

    const tokRes = await client.query(
      `SELECT dojo_id, federation_id, token_expires_at
       FROM karate_dojo_roster_validation
       WHERE token = $1
       FOR UPDATE`,
      [token]
    );
    if (!tokRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Link inválido' });
    }
    const { dojo_id: dojoId, federation_id: federationId, token_expires_at: tokenExpiresAt } = tokRes.rows[0];
    const expired = !tokenExpiresAt || new Date(tokenExpiresAt) <= new Date();
    if (expired) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'Link expirado. Solicite uma nova atualização cadastral à federação.' });
    }

    for (let i = 1; i < lines.length; i++) {
      const rowNum = i + 1;
      const values = splitLine(lines[i]);
      const row = {};
      headers.forEach((h, idx) => { row[h] = values[idx] !== undefined ? values[idx] : ''; });

      const identifier = String(row[colMap.identifier] || '').trim();
      const phoneVal = colMap.phone ? String(row[colMap.phone] || '').trim() : '';
      const emailVal = colMap.email ? String(row[colMap.email] || '').trim() : '';

      await client.query('SAVEPOINT sp_import_row');
      try {
        if (!identifier) {
          erros.push({ row: rowNum, motivo: 'Matrícula (identificador) ausente' });
          await client.query('ROLLBACK TO SAVEPOINT sp_import_row');
          continue;
        }
        if (!phoneVal && !emailVal) {
          ignorados++;
          await client.query('ROLLBACK TO SAVEPOINT sp_import_row');
          continue;
        }

        const setParts = [];
        const params = [identifier, dojoId];
        let n = 3;
        if (phoneVal) { setParts.push(`phone = $${n}`); params.push(phoneVal); n++; }
        if (emailVal) { setParts.push(`email = $${n}`); params.push(emailVal); n++; }

        // ESCOPO: casamento por matrícula E dojo_id do token — nunca por
        // nome, nunca fora do dojô deste link.
        const upd = await client.query(
          `UPDATE customers SET ${setParts.join(', ')}, updated_at = NOW()
           WHERE karate_registration_number = $1 AND dojo_id = $2
           RETURNING id, name`,
          params
        );
        if (!upd.rows.length) {
          erros.push({ row: rowNum, motivo: `Matrícula '${identifier}' não encontrada neste dojô` });
          await client.query('ROLLBACK TO SAVEPOINT sp_import_row');
          continue;
        }
        atualizados++;
        applied.push({ student_id: upd.rows[0].id, name: upd.rows[0].name });
        await client.query('RELEASE SAVEPOINT sp_import_row');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT sp_import_row');
        erros.push({ row: rowNum, motivo: e.message });
      }
    }

    await client.query('SAVEPOINT sp_import_event');
    try {
      await client.query(
        `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
         VALUES ($1, $2, 'roster_imported', $3::jsonb, NULL)`,
        [dojoId, federationId, JSON.stringify(applied.map((a) => ({ ...a, source: 'sensei_portal_import' })))]
      );
      await client.query('RELEASE SAVEPOINT sp_import_event');
    } catch (e) {
      if (e.code === '42P01') {
        await client.query('ROLLBACK TO SAVEPOINT sp_import_event');
      } else {
        throw e;
      }
    }

    await client.query('SAVEPOINT sp_import_touch');
    try {
      await client.query(`UPDATE karate_dojo_roster_validation SET last_accessed_at = NOW() WHERE dojo_id = $1`, [dojoId]);
      await client.query('RELEASE SAVEPOINT sp_import_touch');
    } catch (e) {
      if (e.code === '42703') {
        await client.query('ROLLBACK TO SAVEPOINT sp_import_touch');
      } else {
        throw e;
      }
    }

    await client.query('COMMIT');
    res.json({ atualizados, ignorados, erros });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[karateRosterPortalPublic] import error:', err.message);
    res.status(500).json({ error: 'Erro ao importar planilha' });
  } finally {
    client.release();
  }
}

router.post('/:token/import', async (req, res) => {
  const token = req.params.token;

  if (upload && req.is('multipart/form-data')) {
    return upload.single('file')(req, res, async (err) => {
      if (err) {
        return res.status(422).json({ error: 'Falha ao ler arquivo enviado', code: 'VALIDATION_ERROR' });
      }
      const csvText = req.file ? req.file.buffer.toString('utf8') : (req.body && req.body.csv_content);
      return doImport(token, csvText, res);
    });
  }

  const csvText = req.body && req.body.csv_content;
  return doImport(token, csvText, res);
});

module.exports = router;
// Exportado à parte para teste unitário direto (sem supertest/mock de db) —
// ver __tests__/karate.rosterCompleteness.test.js (item 4).
module.exports.classifyPraticante = classifyPraticante;
