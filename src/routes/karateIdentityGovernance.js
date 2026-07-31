// ============================================================
// AURA DOJÔ — F7.4: GOVERNANÇA DA GESTÃO DA FICHA (lado FEDERAÇÃO)
//
// AS PREMISSAS (Caio, 30/07/2026)
//   1. "A federação não faz gestão de informação. O trabalho dela é apenas
//      receber a sincronização dos dados gerenciados pelos dojôs."
//   2. "Para os dojôs NÃO VINCULADOS, ou que NÃO TÊM AURA, a federação deve
//      ter TOTAL LIBERDADE e acesso para criação, edição e remoção de dados."
//   3. "Quando o dojô sai, os dados permanecem visíveis para a federação, mas
//      sem o acesso e gestão do dojô. Ou seja, a gestão volta para a federação."
//
// Montado sob /federation/:id, ANTES de karatePractitioners e de karateDojos
// (ver src/routes/index.js). A ordem é obrigatória: as duas primeiras rotas
// aqui são INTERCEPTADORES que rodam antes do handler real e chamam next().
//
//   DELETE /federation/:id/practitioners/:practitionerId   (intercepta: AVISA)
//   DELETE /federation/:id/dojos/:dojoId                    (intercepta: DEVOLVE)
//   POST   /federation/:id/dojos/:dojoId/identity/reclaim    (staffWrite + motivo)
//   GET    /federation/:id/identity/exited-dojos             (read)
//   POST   /federation/:id/identity/regularize               (staffWrite, ?dry_run=1)
//
// ── POR QUE INTERCEPTADOR, E NÃO EDIÇÃO DOS DOIS HANDLERS ───
// Os dois DELETEs vivem em karatePractitioners.js (80 KB) e karateDojos.js
// (70 KB). O que a F7.4 precisa fazer neles é ADITIVO e acontece ANTES do
// corpo de cada handler — nada do comportamento existente muda. Um router
// montado antes deixa os dois arquivos com 0 linha alterada (e, portanto, os
// testes deles intocados), e concentra a regra nova num arquivo só, que é a
// mesma escolha que fez a F7.3-A virar um módulo em vez de cinco cópias.
// Os guards são os MESMOS dos handlers reais (guards.staffWrite()), para o
// interceptador nunca ver uma requisição que o handler recusaria.
//
// ── O QUE O INTERCEPTADOR DE DOJÔ RESOLVE (é bug, não enfeite) ──
// customers.karate_identity_dojo_id tem FK ON DELETE SET NULL (migration 262)
// e a MESMA migration criou o CHECK customers_karate_identity_coherent
// (managed_by <> 'dojo' OR karate_identity_dojo_id IS NOT NULL). Apagar a
// company de um dojô que ainda mantém alguma ficha faz o SET NULL violar o
// CHECK → 23514 → 500 no DELETE do dojô. A cascata de karateDojos.js só apaga
// `customers WHERE dojo_id = $1` (onde a pessoa TREINA), que é uma coluna
// DIFERENTE de karate_identity_dojo_id (quem é DONO DA FICHA) — basta um
// praticante adotado que treine em outro dojô (o caso `is_transfer` da F7.1)
// para o DELETE estourar. Devolver a gestão ANTES é a única ordem possível.
//
// TRADE-OFF ASSUMIDO: se o DELETE do dojô for recusado logo depois
// (409 HAS_HISTORY, quando o staff não confirmou a cascata), as fichas JÁ
// terão voltado para a federação. É deliberado:
//   • a federação acabou de mandar apagar o dojô — a premissa 3 se aplica;
//   • nada é perdido: o aluno do dojô continua intacto e re-federar restaura
//     a adoção pela conferência da F7.1;
//   • a alternativa (devolver DEPOIS do DELETE) é impossível — o SET NULL já
//     teria estourado o CHECK e derrubado o DELETE inteiro;
//   • a resposta do 409 carrega `identity_released`, então não é silencioso.
//
// ── O DELETE DE PRATICANTE CONTINUA LIVRE (premissa 2) ──────
// O interceptador de praticante NÃO bloqueia, NÃO devolve gestão e NÃO grava
// nada: ele só AVISA. Apagar a ficha por baixo de um dojô ativo é destrutivo
// e hoje é silencioso — o aluno do dojô sobrevive e perde o vínculo
// (karate_dojo_students.practitioner_id vira NULL pela FK SET NULL da 262) sem
// que ninguém saiba. O aviso entra na resposta do 200; o comportamento do
// DELETE (200 / 409 HAS_HISTORY / ?cascade=true) fica exatamente igual.
//
// ── DEFENSIVO ───────────────────────────────────────────────
// Nenhum interceptador pode derrubar a operação real: qualquer erro aqui é
// logado e vira next(). "Não consegui montar o aviso" nunca pode virar
// "não consegui apagar".
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { loadIdentityOwner } = require('../services/karateIdentityWriteGuard');
const reclaim = require('../services/karateIdentityReclaim');

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Motivo fixo da devolução disparada pela EXCLUSÃO do dojô. É texto de
// TRILHA (fica em karate_identity_audit.changes[].reason), não de UI.
const DELETE_RECLAIM_REASON =
  'Exclusão do dojô pela federação: a gestão das fichas voltou para a federação antes de o cadastro do dojô ser apagado.';

