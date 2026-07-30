// ============================================================
// AURA DOJÔ — F7.3-A: GUARDA ÚNICA DE ESCRITA DA IDENTIDADE
//
// A DECISÃO (Caio, 30/07/2026):
//   "A federação não faz gestão de informação. O trabalho dela é apenas
//    receber a sincronização dos dados gerenciados pelos dojôs."
//
// A REGRA, EM UMA FRASE
//   Ficha com customers.karate_identity_managed_by = 'dojo' não aceita
//   escrita de CAMPO DE IDENTIDADE por nenhum canal da federação — só
//   pelo dojô que a mantém (via adoção F7.1 / sync F7.2) — e a recusa diz
//   QUAL dojô mantém aquela ficha.
//
// ── O BURACO QUE ESTE ARQUIVO FECHA ─────────────────────────
// A F7.1 (adoção) e a F7.2 (sync contínuo) fazem o dado SUBIR. Nenhuma
// das duas impede a federação de continuar sobrescrevendo por baixo — e
// são vários canais, dois deles SEM LOGIN (token no link):
//
//   ficha da federação ...... PATCH /federation/:id/practitioners/:pid
//   portal do sensei ........ PATCH /public/roster-update/:token/...
//   import do portal ........ POST  /public/roster-update/:token/import
//   auto-atendimento ........ POST  /public/roster-self/:token/update
//   motor de sync legado .... services/karateApplyEvent.upsertPractitioner
//
// Enquanto isso valia, o sensei editava, o sync subia, e no dia seguinte
// alguém sobrescrevia pelo link público. O conflito que a fase inteira
// veio matar voltava sozinho.
//
// ── POR QUE UM MÓDULO, E NÃO UM CHECK EM CADA ROTA ──────────
// São cinco caminhos de escrita com cinco vocabulários de campo
// diferentes (FIELD_COL, PORTAL_EDITABLE_FIELDS,
// SELF_SERVICE_EDITABLE_FIELDS, o COALESCE do motor legado). Cinco
// cópias da mesma regra são cinco regras diferentes em duas semanas —
// é o mesmo argumento que fez a F7.2 importar IDENTITY_FIELDS em vez de
// copiar. Aqui a lista de colunas protegidas é DERIVADA de
// IDENTITY_FIELDS (karateStudentIdentityLink.js): o que o dojô
// sincroniza é exatamente o que a federação deixa de escrever. Se um
// campo entrar naquela lista, ele passa a ser protegido aqui no mesmo
// commit, sem ninguém lembrar de nada.
//
// ── POR QUE NÃO GATILHO NO BANCO ────────────────────────────
// Mesmo motivo já escrito na F7.2: a mensagem tem que dizer o NOME do
// dojô e o que fazer, o override depende de QUEM está pedindo (o banco
// não tem o token), e um RAISE EXCEPTION viraria 500 genérico em vez de
// 409 legível. Além disso o gatilho dispararia contra a própria adoção e
// contra o sync, que são escritas legítimas.
//
// ── O QUE CONTINUA LIVRE PARA A FEDERAÇÃO, SEMPRE ───────────
// Matrícula FPKT, papéis federativos (is_arbiter/is_instructor/
// is_examiner/is_assistant/is_student), is_active, dojo_id,
// parent_guardian_id, graduações/certificados/anuidade. A federação não
// perde nada do que ela EMITE — perde só o direito de reescrever a
// PESSOA. FEDERATION_ALWAYS_ALLOWED abaixo é conferida contra a lista
// protegida no carregamento do módulo: se as duas listas um dia se
// cruzarem, o require estoura no boot em vez de a matrícula de alguém
// virar campo bloqueado em produção.
//
// ── guardian_* NÃO É BLOQUEADO (decisão consciente) ─────────
// guardian_name/guardian_cpf/guardian_phone/guardian_relationship
// descrevem a pessoa, mas NÃO estão em IDENTITY_FIELDS: o dojô não os
// sincroniza hoje. Bloquear um campo que o dojô não consegue escrever
// seria congelar o dado — ninguém poderia mais corrigi-lo. Bloqueia-se
// exatamente o que o dojô consegue manter. Entra na F8 junto com a
// entrada desses campos no sync (ver corpo do PR).
//
// ── DEFENSIVO A SCHEMA (42703 / 42P01) ──────────────────────
// Sem a migration 262 não existe karate_identity_managed_by — e também
// não existe ficha adotada. A sonda degrada para "federação gerencia"
// (libera), que é o comportamento correto naquele estado. Dentro de
// transação a leitura roda em SAVEPOINT: um 42703 aqui não pode
// envenenar a transação do chamador (armadilha tx-poison).
// ============================================================
'use strict';

