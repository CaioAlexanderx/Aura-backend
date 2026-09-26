// ============================================================
// AURA Studio · Rotas PÚBLICAS (sem auth) /aprovacao/:token
// Mount em routes/index.js (público, igual /storefront).
//
// Fluxo:
//   1. Cliente recebe link wa.me com URL /aprovacao/:token
//   2. GET /aprovacao/:token devolve mockup + dados do pedido (sem PII sensível)
//   3. POST /aprovacao/:token/respond com action=approve|request_changes
//   4. Se approve → studio_production_status do pedido vira 'approved'
//      Se request_changes → cria revision, mantém pending
//
// Fase 4 da vitrine Studio (25/09/2026): a página ganha a marca da loja
// (`marca`, ver services/marcaDaLoja.js), o placar de revisões inclusas
// e o que a tela de "arte aprovada" precisa para levar ao acompanhamento.
// Nada disso é dado do cliente.
// ============================================================
const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { vitrineDaEmpresa, montarMarca } = require('../services/marcaDaLoja');
const { carregarFaixas, prazoDaSacola } = require('../services/precoDoStudio');
const { revisoesInclusas, precoDaRevisaoExtra } = require('../services/politicaDeRevisoes');

// digital_orders.public_token é da migration 322. Base sem ela: a consulta
// cai para a versão sem o token uma vez e fica nela (armadilha 1).
let _semTokenDoPedido = false;

function sqlDaAprovacao(comToken) {
  return `SELECT a.id, a.token, a.mockup_url, a.status, a.expires_at, a.response_note,
              a.responded_at, a.message_text, a.company_id,
              o.id AS order_id, o.total AS total_amount,
              o.customer_name, o.order_number,
              ${comToken ? 'o.public_token,' : ''}
              c.trade_name, c.legal_name,
              (SELECT json_agg(json_build_object(
                'product_id', oi.product_id,
                'product_name', oi.product_name,
                'product_image', oi.product_image,
                'quantity', oi.quantity,
                'unit_price', oi.unit_price,
                'customization', oi.customization
              ) ORDER BY oi.id)
                FROM digital_order_items oi WHERE oi.order_id = o.id) AS items,
              (SELECT json_agg(json_build_object(
                'revision_number', r.revision_number,
                'mockup_url', r.mockup_url,
                'note', r.note,
                'created_by_type', r.created_by_type,
                'created_at', r.created_at
              ) ORDER BY r.revision_number)
                FROM studio_approval_revisions r WHERE r.approval_id = a.id) AS revisions,
              (SELECT COUNT(*)::int FROM studio_approval_links x
                WHERE x.order_id = a.order_id AND x.status = 'changes_requested') AS ajustes_pedidos
         FROM studio_approval_links a
         JOIN digital_orders o ON o.id = a.order_id
         LEFT JOIN companies c ON c.id = a.company_id
        WHERE a.token = $1 LIMIT 1`;
}

async function lerAprovacao(token) {
  try {
    return await db.query(sqlDaAprovacao(!_semTokenDoPedido), [token]);
  } catch (e) {
    if (e.code !== '42703' || _semTokenDoPedido) throw e;
    _semTokenDoPedido = true;
    return db.query(sqlDaAprovacao(false), [token]);
  }
}

/**
 * Revisões do pedido: quantas a loja inclui, quantas a cliente já pediu e
 * quanto custa a extra. A tela avisa ANTES de a cliente pedir um ajuste
 * que passa a ser cobrado ("Esta seria a 3ª revisão: R$ 10,00"). Conta os
 * links do pedido que voltaram com ajuste — cada pedido de ajuste fecha
 * um link e a loja manda outro com a arte nova.
 *
 * 0 (ou nada configurado) é ILIMITADO, como o painel diz (achado A3):
 * `ilimitadas: true`, `inclusas: null` e nenhum preço de extra. O null em
 * `inclusas` é de propósito: a página que já está no ar lê null como "sem
 * política, nada a dizer" e para de avisar uma cobrança que não existe
 * antes mesmo de o app novo subir.
 */
function placarDeRevisoes(studioSettings, ajustesPedidos) {
  const inclusas = revisoesInclusas(studioSettings);
  return {
    inclusas,
    usadas: parseInt(ajustesPedidos, 10) || 0,
    valor_extra: precoDaRevisaoExtra(studioSettings),
    ilimitadas: inclusas == null,
  };
}

/**
 * O que a página pública recebe (pura, testada sem banco).
 *
 * `shop` e `order` ficam como estavam: é o contrato da página de hoje.
 * O que é novo mora em chaves novas.
 */
function respostaDaAprovacao(a, { vitrine, prazo } = {}) {
  const expired = new Date(a.expires_at) < new Date();
  const ss = vitrine && vitrine.studio_settings ? vitrine.studio_settings : {};
  return {
    token: a.token,
    mockup_url: a.mockup_url,
    status: expired && a.status === 'pending' ? 'expired' : a.status,
    response_note: a.response_note,
    responded_at: a.responded_at,
    expires_at: a.expires_at,
    shop: {
      name: a.trade_name || a.legal_name,
    },
    order: {
      id: a.order_id,
      numero: a.order_number != null ? String(a.order_number) : null,
      customer_name: a.customer_name,
      total_amount: parseFloat(a.total_amount) || 0,
      items: a.items || [],
    },
    revisions: a.revisions || [],
    // Fase 4 — a marca da loja (null sem vitrine: a página cai no visual
    // de sempre).
    marca: montarMarca(vitrine),
    revisoes: placarDeRevisoes(ss, a.ajustes_pedidos),
    prazo_dias_uteis: prazo != null ? prazo : null,
    // "Acompanhar o pedido" depois de aprovar. É o link que a própria
    // cliente recebe na confirmação do pedido.
    acompanhar_token: a.public_token || null,
  };
}

