// ============================================================
// AURA DOJÔ — F2: Service de alunos do dojô (registro PRÓPRIO)
//
// DECISÃO CENTRAL: o aluno do dojô NÃO é o praticante federado
// (karate_practitioners/customers, que são da FEDERAÇÃO). É um registro
// próprio do dojô em karate_dojo_students (migration 242).
//
// F5a (26/07/2026) — QUEM FEDERA É O SENSEI, A FEDERAÇÃO CONFIRMA:
//   practitioner_id deixou de ser "vínculo futuro" e passou a ser gravado
//   por dois caminhos, ambos reusando o que já existia:
//     1) o aluno JÁ tem número FPKT → lookupByFpktNumber (H1) confirma e
//        o vínculo é gravado na hora;
//     2) o aluno é NOVO na federação → abre a solicitação H1
//        (createPractitionerRequest) com student_id; quando a federação
//        aprova, o practitioner_id volta para o aluno.
//   is_federated (migration 253) é a DECLARAÇÃO do sensei;
//   practitioner_id é a CONFIRMAÇÃO. Aluno não federado é cadastro
//   privado do dojô e a federação não o enxerga.
//
// F7.0 (30/07/2026) — O FLUXO DE INFORMAÇÃO SOBE: dojô → federação.
//   "A federação não faz gestão de informação. O trabalho dela é apenas
//    receber a sincronização dos dados gerenciados pelos dojôs." (Caio)
//   Consequência prática AQUI: a ficha do aluno passa a ter onde guardar a
//   identidade INTEIRA da pessoa — RG, endereço completo e foto de
//   carteirinha (migration 262) —, campos que a ficha H1 exige e que até
//   hoje só existiam do lado da federação. Sem isso, "o dojô é a fonte da
//   identidade" seria uma frase sem coluna.
//   SEXO: a borda de escrita ACEITA os dois vocabulários ('M'/'F'/'other'
//   e 'masculino'/'feminino'/'outro') via src/utils/personIdentity.js e
//   continua GRAVANDO M/F/other — zero mudança visível no app.
//   FOTO: karate_photo_url (nome idêntico ao lado da federação) substitui
//   photo_url, que sempre foi coluna morta. photo_url continua aceita e a
//   leitura devolve COALESCE(karate_photo_url, photo_url).
//
// F7.1 (30/07/2026): federar virou CONFERIR-DEPOIS-ADOTAR, em
//   services/karateStudentIdentityLink.js. A rota deixou de chamar daqui.
//
// F7.2 (30/07/2026) — SINCRONIZAÇÃO CONTÍNUA (o que este PR faz aqui):
//   Até agora a identidade era copiada UMA VEZ, no instante do vínculo
//   (F7.1). Editar o aluno depois disso não mexia em nada na federação: no
//   dia seguinte a ficha divergia de novo. Agora, quando um aluno cujo
//   praticante está ADOTADO POR ESTE DOJÔ tem a identidade alterada, o
//   praticante recebe a mesma alteração, na MESMA transação, com trilha.
//   A regra, o que sobe, o que nunca sobe e a decisão sobre campo
//   esvaziado moram em services/karateIdentitySync.js — aqui só ficam os
//   dois PONTOS DE ENTRADA (PATCH e import), porque são os dois lugares
//   onde a ficha do aluno muda.
//
//   POR QUE A TRANSAÇÃO É CONDICIONAL: updateStudent só abre BEGIN quando
//   há o que sincronizar (o PATCH tocou em identidade E o aluno tem
//   practitioner_id E a 262 está aplicada). O caminho comum — mudar faixa,
//   status, observação, ou editar um aluno não federado — continua sendo
//   exatamente as duas queries de sempre. Transacionar sempre custaria
//   BEGIN/COMMIT em todo salvamento de aluno para servir a um caso que
//   hoje é minoria absoluta (6 alunos de dojô, 0 adotados).
//
//   REMOVIDO NESTE PR (limpeza prevista pela F7.1):
//   federateStudentByFpktNumber, unfederateStudent e o writeFederationLink
//   que só eles usavam. Estavam sem NENHUM chamador desde que a rota
//   passou a usar karateStudentIdentityLink — auditado arquivo a arquivo
//   em src/ e tests/ antes de apagar. federateStudentByRequest (caminho 2,
//   solicitação H1) CONTINUA vivo e é chamado pela rota.
//
// F10 (04/08/2026) — FILIAÇÃO: mãe e pai (migration 272, PARENTAGE_COLS).
//   Filiação (identidade da pessoa) — não é o mesmo conceito que
//   karate_dojo_guardians (o RESPONSÁVEL: quem paga/recebe cobrança e é o
//   contato de emergência). Os dois podem não coincidir e um aluno pode
//   ter mãe/pai registrados sem ter responsável vinculado (ou vice-versa).
//   Por isso mother_name/father_name são colunas NOVAS em
//   karate_dojo_students — nunca um substituto do guardian_id.
//   `customers` (praticante da federação) NÃO tem coluna equivalente hoje
//   (conferido em produção) — então mother_name/father_name NÃO entram em
//   IDENTITY_FIELDS nem em GUARDIAN_SYNC_FIELDS
//   (karateStudentIdentityLink.js) e por consequência não entram na
//   guarda de karateIdentityWriteGuard.js: não há disputa de lista para
//   uma coluna que só existe de um lado. Se um dia a federação ganhar
//   filiação, aí sim isso entra no sync — decisão de outro PR.
//
// F11 (09/08/2026) — TAGS configuráveis (migration 274,
//   karateDojoTagService.js). "Academia" da planilha real do Areikan virou
//   tag, não unidade/dojô separado. Ver comentário de listStudentsPaged.
//
// F12 (10/08/2026) — IMPORTADOR: ficha completa da planilha real (Areikan
//   Karatê-Dô, 484 alunos, 15 colunas). O import saía de 8 campos
//   (full_name/birth_date/cpf/phone/email/belt_label/guardian_name/
//   guardian_phone) para 15 colunas da planilha real, perdendo status
//   ativo/inativo (254 dos 484 entrariam ATIVOS por engano), endereço,
//   RG, Mãe, Pai e Academia. Ver o comentário completo em importStudents.
//
// F13 (12/08/2026) — DOIS RESPONSÁVEIS POR ALUNO (migration 280,
//   services/karateDojoStudentGuardians.js). "Vamos usar os dois contatos
//   separados, penso que em um caso de emergência com uma criança, é bom
//   ter o contato de ambos." (Caio). guardian_id (FK singular) continua
//   existindo e continua sendo o responsável PRINCIPAL — o vínculo N:N
//   vive em karate_dojo_student_guardians e é ADITIVO. Toda a mecânica
//   (buscar-ou-criar, upsert, rebaixar o principal, o fragmento de SQL da
//   ficha) mora no módulo próprio; aqui ficam só os pontos de entrada:
//   getStudent (leitura), createStudent/updateStudent (o corpo aceita
//   `guardians: [...]`) e importStudents (mãe E pai).
//
// F14 (13/08/2026) — O IMPORT PASSOU A CUSTAR POR LOTE, NÃO POR LINHA, e
//   a transação ganhou teto de ociosidade. Os dois vieram do mesmo
//   incidente de produção (484 alunos do Areikan): mais de 60s para 100
//   linhas, e uma transação `idle in transaction` de OITO MINUTOS quando
//   o cliente HTTP desistiu. Ver o cabeçalho de importStudents e a
//   migration 281.
//
// Família é entidade de primeira classe (billing familiar na F3):
// responsável em karate_dojo_guardians; um responsável → N alunos.
//
// Regra da casa "dado faltante ≠ pendência": campo ausente é neutro e
// salvar incompleto é permitido silenciosamente; campo INVÁLIDO é erro
// (422). EXCEÇÃO (espelha migrations 197/231 — LGPD): menor de 18 sem
// responsável vinculado → 422 MENOR_SEM_RESPONSAVEL no create/update que
// torne isso verdadeiro. O import em lote é TOLERANTE: importa mesmo
// assim, com warning na resposta (o bloqueio é só no form).
//
// PAGINAÇÃO (QA 27/07/2026): a lista tinha LIMIT 1000 FIXO e ignorava o
// limit do cliente — limit=50 e limit=200 devolviam os mesmos 205 alunos
// (105 KB). Agora é limit/offset de verdade, com o total (sem paginação)
// vindo por count(*) OVER() na MESMA query.
//
// Idade tz-safe: birth_date é date puro — NUNCA new Date('YYYY-MM-DD')
// (interpretaria como UTC e voltaria um dia em UTC-3); split manual.
// Todas as leituras de date usam to_char(...,'YYYY-MM-DD') para o driver
// não converter para Date com timezone.
// ============================================================
'use strict';

const { randomUUID } = require('crypto');
const db = require('../config/database');
const { createPractitionerRequest } = require('./karatePractitionerRequestCreate');
const identitySync = require('./karateIdentitySync');
const guardianLinks = require('./karateDojoStudentGuardians');
const { normalizeCpf, toDojoSex, normalizeUf, normalizeZipCode } = require('../utils/personIdentity');
const {
  normalizeBeltLevel,
  colorOf,
  isLegacyOnlyLevel,
  parseDegreeFromName,
  beltDisplayRank,
  beltLabel: formatCanonicalBeltLabel,
} = require('../utils/karateBeltScale');

const VALID_STATUS = ['active', 'inactive'];
const VALID_SEX_VALUES = ['M', 'F', 'other'];
const IMPORT_MAX_ROWS = 500;

// F14 — teto de OCIOSIDADE DENTRO da transação do import (não é o tempo
// total da operação: é o intervalo máximo entre dois comandos com a
// transação aberta, que é o que ficou em 8 minutos no incidente de
// 13/08/2026). Depois da reescrita em lote, o maior intervalo legítimo
// aqui é o tempo de o Node montar 21 arrays de até 500 posições —
// milissegundos. 60s é três ordens de grandeza de folga sobre isso e
// metade do default que a migration 281 grava no banco para todas as
// outras rotas: a operação que causou o incidente fica com o limite mais
// apertado, e nenhuma outra fica desprotegida.
//
// String literal, sem interpolação: `SET LOCAL` não aceita parâmetro
// ($1), e montar SQL por template é como o repo já quebrou antes.
const IMPORT_IDLE_IN_TX_GUARD_SQL =
  "SET LOCAL idle_in_transaction_session_timeout = '60s'";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Marcas combinantes (acentos) para o strip de NFD do import. Construída
// com escapes ASCII de propósito: escrita como literal de regex, o
// intervalo U+0300–U+036F fica com os caracteres COMBINANTES crus no
// fonte — invisíveis no editor e no diff, e reclamados pelo eslint
// `no-misleading-character-class`. Mesma correção já feita em
// src/routes/transactionsBatch.js (PR #490). Constante única e
// compartilhada: /g em String.replace não guarda lastIndex.
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

// Paginação da lista de alunos. 100 cobre a tela; 500 é o teto para quem
// exporta/imprime sem virar payload de 100 KB de novo.
const LIST_DEFAULT_LIMIT = 100;
const LIST_MAX_LIMIT = 500;

// F7.0 — identidade da pessoa (migration 262). Lista ÚNICA: alimenta o
// SELECT, o INSERT, o UPDATE e o fallback de schema. Uma lista só evita a
// divergência clássica "adicionei no PATCH e esqueci no POST".
const IDENTITY_COLS = [
  'rg', 'zip_code', 'street', 'number', 'complement',
  'neighborhood', 'city', 'state', 'karate_photo_url',
];

// F10 — filiação (migration 272). Lista SEPARADA de IDENTITY_COLS de
// propósito: colunas de uma migration DIFERENTE (272, não 262) e com
// probe de schema PRÓPRIO. Misturar as duas degradaria RG/endereço junto
// se só mother_name/father_name estivessem faltando (ou vice-versa) —
// exatamente o erro que uma lista única evitaria, ao contrário.
const PARENTAGE_COLS = ['mother_name', 'father_name'];

// F7.2 — quais colunas do ALUNO disparam sincronização com a federação.
// NÃO é uma lista nova: vem de karateIdentitySync, que por sua vez a tira
// de IDENTITY_FIELDS (F7.1). Nome, nascimento, CPF e sexo entram aqui e
// NÃO estão em IDENTITY_COLS — são de antes da 262 e mesmo assim são
// identidade da pessoa. mother_name/father_name (F10, migration 272) NÃO
// entram aqui: `customers` não tem coluna equivalente hoje, então não há
// para onde sincronizar (ver cabeçalho do arquivo).
const SYNCED_IDENTITY_COLS = identitySync.DOJO_COLUMNS;

function svcError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

// limit/offset chegam como string da query — lixo vira default (nunca 422:
// "dado faltante ≠ pendência" também vale para parâmetro de paginação).
function parsePaging({ limit, offset } = {}) {
  let l = Number(limit);
  if (!Number.isFinite(l) || l <= 0) l = LIST_DEFAULT_LIMIT;
  l = Math.min(Math.floor(l), LIST_MAX_LIMIT);

  let o = Number(offset);
  if (!Number.isFinite(o) || o < 0) o = 0;
  return { limit: l, offset: Math.floor(o) };
}

// ── Schema em deploy parcial (CLAUDE.md #1/#10) ──
// O backend sobe ANTES da migration. Flags module-level: na primeira
// 42703/42P01 das colunas NOVAS, degradamos e seguimos servindo a lista —
// esconder os alunos porque uma coluna ainda não existe seria muito pior
// que mostrar todo mundo como não federado / sem endereço.
let HAS_IS_FEDERATED_COL = true;      // migration 253
let HAS_REQUEST_STUDENT_ID_COL = true; // migration 253
let HAS_IDENTITY_COLS = true;          // migration 262 (F7.0)
let HAS_PARENTAGE_COLS = true;         // migration 272 (F10)

// Sem a coluna, practitioner_id NOT NULL é a melhor verdade disponível
// (é o vínculo real; is_federated é só a declaração).
function isFederatedExpr(p) {
  return HAS_IS_FEDERATED_COL ? `${p}is_federated` : `(${p}practitioner_id IS NOT NULL)`;
}

function pendingRequestExpr(p) {
  return HAS_REQUEST_STUDENT_ID_COL
    ? `EXISTS (SELECT 1 FROM karate_practitioner_requests pr_req
                 WHERE pr_req.student_id = ${p}id AND pr_req.status = 'pendente')`
    : 'false';
}

// Campos federativos ADITIVOS, sempre na MESMA query da leitura do aluno —
// nenhuma query nova entra na frente de nada (armadilha da fila de mocks).
function federationFields(p) {
  return (
    `${isFederatedExpr(p)} AS is_federated, ` +
    `${pendingRequestExpr(p)} AS has_pending_request, ` +
    `fp.karate_registration_number AS fpkt_number, fp.name AS practitioner_name`
  );
}

function federationJoin(p) {
  return `LEFT JOIN customers fp ON fp.id = ${p}practitioner_id`;
}

// F7.0: quando a migration 262 ainda não rodou, as colunas de identidade
// viram NULL::text com o MESMO alias — o shape da resposta não muda de
// formato, só vem vazio. Nenhuma query extra, nenhum campo some do JSON.
function identityFields(p) {
  if (!HAS_IDENTITY_COLS) {
    return IDENTITY_COLS.map((c) => `NULL::text AS ${c}`).join(', ');
  }
  return IDENTITY_COLS.map((c) => `${p}${c}`).join(', ');
}

// F10 — mesma mecânica de identityFields, para a filiação (migration 272).
function parentageFields(p) {
  if (!HAS_PARENTAGE_COLS) {
    return PARENTAGE_COLS.map((c) => `NULL::text AS ${c}`).join(', ');
  }
  return PARENTAGE_COLS.map((c) => `${p}${c}`).join(', ');
}