const { IDENTITY_FIELDS, writeIdentityAudit } = require('./karateStudentIdentityLink');
const { FEDERATION_OWNED_COLS } = require('./karateIdentitySync');

// ── Canais ──────────────────────────────────────────────────
// O canal decide DUAS coisas: o texto da recusa (quem está lendo é o
// staff da federação ou o pai de um aluno de 8 anos?) e se o override
// sequer existe. Token NÃO é credencial de staff: os dois canais
// públicos têm canOverride:false por definição, não por configuração.
const CHANNELS = Object.freeze({
  FEDERATION_ADMIN: 'federation_admin', // ficha da federação (staffWrite)
  DOJO_PORTAL: 'dojo_portal',           // portal do sensei (token, SEM login)
  SELF_SERVICE: 'self_service',         // auto-atendimento (token, SEM login)
  SYNC_ENGINE: 'sync_engine',           // motor de sync legado (applyEvent)
});

const PUBLIC_CHANNELS = Object.freeze([CHANNELS.DOJO_PORTAL, CHANNELS.SELF_SERVICE]);

// ── As colunas protegidas ───────────────────────────────────
// DERIVADAS de IDENTITY_FIELDS — nunca digitadas de novo.
// photo_url entra à parte: ficou DEPRECADA por COMMENT na 262 (não foi
// dropada) e a leitura da foto é COALESCE(karate_photo_url, photo_url)
// nos dois lados. Deixá-la de fora seria manter uma porta lateral para
// a mesma informação.
const IDENTITY_LABEL_BY_COL = Object.freeze(
  IDENTITY_FIELDS.reduce(
    (acc, f) => { acc[f.fedCol] = f.label; return acc; },
    { photo_url: 'Foto (coluna legada)' }
  )
);

const IDENTITY_COLS = Object.freeze(Object.keys(IDENTITY_LABEL_BY_COL));

// O que a federação escreve SEMPRE, em qualquer ficha. Não é usada para
// montar SQL: existe para a proteção ser EXECUTADA (assertGuardListsAreDisjoint)
// e para o teste conseguir asseverar a promessa do PR.
const FEDERATION_ALWAYS_ALLOWED = Object.freeze([
  'karate_registration_number',
  'is_active',
  'is_student',
  'is_arbiter',
  'is_instructor',
  'is_examiner',
  'is_assistant',
  'dojo_id',
  'federation_id',
  'parent_guardian_id',
  'affiliation_since',
  'guardian_name',
  'guardian_cpf',
  'guardian_phone',
  'guardian_relationship',
  'karate_identity_managed_by',
  'karate_identity_dojo_id',
]);

// Guarda de carregamento: se um campo da federação virar campo de
// identidade (ou vice-versa), o require estoura no boot e no primeiro
// teste — em vez de a matrícula de alguém virar 409 em produção.
function assertGuardListsAreDisjoint() {
  const clash = IDENTITY_COLS.filter((c) => FEDERATION_ALWAYS_ALLOWED.includes(c) || FEDERATION_OWNED_COLS.includes(c));
  if (clash.length) {
    throw new Error(
      `[karateIdentityWriteGuard] coluna em DUAS listas ao mesmo tempo: ${clash.join(', ')}. ` +
      'O dojô é dono da identidade da pessoa; a federação é dona do que ela EMITE. Reveja IDENTITY_FIELDS.'
    );
  }
}
assertGuardListsAreDisjoint();

