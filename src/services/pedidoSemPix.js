// ============================================================
// AURA. — Pedido da loja online que ficou sem Pix (RA-04, 10/11/2026)
//
// O pedido nasce ANTES do Pix (o BR Code leva o numero do pedido). Quando o
// Pix nao sai — a loja nao tem chave valida e o Mercado Pago falhou, ou nao
// existe — pixService lanca PIX_NOT_CONFIGURED. Aqui o pedido recem-criado
// e cancelado, para nao ficar na fila "aguardando Pix" um pedido que
// ninguem tem como pagar, e a chave de idempotencia e solta: o proximo toque
// da cliente (com outra forma de pagamento) cria um pedido novo em vez de
// receber de volta este cancelado.
//
// Pedido esperando pagamento nao baixou estoque nem gerou lancamento:
// cancelar nao tem nada a devolver.
//
// Este modulo NAO importa pixService de proposito: varios testes trocam o
// pixService por um mock so com generatePix.
// ============================================================
'use strict';

const PIX_NOT_CONFIGURED = 'PIX_NOT_CONFIGURED';
const MENSAGEM =
  'O Pix desta loja ainda não está disponível. Por favor, escolha outra forma de pagamento.';

function ehPixNaoConfigurado(err) {
  return !!(err && err.code === PIX_NOT_CONFIGURED);
}

async function desfazerPedidoSemPix(db, order, { comChave = false } = {}) {
  const nota = '\n[PIX INDISPONIVEL em ' + new Date().toISOString() + ']: pedido cancelado sem cobranca';
  try {
    await db.query(`
      UPDATE digital_orders SET
        status         = 'cancelled',
        payment_status = 'cancelled',
        cancelled_at   = NOW(),
        notes          = COALESCE(notes, '') || $2,
        updated_at     = NOW()${comChave ? ',\n        idempotency_key = NULL' : ''}
      WHERE id = $1 AND status = 'pending_payment'
    `, [order.id, nota]);
  } catch (e) {
    // A resposta a cliente nao depende disto; fica no log para a equipe.
    console.error('[pedido-sem-pix] cancelar pedido', order && order.id, 'falhou:', e.message);
  }
}

function responderPixNaoConfigurado(res, err) {
  return res.status((err && err.status) || 422).json({
    error: (err && err.message) || MENSAGEM,
    code: PIX_NOT_CONFIGURED,
  });
}

module.exports = {
  PIX_NOT_CONFIGURED,
  MENSAGEM,
  ehPixNaoConfigurado,
  desfazerPedidoSemPix,
  responderPixNaoConfigurado,
};
