// ============================================================
// AURA. — Em qual loja o produto entra (B1, 20/11/2026)
//
// Plano aprovado pelo Caio em 20/11 (D1–D15). Rotas em
// src/routes/productsNasLojas.js.
//
// D1: duas ou mais lojas = UM PRODUTO POR LOJA, cada um privado
// (is_group_shared = false, nunca ligado por esta feature) e com o seu
// estoque, ligados pelo mesmo master_sku (o vinculo "mesmo produto em lojas
// diferentes" de productLinks.js — o consolidado soma por ele e a
// transferencia acha o par por ele).
//
// A copia do cadastro e a da transferencia (services/copiaDeCadastro.js):
// todas as colunas, fotos, fornecedores, categoria pelo nome, variantes.
//
// Regras por loja de destino (uma falha nao desfaz as outras — D15; cada
// loja roda num SAVEPOINT proprio):
//   - acesso (D11): mesmo grupo, loja ativa e a pessoa mexe no estoque dela
//     (podeMexer da transferencia), conferido de novo aqui;
//   - par ja existe (mesmo master_sku, ou vinculo de uma transferencia
//     anterior): 'ja_existia', sem duplicar nem somar estoque — repetir a
//     chamada e seguro;
//   - limite de produtos do plano da LOJA DE DESTINO, lido do banco
//     (companies.plan), nunca do token;
//   - D6: codigo de barras (do produto ou de uma variante) ou codigo interno
//     (sku) em outro produto visivel na loja de destino: erro so daquela loja,
//     com o produto que esta com o codigo;
//   - D7: NCM, CEST e origem vao iguais. tax_profile e icms_st_paid so com o
//     mesmo regime (companies.tax_regime); codigo municipal da NFS-e
//     (nfse_ctribmun) so no mesmo municipio. Sem copiar, a loja fica com o
//     padrao dela e o resultado avisa 'fiscal_conferir'. Nada bloqueia;
//   - estoque inicial com stock_movements de entrada ('in',
//     reference_type 'cadastro_em_outra_loja', reference_id = produto de
//     origem). Servico (unit 'srv') nao tem estoque. Produto com grade guarda
//     o estoque na variante (regra do Caixa); o pai nao recebe.
//
// CONCORRENCIA: o mesmo advisory lock por grupo da transferencia
// ('stock_transfer:<grupo>') — copia e transferencia nunca criam o par em
// dobro ao mesmo tempo — e FOR UPDATE no produto de origem.
// ============================================================
'use strict';

const { randomUUID } = require('crypto');
const { podeMexer } = require('./transferenciaDeEstoque');
const copia = require('./copiaDeCadastro');
const { ehBarcodeDuplicado } = require('./barcodeDuplicado');

const LIMITE_LOJAS = 20;
const QTD_MAX = 1e9;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCIA = 'cadastro_em_outra_loja';

