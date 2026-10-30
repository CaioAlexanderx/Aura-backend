// ============================================================
// AURA. — Gerar EAN-13 de um produto ou em lote (p-74, 30/10/2026)
// Mount: /companies/:id/products  ->  POST /barcodes/generate
//
// Pedido do Caio: gerar código de barras rápido e em massa. No varejo,
// 4.311 de 13.640 produtos ativos não tinham código nem SKU e a impressão
// de etiquetas travava. O código vai para a etiqueta impressa e para o
// bipe, então só grava por ação da lojista e com prévia (dry_run).
//
// Body: { targets: [{ product_id, variant_id|null }], dry_run: bool }  (máx. 500)
// 200:  { dry_run, items: [{ product_id, variant_id, barcode }],
//         skipped: [{ product_id, variant_id, reason }] }
//       reason: "ja_tem_codigo" | "nao_encontrado"
// 403:  { error, reason: "sem_permissao" } — quem não pode editar produto.
//
// Regras:
//   - nunca sobrescreve código existente (válido ou não): ja_tem_codigo;
//   - série "210" da faixa interna (prefixo 2), contador e dígito
//     verificador em services/gerarEan13.js;
//   - único em products E product_variants de TODAS as empresas do grupo
//     (ativas ou não). Hoje a única trava do banco é UNIQUE (company_id,
//     barcode) em products; variante não tem nenhuma. Por isso a conferência
//     é feita aqui, dentro da transação;
//   - pg_advisory_xact_lock por GRUPO (group_root): dois lotes de CNPJs do
//     mesmo grupo nunca pegam o mesmo número. Empresa fora de grupo tem
//     group_root = ela mesma, então a trava vira "por empresa";
//   - prévia e gravação calculam igual (maior da série + 1, na ordem dos
//     targets): dry_run=false devolve os mesmos itens da prévia quando
//     nada mudou entre as chamadas; se mudou, devolve o que gravou;
//   - audit_log "barcodes_generated" (quantos, por quem), na transação.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { companyGroupWhere } = require('../utils/companyGroup');
const { SERIE_REGEX_SQL, CONTADOR_MAX, codigoDaSerie } = require('../services/gerarEan13');

const MAX_TARGETS = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Visibilidade de produto para escrita: a mesma do PATCH /products/:pid
// (visibilityWhere em products.js) — produto da empresa OU compartilhado
// (is_group_shared) por empresa do mesmo grupo. Copiada, com prefixo de
// tabela, como em productsVariations.js. Se o canônico mudar, mudar aqui.
function visivelParaEmpresa(cidParam, prefix) {
  return `(${prefix}company_id = ${cidParam} OR (
    ${prefix}is_group_shared = true
    AND ${prefix}company_id IN (
      SELECT id FROM companies
      WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
        SELECT COALESCE(NULLIF(billing_owner_company_id, id), id)
        FROM companies WHERE id = ${cidParam}
      )
    )
  ))`;
}

function semCodigo(barcode) {
  return barcode === null || barcode === undefined || String(barcode).trim() === '';
}

// Quem pode editar produto: dono, admin da plataforma, ou membro com a tela
// Estoque liberada. Mesma leitura de /auth/my-permissions: permissions null
// = sem restrição; com objeto, a chave estoque precisa estar ligada.
async function podeEditarProduto(req, companyId) {
  if (req.user && req.user.role === 'admin') return true;
  if (req.companyRole === 'owner' || req.companyRole === 'admin') return true;
  const { rows } = await db.query(
    `SELECT (c.owner_id = $2) AS is_owner, cm.role_label, cm.permissions
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id AND cm.user_id = $2
        AND cm.status = 'active' AND cm.is_active = true
      WHERE c.id = $1
      LIMIT 1`,
    [companyId, req.user && req.user.id]
  );
  const r = rows[0];
  if (!r) return false;
  if (r.is_owner === true || r.role_label === 'owner') return true;
  if (!r.role_label) return false; // nem dono nem membro ativo
  let perms = r.permissions;
  if (typeof perms === 'string') {
    try { perms = JSON.parse(perms); } catch (_) { perms = {}; }
  }
  if (perms === null || perms === undefined) return true;
  return !!perms.estoque;
}

// Normaliza e deduplica os alvos. Alvo com id que não é uuid vira
// nao_encontrado sem ir ao banco.
function normalizarAlvos(targets) {
  const vistos = new Set();
  const alvos = [];
  const invalidos = [];
  for (const t of targets) {
    const productId = t && typeof t.product_id === 'string' ? t.product_id.trim() : '';
    const rawVar = t ? t.variant_id : null;
    const variantId = rawVar === null || rawVar === undefined || rawVar === ''
      ? null : String(rawVar).trim();
    const chave = productId + '|' + (variantId || '');
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    if (!UUID_RE.test(productId) || (variantId !== null && !UUID_RE.test(variantId))) {
      invalidos.push({ product_id: productId || null, variant_id: variantId, reason: 'nao_encontrado' });
      continue;
    }
    alvos.push({ product_id: productId, variant_id: variantId });
  }
  return { alvos, invalidos };
}