function isFederationSchemaError(e) {
  if (!e || (e.code !== '42703' && e.code !== '42P01')) return false;
  // Só degrada por causa das coisas NOVAS. 42P01 de karate_dojo_students
  // continua subindo (a rota responde schema_pending, migration 242).
  return /is_federated|student_id|karate_practitioner_requests/i.test(e.message || '');
}

// Só 42703 (coluna): a AUSÊNCIA da tabela nunca é problema de identidade.
function isIdentitySchemaError(e) {
  if (!e || e.code !== '42703') return false;
  return new RegExp(`\\b(${IDENTITY_COLS.join('|')})\\b`, 'i').test(e.message || '');
}

// F10 — mesmo mecanismo, PROBE PRÓPRIO (migration 272 é um boundary
// diferente da 262). Ver comentário de PARENTAGE_COLS.
function isParentageSchemaError(e) {
  if (!e || e.code !== '42703') return false;
  return new RegExp(`\\b(${PARENTAGE_COLS.join('|')})\\b`, 'i').test(e.message || '');
}

// UMA única retentativa degradada (armadilha "retry chain 42P01": nunca
// re-tentar em cadeia — se falhar de novo, o erro sobe). As duas famílias
// de flag são avaliadas no MESMO catch para que um ambiente sem 253 E sem
// 262 degrade de uma vez, em vez de exigir duas voltas.
async function withStudentSchemaFallback(run) {
  try {
    return await run();
  } catch (e) {
    let degraded = false;

    if (HAS_IDENTITY_COLS && isIdentitySchemaError(e)) {
      HAS_IDENTITY_COLS = false;
      degraded = true;
      console.warn('[karateDojoStudentService] schema da F7.0 ausente (migration 262 pendente) — degradando identidade:', e.message);
    }

    if (HAS_PARENTAGE_COLS && isParentageSchemaError(e)) {
      HAS_PARENTAGE_COLS = false;
      degraded = true;
      console.warn('[karateDojoStudentService] schema da F10 ausente (migration 272 pendente) — degradando filiação:', e.message);
    }

    // F13: a tabela de vínculo é NOVA (migration 280). Mesma família de
    // degradação: sem ela a ficha volta a ter UM responsável, nunca deixa
    // de ser servida. O módulo decide (e loga) — aqui só marcamos que
    // vale UMA retentativa.
    if (guardianLinks.noteSchemaError(e)) degraded = true;

    if ((HAS_IS_FEDERATED_COL || HAS_REQUEST_STUDENT_ID_COL) && isFederationSchemaError(e)) {
      HAS_IS_FEDERATED_COL = false;
      HAS_REQUEST_STUDENT_ID_COL = false;
      degraded = true;
      console.warn('[karateDojoStudentService] schema da F5a ausente (migration 253 pendente) — degradando:', e.message);
    }

    if (!degraded) throw e;
    return run();
  }
}

// ── Datas / idade (tz-safe: split manual, nunca new Date('YYYY-MM-DD')) ──
function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function computeAge(birthDateStr, refDateStr = null) {
  if (!birthDateStr) return null;
  const raw = String(birthDateStr).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [y, m, d] = raw.split('-').map(Number);
  let ry, rm, rd;
  if (refDateStr) {
    [ry, rm, rd] = String(refDateStr).slice(0, 10).split('-').map(Number);
  } else {
    const now = new Date();
    ry = now.getFullYear();
    rm = now.getMonth() + 1;
    rd = now.getDate();
  }
  let age = ry - y;
  if (rm < m || (rm === m && rd < d)) age--;
  return age;
}

function isMinor(birthDateStr) {
  const age = computeAge(birthDateStr);
  return age != null && age < 18;
}

