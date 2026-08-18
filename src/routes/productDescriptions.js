// ============================================================
// AURA. — Descrição de produto por IA: gerar, revisar, aprovar (F0 → F1)
// Montado sob /companies/:id/products.
//
//   GET  /products/descriptions/coverage            — placar de cobertura
//   POST /products/descriptions/generate            — gera rascunhos
//   GET  /products/descriptions/drafts?status=      — lista rascunhos
//   POST /products/descriptions/drafts/:did/approve — publica no produto
//   POST /products/descriptions/drafts/:did/reject  — descarta
//
// ⚠️ ORDEM DE MONTAGEM: todas estas rotas começam por `descriptions`, que
// é ESTÁTICO, e products.js tem um `GET /:id` curinga. Este router TEM que
// ser montado ANTES de require('./products') em private.js, senão o Express
// trata 'descriptions' como uuid e estoura "invalid input syntax for type
// uuid". É a mesma armadilha já paga neste repo (ver comentários do F0
// Bloco B1 em private.js).
//
// ── A REVISÃO É O PRODUTO ───────────────────────────────────
// Gerar texto é barato (~R$0,006 por produto). O que tem custo é revisar:
// 1.487 produtos a 10 segundos cada dão ~4 horas de trabalho humano. Por
// isso o approve é explícito e por rascunho: `products.description` só
// muda por ação de gente. Nenhum caminho desta rota escreve no catálogo
// sem passar pelo approve.
//
// ── PLANO ───────────────────────────────────────────────────
// A geração é CRIAÇÃO e é gateada em Negócio/Expansão (CLAUDE.md,
// armadilha 3: nunca bloquear GET de leitura por plano). O placar de
// cobertura e a lista de rascunhos são leitura e ficam liberados — o
// lojista do Essencial precisa enxergar o quanto do catálogo está sem
// texto, senão o gate vira parede cega.
//
// ── DEFENSIVO ───────────────────────────────────────────────
// A tabela product_description_drafts vem da migration 287. Enquanto ela
// não estiver aplicada, 42P01 vira 503 com código explícito em vez de 500
// genérico (CLAUDE.md, armadilhas 1 e 10).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requirePlan } = require('../middleware/auth');
const { generateDescriptions, PACK_SIZE } = require('../services/productDescriptionAi');

const DEFAULT_LIMIT = 40;
const MAX_LIMIT     = 200;   // teto por chamada: 10 lotes de 20

function migrationPending(res) {
  return res.status(503).json({
    error: 'Rascunhos de descrição ainda não disponíveis nesta base. Aplique a migration 287.',
    code:  'MIGRATION_287_PENDENTE',
  });
}