function isUuid(v) {
  return !!v && UUID_RE.test(String(v));
}

// Ator SEMPRE do token, nunca do corpo (mesma regra da F7.1/F7.2/F7.3).
function actorFrom(req) {
  return {
    userId: (req.user && req.user.id) || null,
    label: (req.user && (req.user.name || req.user.email)) || null,
  };
}

// Acrescenta campos à resposta que o handler REAL vai emitir, sem tocar no
// handler. `when` decide, olhando o corpo, se o acréscimo se aplica.
function decorateJson(res, patch, when) {
  const original = res.json.bind(res);
  res.json = (body) => {
    try {
      const isPlain = body && typeof body === 'object' && !Array.isArray(body);
      if (isPlain && (!when || when(body))) return original(Object.assign({}, body, patch));
    } catch (e) {
      console.warn('[karateIdentityGovernance] falha ao decorar resposta (ignorada):', e && e.message);
    }
    return original(body);
  };
}

// ============================================================
// INTERCEPTADOR 1 — DELETE de praticante: AVISA, nunca bloqueia
// ============================================================
router.delete('/practitioners/:practitionerId', ...guards.staffWrite(), async (req, res, next) => {
  const practitionerId = req.params.practitionerId;
  // /practitioners/import é rota literal de outro router; e um :practitionerId
  // fora de forma UUID iria estourar `invalid input syntax for type uuid` numa
  // query que só existe para montar um AVISO.
  if (!isUuid(practitionerId)) return next();

  let owner;
  try {
    owner = await loadIdentityOwner(db, practitionerId);
  } catch (e) {
    console.warn('[karateIdentityGovernance] não consegui ler o dono da ficha antes do DELETE:', e && e.message);
    return next();
  }

  if (!owner || owner.managedBy !== 'dojo' || !owner.dojo) return next();

  const exit = owner.exit || { exited: false };
  const notice = exit.exited
    ? {
        was_managed_by_dojo: true,
        dojo_active: false,
        dojo: owner.dojo,
        dojo_exit_reason: exit.reason || null,
        message:
          `Esta ficha estava marcada como mantida pelo dojô ${owner.dojo.name || 'sem nome'}, ` +
          `mas ${exit.label} — a gestão já era da federação. O praticante foi excluído normalmente.`,
        student_link:
          'Se aquele dojô tinha um aluno vinculado a este praticante, o aluno NÃO foi apagado: ele ' +
          'continua no cadastro do dojô e apenas perdeu o vínculo (practitioner_id volta a ficar vazio).',
      }
    : {
        was_managed_by_dojo: true,
        dojo_active: true,
        dojo: owner.dojo,
        dojo_exit_reason: null,
        message:
          `ATENÇÃO: esta ficha era mantida pelo dojô ${owner.dojo.name || 'sem nome'}, que continua ATIVO no Aura. ` +
          'A exclusão foi feita (a federação tem liberdade para remover dados), mas o dojô não foi avisado.',
        student_link:
          'O aluno do dojô NÃO foi apagado: ele continua no cadastro do dojô e apenas perdeu o vínculo com ' +
          'este praticante (o campo de vínculo volta a ficar vazio). Se a exclusão foi engano, o sensei ' +
          'precisará federar o aluno de novo com o número FPKT — nenhum dado do aluno se perdeu.',
      };

  // Só entra na resposta de sucesso. 409 HAS_HISTORY / 404 seguem como são.
  decorateJson(res, { identity_notice: notice }, (body) => body.deleted === true);
  return next();
});

