// ============================================================
// AURA. — Entrada de vários itens: "Chegou mercadoria" (B2a e B3, 17/11/2026)
//
// Migration 457 (stock_receipts). Estimativa p-171, Fase 2.
//
//   POST /products/stock-receipts   entrada de vários produtos existentes numa
//                                   ida só, numa transação, com chave contra
//                                   entrar em dobro
//   GET  /products/stock-receipts   "nota já lançada?" (chave da NF-e, ou
//                                   número + fornecedor), inclusive nas
//                                   entradas antigas de um produto ('NF <n>')
//
// Montado em /products ANTES de ./productSuppliers e ./products (o GET /:pid
// curinga de ./products engoliria 'stock-receipts'). Passa pelo
// estoqueSoConsulta do mount: o perfil consulta leva 403 (rota nova nasce
// fechada) e quem não vê custo tem unit_cost tirado do corpo (a linha entra
// sem custo: soma o estoque e não mexe no custo) e recebe a resposta sem os
// campos de custo (unit_cost, avg_cost, total_cost).
//
// Multi-CNPJ: a entrada é sempre da loja da rota (:id). Produto pela regra
// única de visibilidade (productVisibilityWhere, a mesma da entrada de um
// produto): o próprio ou o compartilhado do grupo, que tem um estoque só.
// Fornecedor pelo grupo (companyGroupWhere). O movimento e o cabeçalho
// ficam com a loja que recebeu.
//
// Matcon: nada aqui é do Matcon. A nota do Matcon continua pelo caminho
// dele (custo da nota, pendência 4); o app desvia antes de chegar aqui.
//
// B2b (17/11/2026): produtos NOVOS na mesma chamada (item com new_product
// em vez de product_id). Preço de venda obrigatório (pendência 6, decidida
// pelo Caio em 17/11: o app sugere pela margem e a pessoa pode editar).
// Nascem com estoque 0 e custo 0, na loja da rota, compartilhados no grupo
// pela mesma regra do "+ Produto" (POST /products), e recebem a entrada
// pelo mesmo caminho dos outros: custo médio, fornecedor principal,
// movimento. Respeitam o limite de produtos do plano (tudo ou nada) e
// avançam o passo "produto" do onboarding, como os imports.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { productVisibilityWhere } = require('../utils/companyGroup');
const crypto = require('crypto');
const { onlyDigits } = require('../utils/cnpj');
const {
  lerEntrada, round, numeroPositivo, falhaDeSchema, conferirGrade, achaOuCriaFornecedor,
} = require('../services/entradaDeMercadoria');
const { planejarEntradaEmLote, gravarEntradaEmLote } = require('../services/entradaEmLote');
const { avancarSemEsperar } = require('../services/onboardingProgress');
const { linkImportedCategories } = require('../services/importCategoryLink');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAVE = /^[A-Za-z0-9._:-]{8,100}$/;
const ORIGENS = new Set(['nota', 'planilha', 'digitar', 'lista']);
const MAX_LINHAS = 300;
const SCHEMA_PENDENTE = { error: 'Recurso ainda não disponível. Tente de novo em alguns minutos.', code: 'SCHEMA_PENDENTE' };

// Igual a products.js e productsBatch.js (essencial=2000, negocio=7000,
// expansao=ilimitado). O plano vem do JWT, como nas outras rotas de cadastro.
function limiteDoPlano(plan) {
  switch ((plan || '').toLowerCase()) {
    case 'expansao':
    case 'personalizado': return 999999;
    case 'negocio':       return 7000;
    default:              return 2000;
  }
}

const texto = (v, max) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);

// NCM: 8 dígitos ou nada (mesma regra do POST /products).
function lerNcm(v) {
  if (v === undefined || v === null) return null;
  const d = String(v).replace(/\D/g, '');
  return d.length === 8 ? d : null;
}

// Produto novo da linha (B2b). Devolve { erro } ou { novo }.
function lerProdutoNovo(np) {
  if (!np || typeof np !== 'object') return { erro: 'Produto novo inválido' };
  const nome = texto(np.name, 200);
  if (!nome) return { erro: 'Informe o nome do produto novo' };
  const preco = numeroPositivo(np.price);
  if (!preco) return { erro: 'Informe o preço de venda do produto novo' };
  return {
    novo: {
      name: nome,
      price: round(preco, 2),
      category: texto(np.category, 100) || 'Produtos',
      ncm: lerNcm(np.ncm),
      barcode: texto(np.barcode, 60),
      sku: texto(np.sku, 60),
      unit: texto(np.unit, 10) || 'un',
    },
  };
}

