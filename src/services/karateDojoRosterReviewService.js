// ============================================================
// AURA DOJÔ — F11.3: revisão do plantel herdado (migration 276)
//
// Pedido do dono do produto (10/08/2026): "Na hora de receber os dados da
// federação, ele possa marcar quais praticantes deseja receber. E em
// contrapartida a federação seja avisada de quais praticantes o sensei
// marcou como inativos — interpretando que se ele não quer o aluno em seu
// registro, não está mais ativo."
//
// ⚠️ A INTERPRETAÇÃO NÃO SOBE PARA O BANCO. O sensei sabe responder "esta
// pessoa treina comigo?"; ele NÃO sabe responder "esta pessoa parou de
// treinar karatê?". A pessoa pode ter MUDADO DE DOJÔ —
// karate_practitioner_transfers tem 540 linhas. Então:
//   • concluir a revisão gera AVISO, nunca inativação;
//   • nenhuma função deste arquivo escreve em customers.is_active;
//   • quem inativa/transfere/mantém é a federação, pela rota dela
//     (karateRosterReviewNoticesAdmin.js), com ator identificado.
// Inativar 4.033 pessoas por inferência automática seria dano difícil de
// desfazer. Ver o cabeçalho da migration 276.
//
// ── ANCORAGEM ───────────────────────────────────────────────
// O plantel herdado É `customers` com dojo_id = <company do registro> —
// não karate_dojo_students (aquilo é o cadastro PRÓPRIO do dojô, F2). A
// revisão NÃO copia, NÃO move e NÃO apaga praticante nenhum: ela só
// acrescenta uma marcação lateral.
//
// ── VOLUME (o maior dojô da planilha tem 288 alunos) ─────────
//   • listagem paginada com COUNT(*) OVER() (sem 2ª ida ao banco);
//   • busca por nome/matrícula;
//   • marcação EM LOTE (até 500 ids por chamada, mesmo teto do import);
//   • estado por praticante é linha SÓ PARA QUEM FOI TOCADO — ausência de
//     linha é "ainda não revisado", então a revisão é retomável de graça e
//     não pré-popula 9.840 linhas.
//
// ── ⚠️ REVISÃO CORRENTE = ABERTA **OU** ÚLTIMA CONCLUÍDA ─────
// Regressão de 12/08/2026: leitura (summary e listagem) usava só a revisão
// `in_progress`. Depois do /complete não existe mais uma, o reviewId ia
// null e o summary caía na variante `-- drr:summary-no-review`, onde
// `pending = COUNT(*)` do plantel INTEIRO. Um dojô de 4 praticantes com a
// revisão concluída (1 recognized + 3 not_recognized) via o badge pular de
// 1 para 4 e a listagem voltar a mostrar todo mundo 'pending'. As
// marcações nunca saíram do banco — o backend é que parava de lê-las.
// Toda LEITURA passa por getCurrentReview(). A variante sem revisão
// continua existindo para o caso legítimo: dojô que nunca marcou nada.
//
// ── MOCK POR SQL ────────────────────────────────────────────
// Toda SQL carrega uma âncora `-- drr:<nome>` (mesmo espírito do `-- dtag:`
// de karateDojoTagService.js). Os testes despacham por regex sobre a
// âncora, NUNCA por fila posicional — já derrubou o CI deste repo 4 vezes.
//
// ── DEFENSIVO (a 276 sobe depois do código) ──────────────────
// 42P01 nas tabelas novas NÃO derruba a leitura: a listagem cai para a
// variante SEM o JOIN de revisão (todo mundo aparece como 'pending') e a
// resposta carrega schema_pending:true. Escrita, aí sim, é 503.
// ============================================================
'use strict';

const db = require('../config/database');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// Mesmo teto do import de alunos (karateDojoStudentService): um lote que o
// front consegue montar numa tela e o Postgres consegue engolir num INSERT.
const MAX_BATCH = 500;

const ITEM_STATUSES = ['recognized', 'not_recognized'];
const PENDING_POLICIES = ['not_recognized', 'recognized'];

const REVIEW_COLS = `id, dojo_id, federation_id, assumption_id, status,
       started_by, started_by_label, started_at,
       completed_by, completed_by_label, completed_at,
       inherited_total, recognized_count, not_recognized_count, notices_created,
       created_at, updated_at`;