// ============================================================
// INTERCEPTADOR 2 — DELETE de dojô: DEVOLVE a gestão ANTES
// ============================================================
router.delete('/dojos/:dojoId', ...guards.staffWrite(), async (req, res, next) => {
  const { id: federationId, dojoId } = req.params;
  if (!isUuid(dojoId)) return next();

  let out;
  try {
    // MESMA porta da retomada manual (uma regra de devolução em lote, não
    // duas), com o motivo da exclusão no lugar do motivo digitado pelo staff.
    out = await reclaim.reclaimDojoIdentities({
      federationId,
      dojoId,
      reason: DELETE_RECLAIM_REASON,
      actor: actorFrom(req),
    });
  } catch (e) {
    // Nunca derruba o DELETE por causa da devolução: se ela falhar, o DELETE
    // segue e (no pior caso) estoura o 23514 que já estourava antes deste PR.
    console.error('[karateIdentityGovernance] devolução pré-DELETE do dojô falhou:', (e && e.code) || '', e && e.message);
    return next();
  }

  if (!out || !out.count) return next();

  decorateJson(res, {
    identity_released: {
      count: out.count,
      practitioners: out.released,
      message:
        `${out.count} ficha(s) que este dojô mantinha voltaram para a gestão da federação antes da exclusão. ` +
        'Nenhum dado foi apagado por causa disso — só o marcador de quem gerencia a ficha mudou.',
    },
  });
  return next();
});

// ============================================================
// RETOMADA MANUAL — a federação retoma o dojô INTEIRO
// ============================================================
// "o dojô sumiu mas ninguém cancelou nada": um caminho explícito, com motivo,
// que resolve todas as fichas daquele dojô de uma vez — sem depender de
// override praticante a praticante e sem esperar rotina nenhuma.
//
//   POST /federation/:id/dojos/:dojoId/identity/reclaim  { reason }
//   200 { reclaimed:true, count, released[] }
//   422 RECLAIM_REASON_REQUIRED
router.post('/dojos/:dojoId/identity/reclaim', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;
  if (!isUuid(dojoId)) {
    return res.status(422).json({ error: 'dojoId inválido', code: 'VALIDATION_ERROR' });
  }
  try {
    const out = await reclaim.reclaimDojoIdentities({
      federationId,
      dojoId,
      reason: (req.body || {}).reason,
      actor: actorFrom(req),
    });
    return res.json(out);
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.message, code: e.code || 'ERROR' });
    console.error('[karateIdentityGovernance] reclaim error:', e.message);
    return res.status(500).json({ error: 'Erro ao retomar a gestão das fichas deste dojô' });
  }
});

// ============================================================
// RELATÓRIO — quais dojôs saíram e quantas fichas ainda seguram
// ============================================================
//   GET /federation/:id/identity/exited-dojos
//   200 { data:[{dojo_id, dojo_name, exit_reason, exit_label, practitioners}],
//         count, practitioners_pending }
router.get('/identity/exited-dojos', ...guards.read(), async (req, res) => {
  try {
    const out = await reclaim.listExitedDojos({ federationId: req.params.id });
    return res.json(out);
  } catch (e) {
    console.error('[karateIdentityGovernance] exited-dojos error:', e.message);
    return res.status(500).json({ error: 'Erro ao listar dojôs que saíram' });
  }
});

// ============================================================
// REGULARIZAÇÃO EM LOTE — arruma o que ficou para trás
// ============================================================
// A guarda preguiçosa já desbloqueia a federação NA HORA; esta rotina existe
// para o BANCO parar de mentir (e para a tela do relatório zerar).
// ?dry_run=1 devolve o relatório SEM escrever.
//
//   POST /federation/:id/identity/regularize?dry_run=1&limit=500
router.post('/identity/regularize', ...guards.staffWrite(), async (req, res) => {
  const dryRun = req.query.dry_run === '1' || req.query.dry_run === 'true';
  const dojoId = req.query.dojo_id && isUuid(req.query.dojo_id) ? String(req.query.dojo_id) : null;
  try {
    const out = await reclaim.regularizeExitedIdentities({
      federationId: req.params.id,
      dojoId,
      limit: req.query.limit,
      dryRun,
      actor: actorFrom(req),
    });
    return res.json(out);
  } catch (e) {
    console.error('[karateIdentityGovernance] regularize error:', e.message);
    return res.status(500).json({ error: 'Erro ao regularizar a gestão das fichas' });
  }
});

module.exports = router;
