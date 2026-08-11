// ============================================================
// AURA DOJÔ — GOVERNANÇA DA GESTÃO DA FICHA (lado FEDERAÇÃO)
// + EXCLUSÃO DE DOJÔ = DESATIVAÇÃO (compliance, 11/08/2026)
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
// (ver src/routes/index.js). A ordem é obrigatória:
//
//   DELETE /federation/:id/practitioners/:practitionerId   (intercepta: AVISA)
//   DELETE /federation/:id/dojos/:dojoId                    (RESPONDE: DESATIVA)
//   POST   /federation/:id/dojos/:dojoId/identity/reclaim    (staffWrite + motivo)
//   GET    /federation/:id/identity/exited-dojos             (read)
//   POST   /federation/:id/identity/regularize               (staffWrite, ?dry_run=1)
//
// ── A MUDANÇA DE 11/08/2026: O DELETE DE DOJÔ NÃO APAGA MAIS ──
// Até aqui esta rota era um INTERCEPTADOR: devolvia a gestão das fichas e
// chamava next(), e quem respondia era o handler de karateDojos.js — que
// apagava a linha de `companies` de verdade e, com ?cascade=true, arrastava
// junto os `customers` do dojô e, por ON DELETE CASCADE do schema,
// `karate_belt_history` (as GRADUAÇÕES), certificados e inscrições. São 207
// FKs CASCADE apontando para `companies`, e o guard é `guards.staffWrite()`
// (owner | federation_admin | federation_staff) — perfil operacional comum,
// não admin de plataforma.
//
// Os termos de uso obrigam a guardar os dados por 60 dias. Decisão do dono do
// produto (11/08/2026): "a rota passa a desativar em vez de apagar. Dessa
// forma podemos disponibilizar os dados e também excluir posteriormente sem
// nos impactar ou sem impactar a federação."
//
// Este router é o PRIMEIRO handler que o Express alcança para
// DELETE /federation/:id/dojos/:dojoId. Ele agora RESPONDE (não chama mais
// next()), delegando o trabalho a services/karateDojoDeactivationService.js —
// o caminho destrutivo de karateDojos.js deixa de ser alcançável. O teste
// tests/integration/karateDojoDeleteSoft.test.js congela isso pelo app
// COMPOSTO: se alguém trocar a ordem de montagem em src/routes/index.js, ele
// fica vermelho.
//
// ── POR QUE A DEVOLUÇÃO DA GESTÃO CONTINUA (e por que ela mudou de lugar) ──
// Ela existia por DUAS razões e só uma sumiu:
//   (a) TÉCNICA (sumiu): customers.karate_identity_dojo_id tem FK ON DELETE
//       SET NULL (migration 262) e a mesma migration criou o CHECK
//       customers_karate_identity_coherent. Apagar a company de um dojô que
//       ainda mantinha alguma ficha violava o CHECK → 23514 → 500. Sem DELETE,
//       não há SET NULL, e o CHECK não é mais violado.
//   (b) DE PRODUTO (fica): premissa 3. Dojô desativado não deve continuar
//       gerindo identidade. E `is_active = false` já é uma das três pernas de
//       "o dojô saiu do Aura" em services/karateDojoExitState.js
//       (EXIT_REASONS.COMPANY_INACTIVE) — ou seja, a guarda preguiçosa já
//       liberaria a escrita da federação NA HORA. A devolução deixou de ser
//       o que impede um crash e passou a ser o que faz o BANCO parar de
//       mentir, exatamente como POST /identity/regularize.
//
// Por isso a ORDEM INVERTEU: antes era devolver→apagar (obrigatório, senão
// 23514); agora é desativar→devolver. Isso apaga de vez o trade-off que o
// cabeçalho antigo assumia ("se o DELETE for recusado com 409 as fichas já
// terão voltado"): não há mais 409, e num dojô inexistente (404) nada é
// devolvido — o interceptador antigo não conseguia garantir isso.
//
// ── O DELETE DE PRATICANTE CONTINUA LIVRE (premissa 2) ──────
// O interceptador de praticante NÃO bloqueia, NÃO devolve gestão e NÃO grava
// nada: ele só AVISA. Esse comportamento não foi tocado por este PR.
//
// ── DEFENSIVO ───────────────────────────────────────────────
// A devolução da gestão nunca pode derrubar a desativação: qualquer erro
// nela é logado e a resposta sai assim mesmo (o dojô JÁ está desativado, e
// POST /identity/regularize resolve o resto depois).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const { loadIdentityOwner } = require('../services/karateIdentityWriteGuard');
const reclaim = require('../services/karateIdentityReclaim');
const deactivation = require('../services/karateDojoDeactivationService');

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Motivo fixo da devolução disparada pela EXCLUSÃO do dojô. É texto de
// TRILHA (fica em karate_identity_audit.changes[].reason), não de UI.
const DELETE_RECLAIM_REASON =
  'Desativação do dojô pela federação: a gestão das fichas voltou para a federação. Nenhum dado foi apagado.';