// ── Contrato do override (ato explícito, nunca padrão) ──────
// Duas chaves, as duas obrigatórias juntas. Sem motivo não há override:
// "corrigi porque sim" não é uma linha de trilha que responda a alguém
// seis meses depois.
const OVERRIDE_FLAG_KEY = 'federation_identity_override';
const OVERRIDE_REASON_KEY = 'identity_override_reason';
const OVERRIDE_BODY_KEYS = Object.freeze([OVERRIDE_FLAG_KEY, OVERRIDE_REASON_KEY]);
const OVERRIDE_REASON_MIN = 5;

const CODE_BLOCKED = 'IDENTITY_MANAGED_BY_DOJO';
const CODE_OVERRIDE_FORBIDDEN = 'IDENTITY_OVERRIDE_NOT_ALLOWED';
const CODE_OVERRIDE_REASON = 'IDENTITY_OVERRIDE_REASON_REQUIRED';

function guardError(status, code, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  e.identityGuard = true;
  if (extra) Object.assign(e, extra);
  return e;
}

function isIdentityGuardError(e) {
  return !!(e && e.identityGuard);
}

// Corpo pronto para `res.status(err.status).json(identityGuardBody(err))`.
// Um formato só nos quatro canais: a tela da F7.3-B lê `identity_dojo`
// para entrar em modo leitura e não precisa saber por qual rota passou.
function identityGuardBody(e) {
  return {
    error: e.message,
    code: e.code,
    identity_managed_by: e.identity_managed_by || 'dojo',
    identity_dojo: e.identity_dojo || null,
    blocked_fields: e.blocked_fields || [],
  };
}

// ============================================================
// LEITURA DE QUEM MANTÉM A FICHA
// ============================================================
const OWNER_SQL = `
  SELECT c.id,
         c.name AS practitioner_label,
         c.karate_registration_number AS fpkt_number,
         c.federation_id,
         c.karate_identity_managed_by,
         c.karate_identity_dojo_id,
         COALESCE(d.trade_name, d.legal_name) AS identity_dojo_name
    FROM customers c
    LEFT JOIN companies d ON d.id = c.karate_identity_dojo_id
   WHERE c.id = $1
   LIMIT 1`;

const SCHEMA_PENDING_OWNER = Object.freeze({
  found: false,
  managedBy: 'federation',
  dojo: null,
  schemaPending: true,
});

// `runner` é db (fora de transação) ou o client de uma transação já
// aberta. Com savepoint:true a leitura fica isolada: 42703 (migration 262
// pendente) não envenena a transação de quem chamou.
async function loadIdentityOwner(runner, practitionerId, opts = {}) {
  if (!practitionerId) return { found: false, managedBy: 'federation', dojo: null, schemaPending: false };
  const useSavepoint = !!opts.savepoint;

  if (useSavepoint) await runner.query('SAVEPOINT sp_identity_guard');
  try {
    const { rows } = await runner.query(OWNER_SQL, [practitionerId]);
    if (useSavepoint) await runner.query('RELEASE SAVEPOINT sp_identity_guard');
    if (!rows.length) return { found: false, managedBy: 'federation', dojo: null, schemaPending: false };
    return normalizeOwnerRow(rows[0]);
  } catch (e) {
    if (useSavepoint) {
      try { await runner.query('ROLLBACK TO SAVEPOINT sp_identity_guard'); } catch (_) { /* conexão pode ter caído */ }
    }
    if (e && (e.code === '42703' || e.code === '42P01')) {
      // Sem a 262 não existe ficha adotada: liberar é o comportamento
      // certo, não uma degradação preguiçosa.
      console.warn('[karateIdentityWriteGuard] schema de identidade pendente (262) — liberando escrita:', e.code);
      return SCHEMA_PENDING_OWNER;
    }
    throw e;
  }
}

