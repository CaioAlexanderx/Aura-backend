// ============================================================
// AURA DOJÔ — F7.1: CONFERIR ANTES DE FEDERAR
//
// O CASO REAL QUE ORIGINOU ESTE ARQUIVO (produção, 30/07/2026)
// Uma aluna de 12 anos (CPF 123..., nascida em 1998 no cadastro do dojô)
// foi vinculada a um praticante nascido em 2020, com CPF diferente. O
// backend aceitou SEM UM AVISO: o único critério de
// POST /dojo/students/:sid/federate era "o número existe?" e "outro aluno
// DESTE dojô já usa?". O front até detectava o nome divergente e pedia
// confirmação — mas o backend JÁ TINHA GRAVADO antes de perguntar.
//
// Com a direção nova (F7.0: o fluxo de informação SOBE, dojô → federação)
// isso deixa de ser um vínculo errado e passa a ser uma AUTORIZAÇÃO errada:
// vincular dá ao dojô o direito de sobrescrever a ficha daquela pessoa na
// federação (customers.karate_identity_managed_by = 'dojo'). Vincular
// errado = corromper o cadastro de OUTRO praticante.
//
// ── O DESENHO ───────────────────────────────────────────────
// A mesma rota passa a ter DOIS MODOS, decididos por `confirm`:
//
//   { fpkt_number }                     → PREVIEW. NÃO GRAVA NADA.
//       Devolve a comparação campo a campo entre os dois cadastros,
//       a lista de bloqueios e can_link.
//
//   { fpkt_number, confirm:true, resolution } → CONFIRMAÇÃO. Numa
//       transação só: vincula + ADOTA (managed_by='dojo') + aplica a
//       resolução nos DOIS lados + registra a trilha.
//
// Preview que não grava é o ponto inteiro deste arquivo. A ordem certa é
// "mostrar, perguntar, gravar" — a ordem anterior era "gravar, mostrar,
// perguntar", que é como uma aluna de 12 anos virou um praticante de 2020.
//
// ── POR QUE UM ARQUIVO NOVO ─────────────────────────────────
// karateDojoStudentService.js está sendo reescrito em paralelo pelo PR #446
// (F7.0). Toda a lógica nova mora aqui e o service só DELEGA, para a área
// de conflito entre os dois PRs ser de duas funções, não do arquivo inteiro.
//
// ── DEFENSIVO A SCHEMA PENDENTE (262 e 263) ─────────────────
// Este código sobe ANTES das migrations. Em vez do padrão
// try/catch-42703-e-retenta (que dentro de um BEGIN envenena a transação),
// aqui há UMA sonda ao information_schema, com cache curto. Motivo: a
// confirmação é transacional, e descobrir dentro do BEGIN que a coluna não
// existe custaria SAVEPOINT em cada UPDATE. Sondar antes é mais barato e
// mais legível. A sonda NUNCA lança: falha vira "não tem" (degrada).
//
//   PREVIEW  → funciona SEM a 262. Os campos que só existem no aluno
//              depois da 262 (rg, endereço, foto) vêm null e a resposta
//              carrega schema_pending:true. É leitura: degradar é seguro.
//   CONFIRM  → 503 SCHEMA_PENDING_262 com mensagem clara, sem gravar nada.
//              DECISÃO CONSCIENTE (e é uma recusa, não uma degradação):
//              sem a 262 não existe karate_identity_managed_by, ou seja,
//              seria possível gravar o VÍNCULO sem gravar a ADOÇÃO — que é
//              exatamente o estado meio-gravado que este PR existe para
//              impedir. A janela entre deploy e migration é de minutos e
//              hoje há 6 alunos de dojô e 0 vínculos em produção.
//   DELETE   → NUNCA bloqueia. Desfazer marcação errada é higiene do
//              cadastro e não pode depender de migration: sem a 262 o
//              desvínculo acontece e a devolução da gestão é pulada
//              (identity_returned:false + schema_pending:true).
//   TRILHA   → 263 é a trilha canônica; sem ela, o rastro vai para
//              karate_dojo_roster_events (que já existe em produção e não
//              tem CHECK em `event`). Se NENHUM dos dois puder ser gravado,
//              a transação inteira aborta: adoção sem rastro não existe.
// ============================================================
'use strict';

const db = require('../config/database');
const { normalizeFpktNumber, normalizeName, toIsoDate } = require('./karatePractitionerDedup');
const {
  onlyDigits,
  normalizeSex,
  toDojoSex,
  normalizeUf,
  normalizeZipCode,
} = require('../utils/personIdentity');

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function svcError(status, code, message, extra) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

// Coluna uuid não aceita 'u1' nem 'staff1'. O ator vira null e o rastro
// humano fica em actor_label — perder o log inteiro por causa de um id
// fora de forma seria trocar o certo pelo perfeito.
function asUuid(v) {
  return v && UUID_RE.test(String(v)) ? String(v) : null;
}