// Motivo gravado no carimbo de retenção (companies.removal_reason, migration
// 277). Também é texto de TRILHA, não de UI.
const REMOVAL_REASON =
  'Remoção do dojô solicitada pela federação (a rota DELETE desativa; nada é apagado).';

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
// DELETE DE DOJÔ — DESATIVA. NADA É APAGADO.
// ============================================================
// Resposta 200:
//   { deactivated:true, deleted:false, id, name, is_active:false,
//     already_inactive, counts, roster_cascade, retention:{...},
//     reactivate:{...}, cascade_requested, cascade_ignored,
//     identity_released? }
//
// ?cascade=true — ACEITO E IGNORADO, nunca em silêncio.
//   O parâmetro só existia para autorizar o expurgo. Recusá-lo com 4xx
//   transformaria em erro a chamada que o front JÁ faz hoje (é o segundo
//   passo do fluxo "Excluir definitivamente") e deixaria o operador sem
//   saída. Aceitar e responder `cascade_ignored:true` mantém a chamada
//   funcionando e diz a verdade: o caminho destrutivo que ele pedia não
//   existe mais.
//
// 409 HAS_HISTORY — REMOVIDO.
//   Ele era a trava contra destruir histórico por engano. Não há mais
//   destruição: a operação é reversível por PATCH { is_active:true }. Mantê-lo
//   obrigaria toda desativação de dojô com histórico (isto é, praticamente
//   todas) a passar pelo ?cascade=true que agora ignoramos — barreira sem
//   nada atrás. O que ele carregava de útil, o `counts`, continua na resposta
//   de sucesso, para a UI poder dizer quantos praticantes foram desativados
//   junto.
router.delete('/dojos/:dojoId', ...guards.staffWrite(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;
  if (!isUuid(dojoId)) {
    return res.status(422).json({ error: 'dojoId inválido', code: 'VALIDATION_ERROR' });
  }

  const cascadeRequested = String((req.query && req.query.cascade) || '').toLowerCase() === 'true';
  const actor = actorFrom(req);

  let out;
  try {
    out = await deactivation.deactivateDojo({
      federationId,
      dojoId,
      actorId: actor.userId,
      reason: REMOVAL_REASON,
    });
  } catch (e) {
    console.error('[karateIdentityGovernance] desativação do dojô falhou:', (e && e.code) || '', e && e.message);
    return res.status(500).json({ error: 'Erro ao desativar o dojô', code: 'DEACTIVATION_FAILED' });
  }

  if (!out || !out.found) {
    return res.status(404).json({ error: 'Dojô não encontrado', code: 'NOT_FOUND' });
  }

  // Premissa 3, DEPOIS da desativação (ver o cabeçalho). Best-effort: falhar
  // aqui não desfaz nem esconde a desativação, que já está commitada.
  let identityReleased = null;
  try {
    const rel = await reclaim.reclaimDojoIdentities({
      federationId,
      dojoId,
      reason: DELETE_RECLAIM_REASON,
      actor,
    });
    if (rel && rel.count) {
      identityReleased = {
        count: rel.count,
        practitioners: rel.released,
        message:
          `${rel.count} ficha(s) que este dojô mantinha voltaram para a gestão da federação. ` +
          'Nenhum dado foi apagado por causa disso — só o marcador de quem gerencia a ficha mudou.',
      };
    }
  } catch (e) {
    console.error('[karateIdentityGovernance] devolução da gestão após a desativação falhou:', (e && e.code) || '', e && e.message);
  }

  return res.json({
    deactivated: true,
    deleted: false,
    code: 'DEACTIVATED',
    id: out.id,
    name: out.name,
    is_active: false,
    already_inactive: out.already_inactive,
    counts: out.counts,
    roster_cascade: out.roster_cascade,
    retention: {
      policy_days: out.retention_days,
      removal_requested_at: out.removal_requested_at,
      note:
        'Os dados continuam no Aura. A exclusão definitiva é tratada fora desta rota, ' +
        `depois do prazo de ${out.retention_days} dias previsto nos termos de uso.`,
    },
    reactivate: {
      method: 'PATCH',
      path: `/api/v1/federation/${federationId}/dojos/${dojoId}`,
      body: { is_active: true },
      note:
        'Reativar restaura os praticantes que estavam ativos no momento da desativação ' +
        'e abre a validação de quadro com o sensei.',
    },
    cascade_requested: cascadeRequested,
    cascade_ignored: cascadeRequested,
    message: out.already_inactive
      ? 'Este dojô já estava desativado. Nada foi apagado.'
      : 'Dojô desativado. Nenhum dado foi apagado: praticantes, graduações, certificados e histórico financeiro continuam no Aura.',
    ...(identityReleased ? { identity_released: identityReleased } : {}),
  });
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