// Próximos `quantos` códigos livres da série no grupo. Parte do maior
// número da série já gravado no grupo (products + product_variants, ativos
// ou não) e confere cada candidato contra o grupo antes de devolver.
async function proximosCodigos(client, companyId, quantos) {
  const { rows: maxRows } = await client.query(
    `SELECT COALESCE(MAX(substr(t.code, 4, 9)::bigint), 0) AS max_n FROM (
       SELECT p.barcode AS code FROM products p
        WHERE ${companyGroupWhere('$1', 'p.')} AND p.barcode ~ $2
       UNION ALL
       SELECT pv.barcode AS code FROM product_variants pv
         JOIN products p ON p.id = pv.product_id
        WHERE ${companyGroupWhere('$1', 'p.')} AND pv.barcode ~ $2
     ) t`,
    [companyId, SERIE_REGEX_SQL]
  );
  let n = Number(maxRows[0] && maxRows[0].max_n) || 0;
  const codigos = [];
  // Acima do maior número não deveria haver código da série; a conferência
  // é defesa (código gravado por outra rota sem passar pela trava).
  for (let tentativa = 0; codigos.length < quantos && tentativa < 20; tentativa++) {
    const faltam = quantos - codigos.length;
    if (n + faltam > CONTADOR_MAX) {
      const err = new Error('Série de códigos internos esgotada para este grupo');
      err.status = 409;
      throw err;
    }
    const candidatos = [];
    for (let i = 0; i < faltam; i++) candidatos.push(codigoDaSerie(++n));
    const { rows: usados } = await client.query(
      `SELECT p.barcode AS code FROM products p
        WHERE ${companyGroupWhere('$1', 'p.')} AND p.barcode = ANY($2::text[])
       UNION
       SELECT pv.barcode AS code FROM product_variants pv
         JOIN products p ON p.id = pv.product_id
        WHERE ${companyGroupWhere('$1', 'p.')} AND pv.barcode = ANY($2::text[])`,
      [companyId, candidatos]
    );
    const ocupado = new Set(usados.map((r) => r.code));
    for (const c of candidatos) if (!ocupado.has(c)) codigos.push(c);
  }
  if (codigos.length < quantos) {
    const err = new Error('Não foi possível reservar códigos livres');
    err.status = 409;
    throw err;
  }
  return codigos;
}