// ============================================================
// SONDA DE SCHEMA (uma query, sem exceção, cache curto)
// ============================================================
const PROBE_TTL_MS = 60000;
let schemaProbe = null;

const PROBE_SQL = `
  SELECT
    EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'customers'
               AND column_name = 'karate_identity_managed_by') AS has_customer_identity,
    EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'karate_dojo_students'
               AND column_name = 'rg') AS has_student_identity,
    EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'karate_dojo_students'
               AND column_name = 'is_federated') AS has_is_federated,
    EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public'
               AND table_name = 'karate_identity_audit') AS has_identity_audit`;

async function loadSchemaProbe() {
  if (schemaProbe && Date.now() - schemaProbe.at < PROBE_TTL_MS) return schemaProbe;
  let r = {};
  try {
    const { rows } = await db.query(PROBE_SQL);
    r = rows[0] || {};
  } catch (e) {
    // A sonda NUNCA lança: se nem o information_schema respondeu, o problema
    // é maior que esta rota. Degradamos para "nada aplicado" — o preview
    // continua servindo e a confirmação recusa com mensagem clara.
    console.warn('[karateStudentIdentityLink] sonda de schema falhou — assumindo migrations pendentes:', e && e.message);
  }
  // Cache com TTL curto nos DOIS sentidos: sem isso, um falso negativo
  // (sondado antes da migration rodar) sobreviveria até o próximo deploy.
  schemaProbe = {
    at: Date.now(),
    hasCustomerIdentity: r.has_customer_identity === true,
    hasStudentIdentity: r.has_student_identity === true,
    hasIsFederated: r.has_is_federated === true,
    hasIdentityAudit: r.has_identity_audit === true,
  };
  return schemaProbe;
}

// Cache module-level é estado global: os testes precisam poder zerá-lo
// entre casos, senão a sonda do primeiro caso decide o schema de todos.
function _resetSchemaCache() {
  schemaProbe = null;
}

// ============================================================
// OS CAMPOS DA IDENTIDADE (a lista é UMA só)
//
// Uma lista alimenta SELECT, comparação, resolução e UPDATE dos dois
// lados. É o mesmo motivo do IDENTITY_COLS do #446: o clássico "adicionei
// na comparação e esqueci no UPDATE" não tem onde acontecer.
//
// dojoCol/fedCol são nomes de coluna vindos DESTA constante — nunca do
// corpo da requisição. Não há concatenação de identificador com dado do
// usuário em lugar nenhum deste arquivo.
// ============================================================
const IDENTITY_FIELDS = Object.freeze([
  { key: 'full_name', label: 'Nome', kind: 'name', dojoCol: 'full_name', fedCol: 'name' },
  { key: 'birth_date', label: 'Data de nascimento', kind: 'date', dojoCol: 'birth_date', fedCol: 'birth_date', isDate: true },
  { key: 'cpf', label: 'CPF', kind: 'cpf', dojoCol: 'cpf', fedCol: 'cpf_cnpj' },
  { key: 'rg', label: 'RG', kind: 'text', dojoCol: 'rg', fedCol: 'rg', dojoNeeds262: true },
  { key: 'sex', label: 'Sexo', kind: 'sex', dojoCol: 'sex', fedCol: 'sex' },
  { key: 'phone', label: 'Telefone', kind: 'phone', dojoCol: 'phone', fedCol: 'phone' },
  { key: 'email', label: 'E-mail', kind: 'email', dojoCol: 'email', fedCol: 'email' },
  { key: 'zip_code', label: 'CEP', kind: 'zip', dojoCol: 'zip_code', fedCol: 'zip_code', dojoNeeds262: true },
  { key: 'street', label: 'Logradouro', kind: 'text', dojoCol: 'street', fedCol: 'street', dojoNeeds262: true },
  { key: 'number', label: 'Número', kind: 'text', dojoCol: 'number', fedCol: 'number', dojoNeeds262: true },
  { key: 'complement', label: 'Complemento', kind: 'text', dojoCol: 'complement', fedCol: 'complement', dojoNeeds262: true },
  { key: 'neighborhood', label: 'Bairro', kind: 'text', dojoCol: 'neighborhood', fedCol: 'neighborhood', dojoNeeds262: true },
  { key: 'city', label: 'Cidade', kind: 'text', dojoCol: 'city', fedCol: 'city', dojoNeeds262: true },
  { key: 'state', label: 'UF', kind: 'uf', dojoCol: 'state', fedCol: 'state', dojoNeeds262: true },
  // Leitura da foto é COALESCE(karate_photo_url, photo_url) dos DOIS lados
  // (photo_url ficou deprecada por COMMENT na 262, não foi dropada). A
  // ESCRITA vai só para karate_photo_url — que no aluno só existe com a 262.
  { key: 'photo_url', label: 'Foto', kind: 'url', dojoCol: 'karate_photo_url', fedCol: 'karate_photo_url', dojoNeeds262: true, coalescePhoto: true },
]);

