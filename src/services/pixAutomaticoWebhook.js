// ============================================================
// AURA. — Eventos PIX_AUTOMATIC_* do webhook da Asaas (tq-105, 24/10/2026)
//
// Chamado por routes/webhookAsaas.js ANTES do guard "!payment" (esses eventos
// não têm `payment`). O token do webhook já foi validado lá; aqui chega
// `hasSecret` para saber se o corpo é confiável.
//
// Formato (docs.asaas.com, "Eventos para Pix Automático", conferido 24/10):
//   { id: 'evt_...', event, dateCreated, account: {id, ownerId},
//     authorization: {...} | paymentInstruction: {...} | eligibility: {...} }
//
// Regras:
//   1. Idempotência pelo id do evento: pix_automatico_eventos.event_key é
//      UNIQUE. O INSERT é a "reserva"; reenvio não entra e responde
//      duplicate. Se o processamento falhar, a reserva é apagada para o
//      próximo reenvio da Asaas (ou um reenvio manual) processar de novo.
//      Sem a migration 406 (42P01), processa sem reserva: tudo aqui é
//      idempotente por construção (status com guarda, aviso com dedupeKey).
//   2. Status da autorização em companies.pix_auto_status, só para a
//      autorização ATUAL da empresa (companies.asaas_pix_auto_authorization_id).
//      Evento de uma autorização antiga atualiza só a linha dela em
//      pix_automatico_autorizacoes.
//   3. refused / cancelled / expired são finais: nenhum evento atrasado
//      (CREATED, ACTIVATED) liga de novo. Um CREATED atrasado não rebaixa
//      active. Assim, REFUSED depois do PAYMENT_RECEIVED deixa tudo
//      desligado — o PAYMENT_RECEIVED da primeira cobrança segue o fluxo de
//      pagamento de sempre e nunca toca em pix_auto_status.
//   4. Cancelada sem ser pela Aura (REQUESTED_BY_RECEIVER_USER) = sinal de
//      saída: aviso no sininho da empresa "Aura." (o mesmo canal do lembrete
//      de fatura não paga), para a Cassie ver no mesmo dia.
//   5. Elegibilidade da conta: grava em pix_automatico_elegibilidade (linha
//      única) e loga; INELIGIBLE também avisa no sininho da equipe.
//   6. Instruções de pagamento: só registradas (o livro de concessões e a
//      consulta semanal são do tq-106).
//   7. Sem ASAAS_WEBHOOK_SECRET o corpo não é confiável: a autorização é
//      relida na Asaas (GET) e vale o status de lá; elegibilidade e
//      instrução não têm releitura e só são logadas, sem gravar nada.
// ============================================================
'use strict';

// Conta da equipe que recebe os avisos internos (a mesma do lembrete de
// fatura, migration 367: empresa "Aura.").
const EMPRESA_DA_EQUIPE_PADRAO = '645c1325-8865-48be-af6f-430d93fb2b6c';

function empresaDaEquipe() {
  return String(process.env.PIX_AUTO_ALERT_COMPANY_ID || '').trim() || EMPRESA_DA_EQUIPE_PADRAO;
}

const PREFIXO = 'PIX_AUTOMATIC_RECURRING_';

const STATUS_POR_EVENTO = {
  PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CREATED:   'pending',
  PIX_AUTOMATIC_RECURRING_AUTHORIZATION_ACTIVATED: 'active',
  PIX_AUTOMATIC_RECURRING_AUTHORIZATION_REFUSED:   'refused',
  PIX_AUTOMATIC_RECURRING_AUTHORIZATION_CANCELLED: 'cancelled',
  PIX_AUTOMATIC_RECURRING_AUTHORIZATION_EXPIRED:   'expired',
};

// Status da Asaas (GET da autorização) → vocabulário de companies.pix_auto_status.
const STATUS_DA_ASAAS = {
  CREATED:   'pending',
  ACTIVE:    'active',
  REFUSED:   'refused',
  CANCELLED: 'cancelled',
  EXPIRED:   'expired',
};

const FINAIS = new Set(['refused', 'cancelled', 'expired']);

const CANCELADA_PELA_AURA = 'REQUESTED_BY_RECEIVER_USER';
const CANCELADA_PELA_PAGADORA = 'REQUESTED_BY_PAYER_USER';

const COLUNA_DE_DATA = {
  active: 'activated_at',
  refused: 'refused_at',
  cancelled: 'cancelled_at',
  expired: 'expired_at',
};

/**
 * Pode sair de `atual` para `novo`? null = não muda.
 *   - igual: não muda;
 *   - final (refused/cancelled/expired): nunca sai;
 *   - CREATED atrasado não rebaixa active.
 */
