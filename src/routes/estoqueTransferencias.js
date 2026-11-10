// ============================================================
// AURA. — Transferencia de estoque entre lojas do grupo (10/11/2026)
//
// Migration 444. Regras em src/services/transferenciaDeEstoque.js.
//
//   POST /companies/:id/estoque/transferencias   (:id = loja de origem)
//     { destino_company_id, itens: [{ product_id, variant_id|null, quantidade }], observacao? }
//     201 { transferencia: { id, numero, origem_company_id, destino_company_id,
//                            criada_em, criada_por, observacao, itens: [...] } }
//     4xx { error, code }: NAO_E_DO_GRUPO, MESMA_LOJA, QUANTIDADE_INVALIDA,
//                          ITEM_NAO_ENCONTRADO, ESTOQUE_INSUFICIENTE,
//                          GRADE_DIFERENTE
//   GET  /companies/:id/estoque/transferencias?limit&offset
//     { transferencias: [...com itens], total, limit, offset }
//     (as que a loja mandou ou recebeu)
//
// Montado em private.js sob /estoque: requireCompanyAccess na origem e o
// negarEmConsultaSemCustoNoResto do mount (estoque so consulta leva 403).
// O acesso ao DESTINO e conferido aqui (transferenciaDeEstoque.conferirLojas).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const svc = require('../services/transferenciaDeEstoque');

function falhaDeSchema(err) {
  return err && (err.code === '42P01' || err.code === '42703');
}

router.post('/', async (req, res) => {
  let pedido;
  try {
    pedido = svc.lerPedido(req.body);
  } catch (e) {
    if (e instanceof svc.ErroDeTransferencia) return res.status(e.status).json(e.body);
    throw e;
  }
  const origemId = String(req.params.id).toLowerCase();
  if (pedido.destino === origemId) {
    return res.status(400).json({ error: 'A loja de destino precisa ser outra loja.', code: 'MESMA_LOJA' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const transferencia = await svc.transferir(client, {
      origemId,
      destinoId: pedido.destino,
      userId: req.user && req.user.id,
      isStaff: !!(req.user && req.user.role === 'admin'),
      itens: pedido.itens,
      observacao: pedido.observacao,
    });
    await client.query('COMMIT');
    res.status(201).json({ transferencia });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof svc.ErroDeTransferencia) return res.status(err.status).json(err.body);
    if (falhaDeSchema(err)) {
      return res.status(503).json({ error: 'Recurso ainda não disponível. Tente de novo em alguns minutos.', code: 'SCHEMA_PENDENTE' });
    }
    if (err && (err.code === '40P01' || err.code === '40001' || err.code === '55P03')) {
      return res.status(409).json({ error: 'O estoque mudou enquanto a transferência era feita. Tente de novo.', code: 'TENTE_DE_NOVO' });
    }
    console.error('[estoqueTransferencias] POST error:', err && err.message, err && err.code);
    res.status(500).json({ error: 'Erro ao transferir o estoque' });
  } finally {
    client.release();
  }
});

router.get('/', async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  try {
    const out = await svc.listar(db, req.params.id, { limit, offset });
    res.json(out);
  } catch (err) {
    if (falhaDeSchema(err)) return res.json({ transferencias: [], total: 0, limit, offset });
    console.error('[estoqueTransferencias] GET error:', err && err.message);
    res.status(500).json({ error: 'Erro ao listar as transferências' });
  }
});

module.exports = router;
