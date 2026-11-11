// ============================================================
// AURA. — Acessos de funcionário escolhidos no checkout (p-106, 11/11/2026)
//
// A loja escolhe no checkout quantos acessos de funcionário adicionais quer
// (0 a 10). Regras que seguram o desenho:
//
//   - A quantidade escolhida é de acessos PERMANENTES. Os acessos de
//     temporada (seat_passes ativos e aplicados, services/seatPass) já estão
//     SOMADOS em companies.extra_seats_granted; eles se somam por cima da
//     escolha e nunca são apagados nem cobrados em dobro:
//        permanentes atuais = extra_seats_granted − temporada
//        valor da assinatura = plano + R$ 19 × (escolhidos + temporada)
//     (o mesmo total que o syncSubscriptionSeatValue cobra, então expirar o
//     passe continua tirando só o que é dele).
//   - Os acessos só liberam com o pagamento confirmado. O /billing/subscribe
//     NÃO toca em extra_seats_granted: grava a pendência (migration 445)
//     ligada à assinatura e à 1ª cobrança criadas na Asaas. O webhook da
//     Asaas (PAYMENT_CONFIRMED / PAYMENT_RECEIVED) de uma delas aplica:
//        extra_seats_granted = pendente + temporada
//     limpa a pendência, grava em audit_log e confere o valor na Asaas.
//   - Pix gerado e não pago: nada acontece. Assinar de novo grava a
//     pendência nova por cima, com os ids da assinatura nova.
//
// Todas as funções aceitam `deps = { db, sync }` para teste.
// ============================================================
'use strict';

const defaultDb = require('../config/database');
const { syncSubscriptionSeatValue } = require('./seatSubscription');

const MAX_EXTRA_SEATS = 10;

const MSG_EXTRA_SEATS_INVALIDO =
  'A quantidade de acessos de funcionário adicionais deve ser um número inteiro de 0 a ' + MAX_EXTRA_SEATS + '.';

function resolverDeps(deps = {}) {
  return {
    db: deps.db || defaultDb,
    sync: deps.sync || syncSubscriptionSeatValue,
  };
}

/**
 * Lê o extra_seats que veio do app (body ou query string).
 *   ausente (undefined/null) → { presente: false }   (comportamento de sempre)
 *   inteiro de 0 a 10        → { presente: true, valor }
 *   qualquer outra coisa     → { presente: true, erro }
 */
function lerExtraSeats(raw) {
  if (raw === undefined || raw === null) return { presente: false };
  let n = NaN;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && /^\s*\d{1,3}\s*$/.test(raw)) n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 0 || n > MAX_EXTRA_SEATS) {
    return { presente: true, erro: MSG_EXTRA_SEATS_INVALIDO };
  }
  return { presente: true, valor: n };
}

/**
 * Acessos de temporada ATIVOS e já somados em extra_seats_granted desta
 * empresa (seat_passes status='ativo' com applied_at). Passe agendado ainda
 * não está em extra_seats_granted e entra sozinho na data (job do seatPass).
 * Sem a tabela (pré-374) = 0.
 */