router.post('/barcodes/generate', async (req, res) => {
  const companyId = req.params.id;
  const body = req.body || {};
  const targets = body.targets;
  // Sem dry_run explícito = prévia. Gravar exige dry_run: false.
  const dryRun = body.dry_run !== false;

  if (!Array.isArray(targets) || targets.length === 0) {
    return res.status(400).json({ error: 'Informe os produtos (targets)' });
  }
  if (targets.length > MAX_TARGETS) {
    return res.status(400).json({ error: `No máximo ${MAX_TARGETS} itens por vez` });
  }

  try {
    if (!(await podeEditarProduto(req, companyId))) {
      return res.status(403).json({
        error: 'Seu acesso não permite alterar produtos. Peça ao responsável pela loja.',
        reason: 'sem_permissao',
      });
    }
  } catch (err) {
    console.error('[barcodes/generate] permissao:', err.message);
    return res.status(500).json({ error: 'Erro ao gerar códigos' });
  }

  const { alvos, invalidos } = normalizarAlvos(targets);
  const skipped = [...invalidos];
  const items = [];

  const client = await db.connect();
  let emTransacao = false;
  try {
    await client.query('BEGIN');
    emTransacao = true;

    if (!dryRun) {
      // Trava por grupo, liberada no COMMIT/ROLLBACK. A prévia não trava:
      // não grava nada e não pode segurar a gravação de outra pessoa.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('ean13-gerar:' || (
           SELECT COALESCE(NULLIF(billing_owner_company_id, id), id)::text
             FROM companies WHERE id = $1
         )))`,
        [companyId]
      );
    }

    const productIds = [...new Set(alvos.map((a) => a.product_id))];
    const variantIds = [...new Set(alvos.filter((a) => a.variant_id).map((a) => a.variant_id))];

    const produtos = new Map();
    if (productIds.length) {
      const { rows } = await client.query(
        `SELECT p.id, p.barcode FROM products p
          WHERE p.id = ANY($2::uuid[]) AND ${visivelParaEmpresa('$1', 'p.')}`,
        [companyId, productIds]
      );
      rows.forEach((r) => produtos.set(r.id, r));
    }
    const variantes = new Map();
    if (variantIds.length) {
      const { rows } = await client.query(
        `SELECT pv.id, pv.product_id, pv.barcode FROM product_variants pv
          WHERE pv.id = ANY($1::uuid[]) AND pv.is_active = true`,
        [variantIds]
      );
      rows.forEach((r) => variantes.set(r.id, r));
    }

    const pendentes = [];
    for (const a of alvos) {
      const prod = produtos.get(a.product_id);
      if (!prod) { skipped.push({ ...a, reason: 'nao_encontrado' }); continue; }
      if (a.variant_id) {
        const v = variantes.get(a.variant_id);
        if (!v || v.product_id !== a.product_id) { skipped.push({ ...a, reason: 'nao_encontrado' }); continue; }
        if (!semCodigo(v.barcode)) { skipped.push({ ...a, reason: 'ja_tem_codigo' }); continue; }
      } else if (!semCodigo(prod.barcode)) {
        skipped.push({ ...a, reason: 'ja_tem_codigo' });
        continue;
      }
      pendentes.push(a);
    }

    if (pendentes.length) {
      const codigos = await proximosCodigos(client, companyId, pendentes.length);
      pendentes.forEach((a, i) => items.push({ ...a, barcode: codigos[i] }));
    }

    if (dryRun) {
      await client.query('ROLLBACK');
      emTransacao = false;
      return res.json({ dry_run: true, items, skipped });
    }

    let gravados = items;
    if (items.length) {
      const doProduto = items.filter((it) => !it.variant_id);
      const daVariante = items.filter((it) => it.variant_id);
      const okProd = new Set();
      const okVar = new Set();
      // Só grava onde continua sem código: outra tela pode ter gravado um
      // entre a leitura e aqui (a trava só segura este gerador).
      if (doProduto.length) {
        const { rows } = await client.query(
          `UPDATE products p
              SET barcode = v.code, barcode_format = 'EAN-13'::barcode_format, updated_at = NOW()
             FROM unnest($1::uuid[], $2::text[]) AS v(id, code)
            WHERE p.id = v.id AND (p.barcode IS NULL OR btrim(p.barcode) = '')
            RETURNING p.id`,
          [doProduto.map((it) => it.product_id), doProduto.map((it) => it.barcode)]
        );
        rows.forEach((r) => okProd.add(r.id));
      }
      if (daVariante.length) {
        const { rows } = await client.query(
          `UPDATE product_variants pv
              SET barcode = v.code, barcode_format = 'EAN-13'::barcode_format, updated_at = NOW()
             FROM unnest($1::uuid[], $2::text[]) AS v(id, code)
            WHERE pv.id = v.id AND (pv.barcode IS NULL OR btrim(pv.barcode) = '')
            RETURNING pv.id`,
          [daVariante.map((it) => it.variant_id), daVariante.map((it) => it.barcode)]
        );
        rows.forEach((r) => okVar.add(r.id));
      }
      gravados = [];
      for (const it of items) {
        const ok = it.variant_id ? okVar.has(it.variant_id) : okProd.has(it.product_id);
        if (ok) gravados.push(it);
        else skipped.push({ product_id: it.product_id, variant_id: it.variant_id, reason: 'ja_tem_codigo' });
      }

      // Auditoria na mesma transação, num savepoint: se a tabela faltar, a
      // gravação dos códigos não cai por isso.
      await client.query('SAVEPOINT auditoria_ean13');
      try {
        await client.query(
          `INSERT INTO audit_log (user_id, company_id, action, detail, metadata)
           VALUES ($1, $2, 'barcodes_generated', $3, $4)`,
          [
            (req.user && req.user.id) || null,
            companyId,
            `Gerou ${gravados.length} código(s) de barras EAN-13`,
            JSON.stringify({
              gerados: gravados.length,
              pulados: skipped.length,
              de_produto: gravados.filter((g) => !g.variant_id).length,
              de_variante: gravados.filter((g) => g.variant_id).length,
            }),
          ]
        );
        await client.query('RELEASE SAVEPOINT auditoria_ean13');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT auditoria_ean13');
        console.error('[barcodes/generate] audit_log:', e.message);
      }
    }

    await client.query('COMMIT');
    emTransacao = false;
    return res.json({ dry_run: false, items: gravados, skipped });
  } catch (err) {
    if (emTransacao) {
      try { await client.query('ROLLBACK'); } catch (_) { /* conexão já caiu */ }
    }
    if (err.code === '23505') {
      // UNIQUE (company_id, barcode) de products: alguém gravou o mesmo
      // código por outra tela no meio do lote. Nada foi gravado.
      return res.status(409).json({ error: 'Um dos códigos acabou de ser usado. Tente de novo.' });
    }
    if (err.status === 409) return res.status(409).json({ error: err.message });
    console.error('[barcodes/generate] erro:', err.message);
    return res.status(500).json({ error: 'Erro ao gerar códigos' });
  } finally {
    client.release();
  }
});

module.exports = router;
// Exposto só para os testes.
module.exports._internals = { normalizarAlvos, podeEditarProduto };