// Aceita tanto a linha do OWNER_SQL quanto qualquer SELECT do chamador
// que já traga as colunas (o auto-atendimento, por exemplo, reusa o
// SELECT que ele JÁ faz com o 2º fator de identidade no WHERE — assim o
// guarda nunca responde sobre uma ficha cuja identidade não foi provada).
function normalizeOwnerRow(row) {
  if (!row) return { found: false, managedBy: 'federation', dojo: null, schemaPending: false };
  const managedBy = row.karate_identity_managed_by === 'dojo' ? 'dojo' : 'federation';
  return {
    found: true,
    practitionerId: row.id || null,
    practitionerLabel: row.practitioner_label || row.name || null,
    fpktNumber: row.fpkt_number || row.karate_registration_number || null,
    federationId: row.federation_id || null,
    managedBy,
    dojo: managedBy === 'dojo' && row.karate_identity_dojo_id
      ? { id: row.karate_identity_dojo_id, name: row.identity_dojo_name || null }
      : null,
    schemaPending: false,
  };
}

// ============================================================
// AS COLUNAS DE IDENTIDADE DE UMA ESCRITA
// ============================================================
// `columns` são nomes de coluna de customers vindos do mapa de campos do
// próprio canal (FIELD_COL, PORTAL_EDITABLE_FIELDS, …) — nunca do corpo
// da requisição. Nada aqui vira SQL.
function identityColumnsIn(columns) {
  const seen = new Set();
  const out = [];
  for (const col of columns || []) {
    if (!IDENTITY_LABEL_BY_COL[col] || seen.has(col)) continue;
    seen.add(col);
    out.push({ col, label: IDENTITY_LABEL_BY_COL[col] });
  }
  return out;
}

function labelList(blocked) {
  return blocked.map((b) => b.label).join(', ');
}

function dojoName(owner) {
  return (owner.dojo && owner.dojo.name) || 'o dojô que mantém esta ficha';
}

function blockedMessage(channel, owner, blocked) {
  const who = dojoName(owner);
  const quem = owner.practitionerLabel ? `de ${owner.practitionerLabel}` : 'deste praticante';

  if (PUBLIC_CHANNELS.includes(channel)) {
    // Quem lê isto é sensei ou praticante, não staff. Nada de jargão de
    // coluna e nada de "peça override": este link não tem override.
    return (
      `A ficha ${quem} é mantida pelo dojô ${who}, no sistema do próprio dojô. ` +
      `Por aqui não dá para alterar ${labelList(blocked)} — fale com o dojô ${who} para corrigir, ` +
      'que a alteração sobe sozinha para a federação.'
    );
  }

  return (
    `A ficha ${quem} é mantida pelo dojô ${who} (identidade adotada). ` +
    `A federação não reescreve dados pessoais de ficha adotada: ${labelList(blocked)}. ` +
    'Peça a correção ao dojô (ela sobe sozinha), ou, em caso excepcional, repita a requisição com ' +
    `${OVERRIDE_FLAG_KEY}:true e ${OVERRIDE_REASON_KEY} — o override fica registrado na trilha da ficha. ` +
    'Matrícula, papéis federativos, situação, dojô e graduações continuam editáveis normalmente.'
  );
}

// ── Leitura do pedido de override ───────────────────────────
// Vale para QUALQUER canal: o auto-atendimento também passa por aqui,
// justamente para que a tentativa seja RECUSADA em vez de ignorada.
function readOverrideRequest(body) {
  const b = body && typeof body === 'object' ? body : {};
  const requested = b[OVERRIDE_FLAG_KEY] === true || b[OVERRIDE_FLAG_KEY] === 'true';
  const reason = b[OVERRIDE_REASON_KEY] == null ? '' : String(b[OVERRIDE_REASON_KEY]).trim();
  return { requested, reason };
}