const FIELD_BY_KEY = Object.freeze(
  IDENTITY_FIELDS.reduce((acc, f) => { acc[f.key] = f; return acc; }, {})
);

// ── Comparação: normaliza SÓ para decidir "é o mesmo dado?" ──
// O valor exibido/gravado é sempre o CRU. Diferença de acento, caixa ou
// máscara não é divergência — é digitação. Tratar como divergência
// encheria a tela de falso positivo e o sensei pararia de ler.
function compareKey(kind, v) {
  switch (kind) {
    case 'name':
    case 'text':
      return normalizeName(v);
    case 'date':
      return toIsoDate(v) || '';
    case 'cpf':
    case 'phone':
    case 'zip':
      return onlyDigits(v);
    case 'email':
      return String(v == null ? '' : v).trim().toLowerCase();
    case 'sex':
      return normalizeSex(v) || '';
    case 'uf':
      return normalizeUf(v) || '';
    case 'url':
    default:
      return String(v == null ? '' : v).trim();
  }
}

function hasValue(v) {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

// ── Valor a GRAVAR em cada lado ─────────────────────────────
// Sexo é o único campo com vocabulário diferente por lado (M/F/other no
// dojô, canônico em customers) — ver personIdentity.js.
function storeForDojo(kind, raw) {
  if (!hasValue(raw)) return null;
  switch (kind) {
    case 'sex': return toDojoSex(raw);
    case 'cpf': return onlyDigits(raw) || null;
    case 'zip': return normalizeZipCode(raw);
    case 'uf': return normalizeUf(raw);
    default: return String(raw).trim();
  }
}

function storeForFederation(kind, raw) {
  if (!hasValue(raw)) return null;
  switch (kind) {
    case 'sex': return normalizeSex(raw);
    case 'cpf': return onlyDigits(raw) || null;
    case 'zip': return normalizeZipCode(raw);
    case 'uf': return normalizeUf(raw);
    default: return String(raw).trim();
  }
}

// ============================================================
// SELECTs
// ============================================================
function dojoSelectList(has262) {
  const cols = ['s.id', 's.dojo_id', 's.practitioner_id'];
  for (const f of IDENTITY_FIELDS) {
    if (f.isDate) {
      // date puro: to_char para o driver não devolver Date com fuso
      // (P0 de 15/07 — nunca String(dateObj).slice(0,10)).
      cols.push(`to_char(s.${f.dojoCol}, 'YYYY-MM-DD') AS ${f.key}`);
    } else if (f.coalescePhoto) {
      cols.push(has262 ? `COALESCE(s.karate_photo_url, s.photo_url) AS ${f.key}` : `s.photo_url AS ${f.key}`);
    } else if (f.dojoNeeds262 && !has262) {
      // O SHAPE não muda de formato — só vem vazio. O front não precisa
      // saber se a migration rodou para renderizar a linha.
      cols.push(`NULL::text AS ${f.key}`);
    } else {
      cols.push(`s.${f.dojoCol} AS ${f.key}`);
    }
  }
  return cols.join(', ');
}

function fedSelectList(hasIdentityCols) {
  const cols = [
    'c.id', 'c.karate_registration_number', 'c.dojo_id', 'c.is_active',
    'COALESCE(comp.trade_name, comp.legal_name) AS dojo_name',
  ];
  for (const f of IDENTITY_FIELDS) {
    if (f.isDate) cols.push(`to_char(c.${f.fedCol}, 'YYYY-MM-DD') AS ${f.key}`);
    else if (f.coalescePhoto) cols.push(`COALESCE(c.karate_photo_url, c.photo_url) AS ${f.key}`);
    else cols.push(`c.${f.fedCol} AS ${f.key}`);
  }
  cols.push(hasIdentityCols ? 'c.karate_identity_managed_by' : `'federation'::text AS karate_identity_managed_by`);
  cols.push(hasIdentityCols ? 'c.karate_identity_dojo_id' : 'NULL::uuid AS karate_identity_dojo_id');
  return cols.join(', ');
}

async function loadStudent(q, dojoId, studentId, probe, forUpdate) {
  const { rows } = await q(
    `SELECT ${dojoSelectList(probe.hasStudentIdentity)}
       FROM karate_dojo_students s
      WHERE s.id = $1 AND s.dojo_id = $2
      LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [studentId, dojoId]
  );
  if (!rows.length) throw svcError(404, 'NOT_FOUND', 'Aluno não encontrado neste dojô');
  return rows[0];
}

// Mesmo WHERE de lookupByFpktNumber (karatePractitionerDedup), com a ficha
// INTEIRA. Não reusei aquela função de propósito: ela alimenta o
// "auto-localizar" do H1 e engordar o payload dela mudaria um contrato que
// não tem nada a ver com esta tela. O WHERE, que é a regra, é o mesmo.
async function loadPractitionerByNumber(q, federationId, number, probe, forUpdate) {
  const { rows } = await q(
    `SELECT ${fedSelectList(probe.hasCustomerIdentity)}
       FROM customers c
       LEFT JOIN companies comp ON comp.id = c.dojo_id
      WHERE c.federation_id = $1 AND c.karate_registration_number = $2
      LIMIT 1${forUpdate ? ' FOR UPDATE OF c' : ''}`,
    [federationId, number]
  );
  if (!rows.length) {
    throw svcError(
      404,
      'FPKT_NUMBER_NOT_FOUND',
      'Número FPKT não encontrado nesta federação. Confira o número ou marque o aluno como novo para solicitar o cadastro à federação.'
    );
  }
  return rows[0];
}

// A checagem agora é GLOBAL — não mais escopada ao dojô.
// Antes: WHERE dojo_id = $1 AND practitioner_id = $2. Ou seja, o dojô A e o
// dojô B podiam reivindicar o MESMO praticante e ninguém via. A UNIQUE
// global da 262 garante isso no banco; aqui a checagem existe para devolver
// 409 LEGÍVEL (com o nome do outro dojô) em vez de deixar estourar 23505.
async function loadGlobalClaim(q, practitionerId, studentId) {
  const { rows } = await q(
    `SELECT s.id, s.full_name, s.dojo_id,
            COALESCE(comp.trade_name, comp.legal_name) AS dojo_name
       FROM karate_dojo_students s
       LEFT JOIN companies comp ON comp.id = s.dojo_id
      WHERE s.practitioner_id = $1 AND s.id <> $2
      LIMIT 1`,
    [practitionerId, studentId]
  );
  return rows[0] || null;
}

// ============================================================
// COMPARAÇÃO E BLOQUEIOS
// ============================================================
function buildComparison(student, practitioner) {
  return IDENTITY_FIELDS.map((f) => {
    const dojoValue = hasValue(student[f.key]) ? student[f.key] : null;
    const fedValue = hasValue(practitioner[f.key]) ? practitioner[f.key] : null;
    const dojoHas = dojoValue !== null;
    const fedHas = fedValue !== null;

    // "Dado faltante é neutro": ausência de um lado NUNCA é divergência.
    // A linha aparece assim mesmo — o sensei precisa VER o que está vazio.
    const diverges = dojoHas && fedHas && compareKey(f.kind, dojoValue) !== compareKey(f.kind, fedValue);

    let suggested = null;
    if (dojoHas && !fedHas) suggested = 'dojo';
    else if (!dojoHas && fedHas) suggested = 'federation';
    else if (diverges) suggested = 'dojo'; // o dojô é a fonte da identidade

    return {
      field: f.key,
      label: f.label,
      dojo_value: dojoValue,
      federation_value: fedValue,
      diverges,
      suggested,
    };
  });
}

function buildBlockers({ student, practitioner, claim, dojoId }) {
  const blockers = [];

  // ── CPF_CONFLITANTE — sem override, por decisão ──
  // Dois CPFs preenchidos e diferentes não é erro de digitação: é o sinal
  // mais forte que existe de que são DUAS PESSOAS. Foi exatamente o que o
  // vínculo de produção atropelou. Não existe "confirmar mesmo assim".
  const dojoCpf = onlyDigits(student.cpf);
  const fedCpf = onlyDigits(practitioner.cpf);
  if (dojoCpf && fedCpf && dojoCpf !== fedCpf) {
    blockers.push({
      code: 'CPF_CONFLITANTE',
      field: 'cpf',
      message:
        `O CPF do aluno (${student.cpf}) é diferente do CPF do praticante ${practitioner.karate_registration_number || 'FPKT'} (${practitioner.cpf}). ` +
        'CPF diferente indica que são pessoas diferentes — não é possível vincular, e não existe confirmar mesmo assim. ' +
        'Corrija o CPF no cadastro do aluno ou informe outro número FPKT.',
    });
  }

  // ── PRATICANTE_JA_VINCULADO — agora GLOBAL ──
  if (claim) {
    const mesmoDojo = String(claim.dojo_id) === String(dojoId);
    blockers.push({
      code: 'PRATICANTE_JA_VINCULADO',
      field: 'fpkt_number',
      message: mesmoDojo
        ? `Este número FPKT já está vinculado ao aluno "${claim.full_name}" deste dojô.`
        : `Este número FPKT já está vinculado ao aluno "${claim.full_name}" do dojô "${claim.dojo_name || 'outro dojô'}". Um praticante só pode pertencer a um aluno.`,
    });
  }

  return blockers;
}

function practitionerPayload(p, number) {
  return {
    id: p.id,
    name: p.full_name || null, // alias 'full_name' do SELECT = customers.name
    fpkt_number: number || p.karate_registration_number || null,
    dojo_id: p.dojo_id || null,
    dojo_name: p.dojo_name || null,
    is_active: p.is_active !== false,
    identity_managed_by: p.karate_identity_managed_by || 'federation',
    identity_dojo_id: p.karate_identity_dojo_id || null,
    // Nomes antigos preservados: o app já lê current_dojo_* desde a F5a.
    current_dojo_id: p.dojo_id || null,
    current_dojo_name: p.dojo_name || null,
  };
}

// ============================================================
// RESOLUÇÃO
// ============================================================
// `resolution` é opcional; campo omitido usa o `suggested` do preview.
// Chave desconhecida é IGNORADA (o front pode mandar campo a mais sem
// derrubar a operação); VALOR inválido é 422 — "dado faltante é neutro,
// dado inválido é erro".
function validateResolution(resolution) {
  if (resolution === undefined || resolution === null) return {};
  if (typeof resolution !== 'object' || Array.isArray(resolution)) {
    throw svcError(422, 'VALIDATION_ERROR', 'resolution deve ser um objeto { campo: "dojo" | "federation" }');
  }
  const errors = [];
  const out = {};
  for (const key of Object.keys(resolution)) {
    if (!FIELD_BY_KEY[key]) continue; // campo desconhecido: ignorado
    const v = resolution[key];
    if (v !== 'dojo' && v !== 'federation') {
      errors.push(`resolution.${key} inválido: use "dojo" ou "federation"`);
    } else {
      out[key] = v;
    }
  }
  if (errors.length) {
    const e = svcError(422, 'VALIDATION_ERROR', errors[0]);
    e.errors = errors;
    throw e;
  }
  return out;
}

// Monta o que efetivamente muda em cada lado.
//
// REGRA DE SEGURANÇA: vencedor SEM valor = campo PULADO. Nunca apagamos um
// dado preenchido com o vazio do outro lado — nem quando o sensei pede
// "federation" num campo em que a federação não tem nada. Resolver conflito
// é escolher entre dois valores, nunca destruir um.
function planResolution(comparison, resolution, student, practitioner) {
  const dojoWrites = [];
  const fedWrites = [];
  const applied = [];

  for (const row of comparison) {
    const f = FIELD_BY_KEY[row.field];
    const winner = resolution[row.field] || row.suggested;
    if (!winner) continue;

    const raw = winner === 'dojo' ? row.dojo_value : row.federation_value;
    if (!hasValue(raw)) continue; // vencedor vazio → pula (ver regra acima)

    const loserSide = winner === 'dojo' ? 'federation' : 'dojo';
    const loserRaw = winner === 'dojo' ? row.federation_value : row.dojo_value;
    // Nada a fazer quando os dois já dizem a mesma coisa.
    if (hasValue(loserRaw) && compareKey(f.kind, raw) === compareKey(f.kind, loserRaw)) continue;

    const value = loserSide === 'dojo' ? storeForDojo(f.kind, raw) : storeForFederation(f.kind, raw);
    // Valor que não sobrevive à normalização do lado de destino (CEP com 5
    // dígitos, UF com 3 letras, sexo irreconhecível) também é pulado: seria
    // gravar NULL por cima de algo, que é a mesma destruição de dado.
    if (value === null) continue;

    if (loserSide === 'dojo') {
      dojoWrites.push({ col: f.dojoCol, value });
    } else {
      fedWrites.push({ col: f.fedCol, value });
    }

    applied.push({
      field: f.key,
      label: f.label,
      from: winner,
      value: raw,
      dojo_before: row.dojo_value,
      dojo_after: loserSide === 'dojo' ? value : row.dojo_value,
      federation_before: row.federation_value,
      federation_after: loserSide === 'federation' ? value : row.federation_value,
    });
  }

  return { dojoWrites, fedWrites, applied };
}

// ============================================================
// TRILHA
// ============================================================
// SEMPRE dentro de SAVEPOINT: um erro aqui não pode envenenar a transação
// da adoção (armadilha tx-poison). E a ordem é deliberada — 263 primeiro,
// roster_events como rede. Se os DOIS falharem, o erro sobe e a transação
// inteira aborta: adoção sem rastro não acontece.
async function writeIdentityAudit(client, probe, rec) {
  await client.query('SAVEPOINT sp_identity_audit');

  if (probe.hasIdentityAudit) {
    try {
      await client.query(
        `INSERT INTO karate_identity_audit
           (federation_id, dojo_id, practitioner_id, practitioner_label, fpkt_number,
            student_id, student_label, action, source, changes, actor_user_id, actor_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)`,
        [
          rec.federationId || null,
          rec.dojoId,
          rec.practitionerId || null,
          rec.practitionerLabel || null,
          rec.fpktNumber || null,
          rec.studentId,
          rec.studentLabel || null,
          rec.action,
          rec.source,
          JSON.stringify(rec.changes || []),
          asUuid(rec.actorUserId),
          rec.actorLabel || null,
        ]
      );
      await client.query('RELEASE SAVEPOINT sp_identity_audit');
      return 'karate_identity_audit';
    } catch (e) {
      console.warn('[karateStudentIdentityLink] karate_identity_audit falhou — caindo para roster_events:', e && e.code, e && e.message);
      await client.query('ROLLBACK TO SAVEPOINT sp_identity_audit');
    }
  }

  try {
    await client.query(
      `INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [
        rec.dojoId,
        rec.federationId || null,
        rec.action === 'release' ? 'identity_released' : 'identity_adopted',
        JSON.stringify([
          {
            practitioner_id: rec.practitionerId || null,
            practitioner_label: rec.practitionerLabel || null,
            fpkt_number: rec.fpktNumber || null,
            student_id: rec.studentId,
            student_label: rec.studentLabel || null,
            source: rec.source,
            actor_label: rec.actorLabel || null,
            changes: rec.changes || [],
            migration_263_pendente: !probe.hasIdentityAudit,
          },
        ]),
        asUuid(rec.actorUserId),
      ]
    );
    await client.query('RELEASE SAVEPOINT sp_identity_audit');
    return 'karate_dojo_roster_events';
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT sp_identity_audit');
    console.error('[karateStudentIdentityLink] NENHUMA trilha pôde ser gravada — abortando a adoção:', e && e.code, e && e.message);
    throw e;
  }
}