function lerChave(req) {
  const h = req.headers && req.headers['idempotency-key'];
  const raw = h !== undefined && h !== null && String(h).trim() ? h : req.body && req.body.idempotency_key;
  if (raw === undefined || raw === null) return null;
  const k = String(Array.isArray(raw) ? raw[0] : raw).trim();
  return CHAVE.test(k) ? k : null;
}

function lerNota(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().slice(0, 40);
  return s || null;
}

// Número da nota para comparar: sem espaços e sem zeros à esquerda
// ("004512" e "4512" são a mesma nota). Só dígitos zerados vira "0".
function notaParaComparar(n) {
  if (!n) return null;
  const s = String(n).trim().replace(/^0+(?=.)/, '');
  return s || null;
}

// Quantidade com no máximo 3 casas, a precisão do estoque (numeric(10,3)).
function arredondarQuantidades(entrada) {
  const itens = entrada.itens.map((i) => ({ ...i, quantidade: round(i.quantidade, 3) }));
  return { ...entrada, itens, total: round(itens.reduce((s, i) => s + i.quantidade, 0), 3) };
}

/**
 * Lê o corpo do POST, sem banco. Devolve { erro, status, code?, lines? } ou
 * { chave, origem, nota, chaveNfe, linhas: [{ index, product_id, entrada, supplierCode }] }.
 */
function lerRecebimento(req) {
  const b = req.body || {};
  const chave = lerChave(req);
  if (!chave) return { erro: 'Falta a chave da entrada (idempotency_key)', status: 400, code: 'SEM_CHAVE' };

  const origem = b.origin === undefined || b.origin === null || b.origin === '' ? 'digitar' : String(b.origin);
  if (!ORIGENS.has(origem)) return { erro: 'Origem inválida', status: 400 };

  let chaveNfe = null;
  if (b.nfe_key !== undefined && b.nfe_key !== null && String(b.nfe_key).trim() !== '') {
    chaveNfe = onlyDigits(String(b.nfe_key));
    if (chaveNfe.length !== 44) return { erro: 'Chave da nota inválida: são 44 números', status: 400 };
  }
  const nota = lerNota(b.invoice_number);

  if (b.supplier_id && !UUID.test(String(b.supplier_id))) return { erro: 'Fornecedor não encontrado', status: 404 };

  const itens = Array.isArray(b.items) ? b.items : null;
  if (!itens || !itens.length) return { erro: 'Informe os itens que chegaram', status: 400 };
  if (itens.length > MAX_LINHAS) {
    return { erro: `No máximo ${MAX_LINHAS} itens por entrada`, status: 400, code: 'LIMITE_DE_LINHAS', limit: MAX_LINHAS };
  }

  const linhas = [];
  const erros = [];
  const codigosNovos = new Map(); // código de barras -> index (produtos novos)
  itens.forEach((it, index) => {
    let novo = null;
    if (it && it.new_product && !it.product_id) {
      const lidoNovo = lerProdutoNovo(it.new_product);
      if (lidoNovo.erro) { erros.push({ index, product_id: null, error: lidoNovo.erro }); return; }
      novo = lidoNovo.novo;
      if (Array.isArray(it.variants) && it.variants.length) {
        erros.push({ index, product_id: null, error: 'Produto novo entra sem cor e tamanho; a grade você cadastra depois' });
        return;
      }
      if (novo.barcode) {
        if (codigosNovos.has(novo.barcode)) {
          erros.push({ index, product_id: null, error: `Código de barras repetido na entrada (item ${codigosNovos.get(novo.barcode) + 1})` });
          return;
        }
        codigosNovos.set(novo.barcode, index);
      }
    }
    const pid = novo ? null : (it && it.product_id ? String(it.product_id) : '');
    if (!novo && !UUID.test(pid)) { erros.push({ index, product_id: pid || null, error: 'Produto não encontrado' }); return; }
    const variantes = novo ? null : (Array.isArray(it.variants) ? it.variants : null);
    const lida = lerEntrada({
      quantity: it.quantity,
      items: variantes || undefined,
      unit_cost: it.unit_cost,
      update_cost: it.update_cost === undefined ? b.update_cost : it.update_cost,
    });
    if (lida.erro) { erros.push({ index, product_id: pid, error: lida.erro }); return; }
    if (lida.itens.some((i) => i.variant_id && !UUID.test(i.variant_id))) {
      erros.push({ index, product_id: pid, error: 'Variante inválida' });
      return;
    }
    const codigo = it.supplier_code === undefined || it.supplier_code === null
      ? null : String(it.supplier_code).trim().slice(0, 60) || null;
    linhas.push({ index, product_id: pid, novo, entrada: arredondarQuantidades({ ...lida, nota }), supplierCode: codigo });
  });
  if (erros.length) return { erro: 'Há itens com problema', status: 400, code: 'LINHAS_COM_ERRO', lines: erros };

  return { chave, origem, nota, chaveNfe, linhas };
}

