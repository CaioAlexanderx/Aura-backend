// ============================================================
// AURA. — Nomes de cor para conferir (CP5 da revisão de cores, 14/11/2026)
// Mount: /companies/:id/products  (ANTES de ./products: caminho estático)
//
//   GET  /cores-para-conferir            → só leitura: grupos por pedaço,
//                                           com sugestão e o que sai hoje
//   POST /cores-para-conferir/confirmar  → { itens: [{ product_id, hex, nome }] }
//                                           grava o nome que a lojista
//                                           confirmou, por produto e cor
//
// Regras em services/coresParaConferir.js. O perfil estoque_consulta leva
// 403 no estoqueSoConsulta (rota nova sob /products nasce fechada).
// Multi-CNPJ: vale o que a loja enxerga (próprios + compartilhados do grupo).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { logAuditAction, contextoDaRequisicao } = require('../middleware/auditLog');
const { listar, lerConfirmacao, confirmar } = require('../services/coresParaConferir');

router.get('/cores-para-conferir', async (req, res) => {
  try {
    return res.json(await listar(db, req.params.id));
  } catch (err) {
    console.error('[cores-para-conferir GET]', err.message);
    return res.status(500).json({ error: 'Não consegui listar os nomes de cor agora.' });
  }
});

router.post('/cores-para-conferir/confirmar', async (req, res) => {
  const cid = req.params.id;
  const lido = lerConfirmacao(req.body);
  if (lido.erro) return res.status(400).json({ error: lido.erro });

  const client = await db.connect();
  let r;
  try {
    await client.query('BEGIN');
    r = await confirmar(client, cid, lido.itens);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('[cores-para-conferir POST]', err.message);
    return res.status(500).json({ error: 'Não consegui gravar os nomes agora. Nada foi mudado.' });
  }
  client.release();

  logAuditAction(
    req.user?.id || null, cid, 'products.color_names_confirmed',
    `Confirmou o nome de ${lido.itens.length} cor(es) (${r.variantes} variantes)`,
    { itens: lido.itens.map((i) => [i.product_id, i.hex, i.nome]), variantes: r.variantes, recusados: r.recusados },
    contextoDaRequisicao(req)
  );
  return res.json(r);
});

module.exports = router;