// ============================================================
// UPDATEs (identificadores vêm de IDENTITY_FIELDS, nunca do corpo)
// ============================================================
function buildDojoUpdate({ studentId, dojoId, practitionerId, writes, hasIsFederated }) {
  const vals = [practitionerId];
  const sets = ['practitioner_id = $1'];
  if (hasIsFederated) sets.push('is_federated = true');
  for (const w of writes) {
    vals.push(w.value);
    sets.push(`${w.col} = $${vals.length}`);
  }
  sets.push('updated_at = now()');
  vals.push(studentId, dojoId);
  return {
    sql: `UPDATE karate_dojo_students SET ${sets.join(', ')}
           WHERE id = $${vals.length - 1} AND dojo_id = $${vals.length}
       RETURNING id`,
    vals,
  };
}

function buildFederationUpdate({ practitionerId, dojoId, writes }) {
  const vals = [dojoId];
  const sets = ["karate_identity_managed_by = 'dojo'", 'karate_identity_dojo_id = $1'];
  for (const w of writes) {
    vals.push(w.value);
    sets.push(`${w.col} = $${vals.length}`);
  }
  sets.push('updated_at = now()');
  vals.push(practitionerId);
  return {
    sql: `UPDATE customers SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id`,
    vals,
  };
}

// 23505 pode vir de DOIS lugares diferentes e o operador precisa saber qual.
function mapUniqueViolation(e) {
  const txt = `${(e && e.constraint) || ''} ${(e && e.detail) || ''} ${(e && e.message) || ''}`;
  if (/cpf/i.test(txt)) {
    return svcError(409, 'CPF_DUPLICADO_NO_DOJO', 'O CPF que veio da federação já pertence a outro aluno deste dojô. Confira os dois cadastros antes de vincular.');
  }
  return svcError(409, 'PRATICANTE_JA_VINCULADO', 'Este praticante acabou de ser vinculado a outro aluno. Recarregue a tela e confira.');
}

