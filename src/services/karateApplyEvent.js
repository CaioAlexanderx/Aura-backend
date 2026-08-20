// ============================================================
// AURA KARATÊ — Track K: Motor de APLICAÇÃO de eventos de sync (applyEvent)
//
// É o LADO CONSUMIDOR da fila criada na Track F. O dojô (produtor "Aura
// Karatê Dojô", a construir) empilha eventos no webhook → karate_sync_events
// (status 'pending'). Aqui a federação APLICA esses eventos aos seus dados,
// de forma IDEMPOTENTE, por tipo:
//
//   • practitioner_added → upsert do praticante (customers) do dojô
//   • attendance         → registra frequência (karate_attendance)
//   • annuity_paid       → concilia a anuidade do dojô (karate_dojo_annuity_history)
//
// ------------------------------------------------------------
// CONTRATO DO EVENTO (karate_sync_events.payload por event_type)
// Direction sempre 'dojo_to_fed'. O produtor DEVE enviar um `event_uid`
// estável (idealmente um UUID/ULID gerado UMA vez no dojô por fato de
// negócio) — é a base da deduplicação. Na falta dele, derivamos uma chave
// natural por tipo (ver buildDedupeKey).
//
//   practitioner_added:
//     {
//       event_uid?:   string,   // id estável do evento no dojô (recomendado)
//       external_id?: string,   // id do praticante no sistema do dojô
//       full_name:    string,   // OBRIGATÓRIO
//       cpf?:         string,   // chave natural de match dentro da federação
//       rg?, birth_date?, email?, phone?: string,
//       belt_level?:  string|number,
//       belt_name?:   string
//     }
//
//   attendance:
//     {
//       event_uid?:              string,
//       practitioner_external_id?: string, // ou cpf, p/ resolver o praticante
//       cpf?:                    string,
//       session_date:            'YYYY-MM-DD',  // OBRIGATÓRIO
//       present?:                boolean,       // default true
//       class_label?:            string
//     }
//
//   annuity_paid:
//     {
//       event_uid?:        string,
//       reference_period:  string,  // ex '2026' — OBRIGATÓRIO
//       amount?:           number,
//       paid_at?:          'YYYY-MM-DD' | ISO
//     }
//
// Tipos fora desses três (handshake, exam_*, card_issued, transfer,
// tournament_entry, …) são RECONHECIDOS e ESTACIONADOS (ack/parked): o
// motor os drena sem mutação para não travar a fila — entram na trilha
// applied como kind='parked' (a aplicação real chega em tracks futuras).
//
// ------------------------------------------------------------
// IDEMPOTÊNCIA (propriedade central)
// Cada evento aplica NO MÁXIMO uma vez, mesmo sob replay/re-entrega (o
// webhook cria uma NOVA linha karate_sync_events a cada POST, então o
// status por-linha NÃO basta — precisamos de dedupe por CONTEÚDO).
//
//   • buildDedupeKey(ev) → string estável a partir de
//       (federation_id, dojo_id, event_type, external_id-do-fato).
//   • karate_sync_applied (migration 179) tem UNIQUE(dedupe_key).
//   • applyEvent INSERE a chave com ON CONFLICT DO NOTHING ANTES de mutar,
//     dentro da MESMA transação do chamador. Se o INSERT não pegar a linha
//     (conflito), o evento já foi aplicado → no-op idempotente.
//
// DEFENSIVO: toda leitura/escrita de tabela nova trata 42P01/42703 para o
// PR ser seguro de mergear ANTES da migration 179 ser aplicada (o backend
// não roda migrations no boot). Nesse estado, applyEvent devolve um
// resultado 'deferred' (não-fatal) e o evento permanece 'pending'.
//
// ------------------------------------------------------------
// 30/07/2026 — F7.3-A: ESTE MOTOR RESPEITA O MARCADOR DA FICHA
// upsertPractitioner era a quinta porta (e a mais silenciosa) por onde a
// federação reescrevia a pessoa: casava por CPF e sobrescrevia
// name/rg/birth_date/email/phone por COALESCE, inclusive em ficha já
// ADOTADA por um dojô (customers.karate_identity_managed_by = 'dojo').
// Agora ele consulta o marcador antes de escrever — ver o comentário
// longo em upsertPractitioner para o porquê de PULAR em vez de FALHAR.
// ============================================================
'use strict';