function svcError(status, code, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

const isMissingRelation = (e) => !!e && (e.code === '42P01' || e.code === 'TABLE_MISSING');

function shapeReview(row) {
  if (!row) return null;
  return {
    id: row.id,
    dojo_id: row.dojo_id,
    federation_id: row.federation_id || null,
    assumption_id: row.assumption_id || null,
    status: row.status,
    started_by: row.started_by || null,
    started_by_label: row.started_by_label || null,
    started_at: row.started_at,
    completed_by: row.completed_by || null,
    completed_by_label: row.completed_by_label || null,
    completed_at: row.completed_at || null,
    inherited_total: row.inherited_total != null ? Number(row.inherited_total) : null,
    recognized_count: row.recognized_count != null ? Number(row.recognized_count) : null,
    not_recognized_count: row.not_recognized_count != null ? Number(row.not_recognized_count) : null,
    notices_created: row.notices_created != null ? Number(row.notices_created) : null,
  };
}

function shapePractitioner(row) {
  return {
    practitioner_id: row.id,
    name: row.name || null,
    karate_registration_number: row.karate_registration_number || null,
    birth_date: row.birth_date || null,
    is_active: row.is_active === true,
    photo_url: row.karate_photo_url || null,
    // 'pending' quando não há linha de item — a AUSÊNCIA é o estado.
    review_status: row.review_status || 'pending',
    reviewed_at: row.reviewed_at || null,
  };
}

function parsePaging({ limit, offset } = {}) {
  const l = parseInt(limit, 10);
  const o = parseInt(offset, 10);
  return {
    limit: Number.isFinite(l) && l > 0 ? Math.min(l, MAX_LIMIT) : DEFAULT_LIMIT,
    offset: Number.isFinite(o) && o > 0 ? o : 0,
  };
}

// ?status=active|inactive — qualquer outra coisa é TODOS ("dado faltante ≠
// pendência": um filtro mal digitado nunca deve esconder gente do sensei).
function parseActiveFilter(raw) {
  const v = raw != null ? String(raw).trim().toLowerCase() : '';
  return v === 'active' || v === 'inactive' ? v : null;
}

// ?review_status=recognized|not_recognized|pending
function parseReviewStatusFilter(raw) {
  const v = raw != null ? String(raw).trim().toLowerCase() : '';
  return v === 'recognized' || v === 'not_recognized' || v === 'pending' ? v : null;
}

function parseSearch(raw) {
  if (raw == null) return null;
  const v = String(raw).trim();
  return v === '' ? null : `%${v}%`;
}

// Lote de ids: array de strings não vazias, deduplicado, com teto.
// Não valida formato de UUID aqui — um id que não pertence ao dojô
// simplesmente não é encontrado no recorte de escopo abaixo (vira
// `skipped`), e um id malformado estouraria 22P02 no ::uuid[]; por isso o
// handler mapeia 22P02 para 422 em vez de 500.
function parsePractitionerIds(raw) {
  if (!Array.isArray(raw)) {
    throw svcError(422, 'VALIDATION_ERROR', 'Campo practitioner_ids deve ser uma lista');
  }
  const ids = [];
  const seen = new Set();
  for (const v of raw) {
    if (v == null) continue;
    const s = String(v).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    ids.push(s);
  }
  if (!ids.length) {
    throw svcError(422, 'VALIDATION_ERROR', 'Informe ao menos um praticante em practitioner_ids');
  }
  if (ids.length > MAX_BATCH) {
    throw svcError(422, 'BATCH_TOO_LARGE', `Máximo de ${MAX_BATCH} praticantes por chamada`);
  }
  return ids;
}

// ── Quem está agindo ────────────────────────────────────────
// Os *_label existem para CONGELAR o nome no momento do ato: o usuário
// pode sair da empresa depois, e a federação continua precisando saber
// quem reportou aquele praticante.
//
// ⚠️ O label NÃO PODE vir do token. `req.user` é o payload cru do JWT e
// ele não tem `name` nem `email` (signAccessToken em routes/auth.js põe
// só id, role, plan, company, is_staff, consolidated_view, federation_id,
// karate_role, dojo_id). Ler req.user.name gravava NULL em
// reviewed_by_label / started_by_label / completed_by_label /
// reported_by_label — foi o que aconteceu em produção até 12/08/2026.
// Mexer no payload do JWT para "resolver" isso invalidaria todo token em
// uso; o nome se resolve aqui, no banco.
//
// A coluna é `full_name` (NÃO existe `users.name`). Fallback: email e
// depois NULL — um usuário sem nome não pode derrubar a marcação.
//
// UMA VEZ POR REQUISIÇÃO, nunca por praticante: markBatch processa lotes
// de até 500 ids e um SELECT por linha seria 500 idas ao banco para
// escrever sempre o mesmo texto.
async function resolveActor(actor) {
  const userId = (actor && actor.userId) || null;
  const given = (actor && actor.label) || null;
  if (!userId) return { userId: null, label: given };
  if (given) return { userId, label: given };
  try {
    const { rows } = await db.query(
      `-- drr:actor-label
       SELECT full_name, email
         FROM users
        WHERE id = $1
        LIMIT 1`,
      [userId]
    );
    if (!rows.length) return { userId, label: null };
    const fullName = rows[0].full_name != null ? String(rows[0].full_name).trim() : '';
    const email = rows[0].email != null ? String(rows[0].email).trim() : '';
    return { userId, label: fullName || email || null };
  } catch (e) {
    // Resolver o nome é enfeite da trilha; nunca pode impedir o sensei de
    // marcar o plantel. O uuid (reviewed_by) continua indo certo.
    console.warn('[karateDojoRosterReview] label do ator não resolvido (não bloqueia):', e.message);
    return { userId, label: null };
  }
}

// ── A sessão de revisão ─────────────────────────────────────
async function getOpenReview(dojoId, client) {
  const q = client || db;
  const { rows } = await q.query(
    `-- drr:open-review
     SELECT ${REVIEW_COLS}
       FROM karate_dojo_roster_reviews
      WHERE dojo_id = $1 AND status = 'in_progress'
      LIMIT 1`,
    [dojoId]
  );
  return rows.length ? shapeReview(rows[0]) : null;
}

async function getLatestReview(dojoId) {
  const { rows } = await db.query(
    `-- drr:latest-review
     SELECT ${REVIEW_COLS}
       FROM karate_dojo_roster_reviews
      WHERE dojo_id = $1
      ORDER BY started_at DESC
      LIMIT 1`,
    [dojoId]
  );
  return rows.length ? shapeReview(rows[0]) : null;
}

// A revisão CORRENTE PARA LEITURA: a aberta se houver, senão a última —
// mesmo já concluída. É o que summary e listagem têm que enxergar.
//
// ⚠️ Não confundir com ensureOpenReview: ESCRITA continua exigindo uma
// revisão 'in_progress'. Aqui é só leitura; devolver a concluída não
// reabre nada.
//
// Devolve null só quando o dojô NUNCA marcou ninguém — e aí `pending =
// plantel inteiro` está certo: é o convite inicial à revisão.
async function getCurrentReview(dojoId) {
  const open = await getOpenReview(dojoId);
  if (open) return open;
  return getLatestReview(dojoId);
}

// Qual assunção de registro trouxe este plantel (migration 275). Best-effort
// PURO: a 275 pode não estar aplicada, e um dojô pode ter chegado por outro
// caminho (claim-invite da F0) — em nenhum dos casos isso pode impedir a
// revisão de começar.
async function findAssumptionIdBestEffort(dojoId) {
  try {
    const { rows } = await db.query(
      `-- drr:assumption-lookup
       SELECT id FROM karate_dojo_registry_assumptions
        WHERE to_company_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [dojoId]
    );
    return rows.length ? rows[0].id : null;
  } catch (e) {
    if (isMissingRelation(e) || e.code === '42703') return null;
    console.warn('[karateDojoRosterReview] assunção não localizada (não bloqueia):', e.message);
    return null;
  }
}

// Cria a revisão na PRIMEIRA marcação — nunca num GET. Uma listagem não
// pode ter efeito colateral de escrita (o sensei que só abriu a tela para
// olhar não abriu revisão nenhuma).
//
// ON CONFLICT no índice único PARCIAL (dojo_id) WHERE status='in_progress':
// duas marcações simultâneas não criam duas revisões; a que perder relê.
async function ensureOpenReview(dojoId, federationId, actor) {
  const existing = await getOpenReview(dojoId);
  if (existing) return existing;

  const assumptionId = await findAssumptionIdBestEffort(dojoId);
  const { rows } = await db.query(
    `-- drr:create-review
     INSERT INTO karate_dojo_roster_reviews
       (dojo_id, federation_id, assumption_id, status, started_by, started_by_label)
     VALUES ($1, $2, $3, 'in_progress', $4, $5)
     ON CONFLICT (dojo_id) WHERE status = 'in_progress' DO NOTHING
     RETURNING ${REVIEW_COLS}`,
    [dojoId, federationId || null, assumptionId, (actor && actor.userId) || null, (actor && actor.label) || null]
  );
  if (rows.length) return shapeReview(rows[0]);
  // Perdeu a corrida: a revisão existe, foi outra requisição que a criou.
  return getOpenReview(dojoId);
}

// ── O plantel herdado ───────────────────────────────────────
// customers.dojo_id = a company do REGISTRO (sempre req.dojoId, do token).
// O LEFT JOIN traz a marcação da revisão CORRENTE (aberta ou a última
// concluída); só quando não existe revisão nenhuma a variante SEM JOIN é
// usada e todo mundo sai como 'pending'.
//
// ⚠️ DUAS SQL LITERAIS, NÃO UM BUILDER COM O MESMO ARRAY DE PARÂMETROS.
// A versão sem JOIN não cita `$3` (review_id) — e um `$n` declarado e não
// referenciado faz o Postgres estourar 42P18 ("could not determine data
// type of parameter $3"). Manter as duas listas de parâmetros separadas é
// mais longo e não tem essa armadilha.

const ROSTER_FILTERS = `AND ($4::text IS NULL OR c.name ILIKE $4 OR c.karate_registration_number ILIKE $4)
        AND ($5::text IS NULL
             OR ($5 = 'active' AND c.is_active = true)
             OR ($5 = 'inactive' AND c.is_active = false))`;

const ROSTER_FILTERS_NO_REVIEW = `AND ($3::text IS NULL OR c.name ILIKE $3 OR c.karate_registration_number ILIKE $3)
        AND ($4::text IS NULL
             OR ($4 = 'active' AND c.is_active = true)
             OR ($4 = 'inactive' AND c.is_active = false))`;

const SQL_ROSTER = `-- drr:roster
     SELECT c.id, c.name, c.karate_registration_number, c.birth_date,
            c.is_active, c.karate_photo_url,
            i.status AS review_status, i.reviewed_at,
            COUNT(*) OVER() AS total_count
       FROM customers c
       LEFT JOIN karate_dojo_roster_review_items i
              ON i.practitioner_id = c.id
             AND i.review_id = $3::uuid
      WHERE c.dojo_id = $1
        AND c.federation_id = $2
        ${ROSTER_FILTERS}
        AND ($6::text IS NULL
             OR ($6 = 'pending' AND i.status IS NULL)
             OR ($6 <> 'pending' AND i.status = $6))
      ORDER BY c.name ASC, c.id ASC
      LIMIT $7 OFFSET $8`;

const SQL_ROSTER_NO_REVIEW = `-- drr:roster-no-review
     SELECT c.id, c.name, c.karate_registration_number, c.birth_date,
            c.is_active, c.karate_photo_url,
            NULL::text AS review_status, NULL::timestamptz AS reviewed_at,
            COUNT(*) OVER() AS total_count
       FROM customers c
      WHERE c.dojo_id = $1
        AND c.federation_id = $2
        ${ROSTER_FILTERS_NO_REVIEW}
        AND ($5::text IS NULL OR $5 = 'pending')
      ORDER BY c.name ASC, c.id ASC
      LIMIT $6 OFFSET $7`;

const SQL_ROSTER_COUNT = `-- drr:roster-count
     SELECT COUNT(*)::int AS n
       FROM customers c
       LEFT JOIN karate_dojo_roster_review_items i
              ON i.practitioner_id = c.id AND i.review_id = $3::uuid
      WHERE c.dojo_id = $1
        AND c.federation_id = $2
        ${ROSTER_FILTERS}
        AND ($6::text IS NULL
             OR ($6 = 'pending' AND i.status IS NULL)
             OR ($6 <> 'pending' AND i.status = $6))`;

const SQL_ROSTER_COUNT_NO_REVIEW = `-- drr:roster-count-no-review
     SELECT COUNT(*)::int AS n
       FROM customers c
      WHERE c.dojo_id = $1
        AND c.federation_id = $2
        ${ROSTER_FILTERS_NO_REVIEW}
        AND ($5::text IS NULL OR $5 = 'pending')`;

async function listRoster(dojoId, federationId, opts = {}) {
  const paging = parsePaging(opts);
  const reviewId = opts.reviewId || null;
  const q = parseSearch(opts.q);
  const active = parseActiveFilter(opts.status);
  const reviewStatus = parseReviewStatusFilter(opts.review_status);

  const withParams = [dojoId, federationId, reviewId, q, active, reviewStatus, paging.limit, paging.offset];
  const withoutParams = [dojoId, federationId, q, active, reviewStatus, paging.limit, paging.offset];

  const run = async (withReview) => {
    const { rows } = await db.query(
      withReview ? SQL_ROSTER : SQL_ROSTER_NO_REVIEW,
      withReview ? withParams : withoutParams
    );
    return {
      data: rows.map(shapePractitioner),
      count: rows.length ? parseInt(rows[0].total_count, 10) || 0 : null,
      limit: paging.limit,
      offset: paging.offset,
    };
  };

  // Sem revisão NENHUMA não há o que juntar: vai direto na variante simples
  // (uma consulta a menos e nenhum JOIN inútil sobre 9.840 linhas).
  let withReview = !!reviewId;
  let schemaPending = false;
  let out;
  try {
    out = await run(withReview);
  } catch (e) {
    if (!withReview || !isMissingRelation(e)) throw e;
    // Migration 276 pendente: o plantel EXISTE (é customers), só a marcação
    // não. Mostrar a lista com todo mundo 'pending' é muito melhor que uma
    // tela vazia — o que não começa ainda é a revisão, não o cadastro.
    console.warn('[karateDojoRosterReview] tabelas da revisão ausentes (migration 276 pendente) — listando sem marcação');
    schemaPending = true;
    withReview = false;
    out = await run(false);
  }

  // count vem null quando a página saiu vazia (OFFSET além do fim ou filtro
  // sem resultado): COUNT(*) OVER() não tem linha onde viajar.
  if (out.count === null) {
    out.count = await countRoster(
      withReview ? withParams.slice(0, 6) : withoutParams.slice(0, 5),
      withReview
    );
  }
  if (schemaPending) out.schema_pending = true;
  return out;
}

async function countRoster(params, withReview) {
  try {
    const { rows } = await db.query(
      withReview ? SQL_ROSTER_COUNT : SQL_ROSTER_COUNT_NO_REVIEW,
      params
    );
    return rows.length ? Number(rows[0].n) : 0;
  } catch (e) {
    if (isMissingRelation(e)) return 0;
    throw e;
  }
}

// Contagens do plantel INTEIRO (independem de filtro/página) — é o que a
// barra de progresso do sensei mostra e o que a conclusão usa para decidir
// se ainda há pendente.
//
// `reviewId` é a revisão CORRENTE (aberta ou última concluída). Com a
// revisão concluída, `pending` = praticantes do plantel SEM item naquela
// revisão — normalmente 0, e > 0 quando o plantel CRESCEU depois dela.
// Isso é o comportamento desejado: quem entrou depois nunca foi revisado.
//
// reviewId null = nenhuma revisão jamais criada. Aí `pending = COUNT(*)`
// está certo (o convite inicial), e é para ESSE caso que a variante
// `-- drr:summary-no-review` existe.
async function getSummary(dojoId, federationId, reviewId, client) {
  const q = client || db;
  const runSql = (withReview) => `-- drr:summary${withReview ? '' : '-no-review'}
     SELECT COUNT(*)::int AS inherited_total,
            ${withReview ? "COUNT(*) FILTER (WHERE i.status = 'recognized')::int" : '0'} AS recognized,
            ${withReview ? "COUNT(*) FILTER (WHERE i.status = 'not_recognized')::int" : '0'} AS not_recognized,
            ${withReview ? 'COUNT(*) FILTER (WHERE i.status IS NULL)::int' : 'COUNT(*)::int'} AS pending,
            COUNT(*) FILTER (WHERE c.is_active = false)::int AS inactive_in_federation
       FROM customers c
       ${withReview ? `LEFT JOIN karate_dojo_roster_review_items i
              ON i.practitioner_id = c.id AND i.review_id = $3::uuid` : ''}
      WHERE c.dojo_id = $1 AND c.federation_id = $2`;

  const params = reviewId ? [dojoId, federationId, reviewId] : [dojoId, federationId];
  const shape = (r) => ({
    inherited_total: Number(r.inherited_total) || 0,
    recognized: Number(r.recognized) || 0,
    not_recognized: Number(r.not_recognized) || 0,
    pending: Number(r.pending) || 0,
    inactive_in_federation: Number(r.inactive_in_federation) || 0,
  });

  if (!reviewId) {
    const { rows } = await q.query(runSql(false), params);
    return rows.length ? shape(rows[0]) : shape({});
  }
  try {
    const { rows } = await q.query(runSql(true), params);
    return rows.length ? shape(rows[0]) : shape({});
  } catch (e) {
    // ⚠️ O retry só existe FORA de transação. Dentro de um BEGIN um
    // statement que falhou já envenenou a tx e o segundo estouraria 25P02
    // — ali o 42P01 tem que subir e virar 503 no handler.
    if (client || !isMissingRelation(e)) throw e;
    const { rows } = await q.query(runSql(false), [dojoId, federationId]);
    return rows.length ? shape(rows[0]) : shape({});
  }
}

// Estado da revisão para a tela: a aberta se houver, senão a última
// concluída (para o front conseguir dizer "revisado em 12/08, 41 avisos").
//
// ⚠️ O summary tem que ler A MESMA revisão que o `review` devolvido, senão
// a tela se contradiz: cabeçalho "concluída" com contador de plantel
// inteiro pendente. `review_status` vai junto, no topo, para o front
// distinguir "concluída, sem pendências" de "em andamento" sem ter que
// cavar dentro de `review`.
async function getReviewState(dojoId, federationId) {
  try {
    const review = await getCurrentReview(dojoId);
    const summary = await getSummary(dojoId, federationId, review ? review.id : null);
    return {
      review,
      review_status: review ? review.status : null,
      summary,
      schema_pending: false,
    };
  } catch (e) {
    if (!isMissingRelation(e)) throw e;
    const summary = await getSummary(dojoId, federationId, null);
    return { review: null, review_status: null, summary, schema_pending: true };
  }
}

// ── Marcação em LOTE ────────────────────────────────────────
// status: 'recognized' | 'not_recognized' | 'pending'
//   'pending' é o DESMARCAR — apaga a linha do item e devolve o praticante
//   ao estado "ainda não revisado". Errar um clique não pode ser
//   irreversível, e a revisão não é tudo-ou-nada numa sessão.
//
// Escopo: os ids são recortados contra customers do dojo_id DO TOKEN antes
// de qualquer escrita. Id de praticante de outro dojô volta em `skipped`,
// nunca escreve — e nunca vira 500.
async function markBatch(dojoId, federationId, { practitionerIds, status }, actor) {
  const ids = parsePractitionerIds(practitionerIds);
  const target = status != null ? String(status).trim() : '';
  if (target !== 'pending' && !ITEM_STATUSES.includes(target)) {
    throw svcError(
      422,
      'VALIDATION_ERROR',
      "Campo status deve ser 'recognized', 'not_recognized' ou 'pending' (desmarcar)"
    );
  }

  const scoped = await scopeIds(dojoId, federationId, ids);
  const skipped = ids.filter((id) => !scoped.includes(id));

  // Nenhum id do lote pertence a este dojô: nada a marcar e — importante —
  // nenhuma revisão a abrir. Um corpo com ids alheios não pode ter como
  // efeito colateral iniciar a revisão do plantel de quem mandou.
  // O summary devolvido aqui é de LEITURA: revisão corrente, não só a
  // aberta (senão devolver 0 marcado zeraria o contador da tela).
  if (!scoped.length) {
    const current = await getCurrentReview(dojoId);
    return {
      review: current,
      status: target,
      marked: 0,
      skipped,
      skipped_count: skipped.length,
      summary: await getSummary(dojoId, federationId, current ? current.id : null),
    };
  }

  // UMA resolução de nome por requisição, antes do lote — não uma por
  // praticante (o lote vai a 500).
  const resolvedActor = await resolveActor(actor);

  const review = await ensureOpenReview(dojoId, federationId, resolvedActor);
  if (!review) {
    throw svcError(500, 'REVIEW_UNAVAILABLE', 'Não foi possível abrir a revisão do plantel');
  }
  if (review.status !== 'in_progress') {
    throw svcError(409, 'REVISAO_JA_CONCLUIDA', 'Esta revisão já foi concluída');
  }

  let changed = 0;
  if (scoped.length) {
    if (target === 'pending') {
      const { rows } = await db.query(
        `-- drr:unmark
         DELETE FROM karate_dojo_roster_review_items
          WHERE review_id = $1 AND dojo_id = $2 AND practitioner_id = ANY($3::uuid[])
         RETURNING practitioner_id`,
        [review.id, dojoId, scoped]
      );
      changed = rows.length;
    } else {
      // IDEMPOTENTE: reenviar a mesma marcação faz DO UPDATE, nunca uma
      // segunda linha (índice único (review_id, practitioner_id)).
      const { rows } = await db.query(
        `-- drr:mark
         INSERT INTO karate_dojo_roster_review_items
           (review_id, dojo_id, practitioner_id, status, reviewed_by, reviewed_by_label)
         SELECT $1, $2, x, $4, $5, $6 FROM unnest($3::uuid[]) AS x
         ON CONFLICT (review_id, practitioner_id) DO UPDATE
            SET status = EXCLUDED.status,
                reviewed_by = EXCLUDED.reviewed_by,
                reviewed_by_label = EXCLUDED.reviewed_by_label,
                reviewed_at = now()
         RETURNING practitioner_id`,
        [review.id, dojoId, scoped, target, resolvedActor.userId, resolvedActor.label]
      );
      changed = rows.length;
    }
  }

  const summary = await getSummary(dojoId, federationId, review.id);
  return {
    review,
    status: target,
    marked: changed,
    skipped,
    skipped_count: skipped.length,
    summary,
  };
}

async function scopeIds(dojoId, federationId, ids) {
  const { rows } = await db.query(
    `-- drr:scope-ids
     SELECT c.id
       FROM customers c
      WHERE c.dojo_id = $1 AND c.federation_id = $2 AND c.id = ANY($3::uuid[])`,
    [dojoId, federationId, ids]
  );
  return rows.map((r) => r.id);
}

// ── Concluir a revisão ──────────────────────────────────────
// pendingPolicy:
//   null (default) → se ainda houver praticante NÃO REVISADO, 409
//     REVISAO_INCOMPLETA com os números. NUNCA assume nada em silêncio:
//     "não revisado" e "não reconhecido" são estados diferentes, e
//     transformar um no outro por omissão é exatamente o erro que este PR
//     existe para não cometer.
//   'not_recognized' → o sensei declara, num clique, que o resto do
//     plantel não é dele. É o caminho de lote que evita 300 cliques — mas
//     é uma ESCOLHA explícita dele, não o default.
//   'recognized'     → o oposto (ele confirma o resto em bloco).
//
// Tudo numa transação: preencher o resto, gerar os avisos e fechar o
// cabeçalho. A trilha em karate_dojo_roster_events é best-effort e vive
// dentro de SAVEPOINT (try/catch nu dentro de BEGIN envenena a transação).
async function completeReview(dojoId, federationId, { pendingPolicy } = {}, actor) {
  const policy = pendingPolicy != null ? String(pendingPolicy).trim() : '';
  if (policy && !PENDING_POLICIES.includes(policy)) {
    throw svcError(
      422,
      'VALIDATION_ERROR',
      "Campo pending_policy deve ser 'not_recognized' ou 'recognized'"
    );
  }

  // FORA da transação, de propósito: o SELECT em users usa o pool e não
  // tem nada que fazer dentro do BEGIN que trava a revisão.
  const resolvedActor = await resolveActor(actor);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: locked } = await client.query(
      `-- drr:lock-review
       SELECT ${REVIEW_COLS}
         FROM karate_dojo_roster_reviews
        WHERE dojo_id = $1 AND status = 'in_progress'
        FOR UPDATE`,
      [dojoId]
    );
    if (!locked.length) {
      await client.query('ROLLBACK');
      throw svcError(
        409,
        'REVISAO_NAO_INICIADA',
        'Não há revisão em andamento para este dojô. Marque ao menos um praticante antes de concluir.'
      );
    }
    const review = shapeReview(locked[0]);

    const before = await getSummary(dojoId, federationId, review.id, client);
    if (before.pending > 0 && !policy) {
      await client.query('ROLLBACK');
      throw svcError(
        409,
        'REVISAO_INCOMPLETA',
        `Ainda há ${before.pending} praticante(s) sem marcação. Marque-os ou envie pending_policy para decidir o que fazer com o restante.`,
        { summary: before }
      );
    }

    if (before.pending > 0 && policy) {
      await client.query(
        `-- drr:fill-pending
         INSERT INTO karate_dojo_roster_review_items
           (review_id, dojo_id, practitioner_id, status, reviewed_by, reviewed_by_label)
         SELECT $1, $2, c.id, $4, $5, $6
           FROM customers c
           LEFT JOIN karate_dojo_roster_review_items i
                  ON i.practitioner_id = c.id AND i.review_id = $1
          WHERE c.dojo_id = $2 AND c.federation_id = $3 AND i.id IS NULL
         ON CONFLICT (review_id, practitioner_id) DO NOTHING`,
        [review.id, dojoId, federationId, policy, resolvedActor.userId, resolvedActor.label]
      );
    }

    // ⚠️ O ÚNICO efeito da conclusão sobre a federação. Repare no que NÃO
    // está aqui: nenhum UPDATE em customers, nenhum is_active, nenhum
    // dojo_id. O aviso comunica um fato; a decisão é da federação.
    // ON CONFLICT DO NOTHING = concluir duas vezes não duplica aviso.
    const { rows: noticeRows } = await client.query(
      `-- drr:notices-generate
       INSERT INTO karate_dojo_roster_review_notices
         (review_id, dojo_id, federation_id, practitioner_id,
          practitioner_name, practitioner_fpkt_number, practitioner_was_active,
          reason, reported_by, reported_by_label)
       SELECT i.review_id, i.dojo_id, $3, i.practitioner_id,
              c.name, c.karate_registration_number, c.is_active,
              'nao_reconhecido_pelo_sensei', $4, $5
         FROM karate_dojo_roster_review_items i
         JOIN customers c ON c.id = i.practitioner_id
        WHERE i.review_id = $1 AND i.dojo_id = $2 AND i.status = 'not_recognized'
       ON CONFLICT (review_id, practitioner_id) DO NOTHING
       RETURNING id`,
      [review.id, dojoId, federationId || null, resolvedActor.userId, resolvedActor.label]
    );
    const noticesCreated = noticeRows.length;

    const after = await getSummary(dojoId, federationId, review.id, client);

    const { rows: closed } = await client.query(
      `-- drr:complete
       UPDATE karate_dojo_roster_reviews
          SET status = 'completed',
              completed_at = now(),
              completed_by = $2,
              completed_by_label = $3,
              inherited_total = $4,
              recognized_count = $5,
              not_recognized_count = $6,
              notices_created = $7,
              updated_at = now()
        WHERE id = $1 AND status = 'in_progress'
       RETURNING ${REVIEW_COLS}`,
      [
        review.id,
        resolvedActor.userId,
        resolvedActor.label,
        after.inherited_total,
        after.recognized,
        after.not_recognized,
        noticesCreated,
      ]
    );
    if (!closed.length) {
      await client.query('ROLLBACK');
      throw svcError(409, 'REVISAO_JA_CONCLUIDA', 'Esta revisão já foi concluída');
    }

    await logRosterEventBestEffort(client, {
      dojoId,
      federationId,
      event: 'dojo_roster_review_completed',
      affected: [{
        review_id: review.id,
        inherited_total: after.inherited_total,
        recognized: after.recognized,
        not_recognized: after.not_recognized,
        notices_created: noticesCreated,
        pending_policy: policy || null,
      }],
      actorId: resolvedActor.userId,
    });

    await client.query('COMMIT');

    return {
      review: shapeReview(closed[0]),
      summary: after,
      notices_created: noticesCreated,
      // O contrato em uma linha, para quem lê a resposta e não o código:
      // avisamos; não inativamos.
      practitioners_changed: false,
    };
  } catch (e) {
    if (!e || !e.status) {
      try { await client.query('ROLLBACK'); } catch (_) { /* já rolou */ }
    }
    throw e;
  } finally {
    client.release();
  }
}

// SAVEPOINT, nunca try/catch nu dentro de BEGIN (tx-poison): a trilha é
// best-effort e não pode derrubar a conclusão da revisão.
async function logRosterEventBestEffort(client, { dojoId, federationId, event, affected, actorId }) {
  await client.query('SAVEPOINT sp_roster_review_event');
  try {
    await client.query(
      `-- drr:roster-event
       INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [dojoId, federationId || null, event, JSON.stringify(affected), actorId || null]
    );
    await client.query('RELEASE SAVEPOINT sp_roster_review_event');
  } catch (e) {
    if (isMissingRelation(e)) {
      await client.query('ROLLBACK TO SAVEPOINT sp_roster_review_event');
      await client.query('RELEASE SAVEPOINT sp_roster_review_event');
      console.warn('[karateDojoRosterReview] karate_dojo_roster_events ausente (não bloqueia)');
      return;
    }
    throw e;
  }
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_BATCH,
  ITEM_STATUSES,
  PENDING_POLICIES,
  svcError,
  isMissingRelation,
  parsePaging,
  parseActiveFilter,
  parseReviewStatusFilter,
  parseSearch,
  parsePractitionerIds,
  resolveActor,
  getOpenReview,
  getLatestReview,
  getCurrentReview,
  ensureOpenReview,
  listRoster,
  getSummary,
  getReviewState,
  markBatch,
  completeReview,
  logRosterEventBestEffort,
  shapeReview,
};