function responderErro(res, r) {
  const corpo = { error: r.erro };
  if (r.code) corpo.code = r.code;
  if (r.lines) corpo.lines = r.lines;
  if (r.limit) corpo.limit = r.limit;
  return res.status(r.status).json(corpo);
}

// ─── POST /stock-receipts ────────────────────────────────────
// Corpo:
//   idempotency_key (ou cabeçalho Idempotency-Key): obrigatória, criada pelo
//     app ao abrir o wizard; a mesma chave de novo devolve a resposta
//     guardada (200, repeated: true) e não soma nada
//   supplier_id | new_supplier { name, cnpj, phone } | nenhum
//   invoice_number, nfe_key (44 dígitos), origin (nota|planilha|digitar|lista)
//   update_cost (padrão true; cada item pode trocar)
//   items[]: { product_id, quantity | variants[{ variant_id, quantity }],
//              unit_cost, supplier_code, update_cost }   até 300
//            ou, para cadastrar na hora (B2b):
//            { new_product: { name, price*, category, ncm, barcode, sku, unit },
//              quantity, unit_cost, supplier_code, update_cost }
// Tudo ou nada: um item com problema devolve 400 LINHAS_COM_ERRO com a
// lista (index = posição no items[]) e nada grava.
router.post('/stock-receipts', async (req, res) => {
  const cid = req.params.id;
  const lido = lerRecebimento(req);
  if (lido.erro) return responderErro(res, lido);
  const { chave, origem, nota, chaveNfe, linhas } = lido;
  const autor = req.user && UUID.test(String(req.user.id || '')) ? req.user.id : null;
  const inicio = Date.now();

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1. A chave primeiro: um segundo pedido com a mesma chave espera aqui
    //    (índice único) até o primeiro terminar, e então lê o resultado.
    const { rows: novo } = await client.query(
      `INSERT INTO stock_receipts (company_id, idempotency_key, origin, invoice_number, nfe_key, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id, created_at`,
      [cid, chave, origem, nota, chaveNfe, autor]
    );
    if (!novo.length) {
      const { rows: [guardado] } = await client.query(
        `SELECT company_id, result FROM stock_receipts WHERE idempotency_key = $1`, [chave]);
      await client.query('ROLLBACK');
      if (!guardado || String(guardado.company_id).toLowerCase() !== String(cid).toLowerCase()) {
        return res.status(409).json({ error: 'Esta chave já foi usada em outra loja', code: 'CHAVE_DE_OUTRA_LOJA' });
      }
      if (!guardado.result) {
        return res.status(409).json({ error: 'Esta entrada ainda está sendo gravada. Tente de novo em instantes.', code: 'EM_ANDAMENTO' });
      }
      return res.status(200).json({ ...guardado.result, repeated: true });
    }
    const recibo = novo[0];

    // 2. Trava os produtos e as variantes em ordem de id (duas entradas com
    //    os mesmos produtos em ordem diferente não se travam uma à outra).
    const existentes = linhas.filter((l) => !l.novo);
    const novos = linhas.filter((l) => l.novo);
    const pids = [...new Set(existentes.map((l) => l.product_id))];
    const { rows: travados } = await client.query(
      `SELECT id, company_id, name, stock_qty, cost_price, weighted_avg_cost, supplier_id
         FROM products
        WHERE id = ANY($1::uuid[]) AND ${productVisibilityWhere('$2')}
        ORDER BY id
        FOR UPDATE`,
      [pids, cid]
    );
    const produtos = new Map(travados.map((p) => [p.id, p]));
    const { rows: vs } = await client.query(
      `SELECT id, product_id, stock_qty FROM product_variants
        WHERE product_id = ANY($1::uuid[]) AND is_active = true
        ORDER BY id
        FOR UPDATE`,
      [travados.map((p) => p.id)]
    );
    const variantes = new Map();
    for (const v of vs) {
      if (!variantes.has(v.product_id)) variantes.set(v.product_id, []);
      variantes.get(v.product_id).push(v);
    }

    const erros = [];
    for (const l of existentes) {
      if (!produtos.has(l.product_id)) { erros.push({ index: l.index, product_id: l.product_id, error: 'Produto não encontrado' }); continue; }
      const e = conferirGrade(l.entrada, variantes.get(l.product_id) || []);
      if (e) erros.push({ index: l.index, product_id: l.product_id, error: e });
    }
    // Produto novo com código de barras que a loja já usa: ligar ao que existe.
    const codigos = novos.map((l) => l.novo.barcode).filter(Boolean);
    if (codigos.length) {
      const { rows: jaUsados } = await client.query(
        `SELECT barcode, name FROM products WHERE company_id = $1 AND barcode = ANY($2::text[])`,
        [cid, codigos]
      );
      const dono = new Map(jaUsados.map((r) => [r.barcode, r.name]));
      for (const l of novos) {
        if (l.novo.barcode && dono.has(l.novo.barcode)) {
          erros.push({ index: l.index, product_id: null, error: `Este código de barras já é do produto "${dono.get(l.novo.barcode)}". Ligue o item a ele.` });
        }
      }
    }
    if (erros.length) {
      await client.query('ROLLBACK');
      return responderErro(res, { erro: 'Há itens com problema', status: 400, code: 'LINHAS_COM_ERRO', lines: erros });
    }

    // Limite de produtos do plano: os novos entram todos ou nenhum.
    let compartilharNovos = false;
    if (novos.length) {
      const grupo = await estatisticasDaLoja(client, cid);
      const limite = limiteDoPlano(req.user && req.user.plan);
      if (grupo.total + novos.length > limite) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          error: `Limite de produtos do plano: ${limite}. A loja tem ${grupo.total} e a entrada cadastraria mais ${novos.length}.`,
          code: 'LIMITE_DO_PLANO', limit: limite, current: grupo.total, attempted: novos.length,
        });
      }
      compartilharNovos = grupo.compartilhar;
    }

    // 3. Fornecedor: o de sempre (id), novo pelo CNPJ/nome, ou nenhum.
    const forn = await achaOuCriaFornecedor(client, cid, req.body || {});
    if (forn.erro) { await client.query('ROLLBACK'); return res.status(forn.status).json({ error: forn.erro }); }
    const fornecedor = forn.fornecedor;

    // 3b. Produtos novos (B2b): estoque 0 e custo 0; a entrada logo abaixo
    //     dá o estoque, o custo médio e o fornecedor, como a qualquer outro.
    let categorias = null;
    if (novos.length) {
      const criados = await cadastrarNovos(client, cid, novos, compartilharNovos);
      for (const p of criados) produtos.set(p.id, p);
      categorias = await ligarCategorias(client, cid, criados);
    }

    // 4. Plano (sem banco) e gravação (um comando por tabela).
    const plano = planejarEntradaEmLote({ produtos, variantes, linhas });
    await gravarEntradaEmLote(client, { cid, plano, fornecedor, nota, receiptId: recibo.id });

    const quantidade = round(plano.porLinha.reduce((s, l) => s + l.quantity, 0), 3);
    const comCusto = plano.porLinha.filter((l) => l.unit_cost);
    const resultado = {
      receipt: {
        id: recibo.id, origin: origem, invoice_number: nota, nfe_key: chaveNfe, created_at: recibo.created_at,
      },
      supplier: fornecedor ? { id: fornecedor.id, name: fornecedor.name, created: !!forn.criado } : null,
      lines: plano.porLinha.map((l, i) => (linhas[i].novo ? { ...l, created: true } : l)),
      totals: {
        lines: plano.porLinha.length,
        products: plano.produtos.length,
        created_products: novos.length,
        quantity: quantidade,
        total_cost: comCusto.length ? round(comCusto.reduce((s, l) => s + l.quantity * l.unit_cost, 0), 2) : null,
      },
    };

    if (categorias && (categorias.pending.length || categorias.ambiguous.length)) {
      resultado.categorias = { pendentes: categorias.pending, ambiguos: categorias.ambiguous };
    }
    await client.query(
      `UPDATE stock_receipts SET supplier_id = $2, result = $3::jsonb WHERE id = $1`,
      [recibo.id, fornecedor ? fornecedor.id : null, JSON.stringify(resultado)]
    );
    await client.query('COMMIT');
    if (novos.length) avancarSemEsperar(cid, 'produto');
    console.log(`[stock-receipts] ${cid} ${linhas.length} linhas, ${plano.produtos.length} produtos em ${Date.now() - inicio} ms`);
    res.status(201).json(resultado);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (falhaDeSchema(err)) return res.status(503).json(SCHEMA_PENDENTE);
    console.error('[stock-receipts] post error:', err.message);
    res.status(500).json({ error: 'Erro ao dar entrada' });
  } finally {
    client.release();
  }
});