const crypto = require('crypto');
// F7.3-A — a leitura de "quem mantém esta ficha" é a MESMA dos outros
// quatro canais (ficha da federação, portal do sensei, auto-atendimento).
const { loadIdentityOwner } = require('./karateIdentityWriteGuard');
// Sync da anuidade: o MESMO primitivo de baixa (ledger + amount_paid) do
// /confirm/receive — ver settleAnnuity para o porquê de NÃO escrever o header.
const annuityLedger = require('./karateAnnuityLedger');

// ────────────────────────────────────────────────────────────
// NÚCLEO PURO (sem I/O) — testável isoladamente.
// ────────────────────────────────────────────────────────────

const CONSUMED_TYPES = Object.freeze(['practitioner_added', 'attendance', 'annuity_paid']);

function normStr(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

/** Só dígitos (CPF/telefone) — normaliza o match por chave natural. */
function digits(v) {
  const s = normStr(v);
  return s ? s.replace(/\D/g, '') || null : null;
}

/**
 * Identidade do FATO de negócio dentro de um (federação, dojô, tipo).
 * Preferimos event_uid; senão derivamos uma chave natural determinística.
 * Retorna null quando não há identidade suficiente (evento malformado).
 */
function externalIdentity(ev) {
  const p = (ev && ev.payload) || {};
  const uid = normStr(p.event_uid);
  if (uid) return `uid:${uid}`;

  switch (ev && ev.event_type) {
    case 'practitioner_added': {
      const ext = normStr(p.external_id);
      if (ext) return `ext:${ext}`;
      const cpf = digits(p.cpf);
      if (cpf) return `cpf:${cpf}`;
      return null; // sem uid/external_id/cpf não há como deduplicar com segurança
    }
    case 'attendance': {
      const who = normStr(p.practitioner_external_id) || digits(p.cpf);
      const day = normStr(p.session_date);
      if (who && day) return `att:${who}:${day}`;
      return null;
    }
    case 'annuity_paid': {
      const period = normStr(p.reference_period);
      if (period) return `ann:${period}`;
      return null;
    }
    default:
      // Tipos estacionados: usam o próprio id da linha como identidade
      // (cada linha é estacionada no máximo uma vez).
      return ev && ev.id ? `row:${ev.id}` : null;
  }
}

/**
 * Chave de dedupe ESTÁVEL e curta (sha1 hex). Inclui escopo
 * federation/dojo/type + a identidade do fato. null se não dedupável.
 */
function buildDedupeKey(ev) {
  const ident = externalIdentity(ev);
  if (!ident) return null;
  const parts = [
    ev.federation_id || '',
    ev.dojo_id || '',
    ev.event_type || '',
    ident,
  ].join('|');
  return crypto.createHash('sha1').update(parts).digest('hex');
}

/**
 * Decide a mutação a partir do evento — PURA, sem DB.
 * Retorna um descritor:
 *   { kind: 'practitioner', data: {...} }
 *   { kind: 'attendance',   data: {...} }
 *   { kind: 'annuity',      data: {...} }
 *   { kind: 'parked',  reason }   // tipo conhecido mas não consumido aqui
 *   { kind: 'ignored', reason }   // não é dojo_to_fed / sem event_type
 *   { kind: 'invalid', reason }   // payload malformado p/ um tipo consumido
 */
function decideMutation(ev) {
  if (!ev || typeof ev !== 'object') return { kind: 'invalid', reason: 'evento vazio' };
  if (!ev.event_type) return { kind: 'ignored', reason: 'sem event_type' };
  // Só consumimos eventos vindos do dojô para a federação.
  if (ev.direction && ev.direction !== 'dojo_to_fed') {
    return { kind: 'ignored', reason: `direction ${ev.direction}` };
  }

  if (!CONSUMED_TYPES.includes(ev.event_type)) {
    return { kind: 'parked', reason: `tipo ${ev.event_type} não consumido na Track K` };
  }

  const p = ev.payload;
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return { kind: 'invalid', reason: 'payload ausente ou não-objeto' };
  }

  switch (ev.event_type) {
    case 'practitioner_added': {
      const full_name = normStr(p.full_name);
      if (!full_name) return { kind: 'invalid', reason: 'practitioner_added sem full_name' };
      return {
        kind: 'practitioner',
        data: {
          external_id: normStr(p.external_id),
          full_name,
          cpf: digits(p.cpf),
          rg: normStr(p.rg),
          birth_date: normStr(p.birth_date),
          email: normStr(p.email),
          phone: normStr(p.phone),
          belt_level: normStr(p.belt_level),
          belt_name: normStr(p.belt_name),
        },
      };
    }
    case 'attendance': {
      const session_date = normStr(p.session_date);
      const who = normStr(p.practitioner_external_id) || digits(p.cpf);
      if (!session_date) return { kind: 'invalid', reason: 'attendance sem session_date' };
      if (!who) return { kind: 'invalid', reason: 'attendance sem identificação do praticante' };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(session_date)) {
        return { kind: 'invalid', reason: 'session_date deve ser YYYY-MM-DD' };
      }
      return {
        kind: 'attendance',
        data: {
          practitioner_external_id: normStr(p.practitioner_external_id),
          cpf: digits(p.cpf),
          session_date,
          present: p.present === undefined ? true : !!p.present,
          class_label: normStr(p.class_label),
        },
      };
    }
    case 'annuity_paid': {
      const reference_period = normStr(p.reference_period);
      if (!reference_period) return { kind: 'invalid', reason: 'annuity_paid sem reference_period' };
      const amount = p.amount === undefined || p.amount === null ? null : Number(p.amount);
      if (amount !== null && (Number.isNaN(amount) || amount < 0)) {
        return { kind: 'invalid', reason: 'annuity_paid com amount inválido' };
      }
      return {
        kind: 'annuity',
        data: {
          reference_period,
          amount,
          paid_at: normStr(p.paid_at),
        },
      };
    }
    default:
      return { kind: 'parked', reason: ev.event_type };
  }
}

