// ============================================================
// AURA. — Transferencia de estoque entre lojas do grupo (10/11/2026)
//
// Migration 444. Rota: src/routes/estoqueTransferencias.js.
//
// Loja do grupo (mesmo billing_owner_company_id) manda pecas para outra
// loja do grupo; cada loja tem o seu estoque. Tudo numa transacao so:
// baixa na origem, entrada no destino, stock_movements nas duas ('out' na
// origem, 'in' no destino, quantidade sempre positiva — a convencao da
// tabela), reference_type = 'stock_transfer', reference_id = transferencia.
//
// ESTOQUE POR VARIANTE (mesma regra do Caixa, pdv.js): produto com variante
// ativa guarda o estoque NA VARIANTE e transfere por variant_id; o
// products.stock_qty do pai nao e tocado (o app mostra a soma das variantes
// ativas — variants_stock_total em products.js). Produto sem variante
// transfere pelo products.stock_qty.
//
// PRODUTO NO DESTINO, nesta ordem:
//   1. vinculo de uma transferencia anterior (stock_transfer_items), nos
//      dois sentidos: A->B grava (P -> P'); B->A de P' volta para P;
//   2. codigo de barras igual;
//   3. SKU igual;
//   4. master_sku igual (o vinculo "mesmo produto em CNPJs diferentes" de
//      productLinks.js — e unico por loja, entao a copia nao pode repeti-lo);
//   5. nada: COPIA do cadastro (todas as colunas de products menos estoque,
//      empresa, promocao e importacao), estoque 0, is_group_shared = false;
//      fotos (product_images), fornecedores (product_suppliers) e
//      categorias (criadas no destino pelo nome, com a mesma arvore) vao
//      junto. Depois soma a quantidade transferida.
// VARIANTE no produto do destino: vinculo anterior, codigo de barras,
// sku_suffix, mesmos atributos (product_variant_values: Cor, Tamanho...)
// e, sem nenhum, cria a variante (com os atributos) no produto do destino.
//
// CONCORRENCIA: advisory lock por grupo (transferencias do mesmo grupo
// andam em fila: numero sequencial sem buraco e sem copia em dobro) e
// FOR UPDATE nas linhas de estoque da origem antes de conferir o saldo —
// a venda do Caixa faz UPDATE na mesma linha, entao uma espera a outra e
// nada e vendido duas vezes.
//
// LOTE: ate 1.000 itens por chamada, numero fixo de queries (arrays +
// unnest), nao uma por item.
// ============================================================
'use strict';

const { randomUUID } = require('crypto');
const { lerComClientes, comClientesDaVariante } = require('./comClientes');
const { nomeDaCorDaVariante, nomeGravadoQueAparece } = require('./nomeDaCor');
// 20/11/2026: a copia do cadastro (colunas, fotos, fornecedores, categorias,
// variantes) e de services/copiaDeCadastro.js, usada tambem pelo cadastro do
// mesmo produto em outras lojas (services/produtoNasLojas.js).
const {
  colunasCopiaveis, _limparCacheDeColunas, copiarProdutos, copiarVariantes,
} = require('./copiaDeCadastro');

const LIMITE_ITENS = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QTD_MAX = 1e9;

