// ============================================================
// AURA. — GET /me/estoque/por-loja (visão consolidada multi-CNPJ)
//
// 10/11/2026: o mesmo produto numa linha só, com o estoque de cada loja.
// Regra do agrupamento, limites e acesso: src/services/estoquePorLoja.js.
//
//   GET /me/estoque/por-loja?q=&categoria=&limit=&offset=
//     { lojas: [{id, nome}],
//       itens: [{chave, nome, sku, barcode, imagem_url, preco,
//                por_loja: [{company_id, product_id, estoque, compartilhado,
//                            dona_company_id?}],
//                total, tem_variantes}],
//       total_itens }
//
//   GET /me/estoque/por-loja/variantes?chave=...
//     { lojas: [...],
//       variantes: [{rotulo, sku, barcode,
//                    por_loja: [{company_id, variant_id, estoque, compartilhado,
//                                dona_company_id?}],
//                    total}] }
//
// Só leitura, como todo /me/*: para editar, o usuário entra na loja.
// Sem gate de plano (CLAUDE.md, armadilha 3: GET de listagem não bloqueia).
// ============================================================
'use strict';

const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const svc = require('../services/estoquePorLoja');

router.use(requireAuth);

const LIMITE_PADRAO = 50;
const LIMITE_MAX = 200;

function inteiro(v, padrao, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(Math.max(n, min), max);
}

function texto(v, max = 200) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

router.get('/estoque/por-loja', async (req, res) => {
  try {
    const lojas = await svc.lojasDoUsuario(req.user.id);
    const out = await svc.listarPorLoja(lojas, {
      q: texto(req.query.q),
      categoria: texto(req.query.categoria),
      limit: inteiro(req.query.limit, LIMITE_PADRAO, 1, LIMITE_MAX),
      offset: inteiro(req.query.offset, 0, 0, 1e7),
    });
    res.json(out);
  } catch (err) {
    console.error('[meEstoquePorLoja] lista:', err.message);
    res.status(500).json({ error: 'Erro ao carregar o estoque por loja' });
  }
});

router.get('/estoque/por-loja/variantes', async (req, res) => {
  const chave = texto(req.query.chave, 600);
  if (!chave) return res.status(400).json({ error: 'Informe a chave do item' });
  try {
    const lojas = await svc.lojasDoUsuario(req.user.id);
    const out = await svc.variantesDoItem(lojas, chave);
    if (!out) return res.status(404).json({ error: 'Item não encontrado nas suas lojas' });
    res.json(out);
  } catch (err) {
    console.error('[meEstoquePorLoja] variantes:', err.message);
    res.status(500).json({ error: 'Erro ao carregar as variantes por loja' });
  }
});

module.exports = router;
