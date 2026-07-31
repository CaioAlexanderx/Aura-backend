// ============================================================
// AURA DOJÔ — F5b: as TRÊS TROCAS FEDERATIVAS (lógica)
//
//   1. Certificados      — quem está APTO + pedir em lote + acompanhar
//   2. Inscrição em lote — o dojô inscreve seus alunos num evento da FPKT
//   3. Candidatos a exame— o dojô SUBMETE candidatos (nunca gradua)
//
// ── REGRA TRANSVERSAL (não negociável) ─────────────────────
// SÓ participa aluno com practitioner_id NOT NULL.
// A migration 253 deixou isso explícito: `is_federated` é a DECLARAÇÃO do
// sensei; `practitioner_id` é a CONFIRMAÇÃO da federação — e só a
// confirmação autoriza. Sem practitioner_id não existe a quem a federação
// emitiria certificado nem de quem cobraria inscrição. Por isso NENHUMA
// query desta fase filtra por is_federated: ele não é autorização.
// Quando alguém é pulado, a razão é ACIONÁVEL (ALUNO_NAO_FEDERADO), não
// um "não encontrado" genérico: o sensei precisa saber que falta federar.
//
// ── REUSO (nada de regra nova) ─────────────────────────────
//   karateCertificateService.createOrder    — pedido de certificado (dup
//     check por (practitioner_id, belt_level), INSERT, histórico, e-mail)
//   karateCertificateService.getOrdersByDojo— lista do dojô (já escopada)
//   karateEventEnrollmentService            — resolução do evento + dup
//     check + INSERT de candidato/inscrição (SQL do caminho público)
//
// ── ESCOPO DO DOJÔ NAS INSCRIÇÕES ─────────────────────────
// karate_belt_exam_candidates NÃO tem dojo_id. Havia duas saídas:
//   (a) criar a coluna — recusada: a fase inteira se resolve sem migration
//       e inventar coluna para uma leitura é caro (backfill + 2 sites de
//       INSERT existentes para manter).
//   (b) JOIN customers.dojo_id — recusada: é o dojô ATUAL do praticante;
//       uma transferência moveria a inscrição de dojô silenciosamente, e
//       um aluno federado por número FPKT (que veio de outro dojô) sumiria
//       da lista do dojô que acabou de inscrevê-lo.
// ESCOLHIDO: JOIN karate_dojo_students (s.dojo_id = dojô do token). A
// pergunta real é "quem do MEU quadro está inscrito", e o quadro é
// karate_dojo_students. Zero DDL.
//
// Defensivo 42P01/42703 em tudo (migrations 242/253 podem estar pendentes).
// ============================================================
'use strict';

const db = require('../config/database');
const { createOrder, getOrdersByDojo } = require('./karateCertificateService');
const enroll = require('./karateEventEnrollmentService');

const MAX_BATCH = 200;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Ranking de faixa — DELEGADO ao dicionário canônico (F8.0).
// Este mapa era uma cópia literal do CASE da migration 229 ("MESMOS pesos
// do CASE da migration 229", dizia o comentário) — e herdou dela a Roxa e a
// Azul Claro invertidas. A escala agora tem UM dono só:
// src/utils/karateBeltScale.js, espelhado pelo CASE da migration 264.
// BELT_ORDER e beltOrderOf continuam exportados com o mesmo formato para
// não quebrar nenhum consumidor; só os VALORES foram corrigidos.
const { BELT_ORDER, beltOrderOf } = require('../utils/karateBeltScale');

function serviceError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  e.isServiceError = true;
  return e;
}

function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

// ============================================================
// 1) CERTIFICADOS
// ============================================================