// ============================================================
// API PÚBLICA — POST /dojo/students/:sid/federate
// ============================================================
async function federateByNumber({
  dojoId,
  federationId,
  studentId,
  rawNumber,
  confirm = false,
  resolution = null,
  actor = null,
} = {}) {
  const number = normalizeFpktNumber(rawNumber);
  if (!number) {
    throw svcError(422, 'VALIDATION_ERROR', 'Informe o número FPKT do aluno');
  }

  const probe = await loadSchemaProbe();
  const q = (sql, params) => db.query(sql, params);

  // Ordem preservada da F5a: aluno primeiro (404 NOT_FOUND escopado pelo
  // token), depois o número (404 FPKT_NUMBER_NOT_FOUND). Trocar a ordem
  // vazaria a existência de praticantes para um dojô que errou o :sid.
  const student = await loadStudent(q, dojoId, studentId, probe, false);
  const practitioner = await loadPractitionerByNumber(q, federationId, number, probe, false);

  const alreadyLinked = String(student.practitioner_id || '') === String(practitioner.id);
  const isRelink = Boolean(student.practitioner_id) && !alreadyLinked;

  const claim = await loadGlobalClaim(q, practitioner.id, studentId);
  const comparison = buildComparison(student, practitioner);
  const blockers = buildBlockers({ student, practitioner, claim, dojoId });
  const canLink = blockers.length === 0;
  const isTransfer = Boolean(practitioner.dojo_id) && String(practitioner.dojo_id) !== String(dojoId);

  const resolved = validateResolution(resolution);

  if (!confirm) {
    return {
      preview: true,
      linked: false, // clientes antigos não podem achar que gravou
      student_id: studentId,
      practitioner: practitionerPayload(practitioner, number),
      is_transfer: isTransfer,
      is_relink: isRelink,
      already_linked: alreadyLinked,
      can_link: canLink,
      blockers,
      comparison,
      // Sem a 262 o lado do dojô de RG/endereço/foto não é legível: as
      // linhas vêm com dojo_value null. A flag diz ao front que "vazio"
      // ali significa "ainda não dá para saber", não "não preenchido".
      schema_pending: !probe.hasStudentIdentity || !probe.hasCustomerIdentity,
    };
  }

  if (!canLink) {
    const first = blockers[0];
    throw svcError(409, first.code, first.message, {
      blockers,
      // Renomeamos PRACTITIONER_JA_VINCULADO → PRATICANTE_JA_VINCULADO
      // (contrato final da F7.1). legacy_code existe só para o app não
      // quebrar entre um deploy e outro.
      legacy_code: first.code === 'PRATICANTE_JA_VINCULADO' ? 'PRACTITIONER_JA_VINCULADO' : undefined,
    });
  }

  if (!probe.hasCustomerIdentity) {
    throw svcError(
      503,
      'SCHEMA_PENDING_262',
      'A conferência funciona, mas a adoção da ficha depende da migration 262 (karate_identity_managed_by), que ainda não foi aplicada. Nada foi gravado. Tente de novo depois que a migration rodar.'
    );
  }

  const plan = planResolution(comparison, resolved, student, practitioner);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const tx = (sql, params) => client.query(sql, params);

    // Reler COM LOCK: entre o preview e o confirm o mundo pode ter mudado
    // (outro sensei federando o mesmo número, a ficha sendo editada). As
    // travas são reavaliadas AQUI DENTRO — o preview é informação, não
    // autorização.
    const lockedStudent = await loadStudent(tx, dojoId, studentId, probe, true);
    const lockedPractitioner = await loadPractitionerByNumber(tx, federationId, number, probe, true);
    const lockedClaim = await loadGlobalClaim(tx, lockedPractitioner.id, studentId);
    const lockedBlockers = buildBlockers({
      student: lockedStudent,
      practitioner: lockedPractitioner,
      claim: lockedClaim,
      dojoId,
    });
    if (lockedBlockers.length) {
      await client.query('ROLLBACK');
      const first = lockedBlockers[0];
      throw svcError(409, first.code, first.message, { blockers: lockedBlockers });
    }

    // Trocar de praticante devolve o ANTERIOR à federação. Sem isto, um
    // vínculo desfeito por engano deixaria um praticante "adotado" por um
    // dojô que não o reivindica mais — órfão com dono.
    const previousPractitionerId = lockedStudent.practitioner_id;
    if (previousPractitionerId && String(previousPractitionerId) !== String(lockedPractitioner.id)) {
      await client.query(
        `UPDATE customers
            SET karate_identity_managed_by = 'federation',
                karate_identity_dojo_id = NULL,
                updated_at = now()
          WHERE id = $1 AND karate_identity_dojo_id = $2`,
        [previousPractitionerId, dojoId]
      );
    }

    const dojoUpd = buildDojoUpdate({
      studentId,
      dojoId,
      practitionerId: lockedPractitioner.id,
      writes: plan.dojoWrites,
      hasIsFederated: probe.hasIsFederated,
    });
    const updRes = await client.query(dojoUpd.sql, dojoUpd.vals);
    if (!updRes.rows.length) {
      await client.query('ROLLBACK');
      throw svcError(404, 'NOT_FOUND', 'Aluno não encontrado neste dojô');
    }

    const fedUpd = buildFederationUpdate({
      practitionerId: lockedPractitioner.id,
      dojoId,
      writes: plan.fedWrites,
    });
    await client.query(fedUpd.sql, fedUpd.vals);

    const auditTable = await writeIdentityAudit(client, probe, {
      federationId,
      dojoId,
      practitionerId: lockedPractitioner.id,
      practitionerLabel: lockedPractitioner.full_name || null,
      fpktNumber: number,
      studentId,
      studentLabel: lockedStudent.full_name || null,
      action: 'adopt',
      source: 'dojo_federate',
      changes: plan.applied,
      actorUserId: actor && actor.userId,
      actorLabel: actor && actor.label,
    });

    await client.query('COMMIT');

    return {
      linked: true,
      preview: false,
      student_id: studentId,
      federated: true,
      federation_link_status: 'linked',
      is_transfer: isTransfer,
      adopted: true,
      identity_managed_by: 'dojo',
      applied: plan.applied.map((a) => ({ field: a.field, from: a.from, value: a.value })),
      audit_table: auditTable,
      practitioner: Object.assign(practitionerPayload(lockedPractitioner, number), {
        identity_managed_by: 'dojo',
        identity_dojo_id: dojoId,
      }),
    };
  } catch (e) {
    // ROLLBACK best-effort SÓ na saída de erro (a conexão pode ter caído);
    // não é try/catch best-effort DENTRO do BEGIN.
    try { await client.query('ROLLBACK'); } catch (_) { /* conexão pode ter caído */ }
    if (e && e.status) throw e;
    if (e && e.code === '23505') throw mapUniqueViolation(e);
    if (e && (e.code === '42703' || e.code === '42P01')) {
      _resetSchemaCache(); // a sonda mentiu: force nova leitura no próximo pedido
      console.error('[karateStudentIdentityLink] schema divergente na confirmação:', e.code, e.message);
      throw svcError(503, 'SCHEMA_PENDING_262', 'A adoção da ficha depende de uma migration ainda não aplicada (262/263). Nada foi gravado.');
    }
    throw e;
  } finally {
    client.release();
  }
}