// ── Validações de payload (form: inválido = erro; ausente = neutro) ──
function validateStudentPayload(body, { partial = false } = {}) {
  const b = body || {};
  const errors = [];
  const data = {};

  if (!partial || b.full_name !== undefined) {
    const name = b.full_name != null ? String(b.full_name).trim() : '';
    if (!name) errors.push('Campo full_name é obrigatório');
    else data.full_name = name;
  }

  for (const field of ['birth_date', 'enrolled_at']) {
    if (b[field] === undefined) continue;
    if (b[field] === null || String(b[field]).trim() === '') {
      data[field] = null;
    } else {
      const v = String(b[field]).trim();
      if (!isValidDateStr(v)) errors.push(`${field} deve ser uma data válida no formato YYYY-MM-DD`);
      else data[field] = v;
    }
  }

  if (b.cpf !== undefined) {
    if (b.cpf === null || String(b.cpf).trim() === '') {
      data.cpf = null;
    } else {
      // F7.0: helper único (src/utils/personIdentity.js) — o mesmo que a
      // borda da federação usa. O UNIQUE (dojo_id, cpf) depende disso.
      const digits = normalizeCpf(b.cpf);
      if (!digits || digits.length !== 11) errors.push('cpf inválido (esperados 11 dígitos)');
      else data.cpf = digits;
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

  if (b.sex !== undefined) {
    if (b.sex === null || b.sex === '') data.sex = null;
    else {
      // F7.0: ACEITA os dois vocabulários, GRAVA o do dojô (M/F/other).
      // 'masculino' entra sem quebrar nada; 'xyz' continua sendo 422.
      const dojoSex = toDojoSex(b.sex);
      if (!dojoSex) errors.push(`sex inválido. Use: ${VALID_SEX_VALUES.join(', ')}`);
      else data.sex = dojoSex;
    }
  }

  if (b.status !== undefined) {
    if (!VALID_STATUS.includes(b.status)) errors.push(`status inválido. Use: ${VALID_STATUS.join(', ')}`);
    else data.status = b.status;
  }

  if (b.belt_order !== undefined) {
    if (b.belt_order === null || b.belt_order === '') data.belt_order = null;
    else if (!Number.isInteger(Number(b.belt_order))) errors.push('belt_order deve ser um inteiro');
    else data.belt_order = Number(b.belt_order);
  }

  if (b.consent_lgpd !== undefined) {
    data.consent_lgpd = b.consent_lgpd === true || b.consent_lgpd === 'true';
  }

  for (const field of ['phone', 'photo_url', 'belt_label', 'notes']) {
    if (b[field] === undefined) continue;
    data[field] = b[field] != null && String(b[field]).trim() !== '' ? String(b[field]).trim() : null;
  }

  // ── F7.0: identidade da pessoa (migration 262) ──
  // Whitelist explícita, mesmo espírito de UPDATABLE_COLS: nada entra por
  // spread do body. Texto livre é neutro; CEP e UF têm forma conhecida e
  // por isso são 422 quando vêm errados ("inválido é erro").
  for (const field of ['rg', 'street', 'number', 'complement', 'neighborhood', 'city', 'karate_photo_url']) {
    if (b[field] === undefined) continue;
    data[field] = b[field] != null && String(b[field]).trim() !== '' ? String(b[field]).trim() : null;
  }

  if (b.zip_code !== undefined) {
    if (b.zip_code === null || String(b.zip_code).trim() === '') {
      data.zip_code = null;
    } else {
      const cep = normalizeZipCode(b.zip_code);
      if (!cep) errors.push('zip_code inválido (esperados 8 dígitos)');
      else data.zip_code = cep;
    }
  }

  if (b.state !== undefined) {
    if (b.state === null || String(b.state).trim() === '') {
      data.state = null;
    } else {
      const uf = normalizeUf(b.state);
      if (!uf) errors.push('state inválido (esperada a UF com 2 letras)');
      else data.state = uf;
    }
  }

  // ── F10: filiação — mãe e pai (migration 272) ──
  // Texto livre, mesmo tratamento de rg/street/etc acima: ausente é
  // neutro (não entra em `data`), string vazia vira null explícito
  // (permite apagar o campo num PATCH), valor não-vazio é trim().
  for (const field of ['mother_name', 'father_name']) {
    if (b[field] === undefined) continue;
    data[field] = b[field] != null && String(b[field]).trim() !== '' ? String(b[field]).trim() : null;
  }

  if (b.guardian_id !== undefined) {
    data.guardian_id = b.guardian_id != null && String(b.guardian_id).trim() !== '' ? String(b.guardian_id).trim() : null;
  }

  // ── F13: a LISTA de responsáveis (migration 280) ──
  // Ausente = neutro (o PATCH não mexe em vínculo nenhum). `null` ou `[]`
  // = escolha EXPLÍCITA de deixar o aluno sem responsável — e aí
  // guardian_id vira null e a regra do menor volta a valer, como deve.
  // Quando `guardians` vem, ele MANDA sobre `guardian_id` no mesmo corpo:
  // é a lista que descreve a intenção inteira (quem entra, quem sai, quem
  // é o principal); guardian_id sozinho só sabe falar de um.
  if (b.guardians !== undefined) {
    const g = guardianLinks.validateGuardiansInput(b.guardians);
    if (g.errors.length) errors.push(...g.errors);
    else data.guardians = g.list;
  }

  return { errors, data };
}

function validateGuardianPayload(body, { partial = false } = {}) {
  const b = body || {};
  const errors = [];
  const data = {};

  if (!partial || b.full_name !== undefined) {
    const name = b.full_name != null ? String(b.full_name).trim() : '';
    if (!name) errors.push('Campo full_name é obrigatório');
    else data.full_name = name;
  }

  if (b.cpf !== undefined) {
    if (b.cpf === null || String(b.cpf).trim() === '') {
      data.cpf = null;
    } else {
      const digits = normalizeCpf(b.cpf);
      if (!digits || digits.length !== 11) errors.push('cpf inválido (esperados 11 dígitos)');
      else data.cpf = digits;
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

  for (const field of ['phone', 'relationship']) {
    if (b[field] === undefined) continue;
    data[field] = b[field] != null && String(b[field]).trim() !== '' ? String(b[field]).trim() : null;
  }

  return { errors, data };
}

// ── Shapes / SQL helpers ──
function studentFields(p) {
  return (
    `${p}id, ${p}full_name, to_char(${p}birth_date, 'YYYY-MM-DD') AS birth_date, ` +
    `${p}cpf, ${p}sex, ${p}phone, ${p}email, ${p}photo_url, ${p}belt_label, ${p}belt_order, ` +
    `${p}status, ${p}guardian_id, ${p}consent_lgpd, ${p}notes, ${p}practitioner_id, ` +
    `to_char(${p}enrolled_at, 'YYYY-MM-DD') AS enrolled_at, ${p}created_at, ${p}updated_at, ` +
    identityFields(p) + ', ' + parentageFields(p)
  );
}

function shapeStudent(row) {
  // federated: a coluna manda quando existe. Quando ela NÃO vem na row
  // (migration 253 pendente, RETURNING de create/update), o vínculo real
  // (practitioner_id) é a verdade — nunca inventamos "federado" do nada.
  const federated = row.is_federated === true || (row.is_federated == null && !!row.practitioner_id);
  // linked  = a federação confirmou (existe praticante vinculado)
  // pending = existe solicitação H1 pendente para este aluno
  // none    = cadastro privado do dojô
  const linkStatus = row.practitioner_id
    ? 'linked'
    : (row.has_pending_request === true ? 'pending' : 'none');

  return {
    id: row.id,
    full_name: row.full_name,
    birth_date: row.birth_date || null,
    age: computeAge(row.birth_date),
    cpf: row.cpf || null,
    sex: row.sex || null,
    phone: row.phone || null,
    email: row.email || null,
    photo_url: row.photo_url || null,
    belt_label: row.belt_label || null,
    belt_order: row.belt_order != null ? Number(row.belt_order) : null,
    status: row.status,
    // EXP2: inadimplência (cobrança pending vencida). Só vem nas queries que
    // selecionam has_overdue (lista + ficha); ausente ⇒ false, nunca undefined.
    has_overdue: row.has_overdue === true,
    guardian_id: row.guardian_id || null,
    guardian: null, // preenchido pelos callers quando disponível (ficha/list)
    // F13 (migration 280) — a LISTA de responsáveis (mãe E pai, cada um
    // com contato próprio). Default [] para o shape ser estável em toda
    // resposta; a ficha (getStudent) e as escritas costuram a lista real.
    // A listagem paginada NÃO traz a lista de propósito: seriam N
    // subqueries num payload que já foi motivo de QA por tamanho.
    guardians: [],
    consent_lgpd: row.consent_lgpd === true,
    notes: row.notes || null,
    practitioner_id: row.practitioner_id || null,
    // ── F5a (aditivo) ──
    federated,
    fpkt_number: row.fpkt_number || null,
    practitioner_name: row.practitioner_name || null,
    federation_link_status: linkStatus,
    // ── F7.0 (aditivo): identidade da pessoa, dona pelo DOJÔ ──
    rg: row.rg || null,
    zip_code: row.zip_code || null,
    street: row.street || null,
    number: row.number || null,
    complement: row.complement || null,
    neighborhood: row.neighborhood || null,
    city: row.city || null,
    state: row.state || null,
    // photo_url é coluna MORTA (migration 242, nenhuma UI escreveu nela).
    // COALESCE mantém compatível quem por acaso tenha algo lá.
    karate_photo_url: row.karate_photo_url || row.photo_url || null,
    // ── F10 (aditivo, migration 272): filiação — mãe e pai ──
    mother_name: row.mother_name || null,
    father_name: row.father_name || null,
    enrolled_at: row.enrolled_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── Consultas ──
// federated: true | false | null (null/ausente = todos)
//
// count(*) OVER() dá o total SEM paginação na PRÓPRIA query — de propósito:
// um SELECT COUNT separado entraria na fila de queries e desalinharia os
// mocks posicionais dos testes que já existem (armadilha conhecida). O
// único caso em que a window function não serve é página VAZIA com offset
// > 0 (não há linha para carregar o total) — aí sim vai um COUNT dedicado.
// EXP2 — inadimplência visível: aluno "inadimplente" = tem cobrança pending
// vencida (due_date < hoje em São Paulo). Subquery correlacionada em
// karate_dojo_charges; se a tabela de billing ainda não existir, o 42P01 sobe
// e é pego pelo catch da rota (schema_pending), como os demais.
const OVERDUE_EXISTS =
  `EXISTS (SELECT 1 FROM karate_dojo_charges kc
            WHERE kc.student_id = s.id AND kc.status = 'pending'
              AND kc.due_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date)`;

async function listStudentsPaged(dojoId, opts = {}) {
  const { status = null, q = null, belt = null, federated = null, tag_id = null, overdue = null } = opts;
  const { limit, offset } = parsePaging(opts);

  // F11: filtro por tag (?tag_id=). O JOIN/EXISTS contra
  // karate_dojo_student_tags só entra na SQL quando tag_id vem preenchido —
  // de propósito: essa tabela é NOVA (migration 274) e pode não existir
  // ainda em produção; se ela aparecesse na query sempre, toda chamada a
  // listStudentsPaged (mesmo sem filtro de tag) quebraria com 42P01 até a
  // migration ser aplicada. Sem tag_id, a query fica byte-idêntica à de
  // antes (mesmos $1..$7). Com tag_id, vira $1..$8 (tag entra antes de
  // limit/offset) e, se a tabela ainda não existir, o 42P01 sobe e é
  // pego pelo catch da ROTA (GET /dojo/students), que já devolve
  // { data:[], count:0, ..., schema_pending:true } — nenhum tratamento
  // extra precisa ser escrito aqui.
  const params = [dojoId, status, q, belt, federated];
  let tagClause = '';
  if (tag_id) {
    params.push(tag_id);
    tagClause = `AND EXISTS (
          SELECT 1 FROM karate_dojo_student_tags dst
           WHERE dst.student_id = s.id AND dst.tag_id = $${params.length}
        )`;
  }
  const overdueClause = overdue ? `AND ${OVERDUE_EXISTS}` : '';
  params.push(limit, offset);
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;

  const { rows } = await withStudentSchemaFallback(() => db.query(
    `SELECT ${studentFields('s.')},
            g.full_name AS guardian_full_name, g.phone AS guardian_phone,
            g.relationship AS guardian_relationship,
            ${federationFields('s.')},
            ${OVERDUE_EXISTS} AS has_overdue,
            count(*) OVER() AS total_count
       FROM karate_dojo_students s
       LEFT JOIN karate_dojo_guardians g ON g.id = s.guardian_id
       ${federationJoin('s.')}
      WHERE s.dojo_id = $1
        AND ($2::text IS NULL OR s.status = $2)
        AND ($3::text IS NULL OR s.full_name ILIKE '%' || $3 || '%'
             OR s.cpf = regexp_replace($3, '\\D', '', 'g'))
        AND ($4::text IS NULL OR s.belt_label = $4)
        AND ($5::boolean IS NULL OR ${isFederatedExpr('s.')} = $5)
        ${tagClause}
        ${overdueClause}
      ORDER BY s.full_name ASC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  ));

  const data = rows.map((r) => {
    const s = shapeStudent(r);
    s.guardian = r.guardian_id
      ? {
          id: r.guardian_id,
          full_name: r.guardian_full_name || null,
          phone: r.guardian_phone || null,
          relationship: r.guardian_relationship || null,
        }
      : null;
    return s;
  });

  let count;
  if (rows.length) {
    count = rows[0].total_count != null ? Number(rows[0].total_count) : rows.length;
  } else if (offset > 0) {
    count = await countStudents(dojoId, { status, q, belt, federated, tag_id, overdue });
  } else {
    count = 0;
  }

  return { data, count, limit, offset };
}

// Só usado quando a página vem vazia com offset > 0 (ver acima).
async function countStudents(dojoId, { status = null, q = null, belt = null, federated = null, tag_id = null, overdue = null } = {}) {
  const params = [dojoId, status, q, belt, federated];
  let tagClause = '';
  if (tag_id) {
    params.push(tag_id);
    tagClause = `AND EXISTS (
          SELECT 1 FROM karate_dojo_student_tags dst
           WHERE dst.student_id = s.id AND dst.tag_id = $${params.length}
        )`;
  }
  const overdueClause = overdue ? `AND ${OVERDUE_EXISTS}` : '';
  const { rows } = await withStudentSchemaFallback(() => db.query(
    `SELECT count(*)::int AS total
       FROM karate_dojo_students s
      WHERE s.dojo_id = $1
        AND ($2::text IS NULL OR s.status = $2)
        AND ($3::text IS NULL OR s.full_name ILIKE '%' || $3 || '%'
             OR s.cpf = regexp_replace($3, '\\D', '', 'g'))
        AND ($4::text IS NULL OR s.belt_label = $4)
        AND ($5::boolean IS NULL OR ${isFederatedExpr('s.')} = $5)
        ${tagClause}
        ${overdueClause}`,
    params
  ));
  return rows.length && rows[0].total != null ? Number(rows[0].total) : 0;
}

// Compat: assinatura antiga (devolve o ARRAY). Sem limit/offset explicitos
// vale o default da paginação.
async function listStudents(dojoId, opts = {}) {
  const page = await listStudentsPaged(dojoId, opts);
  return page.data;
}

async function getSummary(dojoId) {
  const totalsRes = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'active')::int AS active,
            count(*) FILTER (WHERE status = 'inactive')::int AS inactive
       FROM karate_dojo_students
      WHERE dojo_id = $1`,
    [dojoId]
  );
  // Pirâmide de faixas: só alunos ATIVOS contam (inativo sai da pirâmide).
  const beltRes = await db.query(
    `SELECT belt_label, belt_order, count(*)::int AS count
       FROM karate_dojo_students
      WHERE dojo_id = $1 AND status = 'active'
      GROUP BY belt_label, belt_order
      ORDER BY belt_order ASC NULLS LAST, belt_label ASC NULLS LAST`,
    [dojoId]
  );
  const t = totalsRes.rows[0] || { total: 0, active: 0, inactive: 0 };
  return {
    total: Number(t.total) || 0,
    active: Number(t.active) || 0,
    inactive: Number(t.inactive) || 0,
    by_belt: beltRes.rows.map((r) => ({
      belt_label: r.belt_label || null,
      belt_order: r.belt_order != null ? Number(r.belt_order) : null,
      count: Number(r.count) || 0,
    })),
  };
}

async function getStudent(dojoId, studentId) {
  const { rows } = await withStudentSchemaFallback(() => db.query(
    `SELECT ${studentFields('s.')},
            g.full_name AS guardian_full_name, g.cpf AS guardian_cpf,
            g.phone AS guardian_phone, g.email AS guardian_email,
            g.relationship AS guardian_relationship,
            ${federationFields('s.')},
            ${OVERDUE_EXISTS} AS has_overdue,
            ${guardianLinks.guardiansJsonField('s.')}
       FROM karate_dojo_students s
       LEFT JOIN karate_dojo_guardians g ON g.id = s.guardian_id
       ${federationJoin('s.')}
      WHERE s.id = $1 AND s.dojo_id = $2
      LIMIT 1`,
    [studentId, dojoId]
  ));
  if (!rows.length) return null;
  const r = rows[0];
  const s = shapeStudent(r);
  s.guardian = r.guardian_id
    ? {
        id: r.guardian_id,
        full_name: r.guardian_full_name || null,
        cpf: r.guardian_cpf || null,
        phone: r.guardian_phone || null,
        email: r.guardian_email || null,
        relationship: r.guardian_relationship || null,
      }
    : null;
  // F13: a lista completa. O responsável legado (guardian_id) é costurado
  // como PRINCIPAL quando ainda não existe vínculo para ele — é o que
  // mantém a ficha correta ANTES da migration 280 rodar e para qualquer
  // escrita antiga que só tenha mexido em guardian_id.
  s.guardians = guardianLinks.guardiansFromRow(r, s.guardian);
  return s;
}

// F13 — grava os vínculos do aluno e devolve a lista para a resposta.
// SEM transação de propósito: o createStudent/updateStudent comum não
// abre BEGIN e não vai passar a abrir por causa de uma tabela ADITIVA. O
// que garante que nada se perde é a ordem: o responsável PRINCIPAL já foi
// gravado em karate_dojo_students.guardian_id (o campo legado continua
// sendo a verdade da transição) ANTES de chegar aqui.
// Degrada só no schema novo (migration 280 pendente) — qualquer outro
// erro SOBE, porque erro de banco de verdade não pode virar silêncio.
async function persistGuardianLinks(dojoId, studentId, resolved) {
  if (!guardianLinks.hasLinkTable()) return null;
  try {
    await guardianLinks.replaceLinks(db, studentId, resolved);
    return await guardianLinks.listForStudent(dojoId, studentId);
  } catch (e) {
    if (!guardianLinks.noteSchemaError(e)) throw e;
    return null;
  }
}

// F13 — costura a lista gravada na resposta: `guardians` (a lista) e
// `guardian` (o PRINCIPAL, no shape legado que o app já consome).
function applyGuardianListToShape(s, list) {
  if (!Array.isArray(list) || !list.length) return;
  s.guardians = list;
  const primary = guardianLinks.primaryOf(list);
  if (primary) {
    s.guardian = {
      id: primary.id,
      full_name: primary.full_name,
      cpf: primary.cpf,
      phone: primary.phone,
      email: primary.email,
      relationship: primary.relationship,
    };
  }
}

// F13 — resolve `data.guardians` em ids deste dojô e devolve o `data`
// com guardian_id apontando para o PRINCIPAL. Roda ANTES do INSERT/UPDATE
// de propósito: é o que faz a regra do menor (MENOR_SEM_RESPONSAVEL)
// olhar o estado REAL, e não um payload que ainda não virou vínculo.
async function resolveGuardiansIntoData(dojoId, data) {
  if (data.guardians === undefined) return { data, resolved: null };
  const resolved = await guardianLinks.resolveGuardians(db, dojoId, data.guardians || []);
  const primary = guardianLinks.primaryOf(resolved);
  return { data: { ...data, guardian_id: primary ? primary.guardian_id : null }, resolved };
}

async function resolveGuardianOrThrow(dojoId, guardianId) {
  const g = await db.query(
    `SELECT id, full_name, phone, relationship
       FROM karate_dojo_guardians
      WHERE id = $1 AND dojo_id = $2
      LIMIT 1`,
    [guardianId, dojoId]
  );
  if (!g.rows.length) {
    throw svcError(422, 'GUARDIAN_NOT_FOUND', 'Responsável não encontrado neste dojô');
  }
  return g.rows[0];
}

// Colunas/params BASE do INSERT. Os campos da F7.0 são acrescentados DEPOIS
// ($16+), nunca no meio: os testes de integração conferem a posição do
// dojo_id ($1) e do cpf ($4) na fila de params.
const CREATE_BASE_COLS =
  'dojo_id, full_name, birth_date, cpf, sex, phone, email, photo_url, ' +
  'belt_label, belt_order, status, guardian_id, consent_lgpd, notes, enrolled_at';
const CREATE_BASE_VALUES =
  "$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, 'active'), $12, COALESCE($13, false), $14, $15";

async function createStudent(dojoId, data) {
  // F13: quando o corpo traz a LISTA, ela manda — os responsáveis são
  // resolvidos (buscados ou criados) e o PRINCIPAL vira guardian_id.
  const pre = await resolveGuardiansIntoData(dojoId, data);
  data = pre.data;
  const resolvedGuardians = pre.resolved;

  // resolveGuardians já conferiu o escopo (ou criou) cada responsável da
  // lista — repetir a busca aqui seria um round-trip para saber o que
  // acabamos de saber.
  let guardian = null;
  if (data.guardian_id && !resolvedGuardians) {
    guardian = await resolveGuardianOrThrow(dojoId, data.guardian_id);
  }
  // EXCEÇÃO à regra "dado faltante ≠ pendência" (LGPD, espelha migr 197/231):
  // menor de 18 SEM responsável vinculado não pode ser salvo pelo form.
  if (data.birth_date && isMinor(data.birth_date) && !data.guardian_id) {
    throw svcError(422, 'MENOR_SEM_RESPONSAVEL', 'Aluno menor de 18 anos precisa de um responsável vinculado (LGPD). Cadastre o responsável e vincule antes de salvar.');
  }

  const baseParams = [
    dojoId,
    data.full_name,
    data.birth_date !== undefined ? data.birth_date : null,
    data.cpf !== undefined ? data.cpf : null,
    data.sex !== undefined ? data.sex : null,
    data.phone !== undefined ? data.phone : null,
    data.email !== undefined ? data.email : null,
    data.photo_url !== undefined ? data.photo_url : null,
    data.belt_label !== undefined ? data.belt_label : null,
    data.belt_order !== undefined ? data.belt_order : null,
    data.status !== undefined ? data.status : null,
    data.guardian_id !== undefined ? data.guardian_id : null,
    data.consent_lgpd !== undefined ? data.consent_lgpd : null,
    data.notes !== undefined ? data.notes : null,
    data.enrolled_at !== undefined ? data.enrolled_at : null,
  ];

  const attempt = (withIdentity, withParentage) => {
    let cols = CREATE_BASE_COLS;
    let values = CREATE_BASE_VALUES;
    const params = baseParams.slice();
    if (withIdentity) {
      for (const c of IDENTITY_COLS) {
        params.push(data[c] !== undefined ? data[c] : null);
        cols += `, ${c}`;
        values += `, $${params.length}`;
      }
    }
    if (withParentage) {
      for (const c of PARENTAGE_COLS) {
        params.push(data[c] !== undefined ? data[c] : null);
        cols += `, ${c}`;
        values += `, $${params.length}`;
      }
    }
    return db.query(
      `INSERT INTO karate_dojo_students (${cols})
       VALUES (${values})
       RETURNING ${studentFields('')}`,
      params
    );
  };

  let rows;
  try {
    ({ rows } = await attempt(HAS_IDENTITY_COLS, HAS_PARENTAGE_COLS));
  } catch (e) {
    // Defensivo (CLAUDE.md #1): o backend sobe antes das migrations 262/272.
    // Avalia as DUAS famílias no mesmo catch (mesmo espírito de
    // withStudentSchemaFallback) — perder RG/endereço/mãe/pai do cadastro
    // é ruim, não conseguir cadastrar o aluno é inaceitável. UMA
    // retentativa, nunca em cadeia.
    let degraded = false;
    if (HAS_IDENTITY_COLS && isIdentitySchemaError(e)) {
      HAS_IDENTITY_COLS = false;
      degraded = true;
      console.warn('[karateDojoStudentService] identidade F7.0 ausente (migration 262 pendente) — aluno criado sem RG/endereço/foto:', e.message);
    }
    if (HAS_PARENTAGE_COLS && isParentageSchemaError(e)) {
      HAS_PARENTAGE_COLS = false;
      degraded = true;
      console.warn('[karateDojoStudentService] filiação F10 ausente (migration 272 pendente) — aluno criado sem mãe/pai:', e.message);
    }
    if (!degraded) throw e;
    ({ rows } = await attempt(HAS_IDENTITY_COLS, HAS_PARENTAGE_COLS));
  }

  // Aluno recém-criado nunca nasce federado nem com solicitação pendente:
  // shapeStudent devolve federated:false / federation_link_status:'none'
  // sem precisar de NENHUMA query extra (o INSERT não muda de lugar).
  // Pelo mesmo motivo NÃO há sync aqui: sem practitioner_id não existe
  // ficha adotada para receber nada.
  const s = shapeStudent(rows[0]);
  s.guardian = guardian
    ? { id: guardian.id, full_name: guardian.full_name, phone: guardian.phone, relationship: guardian.relationship }
    : null;
  if (resolvedGuardians) {
    applyGuardianListToShape(s, await persistGuardianLinks(dojoId, s.id, resolvedGuardians));
  }
  return s;
}

const UPDATABLE_COLS = [
  'full_name', 'birth_date', 'cpf', 'sex', 'phone', 'email', 'photo_url',
  'belt_label', 'belt_order', 'status', 'guardian_id', 'consent_lgpd',
  'notes', 'enrolled_at',
];

// Whitelist efetiva: os campos da F7.0 só entram quando a migration 262 já
// rodou, e os da F10 só quando a 272 já rodou. Continua sendo whitelist —
// nada vem do spread do body.
function updatableCols() {
  let cols = UPDATABLE_COLS;
  if (HAS_IDENTITY_COLS) cols = cols.concat(IDENTITY_COLS);
  if (HAS_PARENTAGE_COLS) cols = cols.concat(PARENTAGE_COLS);
  return cols;
}

// F7.2: quais colunas de IDENTIDADE este PATCH tocou. `photo_url` (coluna
// morta) NÃO conta de propósito — quem sobe é karate_photo_url.
function touchedIdentityCols(data) {
  return SYNCED_IDENTITY_COLS.filter((c) => data[c] !== undefined);
}

async function updateStudent(dojoId, studentId, data, ctx = {}) {
  // O SELECT que já existia ganhou os campos federativos (mesma query, sem
  // custo de round-trip novo): o PATCH não altera practitioner_id nem
  // is_federated (não estão em UPDATABLE_COLS — federar tem rota própria),
  // então o estado federativo lido aqui vale para a resposta E é o que
  // decide se há sync a fazer.
  const existing = await withStudentSchemaFallback(() => db.query(
    `SELECT ${studentFields('s.')}, ${federationFields('s.')}
       FROM karate_dojo_students s
       ${federationJoin('s.')}
      WHERE s.id = $1 AND s.dojo_id = $2
      LIMIT 1`,
    [studentId, dojoId]
  ));
  if (!existing.rows.length) {
    throw svcError(404, 'NOT_FOUND', 'Aluno não encontrado neste dojô');
  }
  const cur = existing.rows[0];
  if (!Object.keys(data).length) return shapeStudent(cur); // PATCH vazio = no-op

  // F13: idem createStudent — a lista resolve ANTES, para a regra do
  // menor logo abaixo enxergar o estado RESULTANTE de verdade.
  const pre = await resolveGuardiansIntoData(dojoId, data);
  data = pre.data;
  const resolvedGuardians = pre.resolved;

  let guardian = null;
  if (data.guardian_id && !resolvedGuardians) {
    guardian = await resolveGuardianOrThrow(dojoId, data.guardian_id);
  }

  // Estado RESULTANTE (existente + patch): a regra do menor vale para o
  // update que TORNE isso verdadeiro (mudar birth_date ou remover guardian).
  const mergedBirth = data.birth_date !== undefined ? data.birth_date : cur.birth_date;
  const mergedGuardian = data.guardian_id !== undefined ? data.guardian_id : cur.guardian_id;
  if (mergedBirth && isMinor(mergedBirth) && !mergedGuardian) {
    throw svcError(422, 'MENOR_SEM_RESPONSAVEL', 'Aluno menor de 18 anos precisa de um responsável vinculado (LGPD). Vincule um responsável antes de salvar.');
  }

  const buildUpdate = () => {
    const sets = [];
    const vals = [];
    for (const col of updatableCols()) {
      if (data[col] !== undefined) {
        vals.push(data[col]);
        sets.push(`${col} = $${vals.length}`);
      }
    }
    sets.push('updated_at = now()');
    vals.push(studentId, dojoId);
    return {
      sql: `UPDATE karate_dojo_students SET ${sets.join(', ')}
        WHERE id = $${vals.length - 1} AND dojo_id = $${vals.length}
        RETURNING ${studentFields('')}`,
      vals,
    };
  };
  const runUpdate = () => {
    const q = buildUpdate();
    return db.query(q.sql, q.vals);
  };

  // ── F7.2: precisa sincronizar? ──
  // Três condições, todas necessárias:
  //   • o PATCH tocou em campo de IDENTIDADE (faixa/status/observação não);
  //   • o aluno TEM praticante vinculado (sem vínculo não há o que subir);
  //   • a 262 está aplicada (sem ela não existe ficha adotada — e abrir
  //     transação para descobrir isso seria custo puro).
  // Quando alguma falha, o caminho é EXATAMENTE o de sempre: duas queries,
  // sem BEGIN. É o que mantém o salvamento comum barato.
  const touched = touchedIdentityCols(data);
  // F8: trocar/remover o responsável também pode ter o que subir — o
  // RESPONSÁVEL não é uma coluna de SYNCED_IDENTITY_COLS (vive noutra
  // tabela), então `touched` sozinho não veria essa mudança. guardian_id
  // sendo tocado é gatilho por si só, mesmo que nenhuma coluna de
  // identidade do ALUNO tenha mudado.
  const guardianTouched = data.guardian_id !== undefined;
  const needsSync = HAS_IDENTITY_COLS && Boolean(cur.practitioner_id) && (touched.length > 0 || guardianTouched);

  let upd;
  let syncResult = null;

  if (!needsSync) {
    try {
      upd = await runUpdate();
    } catch (e) {
      let degraded = false;
      if (HAS_IDENTITY_COLS && isIdentitySchemaError(e)) {
        HAS_IDENTITY_COLS = false;
        degraded = true;
        console.warn('[karateDojoStudentService] identidade F7.0 ausente (migration 262 pendente) — PATCH aplicado sem RG/endereço/foto:', e.message);
      }
      if (HAS_PARENTAGE_COLS && isParentageSchemaError(e)) {
        HAS_PARENTAGE_COLS = false;
        degraded = true;
        console.warn('[karateDojoStudentService] filiação F10 ausente (migration 272 pendente) — PATCH aplicado sem mãe/pai:', e.message);
      }
      if (!degraded) throw e;
      upd = await runUpdate();
    }
  } else {
    try {
      ({ upd, syncResult } = await updateStudentWithSync({
        dojoId,
        studentId,
        buildUpdate,
        practitionerId: cur.practitioner_id,
        guardianId: mergedGuardian,
        ctx,
      }));
    } catch (e) {
      // A transação inteira já foi revertida (ROLLBACK no catch de lá).
      // UMA retentativa, agora degradada e sem sync — nunca em cadeia.
      // Avalia as DUAS famílias (F7.0 e F10) no mesmo catch, mesmo
      // espírito de withStudentSchemaFallback.
      let degraded = false;
      if (HAS_IDENTITY_COLS && isIdentitySchemaError(e)) {
        HAS_IDENTITY_COLS = false;
        degraded = true;
        console.warn('[karateDojoStudentService] identidade F7.0 ausente (migration 262 pendente) — PATCH refeito sem sync:', e.message);
      }
      if (HAS_PARENTAGE_COLS && isParentageSchemaError(e)) {
        HAS_PARENTAGE_COLS = false;
        degraded = true;
        console.warn('[karateDojoStudentService] filiação F10 ausente (migration 272 pendente) — PATCH refeito sem sync:', e.message);
      }
      if (!degraded) throw e;
      upd = await runUpdate();
      syncResult = { status: 'skipped', synced: false, fields: [], reason: 'SCHEMA_PENDING' };
    }
  }

  // RETURNING não faz JOIN: o estado federativo vem do SELECT acima.
  const s = shapeStudent({
    ...upd.rows[0],
    is_federated: cur.is_federated,
    has_pending_request: cur.has_pending_request,
    fpkt_number: cur.fpkt_number,
    practitioner_name: cur.practitioner_name,
  });
  s.guardian = guardian
    ? { id: guardian.id, full_name: guardian.full_name, phone: guardian.phone, relationship: guardian.relationship }
    : null;
  // Aditivo e só quando houve tentativa: o front mostra "ficha da federação
  // atualizada" — e, se o sync falhou, o sensei FICA SABENDO em vez de
  // achar que subiu. Falha de sync nunca vira erro do salvamento.
  if (syncResult) s.identity_sync = syncResult;
  if (resolvedGuardians) {
    applyGuardianListToShape(s, await persistGuardianLinks(dojoId, studentId, resolvedGuardians));
  }
  return s;
}

// Transação do PATCH com sync. A ordem importa: o aluno é gravado PRIMEIRO
// e o sync vem depois, dentro de SAVEPOINT (dentro de karateIdentitySync) —
// assim uma falha do sync descarta só o sync, e o COMMIT ainda salva o
// aluno. O contrário (sync antes) obrigaria a desfazer o salvamento.
async function updateStudentWithSync({ dojoId, studentId, buildUpdate, practitionerId, guardianId, ctx }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const q = buildUpdate();
    const upd = await client.query(q.sql, q.vals);
    if (!upd.rows.length) {
      await client.query('ROLLBACK');
      throw svcError(404, 'NOT_FOUND', 'Aluno não encontrado neste dojô');
    }

    // F8: o responsável mora em OUTRA tabela (karate_dojo_guardians) — o
    // RETURNING acima só traz colunas de karate_dojo_students. O sync
    // compara a FICHA INTEIRA (comentário de karateIdentitySync), e isso
    // agora inclui o responsável ATUAL do aluno, não só o que este PATCH
    // tocou.
    const guardianFields = await fetchGuardianSyncFields(client, dojoId, guardianId);

    // NUNCA lança: devolve o resultado (ok | skipped | failed). É o que
    // permite cumprir "falha do sync não derruba o salvamento" sem
    // try/catch nu dentro do BEGIN (armadilha tx-poison).
    const syncResult = await identitySync.syncStudentIdentity(client, {
      dojoId,
      federationId: ctx.federationId || null,
      studentId,
      practitionerId,
      student: { ...upd.rows[0], ...guardianFields },
      studentLabel: upd.rows[0].full_name || null,
      actor: ctx.actor || null,
    });

    await client.query('COMMIT');
    return { upd, syncResult };
  } catch (e) {
    // ROLLBACK best-effort SÓ na saída de erro (a conexão pode ter caído).
    try { await client.query('ROLLBACK'); } catch (_) { /* conexão pode ter caído */ }
    throw e;
  } finally {
    client.release();
  }
}

// F8 — campos do responsável para o SYNC (dojô → federação). Separado de
// resolveGuardianOrThrow (que serve a RESPOSTA do POST/PATCH do aluno e
// não traz cpf) porque o sync PRECISA do cpf: guardian_cpf é campo de
// identidade na federação. Chaves ACHATADAS (guardian_full_name,
// guardian_cpf, ...) — são os mesmos nomes de GUARDIAN_SYNC_FIELDS.dojoCol
// em karateStudentIdentityLink.js, para o sync ler com
// `row[f.dojoCol]` sem precisar de um branch novo.
async function fetchGuardianSyncFields(client, dojoId, guardianId) {
  if (!guardianId) {
    return { guardian_full_name: null, guardian_cpf: null, guardian_phone: null, guardian_relationship: null };
  }
  const { rows } = await client.query(
    `SELECT full_name, cpf, phone, relationship
       FROM karate_dojo_guardians
      WHERE id = $1 AND dojo_id = $2
      LIMIT 1`,
    [guardianId, dojoId]
  );
  const g = rows[0] || {};
  return {
    guardian_full_name: g.full_name || null,
    guardian_cpf: g.cpf || null,
    guardian_phone: g.phone || null,
    guardian_relationship: g.relationship || null,
  };
}

// ============================================================
// F8 — POST /dojo/students/:sid/photo (upload de foto do aluno)
// ============================================================
// Mesma forma de updateStudent para um campo único (karate_photo_url):
// sem praticante vinculado, sem sync, sem transação — o caminho comum
// (a imensa maioria dos uploads) continua sendo uma query só. Com
// praticante vinculado, sobe a ficha completa (incluindo o responsável
// ATUAL) na MESMA transação, reusando updateStudentWithSync — mesmo
// motivo de sempre: o sync compara a ficha inteira, não só o campo
// tocado.
//
// karate_photo_url já é um SYNCED_IDENTITY_COLS (dentro de IDENTITY_COLS,
// migration 262) — não precisa entrar em nenhuma lista nova.
async function setStudentPhoto(dojoId, studentId, photoUrl, ctx = {}) {
  const existing = await withStudentSchemaFallback(() => db.query(
    `SELECT ${studentFields('s.')}, ${federationFields('s.')}
       FROM karate_dojo_students s
       ${federationJoin('s.')}
      WHERE s.id = $1 AND s.dojo_id = $2
      LIMIT 1`,
    [studentId, dojoId]
  ));
  if (!existing.rows.length) {
    throw svcError(404, 'NOT_FOUND', 'Aluno não encontrado neste dojô');
  }
  const cur = existing.rows[0];

  if (!HAS_IDENTITY_COLS) {
    // karate_photo_url só existe com a migration 262 (F7.0). Sem ela não
    // há onde gravar — mesmo 503 que o resto da F7.0 usa quando a coluna
    // falta, em vez de inventar uma coluna alternativa.
    throw svcError(
      503,
      'SCHEMA_PENDING',
      'Upload de foto do aluno depende da migration 262 (karate_photo_url), ainda não aplicada.'
    );
  }

  const buildUpdate = () => ({
    sql: `UPDATE karate_dojo_students SET karate_photo_url = $1, updated_at = now()
           WHERE id = $2 AND dojo_id = $3
       RETURNING ${studentFields('')}`,
    vals: [photoUrl, studentId, dojoId],
  });

  const needsSync = Boolean(cur.practitioner_id);
  let upd;
  let syncResult = null;
  if (!needsSync) {
    const q = buildUpdate();
    upd = await db.query(q.sql, q.vals);
  } else {
    ({ upd, syncResult } = await updateStudentWithSync({
      dojoId,
      studentId,
      buildUpdate,
      practitionerId: cur.practitioner_id,
      guardianId: cur.guardian_id,
      ctx,
    }));
  }

  const s = shapeStudent({
    ...upd.rows[0],
    is_federated: cur.is_federated,
    has_pending_request: cur.has_pending_request,
    fpkt_number: cur.fpkt_number,
    practitioner_name: cur.practitioner_name,
  });
  if (syncResult) s.identity_sync = syncResult;
  return s;
}

// Tabelas que apontam para o aluno com ON DELETE CASCADE. Um DELETE real
// destruiria trilha financeira, presenças que alimentam critérios de exame,
// graduações e certificados JÁ EMITIDOS (com verify_token público que passaria
// a devolver 404 para um documento entregue impresso).
const STUDENT_HISTORY_PROBES = Object.freeze([
  'SELECT 1 FROM karate_dojo_charges WHERE student_id = $1 LIMIT 1',
  'SELECT 1 FROM karate_dojo_attendance WHERE student_id = $1 LIMIT 1',
  'SELECT 1 FROM karate_dojo_belt_exam_results WHERE student_id = $1 LIMIT 1',
  'SELECT 1 FROM karate_dojo_issued_certificates WHERE student_id = $1 LIMIT 1',
  'SELECT 1 FROM karate_dojo_event_enrollments WHERE student_id = $1 LIMIT 1',
]);

async function deleteStudent(dojoId, studentId) {
  const ex = await db.query(
    'SELECT id FROM karate_dojo_students WHERE id = $1 AND dojo_id = $2 LIMIT 1',
    [studentId, dojoId]
  );
  if (!ex.rows.length) {
    throw svcError(404, 'NOT_FOUND', 'Aluno não encontrado neste dojô');
  }

  // Aluno COM histórico nunca é apagado — preserva a trilha. Espelha deleteClass.
  // Para "tirar da lista", a UI usa Inativar (status='inactive'), que já existe.
  let hasHistory = false;
  for (const sql of STUDENT_HISTORY_PROBES) {
    try {
      const r = await db.query(sql, [studentId]);
      if (r.rows.length) { hasHistory = true; break; }
    } catch (e) {
      // 42P01 tabela ausente (deploy parcial) / 42703 coluna ausente: não pode
      // liberar a exclusão de um aluno que na verdade TEM histórico noutra
      // tabela — mas essa sonda específica indisponível não prova histórico.
      if (e.code !== '42P01' && e.code !== '42703') throw e;
    }
  }

  if (hasHistory) {
    throw svcError(
      409, 'HAS_HISTORY',
      'Aluno com histórico (cobranças, presenças, graduações ou certificados) não pode ser excluído. Inative-o para preservar o histórico.'
    );
  }

  // Sem histórico: delete real.
  const del = await db.query(
    'DELETE FROM karate_dojo_students WHERE id = $1 AND dojo_id = $2 RETURNING id',
    [studentId, dojoId]
  );
  if (!del.rows.length) {
    throw svcError(404, 'NOT_FOUND', 'Aluno não encontrado neste dojô');
  }
  return { deleted: true, id: studentId };
}

// ============================================================
// F5a — FEDERAR o aluno NOVO (caminho 2: solicitação H1)
//
// O caminho 1 (número FPKT existente) e o desfederar moram em
// services/karateStudentIdentityLink.js desde a F7.1 — vincular virou
// ADOTAR a ficha e exige conferência campo a campo. As versões antigas
// que viviam aqui foram removidas na F7.2 (estavam sem chamador).
// ============================================================

// Leitura crua do aluno (sem JOIN): usada pelo fluxo de solicitação, que
// precisa da ficha para pré-preencher a solicitação H1.
async function loadStudentOrThrow(dojoId, studentId) {
  const { rows } = await withStudentSchemaFallback(() => db.query(
    `SELECT ${studentFields('')} FROM karate_dojo_students
      WHERE id = $1 AND dojo_id = $2
      LIMIT 1`,
    [studentId, dojoId]
  ));
  if (!rows.length) {
    throw svcError(404, 'NOT_FOUND', 'Aluno não encontrado neste dojô');
  }
  return rows[0];
}

async function findPendingRequestForStudent(dojoId, studentId) {
  if (!HAS_REQUEST_STUDENT_ID_COL) return null;
  try {
    const { rows } = await db.query(
      `SELECT id, status, created_at FROM karate_practitioner_requests
        WHERE dojo_id = $1 AND student_id = $2 AND status = 'pendente'
        ORDER BY created_at DESC
        LIMIT 1`,
      [dojoId, studentId]
    );
    return rows[0] || null;
  } catch (e) {
    if (e.code === '42703' || e.code === '42P01') {
      HAS_REQUEST_STUDENT_ID_COL = false;
      console.warn('[karateDojoStudentService] student_id/karate_practitioner_requests ausente — sem estado "pendente" por aluno');
      return null;
    }
    throw e;
  }
}

// Ficha da solicitação = dados do ALUNO como base + o que o sensei mandou
// no corpo (o corpo vence). Evita redigitar o que o dojô já tem.
//
// F7.0: com RG e endereço no aluno, a solicitação H1 deixa de exigir que o
// sensei redigite o que ele já cadastrou — é o "fluxo que sobe" na prática.
function mergeStudentIntoRequestPayload(student, body) {
  const b = body || {};
  const pick = (key, fallback) => {
    const v = b[key];
    return v !== undefined && v !== null && String(v).trim() !== '' ? v : (fallback || null);
  };
  const merged = { ...b };
  delete merged.request; // flag de controle, não é campo da ficha
  merged.full_name = pick('full_name', student.full_name);
  merged.birth_date = pick('birth_date', student.birth_date);
  merged.cpf = pick('cpf', student.cpf);
  merged.rg = pick('rg', student.rg);
  merged.phone = pick('phone', student.phone);
  merged.email = pick('email', student.email);
  merged.sex = pick('sex', student.sex);
  merged.zip_code = pick('zip_code', student.zip_code);
  merged.street = pick('street', student.street);
  merged.number = pick('number', student.number);
  merged.complement = pick('complement', student.complement);
  merged.neighborhood = pick('neighborhood', student.neighborhood);
  merged.city = pick('city', student.city);
  merged.state = pick('state', student.state);
  merged.claimed_belt = pick('claimed_belt', student.belt_label);
  return merged;
}

// Caminho 2: o aluno é NOVO na federação — abre a solicitação H1 que já
// existe (createPractitionerRequest), agora carimbada com student_id.
// NÃO marca is_federated: pendente não é federado; o marcador só vira true
// quando a federação aprova (ou quando o número existente é confirmado).
async function federateStudentByRequest(dojoId, federationId, studentId, { body, channel = null, actorLabel = null } = {}) {
  const student = await loadStudentOrThrow(dojoId, studentId);

  if (student.practitioner_id) {
    throw svcError(409, 'JA_FEDERADO', 'Este aluno já está vinculado a um praticante da federação.');
  }

  // Idempotente: pedir de novo devolve a solicitação pendente que existe.
  const pending = await findPendingRequestForStudent(dojoId, studentId);
  if (pending) {
    return {
      linked: false,
      student_id: studentId,
      federated: false,
      request_id: pending.id,
      status: 'pending',
      federation_link_status: 'pending',
      already_pending: true,
      created_at: pending.created_at,
      message: 'Já existe uma solicitação pendente para este aluno.',
    };
  }

  const result = await createPractitionerRequest({
    federationId,
    dojoId,
    body: mergeStudentIntoRequestPayload(student, body),
    channel,
    actorLabel,
    studentId,
  });

  if (result.status >= 400) {
    const e = svcError(result.status, result.body.code || 'ERROR', result.body.error);
    if (result.body.errors) e.errors = result.body.errors;
    throw e;
  }

  return {
    linked: false,
    student_id: studentId,
    federated: false,
    request_id: result.body.id,
    status: 'pending',
    federation_link_status: 'pending',
    already_pending: result.body.already_pending === true,
    created_at: result.body.created_at,
    fpkt_lookup: result.body.fpkt_lookup || null,
  };
}

// ============================================================
// F12 — IMPORTAÇÃO EM LOTE: normalizadores puros (sem banco)
//
// Testáveis sem mock de SQL, mesmo espírito de validateStudentPayload e
// dos testes de F10 (karate.dojoStudentParentage.test.js): funções puras
// primeiro, banco só onde é inevitável (dedupe/tag/responsável).
// ============================================================

// Telefone: a planilha real tem MÁSCARA ERRADA na origem
// ("(16) 9811-49883" — 11 dígitos corretos, hífen fora do lugar). Em vez
// de tentar validar a máscara, extrai só os dígitos: 10 ou 11 dígitos é um
// telefone BR válido (fixo ou celular), qualquer outra coisa é inválido —
// campo fica null e a linha ganha warning (import é TOLERANTE).
function normalizePhoneDigits(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits.length === 10 || digits.length === 11 ? digits : null;
}

// CPF: dígito verificador (mod 11, algoritmo padrão da Receita). Decisão
// do produto (planilha real do Areikan, 16 CPFs com DV inválido): NÃO
// bloqueia a linha — são alunos reais com erro de digitação antigo. O CPF
// entra assim mesmo; quem chama decide o warning (marcado para revisão).
function isValidCpfChecksum(digits) {
  if (!/^\d{11}$/.test(digits)) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false; // 11 dígitos iguais: nunca válido
  const calcDigit = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += parseInt(digits[i], 10) * (len + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  if (calcDigit(9) !== parseInt(digits[9], 10)) return false;
  if (calcDigit(10) !== parseInt(digits[10], 10)) return false;
  return true;
}

// ── Endereço: número da VIA × complemento (13/08/2026) ─────────────────
// A planilha real traz o endereço numa coluna só. A versão anterior desta
// função pegava o ÚLTIMO número da string, e por isso o COMPLEMENTO virava
// o número da casa: "Rua Manoel Rodrigues Jacob 1451 - AP 74" gravava
// number='74' (o apartamento) em vez de '1451'. 129 dos 476 endereços da
// planilha do Areikan (27%) têm complemento no texto.
//
// Regra nova: o número da via é o primeiro número que aparece DEPOIS do
// nome da via e ANTES de qualquer marcador de complemento; o que vem
// depois dele vira `complement`. Na dúvida, number = null e a string
// inteira fica em `street` — dado ausente é neutro, dado errado é dano.
const ADDRESS_COMPLEMENT_MARKERS = new Set([
  'ap', 'apt', 'apto', 'apts', 'aptos', 'apart', 'apartamento', 'apartamentos',
  'bloco', 'blocos', 'bl', 'casa', 'casas', 'lote', 'lotes', 'lt',
  'quadra', 'quadras', 'qd', 'sala', 'salas', 'cj', 'conj', 'conjunto',
  'torre', 'torres', 'fundos',
]);

// Só serve para UMA coisa: reconhecer que o número logo depois do tipo de
// via faz parte do NOME dela ("Rua 21", "Avenida 15 de Novembro"), não é
// número de porta.
const ADDRESS_VIA_TYPES = new Set([
  'rua', 'r', 'avenida', 'av', 'alameda', 'al', 'travessa', 'tv', 'trav',
  'praca', 'pca', 'rodovia', 'rod', 'estrada', 'via', 'largo', 'viela',
  'passagem', 'servidao', 'ladeira', 'marginal',
]);

const ADDR_EDGE_PUNCT = /^[.,;:/\\\-–—]+|[.,;:/\\\-–—]+$/g;
const ADDR_TRAIL_SEP = /[\s,;:/\\\-–—]+$/;
const ADDR_LEAD_SEP = /^[\s,;:/\\\-–—]+/;

function addrFold(s) {
  return s.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();
}

function addrToken(t) {
  const bareRaw = t.replace(ADDR_EDGE_PUNCT, '');
  const bare = addrFold(bareRaw);
  const nAttached = bare.match(/^(?:n|no|nr|num|numero)[ºo°]?\.?(\d+[a-z]?)$/);
  const mk = bare.match(/^([a-z]+)(?:[.\s]*\d.*)?$/);
  return {
    bareRaw,
    bare,
    numOnly: /^\d+[a-z]?$/.test(bare),
    nAttached: nAttached ? nAttached[1] : null,
    nStandalone: /^(?:n|no|nr|num|numero)[ºo°]?\.?$/.test(bare),
    marker: mk && ADDRESS_COMPLEMENT_MARKERS.has(mk[1]) ? mk[1] : null,
    hasDigit: /\d/.test(bare),
    startsGroup: /^[([]/.test(t),
    endsSep: /[.,;:/\\\-–—]$/.test(t),
    pureSep: bare === '',
  };
}

function splitAddress(raw) {
  if (raw == null) return { street: null, number: null, complement: null };
  const v = String(raw).replace(/\s+/g, ' ').trim();
  if (!v) return { street: null, number: null, complement: null };
  const whole = () => ({ street: v, number: null, complement: null });

  const tokens = v.split(' ');
  const meta = tokens.map(addrToken);

  // 1) Onde começa o complemento. Um marcador só vale se estiver DEPOIS do
  // miolo do nome da via (índice >= 2, senão "Rua Casa Branca 100" viraria
  // complemento) e se o contexto confirmar: pontuação/número antes, ou
  // dígito colado/logo depois ("AP 74", "ap.92", "Casa J2").
  let cStart = tokens.length;
  for (let i = 0; i < meta.length; i++) {
    const m = meta[i];
    if (i >= 1 && m.startsGroup) { cStart = i; break; }
    if (!m.marker || i < 2) continue;
    const prev = meta[i - 1];
    const next = meta[i + 1];
    const legit = prev.pureSep || prev.endsSep || prev.numOnly
      || prev.nAttached != null || m.hasDigit || (next != null && next.hasDigit);
    if (legit) { cStart = i; break; }
  }

  // 2) O número da via, procurado SÓ antes do complemento.
  let numIdx = -1;
  let markerIdx = -1;
  for (let i = 0; i < cStart; i++) {
    if (meta[i].nAttached != null) { numIdx = i; break; }
    if (meta[i].nStandalone && i + 1 < cStart && meta[i + 1].numOnly) {
      numIdx = i + 1; markerIdx = i; break;
    }
  }
  if (numIdx === -1) {
    for (let i = cStart - 1; i >= 0; i--) {
      if (!meta[i].numOnly) continue;
      if (i === 0) break;                                            // sobraria street vazio
      if (i === 1 && ADDRESS_VIA_TYPES.has(meta[0].bare)) break;     // "Rua 21", "Avenida 15 de Novembro"
      numIdx = i;
      break;
    }
  }

  // 3) Sem número: se havia marcador, o complemento ainda se separa.
  if (numIdx === -1) {
    if (cStart >= tokens.length) return whole();
    const street = tokens.slice(0, cStart).join(' ').replace(ADDR_TRAIL_SEP, '').trim();
    if (!street) return whole();
    const complement = tokens.slice(cStart).join(' ').trim();
    return { street, number: null, complement: complement || null };
  }

  // Texto solto depois do número SEM nenhum marcador de complemento = a
  // heurística não entendeu a linha. Não divide (regra de ouro).
  if (cStart >= tokens.length && meta.slice(numIdx + 1).some((m) => !m.pureSep)) return whole();

  let streetParts = tokens.slice(0, numIdx);
  if (markerIdx >= 0) streetParts = streetParts.filter((_, i) => i !== markerIdx);
  const street = streetParts.join(' ').replace(ADDR_TRAIL_SEP, '').trim();
  if (!street) return whole();

  const numMatch = meta[numIdx].bareRaw.match(/(\d+[A-Za-z]?)$/);
  if (!numMatch) return whole();

  const complement = tokens.slice(numIdx + 1).join(' ').replace(ADDR_LEAD_SEP, '').trim();
  return { street, number: numMatch[1], complement: complement || null };
}

// Status: coluna "Ativo" da planilha real. Vocabulário tolerante (a
// planilha pode vir com Sim/Não, TRUE/FALSE, Ativo/Inativo, 1/0) — quem
// não reconhece vira 'active' (default neutro, igual ao import de sempre)
// COM warning, para não mascarar um valor inesperado como se fosse "sim".
const ACTIVE_STATUS_TOKENS = new Set(['ativo', 'active', 'sim', 's', 'true', '1', 'yes']);
const INACTIVE_STATUS_TOKENS = new Set(['inativo', 'inactive', 'nao', 'n', 'false', '0', 'no']);

function normalizeImportStatus(raw) {
  if (raw == null) return { status: 'active', recognized: true };
  if (typeof raw === 'boolean') return { status: raw ? 'active' : 'inactive', recognized: true };
  const v = String(raw)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS, '');
  if (!v) return { status: 'active', recognized: true };
  if (ACTIVE_STATUS_TOKENS.has(v)) return { status: 'active', recognized: true };
  if (INACTIVE_STATUS_TOKENS.has(v)) return { status: 'inactive', recognized: true };
  return { status: 'active', recognized: false };
}

// Faixa: a planilha real traz "1º Kyu - Marrom", "10º Kyu - Branca",
// "Preta 1º Dan" e "4º Kyu - Azul Escura" (feminino, grafia diferente do
// "Azul Escuro" canônico). Fonte ÚNICA da escala: src/utils/
// karateBeltScale.js (nenhum mapa de faixa novo aqui) — este parser só
// EXTRAI a cor/grau do texto solto da planilha e delega toda a semântica
// de ordenação/rótulo para lá.
function detectImportBeltLevel(raw) {
  const stripped = raw
    .normalize('NFD')
    .replace(COMBINING_MARKS, '');
  if (/\bpreta\b/i.test(stripped)) return 'preta';

  // Remove um prefixo "<n>º Kyu -" / "<n> Kyu" quando existir; o que
  // sobra tende a ser só a cor ("Marrom", "Azul Escura", ...).
  let candidate = raw.replace(/^\s*\d+\s*[oº°]?\s*kyu\s*-?\s*/i, '').trim();
  if (candidate === raw.trim() || !candidate) {
    const parts = raw.split('-').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) candidate = parts[parts.length - 1];
  }

  let level = normalizeBeltLevel(candidate);
  if (level && (colorOf(level) || isLegacyOnlyLevel(level))) return level;

  // Última tentativa: a string inteira já é só a cor (ex. "Branca").
  level = normalizeBeltLevel(raw);
  if (level && colorOf(level)) return level;

  return null;
}

function parseImportBeltLabel(raw) {
  if (raw == null) return { belt_label: null, belt_order: null, recognized: true };
  const v = String(raw).trim();
  if (!v) return { belt_label: null, belt_order: null, recognized: true };

  const level = detectImportBeltLevel(v);
  if (!level) return { belt_label: null, belt_order: null, recognized: false };

  const degree = parseDegreeFromName(level, v);
  return {
    belt_label: formatCanonicalBeltLabel(level, degree),
    belt_order: beltDisplayRank(level, degree),
    recognized: true,
  };
}

// ── Import em lote (até 500 linhas JSON já parseadas pelo front) ──
//
// F12 (10/08/2026) — DE 8 CAMPOS PARA A FICHA REAL DO DOJÔ
//
// A planilha real do primeiro dojô a entrar (Associação Areikan Karatê-Dô,
// 484 alunos) tem 15 colunas: Nome, Graduação KYU, Academia, Ativo, Data
// Nascimento, RG, CPF, Pai, Mãe, Telefone, Endereço, CEP, Bairro, Cidade,
// Email. O import de 8 campos (full_name/birth_date/cpf/phone/email/
// belt_label/guardian_name/guardian_phone, da F2) aproveitava 6 de 15 —
// e o pior: SEM status, os 254 inativos entrariam ATIVOS.
//
// MAPA COLUNA → CAMPO (linha da planilha → chave aceita nesta função):
//   Nome              → full_name
//   Graduação KYU     → belt_label   (texto solto; ver parseImportBeltLabel)
//   Academia          → academia     (vira TAG — karate_dojo_tags, migr 274)
//   Ativo             → status       (ver normalizeImportStatus)
//   Data Nascimento   → birth_date   (YYYY-MM-DD; ausente/inválido = neutro)
//   RG                → rg
//   CPF               → cpf          (DV inválido NÃO bloqueia — marcado p/ revisão)
//   Pai               → father_name  (filiação — migr 272)
//   Mãe               → mother_name  (filiação — migr 272; também vira o
//                                      RESPONSÁVEL quando o aluno é menor)
//   Telefone          → phone        (máscara da origem é ignorada; só dígitos)
//   Endereço          → address      (combinado; separado em street/number)
//   CEP               → zip_code
//   Bairro            → neighborhood
//   Cidade            → city
//   Email             → email
// Campos legados mantidos por compatibilidade (outras planilhas/callers):
//   guardian_name / guardian_phone → responsável EXPLÍCITO (sobrepõe a
//   regra de mãe/pai abaixo quando vier preenchido).
//
// RESPONSÁVEL DE MENOR (regra do dono do produto): 370/484 (76%) são
// menores de 18 e a planilha NÃO tem coluna de responsável — mas telefone
// e e-mail da linha "parecem" ser dos pais (uma aluna de 16 anos tem o
// e-mail da mãe). Regra: para MENOR (birth_date conhecida e < 18 anos),
// cria/reusa responsável a partir da filiação da linha.
//
// F13 (12/08/2026) — OS DOIS, NÃO UM: até aqui era a MÃE, "ou o pai se a
// mãe estiver vazia". Virou MÃE **E** PAI, cada um como um responsável
// próprio, com o parentesco certo ('mãe'/'pai') no vínculo — "em um caso
// de emergência com uma criança, é bom ter o contato de ambos" (Caio).
//
// A PLANILHA TRAZ UM TELEFONE SÓ (e um e-mail só). Regra declarada:
//   • o contato vai para o PRINCIPAL — a mãe; o pai quando não há mãe.
//     É exatamente quem a ficha já mostrava antes deste PR, então nenhuma
//     ficha existente muda de contato;
//   • o SEGUNDO entra NOMEADO E SEM CONTATO. Inventar um telefone para
//     ele (copiar o do outro) seria pior do que não ter: numa emergência,
//     dois números iguais é UM número com aparência de dois. A ficha
//     mostra o campo vazio e um warning GUARDIAN_SEM_CONTATO por linha
//     nomeia quem falta, para o sensei completar.
//
// CONTATO SAI DO ALUNO (contactMovedToGuardian) — MANTIDO, e agora com
// razão mais forte: o telefone da linha é do adulto, não da criança de 10
// anos. Antes havia um efeito colateral ruim — o contato "sumia" da ficha
// e reaparecia só dentro do responsável. Com a lista de responsáveis na
// resposta da ficha (F13), o contato continua VISÍVEL, agora atribuído a
// QUEM ele é de verdade. Para ADULTO nada muda: telefone e e-mail são do
// próprio aluno, como sempre.
//
// IRMÃOS NÃO DUPLICAM O RESPONSÁVEL: karate_dojo_guardians é escopada por
// DOJÔ (não por aluno), e o cache do lote + a busca-ou-cria por
// (dojo, lower(nome), telefone) fazem "Caio Marmorato Toloi" e "Lucas
// Marmorato Toloi" apontarem para a MESMA mãe. Para o segundo responsável
// (sem telefone) a busca é por NOME dentro do dojô, de propósito: senão um
// pai já cadastrado COM telefone viraria uma segunda linha SEM.
//
// mother_name/father_name são gravados SEMPRE (é filiação/identidade —
// diferente de "quem é o responsável"), estejam ou não usados como
// responsável.
//
// IDADE DESCONHECIDA (7 linhas sem data de nascimento — decisão declarada,
// não omissão): sem birth_date não dá para saber se é menor. Tratada como
// ADULTO (telefone/e-mail ficam no próprio aluno, mãe/pai só como
// filiação) — com warning AGE_UNKNOWN_TREATED_AS_ADULT na linha, para o
// sensei revisar manualmente quem realmente é.
//
// TAGS ("Academia"): criada se não existir (case-insensitive por dojô —
// UNIQUE de migration 274) e reusada entre linhas da mesma tag no MESMO
// lote (cache local, evita 484 buscas para 4 tags).
//
// REIMPORTAÇÃO / IDEMPOTÊNCIA (comportamento MELHORADO neste PR): o
// dedupe de sempre é por (dojo_id, cpf) — mas 14% da planilha real (e
// qualquer linha sem CPF) não tinham NENHUMA proteção contra duplicar ao
// reimportar o mesmo arquivo. Agora, quando a linha não tem CPF, o dedupe
// cai para (dojo_id, lower(full_name), birth_date) — no lote (Set) e no
// banco. Continua não sendo "idempotência forte" (editar o nome depois de
// importar faz uma reimportação não reconhecer a linha), mas fecha o
// buraco que faria uma reimportação de 484 alunos duplicar os ~68 sem CPF.
//
// POLÍTICA DE ERRO POR LINHA: import continua TOLERANTE — campo inválido
// vira warning + campo NULL, a linha entra mesmo assim (nunca 422 por
// causa de UMA linha ruim). As duas únicas razões para uma linha ser
// SKIPPED (não criar registro) são: full_name ausente, ou duplicata (CPF
// ou nome+nascimento) — o resto é sempre "importa e avisa".
//
// F7.0/F7.2 (mantido): roda DENTRO de um BEGIN; RG/endereço/filiação já
// são colunas garantidas por este PR ("SEM MIGRATION — já existem em
// produção": 262, 272, 274) — se por algum motivo excepcional a coluna
// não existir, o 42703 sobe e ROLLBACK do lote inteiro (mesma política de
// "qualquer falha inesperada aborta o lote" que este arquivo já tinha).
// F7.2: sync em lote ao final — hoje custa ZERO query (import nunca grava
// practitioner_id), mesmo comportamento de antes.
// F13: os vínculos aluno↔responsável do lote inteiro vão em UMA query ao
// final, dentro de SAVEPOINT — com a migration 280 pendente, um 42P01
// cru envenenaria a transação e derrubaria a importação dos 484 alunos,
// que já entraram corretamente com o responsável principal.
// F14 (13/08/2026) — O CUSTO POR LINHA, E A TRANSAÇÃO QUE FICOU ÓRFÃ
//
// O import dos 484 do Areikan rodou, mas com dois problemas medidos em
// produção no mesmo dia:
//
//   1. MAIS DE 60 SEGUNDOS PARA 100 LINHAS. Cada aluno custava ~10 idas ao
//      banco (dedupe por CPF, dedupe por nome+nascimento, INSERT do aluno,
//      SELECT+INSERT de responsável até 2×, INSERT do vínculo de tag,
//      SELECT/INSERT da tag): ~1.000 round-trips por lote de 100. O
//      gargalo NUNCA foi volume de dados — é NÚMERO DE VIAGENS × LATÊNCIA
//      (o backend roda no Railway/us-west e o banco no Supabase/sa-east-1;
//      cada viagem custa ~190ms mesmo com a conexão quente, ver
//      src/config/database.js).
//
//   2. TRANSAÇÃO ÓRFÃ DE 8 MINUTOS. Com as 484 linhas num request só, o
//      cliente HTTP desistiu. O Node parou de mandar comandos e a
//      transação ficou `idle in transaction` por oito minutos, parada
//      exatamente no `SELECT id FROM karate_dojo_guardians ...` do laço,
//      com `wait_event = ClientRead`, segurando conexão do pool e locks.
//      Só morreu com `pg_terminate_backend` na mão.
//
// A REESCRITA: TRÊS PASSOS, NÃO UM LAÇO
//
//   PASSO 1 — PURO, SEM BANCO. Normaliza as 484 linhas, acumula os
//     warnings DE CADA LINHA em um array próprio (é isso que preserva a
//     ORDEM dos avisos: eles continuam saindo agrupados por linha, na
//     mesma sequência de antes) e resolve o dedupe DENTRO do lote.
//   PASSO 2 — LEITURAS EM LOTE. Uma query para o dedupe por CPF, uma para
//     o dedupe por nome+nascimento, uma para as tags, uma para procurar os
//     responsáveis. Quatro queries para o lote inteiro, não 4 por linha.
//   PASSO 3 — ESCRITAS EM LOTE. Um INSERT para os responsáveis novos, um
//     para os alunos, um para os vínculos de tag, um para os vínculos de
//     responsável (este já era em lote desde a F13).
//
//   Resultado: o lote de 484 linhas passou de ~4.800 round-trips para ~14,
//   e o número NÃO cresce mais com a quantidade de linhas.
//
// IDS GERADOS NO CLIENTE (randomUUID). Um INSERT de N linhas devolve N
// linhas em RETURNING, mas a ORDEM do RETURNING não é contratual — e
// precisamos saber qual id é de qual linha para montar os vínculos de tag
// e de responsável. Gerar o uuid aqui resolve isso sem depender de ordem
// nenhuma; a coluna continua com `DEFAULT gen_random_uuid()` para todo o
// resto do sistema, e um uuid v4 do Node é o mesmo tipo de valor.
//
// SET LOCAL idle_in_transaction_session_timeout — POR QUE AQUI DENTRO.
// A defesa de verdade contra a transação órfã é do BANCO (migration 281,
// `ALTER DATABASE ... SET`, que vale para toda sessão e toda rota). Este
// SET LOCAL é a segunda camada, e existe por um motivo concreto: o
// `SET` de SESSÃO que src/config/database.js manda no evento `connect` do
// pool NÃO sobrevive a um pooler em modo transaction (Supavisor), e a
// prova está nos valores observados no banco no dia do incidente —
// `idle_in_transaction_session_timeout = 0`, não os 30s que o código
// pedia. `SET LOCAL` vive DENTRO da transação, que o pooler é obrigado a
// manter na mesma conexão de servidor: é o único que não pode ser
// descartado. Se ele falhar, o catch abaixo dá ROLLBACK e nada foi
// escrito — falha fechada, e a defesa do banco continua valendo.
//
// O QUE NÃO MUDOU (validado com os 484 alunos reais em produção):
//   • a política de SKIP — só nome ausente e duplicata (CPF, ou
//     nome+nascimento quando não há CPF), inclusive QUAL das duas
//     mensagens de duplicata sai em cada caso;
//   • os warnings, um a um, e a ordem deles;
//   • a derivação de responsável (mãe principal, pai secundário sem
//     contato, com GUARDIAN_SEM_CONTATO nomeando quem falta);
//   • a criação da tag pela coluna "Academia" e o reuso entre irmãos do
//     mesmo responsável;
//   • o formato do resultado { created, skipped, warnings, identity_sync,
//     guardian_links }.
//
// ABORT DO CLIENTE (req.on('aborted') / res.on('close')): investigado e
// DELIBERADAMENTE NÃO IMPLEMENTADO — ver o comentário logo acima do
// BEGIN, dentro da função.
async function importStudents(dojoId, rows, ctx = {}) {
  if (!Array.isArray(rows)) {
    throw svcError(422, 'VALIDATION_ERROR', 'Corpo esperado: { rows: [...] } (array de linhas já parseadas)');
  }
  if (rows.length > IMPORT_MAX_ROWS) {
    throw svcError(422, 'IMPORT_TOO_LARGE', `Máximo de ${IMPORT_MAX_ROWS} linhas por importação`);
  }
  let identitySyncResult = { status: 'ok', synced: 0, checked: 0, fields: [], reason: 'NOTHING_TO_SYNC' };
  let guardianLinksResult = { written: false, count: 0 };
  if (!rows.length) {
    return { created: 0, skipped: 0, warnings: [], identity_sync: identitySyncResult, guardian_links: guardianLinksResult };
  }

  // ══════════════════════════════════════════════════════════
  // PASSO 1 — NORMALIZAÇÃO PURA (zero query)
  //
  // Cada linha ganha um `prep` com o seu PRÓPRIO array de warnings. É isso
  // que faz a resposta continuar saindo agrupada por linha na ordem da
  // planilha: se os warnings fossem para uma lista única, a fase de banco
  // (que agora roda depois do laço inteiro) os reagruparia por FASE, e a
  // ordem observável mudaria sem ninguém mexer em regra nenhuma.
  // ══════════════════════════════════════════════════════════
  const prepared = [];
  const firstRowByCpf = new Map();      // cpf → índice da 1ª ocorrência no lote
  const firstRowByNameKey = new Map();  // nome|nascimento → idem (linhas sem CPF)

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 1;
    const r = rows[i] || {};
    const warn = [];
    const prep = { rowNum, warn, skipped: false, dedupeKind: null, dedupeKey: null, dupInBatch: false };
    prepared.push(prep);

    const fullName = r.full_name != null ? String(r.full_name).trim() : '';
    if (!fullName) {
      prep.skipped = true;
      warn.push({ row: rowNum, code: 'MISSING_NAME', message: 'Linha sem full_name — ignorada' });
      continue;
    }
    prep.fullName = fullName;

    // Import é TOLERANTE: campo inválido vira warning + campo NULL (a linha
    // entra mesmo assim). Diferente do form, onde inválido é 422.
    let birthDate = null;
    if (r.birth_date != null && String(r.birth_date).trim() !== '') {
      const v = String(r.birth_date).trim();
      if (isValidDateStr(v)) birthDate = v;
      else warn.push({ row: rowNum, code: 'INVALID_BIRTH_DATE', message: `birth_date inválido ("${v}") — aluno importado sem data de nascimento` });
    }
    prep.birthDate = birthDate;
    // null = idade DESCONHECIDA (7 casos na planilha real); true/false = conhecida.
    const isMinorRow = birthDate ? isMinor(birthDate) : null;
    prep.isMinorRow = isMinorRow;

    let cpf = null;
    if (r.cpf != null && String(r.cpf).trim() !== '') {
      const digits = normalizeCpf(r.cpf);
      if (digits && digits.length === 11) {
        cpf = digits;
        // F12: DV inválido NÃO bloqueia — decisão do produto (16 casos
        // reais na planilha do Areikan). Importa marcado para revisão.
        if (!isValidCpfChecksum(cpf)) {
          warn.push({ row: rowNum, code: 'CPF_CHECKSUM_INVALID', message: 'CPF com dígito verificador inválido — importado mesmo assim, marcado para revisão' });
        }
      } else {
        warn.push({ row: rowNum, code: 'INVALID_CPF', message: 'cpf inválido — aluno importado sem CPF' });
      }
    }
    prep.cpf = cpf;

    prep.rg = r.rg != null && String(r.rg).trim() !== '' ? String(r.rg).trim() : null;

    let email = null;
    if (r.email != null && String(r.email).trim() !== '') {
      const v = String(r.email).trim();
      if (EMAIL_RE.test(v)) email = v;
      else warn.push({ row: rowNum, code: 'INVALID_EMAIL', message: 'email inválido — aluno importado sem e-mail' });
    }

    let phone = null;
    if (r.phone != null && String(r.phone).trim() !== '') {
      phone = normalizePhoneDigits(r.phone);
      if (!phone) warn.push({ row: rowNum, code: 'INVALID_PHONE', message: 'telefone inválido — aluno importado sem telefone' });
    }

    const beltParsed = parseImportBeltLabel(r.belt_label);
    if (!beltParsed.recognized) {
      warn.push({ row: rowNum, code: 'INVALID_BELT', message: `belt_label não reconhecido ("${String(r.belt_label).trim()}") — aluno importado sem faixa` });
    }
    prep.beltLabel = beltParsed.belt_label;
    prep.beltOrder = beltParsed.belt_order;

    const statusParsed = normalizeImportStatus(r.status);
    if (!statusParsed.recognized) {
      warn.push({ row: rowNum, code: 'INVALID_STATUS', message: `status não reconhecido ("${String(r.status).trim()}") — aluno importado como ativo` });
    }
    prep.status = statusParsed.status;

    const motherName = r.mother_name != null && String(r.mother_name).trim() !== '' ? String(r.mother_name).trim() : null;
    const fatherName = r.father_name != null && String(r.father_name).trim() !== '' ? String(r.father_name).trim() : null;
    prep.motherName = motherName;
    prep.fatherName = fatherName;

    let zipCode = null;
    if (r.zip_code != null && String(r.zip_code).trim() !== '') {
      zipCode = normalizeZipCode(r.zip_code);
      if (!zipCode) warn.push({ row: rowNum, code: 'INVALID_ZIP', message: 'CEP inválido — aluno importado sem CEP' });
    }
    prep.zipCode = zipCode;

    // F12: 96% das linhas vêm com o número grudado na rua. street/number/
    // complement já separados pelo caller (planilha nova) têm PRIORIDADE;
    // sem eles, usa address (combinado) e separa aqui.
    // 13/08/2026: splitAddress agora devolve TAMBÉM o complemento — 27%
    // dos endereços do Areikan trazem "AP 74"/"casa J2"/"lote 15" no
    // mesmo campo, e era isso que virava `number` por engano.
    let street = r.street != null && String(r.street).trim() !== '' ? String(r.street).trim() : null;
    let number = r.number != null && String(r.number).trim() !== '' ? String(r.number).trim() : null;
    let complement = r.complement != null && String(r.complement).trim() !== '' ? String(r.complement).trim() : null;
    if (!street && r.address != null && String(r.address).trim() !== '') {
      const split = splitAddress(r.address);
      street = split.street;
      number = split.number;
      // Complemento explícito da planilha manda; o extraído do texto só
      // preenche o buraco (nunca sobrescreve o que o caller já sabia).
      if (!complement) complement = split.complement;
    }
    prep.street = street;
    prep.number = number;
    prep.complement = complement;
    prep.neighborhood = r.neighborhood != null && String(r.neighborhood).trim() !== '' ? String(r.neighborhood).trim() : null;
    // Planilha real tem 1 typo de cidade conhecido ("Araraqaura") e 8
    // linhas sem cidade — nenhuma correção automática aqui de propósito
    // (autocorrigir texto livre é decisão de produto separada, não
    // deste PR). Cidade entra exatamente como veio, só trim().
    prep.city = r.city != null && String(r.city).trim() !== '' ? String(r.city).trim() : null;
    // A planilha não traz sexo nem UF — nulos, nunca inventados (UF
    // poderia sair do CEP, mas isso é decisão separada e não está
    // implementada aqui).
    prep.sex = null;
    prep.state = null;

    // ── Chave de dedupe: por CPF quando existe; por nome+nascimento quando não ──
    // Só a chave é decidida aqui; QUEM é duplicata (e com qual das duas
    // mensagens) só dá para saber depois da consulta em lote do PASSO 2.
    if (cpf) {
      prep.dedupeKind = 'cpf';
      prep.dedupeKey = cpf;
      if (firstRowByCpf.has(cpf)) prep.dupInBatch = true;
      else firstRowByCpf.set(cpf, i);
    } else {
      const nameKey = `${fullName.toLowerCase()}|${birthDate || ''}`;
      prep.dedupeKind = 'name';
      prep.dedupeKey = nameKey;
      if (firstRowByNameKey.has(nameKey)) prep.dupInBatch = true;
      else firstRowByNameKey.set(nameKey, i);
    }

    prep.tagName = r.academia != null && String(r.academia).trim() !== '' ? String(r.academia).trim() : null;

    // ── Responsáveis (F13: mãe E pai, cada um com o seu contato) ──
    // Caminho 1 (legado, prioridade): guardian_name explícito na linha —
    // UM responsável, com guardian_phone. Planilhas de 8 campos
    // continuam funcionando byte a byte.
    // Caminho 2 (F12→F13): menor SEM guardian_name explícito — mãe E pai
    // viram responsáveis. O telefone/e-mail ÚNICO da linha fica com o
    // PRINCIPAL (mãe; pai quando não há mãe); o outro entra nomeado e
    // sem contato, com warning. Ver o cabeçalho da função.
    const guardianSources = [];
    let contactMovedToGuardian = false;

    if (r.guardian_name != null && String(r.guardian_name).trim() !== '') {
      guardianSources.push({
        name: String(r.guardian_name).trim(),
        phone: r.guardian_phone != null && String(r.guardian_phone).trim() !== '' ? String(r.guardian_phone).trim() : null,
        email: null,
        relationship: null,
      });
    } else if (isMinorRow === true) {
      if (motherName) guardianSources.push({ name: motherName, phone: null, email: null, relationship: 'mãe' });
      if (fatherName) guardianSources.push({ name: fatherName, phone: null, email: null, relationship: 'pai' });
      if (guardianSources.length) {
        // O contato da linha é do PRINCIPAL — e sai do cadastro do aluno.
        guardianSources[0].phone = phone;
        guardianSources[0].email = email;
        contactMovedToGuardian = true;
      }
    }
    prep.guardianSources = guardianSources;
    prep.contactMovedToGuardian = contactMovedToGuardian;
    prep.phone = phone;
    prep.email = email;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // ── A TRANSAÇÃO ÓRFÃ DE 8 MINUTOS ──────────────────────────────────
    // Ver o cabeçalho da função para o porquê deste SET viver AQUI e não
    // no `connect` do pool.
    //
    // ABORT DO CLIENTE — POR QUE NÃO. `req.on('aborted')` / `res.on('close')`
    // avisam quando o cliente desiste, e daria para disparar um ROLLBACK
    // dali. Mas o handler roda em OUTRO tick, enquanto esta função está
    // parada em `await client.query(...)`: o ROLLBACK entraria na fila do
    // mesmo client e executaria no meio do caminho, e os comandos
    // seguintes desta função rodariam FORA de transação, em autocommit —
    // isto é, gravando metade das linhas de forma definitiva. Trocar uma
    // transação órfã (que ninguém vê) por um import pela metade (que o
    // dojô vê) é um péssimo negócio. Um abort correto exigiria um ponto de
    // cancelamento COOPERATIVO no meio da operação; depois desta reescrita
    // nem isso faz sentido: o lote inteiro são ~14 comandos, sem laço
    // client-side entre eles, então não existe mais "meio do caminho" onde
    // um abort pegue a transação parada. O timeout cobre o pior caso, que
    // é o que ele precisa cobrir.
    await client.query(IMPORT_IDLE_IN_TX_GUARD_SQL);

    // ══════════════════════════════════════════════════════════
    // PASSO 2 — LEITURAS EM LOTE
    // ══════════════════════════════════════════════════════════

    // ── Dedupe por CPF: UMA query para o lote inteiro ──
    const cpfCandidates = [...firstRowByCpf.keys()];
    const cpfsInDb = new Set();
    if (cpfCandidates.length) {
      const dupCpf = await client.query(
        `-- tag:import_dedupe_cpf
         SELECT cpf FROM karate_dojo_students
          WHERE dojo_id = $1 AND cpf = ANY($2::text[])`,
        [dojoId, cpfCandidates]
      );
      for (const row of dupCpf.rows) cpfsInDb.add(row.cpf);
    }

    // ── Dedupe por nome+nascimento (linhas SEM CPF): UMA query ──
    // A comparação continua sendo `IS NOT DISTINCT FROM` NO BANCO, de
    // propósito: trazer as datas para o JS para comparar aqui obrigaria a
    // remarshalar `date` → `Date` → string, que é exatamente onde nasce o
    // bug de fuso de um dia. O que volta é só o ORDINAL do candidato que
    // casou.
    const nameCandidates = [];
    for (const [key, idx] of firstRowByNameKey) {
      nameCandidates.push({ key, fullName: prepared[idx].fullName, birthDate: prepared[idx].birthDate });
    }
    const nameKeysInDb = new Set();
    if (nameCandidates.length) {
      const dupName = await client.query(
        `-- tag:import_dedupe_name_birth
         SELECT DISTINCT c.ord
           FROM unnest($2::text[], $3::date[]) WITH ORDINALITY AS c(full_name, birth_date, ord)
           JOIN karate_dojo_students s
             ON s.dojo_id = $1
            AND lower(s.full_name) = lower(c.full_name)
            AND s.birth_date IS NOT DISTINCT FROM c.birth_date`,
        [dojoId, nameCandidates.map((c) => c.fullName), nameCandidates.map((c) => c.birthDate)]
      );
      for (const row of dupName.rows) {
        const hit = nameCandidates[Number(row.ord) - 1];
        if (hit) nameKeysInDb.add(hit.key);
      }
    }

    // ── Quem entra e quem é pulado ──
    // A ORDEM das duas mensagens de duplicata é a de sempre: se a chave já
    // existe NO BANCO, todas as linhas com ela levam a mensagem de "já
    // cadastrado"; a mensagem de "duplicado no lote" só sobra para a
    // 2ª ocorrência de uma chave que NÃO estava no banco — que é
    // exatamente o que o laço antigo produzia (ele só marcava a chave como
    // vista DEPOIS de a linha sobreviver à consulta).
    for (const prep of prepared) {
      if (prep.skipped) continue;
      if (prep.dedupeKind === 'cpf') {
        if (cpfsInDb.has(prep.dedupeKey)) {
          prep.skipped = true;
          prep.warn.push({ row: prep.rowNum, code: 'DUP_CPF', message: 'CPF já cadastrado neste dojô — linha ignorada' });
        } else if (prep.dupInBatch) {
          prep.skipped = true;
          prep.warn.push({ row: prep.rowNum, code: 'DUP_CPF', message: 'CPF duplicado no lote — linha ignorada' });
        }
      } else if (nameKeysInDb.has(prep.dedupeKey)) {
        prep.skipped = true;
        prep.warn.push({ row: prep.rowNum, code: 'DUP_NAME_NO_CPF', message: 'Aluno com mesmo nome e nascimento já cadastrado neste dojô (linha sem CPF) — linha ignorada' });
      } else if (prep.dupInBatch) {
        prep.skipped = true;
        prep.warn.push({ row: prep.rowNum, code: 'DUP_NAME_NO_CPF', message: 'Nome e nascimento duplicados no lote (linha sem CPF) — linha ignorada' });
      }
    }

    const survivors = prepared.filter((p) => !p.skipped);

    // ── Tags ("Academia"): UM upsert para todas as tags distintas ──
    // Continua sendo o mesmo upsert de antes (inclusive o `updated_at =
    // now()` na tag que já existia), só que uma vez por LOTE em vez de uma
    // vez por tag nova. O arbiter repete a EXPRESSÃO `lower(name)` porque
    // uq_karate_dojo_tags_dojo_name_ci é índice por expressão — coluna
    // crua aqui daria 42P10.
    const tagNameByKey = new Map(); // lower(nome) → nome cru da 1ª ocorrência
    for (const prep of survivors) {
      if (!prep.tagName) continue;
      const key = prep.tagName.toLowerCase();
      if (!tagNameByKey.has(key)) tagNameByKey.set(key, prep.tagName);
    }
    const tagIdByKey = new Map();
    if (tagNameByKey.size) {
      const tagRes = await client.query(
        `-- tag:import_tags_upsert
         INSERT INTO karate_dojo_tags (dojo_id, name, color, active)
         SELECT $1::uuid, t.name, NULL, true
           FROM unnest($2::text[]) AS t(name)
         ON CONFLICT (dojo_id, lower(name)) DO UPDATE SET updated_at = now()
         RETURNING id, name`,
        [dojoId, [...tagNameByKey.values()]]
      );
      // Casa pelo nome em MINÚSCULAS DO JS nos dois lados (a chave do mapa
      // e o `name` que voltou): usar `lower()` do Postgres de um lado e
      // `toLowerCase()` do outro seria pedir para divergirem.
      for (const row of tagRes.rows) tagIdByKey.set(String(row.name).toLowerCase(), row.id);
    }

    // ── Responsáveis: UMA busca e UM insert para o lote ──
    // O "cache do lote" da F13 continua existindo — só deixou de ser um
    // Map preenchido dentro do laço e virou este índice de chaves
    // DISTINTAS, montado na MESMA ordem em que o laço antigo as encontrava
    // (linha por linha, mãe antes de pai). É ele que faz irmãos
    // compartilharem a mesma linha de karate_dojo_guardians: "Caio
    // Marmorato Toloi" e "Lucas Marmorato Toloi" produzem a MESMA chave
    // lower(nome)|telefone e resolvem para o mesmo id — 87 responsáveis
    // compartilhados por irmãos na planilha real do Areikan.
    const guardianKeys = [];
    const guardianKeyIndex = new Map(); // chave → posição em guardianKeys
    const guardianKeyOf = (gs) => `${gs.name.toLowerCase()}|${gs.phone || ''}`;
    for (const prep of survivors) {
      for (const gs of prep.guardianSources) {
        const key = guardianKeyOf(gs);
        if (guardianKeyIndex.has(key)) continue;
        guardianKeyIndex.set(key, guardianKeys.length);
        guardianKeys.push({ key, name: gs.name, phone: gs.phone, email: gs.email, relationship: gs.relationship });
      }
    }

    // Uma query resolve as duas buscas que existiam por linha:
    //   • COM telefone → chave exata (dojo, nome, telefone), como sempre;
    //   • SEM telefone (o segundo responsável) → por NOME, aceitando quem
    //     já existe COM telefone. Sem isso, um pai já cadastrado viraria
    //     uma SEGUNDA linha sem contato — dois cadastros da mesma pessoa.
    // O ORDER BY é o mesmo do SELECT antigo e vale para os dois casos.
    const guardianDbHit = new Map(); // posição em guardianKeys → { id, hasPhone }
    if (guardianKeys.length) {
      const found = await client.query(
        `-- tag:import_guardian_lookup
         SELECT k.ord, g.id, (g.phone IS NOT NULL) AS has_phone
           FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS k(full_name, phone, ord)
           JOIN LATERAL (
                  SELECT g2.id, g2.phone
                    FROM karate_dojo_guardians g2
                   WHERE g2.dojo_id = $1
                     AND lower(g2.full_name) = lower(k.full_name)
                     AND (k.phone IS NULL OR COALESCE(g2.phone, '') = COALESCE(k.phone, ''))
                   ORDER BY (g2.phone IS NOT NULL) DESC, g2.created_at ASC
                   LIMIT 1
                ) g ON true`,
        [dojoId, guardianKeys.map((g) => g.name), guardianKeys.map((g) => g.phone)]
      );
      for (const row of found.rows) {
        guardianDbHit.set(Number(row.ord) - 1, { id: row.id, hasPhone: row.has_phone === true });
      }
    }

    // Resolve chave por chave, NA ORDEM do lote. O laço antigo enxergava
    // os responsáveis recém-criados porque eles já estavam no banco dentro
    // da transação; aqui eles ainda não existem, então quem faz esse papel
    // é `mintedByName` — com o MESMO critério de desempate do ORDER BY
    // acima (quem tem telefone primeiro; empatou, o mais antigo — e tudo
    // que veio do banco é mais antigo que qualquer linha nova do lote).
    const guardianIdByKey = new Map();
    const mintedByName = new Map(); // lower(nome) → [{ id, hasPhone, seq }]
    const guardiansToInsert = [];
    for (let k = 0; k < guardianKeys.length; k++) {
      const gk = guardianKeys[k];
      const lowerName = gk.name.toLowerCase();
      const dbHit = guardianDbHit.get(k) || null;
      let gid = null;

      if (gk.phone) {
        gid = dbHit ? dbHit.id : null;
      } else {
        const candidates = [];
        if (dbHit) candidates.push({ id: dbHit.id, hasPhone: dbHit.hasPhone, seq: -1 });
        for (const m of (mintedByName.get(lowerName) || [])) candidates.push(m);
        candidates.sort((a, b) => (b.hasPhone ? 1 : 0) - (a.hasPhone ? 1 : 0) || a.seq - b.seq);
        gid = candidates.length ? candidates[0].id : null;
      }

      if (!gid) {
        gid = randomUUID();
        guardiansToInsert.push(gk);
        const minted = mintedByName.get(lowerName) || [];
        minted.push({ id: gid, hasPhone: !!gk.phone, seq: guardiansToInsert.length });
        mintedByName.set(lowerName, minted);
        gk.newId = gid;
      }
      guardianIdByKey.set(gk.key, gid);
    }

    if (guardiansToInsert.length) {
      await client.query(
        `-- tag:import_guardians_insert
         INSERT INTO karate_dojo_guardians (id, dojo_id, full_name, phone, email, relationship)
         SELECT t.id, $1::uuid, t.full_name, t.phone, t.email, t.relationship
           FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[])
                AS t(id, full_name, phone, email, relationship)`,
        [
          dojoId,
          guardiansToInsert.map((g) => g.newId),
          guardiansToInsert.map((g) => g.name),
          guardiansToInsert.map((g) => g.phone),
          guardiansToInsert.map((g) => g.email),
          guardiansToInsert.map((g) => g.relationship),
        ]
      );
    }

    // ── Vínculos e warnings que dependem do responsável resolvido ──
    for (const prep of survivors) {
      const rowGuardians = [];
      for (const gs of prep.guardianSources) {
        const gid = guardianIdByKey.get(guardianKeyOf(gs));
        // Mãe e pai com o MESMO nome resolvem para a mesma pessoa: um
        // vínculo só (o índice UNIQUE do vínculo também não deixaria dois).
        if (rowGuardians.some((x) => x.guardian_id === gid)) continue;
        rowGuardians.push({ guardian_id: gid, relationship: gs.relationship, is_primary: rowGuardians.length === 0 });
      }
      prep.rowGuardians = rowGuardians;

      // A PLANILHA TRAZ UM TELEFONE SÓ: o segundo responsável entra
      // NOMEADO E SEM CONTATO, e um warning por linha diz quem falta.
      if (prep.contactMovedToGuardian) {
        for (let k = 1; k < prep.guardianSources.length; k++) {
          prep.warn.push({
            row: prep.rowNum,
            code: 'GUARDIAN_SEM_CONTATO',
            message: `Responsável "${prep.guardianSources[k].name}" (${prep.guardianSources[k].relationship}) importado SEM telefone/e-mail — a planilha traz um contato só, que ficou com o responsável principal. Complete o contato dele na ficha do aluno.`,
          });
        }
      }

      // guardian_id (coluna legada) = o PRINCIPAL. Continua sendo escrito
      // exatamente como antes — é o que telas e serviços não reescritos
      // por este PR continuam lendo.
      prep.guardianId = rowGuardians.length ? rowGuardians[0].guardian_id : null;
      // Contato do PRÓPRIO aluno: só quando não foi "consumido" pelo
      // responsável derivado de mãe/pai (caminho 2 acima).
      prep.studentPhone = prep.contactMovedToGuardian && prep.guardianId ? null : prep.phone;
      prep.studentEmail = prep.contactMovedToGuardian && prep.guardianId ? null : prep.email;

      // Import TOLERANTE: menor sem responsável na planilha entra MESMO
      // ASSIM, com warning (o bloqueio 422 MENOR_SEM_RESPONSAVEL é só no form).
      if (prep.isMinorRow === true && !prep.guardianId) {
        prep.warn.push({ row: prep.rowNum, code: 'MENOR_SEM_RESPONSAVEL', message: 'Menor de 18 anos sem responsável vinculado (nem mãe/pai na planilha) — importado mesmo assim; vincule um responsável depois' });
      }
      // F12: idade desconhecida (sem birth_date) — decisão DECLARADA: trata
      // como adulto (contato fica no próprio aluno; mãe/pai só como
      // filiação), mas avisa para o sensei revisar manualmente.
      if (prep.isMinorRow === null) {
        prep.warn.push({ row: prep.rowNum, code: 'AGE_UNKNOWN_TREATED_AS_ADULT', message: 'Sem data de nascimento — não deu para saber se é menor; importado como adulto (revisar manualmente)' });
      }

      prep.studentId = randomUUID();
    }

    // ══════════════════════════════════════════════════════════
    // PASSO 3 — ESCRITAS EM LOTE
    // ══════════════════════════════════════════════════════════
    const linkedStudentIds = []; // F7.2: linhas que nasceram com praticante
    const pendingLinks = [];     // F13: vínculos aluno↔responsável do lote

    if (survivors.length) {
      // SEM ON CONFLICT de propósito: o dedupe já aconteceu acima, e
      // uq_karate_dojo_students_dojo_cpf é PARCIAL (WHERE cpf IS NOT NULL)
      // — um arbiter (dojo_id, cpf) sem repetir o predicado daria 42P10, e
      // com o predicado transformaria "duplicata" em upsert silencioso,
      // que é outra política de produto.
      const ins = await client.query(
        `-- tag:import_students_insert
         INSERT INTO karate_dojo_students
           (id, dojo_id, full_name, birth_date, cpf, rg, sex, phone, email,
            belt_label, belt_order, status, guardian_id,
            mother_name, father_name, zip_code, street, number, complement,
            neighborhood, city, state)
         SELECT t.id, $1::uuid, t.full_name, t.birth_date, t.cpf, t.rg, t.sex, t.phone, t.email,
                t.belt_label, t.belt_order, t.status, t.guardian_id,
                t.mother_name, t.father_name, t.zip_code, t.street, t.number, t.complement,
                t.neighborhood, t.city, t.state
           FROM unnest($2::uuid[], $3::text[], $4::date[], $5::text[], $6::text[], $7::text[],
                       $8::text[], $9::text[], $10::text[], $11::int[], $12::text[], $13::uuid[],
                       $14::text[], $15::text[], $16::text[], $17::text[], $18::text[], $19::text[],
                       $20::text[], $21::text[], $22::text[])
                AS t(id, full_name, birth_date, cpf, rg, sex, phone, email,
                     belt_label, belt_order, status, guardian_id,
                     mother_name, father_name, zip_code, street, number, complement,
                     neighborhood, city, state)
         RETURNING id, practitioner_id`,
        [
          dojoId,
          survivors.map((p) => p.studentId),
          survivors.map((p) => p.fullName),
          survivors.map((p) => p.birthDate),
          survivors.map((p) => p.cpf),
          survivors.map((p) => p.rg),
          survivors.map((p) => p.sex),
          survivors.map((p) => p.studentPhone),
          survivors.map((p) => p.studentEmail),
          survivors.map((p) => p.beltLabel),
          survivors.map((p) => p.beltOrder),
          survivors.map((p) => p.status),
          survivors.map((p) => p.guardianId),
          survivors.map((p) => p.motherName),
          survivors.map((p) => p.fatherName),
          survivors.map((p) => p.zipCode),
          survivors.map((p) => p.street),
          survivors.map((p) => p.number),
          survivors.map((p) => p.complement),
          survivors.map((p) => p.neighborhood),
          survivors.map((p) => p.city),
          survivors.map((p) => p.state),
        ]
      );

      // Sempre NULL hoje (o INSERT não grava a coluna). Conferir em vez de
      // supor é o que faz o caminho continuar correto quando isso mudar.
      for (const row of (ins && ins.rows) || []) {
        if (row && row.practitioner_id) linkedStudentIds.push(row.id);
      }

      const tagLinkStudents = [];
      const tagLinkTags = [];
      for (const prep of survivors) {
        if (!prep.tagName) continue;
        const tagId = tagIdByKey.get(prep.tagName.toLowerCase());
        if (!tagId) continue;
        tagLinkStudents.push(prep.studentId);
        tagLinkTags.push(tagId);
      }
      if (tagLinkStudents.length) {
        await client.query(
          `-- tag:import_student_tags
           INSERT INTO karate_dojo_student_tags (student_id, tag_id)
           SELECT t.student_id, t.tag_id
             FROM unnest($1::uuid[], $2::uuid[]) AS t(student_id, tag_id)
           ON CONFLICT (student_id, tag_id) DO NOTHING`,
          [tagLinkStudents, tagLinkTags]
        );
      }

      for (const prep of survivors) {
        for (const g of prep.rowGuardians) {
          pendingLinks.push({
            student_id: prep.studentId,
            guardian_id: g.guardian_id,
            relationship: g.relationship,
            is_primary: g.is_primary,
          });
        }
      }
    }

    // F13 — vínculos do lote em UMA query, dentro de SAVEPOINT. Lista
    // vazia = ZERO query (nenhum aluno com responsável no lote).
    // Reimportar o mesmo arquivo não duplica vínculo: o aluno repetido é
    // SKIPPED pelo dedupe antes de chegar aqui e, mesmo que chegasse, o
    // upsert do vínculo é idempotente pelo par (student_id, guardian_id).
    guardianLinksResult = {
      written: await guardianLinks.upsertLinksBatchInTx(client, pendingLinks),
      count: pendingLinks.length,
    };

    // Lista vazia = ZERO query (ver cabeçalho). Quando houver linhas
    // vinculadas, é UMA query de candidatos para o lote inteiro.
    identitySyncResult = await identitySync.syncStudentsBatch(client, {
      dojoId,
      federationId: ctx.federationId || null,
      studentIds: linkedStudentIds,
      actor: ctx.actor || null,
    });

    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* conexão pode ter caído */ }
    throw e;
  } finally {
    client.release();
  }

  // Warnings saem agrupados por LINHA, na ordem da planilha — e dentro de
  // cada linha, na mesma ordem de antes.
  const warnings = [];
  let created = 0;
  let skipped = 0;
  for (const prep of prepared) {
    if (prep.skipped) skipped++;
    else created++;
    for (const w of prep.warn) warnings.push(w);
  }

  return { created, skipped, warnings, identity_sync: identitySyncResult, guardian_links: guardianLinksResult };
}

// ── Responsáveis (CRUD mínimo) ──
async function listGuardians(dojoId) {
  const { rows } = await db.query(
    `SELECT g.id, g.full_name, g.cpf, g.phone, g.email, g.relationship,
            g.created_at, g.updated_at,
            count(s.id)::int AS students_count
       FROM karate_dojo_guardians g
       LEFT JOIN karate_dojo_students s ON s.guardian_id = g.id
      WHERE g.dojo_id = $1
      GROUP BY g.id
      ORDER BY g.full_name ASC
      LIMIT 1000`,
    [dojoId]
  );
  return rows.map((r) => ({
    id: r.id,
    full_name: r.full_name,
    cpf: r.cpf || null,
    phone: r.phone || null,
    email: r.email || null,
    relationship: r.relationship || null,
    students_count: Number(r.students_count) || 0,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

async function createGuardian(dojoId, data) {
  const { rows } = await db.query(
    `INSERT INTO karate_dojo_guardians (dojo_id, full_name, cpf, phone, email, relationship)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, full_name, cpf, phone, email, relationship, created_at, updated_at`,
    [
      dojoId,
      data.full_name,
      data.cpf !== undefined ? data.cpf : null,
      data.phone !== undefined ? data.phone : null,
      data.email !== undefined ? data.email : null,
      data.relationship !== undefined ? data.relationship : null,
    ]
  );
  return rows[0];
}

const GUARDIAN_UPDATABLE_COLS = ['full_name', 'cpf', 'phone', 'email', 'relationship'];

// F8: PATCH do responsável agora pode subir para a federação — 1
// responsável : N alunos (comentário de topo do arquivo), então uma
// mudança aqui pode afetar VÁRIAS fichas adotadas de uma vez. `ctx` é o
// mesmo formato de updateStudent/setStudentPhoto (identityCtx(req) na
// rota): { federationId, actor }.
async function updateGuardian(dojoId, guardianId, data, ctx = {}) {
  const existing = await db.query(
    `SELECT id, full_name, cpf, phone, email, relationship, created_at, updated_at
       FROM karate_dojo_guardians
      WHERE id = $1 AND dojo_id = $2
      LIMIT 1`,
    [guardianId, dojoId]
  );
  if (!existing.rows.length) {
    throw svcError(404, 'NOT_FOUND', 'Responsável não encontrado neste dojô');
  }
  const sets = [];
  const vals = [];
  for (const col of GUARDIAN_UPDATABLE_COLS) {
    if (data[col] !== undefined) {
      vals.push(data[col]);
      sets.push(`${col} = $${vals.length}`);
    }
  }
  if (!sets.length) return existing.rows[0]; // PATCH vazio = no-op
  sets.push('updated_at = now()');
  vals.push(guardianId, dojoId);
  const buildUpdate = () => ({
    sql: `UPDATE karate_dojo_guardians SET ${sets.join(', ')}
      WHERE id = $${vals.length - 1} AND dojo_id = $${vals.length}
      RETURNING id, full_name, cpf, phone, email, relationship, created_at, updated_at`,
    vals,
  });

  // Quais alunos DESTE responsável têm praticante vinculado — só esses
  // têm o que sincronizar (syncStudentsBatch filtra de novo por ficha
  // ADOTADA POR ESTE dojô; passar um aluno não-adotado aqui é inofensivo,
  // ele só não gera UPDATE). Sem nenhum, o caminho continua sendo a
  // MESMA UPDATE de sempre, sem transação — a maioria dos responsáveis
  // não tem aluno federado.
  const linked = await db.query(
    `SELECT id FROM karate_dojo_students WHERE guardian_id = $1 AND dojo_id = $2 AND practitioner_id IS NOT NULL`,
    [guardianId, dojoId]
  );
  const studentIds = linked.rows.map((r) => r.id);

  if (!studentIds.length) {
    const q = buildUpdate();
    const upd = await db.query(q.sql, q.vals);
    return upd.rows[0];
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const q = buildUpdate();
    const upd = await client.query(q.sql, q.vals);
    if (!upd.rows.length) {
      await client.query('ROLLBACK');
      throw svcError(404, 'NOT_FOUND', 'Responsável não encontrado neste dojô');
    }

    // Mesmo mecanismo do import (F7.2/F8): 1 query de candidatos para
    // TODOS os alunos deste responsável, nunca 1 por aluno.
    const syncResult = await identitySync.syncStudentsBatch(client, {
      dojoId,
      federationId: ctx.federationId || null,
      studentIds,
      actor: ctx.actor || null,
      source: identitySync.SOURCE_STUDENT_EDIT,
    });

    await client.query('COMMIT');
    const g = upd.rows[0];
    g.identity_sync = syncResult;
    return g;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* conexão pode ter caído */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  IMPORT_MAX_ROWS,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  IDENTITY_COLS,
  PARENTAGE_COLS,
  SYNCED_IDENTITY_COLS,
  computeAge,
  isMinor,
  parsePaging,
  touchedIdentityCols,
  validateStudentPayload,
  validateGuardianPayload,
  listStudents,
  listStudentsPaged,
  countStudents,
  getSummary,
  getStudent,
  createStudent,
  updateStudent,
  deleteStudent,
  importStudents,
  listGuardians,
  createGuardian,
  updateGuardian,
  setStudentPhoto,
  // F12 — normalizadores puros do import (testáveis sem banco)
  normalizePhoneDigits,
  isValidCpfChecksum,
  splitAddress,
  normalizeImportStatus,
  parseImportBeltLabel,
  detectImportBeltLevel,
  // F5a — caminho 2 (solicitação H1). O caminho 1 e o desfederar são da
  // F7.1 (karateStudentIdentityLink); as versões antigas daqui foram
  // removidas na F7.2 por não terem chamador.
  federateStudentByRequest,
  // F13 — vínculo N:N aluno↔responsável (migration 280). A mecânica mora
  // em services/karateDojoStudentGuardians.js; reexportado aqui para as
  // rotas/testes não precisarem conhecer dois módulos.
  MAX_GUARDIANS_PER_STUDENT: guardianLinks.MAX_GUARDIANS_PER_STUDENT,
  listStudentGuardians: guardianLinks.listForStudent,
};
