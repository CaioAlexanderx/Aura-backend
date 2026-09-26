// ============================================================
// AURA. — Job: Pix da loja online que expirou sem pagamento
//
// Criado: 01/09/2026
//
// É o único evento da taxonomia de services/lojaEvents.js que NÃO tem gancho
// natural: ninguém "faz" um Pix expirar — o pedido simplesmente fica em
// pending_payment com asaas_pix_expires_at no passado. Sem varredura, a
// lojista nunca fica sabendo, e um pedido morto é justamente o que ainda dá
// para recuperar com uma mensagem no WhatsApp enquanto o cliente lembra.
//
// A varredura é barata e boba de propósito:
//   - status = 'pending_payment' (pago/aprovado/cancelado já saíram daqui)
//   - asaas_pix_expires_at NÃO nulo e no passado
//   - payment_status ainda pendente
//   - JANELA de 7 dias: um pedido morto há um mês não é venda recuperável, é
//     arqueologia. A janela também evita que o primeiro deploy do job
//     despeje meses de pedido velho no sino de todo mundo de uma vez.
//
// A idempotência NÃO vem daqui: vem da dedupe_key
// 'loja:pix_expirado:<order_id>' (índice único parcial, migration 285). O
// job pode reprocessar o mesmo pedido a cada tick pelos 7 dias inteiros que
// o aviso continua sendo um só. Por isso não há coluna de "já notificado" —
// seria um segundo mecanismo de idempotência para o mesmo fato.
//
// Mesmo padrão dos outros jobs (setInterval + init/stop, tick injetável).
// ============================================================
'use strict';

const BATCH = 100;
const JANELA_DIAS = 7;
const INTERVALO_MS = 10 * 60 * 1000; // 10min — Pix expira em minutos/horas

/**
 * Um ciclo da varredura. @param deps {{ db, lojaEvents }} — injetável p/ teste.
 * @returns {Promise<{scanned:number, notified:number}>}
 */
async function tickPixExpirado({ db, lojaEvents }) {
  const summary = { scanned: 0, notified: 0 };

  const { rows } = await db.query(
    `SELECT id, company_id, order_number, customer_name, total, vertical
       FROM digital_orders
      WHERE status = 'pending_payment'
        AND asaas_pix_expires_at IS NOT NULL
        AND asaas_pix_expires_at < NOW()
        AND created_at > NOW() - INTERVAL '${JANELA_DIAS} days'
        AND COALESCE(payment_status, 'pending') NOT IN ('confirmed', 'paid', 'received')
      ORDER BY asaas_pix_expires_at DESC
      LIMIT $1`,
    [BATCH]
  );

  for (const order of rows) {
    summary.scanned++;
    // emitLojaEvent devolve null quando o evento está desligado para a
    // empresa OU quando a dedupe_key já existe (ticks anteriores).
    const created = await lojaEvents.emitLojaEvent('loja_pix_expirado', order);
    if (created) summary.notified++;
  }

  return summary;
}

// ── Cancelamento do Pix vencido (10/09/2026) ─────────────────
//
// Decisao do Caio: Pix sem pagamento em PRAZO_HORAS vira "Expirado" e o
// pedido e cancelado. O aviso de cima so avisava, e so para Pix com data de
// expiracao — Pix MANUAL nao tem data, e os pedidos ficavam meses em
// "Precisa agir" (Finesse: tres de 21/05).
//
// Pode cancelar sem devolver nada: o estoque so e baixado na confirmacao
// (digitalOrderConfirmation) e pedido pendente nao tem lancamento.
//
// Fora de proposito:
//   - awaiting_approval: a cliente disse "ja paguei", alguem precisa olhar.
//   - comprovante anexado (payment_proof_url): mesmo motivo. O upload do
//     comprovante NAO muda o status — a cliente pode anexar sem tocar em
//     "Ja paguei", e o pedido continuava na fila de cancelar.
//
// Studio (Fase 2 da vitrine, decisao do PO 25/09/2026): entra, com prazo
// proprio de PRAZO_HORAS_STUDIO. Ficava de fora porque "arte e orcamento
// tem ritmo proprio" — mas um Pix de vitrine nao pago em tres dias e
// pedido abandonado, e ele segurava a fila de producao da lojista. So
// cancela enquanto a producao nao andou: se a lojista ja aprovou a arte
// ou comecou a produzir sem o Pix, ela combinou algo com a cliente, e o
// job nao desfaz combinado.
//
// Pedido recente (JANELA_DIAS) avisa no sino; pedido antigo cancela calado
// para o primeiro deploy nao despejar meses de aviso. Loja de teste segue a
// mesma regra: o aviso e so o sino da propria lojista (lojaEvents), nada
// sai para o cliente.
const PRAZO_HORAS = 48;
const PRAZO_HORAS_STUDIO = 72;

// Sinal registrado no painel (studio_payments -> deposit_paid) e dinheiro
// na mao da lojista: o pedido nao e mais "Pix esquecido", mesmo que o
// payment_status do digital_order continue pendente.
// Status de producao em que o pedido Studio ainda nao andou.
const STUDIO_PARADO = ['pending_art', 'awaiting_customization'];