// ============================================================
// O GUARDA
// ============================================================
// Uso:
//   const guard = await assertIdentityWriteAllowed({
//     runner: db,                 // ou o client da transação
//     savepoint: false,           // true quando runner é client em BEGIN
//     practitionerId,
//     columns: ['name', 'cpf_cnpj'],
//     channel: CHANNELS.FEDERATION_ADMIN,
//     canOverride: true,          // só em canal com staffWrite
//     body: req.body,
//     owner,                      // opcional: linha já lida pelo chamador
//   });
//   if (guard.overridden) { /* grave e CHAME writeOverrideAudit na MESMA tx */ }
//
// Lança (com .status/.code/.identityGuard) quando a escrita é recusada.
async function assertIdentityWriteAllowed({
  runner = null,
  savepoint = false,
  practitionerId = null,
  columns = [],
  channel = CHANNELS.FEDERATION_ADMIN,
  canOverride = false,
  body = null,
  owner = null,
  actor = null,
} = {}) {
  const blocked = identityColumnsIn(columns);
  const request = readOverrideRequest(body);

  // Override pedido num canal sem staffWrite é RECUSA EXPLÍCITA, mesmo
  // que a ficha nem seja adotada — quem tentou precisa saber que essa
  // porta não existe, em vez de achar que funcionou porque a ficha era
  // da federação. Token não é credencial de staff.
  if (request.requested && !canOverride) {
    throw guardError(
      403,
      CODE_OVERRIDE_FORBIDDEN,
      'Este link não pode forçar alteração de ficha mantida por dojô. ' +
      'Fale com o dojô responsável pela ficha — a correção feita lá sobe sozinha para a federação.',
      { blocked_fields: blocked.map((b) => b.col) }
    );
  }

  // Nenhum campo de identidade na escrita → nada a decidir. Matrícula,
  // papéis, situação e dojô passam por aqui sem custo e sem query.
  if (!blocked.length) {
    return { blocked: false, overridden: false, managedBy: null, dojo: null, columns: [], schemaPending: false };
  }

  const resolved = owner
    ? normalizeOwnerRow(owner)
    : await loadIdentityOwner(runner, practitionerId, { savepoint });

  if (resolved.managedBy !== 'dojo') {
    // Ficha da federação: segue EXATAMENTE como sempre foi. Este é o
    // caminho de 9.783 dos 9.783 praticantes de hoje.
    return {
      blocked: false,
      overridden: false,
      managedBy: 'federation',
      dojo: null,
      columns: blocked.map((b) => b.col),
      schemaPending: !!resolved.schemaPending,
      owner: resolved,
    };
  }

  if (!request.requested) {
    throw guardError(409, CODE_BLOCKED, blockedMessage(channel, resolved, blocked), {
      identity_managed_by: 'dojo',
      identity_dojo: resolved.dojo,
      blocked_fields: blocked.map((b) => b.col),
    });
  }

  if (request.reason.length < OVERRIDE_REASON_MIN) {
    throw guardError(
      422,
      CODE_OVERRIDE_REASON,
      `Para sobrescrever a ficha mantida pelo dojô ${dojoName(resolved)} é obrigatório informar ` +
      `${OVERRIDE_REASON_KEY} (o motivo fica registrado na trilha da ficha, junto com o antes e o depois de cada campo).`,
      { identity_managed_by: 'dojo', identity_dojo: resolved.dojo, blocked_fields: blocked.map((b) => b.col) }
    );
  }

  return {
    blocked: false,
    overridden: true,
    managedBy: 'dojo',
    dojo: resolved.dojo,
    columns: blocked.map((b) => b.col),
    reason: request.reason,
    actor: actor || null,
    owner: resolved,
    schemaPending: false,
  };
}