class ErroDeTransferencia extends Error {
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
const norm = (v) => txt(v).toLowerCase();

// ─── leitura do corpo ────────────────────────────────────────
function lerPedido(body) {
  const b = body && typeof body === 'object' ? body : {};
  const destino = txt(b.destino_company_id);
  if (!UUID.test(destino)) {
    throw new ErroDeTransferencia(400, 'NAO_E_DO_GRUPO', 'Escolha a loja de destino.');
  }
  if (!Array.isArray(b.itens) || b.itens.length === 0) {
    throw new ErroDeTransferencia(400, 'QUANTIDADE_INVALIDA', 'Escolha pelo menos um item para transferir.');
  }
  if (b.itens.length > LIMITE_ITENS) {
    throw new ErroDeTransferencia(400, 'QUANTIDADE_INVALIDA',
      `Envie no máximo ${LIMITE_ITENS.toLocaleString('pt-BR')} itens por transferência.`, { limite: LIMITE_ITENS });
  }

  const porChave = new Map();
  const invalidos = [];
  const naoAchados = [];
  b.itens.forEach((it, idx) => {
    const i = it && typeof it === 'object' ? it : {};
    const pid = txt(i.product_id);
    const vidBruto = i.variant_id === undefined || i.variant_id === null || i.variant_id === '' ? null : txt(i.variant_id);
    if (!UUID.test(pid) || (vidBruto !== null && !UUID.test(vidBruto))) {
      naoAchados.push({ indice: idx, product_id: i.product_id ?? null, variant_id: i.variant_id ?? null });
      return;
    }
    const q = Number(i.quantidade);
    if (!Number.isFinite(q) || q <= 0 || q > QTD_MAX || arred3(q) <= 0) {
      invalidos.push({ indice: idx, product_id: pid, variant_id: vidBruto, quantidade: i.quantidade ?? null });
      return;
    }
    const chave = `${pid.toLowerCase()}|${vidBruto ? vidBruto.toLowerCase() : ''}`;
    const atual = porChave.get(chave);
    if (atual) atual.quantidade = arred3(atual.quantidade + q);
    else porChave.set(chave, { product_id: pid.toLowerCase(), variant_id: vidBruto ? vidBruto.toLowerCase() : null, quantidade: arred3(q) });
  });
  if (invalidos.length) {
    throw new ErroDeTransferencia(400, 'QUANTIDADE_INVALIDA', 'A quantidade de cada item precisa ser maior que zero.', { itens: invalidos });
  }
  if (naoAchados.length) {
    throw new ErroDeTransferencia(404, 'ITEM_NAO_ENCONTRADO', 'Alguns itens não foram encontrados.', { itens: naoAchados });
  }

  let observacao = b.observacao === undefined || b.observacao === null ? null : txt(b.observacao).slice(0, 500);
  if (observacao === '') observacao = null;

  return { destino: destino.toLowerCase(), itens: [...porChave.values()], observacao };
}

// ─── acesso ──────────────────────────────────────────────────
// Mesmo desenho do ajuste/entrada de estoque: dono, papel admin ou membro
// que mexe no estoque. Fica de fora quem e "estoque so consulta"
// (estoqueSoConsulta.js) e quem tem a chave estoque desligada.
function podeMexer({ isOwner, roleLabel, permissions }) {
  if (isOwner === true || roleLabel === 'owner' || roleLabel === 'admin') return true;
  if (!roleLabel) return false; // nao e membro ativo
  if (!permissions) return true;
  if (permissions.estoque_consulta === true) return false;
  if (permissions.estoque === false) return false;
  return true;
}

function lerPermissoes(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// Lojas, grupo e acesso do usuario as duas. Uma query.
async function conferirLojas(conn, { origemId, destinoId, userId, isStaff }) {
  if (origemId === destinoId) {
    throw new ErroDeTransferencia(400, 'MESMA_LOJA', 'A loja de destino precisa ser outra loja.');
  }
  const { rows } = await conn.query(
    `SELECT c.id,
            COALESCE(NULLIF(c.billing_owner_company_id, c.id), c.id) AS grupo,
            COALESCE(c.trade_name, c.legal_name) AS nome,
            COALESCE(c.is_active, true) AS ativa,
            (c.owner_id = $2) AS is_owner,
            cm.role_label, cm.permissions
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id AND cm.user_id = $2
        AND cm.status = 'active' AND cm.is_active = true
      WHERE c.id = ANY($1::uuid[])`,
    [[origemId, destinoId], userId]
  );
  const origem = rows.find((r) => String(r.id).toLowerCase() === origemId);
  const destino = rows.find((r) => String(r.id).toLowerCase() === destinoId);
  const recusa = () => new ErroDeTransferencia(403, 'NAO_E_DO_GRUPO',
    'A loja de destino precisa ser do mesmo grupo e você precisa ter acesso ao estoque das duas.');
  if (!origem || !destino || !destino.ativa || String(origem.grupo) !== String(destino.grupo)) throw recusa();
  if (!isStaff) {
    for (const loja of [origem, destino]) {
      const quem = { isOwner: loja.is_owner, roleLabel: loja.role_label, permissions: lerPermissoes(loja.permissions) };
      if (!podeMexer(quem)) throw recusa();
    }
  }
  return { grupo: String(origem.grupo), origemNome: origem.nome, destinoNome: destino.nome };
}

// ─── rotulo da variante ──────────────────────────────────────
// "Azul / M": nome da cor e depois os outros atributos; tamanho curto em
// maiuscula. Sem nada legivel, o sku_suffix ("AZUL-M").
// 14/11/2026 (CP2a da revisao de cores): o nome da cor e o mesmo do Caixa e
// do cupom (services/nomeDaCor.js). Antes, a cor sem color_name sumia do
// rotulo ("M") e o nome cortado ("AZUL ESCUR") aparecia como estava.
function rotuloDaVariante(v, valores) {
  const lista = valores || [];
  const partes = [];
  const cor = lista.find((x) => norm(x.attribute_name) === 'cor');
  const corLegivel = cor
    ? (nomeDaCorDaVariante({
        color_name: v && v.color_name,
        sku_suffix: v && v.sku_suffix,
        attributes: lista.map((x) => ({ attribute: x.attribute_name, value: x.value })),
      }) || '')
    : (nomeGravadoQueAparece(v && v.color_name) || '');
  if (corLegivel) partes.push(corLegivel);
  for (const x of lista) {
    if (x === cor) continue;
    const val = txt(x.value);
    if (val) partes.push(val.length <= 4 ? val.toUpperCase() : val);
  }
  if (partes.length) return partes.join(' / ');
  return txt(v && v.sku_suffix) || null;
}

function assinaturaDosAtributos(valores) {
  const pares = (valores || [])
    .map((x) => `${norm(x.attribute_name)}=${norm(x.value)}`)
    .filter((s) => s !== '=')
    .sort();
  return pares.length ? pares.join('|') : null;
}

function agrupar(rows, chave) {
  const m = new Map();
  for (const r of rows) {
    const k = String(r[chave]).toLowerCase();
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

/**
 * Pecas com clientes (condicional aberta) dos produtos, por produto/variante,
 * ou null quando a trava esta desligada. Dentro da transacao: SAVEPOINT, para
 * uma base sem a migration 467 nao derrubar a transferencia (cai no saldo de
 * sempre, como a conferencia e o GET /products fazem).
 */
async function lerForaDaOrigem(conn, origemId, pids, comCondicional) {
  if (!comCondicional || !pids.length) return null;
  try {
    await conn.query('SAVEPOINT cc_transferencia');
    const mapa = await lerComClientes(conn, origemId, pids);
    await conn.query('RELEASE SAVEPOINT cc_transferencia');
    return mapa;
  } catch (e) {
    console.error('[transferencia] pecas com clientes indisponivel:', e && e.message);
    await conn.query('ROLLBACK TO SAVEPOINT cc_transferencia').catch(() => {});
    return null;
  }
}

// ─── o nucleo ────────────────────────────────────────────────
/**
 * Roda DENTRO de uma transacao aberta pelo chamador (BEGIN ... COMMIT).
 * Lanca ErroDeTransferencia (4xx) sem ter escrito nada.
 */
async function transferir(conn, { origemId, destinoId, userId, isStaff = false, itens, observacao = null, stockCountId = null, comCondicional = false }) {
  origemId = String(origemId).toLowerCase();
  destinoId = String(destinoId).toLowerCase();
  const lojas = await conferirLojas(conn, { origemId, destinoId, userId, isStaff });

  // Fila por grupo: numero sem buraco, copia sem duplicar, A->B e B->A sem deadlock.
  await conn.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`stock_transfer:${lojas.grupo}`]);

  const pids = [...new Set(itens.map((i) => i.product_id))];
  const vids = [...new Set(itens.filter((i) => i.variant_id).map((i) => i.variant_id))];

  // 1. origem, com lock (ordem por id: dois lotes travam na mesma ordem)
  const { rows: prodOrigem } = await conn.query(
    `SELECT id, name, is_active, stock_qty, barcode, sku, master_sku, unit
       FROM products
      WHERE id = ANY($1::uuid[]) AND company_id = $2
      ORDER BY id
      FOR UPDATE`,
    [pids, origemId]
  );
  const prodPorId = new Map(prodOrigem.map((p) => [String(p.id).toLowerCase(), p]));
  const varOrigem = vids.length ? (await conn.query(
    `SELECT id, product_id, is_active, stock_qty, barcode, sku_suffix, color_name
       FROM product_variants
      WHERE id = ANY($1::uuid[])
      ORDER BY id
      FOR UPDATE`,
    [vids]
  )).rows : [];
  const varPorId = new Map(varOrigem.map((v) => [String(v.id).toLowerCase(), v]));
  const { rows: comGrade } = await conn.query(
    `SELECT DISTINCT product_id FROM product_variants WHERE product_id = ANY($1::uuid[]) AND is_active = true`,
    [pids]
  );
  const temGradeOrigem = new Set(comGrade.map((r) => String(r.product_id).toLowerCase()));

  const naoAchados = [];
  const servicos = [];
  for (const it of itens) {
    const p = prodPorId.get(it.product_id);
    if (!p || p.is_active === false) { naoAchados.push({ product_id: it.product_id, variant_id: it.variant_id }); continue; }
    // Servico (products.unit 'srv', a mesma marca da NFC-e) nao tem estoque.
    if (norm(p.unit) === 'srv') { servicos.push({ product_id: it.product_id, variant_id: it.variant_id, nome: p.name, motivo: 'servico' }); continue; }
    if (it.variant_id) {
      const v = varPorId.get(it.variant_id);
      if (!v || v.is_active === false || String(v.product_id).toLowerCase() !== it.product_id) {
        naoAchados.push({ product_id: it.product_id, variant_id: it.variant_id, nome: p.name });
      }
    } else if (temGradeOrigem.has(it.product_id)) {
      naoAchados.push({ product_id: it.product_id, variant_id: null, nome: p.name, motivo: 'informe_a_variante' });
    }
  }
  if (servicos.length) {
    const nomes = servicos.map((x) => x.nome).filter(Boolean).slice(0, 3).join(', ');
    throw new ErroDeTransferencia(400, 'QUANTIDADE_INVALIDA',
      `Serviço não tem estoque e não entra na transferência. Tire da lista: ${nomes}${servicos.length > 3 ? '…' : ''}.`, { itens: servicos });
  }
  if (naoAchados.length) {
    throw new ErroDeTransferencia(404, 'ITEM_NAO_ENCONTRADO',
      'Alguns itens não estão no estoque desta loja (ou precisam da cor/tamanho).', { itens: naoAchados });
  }

  // 2. saldo (ja travado)
  // Venda condicional: a peca com cliente continua no estoque, mas nao esta na
  // loja e nao pode ser mandada. Com a trava ligada, o disponivel e
  // estoque - com clientes, por variante (igual ao produto sem grade).
  // Trava desligada: nem consulta, o saldo e o de sempre.
  const fora = await lerForaDaOrigem(conn, origemId, pids, comCondicional);
  const faltando = [];
  for (const it of itens) {
    const linha = it.variant_id ? varPorId.get(it.variant_id) : prodPorId.get(it.product_id);
    const comClientes = fora ? comClientesDaVariante(fora, it.product_id, it.variant_id || null) : 0;
    const disponivel = (Number(linha.stock_qty) || 0) - comClientes;
    if (it.quantidade > disponivel + 1e-9) {
      faltando.push({
        product_id: it.product_id, variant_id: it.variant_id,
        nome: prodPorId.get(it.product_id).name,
        quantidade: it.quantidade, disponivel: arred3(Math.max(0, disponivel)),
        ...(comClientes > 0 ? { com_clientes: comClientes } : {}),
      });
    }
  }
  if (faltando.length) {
    const algumaComCliente = faltando.some((f) => f.com_clientes > 0);
    throw new ErroDeTransferencia(409, 'ESTOQUE_INSUFICIENTE',
      algumaComCliente
        ? 'Alguns itens não têm peças livres na loja: parte do estoque está com clientes em condicional.'
        : 'Alguns itens não têm estoque suficiente na loja de origem.', { itens: faltando });
  }

  // 3. atributos das variantes de origem (rotulo + match + copia)
  const valoresOrigem = vids.length ? agrupar((await conn.query(
    `SELECT variant_id, attribute_name, value FROM product_variant_values WHERE variant_id = ANY($1::uuid[])`,
    [vids]
  )).rows, 'variant_id') : new Map();

  // 4. produto no destino
  const mapaProd = new Map();      // pid origem -> { id, criado }
  const vinculoVar = new Map();    // vid origem -> vid destino (transferencia anterior)
  const { rows: vinculos } = await conn.query(
    `SELECT * FROM (
       SELECT i.product_id AS o_pid, i.variant_id AS o_vid,
              i.destino_product_id AS d_pid, i.destino_variant_id AS d_vid, t.criada_em
         FROM stock_transfer_items i JOIN stock_transfers t ON t.id = i.transfer_id
        WHERE t.origem_company_id = $1 AND t.destino_company_id = $2 AND i.product_id = ANY($3::uuid[])
       UNION ALL
       SELECT i.destino_product_id, i.destino_variant_id, i.product_id, i.variant_id, t.criada_em
         FROM stock_transfer_items i JOIN stock_transfers t ON t.id = i.transfer_id
        WHERE t.origem_company_id = $2 AND t.destino_company_id = $1 AND i.destino_product_id = ANY($3::uuid[])
     ) v
     WHERE v.d_pid IS NOT NULL
     ORDER BY v.criada_em DESC`,
    [origemId, destinoId, pids]
  );
  const candidatos = [...new Set(vinculos.map((v) => String(v.d_pid).toLowerCase()))];
  const prodVinculadoOk = candidatos.length ? new Set((await conn.query(
    `SELECT id FROM products WHERE id = ANY($1::uuid[]) AND company_id = $2 AND is_active = true`,
    [candidatos, destinoId]
  )).rows.map((r) => String(r.id).toLowerCase())) : new Set();
  for (const v of vinculos) {
    const o = String(v.o_pid).toLowerCase();
    const d = String(v.d_pid).toLowerCase();
    if (!prodVinculadoOk.has(d)) continue;
    if (!mapaProd.has(o)) mapaProd.set(o, { id: d, criado: false, via: 'vinculo' });
    if (v.o_vid && v.d_vid && mapaProd.get(o).id === d) {
      const ov = String(v.o_vid).toLowerCase();
      if (!vinculoVar.has(ov)) vinculoVar.set(ov, String(v.d_vid).toLowerCase());
    }
  }

  const pendentes = () => prodOrigem.filter((p) => !mapaProd.has(String(p.id).toLowerCase()));
  const barcodeOcupado = new Set(); // barcode do destino em produto inativo: a copia sai sem
  // 4b. barcode (inclui inativo: o UNIQUE (company_id, barcode) tambem inclui)
  {
    const lista = pendentes().filter((p) => txt(p.barcode));
    if (lista.length) {
      const { rows } = await conn.query(
        `SELECT id, barcode, is_active FROM products WHERE company_id = $1 AND barcode = ANY($2::text[])`,
        [destinoId, lista.map((p) => txt(p.barcode))]
      );
      const porCodigo = new Map(rows.map((r) => [txt(r.barcode), r]));
      for (const p of lista) {
        const d = porCodigo.get(txt(p.barcode));
        if (!d) continue;
        if (d.is_active === false) barcodeOcupado.add(txt(p.barcode));
        else mapaProd.set(String(p.id).toLowerCase(), { id: String(d.id).toLowerCase(), criado: false, via: 'barcode' });
      }
    }
  }
  // 4c. sku  4d. master_sku
  for (const coluna of ['sku', 'master_sku']) {
    const lista = pendentes().filter((p) => txt(p[coluna]));
    if (!lista.length) continue;
    const { rows } = await conn.query(
      `SELECT DISTINCT ON (btrim(${coluna})) id, btrim(${coluna}) AS chave
         FROM products
        WHERE company_id = $1 AND is_active = true AND btrim(${coluna}) = ANY($2::text[])
        ORDER BY btrim(${coluna}), created_at ASC`,
      [destinoId, lista.map((p) => txt(p[coluna]))]
    );
    const porChave = new Map(rows.map((r) => [r.chave, String(r.id).toLowerCase()]));
    for (const p of lista) {
      const d = porChave.get(txt(p[coluna]));
      if (d) mapaProd.set(String(p.id).toLowerCase(), { id: d, criado: false, via: coluna });
    }
  }

  // 5. destino achado: trava e confere a grade
  const achados = [...new Set([...mapaProd.values()].map((m) => m.id))];
  const destinoInfo = new Map();
  if (achados.length) {
    const { rows } = await conn.query(
      `SELECT id, stock_qty FROM products WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [achados]
    );
    const { rows: grade } = await conn.query(
      `SELECT DISTINCT product_id FROM product_variants WHERE product_id = ANY($1::uuid[]) AND is_active = true`,
      [achados]
    );
    const comG = new Set(grade.map((r) => String(r.product_id).toLowerCase()));
    for (const r of rows) {
      const id = String(r.id).toLowerCase();
      destinoInfo.set(id, { stock_qty: Number(r.stock_qty) || 0, temGrade: comG.has(id) });
    }
  }
  const gradeDiferente = [];
  for (const it of itens) {
    const m = mapaProd.get(it.product_id);
    if (!m) continue;
    const d = destinoInfo.get(m.id) || { stock_qty: 0, temGrade: false };
    if (!it.variant_id && d.temGrade) {
      gradeDiferente.push({ product_id: it.product_id, variant_id: null, destino_product_id: m.id, nome: prodPorId.get(it.product_id).name, motivo: 'destino_tem_variantes' });
    } else if (it.variant_id && !d.temGrade && d.stock_qty > 0) {
      gradeDiferente.push({ product_id: it.product_id, variant_id: it.variant_id, destino_product_id: m.id, nome: prodPorId.get(it.product_id).name, motivo: 'destino_sem_variantes' });
    }
  }
  if (gradeDiferente.length) {
    throw new ErroDeTransferencia(409, 'GRADE_DIFERENTE',
      'Na loja de destino o mesmo produto tem outra grade de cor/tamanho. Ajuste o cadastro lá antes de transferir.', { itens: gradeDiferente });
  }

  // 6. copia dos que nao existem no destino
  const cols = await colunasCopiaveis(conn);
  const copiar = pendentes();
  if (copiar.length) {
    const orig = [], novo = [], barcode = [];
    for (const p of copiar) {
      const id = randomUUID();
      const o = String(p.id).toLowerCase();
      orig.push(o); novo.push(id);
      barcode.push(txt(p.barcode) && !barcodeOcupado.has(txt(p.barcode)) ? p.barcode : null);
      mapaProd.set(o, { id, criado: true, via: 'copia' });
    }
    // 20/11/2026: a copia mora em services/copiaDeCadastro.js (mesmo SQL).
    await copiarProdutos(conn, { destinoId, orig, novo, barcode, cols });
  }

  // 7. variante no destino
  const itensVar = itens.filter((i) => i.variant_id);
  const mapaVar = new Map(); // vid origem -> { id, criada }
  if (itensVar.length) {
    const prodsDestinoExistentes = [...new Set(itensVar
      .map((i) => mapaProd.get(i.product_id))
      .filter((m) => !m.criado)
      .map((m) => m.id))];
    const varsDestino = new Map(); // pid destino -> [{ id, barcode, sku_suffix, assin }]
    if (prodsDestinoExistentes.length) {
      const { rows: vs } = await conn.query(
        `SELECT id, product_id, barcode, sku_suffix FROM product_variants
          WHERE product_id = ANY($1::uuid[]) AND is_active = true
          ORDER BY created_at ASC, id`,
        [prodsDestinoExistentes]
      );
      const valores = vs.length ? agrupar((await conn.query(
        `SELECT variant_id, attribute_name, value FROM product_variant_values WHERE variant_id = ANY($1::uuid[])`,
        [vs.map((v) => v.id)]
      )).rows, 'variant_id') : new Map();
      for (const v of vs) {
        const pid = String(v.product_id).toLowerCase();
        if (!varsDestino.has(pid)) varsDestino.set(pid, []);
        varsDestino.get(pid).push({
          id: String(v.id).toLowerCase(), barcode: txt(v.barcode), sku: norm(v.sku_suffix),
          assin: assinaturaDosAtributos(valores.get(String(v.id).toLowerCase())),
        });
      }
    }
    const criarOrig = [], criarNovo = [], criarPid = [];
    for (const it of itensVar) {
      const destPid = mapaProd.get(it.product_id).id;
      const lista = varsDestino.get(destPid) || [];
      const vo = varPorId.get(it.variant_id);
      const assin = assinaturaDosAtributos(valoresOrigem.get(it.variant_id));
      const bc = txt(vo.barcode);
      const sku = norm(vo.sku_suffix);
      const ligada = vinculoVar.get(it.variant_id);
      const achada =
        (ligada && lista.find((v) => v.id === ligada)) ||
        (bc && lista.find((v) => v.barcode === bc)) ||
        (sku && lista.find((v) => v.sku === sku)) ||
        (assin && lista.find((v) => v.assin === assin)) ||
        null;
      if (achada) { mapaVar.set(it.variant_id, { id: achada.id, criada: false }); continue; }
      const id = randomUUID();
      criarOrig.push(it.variant_id); criarNovo.push(id); criarPid.push(destPid);
      mapaVar.set(it.variant_id, { id, criada: true });
      // a proxima variante igual no mesmo lote acha esta
      lista.push({ id, barcode: bc, sku, assin });
      varsDestino.set(destPid, lista);
    }
    if (criarOrig.length) {
      await copiarVariantes(conn, { cols, orig: criarOrig, novo: criarNovo, pid: criarPid });
    }
  }

  // 8. estoque: baixa na origem, entrada no destino (somado por linha)
  const somar = (mapa, k, n) => mapa.set(k, arred3((mapa.get(k) || 0) + n));
  const baixaProd = new Map(), baixaVar = new Map(), entraProd = new Map(), entraVar = new Map();
  for (const it of itens) {
    if (it.variant_id) {
      somar(baixaVar, it.variant_id, it.quantidade);
      somar(entraVar, mapaVar.get(it.variant_id).id, it.quantidade);
    } else {
      somar(baixaProd, it.product_id, it.quantidade);
      somar(entraProd, mapaProd.get(it.product_id).id, it.quantidade);
    }
  }
  const aplicar = async (tabela, mapa, sinal, extra = '', params = []) => {
    if (!mapa.size) return;
    await conn.query(
      `UPDATE ${tabela} t SET stock_qty = t.stock_qty ${sinal} u.q, updated_at = NOW()
         FROM unnest($1::uuid[], $2::numeric[]) AS u(id, q)
        WHERE t.id = u.id ${extra}`,
      [[...mapa.keys()], [...mapa.values()], ...params]
    );
  };
  await aplicar('products', baixaProd, '-', 'AND t.company_id = $3', [origemId]);
  await aplicar('product_variants', baixaVar, '-');
  await aplicar('products', entraProd, '+', 'AND t.company_id = $3', [destinoId]);
  await aplicar('product_variants', entraVar, '+');

  // 9. cabecalho, itens e movimentos
  const { rows: seq } = await conn.query(
    `SELECT COALESCE(MAX(numero), 0) + 1 AS numero FROM stock_transfers WHERE grupo_company_id = $1`,
    [lojas.grupo]
  );
  const numero = Number(seq[0].numero);
  const total = arred3(itens.reduce((s, i) => s + i.quantidade, 0));
  // 11/11/2026 (migration 446): stock_count_id so quando a transferencia
  // sai de uma conferencia (a rota ja conferiu que e da origem). Sem ele o
  // INSERT e o de sempre.
  const { rows: cab } = stockCountId
    ? await conn.query(
      `INSERT INTO stock_transfers
         (grupo_company_id, numero, origem_company_id, destino_company_id, criada_por, observacao, itens_count, quantidade_total, stock_count_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, numero, origem_company_id, destino_company_id, criada_em, criada_por, observacao, stock_count_id`,
      [lojas.grupo, numero, origemId, destinoId, userId || null, observacao, itens.length, total, stockCountId]
    )
    : await conn.query(
      `INSERT INTO stock_transfers
       (grupo_company_id, numero, origem_company_id, destino_company_id, criada_por, observacao, itens_count, quantidade_total)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, numero, origem_company_id, destino_company_id, criada_em, criada_por, observacao`,
      [lojas.grupo, numero, origemId, destinoId, userId || null, observacao, itens.length, total]
    );
  const t = cab[0];

  const saida = itens.map((it) => {
    const mp = mapaProd.get(it.product_id);
    const mv = it.variant_id ? mapaVar.get(it.variant_id) : null;
    return {
      product_id: it.product_id,
      variant_id: it.variant_id,
      destino_product_id: mp.id,
      destino_variant_id: mv ? mv.id : null,
      quantidade: it.quantidade,
      criado_no_destino: mp.criado || !!(mv && mv.criada),
      nome: prodPorId.get(it.product_id).name,
      rotulo: it.variant_id ? rotuloDaVariante(varPorId.get(it.variant_id), valoresOrigem.get(it.variant_id)) : null,
    };
  });
  const col = (k) => saida.map((s) => s[k]);
  await conn.query(
    `INSERT INTO stock_transfer_items
       (transfer_id, product_id, variant_id, destino_product_id, destino_variant_id, quantidade, criado_no_destino, nome, variante)
     SELECT $1, * FROM unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[], $6::numeric[], $7::boolean[], $8::text[], $9::text[])`,
    [t.id, col('product_id'), col('variant_id'), col('destino_product_id'), col('destino_variant_id'),
      col('quantidade'), col('criado_no_destino'), col('nome'), col('rotulo')]
  );

  const mProd = [], mEmp = [], mTipo = [], mQtd = [], mVar = [], mNota = [];
  const notaSai = `Transferência #${numero} para ${lojas.destinoNome || 'outra loja'}`;
  const notaEntra = `Transferência #${numero} de ${lojas.origemNome || 'outra loja'}`;
  for (const s of saida) {
    mProd.push(s.product_id); mEmp.push(origemId); mTipo.push('out'); mQtd.push(s.quantidade); mVar.push(s.variant_id); mNota.push(notaSai);
    mProd.push(s.destino_product_id); mEmp.push(destinoId); mTipo.push('in'); mQtd.push(s.quantidade); mVar.push(s.destino_variant_id); mNota.push(notaEntra);
  }
  await conn.query(
    `INSERT INTO stock_movements (product_id, company_id, type, quantity, variant_id, notes, reference_id, reference_type)
     SELECT m.p, m.c, m.t, m.q, m.v, m.n, $7, 'stock_transfer'
       FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::numeric[], $5::uuid[], $6::text[]) AS m(p, c, t, q, v, n)`,
    [mProd, mEmp, mTipo, mQtd, mVar, mNota, t.id]
  );

  return {
    id: t.id,
    numero: Number(t.numero),
    origem_company_id: t.origem_company_id,
    destino_company_id: t.destino_company_id,
    origem_nome: lojas.origemNome || null,
    destino_nome: lojas.destinoNome || null,
    criada_em: t.criada_em,
    criada_por: t.criada_por,
    observacao: t.observacao,
    total_itens: itens.length,
    total_pecas: total,
    itens: saida,
    ...(stockCountId ? { stock_count_id: t.stock_count_id || stockCountId } : {}),
  };
}

// ─── listagem ────────────────────────────────────────────────
async function listar(conn, companyId, { limit = 20, offset = 0 } = {}) {
  const { rows } = await conn.query(
    `SELECT t.id, t.numero, t.origem_company_id, t.destino_company_id, t.criada_em, t.criada_por,
            t.observacao, t.itens_count, t.quantidade_total,
            COALESCE(co.trade_name, co.legal_name) AS origem_nome,
            COALESCE(cd.trade_name, cd.legal_name) AS destino_nome,
            u.full_name AS usuario_nome,
            COUNT(*) OVER () AS total
       FROM stock_transfers t
       LEFT JOIN companies co ON co.id = t.origem_company_id
       LEFT JOIN companies cd ON cd.id = t.destino_company_id
       LEFT JOIN users u ON u.id = t.criada_por
      WHERE t.origem_company_id = $1 OR t.destino_company_id = $1
      ORDER BY t.criada_em DESC, t.numero DESC
      LIMIT $2 OFFSET $3`,
    [companyId, limit, offset]
  );
  let total = rows.length ? Number(rows[0].total) : 0;
  if (!rows.length && offset > 0) {
    const { rows: c } = await conn.query(
      `SELECT COUNT(*) AS total FROM stock_transfers WHERE origem_company_id = $1 OR destino_company_id = $1`,
      [companyId]
    );
    total = Number(c[0].total);
  }
  const ids = rows.map((r) => r.id);
  const itens = ids.length ? agrupar((await conn.query(
    `SELECT id, transfer_id, product_id, variant_id, destino_product_id, destino_variant_id,
            quantidade, criado_no_destino, nome, variante
       FROM stock_transfer_items
      WHERE transfer_id = ANY($1::uuid[])
      ORDER BY nome ASC NULLS LAST, variante ASC NULLS LAST, id`,
    [ids]
  )).rows, 'transfer_id') : new Map();
  const cid = String(companyId).toLowerCase();
  return {
    transferencias: rows.map((r) => ({
      id: r.id,
      numero: Number(r.numero),
      origem_company_id: r.origem_company_id,
      destino_company_id: r.destino_company_id,
      origem_nome: r.origem_nome || null,
      destino_nome: r.destino_nome || null,
      sentido: String(r.origem_company_id).toLowerCase() === cid ? 'saida' : 'entrada',
      criada_em: r.criada_em,
      criada_por: r.criada_por,
      usuario_nome: r.usuario_nome || null,
      observacao: r.observacao,
      total_itens: Number(r.itens_count),
      total_pecas: Number(r.quantidade_total),
      itens: (itens.get(String(r.id).toLowerCase()) || []).map((i) => ({
        product_id: i.product_id,
        variant_id: i.variant_id,
        destino_product_id: i.destino_product_id,
        destino_variant_id: i.destino_variant_id,
        quantidade: Number(i.quantidade),
        criado_no_destino: !!i.criado_no_destino,
        nome: i.nome,
        rotulo: i.variante,
      })),
    })),
    total,
    limit,
    offset,
  };
}

module.exports = {
  LIMITE_ITENS,
  ErroDeTransferencia,
  lerPedido,
  podeMexer,
  conferirLojas,
  transferir,
  listar,
  rotuloDaVariante,
  assinaturaDosAtributos,
  _limparCacheDeColunas,
};