// Quantos produtos a loja tem e se o produto novo nasce compartilhado no
// grupo (mesma regra do POST /products: loja num grupo que não separou os
// produtos). Base sem share_products_in_group (42703): só o grupo conta.
async function estatisticasDaLoja(client, cid) {
  const sql = (comSeparacao) => `SELECT
      (SELECT COUNT(*)::int FROM products WHERE company_id = $1) AS total,
      EXISTS(
        SELECT 1 FROM companies c
         WHERE c.id = $1
           AND ((c.billing_owner_company_id IS NOT NULL AND c.billing_owner_company_id != c.id)
                OR EXISTS (SELECT 1 FROM companies sub WHERE sub.billing_owner_company_id = c.id AND sub.id != c.id))
      ) AS in_group${comSeparacao ? `,
      EXISTS(
        SELECT 1 FROM companies g
         WHERE COALESCE(NULLIF(g.billing_owner_company_id, g.id), g.id) = (
           SELECT COALESCE(NULLIF(billing_owner_company_id, id), id) FROM companies WHERE id = $1)
           AND g.share_products_in_group = false
      ) AS group_separated` : ''}`;
  await client.query('SAVEPOINT estatisticas');
  let r;
  try {
    ({ rows: [r] } = await client.query(sql(true), [cid]));
    await client.query('RELEASE SAVEPOINT estatisticas');
  } catch (e) {
    if (e.code !== '42703') throw e;
    await client.query('ROLLBACK TO SAVEPOINT estatisticas');
    ({ rows: [r] } = await client.query(sql(false), [cid]));
  }
  return { total: Number(r.total) || 0, compartilhar: r.in_group === true && r.group_separated !== true };
}