// GET /aprovacao/:token — devolve dados do mockup pro cliente
router.get('/:token', async function(req, res) {
  try {
    const r = await lerAprovacao(req.params.token);
    if (!r.rows.length) return res.status(404).json({ error: 'Link inválido ou expirado' });

    const a = r.rows[0];
    const vitrine = await vitrineDaEmpresa(a.company_id);
    // Prazo pela mesma regra da sacola e da confirmação (faixa de
    // quantidade pode mudar o lead time). Falha aqui não derruba a página.
    let prazo = null;
    try {
      const faixas = await carregarFaixas(db, a.company_id);
      prazo = prazoDaSacola(
        vitrine && vitrine.studio_settings ? vitrine.studio_settings.default_sla_days : null,
        (a.items || []).map((i) => ({
          quantidade: parseInt(i.quantity, 10) || 0,
          faixas: faixas ? (faixas[i.product_id] ?? faixas.__global ?? null) : null,
        }))
      );
    } catch (_) { prazo = null; }

    res.set('Cache-Control', 'no-store');
    res.json(respostaDaAprovacao(a, { vitrine, prazo }));
  } catch (err) {
    console.error('[aprovacao:GET]', err.message);
    res.status(500).json({ error: 'Erro ao buscar aprovação' });
  }
});

// A referência que a cliente anexa ao pedir ajuste (Fase 4). Sobe pelo
// upload público da vitrine e chega aqui como URL; vai junto da nota, que
// é o que a lojista já lê no KDS — sem coluna nova. Só https e só um
// endereço razoável: é texto que a lojista vai abrir.
function referenciaValida(url) {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  if (u.length > 500 || !/^https:\/\/[^\s"'<>]+$/i.test(u)) return null;
  return u;
}

function notaComReferencia(note, referencia) {
  // A nota é cortada em 1000 caracteres na gravação; o corte fica no
  // texto da cliente, nunca no meio do endereço da referência.
  const limite = 1000 - (referencia ? referencia.length + 14 : 0);
  const n = note ? String(note).trim().slice(0, limite) : '';
  if (!referencia) return n || null;
  return (n ? n + '\n' : '') + 'Referência: ' + referencia;
}

// POST /aprovacao/:token/respond
// body: { action: 'approve' | 'request_changes', note?: string, referencia_url?: string }
router.post('/:token/respond', async function(req, res) {
  const { action } = req.body;
  const note = action === 'request_changes'
    ? notaComReferencia(req.body.note, referenciaValida(req.body.referencia_url))
    : req.body.note;
  if (!['approve', 'request_changes'].includes(action)) {
    return res.status(400).json({ error: "action deve ser 'approve' ou 'request_changes'" });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Busca aprovação + valida que ainda está pending e não expirou
    const aRes = await client.query(
      `SELECT id, company_id, order_id, status, expires_at
         FROM studio_approval_links WHERE token = $1 LIMIT 1`,
      [req.params.token]
    );
    if (!aRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Link inválido' }); }
    const a = aRes.rows[0];
    if (a.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Esta aprovação já foi respondida' });
    }
    if (new Date(a.expires_at) < new Date()) {
      // Marca como expired ao detectar
      await client.query(`UPDATE studio_approval_links SET status = 'expired' WHERE id = $1`, [a.id]);
      await client.query('COMMIT');
      return res.status(410).json({ error: 'Link expirado — peça pro lojista enviar um novo' });
    }

    const newStatus = action === 'approve' ? 'approved' : 'changes_requested';

    // Atualiza aprovação
    await client.query(
      `UPDATE studio_approval_links
          SET status = $1, response_note = $2, responded_at = NOW()
        WHERE id = $3`,
      [newStatus, note ? String(note).slice(0, 1000) : null, a.id]
    );

    // Cria revisão registrando resposta do cliente
    const nextRev = await client.query(
      `SELECT COALESCE(MAX(revision_number), 0) + 1 AS next
         FROM studio_approval_revisions WHERE approval_id = $1`,
      [a.id]
    );
    await client.query(
      `INSERT INTO studio_approval_revisions
         (approval_id, revision_number, note, created_by_type)
       VALUES ($1, $2, $3, 'customer')`,
      [a.id, nextRev.rows[0].next, action === 'approve' ? 'Cliente aprovou' : (note || 'Cliente pediu ajuste')]
    );

    // Se aprovado, avança o pedido pra 'approved' no KDS
    if (action === 'approve') {
      await client.query(
        `UPDATE digital_orders
            SET studio_production_status = 'approved', updated_at = NOW()
          WHERE id = $1 AND company_id = $2`,
        [a.order_id, a.company_id]
      );
    }

    await client.query('COMMIT');
    res.json({
      ok: true,
      action,
      new_status: newStatus,
      message: action === 'approve'
        ? '🎉 Aprovado! A loja já foi notificada e vai começar a produzir.'
        : 'Pronto! A loja recebeu seu pedido de ajuste e vai te chamar.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[aprovacao:respond]', err.message);
    res.status(500).json({ error: 'Erro ao registrar resposta' });
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports._respostaDaAprovacao = respostaDaAprovacao;
module.exports._placarDeRevisoes = placarDeRevisoes;
module.exports._referenciaValida = referenciaValida;
module.exports._notaComReferencia = notaComReferencia;