// ── listAptos ──────────────────────────────────────────
// DECISÃO DE MODELAGEM: a unidade da lista é a GRADUAÇÃO, não o aluno.
// karate_certificate_orders é chaveado por (practitioner_id, belt_level) —
// é exatamente isso que o dup check do createOrder usa. Então "já pediu"
// só tem resposta precisa por graduação. Um aluno que subiu 3 faixas e
// pediu certificado de 1 aparece 2 vezes — e está CERTO: são 2 certificados
// que ele tem direito de pedir.
//
// "Sem pedido" = NOT EXISTS pedido não-recusado para (praticante, faixa) —
// espelha o dup check de createOrder (status NOT IN ('refused')), senão a
// lista prometeria algo que o POST recusaria.
//
// o.practitioner_id é TEXT (migration 182) e s.practitioner_id é uuid —
// daí o ::text explícito. Sem cast, 42883 (operator does not exist).
async function listAptos(dojoId, federationId) {
  const { rows } = await db.query(
    `SELECT s.id                          AS student_id,
            s.full_name                   AS student_name,
            s.practitioner_id             AS practitioner_id,
            cu.name                       AS practitioner_name,
            cu.karate_registration_number AS fpkt_number,
            h.id                          AS belt_history_id,
            h.belt_level                  AS belt_level,
            h.belt_name                   AS belt_name,
            h.graduated_at                AS graduated_at,
            h.exam_id                     AS exam_id,
            e.name                        AS exam_name
       FROM karate_dojo_students s
       JOIN karate_belt_history h
         ON h.student_id = s.practitioner_id
        AND h.federation_id = $2
       LEFT JOIN customers cu        ON cu.id = s.practitioner_id
       LEFT JOIN karate_belt_exams e ON e.id = h.exam_id
      WHERE s.dojo_id = $1
        AND s.practitioner_id IS NOT NULL
        AND NOT EXISTS (
              SELECT 1
                FROM karate_certificate_orders o
               WHERE o.federation_id = $2
                 AND o.practitioner_id = s.practitioner_id::text
                 AND o.belt_level = h.belt_level
                 AND o.status <> 'refused'
            )
      ORDER BY h.graduated_at DESC NULLS LAST, s.full_name ASC
      LIMIT 500`,
    [dojoId, federationId]
  );

  return rows.map((r) => ({
    student_id: r.student_id,
    practitioner_id: r.practitioner_id,
    name: r.student_name || r.practitioner_name || null,
    fpkt_number: r.fpkt_number || null,
    belt_history_id: r.belt_history_id,
    belt_level: r.belt_level || null,
    belt_label: r.belt_name || null,
    belt_order: beltOrderOf(r.belt_level),
    graduated_at: r.graduated_at || null,
    exam_id: r.exam_id || null,
    exam_name: r.exam_name || null,
  }));
}