// ── GET /descriptions/coverage ───────────────────────────────
// Semente do índice de saúde do catálogo (Onda E). Mede o que a IA
// preenche, para o lojista ver o buraco antes e depois.
router.get('/descriptions/coverage', async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows } = await db.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE description IS NOT NULL AND btrim(description) <> '')::int AS com_descricao,
             COUNT(*) FILTER (WHERE image_url IS NOT NULL)::int AS com_foto
        FROM products
       WHERE company_id = $1 AND is_active IS TRUE
    `, [cid]);

    const r = rows[0] || { total: 0, com_descricao: 0, com_foto: 0 };
    const pct = (n) => (r.total ? Math.round((n * 1000) / r.total) / 10 : 0);

    let rascunhos_pendentes = 0;
    try {
      const { rows: d } = await db.query(
        `SELECT COUNT(*)::int AS n FROM product_description_drafts
          WHERE company_id = $1 AND status = 'pendente'`,
        [cid]
      );
      rascunhos_pendentes = d[0] ? d[0].n : 0;
    } catch (e) {
      if (e.code !== '42P01') throw e;   // sem a 287 ainda: zero, não erro
    }

    res.json({
      total: r.total,
      com_descricao: r.com_descricao,
      sem_descricao: r.total - r.com_descricao,
      com_foto: r.com_foto,
      sem_foto: r.total - r.com_foto,
      pct_descricao: pct(r.com_descricao),
      pct_foto: pct(r.com_foto),
      rascunhos_pendentes,
    });
  } catch (err) {
    console.error('[productDescriptions] coverage error:', err.message);
    res.status(500).json({ error: 'Erro ao calcular cobertura do catálogo' });
  }
});

// ── GET /descriptions/drafts ─────────────────────────────────
router.get('/descriptions/drafts', async (req, res) => {
  const cid = req.params.id;
  const status = req.query.status || 'pendente';
  if (!['pendente', 'aprovado', 'rejeitado'].includes(status)) {
    return res.status(400).json({ error: 'status inválido. Use pendente, aprovado ou rejeitado.' });
  }
  try {
    const { rows } = await db.query(`
      SELECT d.id, d.product_id, d.draft, d.model, d.status, d.created_at, d.reviewed_at,
             p.name AS product_name, p.brand, p.category
        FROM product_description_drafts d
        JOIN products p ON p.id = d.product_id
       WHERE d.company_id = $1 AND d.status = $2
       ORDER BY d.created_at DESC
       LIMIT 200
    `, [cid, status]);
    res.json({ drafts: rows, total: rows.length });
  } catch (err) {
    if (err.code === '42P01') return migrationPending(res);
    console.error('[productDescriptions] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar rascunhos' });
  }
});

// ── POST /descriptions/generate ──────────────────────────────
// body: { limit?, product_ids?, dry_run? }
router.post('/descriptions/generate', requirePlan('negocio', 'expansao'), async (req, res) => {
  const cid = req.params.id;
  const body = req.body || {};
  const dryRun = body.dry_run === true;

  let limit = parseInt(body.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(limit, MAX_LIMIT);

  const ids = Array.isArray(body.product_ids) ? body.product_ids.filter(Boolean) : null;

  try {
    // Candidatos: ativos, sem descrição, sem rascunho pendente. O NOT EXISTS
    // é o que impede empilhar rascunho ao chamar a rota duas vezes — o índice
    // único parcial da 287 é a segunda linha de defesa, não a primeira.
    const params = [cid];
    let where = `p.company_id = $1
                 AND p.is_active IS TRUE
                 AND (p.description IS NULL OR btrim(p.description) = '')`;
    if (ids && ids.length) {
      params.push(ids);
      where += ` AND p.id = ANY($${params.length}::uuid[])`;
    }
    params.push(limit);

    const { rows: produtos } = await db.query(`
      SELECT p.id, p.name, p.brand, p.category, p.color, p.size, p.unit
        FROM products p
       WHERE ${where}
         AND NOT EXISTS (
           SELECT 1 FROM product_description_drafts d
            WHERE d.product_id = p.id AND d.status = 'pendente'
         )
       ORDER BY p.created_at DESC
       LIMIT $${params.length}
    `, params);

    if (!produtos.length) {
      return res.json({
        generated: 0, drafts: [], errors: [],
        message: 'Nenhum produto elegível: todos já têm descrição ou rascunho pendente.',
      });
    }

    const { results, errors, usage } = await generateDescriptions(produtos);

    if (dryRun) {
      return res.json({
        dry_run: true,
        generated: results.length,
        drafts: results,
        errors,
        usage: { ...usage, pack_size: PACK_SIZE },
      });
    }

    // Persiste um a um: um produto que perdeu a corrida (rascunho criado por
    // outra chamada em paralelo) bate no índice único e é pulado, sem
    // derrubar os demais.
    const saved = [];
    for (const r of results) {
      try {
        const { rows } = await db.query(`
          INSERT INTO product_description_drafts
            (company_id, product_id, draft, model, input_tokens, output_tokens)
          VALUES ($1,$2,$3,$4,$5,$6)
          RETURNING id, product_id, draft, model, status, created_at
        `, [cid, r.product_id, r.description, r.model, r.input_tokens, r.output_tokens]);
        saved.push(rows[0]);
      } catch (e) {
        if (e.code === '23505') continue;                  // já havia pendente
        if (e.code === '42P01') return migrationPending(res);
        throw e;
      }
    }

    res.status(201).json({
      generated: saved.length,
      drafts: saved,
      errors,
      usage: { ...usage, pack_size: PACK_SIZE },
    });
  } catch (err) {
    if (err.code === '42P01') return migrationPending(res);
    console.error('[productDescriptions] generate error:', err.message);
    res.status(500).json({ error: 'Erro ao gerar descrições' });
  }
});

// ── POST /descriptions/drafts/:did/approve ───────────────────
// O ÚNICO caminho desta rota que escreve em products.description.
router.post('/descriptions/drafts/:did/approve', requirePlan('negocio', 'expansao'), async (req, res) => {
  const { id: cid, did } = req.params;
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE: dois cliques no aprovar não podem publicar duas vezes.
    const { rows } = await client.query(
      `SELECT id, product_id, draft FROM product_description_drafts
        WHERE id = $1 AND company_id = $2 AND status = 'pendente'
        FOR UPDATE`,
      [did, cid]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Rascunho não encontrado ou já revisado' });
    }
    const draft = rows[0];

    // company_id no WHERE do UPDATE: o rascunho já é da empresa, mas o
    // produto tem que ser também — guarda multi-tenant no write path.
    const { rowCount } = await client.query(
      `UPDATE products SET description = $1, updated_at = NOW()
        WHERE id = $2 AND company_id = $3`,
      [draft.draft, draft.product_id, cid]
    );
    if (!rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Produto não encontrado nesta empresa' });
    }

    await client.query(
      `UPDATE product_description_drafts
          SET status = 'aprovado', reviewed_at = NOW(), reviewed_by = $2
        WHERE id = $1`,
      [did, (req.user && req.user.id) || null]
    );

    await client.query('COMMIT');
    res.json({ approved: true, product_id: draft.product_id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '42P01') return migrationPending(res);
    console.error('[productDescriptions] approve error:', err.message);
    res.status(500).json({ error: 'Erro ao aprovar descrição' });
  } finally {
    client.release();
  }
});

// ── POST /descriptions/drafts/:did/reject ────────────────────
// Não escreve no produto. Libera o produto para nova geração (o índice
// único parcial só vale para status='pendente').
router.post('/descriptions/drafts/:did/reject', requirePlan('negocio', 'expansao'), async (req, res) => {
  const { id: cid, did } = req.params;
  try {
    const { rowCount } = await db.query(
      `UPDATE product_description_drafts
          SET status = 'rejeitado', reviewed_at = NOW(), reviewed_by = $3
        WHERE id = $1 AND company_id = $2 AND status = 'pendente'`,
      [did, cid, (req.user && req.user.id) || null]
    );
    if (!rowCount) return res.status(404).json({ error: 'Rascunho não encontrado ou já revisado' });
    res.json({ rejected: true });
  } catch (err) {
    if (err.code === '42P01') return migrationPending(res);
    console.error('[productDescriptions] reject error:', err.message);
    res.status(500).json({ error: 'Erro ao rejeitar rascunho' });
  }
});

module.exports = router;