async function acessosDeTemporadaAtivos(companyId, deps = {}) {
  const { db } = resolverDeps(deps);
  try {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(qty), 0)::int AS total
         FROM seat_passes
        WHERE company_id = $1 AND status = 'ativo' AND applied_at IS NOT NULL`,
      [companyId]
    );
    return (rows && rows[0] && parseInt(rows[0].total, 10)) || 0;
  } catch (err) {
    if (err && err.code === '42P01') return 0;
    throw err;
  }
}

// A coluna da pendência já existe? Lido do `SELECT * FROM companies` do
// checkout: antes da migration 445 a chave nem vem na linha.
function pendenciaDisponivel(company) {
  return !!company && Object.prototype.hasOwnProperty.call(company, 'pending_extra_seats');
}

function pendenteDe(company) {
  if (!company || company.pending_extra_seats === null || company.pending_extra_seats === undefined) return null;
  const n = parseInt(company.pending_extra_seats, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Grava (qty inteiro) ou limpa (qty null) a pendência da empresa.
 * Nunca lança: o /subscribe já criou a assinatura na Asaas quando chega
 * aqui, e um 500 faria a loja tentar de novo e gerar outra cobrança. A falha
 * fica no log com RECONCILIAR (mesmo padrão do resto do billing).
 * @returns {Promise<boolean>} true se gravou
 */
async function gravarPendencia(companyId, { qty, subscriptionId = null, paymentId = null }, deps = {}) {
  const { db } = resolverDeps(deps);
  const limpar = qty === null || qty === undefined;
  try {
    await db.query(
      `UPDATE companies
          SET pending_extra_seats = $2,
              pending_extra_seats_subscription_id = $3,
              pending_extra_seats_payment_id = $4,
              pending_extra_seats_at = CASE WHEN $2::int IS NULL THEN NULL ELSE NOW() END,
              updated_at = NOW()
        WHERE id = $1`,
      [companyId, limpar ? null : qty, limpar ? null : subscriptionId, limpar ? null : paymentId]
    );
    return true;
  } catch (err) {
    if (err && err.code === '42703') {
      console.error('[acessosPendentes] coluna da pendência ausente (migration 445 pendente) — company=' + companyId);
      return false;
    }
    console.error('[BILLING] RECONCILIAR: pendência de acessos não gravada — company=' + companyId +
      ' qty=' + qty + ' sub=' + subscriptionId + ' pay=' + paymentId + ': ' + err.message);
    return false;
  }
}

async function auditar(db, { companyId, action, detail, metadata }) {
  try {
    await db.query(
      `INSERT INTO audit_log (user_id, company_id, action, detail, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [null, companyId, action, detail || null, JSON.stringify(metadata || {})]
    );
  } catch (err) {
    console.error('[acessosPendentes] audit_log falhou (' + action + '):', err.message);
  }
}

// Uma instrução só: a linha da empresa é travada, a pendência sai e os
// acessos entram juntos. A temporada é lida na mesma instrução (sem janela
// para o job do seatPass somar/tirar no meio).
const APLICAR_SQL = (comTemporada) => `
  WITH alvo AS (
    SELECT id, pending_extra_seats AS pendente, COALESCE(extra_seats_granted, 0) AS antes
      FROM companies
     WHERE id = $1
       AND pending_extra_seats IS NOT NULL
       AND ((pending_extra_seats_payment_id IS NOT NULL AND pending_extra_seats_payment_id = $2)
         OR (pending_extra_seats_subscription_id IS NOT NULL AND pending_extra_seats_subscription_id = $3))
     FOR UPDATE
  )
  UPDATE companies co
     SET extra_seats_granted = alvo.pendente + ${comTemporada
    ? `(SELECT COALESCE(SUM(p.qty), 0)::int FROM seat_passes p
            WHERE p.company_id = co.id AND p.status = 'ativo' AND p.applied_at IS NOT NULL)`
    : '0'},
         pending_extra_seats = NULL,
         pending_extra_seats_subscription_id = NULL,
         pending_extra_seats_payment_id = NULL,
         pending_extra_seats_at = NULL,
         updated_at = NOW()
    FROM alvo
   WHERE co.id = alvo.id
  RETURNING co.id, co.plan, co.billing_cycle, co.billing_status, co.asaas_subscription_id,
            co.extra_seats_granted, alvo.pendente, alvo.antes`;

/**
 * Chamado pelo webhook da Asaas em pagamento confirmado (CONFIRMED/RECEIVED).
 * Só age se a cobrança paga for a 1ª cobrança ou da assinatura gravadas na
 * pendência. Nunca lança.
 * @returns {Promise<{aplicado:boolean, motivo?:string, extra_seats_granted?:number, sync?:object}>}
 */