// ============================================================
// API PÚBLICA — DELETE /dojo/students/:sid/federate
// ============================================================
// Desvincular passa a DEVOLVER A GESTÃO à federação. Continua sem apagar
// NADA em customers: o praticante segue existindo com número, faixa e
// histórico — só volta a ser a federação quem digita a ficha dele.
async function unfederateStudent({ dojoId, studentId, federationId = null, actor = null } = {}) {
  const probe = await loadSchemaProbe();

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const cur = await client.query(
      `SELECT s.id, s.full_name, s.practitioner_id
         FROM karate_dojo_students s
        WHERE s.id = $1 AND s.dojo_id = $2
        LIMIT 1 FOR UPDATE`,
      [studentId, dojoId]
    );
    if (!cur.rows.length) {
      await client.query('ROLLBACK');
      throw svcError(404, 'NOT_FOUND', 'Aluno não encontrado neste dojô');
    }
    const previousPractitionerId = cur.rows[0].practitioner_id || null;

    const sets = ['practitioner_id = NULL'];
    if (probe.hasIsFederated) sets.push('is_federated = false');
    sets.push('updated_at = now()');
    await client.query(
      `UPDATE karate_dojo_students SET ${sets.join(', ')}
        WHERE id = $1 AND dojo_id = $2 RETURNING id`,
      [studentId, dojoId]
    );

    // Devolver a gestão só faz sentido se ela era DESTE dojô. O
    // `AND karate_identity_dojo_id = $2` é o que impede um dojô de
    // "devolver" a ficha que outro dojô adotou.
    let identityReturned = false;
    if (previousPractitionerId && probe.hasCustomerIdentity) {
      const back = await client.query(
        `UPDATE customers
            SET karate_identity_managed_by = 'federation',
                karate_identity_dojo_id = NULL,
                updated_at = now()
          WHERE id = $1 AND karate_identity_dojo_id = $2
      RETURNING id, name, karate_registration_number`,
        [previousPractitionerId, dojoId]
      );
      identityReturned = back.rows.length > 0;

      if (identityReturned) {
        await writeIdentityAudit(client, probe, {
          federationId,
          dojoId,
          practitionerId: previousPractitionerId,
          practitionerLabel: back.rows[0].name || null,
          fpktNumber: back.rows[0].karate_registration_number || null,
          studentId,
          studentLabel: cur.rows[0].full_name || null,
          action: 'release',
          source: 'dojo_unfederate',
          changes: [
            {
              field: 'karate_identity_managed_by',
              label: 'Gestão da ficha',
              winner: 'federation',
              federation_before: 'dojo',
              federation_after: 'federation',
            },
          ],
          actorUserId: actor && actor.userId,
          actorLabel: actor && actor.label,
        });
      }
    }

    await client.query('COMMIT');

    return {
      unlinked: true,
      id: studentId,
      student_id: studentId,
      federated: false,
      practitioner_id: null,
      fpkt_number: null,
      federation_link_status: 'none',
      // Novos na F7.1: o front mostra "a ficha voltou para a federação".
      identity_returned: identityReturned,
      identity_managed_by: identityReturned ? 'federation' : null,
      schema_pending: !probe.hasCustomerIdentity,
    };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* conexão pode ter caído */ }
    if (e && e.status) throw e;
    if (e && (e.code === '42703' || e.code === '42P01')) {
      _resetSchemaCache();
      console.error('[karateStudentIdentityLink] schema divergente ao desvincular:', e.code, e.message);
    }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  IDENTITY_FIELDS,
  federateByNumber,
  unfederateStudent,
  // Exportados para teste/inspeção — a comparação é a regra de negócio
  // deste PR e precisa ser testável sem subir o Express inteiro.
  buildComparison,
  buildBlockers,
  planResolution,
  compareKey,
  _resetSchemaCache,
};