class ErroDeLojas extends Error {
  constructor(status, code, error, extra = {}) {
    super(error);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
  get body() {
    return { error: this.message, code: this.code, ...this.extra };
  }
}

const arred3 = (n) => Math.round(Number(n) * 1000) / 1000;
const txt = (v) => (v === null || v === undefined ? '' : String(v).trim());
const low = (v) => String(v).toLowerCase();

// Mesmos numeros de getPlanLimit (routes/products.js). Sem limite = null.
function limiteDoPlano(plan) {
  switch (txt(plan).toLowerCase()) {
    case 'expansao':
    case 'personalizado': return null;
    case 'negocio': return 7000;
    default: return 2000;
  }
}

function lerPermissoes(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

const mexe = (loja) => podeMexer({
  isOwner: loja.is_owner, roleLabel: loja.role_label, permissions: lerPermissoes(loja.permissions),
});

// ─── grupo ───────────────────────────────────────────────────
// Todas as empresas do grupo de `companyId` (inclusive desativadas: a regra
// do estoque unico, como em products.js, olha o grupo inteiro), com o acesso
// do usuario a cada uma. Uma query. to_jsonb le colunas que podem faltar
// numa base atrasada (share_products_in_group, 355; address_city_code, so na
// producao) sem 42703.
async function lojasDoGrupo(conn, companyId, userId) {
  const { rows } = await conn.query(
    `SELECT c.id,
            COALESCE(NULLIF(c.billing_owner_company_id, c.id), c.id) AS grupo,
            COALESCE(c.trade_name, c.legal_name) AS nome,
            c.plan,
            c.tax_regime::text AS regime,
            to_jsonb(c) ->> 'address_city_code' AS municipio,
            to_jsonb(c) ->> 'share_products_in_group' AS compartilha,
            COALESCE(c.is_active, true) AS ativa,
            (c.owner_id = $2) AS is_owner,
            cm.role_label, cm.permissions
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id AND cm.user_id = $2
        AND cm.status = 'active' AND cm.is_active = true
      WHERE COALESCE(NULLIF(c.billing_owner_company_id, c.id), c.id) = (
              SELECT COALESCE(NULLIF(billing_owner_company_id, id), id) FROM companies WHERE id = $1
            )
      ORDER BY (c.id = $1) DESC, c.is_primary DESC NULLS LAST, c.created_at ASC, c.id`,
    [companyId, userId || null]
  );
  return rows.map((r) => ({ ...r, id: low(r.id), grupo: low(r.grupo) }));
}

// D12: grupo com 2+ empresas e nenhuma com share_products_in_group = false
// (a mesma conta do defaultShared do POST /products).
const estoqueUnico = (grupo) => grupo.length >= 2 && !grupo.some((g) => g.compartilha === 'false');

async function contarProdutos(conn, ids) {
  if (!ids.length) return new Map();
  const { rows } = await conn.query(
    `SELECT company_id, COUNT(*)::int AS total FROM products WHERE company_id = ANY($1::uuid[]) GROUP BY company_id`,
    [ids]
  );
  return new Map(rows.map((r) => [low(r.company_id), Number(r.total) || 0]));
}

// ─── GET lojas-para-cadastro ─────────────────────────────────
async function lojasParaCadastro(conn, { companyId, userId, isStaff = false }) {
  const cid = low(companyId);
  const grupo = await lojasDoGrupo(conn, cid, userId);
  const visiveis = grupo.filter((g) => g.ativa && (isStaff || mexe(g)));
  const usados = await contarProdutos(conn, visiveis.map((g) => g.id));
  return {
    estoque_unico: estoqueUnico(grupo),
    lojas: visiveis.map((g) => ({
      company_id: g.id,
      nome: g.nome,
      ativa: g.id === cid,
      regime: g.regime || null,
      limite: { usados: usados.get(g.id) || 0, maximo: limiteDoPlano(g.plan) },
    })),
  };
}

// ─── leitura do corpo do POST ────────────────────────────────
function lerQuantidade(v, onde) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > QTD_MAX) {
    throw new ErroDeLojas(400, 'QUANTIDADE_INVALIDA', 'A quantidade de cada loja precisa ser zero ou mais.', { onde });
  }
  return arred3(n);
}

function lerPedidoDeLojas(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!Array.isArray(b.lojas) || b.lojas.length === 0) {
    throw new ErroDeLojas(400, 'LOJAS_INVALIDAS', 'Escolha pelo menos uma loja.');
  }
  if (b.lojas.length > LIMITE_LOJAS) {
    throw new ErroDeLojas(400, 'LOJAS_INVALIDAS', `Escolha no máximo ${LIMITE_LOJAS} lojas.`, { limite: LIMITE_LOJAS });
  }
  const vistas = new Set();
  return b.lojas.map((l, i) => {
    const x = l && typeof l === 'object' ? l : {};
    const companyId = txt(x.company_id);
    if (!UUID.test(companyId)) throw new ErroDeLojas(400, 'LOJAS_INVALIDAS', 'Escolha a loja.', { indice: i });
    const id = low(companyId);
    if (vistas.has(id)) throw new ErroDeLojas(400, 'LOJAS_INVALIDAS', 'A mesma loja veio duas vezes.', { company_id: id });
    vistas.add(id);
    const variantes = new Map();
    if (x.variantes !== undefined && x.variantes !== null) {
      if (!Array.isArray(x.variantes)) throw new ErroDeLojas(400, 'VARIANTE_INVALIDA', 'As quantidades da grade vieram num formato inválido.');
      for (const v of x.variantes) {
        const vid = txt(v && v.variant_id);
        if (!UUID.test(vid)) throw new ErroDeLojas(400, 'VARIANTE_INVALIDA', 'Uma cor ou tamanho não foi encontrado neste produto.', { variant_id: (v && v.variant_id) ?? null });
        const k = low(vid);
        variantes.set(k, arred3((variantes.get(k) || 0) + lerQuantidade(v.stock_qty, { company_id: id, variant_id: k })));
      }
    }
    return { company_id: id, stock_qty: lerQuantidade(x.stock_qty, { company_id: id }), variantes };
  });
}