// ============================================================
// TRILHA DO OVERRIDE — "se não for registrado, ele não acontece"
// ============================================================
// Recebe o `client` de uma transação ABERTA e roda na MESMA transação do
// UPDATE. writeIdentityAudit já lança quando NENHUMA trilha pôde ser
// gravada (nem karate_identity_audit, nem o fallback roster_events); o
// chamador deve deixar esse erro subir para o ROLLBACK. É isso que torna
// a frase do PR verdadeira: override sem rastro não commita.
//
// action='sync' + source='federation_admin' (e não um `action` novo) é
// deliberado: o CHECK da 263 fecha action em (adopt|release|sync) e um
// valor fora dele viraria 23514 — a trilha se perderia e, pela regra
// acima, o override inteiro seria descartado. `source` já tem
// 'federation_admin' no CHECK justamente para ser o discriminador. Zero
// DDL nesta onda (a 264 continua livre).
async function writeOverrideAudit(client, {
  federationId = null,
  practitionerId,
  practitionerLabel = null,
  fpktNumber = null,
  dojoId = null,
  changes = [],
  reason = null,
  actor = null,
} = {}) {
  return writeIdentityAudit(client, { hasIdentityAudit: true }, {
    federationId,
    dojoId,
    practitionerId,
    practitionerLabel,
    fpktNumber,
    studentId: null,
    studentLabel: null,
    action: 'sync',
    source: 'federation_admin',
    changes: [
      {
        field: OVERRIDE_FLAG_KEY,
        label: 'Override da federação sobre ficha adotada',
        winner: 'federation',
        reason: reason || null,
      },
      ...changes,
    ],
    actorUserId: actor && actor.userId,
    actorLabel: actor && actor.label,
  });
}

// Monta a lista de mudanças (antes/depois por campo) a partir da linha
// ANTERIOR e dos valores que vão ser gravados. Só entram os campos que
// realmente mudam — aplicar valor idêntico não é evento (regra da 263).
function buildOverrideChanges(beforeRow, writes) {
  const out = [];
  for (const w of writes || []) {
    const label = IDENTITY_LABEL_BY_COL[w.col];
    if (!label) continue;
    const before = beforeRow ? beforeRow[w.col] : undefined;
    const after = w.value;
    const same = String(before == null ? '' : before) === String(after == null ? '' : after);
    if (same) continue;
    out.push({
      field: w.col,
      label,
      winner: 'federation',
      federation_before: before === undefined ? null : before,
      federation_after: after === undefined ? null : after,
    });
  }
  return out;
}

// Contrato de LEITURA para a UI (F7.3-B entra em modo leitura com isto).
// Uma função só para os GETs não inventarem três formatos diferentes.
function identityOwnershipPayload(row) {
  const o = normalizeOwnerRow(row);
  return {
    identity_managed_by: o.managedBy,
    identity_dojo: o.dojo,
  };
}

module.exports = {
  CHANNELS,
  PUBLIC_CHANNELS,
  IDENTITY_COLS,
  IDENTITY_LABEL_BY_COL,
  FEDERATION_ALWAYS_ALLOWED,
  OVERRIDE_FLAG_KEY,
  OVERRIDE_REASON_KEY,
  OVERRIDE_BODY_KEYS,
  CODE_BLOCKED,
  CODE_OVERRIDE_FORBIDDEN,
  CODE_OVERRIDE_REASON,
  OWNER_SQL,
  assertIdentityWriteAllowed,
  loadIdentityOwner,
  normalizeOwnerRow,
  identityColumnsIn,
  readOverrideRequest,
  writeOverrideAudit,
  buildOverrideChanges,
  identityOwnershipPayload,
  identityGuardBody,
  isIdentityGuardError,
  assertGuardListsAreDisjoint,
};