// Um INSERT só para todos os novos. O id nasce aqui para casar cada linha
// com o seu produto sem depender da ordem do RETURNING.
// products.ncm existe em produção mas não nasce de nenhuma migration do
// repo (o banco de CI não tem): sem a coluna (42703), cadastra sem o NCM,
// o mesmo degrau que o POST /products usa para as colunas novas.
async function cadastrarNovos(client, cid, novos, compartilhar) {
  for (const l of novos) l.product_id = crypto.randomUUID();
  const col = (k) => novos.map((l) => l.novo[k]);
  const inserir = (comNcm) => client.query(
    `INSERT INTO products (id, company_id, name, sku, barcode, category, price, cost_price, stock_qty, unit, is_group_shared${comNcm ? ', ncm' : ''})
     SELECT u.id, $1, u.name, u.sku, u.barcode, u.category, u.price, 0, 0, u.unit, $9${comNcm ? ', u.ncm' : ''}
       FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::text[], $10::text[])
            AS u(id, name, sku, barcode, category, price, unit, ncm)
     RETURNING id, company_id, name, category, stock_qty, cost_price, weighted_avg_cost, supplier_id`,
    [cid, novos.map((l) => l.product_id), col('name'), col('sku'), col('barcode'), col('category'),
      col('price'), col('unit'), compartilhar, col('ncm')]
  );
  await client.query('SAVEPOINT novos');
  try {
    const { rows } = await inserir(true);
    await client.query('RELEASE SAVEPOINT novos');
    return rows;
  } catch (e) {
    if (e.code !== '42703') throw e;
    await client.query('ROLLBACK TO SAVEPOINT novos');
    console.warn('[stock-receipts] produtos novos sem NCM: base sem products.ncm');
    const { rows } = await inserir(false);
    return rows;
  }
}