// Carrega os alunos DO DOJÔ pelos ids pedidos. Uma query só (nunca N+1) e
// sempre escopada por dojo_id do token — aluno de outro dojô simplesmente
// não volta e vira skip ALUNO_NAO_ENCONTRADO.
async function loadDojoStudents(dojoId, ids) {
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT id, full_name, practitioner_id, status
       FROM karate_dojo_students
      WHERE dojo_id = $1 AND id = ANY($2::uuid[])`,
    [dojoId, ids]
  );
  return new Map(rows.map((r) => [r.id, r]));
}

// Graduação alvo do pedido de certificado.
// - beltHistoryId informado → aquela graduação (validada contra o praticante
//   E a federação — o id vem do cliente, então nunca confiamos nele sozinho)
// - sem beltHistoryId → faixa ATUAL pela view canônica karate_current_belt
//   (a 229 já resolve "qual é a mais alta"), com degradação para o histórico
//   cru se a view não existir.
async function resolveGraduation(practitionerId, federationId, beltHistoryId) {
  if (beltHistoryId) {
    const { rows } = await db.query(
      `SELECT id, belt_level, belt_name, graduated_at AS current_since, exam_id
         FROM karate_belt_history
        WHERE id = $1 AND student_id = $2 AND federation_id = $3
        LIMIT 1`,
      [beltHistoryId, practitionerId, federationId]
    );
    return rows[0] || null;
  }

  try {
    const { rows } = await db.query(
      `SELECT belt_level, belt_name, current_since, exam_id
         FROM karate_current_belt
        WHERE student_id = $1 AND federation_id = $2
        LIMIT 1`,
      [practitionerId, federationId]
    );
    if (rows.length) return rows[0];
    return null;
  } catch (e) {
    if (e && e.code === '42P01') {
      // View ausente — UMA degradação para a tabela base, sem cadeia de retry.
      const { rows } = await db.query(
        `SELECT belt_level, belt_name, graduated_at AS current_since, exam_id
           FROM karate_belt_history
          WHERE student_id = $1 AND federation_id = $2
          ORDER BY graduated_at DESC
          LIMIT 1`,
        [practitionerId, federationId]
      );
      return rows[0] || null;
    }
    throw e;
  }
}

// Nome do exame para exam_ref (informativo no certificado). Best-effort de
// verdade: fora de transação, falha → null, o pedido segue.
async function lookupExamName(examId, federationId) {
  if (!examId) return null;
  try {
    const { rows } = await db.query(
      `SELECT name FROM karate_belt_exams WHERE id = $1 AND federation_id = $2 LIMIT 1`,
      [examId, federationId]
    );
    return (rows[0] && rows[0].name) || null;
  } catch (_) {
    return null;
  }
}

// ── createCertOrdersBatch ─────────────────────────────────
// items: [{ student_id, belt_history_id? }]
// Sem transação única de propósito: cada pedido é independente e
// createOrder já grava histórico + dispara e-mail. Um lote parcial é o
// resultado correto — e um BEGIN transformaria o primeiro DUPLICATE_ORDER
// num tx-poison para todos os seguintes.
async function createCertOrdersBatch({
  dojoId,
  federationId,
  items,
  delivery,
  createdBy,
  createdByName,
}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) throw serviceError(422, 'VALIDATION_ERROR', 'Informe items: [{ student_id }]');
  if (list.length > MAX_BATCH) {
    throw serviceError(422, 'VALIDATION_ERROR', `Máximo de ${MAX_BATCH} itens por lote`);
  }

  const skipped = [];
  const valid = [];
  for (const raw of list) {
    const it = raw || {};
    const sid = it.student_id != null ? String(it.student_id).trim() : '';
    if (!isUuid(sid)) {
      skipped.push({ student_id: it.student_id || null, reason: 'ID_INVALIDO', message: 'student_id inválido' });
      continue;
    }
    const bhId = it.belt_history_id != null ? String(it.belt_history_id).trim() : '';
    if (bhId && !isUuid(bhId)) {
      skipped.push({ student_id: sid, reason: 'ID_INVALIDO', message: 'belt_history_id inválido' });
      continue;
    }
    valid.push({ student_id: sid, belt_history_id: bhId || null });
  }

  const students = await loadDojoStudents(dojoId, valid.map((v) => v.student_id));

  const d = delivery || {};
  const orders = [];

  for (const item of valid) {
    const student = students.get(item.student_id);
    if (!student) {
      skipped.push({
        student_id: item.student_id,
        reason: 'ALUNO_NAO_ENCONTRADO',
        message: 'Aluno não encontrado neste dojô',
      });
      continue;
    }
    if (!student.practitioner_id) {
      skipped.push({
        student_id: item.student_id,
        name: student.full_name,
        reason: 'ALUNO_NAO_FEDERADO',
        message: 'Aluno ainda não confirmado pela federação — federe o aluno (número FPKT) antes de pedir o certificado',
      });
      continue;
    }

    let grad;
    try {
      grad = await resolveGraduation(student.practitioner_id, federationId, item.belt_history_id);
    } catch (e) {
      if (e && e.code === '42P01') throw e; // vira 503 SCHEMA_PENDING na rota
      throw e;
    }

    if (!grad) {
      skipped.push({
        student_id: item.student_id,
        name: student.full_name,
        reason: item.belt_history_id ? 'GRADUACAO_NAO_ENCONTRADA' : 'SEM_GRADUACAO',
        message: item.belt_history_id
          ? 'Graduação não encontrada para este praticante nesta federação'
          : 'Praticante ainda não tem graduação registrada na federação',
      });
      continue;
    }

    const examName = await lookupExamName(grad.exam_id, federationId);

    try {
      const order = await createOrder({
        federationId,
        dojoId, // SEMPRE do token — nunca do corpo
        practitionerId: student.practitioner_id,
        beltLevel: grad.belt_level,
        beltName: grad.belt_name || grad.belt_level,
        examDate: grad.current_since || null,
        examRef: examName,
        nomeImpresso: student.full_name,
        deliveryType: d.delivery_type === 'mail' ? 'mail' : 'pickup',
        addrCep: d.addr_cep || null,
        addrLogradouro: d.addr_logradouro || null,
        addrNumero: d.addr_numero || null,
        addrComplemento: d.addr_complemento || null,
        addrCidade: d.addr_cidade || null,
        observacao: d.observacao || null,
        createdBy: createdBy || null,
        createdByName: createdByName || null,
      });
      orders.push({
        student_id: item.student_id,
        order_id: order.id,
        belt_level: order.belt_level,
        belt_name: order.belt_name,
        status: order.status,
      });
    } catch (e) {
      if (e && e.code === 'DUPLICATE_ORDER') {
        skipped.push({
          student_id: item.student_id,
          name: student.full_name,
          reason: 'JA_SOLICITADO',
          message: 'Já existe pedido ativo para esta graduação',
        });
        continue;
      }
      if (e && e.code === 'TABLE_MISSING') throw e; // 503 SCHEMA_PENDING
      throw e;
    }
  }

  return { created: orders.length, orders, skipped };
}

// ── listCertOrders ─────────────────────────────────────
// Reuso puro de getOrdersByDojo — a mesma função que /certificate-orders/mine
// usa. A novidade da F5b não é a query, é o CANAL: agora dá para chegar
// nela pelo token do dojô (requireDojoAccess), não só por login Aura.
async function listCertOrders(dojoId, federationId, params) {
  return getOrdersByDojo(dojoId, federationId, params || {});
}

// ============================================================
// 2 e 3) INSCRIÇÃO EM LOTE / CANDIDATOS A EXAME
// ============================================================

// Os dois são o MESMO ato no banco (karate_belt_exams é a tabela canônica
// de evento: exame E curso), mudando apenas o que se aceita:
//   mode 'event'     → exame, curso canônico ou curso legado
//   mode 'belt_exam' → só exame de faixa (curso é recusado — a rota está
//                      errada para aquele objeto, não é um skip por aluno)
async function enrollBatch({ dojoId, federationId, eventId, studentIds, mode }) {
  const ids = Array.isArray(studentIds) ? studentIds : [];
  if (!ids.length) throw serviceError(422, 'VALIDATION_ERROR', 'Informe student_ids: [uuid]');
  if (ids.length > MAX_BATCH) {
    throw serviceError(422, 'VALIDATION_ERROR', `Máximo de ${MAX_BATCH} alunos por lote`);
  }

  const ev = await enroll.resolveFederationEvent(federationId, eventId);
  if (!ev) {
    throw serviceError(
      404,
      mode === 'belt_exam' ? 'EXAM_NOT_FOUND' : 'EVENT_NOT_FOUND',
      mode === 'belt_exam' ? 'Exame não encontrado nesta federação' : 'Evento não encontrado nesta federação'
    );
  }

  if (mode === 'belt_exam') {
    if (ev.kind !== 'exam') {
      throw serviceError(404, 'EXAM_NOT_FOUND', 'Exame não encontrado nesta federação');
    }
    if (ev.exam_type === 'curso') {
      throw serviceError(
        422,
        'NAO_E_EXAME',
        'Este evento é um curso, não um exame de faixa. Use a inscrição em evento.'
      );
    }
  }

  const skipped = [];
  const valid = [];
  for (const raw of ids) {
    const sid = raw != null ? String(raw).trim() : '';
    if (!isUuid(sid)) {
      skipped.push({ student_id: raw || null, reason: 'ID_INVALIDO', message: 'student_id inválido' });
      continue;
    }
    if (!valid.includes(sid)) valid.push(sid); // o mesmo id 2x no corpo não vira 2 inscrições
  }

  // Competição: inscrição exige category_id POR ATLETA (karate_competition_entries).
  // Não existe "inscrever o dojô inteiro" sem escolher a categoria de cada um,
  // e escolher por eles seria inventar regra. Todos entram como skip com
  // razão acionável — nunca um 500 nem uma inscrição errada.
  if (ev.kind === 'competition') {
    return {
      enrolled: 0,
      event: publicEvent(ev),
      skipped: skipped.concat(
        valid.map((sid) => ({
          student_id: sid,
          reason: 'COMPETICAO_NAO_SUPORTADA',
          message: 'Competição exige escolher a categoria de cada atleta — use a inscrição da competição',
        }))
      ),
    };
  }

  if (enroll.isEventClosed(ev)) {
    return {
      enrolled: 0,
      event: publicEvent(ev),
      skipped: skipped.concat(
        valid.map((sid) => ({
          student_id: sid,
          reason: 'EVENTO_FECHADO',
          message: 'As inscrições deste evento estão encerradas',
        }))
      ),
    };
  }

  const students = await loadDojoStudents(dojoId, valid);
  const enrolledList = [];

  // SEM BEGIN de propósito (ver cabeçalho do arquivo): cada aluno é uma
  // unidade independente; o UNIQUE (exam_id, student_id) é a rede de
  // segurança e um 23505 vira JA_INSCRITO em vez de envenenar o lote.
  for (const sid of valid) {
    const student = students.get(sid);
    if (!student) {
      skipped.push({
        student_id: sid,
        reason: 'ALUNO_NAO_ENCONTRADO',
        message: 'Aluno não encontrado neste dojô',
      });
      continue;
    }
    if (!student.practitioner_id) {
      skipped.push({
        student_id: sid,
        name: student.full_name,
        reason: 'ALUNO_NAO_FEDERADO',
        message: 'Aluno ainda não confirmado pela federação — federe o aluno (número FPKT) antes de inscrevê-lo',
      });
      continue;
    }

    const practitionerId = student.practitioner_id;

    try {
      if (ev.kind === 'exam') {
        const dup = await enroll.findExamCandidate(null, ev.id, practitionerId);
        if (dup) {
          skipped.push({
            student_id: sid,
            name: student.full_name,
            reason: 'JA_INSCRITO',
            message: 'Aluno já inscrito neste evento',
            candidate_id: dup.id,
          });
          continue;
        }
        const row = await enroll.insertExamCandidate(null, ev.id, practitionerId, {});
        enrolledList.push({
          student_id: sid,
          name: student.full_name,
          practitioner_id: practitionerId,
          candidate_id: row.id,
        });
      } else {
        const dup = await enroll.findCourseEnrollment(null, ev.id, practitionerId);
        if (dup) {
          skipped.push({
            student_id: sid,
            name: student.full_name,
            reason: 'JA_INSCRITO',
            message: 'Aluno já inscrito neste evento',
            enrollment_id: dup.id,
          });
          continue;
        }
        const row = await enroll.insertCourseEnrollment(null, ev.id, practitionerId, { dojoId });
        enrolledList.push({
          student_id: sid,
          name: student.full_name,
          practitioner_id: practitionerId,
          enrollment_id: row.id,
        });
      }
    } catch (e) {
      // Corrida entre o SELECT de duplicata e o INSERT: o UNIQUE resolve.
      // Idempotência real — reinscrever NUNCA duplica.
      if (e && e.code === '23505') {
        skipped.push({
          student_id: sid,
          name: student.full_name,
          reason: 'JA_INSCRITO',
          message: 'Aluno já inscrito neste evento',
        });
        continue;
      }
      throw e;
    }
  }

  return { enrolled: enrolledList.length, enrollments: enrolledList, event: publicEvent(ev), skipped };
}

function publicEvent(ev) {
  if (!ev) return null;
  return {
    id: ev.id,
    name: ev.name || null,
    kind: ev.kind,
    exam_type: ev.exam_type || ev.event_type || null,
    event_date: ev.event_date || null,
    location: ev.location || null,
    fee_amount: ev.fee_amount != null ? Number(ev.fee_amount) : null,
    status: ev.status || null,
  };
}

// ── listEnrollments ────────────────────────────────────
// "Quem do MEU quadro está inscrito neste evento". O INNER JOIN com
// karate_dojo_students é o escopo (ver cabeçalho): inscrito de outro dojô
// não aparece, e o aluno federado por número FPKT que veio de outro dojô
// aparece — que é o comportamento correto para o sensei que o inscreveu.
async function listEnrollments({ dojoId, federationId, eventId, mode }) {
  const ev = await enroll.resolveFederationEvent(federationId, eventId);
  if (!ev) {
    throw serviceError(
      404,
      mode === 'belt_exam' ? 'EXAM_NOT_FOUND' : 'EVENT_NOT_FOUND',
      mode === 'belt_exam' ? 'Exame não encontrado nesta federação' : 'Evento não encontrado nesta federação'
    );
  }
  if (mode === 'belt_exam' && ev.kind !== 'exam') {
    throw serviceError(404, 'EXAM_NOT_FOUND', 'Exame não encontrado nesta federação');
  }

  if (ev.kind === 'competition') {
    // Simétrico ao POST: o dojô não inscreve em competição por aqui, então
    // não promete listar. Lista vazia é mais honesto que meia-verdade.
    return { event: publicEvent(ev), data: [] };
  }

  if (ev.kind === 'exam') {
    // Colunas restritas à migration 157 de propósito: certificate_eligible
    // (202) e registration_responses (200) podem não existir e derrubariam
    // a leitura inteira com 42703.
    const { rows } = await db.query(
      `SELECT c.id           AS candidate_id,
              c.student_id   AS practitioner_id,
              c.status       AS status,
              c.target_belt  AS target_belt,
              c.fee_paid     AS fee_paid,
              c.created_at   AS created_at,
              s.id           AS student_id,
              s.full_name    AS student_name,
              s.belt_label   AS belt_label,
              s.belt_order   AS belt_order,
              cu.karate_registration_number AS fpkt_number
         FROM karate_belt_exam_candidates c
         JOIN karate_dojo_students s
           ON s.practitioner_id = c.student_id
          AND s.dojo_id = $2
         LEFT JOIN customers cu ON cu.id = c.student_id
        WHERE c.exam_id = $1
        ORDER BY s.full_name ASC`,
      [ev.id, dojoId]
    );
    return {
      event: publicEvent(ev),
      data: rows.map((r) => ({
        candidate_id: r.candidate_id,
        student_id: r.student_id,
        practitioner_id: r.practitioner_id,
        name: r.student_name,
        fpkt_number: r.fpkt_number || null,
        belt_label: r.belt_label || null,
        belt_order: r.belt_order != null ? Number(r.belt_order) : null,
        target_belt: r.target_belt || null,
        status: r.status,
        fee_paid: r.fee_paid === true,
        created_at: r.created_at,
      })),
    };
  }

  const { rows } = await db.query(
    `SELECT en.id         AS enrollment_id,
            en.student_id AS practitioner_id,
            en.status     AS status,
            en.fee_paid   AS fee_paid,
            en.created_at AS created_at,
            s.id          AS student_id,
            s.full_name   AS student_name,
            s.belt_label  AS belt_label,
            s.belt_order  AS belt_order,
            cu.karate_registration_number AS fpkt_number
       FROM karate_event_enrollments en
       JOIN karate_dojo_students s
         ON s.practitioner_id = en.student_id
        AND s.dojo_id = $2
       LEFT JOIN customers cu ON cu.id = en.student_id
      WHERE en.event_id = $1
      ORDER BY s.full_name ASC`,
    [ev.id, dojoId]
  );
  return {
    event: publicEvent(ev),
    data: rows.map((r) => ({
      enrollment_id: r.enrollment_id,
      student_id: r.student_id,
      practitioner_id: r.practitioner_id,
      name: r.student_name,
      fpkt_number: r.fpkt_number || null,
      belt_label: r.belt_label || null,
      belt_order: r.belt_order != null ? Number(r.belt_order) : null,
      status: r.status,
      fee_paid: r.fee_paid === true,
      created_at: r.created_at,
    })),
  };
}

module.exports = {
  MAX_BATCH,
  BELT_ORDER,
  beltOrderOf,
  listAptos,
  createCertOrdersBatch,
  listCertOrders,
  enrollBatch,
  listEnrollments,
};
