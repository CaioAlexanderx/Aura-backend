// ============================================================
// AURA. — Em qual loja o produto entra (B1, 20/11/2026)
//
// Regras em src/services/produtoNasLojas.js. Montado em private.js sob
// /products, ANTES de ./products (rota estatica antes da parametrica).
//
//   GET  /companies/:id/products/lojas-para-cadastro
//     200 { estoque_unico, lojas: [{ company_id, nome, ativa, regime,
//            limite: { usados, maximo|null } }] }
//     Lojas do grupo de :id em que a pessoa mexe no estoque. Menos de 2:
//     o app esconde o campo e envia o mesmo de hoje.
//
//   POST /companies/:id/products/:pid/lojas
//     { lojas: [{ company_id, stock_qty, variantes: [{ variant_id, stock_qty }] }] }
//     200 { master_sku, resultados: [{ company_id, nome, status:
//            'criado'|'ja_existia'|'erro', product_id, stock_qty, avisos,
//            erro?: { code, message, produto_conflito? } }] }
//     (200 mesmo com falha parcial — D15.)
//     4xx { error, code }: LOJAS_INVALIDAS, QUANTIDADE_INVALIDA,
//       VARIANTE_INVALIDA (400); SEM_ACESSO (403); PRODUTO_NAO_ENCONTRADO
//       (404); PRODUTO_COMPARTILHADO (409).
//
// O mount /products tem o estoqueSoConsulta: o perfil "estoque so consulta"
// leva 403 nas duas (rota nova sob /products nasce fechada para ele).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const svc = require('../services/produtoNasLojas');

const ehStaff = (req) => !!(req.user && req.user.role === 'admin');
const falhaDeSchema = (err) => err && (err.code === '42P01' || err.code === '42703');

router.get('/lojas-para-cadastro', async (req, res) => {
  try {
    const out = await svc.lojasParaCadastro(db, {
      companyId: req.params.id,
      userId: req.user && req.user.id,
      isStaff: ehStaff(req),
    });
    res.json(out);
  } catch (err) {
    console.error('[productsNasLojas] GET lojas-para-cadastro error:', err && err.message);
    res.status(500).json({ error: 'Erro ao listar as lojas' });
  }
});

router.post('/:pid/lojas', async (req, res) => {
  let lojas;
  try {
    lojas = svc.lerPedidoDeLojas(req.body);
  } catch (e) {
    if (e instanceof svc.ErroDeLojas) return res.status(e.status).json(e.body);
    throw e;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await svc.levarParaLojas(client, {
      origemId: req.params.id,
      productId: req.params.pid,
      userId: req.user && req.user.id,
      isStaff: ehStaff(req),
      lojas,
    });
    await client.query('COMMIT');
    res.json(out);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof svc.ErroDeLojas) return res.status(err.status).json(err.body);
    if (falhaDeSchema(err)) {
      return res.status(503).json({ error: 'Recurso ainda não disponível. Tente de novo em alguns minutos.', code: 'SCHEMA_PENDENTE' });
    }
    if (err && (err.code === '40P01' || err.code === '40001' || err.code === '55P03')) {
      return res.status(409).json({ error: 'O estoque mudou enquanto o cadastro era feito. Tente de novo.', code: 'TENTE_DE_NOVO' });
    }
    console.error('[productsNasLojas] POST lojas error:', err && err.message, err && err.code);
    res.status(500).json({ error: 'Erro ao cadastrar o produto nas outras lojas' });
  } finally {
    client.release();
  }
});

module.exports = router;