// Categoria na árvore, como o lote e a planilha. A função engole alguns
// erros do banco, o que deixaria a transação abortada: o savepoint isola
// (sem vínculo, o texto da categoria já está no produto e o wizard de
// categorias pega depois).
async function ligarCategorias(client, cid, criados) {
  await client.query('SAVEPOINT categorias');
  try {
    const out = await linkImportedCategories(client, cid, criados);
    await client.query('RELEASE SAVEPOINT categorias');
    return out;
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT categorias');
    console.warn('[stock-receipts] categorias dos novos ficaram de fora:', e.message);
    return null;
  }
}

// ─── GET /stock-receipts?nfe_key&invoice_number&supplier_id ──
// "Nota já lançada?" na loja da rota. Acha:
//   - entradas de vários itens (stock_receipts) pela chave da NF-e, ou pelo
//     número (sem zeros à esquerda) + fornecedor (sem fornecedor no pedido:
//     qualquer fornecedor);
//   - entradas antigas de um produto, que só guardam o texto 'NF <n>' em
//     stock_movements.notes (sem reference_id), juntadas por fornecedor e dia.
// A chave da NF-e só existe nas entradas novas.
router.get('/stock-receipts', async (req, res) => {
  const cid = req.params.id;
  const chaveNfe = req.query.nfe_key ? onlyDigits(String(req.query.nfe_key)) : '';
  const numero = notaParaComparar(lerNota(req.query.invoice_number));
  const sid = req.query.supplier_id ? String(req.query.supplier_id) : null;
  if (chaveNfe && chaveNfe.length !== 44) return res.status(400).json({ error: 'Chave da nota inválida: são 44 números' });
  if (!chaveNfe && !numero) return res.status(400).json({ error: 'Informe a chave ou o número da nota' });
  if (sid && !UUID.test(sid)) return res.json({ receipts: [], legacy: [] });

  try {
    let receipts = [];
    let indisponivel = false;
    try {
      const { rows } = await db.query(
        `SELECT r.id, r.created_at, r.invoice_number, r.nfe_key, r.origin, r.supplier_id, s.name AS supplier_name,
                COALESCE(jsonb_array_length(r.result->'lines'), 0) AS lines
           FROM stock_receipts r
           LEFT JOIN suppliers s ON s.id = r.supplier_id
          WHERE r.company_id = $1 AND r.result IS NOT NULL
            AND (
              ($2::text <> '' AND r.nfe_key = $2)
              OR ($3::text IS NOT NULL
                  AND regexp_replace(btrim(r.invoice_number), '^0+(?=.)', '') = $3
                  AND ($4::uuid IS NULL OR r.supplier_id = $4))
            )
          ORDER BY r.created_at DESC
          LIMIT 20`,
        [cid, chaveNfe, numero, sid]
      );
      receipts = rows;
    } catch (e) {
      if (!falhaDeSchema(e)) throw e;
      indisponivel = true;
    }

    let legacy = [];
    if (numero) {
      const { rows } = await db.query(
        `SELECT MIN(sm.created_at) AS created_at, sm.supplier_id, s.name AS supplier_name,
                COUNT(DISTINCT sm.product_id)::int AS products
           FROM stock_movements sm
           LEFT JOIN suppliers s ON s.id = sm.supplier_id
          WHERE sm.company_id = $1 AND sm.type = 'in' AND sm.reference_type = 'entrada'
            AND sm.reference_id IS NULL AND sm.notes LIKE 'NF %'
            AND regexp_replace(btrim(substr(sm.notes, 4)), '^0+(?=.)', '') = $2
            AND ($3::uuid IS NULL OR sm.supplier_id = $3)
          GROUP BY sm.supplier_id, s.name, date_trunc('day', sm.created_at)
          ORDER BY MIN(sm.created_at) DESC
          LIMIT 20`,
        [cid, numero, sid]
      );
      legacy = rows;
    }

    const corpo = { receipts, legacy };
    if (indisponivel) corpo.indisponivel = true;
    res.json(corpo);
  } catch (err) {
    console.error('[stock-receipts] get error:', err.message);
    res.status(500).json({ error: 'Erro ao procurar a nota' });
  }
});

module.exports = router;
module.exports._interno = { lerRecebimento, notaParaComparar, MAX_LINHAS };