// ─── D6: codigo em outro produto da loja de destino ──────────
// Produto proprio do destino (ativo ou arquivado: o UNIQUE (company_id,
// barcode) inclui o arquivado) ou compartilhado de outra loja do grupo, que
// o Caixa do destino tambem bipa. Variante: so a ativa de produto ativo.
// Uma query para o lote inteiro: codigo -> produto que esta com ele.
async function donosDosCodigos(conn, { destinoId, codigos, excluir }) {
  if (!codigos.length) return new Map();
  const doGrupo = `p.company_id IN (
                   SELECT id FROM companies WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
                     SELECT COALESCE(NULLIF(billing_owner_company_id, id), id) FROM companies WHERE id = $1))`;
  const { rows } = await conn.query(
    `SELECT id, name, is_active, codigo FROM (
       SELECT p.id, p.name, p.is_active, btrim(p.barcode) AS codigo, 0 AS ordem
         FROM products p
        WHERE btrim(p.barcode) = ANY($2::text[]) AND p.id <> ALL($3::uuid[])
          AND (p.company_id = $1 OR (p.is_group_shared = true AND p.is_active = true AND ${doGrupo}))
       UNION ALL
       SELECT p.id, p.name, p.is_active, btrim(v.barcode), 1
         FROM product_variants v JOIN products p ON p.id = v.product_id
        WHERE btrim(v.barcode) = ANY($2::text[]) AND v.is_active = true AND p.is_active = true AND p.id <> ALL($3::uuid[])
          AND (p.company_id = $1 OR (p.is_group_shared = true AND ${doGrupo}))
     ) c
     ORDER BY codigo, is_active DESC, ordem`,
    [destinoId, codigos, excluir]
  );
  const out = new Map();
  for (const r of rows) if (!out.has(r.codigo)) out.set(r.codigo, r);
  return out;
}

async function donosDosSkus(conn, { destinoId, skus, excluir }) {
  if (!skus.length) return new Map();
  const { rows } = await conn.query(
    `SELECT DISTINCT ON (btrim(sku)) id, name, btrim(sku) AS chave
       FROM products
      WHERE company_id = $1 AND is_active = true AND btrim(sku) = ANY($2::text[]) AND id <> ALL($3::uuid[])
      ORDER BY btrim(sku), created_at ASC`,
    [destinoId, skus, excluir]
  );
  return new Map(rows.map((r) => [r.chave, r]));
}

function erroDeCodigo(dono) {
  const message = dono.is_active === false
    ? `O código ${dono.codigo} pertence ao produto "${dono.name}", que foi excluído desta loja mas ficou guardado por causa do histórico de vendas.`
    : `O código ${dono.codigo} já está no produto "${dono.name}" desta loja.`;
  return {
    code: 'BARCODE_EM_USO', message,
    produto_conflito: { id: dono.id, name: dono.name, ...(dono.is_active === false ? { arquivado: true } : {}) },
  };
}

function erroDeSku(sku, dono) {
  return {
    code: 'CODIGO_EM_USO',
    message: `O código interno ${sku} já está no produto "${dono.name}" desta loja.`,
    produto_conflito: { id: dono.id, name: dono.name },
  };
}

// Estoque atual dos pares (soma das variantes ativas quando ha grade).
async function estoqueDosProdutos(conn, ids) {
  if (!ids.length) return new Map();
  const { rows } = await conn.query(
    `SELECT p.id, p.stock_qty,
            (SELECT SUM(v.stock_qty) FROM product_variants v WHERE v.product_id = p.id AND v.is_active = true) AS grade,
            EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.is_active = true) AS tem_grade
       FROM products p WHERE p.id = ANY($1::uuid[])`,
    [ids]
  );
  return new Map(rows.map((r) => [low(r.id), arred3(r.tem_grade ? Number(r.grade) || 0 : Number(r.stock_qty) || 0)]));
}