// ────────────────────────────────────────────────────────────
// LADO DB (idempotente + defensivo). Recebe um `client` já em transação.
// ────────────────────────────────────────────────────────────

function isMissingSchema(err) {
  return err && (err.code === '42P01' || err.code === '42703');
}

/**
 * Reivindica o evento na trilha karate_sync_applied (dedupe).
 * Retorna:
 *   { claimed: true,  appliedRow }   — primeira vez, segue para mutar
 *   { claimed: false }               — já aplicado (no-op idempotente)
 *   { deferred: true }               — tabela ausente (migration não aplicada)
 */
async function claimApplied(client, ev, decision, dedupeKey) {
  try {
    const { rows } = await client.query(
      `INSERT INTO karate_sync_applied
         (dedupe_key, federation_id, dojo_id, connection_id, event_id, event_type, kind, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [
        dedupeKey,
        ev.federation_id || null,
        ev.dojo_id || null,
        ev.connection_id || null,
        ev.id || null,
        ev.event_type || null,
        decision.kind,
      ]
    );
    if (!rows.length) return { claimed: false };
    return { claimed: true, appliedId: rows[0].id };
  } catch (err) {
    if (isMissingSchema(err)) return { deferred: true };
    throw err;
  }
}

/** Marca a linha applied com o id do registro afetado (auditoria). */
async function tagApplied(client, appliedId, targetTable, targetId) {
  if (!appliedId) return;
  try {
    await client.query(
      `UPDATE karate_sync_applied SET target_table = $2, target_id = $3 WHERE id = $1`,
      [appliedId, targetTable || null, targetId || null]
    );
  } catch (err) {
    if (!isMissingSchema(err)) throw err;
  }
}

// ── Mutação: praticante ─────────────────────────────────────
// Match por CPF dentro da federação (chave natural). Sem CPF, cria novo.
// Atualiza dojo_id/dados básicos no match.
//
// (14/07/2026 — H2) INVESTIGAÇÃO: o contrato do evento practitioner_added
// (ver cabeçalho do arquivo) NUNCA carrega um número de matrícula FPKT —
// os campos são só event_uid/external_id/full_name/cpf/rg/birth_date/
// email/phone/belt_level/belt_name. Ou seja, este caminho não "propaga"
// um número que já existe em outra instância: ele CRIA de verdade, e
// antes desta mudança usava nextPractitionerRegistrationNumber como
// fallback incondicional (100% das criações por sync inventariam um
// número, porque o payload nunca tem um pra propagar). Isso viola a
// regra fechada com o Caio (o número FPKT é emitido SÓ pela federação,
// fora do sistema) — mesma classe de bug do quick-add do portal do
// sensei (karateRosterPortalPublic.js). Diferença: aqui é um pipeline
// assíncrono sem aprovação humana no meio (ao contrário da solicitação
// da H1), então a correção é falha explícita em vez de virar solicitação
// pendente: praticante sem match por CPF fica sem aplicar — o evento cai
// em 'failed' depois de MAX_ATTEMPTS (karateSyncApplyRunner.js), visível
// nos endpoints que já filtram status='failed' em karateFederation.js —
// em vez de nascer com número inventado. Cada evento roda na própria
// transação (runFederationApply), então isso NÃO derruba a fila nem
// outros eventos pendentes.
//
// (30/07/2026 — F7.3-A) FICHA ADOTADA POR DOJÔ: o COALESCE abaixo escreve
// name/rg/birth_date/email/phone — cinco campos de IDENTIDADE, que desde
// a F7.1 podem pertencer a um dojô. Este era o canal mais silencioso de
// todos: sem tela, sem ator humano, disparado por um webhook.
//
// PULAR (e não falhar) é decisão consciente:
//   • falhar marcaria o evento como 'failed' depois de MAX_ATTEMPTS e o
//     motor ficaria re-tentando para sempre um payload que NUNCA vai
//     ganhar autorização — o dono da ficha é outro sistema, não há o que
//     esperar. Seria ruído permanente no painel de sync;
//   • o evento não é inútil: dojo_id (o vínculo de onde a pessoa treina)
//     é coluna da FEDERAÇÃO e continua sendo aplicado. Só a PESSOA fica
//     de fora;
//   • o dado não se perde: a ficha do dojô é a fonte, e a F7.2 sobe a
//     versão dele. Sobrescrever aqui seria justamente inverter o fluxo.
// O resultado carrega identity_skipped:true até applyEvent, para o
// runner e o painel de sync poderem mostrar "aplicado, identidade não
// sobrescrita (ficha do dojô)".
async function upsertPractitioner(client, ev, data) {
  const federationId = ev.federation_id;
  const dojoId = ev.dojo_id;

  let existing = null;
  if (data.cpf) {
    const r = await client.query(
      `SELECT id FROM customers
       WHERE federation_id = $1 AND regexp_replace(COALESCE(cpf_cnpj,''), '\\D', '', 'g') = $2
       LIMIT 1`,
      [federationId, data.cpf]
    );
    existing = r.rows[0] || null;
  }

  if (existing) {
    // savepoint:true porque estamos DENTRO da transação do runner: um
    // 42703 (migration 262 pendente) não pode envenenar a transação do
    // chamador (armadilha tx-poison). Sem a 262 não existe ficha
    // adotada, e o guarda devolve 'federation' — o caminho de sempre.
    const owner = await loadIdentityOwner(client, existing.id, { savepoint: true });

    if (owner.managedBy === 'dojo') {
      // Só o que é da FEDERAÇÃO. dojo_id fica de fora de IDENTITY_FIELDS
      // de propósito (é onde a federação acha que a pessoa treina, não
      // quem a pessoa é) — ver FEDERATION_OWNED_COLS em karateIdentitySync.
      await client.query(
        `UPDATE customers SET
           dojo_id     = COALESCE($2, dojo_id),
           updated_at  = NOW()
         WHERE id = $1`,
        [existing.id, dojoId]
      );
      console.warn(
        '[karateApplyEvent] practitioner_added: identidade NÃO sobrescrita — ficha mantida pelo dojô',
        (owner.dojo && owner.dojo.name) || (owner.dojo && owner.dojo.id) || '(dojô desconhecido)',
        'practitioner:', existing.id
      );
      return {
        id: existing.id,
        created: false,
        identity_skipped: true,
        identity_dojo_id: (owner.dojo && owner.dojo.id) || null,
      };
    }

    await client.query(
      `UPDATE customers SET
         name        = COALESCE($2, name),
         rg          = COALESCE($3, rg),
         birth_date  = COALESCE($4, birth_date),
         email       = COALESCE($5, email),
         phone       = COALESCE($6, phone),
         dojo_id     = COALESCE($7, dojo_id),
         updated_at  = NOW()
       WHERE id = $1`,
      [existing.id, data.full_name, data.rg, data.birth_date, data.email, data.phone, dojoId]
    );
    return { id: existing.id, created: false, identity_skipped: false };
  }

  // Sem match por CPF → seria uma criação nova. O contrato do evento não
  // carrega número FPKT e o backend NUNCA gera um (regra H1/H2) — falha
  // explícita em vez de inventar. NÃO recuperável: re-tentar sozinho não
  // muda o payload (ele nunca vai ganhar um número por conta própria).
  const err = new Error(
    'practitioner_added sem correspondência por CPF: seria uma criação nova, mas o evento não carrega número de matrícula FPKT e o backend não gera número (regra H1/H2). Evento não aplicado — resolva manualmente (import/solicitação) com o número emitido pela federação.'
  );
  err.recoverable = false;
  err.code = 'FPKT_NUMBER_REQUIRED';
  throw err;
}

// ── Resolução do praticante p/ frequência ───────────────────
async function resolvePractitionerId(client, ev, data) {
  const federationId = ev.federation_id;
  if (data.cpf) {
    const r = await client.query(
      `SELECT id FROM customers
       WHERE federation_id = $1 AND regexp_replace(COALESCE(cpf_cnpj,''), '\\D', '', 'g') = $2
       LIMIT 1`,
      [federationId, data.cpf]
    );
    if (r.rows[0]) return r.rows[0].id;
  }
  // external_id não tem coluna dedicada em customers; sem CPF não resolvemos.
  return null;
}

// ── Mutação: frequência (karate_attendance, migration 179) ──
async function recordAttendance(client, ev, data) {
  const practitionerId = await resolvePractitionerId(client, ev, data);
  if (!practitionerId) {
    // Praticante ainda não existe na federação: erro recuperável — o evento
    // practitioner_added provavelmente vem na mesma fila; a re-tentativa
    // do motor resolve quando a ordem se acertar.
    const e = new Error('praticante não encontrado para attendance (re-tentar)');
    e.recoverable = true;
    throw e;
  }
  const ins = await client.query(
    `INSERT INTO karate_attendance
       (federation_id, dojo_id, practitioner_id, session_date, present, class_label, source, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'sync', NOW())
     ON CONFLICT (federation_id, practitioner_id, session_date) DO UPDATE
       SET present = EXCLUDED.present, class_label = EXCLUDED.class_label
     RETURNING id`,
    [
      ev.federation_id, ev.dojo_id, practitionerId,
      data.session_date, data.present, data.class_label,
    ]
  );
  return { id: ins.rows[0].id };
}

// ── Mutação: anuidade do dojô conciliada ────────────────────
//
// FONTE ÚNICA DE VERDADE = PARCELA (F2-sync, follow-up da Onda 1 do QA).
// Antes, o sync escrevia SÓ o header (paid_at). Mas o summary
// (karateAnnuitySummary) lê de karate_annuity_installments (amount_paid/status),
// não do header — o "pago" via sync ficava invisível no hub e um rollup futuro
// podia reverter o header. Agora o sync liquida a(s) PARCELA(s) do período pelo
// MESMO primitivo do /confirm (ledger karate_annuity_payments + amount_paid,
// via annuityLedger.settlePeriodOnClient) e deixa syncAnnuityHeaderRollup
// DERIVAR o header. A divergência header↔parcela some por construção, e o
// header 'paid' nunca mais é escrito à mão (o rollup só marca 'paid' quando
// TODAS as parcelas pagam — invariante do guardrail).
//
// A cobrança NASCE na federação (Track B / /charge), NUNCA aqui.
//
// PARK-AND-REPLAY: se o pagamento chega ANTES da cobrança existir, NÃO drenamos
// (isso perderia o fato para sempre); devolvemos { parked:true } e o chamador
// mantém o evento 'pending' para re-aplicar quando a cobrança nascer.
async function settleAnnuity(client, ev, data) {
  // Resolve o header (anuidade) do período dentro da federação/dojô.
  const headerRes = await client.query(
    `SELECT id FROM karate_dojo_annuity_history
      WHERE dojo_id = $1 AND reference_period = $2 AND federation_id = $3
      LIMIT 1`,
    [ev.dojo_id, data.reference_period, ev.federation_id]
  );
  if (!headerRes.rows.length) {
    // Cobrança ainda não existe → park-and-replay (não drena).
    return { parked: true };
  }
  const annuityId = headerRes.rows[0].id;

  // Liquida a(s) parcela(s) pelo primitivo do ledger; o header é derivado.
  const r = await annuityLedger.settlePeriodOnClient(client, {
    federation_id: ev.federation_id,
    annuity_id: annuityId,
    amount: data.amount != null ? data.amount : null,
    payment_method: null, // o evento annuity_paid não carrega método
    paid_at: data.paid_at || null,
    created_by: null,
  });

  if (r.no_installments) {
    // Header legado SEM nenhuma parcela (anomalia de dado): não há parcela para
    // ser a fonte. Fallback ao comportamento antigo — marca só o paid_at do
    // header (idempotente, WHERE paid_at IS NULL), sem tocar status (fica dentro
    // do CHECK). Não aparece no summary (que faz JOIN com parcelas), então não
    // reintroduz a divergência header↔parcela.
    const paidAt = data.paid_at || new Date().toISOString();
    const upd = await client.query(
      `UPDATE karate_dojo_annuity_history
          SET paid_at = COALESCE(paid_at, $2), updated_at = NOW()
        WHERE id = $1 AND paid_at IS NULL
        RETURNING id`,
      [annuityId, paidAt]
    );
    return { id: annuityId, settled: upd.rows.length > 0 };
  }

  // settled=true só quando de fato aplicou valor (saldo já quitado → no-op).
  return { id: annuityId, settled: Number(r.settled_amount) > 0 };
}

/**
 * applyEvent — aplica UM evento (idempotente). `client` já em transação.
 * Resultado: { ok, applied, deferred?, parked?, ignored?, invalid?, kind, detail? }
 *   - ok=true  → processado com sucesso (mutado, no-op idempotente, parked,
 *                ignored ou invalid — todos drenam a fila).
 *   - ok=false → falha recuperável → o motor re-tenta (status volta a pending).
 *   - deferred → schema ausente: NÃO drena (mantém pending até a migration).
 *   - hold (só annuity) → PARK-AND-REPLAY: cobrança do período ainda não
 *     existe; NÃO drena e NÃO conta attempt (mantém pending até a cobrança
 *     nascer). Mesma mecânica de drenagem do deferred no runner/engine.
 *   - identity_skipped (só practitioner) → aplicado, mas a IDENTIDADE não
 *     foi sobrescrita porque a ficha é mantida por um dojô (F7.3-A).
 */
async function applyEvent(client, ev) {
  const decision = decideMutation(ev);

  // Eventos não-consumidos drenam sem tocar a trilha applied:
  if (decision.kind === 'ignored') {
    return { ok: true, applied: false, ignored: true, kind: decision.kind, detail: decision.reason };
  }
  if (decision.kind === 'invalid') {
    // Malformado: drena (ok) mas NÃO aplica — não adianta re-tentar um
    // payload quebrado. Fica registrado como falha lógica via detail.
    return { ok: true, applied: false, invalid: true, kind: decision.kind, detail: decision.reason };
  }

  const dedupeKey = buildDedupeKey(ev);
  if (!dedupeKey) {
    // Sem identidade dedupável: tratamos como inválido (não re-tenta).
    return { ok: true, applied: false, invalid: true, kind: 'invalid', detail: 'sem chave de dedupe' };
  }

  const claim = await claimApplied(client, ev, decision, dedupeKey);
  if (claim.deferred) {
    return { ok: false, deferred: true, applied: false, kind: decision.kind, detail: 'karate_sync_applied ausente' };
  }
  if (!claim.claimed) {
    // Já aplicado anteriormente → no-op idempotente.
    return { ok: true, applied: false, duplicate: true, kind: decision.kind };
  }

  // Primeira vez: aplica a mutação real.
  try {
    if (decision.kind === 'parked') {
      await tagApplied(client, claim.appliedId, null, null);
      return { ok: true, applied: false, parked: true, kind: 'parked', detail: decision.reason };
    }
    if (decision.kind === 'practitioner') {
      const r = await upsertPractitioner(client, ev, decision.data);
      await tagApplied(client, claim.appliedId, 'customers', r.id);
      return {
        ok: true,
        applied: true,
        kind: 'practitioner',
        created: r.created,
        targetId: r.id,
        identity_skipped: !!r.identity_skipped,
        identity_dojo_id: r.identity_dojo_id || null,
        detail: r.identity_skipped ? 'identidade não sobrescrita: ficha mantida pelo dojô' : undefined,
      };
    }
    if (decision.kind === 'attendance') {
      const r = await recordAttendance(client, ev, decision.data);
      await tagApplied(client, claim.appliedId, 'karate_attendance', r.id);
      return { ok: true, applied: true, kind: 'attendance', targetId: r.id };
    }
    if (decision.kind === 'annuity') {
      const r = await settleAnnuity(client, ev, decision.data);
      if (r.parked) {
        // PARK-AND-REPLAY: cobrança do período ainda não existe. NÃO drena e
        // NÃO incrementa attempts — o chamador (runner/engine) faz ROLLBACK
        // (desfaz o claim em karate_sync_applied) e mantém o evento 'pending'
        // para re-aplicar quando a cobrança nascer. Mesma mecânica do deferred.
        return {
          ok: false, hold: true, applied: false, kind: 'annuity',
          detail: 'cobrança do período ainda não existe — aguardando (park-and-replay)',
        };
      }
      await tagApplied(client, claim.appliedId, 'karate_dojo_annuity_history', r.id);
      return { ok: true, applied: r.settled, kind: 'annuity', settled: r.settled, targetId: r.id };
    }
    return { ok: true, applied: false, kind: decision.kind };
  } catch (err) {
    // Falha ao mutar: propaga para o chamador (ROLLBACK desfaz inclusive a
    // reivindicação na trilha applied → re-tentativa fica idempotente).
    if (err.recoverable) {
      const e = new Error(err.message);
      e.recoverable = true;
      throw e;
    }
    throw err;
  }
}

module.exports = {
  // núcleo puro
  CONSUMED_TYPES,
  normStr,
  digits,
  externalIdentity,
  buildDedupeKey,
  decideMutation,
  // lado DB
  applyEvent,
  isMissingSchema,
};
