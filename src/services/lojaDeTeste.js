// ============================================================
// AURA. — A loja de teste
//
// ── O PROBLEMA ─────────────────────────────────────────────────────────
// Metade do produto so pode ser verificada fechando um pedido: checkout,
// cobranca, aprovacao de arte, cancelamento, estorno. Ate 04/09/2026 nao
// havia onde fazer isso. Na loja de um cliente real e proibido — o pedido
// de teste dispara WhatsApp de verdade no numero dela e suja o painel.
//
// O resultado esta registrado: na rodada de QA de 03/09 NENHUM checkout
// foi concluido, e a tela de confirmacao — a ultima que a cliente ve —
// foi avaliada lendo codigo.
//
// ── A TRAVA ────────────────────────────────────────────────────────────
// `companies.is_sandbox` desliga o que sai para o mundo:
//
//   - notificacao ao lojista e ao cliente (push, e-mail, WhatsApp)
//   - criacao de cobranca real em gateway (Mercado Pago, Asaas)
//
// E so. Preco, estoque, fila de producao e financeiro continuam
// funcionando de verdade: uma loja de teste que nao baixa estoque nao
// testa o que interessa, e um QA que roda num mundo de mentira encontra
// os defeitos de mentira.
//
// ── POR QUE UM CACHE ───────────────────────────────────────────────────
// A pergunta e feita em caminho quente (todo pedido confirmado) e a
// resposta muda praticamente nunca. Sem cache, seria uma consulta a mais
// em cada notificacao de cada loja real.
// ============================================================
'use strict';

const db = require('../config/database');

/** Quanto tempo a resposta fica guardada. */
const VALIDADE_MS = 5 * 60 * 1000;

/** company_id → { sandbox, expiraEm } */
const _cache = new Map();

/**
 * Esta empresa e de teste?
 *
 * Nunca lanca e, na duvida, responde `false`: uma falha de leitura nao
 * pode transformar a loja de um cliente real numa loja muda. O erro
 * seguro aqui e notificar demais, nunca de menos.
 */
async function ehLojaDeTeste(companyId) {
  if (!companyId) return false;

  const guardado = _cache.get(companyId);
  if (guardado && guardado.expiraEm > Date.now()) return guardado.sandbox;

  let sandbox = false;
  try {
    const { rows } = await db.query(
      'SELECT is_sandbox FROM companies WHERE id = $1 LIMIT 1',
      [companyId]
    );
    sandbox = rows.length ? rows[0].is_sandbox === true : false;
  } catch (err) {
    // 42703: migration 320 ainda nao aplicada. O backend sobe antes da
    // migration, e ate ela chegar toda empresa e real — que e o padrao
    // seguro.
    if (err.code !== '42703' && err.code !== '42P01') {
      console.error('[lojaDeTeste] erro na leitura:', err.message);
    }
    sandbox = false;
  }

  _cache.set(companyId, { sandbox, expiraEm: Date.now() + VALIDADE_MS });
  return sandbox;
}

/**
 * Registra no log o que NAO foi disparado.
 *
 * Sem isto, um teste que nao recebe o WhatsApp esperado e indistinguivel
 * de um defeito de integracao — e o testador vai abrir um achado falso.
 */
function anotarBloqueio(oque, companyId) {
  console.log(`[lojaDeTeste] ${oque} nao enviado — empresa de teste (${companyId})`);
}

/**
 * Um Pix de mentira, com a forma do de verdade.
 *
 * A tela de confirmacao — a ultima que a cliente ve, com o QR, o
 * copia-e-cola e os proximos passos — e justamente a que nunca foi
 * testada, porque testa-la exigia criar uma cobranca real. Aqui ela
 * renderiza inteira sem que ninguem seja cobrado.
 *
 * O payload NAO e um codigo Pix valido, de proposito: colado no banco
 * ele nao abre pagamento nenhum. Um payload bem-formado seria uma
 * cobranca de teste esperando alguem pagar por engano.
 */
function pixDeTeste(order, total) {
  const valor = Number(total || 0).toFixed(2);
  return {
    payment_id: `teste-${order.id}`,
    qrcode: null,
    payload: `LOJA DE TESTE — NAO E UM CODIGO PIX VALIDO — pedido #${order.order_number} — R$ ${valor}`,
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    teste: true,
  };
}

/** So para teste: esquece o que foi guardado. */
function limparCache() { _cache.clear(); }

module.exports = { ehLojaDeTeste, anotarBloqueio, pixDeTeste, limparCache };