async function aplicarPendenciaDoPagamento({ companyId, payment }, deps = {}) {
  const { db, sync } = resolverDeps(deps);
  try {
    const paymentId = (payment && payment.id) || null;
    const subscriptionId = (payment && payment.subscription) || null;
    if (!companyId || (!paymentId && !subscriptionId)) return { aplicado: false, motivo: 'sem_referencia' };

    const params = [companyId, paymentId ? String(paymentId) : null, subscriptionId ? String(subscriptionId) : null];

    // Conferencia previa que NUNCA da erro de schema: to_jsonb(linha) le as
    // colunas da 445 sem cita-las (antes da migration vem null) e
    // to_regclass diz se seat_passes existe. Importa porque o webhook pode
    // rodar dentro de uma transacao (testes *.banco): um 42703/42P01 ali
    // abortaria a transacao inteira, mesmo capturado. Sem pendencia desta
    // cobranca: nenhuma outra query.
    const { rows: pre } = await db.query(
      `SELECT to_jsonb(c) ->> 'pending_extra_seats' AS pendente,
              to_jsonb(c) ->> 'pending_extra_seats_payment_id' AS pay,
              to_jsonb(c) ->> 'pending_extra_seats_subscription_id' AS sub,
              to_regclass('seat_passes') IS NOT NULL AS tem_temporada
         FROM companies c WHERE c.id = $1`,
      [companyId]
    );
    const p = pre && pre[0];
    const casa = p && p.pendente !== null && p.pendente !== undefined &&
      ((p.pay && p.pay === params[1]) || (p.sub && p.sub === params[2]));
    if (!casa) return { aplicado: false, motivo: 'sem_pendencia' };

    const { rows } = await db.query(APLICAR_SQL(p.tem_temporada !== false), params);
    if (!rows || !rows.length) return { aplicado: false, motivo: 'sem_pendencia' };

    const r = rows[0];
    const depois = parseInt(r.extra_seats_granted, 10) || 0;
    const pendente = parseInt(r.pendente, 10) || 0;
    const temporada = Math.max(depois - pendente, 0);
    const company = {
      id: r.id,
      plan: r.plan,
      billing_cycle: r.billing_cycle,
      billing_status: r.billing_status,
      asaas_subscription_id: r.asaas_subscription_id,
      extra_seats_granted: depois,
    };

    // Confere o valor da assinatura na Asaas (plano + R$ 19 × acessos). Na
    // assinatura recém-criada ele já está certo e o sync só lê (value_unchanged).
    let resultado = null;
    try {
      resultado = await sync(company);
    } catch (err) {
      resultado = { updated: false, skipped: 'error', error: err.message };
    }

    await auditar(db, {
      companyId: company.id,
      action: 'billing.extra_seats_applied',
      detail: 'Acessos de funcionário do checkout liberados com o pagamento: ' + pendente +
        (temporada > 0 ? ' + ' + temporada + ' de temporada' : ''),
      metadata: {
        pendente,
        temporada,
        extra_seats_granted_antes: parseInt(r.antes, 10) || 0,
        extra_seats_granted: depois,
        payment_id: paymentId,
        subscription_id: subscriptionId,
        sync: resultado ? (resultado.updated ? 'ajustado' : resultado.skipped) : null,
        valor_assinatura: resultado ? resultado.value : undefined,
        valor_anterior: resultado ? resultado.previousValue : undefined,
      },
    });

    console.log('[BILLING] Acessos do checkout liberados — company=' + company.id + ' pendente=' + pendente +
      ' temporada=' + temporada + ' extra_seats_granted=' + depois + ' (pagamento ' + paymentId + ')');
    return { aplicado: true, extra_seats_granted: depois, pendente, temporada, sync: resultado };
  } catch (err) {
    if (err && err.code === '42703') return { aplicado: false, motivo: 'migration_pendente' };
    console.error('[BILLING] RECONCILIAR: acessos pendentes não aplicados — company=' + companyId +
      ' pagamento=' + (payment && payment.id) + ': ' + err.message);
    return { aplicado: false, motivo: 'erro', error: err.message };
  }
}

module.exports = {
  MAX_EXTRA_SEATS,
  MSG_EXTRA_SEATS_INVALIDO,
  lerExtraSeats,
  acessosDeTemporadaAtivos,
  pendenciaDisponivel,
  pendenteDe,
  gravarPendencia,
  aplicarPendenciaDoPagamento,
};