function gerarMasterSku() {
  return `AURA-${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
}

const tem = (obj, c) => Object.prototype.hasOwnProperty.call(obj, c);

// ─── o nucleo: N produtos da origem em M lojas ──────────────
/**
 * Roda DENTRO de uma transacao aberta pelo chamador (BEGIN ... COMMIT).
 * Lanca ErroDeLojas (4xx) sem ter escrito nada. Falha de uma loja vira
 * resultado 'erro' daquela loja (SAVEPOINT por loja), as outras seguem.
 *
 * itens: [{ product_id, lojas: [{ company_id, stock_qty, variantes: Map(vid -> qtd) }] }]
 * opcoes:
 *   estrito      — um produto so (rota POST :pid/lojas): produto que nao e da
 *                  origem e 404, compartilhado e 409. Sem ele, viram erro do item.
 *   notas        — texto do stock_movements de entrada.
 *   loteDaLoja   — (companyId) => import_batch_id para as copias daquela loja
 *                  (importacao por planilha: o "desfazer" continua por loja).
 *   soCadastro   — copia sem fornecedor e sem custo (Chegou mercadoria: o
 *                  custo e o fornecedor ficam na loja da entrada).
 *
 * Numero de queries fixo por loja de destino, nao por produto.
 * Devolve Map(product_id -> { master_sku, resultados: [...] }).
 */
async function levarLote(conn, { origemId, userId, isStaff = false, itens, opcoes = {} }) {
  origemId = low(origemId);
  const pids = [...new Set(itens.map((i) => low(i.product_id)))];
  const grupo = await lojasDoGrupo(conn, origemId, userId);
  const origem = grupo.find((g) => g.id === origemId);
  if (!origem) throw new ErroDeLojas(404, 'PRODUTO_NAO_ENCONTRADO', 'Produto não encontrado.');
  if (!isStaff && !mexe(origem)) {
    throw new ErroDeLojas(403, 'SEM_ACESSO', 'Você não tem acesso ao estoque desta loja.');
  }

  await conn.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`stock_transfer:${origem.grupo}`]);

  const { rows: prodRows } = await conn.query(
    `SELECT * FROM products WHERE id = ANY($1::uuid[]) AND company_id = $2 ORDER BY id FOR UPDATE`,
    [pids, origemId]
  );
  const prodPorId = new Map(prodRows.map((p) => [low(p.id), p]));
  const fora = new Map(); // pid -> erro do item inteiro
  for (const pid of pids) {
    const p = prodPorId.get(pid);
    if (!p || p.is_active === false) {
      if (opcoes.estrito) throw new ErroDeLojas(404, 'PRODUTO_NAO_ENCONTRADO', 'Produto não encontrado.');
      fora.set(pid, { code: 'PRODUTO_NAO_ENCONTRADO', message: 'Produto não encontrado.' });
    } else if (p.is_group_shared === true) {
      // Compartilhado ja aparece em todas as lojas do grupo: uma copia privada
      // faria o Caixa da outra loja achar dois produtos com o mesmo codigo.
      if (opcoes.estrito) throw new ErroDeLojas(409, 'PRODUTO_COMPARTILHADO', 'Este produto já aparece em todas as lojas do grupo.');
      fora.set(pid, { code: 'PRODUTO_COMPARTILHADO', message: 'Este produto já aparece em todas as lojas do grupo.' });
    }
  }
  const validos = pids.filter((pid) => !fora.has(pid));

  const { rows: varRows } = validos.length ? await conn.query(
    `SELECT id, product_id, barcode FROM product_variants
      WHERE product_id = ANY($1::uuid[]) AND is_active = true
      ORDER BY product_id, created_at ASC, id`,
    [validos]
  ) : { rows: [] };
  const gradeDe = new Map(validos.map((pid) => [pid, []]));
  for (const v of varRows) gradeDe.get(low(v.product_id)).push({ id: low(v.id), barcode: txt(v.barcode) });
  for (const it of itens) {
    const grade = gradeDe.get(low(it.product_id));
    if (!grade) continue;
    const ids = new Set(grade.map((v) => v.id));
    for (const l of it.lojas) {
      for (const vid of l.variantes.keys()) {
        if (!ids.has(vid)) {
          throw new ErroDeLojas(400, 'VARIANTE_INVALIDA', 'Uma cor ou tamanho não foi encontrado neste produto.', { variant_id: vid });
        }
      }
    }
  }

  // master_sku: o vinculo. Produto sem ele ganha um agora (a copia o leva).
  const masterDe = new Map();
  const semMaster = [], novosMaster = [];
  for (const pid of validos) {
    const atual = txt(prodPorId.get(pid).master_sku);
    if (atual) { masterDe.set(pid, atual); continue; }
    const m = gerarMasterSku();
    masterDe.set(pid, m); semMaster.push(pid); novosMaster.push(m);
  }
  if (semMaster.length === 1) {
    await conn.query(`UPDATE products SET master_sku = $2, updated_at = NOW() WHERE id = $1`, [semMaster[0], novosMaster[0]]);
  } else if (semMaster.length) {
    await conn.query(
      `UPDATE products p SET master_sku = u.m, updated_at = NOW()
         FROM unnest($1::uuid[], $2::text[]) AS u(id, m)
        WHERE p.id = u.id`,
      [semMaster, novosMaster]
    );
  }

  const porId = new Map(grupo.map((g) => [g.id, g]));
  const ordemDasLojas = [];
  for (const it of itens) for (const l of it.lojas) if (!ordemDasLojas.includes(l.company_id)) ordemDasLojas.push(l.company_id);
  const destinos = ordemDasLojas.filter((id) => id !== origemId && porId.has(id));

  // Par por vinculo de transferencia (nos dois sentidos) e por master_sku.
  const parDe = new Map(); // `${loja}|${pid}` -> { id, master_sku }
  if (destinos.length && validos.length) {
    const vinculos = await copia.opcional(conn, 'sp_vinculos', () => conn.query(
      `SELECT * FROM (
         SELECT t.destino_company_id AS loja, i.product_id AS o_pid, i.destino_product_id AS d_pid, t.criada_em
           FROM stock_transfer_items i JOIN stock_transfers t ON t.id = i.transfer_id
          WHERE t.origem_company_id = $1 AND i.product_id = ANY($2::uuid[]) AND t.destino_company_id = ANY($3::uuid[])
         UNION ALL
         SELECT t.origem_company_id, i.destino_product_id, i.product_id, t.criada_em
           FROM stock_transfer_items i JOIN stock_transfers t ON t.id = i.transfer_id
          WHERE t.destino_company_id = $1 AND i.destino_product_id = ANY($2::uuid[]) AND t.origem_company_id = ANY($3::uuid[])
       ) v WHERE v.d_pid IS NOT NULL ORDER BY v.criada_em DESC`,
      [origemId, validos, destinos]
    ));
    const linhasDeVinculo = vinculos ? vinculos.rows : [];
    const { rows: pares } = await conn.query(
      `SELECT id, company_id, btrim(master_sku) AS master_sku FROM products
        WHERE company_id = ANY($1::uuid[]) AND is_active = true
          AND (btrim(master_sku) = ANY($2::text[]) OR id = ANY($3::uuid[]))
        ORDER BY created_at ASC`,
      [destinos, [...new Set(masterDe.values())], linhasDeVinculo.map((v) => v.d_pid)]
    );
    const porMaster = new Map();
    for (const r of pares) {
      const k = `${low(r.company_id)}|${r.master_sku}`;
      if (r.master_sku && !porMaster.has(k)) porMaster.set(k, { id: low(r.id), master_sku: r.master_sku });
    }
    for (const pid of validos) {
      for (const loja of destinos) {
        const achado = porMaster.get(`${loja}|${masterDe.get(pid)}`);
        if (achado) parDe.set(`${loja}|${pid}`, achado);
      }
    }
    const ativos = new Map(pares.map((r) => [low(r.id), r]));
    for (const v of linhasDeVinculo) {
      const k = `${low(v.loja)}|${low(v.o_pid)}`;
      const r = ativos.get(low(v.d_pid));
      if (parDe.has(k) || !r || low(r.company_id) !== low(v.loja)) continue;
      parDe.set(k, { id: low(r.id), master_sku: r.master_sku || '' });
    }
  }
  const usados = await contarProdutos(conn, destinos);
  const cols = await copia.colunasCopiaveis(conn);
  const notas = opcoes.notas || `Estoque inicial do cadastro (cópia da ${origem.nome || 'outra loja'})`;

  // resultado de cada (produto, loja), na ordem do pedido
  const saida = new Map();
  const res = (pid, companyId) => saida.get(pid).get(companyId);
  for (const it of itens) {
    const pid = low(it.product_id);
    if (!saida.has(pid)) saida.set(pid, new Map());
    for (const l of it.lojas) {
      const destino = porId.get(l.company_id);
      saida.get(pid).set(l.company_id, {
        company_id: l.company_id, nome: destino ? destino.nome : null,
        status: 'erro', product_id: null, stock_qty: 0, avisos: [], erro: null,
      });
    }
  }
  const falhar = (r, e) => { r.status = 'erro'; r.product_id = null; r.stock_qty = 0; r.avisos = []; r.erro = e; };

  for (const lojaId of ordemDasLojas) {
    const destino = porId.get(lojaId);
    const pedidos = []; // { pid, l }
    for (const it of itens) for (const l of it.lojas) if (l.company_id === lojaId) pedidos.push({ pid: low(it.product_id), l });

    const pendentes = [];
    for (const pd of pedidos) {
      const r = res(pd.pid, lojaId);
      if (fora.has(pd.pid)) { falhar(r, fora.get(pd.pid)); continue; }
      if (lojaId === origemId) { falhar(r, { code: 'MESMA_LOJA', message: 'O produto já é desta loja.' }); continue; }
      if (!destino || !destino.ativa || (!isStaff && !mexe(destino))) {
        falhar(r, { code: 'SEM_ACESSO', message: 'Esta loja não está no seu grupo ou você não tem acesso ao estoque dela.' });
        continue;
      }
      pendentes.push(pd);
    }
    if (!pendentes.length) continue;

    // par ja existe: nao duplica nem soma estoque
    const jaExistem = pendentes.filter((pd) => parDe.has(`${lojaId}|${pd.pid}`));
    if (jaExistem.length) {
      const semVinculo = jaExistem.filter((pd) => !parDe.get(`${lojaId}|${pd.pid}`).master_sku);
      if (semVinculo.length) {
        // Copia antiga de uma transferencia, sem o vinculo: passa a ter.
        await copia.opcional(conn, 'sp_vinculo_par', () => conn.query(
          `UPDATE products p SET master_sku = u.m, updated_at = NOW()
             FROM unnest($1::uuid[], $2::text[]) AS u(id, m)
            WHERE p.id = u.id AND p.master_sku IS NULL`,
          [semVinculo.map((pd) => parDe.get(`${lojaId}|${pd.pid}`).id), semVinculo.map((pd) => masterDe.get(pd.pid))]
        ), { toleraDuplicado: true });
      }
      const estoques = await estoqueDosProdutos(conn, jaExistem.map((pd) => parDe.get(`${lojaId}|${pd.pid}`).id));
      for (const pd of jaExistem) {
        const par = parDe.get(`${lojaId}|${pd.pid}`);
        Object.assign(res(pd.pid, lojaId), { status: 'ja_existia', product_id: par.id, stock_qty: estoques.get(par.id) || 0 });
      }
    }
    let aCriar = pendentes.filter((pd) => !parDe.has(`${lojaId}|${pd.pid}`));
    if (!aCriar.length) continue;

    // D10: limite do plano da loja de destino, lido do banco
    const maximo = limiteDoPlano(destino.plan);
    const atual = usados.get(lojaId) || 0;
    if (maximo !== null && atual + aCriar.length > maximo) {
      const e = {
        code: 'LIMITE_PLANO',
        message: `Esta loja chegou ao limite de ${maximo.toLocaleString('pt-BR')} produtos do plano.`,
        limite: maximo, usados: atual,
      };
      for (const pd of aCriar) falhar(res(pd.pid, lojaId), e);
      continue;
    }

    // D6: codigo de barras e codigo interno
    const excluir = validos;
    const codigos = [...new Set(aCriar.flatMap((pd) => [txt(prodPorId.get(pd.pid).barcode), ...gradeDe.get(pd.pid).map((v) => v.barcode)]).filter(Boolean))];
    const skus = [...new Set(aCriar.map((pd) => txt(prodPorId.get(pd.pid).sku)).filter(Boolean))];
    const donos = await donosDosCodigos(conn, { destinoId: lojaId, codigos, excluir });
    const donosSku = await donosDosSkus(conn, { destinoId: lojaId, skus, excluir });
    aCriar = aCriar.filter((pd) => {
      const p = prodPorId.get(pd.pid);
      const meus = [txt(p.barcode), ...gradeDe.get(pd.pid).map((v) => v.barcode)].filter(Boolean);
      const dono = meus.map((c) => donos.get(c)).find(Boolean);
      if (dono) { falhar(res(pd.pid, lojaId), erroDeCodigo(dono)); return false; }
      const sku = txt(p.sku);
      if (sku && donosSku.has(sku)) { falhar(res(pd.pid, lojaId), erroDeSku(sku, donosSku.get(sku))); return false; }
      return true;
    });
    if (!aCriar.length) continue;

    await conn.query('SAVEPOINT sp_loja');
    try {
      const novoDe = new Map(aCriar.map((pd) => [pd.pid, randomUUID()]));
      const orig = aCriar.map((pd) => pd.pid);
      const novo = orig.map((pid) => novoDe.get(pid));
      await copia.copiarProdutos(conn, {
        destinoId: lojaId, orig, novo,
        barcode: orig.map((pid) => (txt(prodPorId.get(pid).barcode) ? prodPorId.get(pid).barcode : null)),
        cols,
      });
      const varNova = new Map(); // vid origem -> vid destino
      const vOrig = [], vNovo = [], vPid = [];
      for (const pid of orig) {
        for (const v of gradeDe.get(pid)) {
          const id = randomUUID();
          varNova.set(v.id, id);
          vOrig.push(v.id); vNovo.push(id); vPid.push(novoDe.get(pid));
        }
      }
      if (vOrig.length) await copia.copiarVariantes(conn, { cols, orig: vOrig, novo: vNovo, pid: vPid });

      // D7 — fiscal: so com o mesmo regime / o mesmo municipio
      const mesmoRegime = !!(origem.regime && destino.regime && origem.regime === destino.regime);
      const mesmoMunicipio = !!(txt(origem.municipio) && txt(destino.municipio) && txt(origem.municipio) === txt(destino.municipio));
      const limpar = [];
      if (!mesmoRegime) limpar.push('tax_profile', 'icms_st_paid');
      if (!mesmoMunicipio) limpar.push('nfse_ctribmun');
      for (const c of limpar) {
        const alvo = orig.filter((pid) => {
          const p = prodPorId.get(pid);
          return tem(p, c) && p[c] !== null && txt(p[c]) !== '';
        });
        if (!alvo.length) continue;
        await conn.query(`UPDATE products SET "${c}" = NULL WHERE id = ANY($1::uuid[])`, [alvo.map((pid) => novoDe.get(pid))]);
        for (const pid of alvo) {
          const r = res(pid, lojaId);
          if (!r.avisos.includes('fiscal_conferir')) r.avisos.push('fiscal_conferir');
        }
      }

      if (opcoes.soCadastro) {
        // Chegou mercadoria: o custo e o fornecedor ficam na loja da entrada.
        await copia.opcional(conn, 'sp_so_cadastro_forn', () => conn.query(
          `DELETE FROM product_suppliers WHERE product_id = ANY($1::uuid[])`, [novo]));
        const sets = ['cost_price = 0'];
        for (const c of ['supplier_id', 'supplier_name', 'supplier_cnpj', 'weighted_avg_cost', 'last_purchase_unit_cost', 'last_purchase_at']) {
          if (tem(prodPorId.get(orig[0]), c)) sets.push(`"${c}" = NULL`);
        }
        await conn.query(`UPDATE products SET ${sets.join(', ')} WHERE id = ANY($1::uuid[])`, [novo]);
      }

      const lote = typeof opcoes.loteDaLoja === 'function' ? opcoes.loteDaLoja(lojaId) : null;
      if (lote) {
        await conn.query(`UPDATE products SET import_batch_id = $2 WHERE id = ANY($1::uuid[])`, [novo, lote]);
      }

      // Estoque inicial + movimentos de entrada
      const pUpd = [], pQtd = [], vUpd = [], vQtd = [];
      const movP = [], movV = [], movQ = [];
      const totalDe = new Map();
      for (const pd of aCriar) {
        const p = prodPorId.get(pd.pid);
        const novoId = novoDe.get(pd.pid);
        let total = 0;
        if (txt(p.unit).toLowerCase() === 'srv') {
          // servico nao tem estoque
        } else if (gradeDe.get(pd.pid).length) {
          for (const [vid, qtd] of pd.l.variantes) {
            if (!(qtd > 0)) continue;
            vUpd.push(varNova.get(vid)); vQtd.push(qtd);
            movP.push(novoId); movV.push(varNova.get(vid)); movQ.push(qtd);
            total = arred3(total + qtd);
          }
        } else if (pd.l.stock_qty > 0) {
          pUpd.push(novoId); pQtd.push(pd.l.stock_qty);
          movP.push(novoId); movV.push(null); movQ.push(pd.l.stock_qty);
          total = pd.l.stock_qty;
        }
        totalDe.set(pd.pid, total);
      }
      if (pUpd.length === 1) {
        await conn.query(
          `UPDATE products SET stock_qty = $2, updated_at = NOW() WHERE id = $1 AND company_id = $3`,
          [pUpd[0], pQtd[0], lojaId]
        );
      } else if (pUpd.length) {
        await conn.query(
          `UPDATE products t SET stock_qty = u.q, updated_at = NOW()
             FROM unnest($1::uuid[], $2::numeric[]) AS u(id, q)
            WHERE t.id = u.id AND t.company_id = $3`,
          [pUpd, pQtd, lojaId]
        );
      }
      if (vUpd.length) {
        await conn.query(
          `UPDATE product_variants t SET stock_qty = u.q, updated_at = NOW()
             FROM unnest($1::uuid[], $2::numeric[]) AS u(id, q)
            WHERE t.id = u.id`,
          [vUpd, vQtd]
        );
      }
      if (movP.length) {
        // reference_id: o produto de origem de cada linha
        const origemDoNovo = new Map(aCriar.map((pd) => [novoDe.get(pd.pid), pd.pid]));
        await conn.query(
          `INSERT INTO stock_movements (product_id, company_id, type, quantity, variant_id, notes, reference_id, reference_type)
           SELECT m.p, $1, 'in', m.q, m.v, $5, m.o, '${REFERENCIA}'
             FROM unnest($2::uuid[], $3::uuid[], $4::numeric[], $6::uuid[]) AS m(p, v, q, o)`,
          [lojaId, movP, movV, movQ, notas, movP.map((p) => origemDoNovo.get(p))]
        );
      }
      await conn.query('RELEASE SAVEPOINT sp_loja');
      usados.set(lojaId, atual + aCriar.length);
      for (const pd of aCriar) {
        Object.assign(res(pd.pid, lojaId), { status: 'criado', product_id: novoDe.get(pd.pid), stock_qty: totalDe.get(pd.pid) || 0 });
      }
    } catch (e) {
      await conn.query('ROLLBACK TO SAVEPOINT sp_loja');
      await conn.query('RELEASE SAVEPOINT sp_loja');
      const erro = ehBarcodeDuplicado(e)
        ? { code: 'BARCODE_EM_USO', message: 'O código de barras já está em outro produto desta loja.' }
        : { code: 'ERRO_AO_CRIAR', message: 'Não deu para criar o produto nesta loja. Tente de novo.' };
      if (!ehBarcodeDuplicado(e)) console.error('[produtoNasLojas] copia para', lojaId, 'falhou:', e && e.message, e && e.code);
      for (const pd of aCriar) falhar(res(pd.pid, lojaId), erro);
    }
  }

  const out = new Map();
  for (const [pid, lojas] of saida) {
    out.set(pid, {
      master_sku: masterDe.get(pid) || null,
      resultados: [...lojas.values()].map((r) => {
        const { erro, ...resto } = r;
        return r.status === 'erro' ? { ...resto, erro } : resto;
      }),
    });
  }
  return out;
}

// ─── POST /:pid/lojas ────────────────────────────────────────
async function levarParaLojas(conn, { origemId, productId, userId, isStaff = false, lojas }) {
  const pid = low(productId);
  if (!UUID.test(pid)) throw new ErroDeLojas(404, 'PRODUTO_NAO_ENCONTRADO', 'Produto não encontrado.');
  const out = await levarLote(conn, {
    origemId, userId, isStaff, itens: [{ product_id: pid, lojas }], opcoes: { estrito: true },
  });
  return out.get(pid);
}

module.exports = {
  LIMITE_LOJAS,
  REFERENCIA,
  ErroDeLojas,
  limiteDoPlano,
  lojasDoGrupo,
  estoqueUnico,
  lojasParaCadastro,
  lerPedidoDeLojas,
  levarLote,
  levarParaLojas,
};