const fmtReais = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? `R$ ${n.toFixed(2).replace('.', ',')}` : 'R$ —';
};

const ehStudio = (pedido) => pedido && pedido.vertical === 'studio';
const prazoDoPedido = (pedido) => (ehStudio(pedido) ? PRAZO_HORAS_STUDIO : PRAZO_HORAS);

// Base sem a coluna do comprovante (42703): o filtro sai, uma vez, e o
// job continua cancelando — melhor que parar de cancelar tudo.
let _semColunaDoComprovante = false;

function sqlDoCancelamento({ comComprovante }) {
  return `UPDATE digital_orders SET
        status         = 'cancelled',
        payment_status = 'expired',
        cancelled_at   = NOW(),
        updated_at     = NOW(),
        notes          = COALESCE(notes, '') || CASE WHEN vertical = 'studio' THEN $3 ELSE $2 END
      WHERE id IN (
        SELECT id FROM digital_orders
         WHERE status = 'pending_payment'
           AND payment_method = 'pix'
           AND COALESCE(payment_status, 'pending') NOT IN ('confirmed', 'paid', 'received')${comComprovante ? `
           AND payment_proof_url IS NULL` : ''}
           AND (
             (COALESCE(vertical, 'retail') <> 'studio'
               AND created_at < NOW() - INTERVAL '${PRAZO_HORAS} hours')
             OR (vertical = 'studio'
               AND created_at < NOW() - INTERVAL '${PRAZO_HORAS_STUDIO} hours'
               AND COALESCE(studio_production_status, 'pending_art') IN (${STUDIO_PARADO.map((s) => `'${s}'`).join(', ')})
               AND COALESCE(deposit_paid, false) = false)
           )
         ORDER BY created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
        AND status = 'pending_payment'
      RETURNING id, company_id, order_number, customer_name, total, vertical, created_at`;
}

/** @returns {Promise<{cancelados:number, avisados:number}>} */
async function tickCancelarPixVencido({ db, lojaEvents }) {
  const resumo = { cancelados: 0, avisados: 0 };
  const agora = new Date().toISOString();
  const nota = (horas) => `\n[EXPIRADO em ${agora}]: Pix sem pagamento em ${horas} h, cancelado automaticamente.`;
  const params = [BATCH, nota(PRAZO_HORAS), nota(PRAZO_HORAS_STUDIO)];

  let rows;
  try {
    ({ rows } = await db.query(sqlDoCancelamento({ comComprovante: !_semColunaDoComprovante }), params));
  } catch (e) {
    if (e.code !== '42703' || _semColunaDoComprovante) throw e;
    _semColunaDoComprovante = true;
    ({ rows } = await db.query(sqlDoCancelamento({ comComprovante: false }), params));
  }

  const limiteDoAviso = Date.now() - JANELA_DIAS * 24 * 3600 * 1000;
  for (const pedido of rows) {
    resumo.cancelados++;
    if (new Date(pedido.created_at).getTime() < limiteDoAviso) continue;
    const quem = pedido.customer_name ? ` de ${pedido.customer_name}` : '';
    const criado = await lojaEvents.emitLojaEvent('loja_pix_expirado', pedido, {
      body: `O Pix de ${fmtReais(pedido.total)}${quem} não foi pago em ${prazoDoPedido(pedido)} h e o pedido foi cancelado automaticamente. Se ainda quiser a venda, chame o cliente.`,
    });
    if (criado) resumo.avisados++;
  }
  return resumo;
}

let _interval = null;

function initPixExpiradoJob() {
  if (_interval) return;
  const db = require('../config/database');
  const lojaEvents = require('../services/lojaEvents');
  _interval = setInterval(() => {
    tickPixExpirado({ db, lojaEvents })
      .then((s) => {
        if (s.notified > 0) console.log(`[pixExpirado] scanned=${s.scanned} avisados=${s.notified}`);
      })
      .catch((e) => console.error('[pixExpirado] tick crash:', e.message))
      // Depois do aviso, e nao em paralelo: o Pix com data que venceu ha
      // pouco recebe o aviso de "recuperavel" antes de ser cancelado.
      .then(() => tickCancelarPixVencido({ db, lojaEvents }))
      .then((r) => {
        if (r && r.cancelados > 0) console.log(`[pixExpirado] cancelados=${r.cancelados} avisados=${r.avisados}`);
      })
      .catch((e) => console.error('[pixExpirado] cancelamento crash:', e.message));
  }, INTERVALO_MS);
  if (_interval.unref) _interval.unref();
  console.log('[pixExpirado] iniciado — Pix da loja online vencido sem pagamento');
}

function stopPixExpiradoJob() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = {
  initPixExpiradoJob,
  stopPixExpiradoJob,
  tickPixExpirado,
  tickCancelarPixVencido,
  PRAZO_HORAS,
  PRAZO_HORAS_STUDIO,
  BATCH,
  JANELA_DIAS,
  INTERVALO_MS,
};
