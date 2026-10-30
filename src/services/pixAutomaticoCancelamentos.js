// ============================================================
// AURA. — Autorizações do Pix Automático canceladas (tq-105, critério 5 da
// Célia, 29/10/2026)
//
// Cancelamento que NÃO foi pedido pela Aura (REQUESTED_BY_RECEIVER_USER fica
// de fora) é sinal de saída. Ele aparece em três lugares:
//   1. sininho da equipe no mesmo dia (services/pixAutomaticoWebhook.js);
//   2. alerta do painel da Gestão Aura, por 7 dias (services/painelAlertas.js,
//      tipo pix_auto_cancelado);
//   3. lista "Autorizações do Pix Automático canceladas" no bloco Receita,
//      que com o período de 7 dias é a linha do board semanal.
//
// Fonte: pix_automatico_autorizacoes (migration 406), gravada pelo webhook.
// Sem a tabela (42P01) a lista sai vazia.
// ============================================================
'use strict';

const b = require('./painelBlocos/_base');

const MOTIVO = {
  REQUESTED_BY_PAYER_USER: 'Cliente cancelou no banco',
  REQUESTED_BY_COURT_ORDER: 'Ordem judicial',
  CONFIRMATION_ERROR: 'Erro na confirmação',
  OTHER: 'Outro motivo',
};

function rotuloDoMotivo(m) {
  if (!m) return 'Motivo não informado';
  return MOTIVO[m] || m;
}

/**
 * @returns {Promise<Array<{authorization_id, company_id, nome, cancelado_em, motivo, motivo_codigo, pela_cliente}>>}
 */
async function listarCanceladas({ db = b.pool, hoje, dias = 7 } = {}) {
  const rows = await b.opcional(
    db,
    `SELECT a.id AS authorization_id, a.company_id, a.cancelled_at, a.cancellation_reason,
            COALESCE(c.trade_name, c.legal_name) AS nome
       FROM pix_automatico_autorizacoes a
       LEFT JOIN companies c ON c.id = a.company_id
      WHERE a.status = 'cancelled'
        AND a.cancelled_at >= ${b.desde(dias)}
        AND a.cancellation_reason IS DISTINCT FROM 'REQUESTED_BY_RECEIVER_USER'
      ORDER BY a.cancelled_at DESC`,
    [hoje]
  );
  return rows
    .filter((r) => r && r.authorization_id && r.cancelled_at)
    .map((r) => ({
      authorization_id: r.authorization_id,
      company_id: r.company_id || null,
      nome: r.nome || 'Empresa sem nome',
      cancelado_em: r.cancelled_at,
      motivo_codigo: r.cancellation_reason || null,
      motivo: rotuloDoMotivo(r.cancellation_reason),
      pela_cliente: r.cancellation_reason === 'REQUESTED_BY_PAYER_USER',
    }));
}

module.exports = { listarCanceladas, rotuloDoMotivo };