function proximoStatus(atual, novo) {
  if (!novo) return null;
  const a = atual || null;
  if (a === novo) return null;
  if (a && FINAIS.has(a)) return null;
  if (novo === 'pending' && a === 'active') return null;
  return novo;
}

function tipoDoEvento(event) {
  if (/^PIX_AUTOMATIC_RECURRING_AUTHORIZATION_/.test(event)) return 'autorizacao';
  if (/^PIX_AUTOMATIC_RECURRING_PAYMENT_INSTRUCTION_/.test(event)) return 'instrucao';
  if (event === PREFIXO + 'ELIGIBILITY_UPDATED') return 'elegibilidade';
  return 'outro';
}

// O exemplo de instrução da documentação não traz `id` no topo: a chave cai
// para evento + objeto + status + data, que também se repete num reenvio.
function chaveDoEvento(body) {
  if (body && body.id) return String(body.id);
  const obj = (body && (body.authorization || body.paymentInstruction || body.eligibility)) || {};
  return [body && body.event, obj.id || '', obj.status || '', (body && body.dateCreated) || ''].join(':');
}

function dataBr(iso) {
  const s = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

async function reservar(db, { chave, event, authorizationId, status, verified, body }) {
  try {
    const r = await db.query(
      `INSERT INTO pix_automatico_eventos (event_key, event, authorization_id, status, verified, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (event_key) DO NOTHING
       RETURNING id`,
      [chave, event, authorizationId || null, status || null, !!verified, JSON.stringify(body)]
    );
    return { reservado: !!(r && r.rows && r.rows.length), semTabela: false };
  } catch (err) {
    if (err.code === '42P01') {
      console.warn('[pixAutomatico] migration 406 ausente — evento processado sem reserva (idempotente): ' + event);
      return { reservado: true, semTabela: true };
    }
    throw err;
  }
}

async function concluir(db, reserva, chave, { companyId, result }) {
  if (reserva.semTabela) return;
  await db.query(
    `UPDATE pix_automatico_eventos
        SET company_id = $2, result = $3, processed_at = NOW()
      WHERE event_key = $1`,
    [chave, companyId || null, result]
  ).catch((e) => console.error('[pixAutomatico] falha ao concluir evento ' + chave + ': ' + e.message));
}

async function desfazerReserva(db, reserva, chave) {
  if (reserva.semTabela) return;
  await db.query('DELETE FROM pix_automatico_eventos WHERE event_key = $1 AND processed_at IS NULL', [chave])
    .catch((e) => console.error('[pixAutomatico] falha ao soltar reserva ' + chave + ': ' + e.message));
}

// Empresa da autorização: primeiro a autorização ATUAL (companies), depois
// uma antiga (pix_automatico_autorizacoes).
async function acharEmpresa(db, authorizationId) {
  const r = await db.query(
    `SELECT id, pix_auto_status, COALESCE(trade_name, legal_name) AS nome
       FROM companies WHERE asaas_pix_auto_authorization_id = $1 LIMIT 1`,
    [authorizationId]
  );
  if (r.rows.length) return { empresa: r.rows[0], atual: true };
  try {
    const a = await db.query(
      'SELECT company_id FROM pix_automatico_autorizacoes WHERE id = $1 LIMIT 1',
      [authorizationId]
    );
    if (a.rows.length) return { empresa: { id: a.rows[0].company_id }, atual: false };
  } catch (err) {
    if (err.code !== '42P01') throw err;
  }
  return { empresa: null, atual: false };
}

async function atualizarLinhaDaAutorizacao(db, authorizationId, novo, auth) {
  const coluna = COLUNA_DE_DATA[novo];
  try {
    await db.query(
      `UPDATE pix_automatico_autorizacoes
          SET status = $2,
              ${coluna ? coluna + ' = COALESCE(' + coluna + ', NOW()),' : ''}
              subscription_id = COALESCE($3, subscription_id),
              cancellation_reason = COALESCE($4, cancellation_reason),
              updated_at = NOW()
        WHERE id = $1
          AND status NOT IN ('refused', 'cancelled', 'expired')
          AND NOT ($2 = 'pending' AND status = 'active')`,
      [authorizationId, novo, (auth && auth.subscriptionId) || null, (auth && auth.cancellationReason) || null]
    );
  } catch (err) {
    if (err.code !== '42P01') throw err;
  }
}

async function avisarCancelamento({ notifications, empresa, auth }) {
  const motivo = auth.cancellationReason || null;
  if (motivo === CANCELADA_PELA_AURA) return null;
  const nome = empresa.nome || 'empresa sem nome';
  const quando = dataBr(auth.cancellationDate);
  const pelaCliente = motivo === CANCELADA_PELA_PAGADORA;
  return notifications.notifyCompany(empresaDaEquipe(), {
    title: pelaCliente
      ? `Pix Automático cancelado no banco: ${nome}`
      : `Pix Automático cancelado: ${nome}`,
    body: (pelaCliente
      ? `A cliente cancelou a autorização do Pix Automático no banco${quando ? ' em ' + quando : ''}. ` +
        'É sinal de saída: vale falar com ela hoje. '
      : `A autorização do Pix Automático foi cancelada${quando ? ' em ' + quando : ''} ` +
        `(motivo na Asaas: ${motivo || 'não informado'}). `) +
      'Os próximos débitos automáticos não acontecem; confira na Asaas como ficou a assinatura.',
    // Um cancelamento por autorização: reenvio do evento não vira segundo aviso.
    dedupeKey: `pix-auto-cancelada:${auth.id}`,
  });
}

async function processarAutorizacao({ db, notifications, cliente, body, hasSecret, event }) {
  const doCorpo = body.authorization || {};
  if (!doCorpo.id) return { result: 'sem_autorizacao', http: { received: true, handled: false } };

  let auth = doCorpo;
  let novo = STATUS_POR_EVENTO[event] || null;
  if (!hasSecret) {
    let real = null;
    try { real = await cliente.consultarAutorizacao(doCorpo.id); } catch (_) { real = null; }
    if (!real || !real.id) {
      console.warn('[pixAutomatico] sem segredo e sem releitura da autorização — evento ignorado: ' + event);
      return { naoVerificado: true };
    }
    auth = real;
    novo = STATUS_DA_ASAAS[real.status] || null;
  }
  return { auth, novo, verified: true };
}

async function aplicarAutorizacao({ db, notifications, auth, novo, event }) {
  const { empresa, atual } = await acharEmpresa(db, auth.id);
  if (!empresa) {
    console.warn(`[pixAutomatico] ${event}: autorização ${auth.id} não é de nenhuma empresa — só registrado`);
    return { companyId: null, result: 'autorizacao_desconhecida' };
  }
  if (novo) await atualizarLinhaDaAutorizacao(db, auth.id, novo, auth);

  if (!atual) {
    console.log(`[pixAutomatico] ${event}: autorização antiga ${auth.id} da company ${empresa.id} — companies não muda`);
    return { companyId: empresa.id, result: 'autorizacao_antiga' };
  }

  const anterior = empresa.pix_auto_status || null;
  const proximo = proximoStatus(anterior, novo);
  let mudou = false;
  if (proximo) {
    const u = await db.query(
      `UPDATE companies
          SET pix_auto_status = $1, updated_at = NOW()
        WHERE id = $2
          AND asaas_pix_auto_authorization_id = $3
          AND COALESCE(pix_auto_status, '') = $4`,
      [proximo, empresa.id, auth.id, anterior || '']
    );
    mudou = !!(u && u.rowCount);
  }
  console.log(`[pixAutomatico] ${event}: company ${empresa.id} pix_auto_status ` +
    `${anterior || '(vazio)'} -> ${mudou ? proximo : (anterior || '(vazio)') + ' (sem mudança)'}`);

  // Aviso de cancelamento: só para a autorização atual e quando ela não
  // estava já encerrada por outro motivo (refused/expired). dedupeKey cobre
  // o reenvio.
  let avisou = false;
  if (novo === 'cancelled' && (mudou || anterior === 'cancelled')) {
    avisou = !!(await avisarCancelamento({ notifications, empresa, auth }));
  }
  return {
    companyId: empresa.id,
    result: mudou ? `status_${proximo}` : 'sem_mudanca',
    http: { status_anterior: anterior, status: mudou ? proximo : anterior, alerta: avisou },
  };
}

async function aplicarElegibilidade({ db, notifications, body, chave }) {
  const el = body.eligibility || {};
  const status = el.status || null;
  const ownerId = body.account && body.account.ownerId;
  if (ownerId) {
    console.log('[pixAutomatico] elegibilidade de subconta ignorada (ownerId presente)');
    return { result: 'subconta_ignorada' };
  }
  if (!status) return { result: 'sem_status' };
  const motivos = Array.isArray(el.ineligibleReasons) ? el.ineligibleReasons : [];
  console.log(`[pixAutomatico] elegibilidade da conta da Aura: ${status}` +
    (motivos.length ? ' motivos=' + JSON.stringify(motivos) : ''));
  try {
    // Entrega fora de ordem: só grava se o evento for mais novo que o gravado.
    await db.query(
      `INSERT INTO pix_automatico_elegibilidade (id, status, ineligible_reasons, account_id, event_key, event_date, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, NOW())
       ON CONFLICT (id) DO UPDATE
          SET status = EXCLUDED.status,
              ineligible_reasons = EXCLUDED.ineligible_reasons,
              account_id = EXCLUDED.account_id,
              event_key = EXCLUDED.event_key,
              event_date = EXCLUDED.event_date,
              updated_at = NOW()
        WHERE pix_automatico_elegibilidade.event_date IS NULL
           OR EXCLUDED.event_date IS NULL
           OR pix_automatico_elegibilidade.event_date <= EXCLUDED.event_date`,
      [status, JSON.stringify(motivos), (body.account && body.account.id) || null, chave, body.dateCreated || null]
    );
  } catch (err) {
    if (err.code !== '42P01') throw err;
    console.warn('[pixAutomatico] migration 406 ausente — elegibilidade só logada');
  }
  if (status === 'INELIGIBLE') {
    await notifications.notifyCompany(empresaDaEquipe(), {
      title: 'Conta da Aura inelegível ao Pix Automático',
      body: 'A Asaas avisou que a conta da Aura ficou inelegível ao Pix Automático' +
        (motivos.length ? ` (motivos: ${motivos.join(', ')})` : '') +
        '. A inelegibilidade pode cancelar as autorizações e os débitos já agendados.',
      dedupeKey: `pix-auto-inelegivel:${chave}`,
    });
  }
  return { result: 'elegibilidade_' + status.toLowerCase() };
}

async function aplicarInstrucao({ db, body, event }) {
  const pi = body.paymentInstruction || {};
  const authId = pi.authorization && pi.authorization.id;
  let companyId = null;
  if (authId) {
    const { empresa } = await acharEmpresa(db, authId);
    companyId = empresa ? empresa.id : null;
  }
  console.log(`[pixAutomatico] ${event}: instrução ${pi.id || '?'} status=${pi.status || '?'} registrada`);
  return { companyId, result: 'registrado' };
}

/**
 * @returns {Promise<object>} corpo da resposta (sempre HTTP 200, como o
 *   resto do webhook: 5xx em série faz a Asaas pausar a fila inteira, e a
 *   fila é a mesma das cobranças).
 */
async function processarEventoPixAutomatico({ body, hasSecret, db, notifications, cliente }) {
  const event = String((body && body.event) || '');
  const tipo = tipoDoEvento(event);
  const chave = chaveDoEvento(body);

  let auth = null;
  let novo = null;
  if (tipo === 'autorizacao') {
    const v = await processarAutorizacao({ db, notifications, cliente, body, hasSecret, event });
    if (v.naoVerificado) return { received: true, handled: false, reason: 'no_secret_reverification_failed' };
    if (v.http) return v.http;
    auth = v.auth;
    novo = v.novo;
  } else if (!hasSecret) {
    // Elegibilidade e instrução não têm como ser relidas aqui: sem o token,
    // não gravamos nada vindo do corpo.
    console.warn('[pixAutomatico] ASAAS_WEBHOOK_SECRET ausente — ' + event + ' só logado, nada gravado');
    return { received: true, handled: false, reason: 'no_secret_unverifiable' };
  }

  const reserva = await reservar(db, {
    chave, event,
    authorizationId: auth ? auth.id
      : (body.paymentInstruction && body.paymentInstruction.authorization && body.paymentInstruction.authorization.id) || null,
    status: auth ? auth.status : ((body.paymentInstruction && body.paymentInstruction.status)
      || (body.eligibility && body.eligibility.status) || null),
    verified: true,
    body,
  });
  if (!reserva.reservado) {
    console.log('[pixAutomatico] reenvio ignorado: ' + event + ' ' + chave);
    return { received: true, handled: false, duplicate: true, event };
  }

  try {
    let r;
    if (tipo === 'autorizacao') r = await aplicarAutorizacao({ db, notifications, auth, novo, event });
    else if (tipo === 'elegibilidade') r = await aplicarElegibilidade({ db, notifications, body, chave });
    else if (tipo === 'instrucao') r = await aplicarInstrucao({ db, body, event });
    else r = { result: 'evento_sem_tratamento' };
    await concluir(db, reserva, chave, r);
    return { received: true, handled: true, event, result: r.result, ...(r.http || {}) };
  } catch (err) {
    console.error('[pixAutomatico] erro processando ' + event + ': ' + err.message);
    await desfazerReserva(db, reserva, chave);
    return { received: true, error: true };
  }
}

module.exports = {
  processarEventoPixAutomatico,
  proximoStatus,
  chaveDoEvento,
  tipoDoEvento,
  empresaDaEquipe,
  STATUS_POR_EVENTO,
  STATUS_DA_ASAAS,
  EMPRESA_DA_EQUIPE_PADRAO,
};
