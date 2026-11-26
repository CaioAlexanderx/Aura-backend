// ============================================================
// AURA. — Venda condicional: guardar e ler (C2, 25/11/2026)
//
// A cliente leva pecas para experimentar. Regras do Caio (mockup aprovado em
// 25/11), as que valem neste arquivo:
//   R1. guardar a condicional NAO cria venda, lancamento no Financeiro nem
//       movimento de caixa, e NAO baixa estoque. A peca so passa a contar em
//       "com clientes" (calculado, services/comClientes.js);
//   R2. exige cliente cadastrada (customer_id do mesmo dono, a regra do
//       Caixa em utils/customerScope.js) com nome e telefone valido (DDD +
//       numero, 10 ou 11 digitos), ao menos 1 peca e devolucao entre hoje e
//       hoje + 30 dias (fuso de Sao Paulo). Sem due_date, vale o prazo padrao
//       da loja (pdv_settings.condicional_prazo_padrao, 1-30, ausente = 3);
//   R3/R4. cada linha e UMA peca (quantity, se vier, tem de ser 1). So entra
//       peca livre: livres = estoque − com clientes − reservado (pedido do
//       balcao, reservaDoPedido.js). Sem livre: 409 COND_SEM_SALDO com o
//       numero da condicional que segura a peca. Loja com "vender sem
//       estoque" ligado (allow_sale_without_stock) entra com o aviso, como o
//       pedido do balcao (B2);
//   R5. Idempotency-Key (cabecalho ou idempotency_key no corpo): a mesma
//       chave na mesma loja devolve a mesma condicional (200); com outras
//       pecas, 409 IDEMPOTENCY_KEY_REUSED. Trava de transacao na chave +
//       indice unico parcial (uq_condicionais_company_idem) como garantia.
//
// PRECO DO DIA (unit_price da peca): calculado AQUI, no servidor, pela regra
// unica do Caixa (services/precoEfetivo.js, De/Por p-84): promocao vigente
// conta; variante com price_override vale o proprio preco (e a promocao
// dela); sem override segue o produto. O preco no cartao (card_price) NAO
// entra: depende da forma de pagamento, que so existe na cobranca. Preco
// mandado pelo app e ignorado. E o preco da cobranca (decisao 1 do Caio): o
// detalhe mostra o preco de hoje ao lado (preco_hoje).
//
// Pecas que nao entram: servico (unit 'srv'), peca sob encomenda
// (personalizavel) e produto com grade sem a variante escolhida.
//
// Numero por loja: UPSERT em condicional_sequencias (trava a linha da loja
// ate o COMMIT, entao duas condicionais simultaneas nunca pegam o mesmo
// numero) + indice unico (company_id, numero). Exibido como C-0031.
//
// Corrida pela mesma peca: dentro da transacao, trava de transacao por
// produto (pg_advisory_xact_lock, em ordem) antes de contar o livre. Duas
// condicionais pela ultima unidade: a segunda espera a primeira e recebe 409.
//
// Termos: pdv_settings.condicional_termos e COPIADO em terms_snapshot ao
// guardar (decisao 5). Sem texto, null (sem quadro no comprovante).
//
// Multi-CNPJ: a condicional e de UMA loja (a do :id). Produto compartilhado
// do grupo pode entrar (a regra unica de visibilidade); ele conta "com
// cliente" no estoque unico da loja dona.
//
// Trava de lancamento: CONDICIONAL_LIBERADA (env, desligada). Desligada, so a
// equipe Aura (is_staff / admin) usa as rotas; para o lojista sao 404.
// ============================================================
'use strict';

const db = require('../config/database');
const { productVisibilityWhere } = require('../utils/companyGroup');
const { findOwnerScopedCustomer } = require('../utils/customerScope');
const { normalizarTelefone, digitosNacionais } = require('../utils/telefone');
const { lerVendaSemEstoque } = require('../utils/vendaSemEstoque');
const { ehUnidadeServico } = require('./notaDoItem');
const { lerReservas, reservadoDaVariante } = require('./reservaDoPedido');
const comClientes = require('./comClientes');
const {
  precoEfetivoDoProduto, precoEfetivoDaVariante, colunasPromo, colunasPromoNulas, comColunasPromo,
} = require('./precoEfetivo');

const MAX_PECAS = 60;
const PRAZO_PADRAO_DIAS = 3;
const PRAZO_MAX_DIAS = 30;
const TERMOS_MAX = 3000;
const INDICE_CHAVE = 'uq_condicionais_company_idem';
const INDICE_NUMERO = 'uq_condicionais_company_numero';
// Decisao da Nina (25/11): o aviso da loja que vende sem estoque, texto exato.
const AVISO_SEM_ESTOQUE = 'Sem unidade livre. Entra mesmo assim porque sua loja vende sem estoque.';
const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function erro(status, message, code, extra) {
  return Object.assign(new Error(message), { status, code, ...(extra || {}) });
}

/**
 * Trava do recurso. Desligada (padrao) = so a equipe Aura usa, para QA em
 * producao. CONDICIONAL_LIBERADA=true libera para todo lojista, junto com a
 * trava de mesmo nome do app.
 */
function condicionalLiberada(req) {
  const env = String(process.env.CONDICIONAL_LIBERADA || '').trim().toLowerCase();
  if (env === 'true' || env === '1') return true;
  const u = req && req.user;
  return !!u && (u.is_staff === true || u.role === 'admin');
}

/** Hoje em Sao Paulo, 'YYYY-MM-DD'. */
function hojeSP(agora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(agora);
}

function dataValida(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 'YYYY-MM-DD' + n dias. */
function somarDias(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Dias de a ate b ('YYYY-MM-DD'); positivo quando b e depois. */
function diasEntre(a, b) {
  return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
}

/** C-0031. */
function numeroExibicao(numero) {
  const n = Number(numero) || 0;
  return 'C-' + String(n).padStart(4, '0');
}

function textoLimpo(raw, max) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const s = String(raw).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return Array.from(s).slice(0, max).join('').trim();
}

/** Termos: mantem as quebras de linha (o comprovante imprime em paragrafos). */
function termosLimpos(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim();
  if (!s) return null;
  return Array.from(s).slice(0, TERMOS_MAX).join('');
}

/** Prazo padrao da loja: inteiro de 1 a 30 em pdv_settings; senao 3. */
function lerPrazoPadrao(pdvSettings) {
  const v = pdvSettings && pdvSettings.condicional_prazo_padrao;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isInteger(n) && n >= 1 && n <= PRAZO_MAX_DIAS ? n : PRAZO_PADRAO_DIAS;
}

function lerTermos(pdvSettings) {
  return termosLimpos(pdvSettings && pdvSettings.condicional_termos);
}

/** Chave de idempotencia do cabecalho ou do corpo. null = sem protecao. */
function lerChave(req) {
  const doCabecalho = req?.headers?.['idempotency-key'];
  const raw = (doCabecalho !== undefined && doCabecalho !== null && doCabecalho !== '')
    ? doCabecalho
    : req?.body?.idempotency_key;
  if (raw === undefined || raw === null) return null;
  const k = String(Array.isArray(raw) ? raw[0] : raw).trim();
  if (!k) return null;
  return KEY_RE.test(k) ? k : null;
}

/**
 * Le e confere o corpo, sem banco. Devolve { dados } ou { erro }.
 * Mensagens em portugues, prontas para a tela.
 */
function lerCorpo(body, { hoje = hojeSP() } = {}) {
  const b = body || {};
  const brutos = b.items;
  if (!Array.isArray(brutos) || brutos.length === 0) {
    return { erro: { status: 422, code: 'COND_SEM_PECAS', message: 'Escolha pelo menos uma peça para a condicional.' } };
  }
  if (brutos.length > MAX_PECAS) {
    return { erro: { status: 422, code: 'COND_PECAS_DEMAIS', message: `Uma condicional leva até ${MAX_PECAS} peças.` } };
  }
  const itens = [];
  for (let i = 0; i < brutos.length; i++) {
    const it = brutos[i] || {};
    // uuid sempre em minusculas: e a chave dos Maps e da comparacao da
    // repeticao (o banco devolve em minusculas).
    const pid = it.product_id ? String(it.product_id).trim().toLowerCase() : '';
    const vid = it.variant_id ? String(it.variant_id).trim().toLowerCase() : null;
    if (!UUID_RE.test(pid)) {
      return { erro: { status: 422, code: 'COND_ITEM_INVALIDO', message: `A peça ${i + 1} não tem um produto cadastrado.` } };
    }
    if (vid && !UUID_RE.test(vid)) {
      return { erro: { status: 422, code: 'COND_ITEM_INVALIDO', message: `A peça ${i + 1} tem uma cor ou tamanho inválido.` } };
    }
    if (it.quantity !== undefined && it.quantity !== null && it.quantity !== '' && Number(it.quantity) !== 1) {
      return { erro: { status: 422, code: 'COND_QUANTIDADE', message: 'Na condicional cada linha é uma peça. Para levar duas iguais, adicione a peça duas vezes.' } };
    }
    itens.push({ product_id: pid, variant_id: vid });
  }

  const cid = b.customer_id ? String(b.customer_id).trim().toLowerCase() : '';
  if (!cid) {
    return { erro: { status: 422, code: 'COND_CLIENTE_OBRIGATORIO', message: 'Escolha a cliente que vai levar as peças.' } };
  }
  if (!UUID_RE.test(cid)) {
    return { erro: { status: 404, code: 'CUSTOMER_NOT_FOUND', message: 'Cliente não encontrado nesta empresa.' } };
  }

  let dueDate = null;
  if (b.due_date !== undefined && b.due_date !== null && b.due_date !== '') {
    const s = String(b.due_date).trim();
    if (!dataValida(s)) {
      return { erro: { status: 422, code: 'COND_DATA', message: 'A data de devolução está inválida.' } };
    }
    if (s < hoje) {
      return { erro: { status: 422, code: 'COND_DATA', message: 'A data de devolução já passou. Escolha hoje ou um dia depois.' } };
    }
    if (s > somarDias(hoje, PRAZO_MAX_DIAS)) {
      return { erro: { status: 422, code: 'COND_DATA', message: `A devolução pode ser em até ${PRAZO_MAX_DIAS} dias.` } };
    }
    dueDate = s;
  }

  const sellerId = b.seller_id ? String(b.seller_id).trim().toLowerCase() : null;
  const employeeId = b.employee_id ? String(b.employee_id).trim().toLowerCase() : null;
  if ((sellerId && !UUID_RE.test(sellerId)) || (employeeId && !UUID_RE.test(employeeId))) {
    return { erro: { status: 422, code: 'COND_VENDEDORA', message: 'Vendedora inválida.' } };
  }

  return {
    dados: {
      itens,
      customerId: cid,
      customerName: textoLimpo(b.customer_name, 255),
      customerPhone: b.customer_phone === undefined || b.customer_phone === null ? null : b.customer_phone,
      dueDate,
      sellerId,
      employeeId,
      sellerName: textoLimpo(b.seller_name, 120),
      notes: textoLimpo(b.notes, 500),
    },
  };
}

/** Telefone para gravar: DDD + numero (10 ou 11 digitos). null = invalido. */
function telefoneValido(bruto) {
  const n = normalizarTelefone(textoLimpo(bruto, 30));
  if (!n.ok || n.valor === null || n.valor === undefined) return null;
  const d = digitosNacionais(n.valor);
  return d.length === 10 || d.length === 11 ? d : null;
}

/**
 * Produtos e variantes (com as colunas de promocao), pela regra unica de
 * visibilidade do grupo. Fora da transacao: a leitura de promo_* tem
 * fallback para a base sem a 427 (42703) e nao pode abortar a transacao.
 */
async function lerCatalogo(q, companyId, productIds, variantIds) {
  const pids = [...new Set(productIds)];
  const vids = [...new Set(variantIds.filter(Boolean))];
  const produtos = await comColunasPromo((com) => q.query(
    `SELECT p.id, p.name, p.price, p.stock_qty, p.unit, p.is_active,
            (p.is_personalizable IS TRUE AND p.customization_config IS NOT NULL) AS sob_encomenda,
            EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.is_active IS NOT FALSE) AS tem_grade,
            ${com ? colunasPromo('p') : colunasPromoNulas()}
       FROM products p
      WHERE p.id = ANY($1::uuid[])
        AND ${productVisibilityWhere('$2', 'p.')}`,
    [pids, companyId]
  ));
  let variantes = { rows: [] };
  if (vids.length) {
    variantes = await comColunasPromo((com) => q.query(
      `SELECT pv.id, pv.product_id, pv.sku_suffix, pv.price_override, pv.stock_qty, pv.is_active, pv.color_name,
              (SELECT x.value FROM product_variant_values x
                WHERE x.variant_id = pv.id AND lower(x.attribute_name) IN ('cor', 'cores', 'color') LIMIT 1) AS cor_atributo,
              (SELECT x.value FROM product_variant_values x
                WHERE x.variant_id = pv.id AND lower(x.attribute_name) IN ('tamanho', 'tamanhos', 'size') LIMIT 1) AS tamanho,
              ${com ? colunasPromo('pv') : colunasPromoNulas()}
         FROM product_variants pv
        WHERE pv.id = ANY($1::uuid[])`,
      [vids]
    ));
  }
  return {
    produtos: new Map(produtos.rows.map((r) => [String(r.id), r])),
    variantes: new Map(variantes.rows.map((r) => [String(r.id), r])),
  };
}

/** Confere as pecas e preenche nome, rotulo, cor, tamanho e o preco do dia. */
async function conferirPecas(q, companyId, itens, agora = new Date()) {
  const cat = await lerCatalogo(q, companyId, itens.map((i) => i.product_id), itens.map((i) => i.variant_id));
  for (const it of itens) {
    const p = cat.produtos.get(it.product_id);
    if (!p || p.is_active === false) {
      throw erro(404, 'Produto não encontrado nesta loja.', 'PRODUCT_NOT_FOUND', { product_id: it.product_id });
    }
    it.nome = p.name;
    if (ehUnidadeServico(p.unit)) {
      throw erro(422, `"${p.name}" é serviço e não sai da loja em condicional.`, 'COND_ITEM_NAO_PECA');
    }
    if (p.sob_encomenda === true) {
      throw erro(422, `"${p.name}" é feita sob encomenda e não sai da loja em condicional.`, 'COND_ITEM_NAO_PECA');
    }
    if (it.variant_id) {
      const v = cat.variantes.get(it.variant_id);
      if (!v || String(v.product_id) !== it.product_id) {
        throw erro(422, `"${p.name}": essa cor ou tamanho não é deste produto.`, 'COND_ITEM_INVALIDO');
      }
      if (v.is_active === false) {
        throw erro(422, `"${p.name}": essa cor ou tamanho está desativado.`, 'COND_ITEM_INVALIDO');
      }
      it.variant_label = v.sku_suffix ? String(v.sku_suffix).slice(0, 120) : null;
      it.color_name = textoLimpo(v.color_name, 80) || textoLimpo(v.cor_atributo, 80);
      it.size_label = textoLimpo(v.tamanho, 40);
      it.unit_price = round2(precoEfetivoDaVariante(v, p, agora));
    } else {
      if (p.tem_grade === true) {
        throw erro(422, `"${p.name}": escolha a cor e o tamanho da peça.`, 'COND_VARIANTE_OBRIGATORIA');
      }
      it.variant_label = null;
      it.color_name = null;
      it.size_label = null;
      it.unit_price = round2(precoEfetivoDoProduto(p, agora));
    }
  }
  return itens;
}

/**
 * Dentro da transacao (com as travas por produto ja tomadas): conta o livre
 * de cada (produto, variante) e devolve o que falta ([] = tudo livre).
 */
async function conferirLivres(client, companyId, itens) {
  const linhas = new Map();
  for (const it of itens) {
    const k = `${it.product_id}|${it.variant_id || ''}`;
    const l = linhas.get(k) || { it, pedidas: 0 };
    l.pedidas += 1;
    linhas.set(k, l);
  }
  const pids = [...new Set(itens.map((i) => i.product_id))];
  const vids = [...new Set(itens.map((i) => i.variant_id).filter(Boolean))];
  const { rows: ps } = await client.query(`SELECT id, stock_qty FROM products WHERE id = ANY($1::uuid[])`, [pids]);
  const estoqueP = new Map(ps.map((r) => [String(r.id), Number(r.stock_qty) || 0]));
  let estoqueV = new Map();
  if (vids.length) {
    const { rows: vs } = await client.query(`SELECT id, stock_qty FROM product_variants WHERE id = ANY($1::uuid[])`, [vids]);
    estoqueV = new Map(vs.map((r) => [String(r.id), Number(r.stock_qty) || 0]));
  }
  const reservas = await lerReservas(client, companyId, pids);
  const fora = await comClientes.lerComClientes(client, companyId, pids);
  const faltas = [];
  for (const { it, pedidas } of linhas.values()) {
    const estoque = it.variant_id ? (estoqueV.get(it.variant_id) || 0) : (estoqueP.get(it.product_id) || 0);
    const reservado = reservadoDaVariante(reservas, it.product_id, it.variant_id);
    const comCliente = comClientes.comClientesDaVariante(fora, it.product_id, it.variant_id);
    const livre = Math.max(0, estoque - comCliente - reservado);
    if (livre < pedidas) {
      faltas.push({
        product_id: it.product_id,
        variant_id: it.variant_id || null,
        nome: it.nome + (it.variant_label ? ` (${it.variant_label})` : ''),
        pedidas,
        estoque,
        com_clientes: comCliente,
        reservado,
        livre,
        condicionais: [],
      });
    }
  }
  if (faltas.length) {
    const quem = await comClientes.lerQuemSegura(client, companyId, faltas.map((f) => f.product_id));
    for (const f of faltas) {
      const vistas = new Set();
      for (const r of quem) {
        if (String(r.product_id) !== f.product_id) continue;
        if (String(r.variant_id || '') !== String(f.variant_id || '')) continue;
        if (vistas.has(String(r.condicional_id))) continue;
        vistas.add(String(r.condicional_id));
        f.condicionais.push({
          id: r.condicional_id,
          company_id: r.company_id,
          numero: Number(r.numero),
          numero_exibicao: numeroExibicao(r.numero),
          customer_name: r.customer_name,
          due_date: r.due_date,
        });
      }
    }
  }
  return faltas;
}

function fraseDaFalta(f) {
  if (f.condicionais.length) {
    const nums = f.condicionais.map((c) => c.numero_exibicao).join(', ');
    return `"${f.nome}": está com cliente na ${nums}.`;
  }
  if (f.reservado > 0) return `"${f.nome}": está separada num pedido.`;
  return `"${f.nome}": sem unidade no estoque.`;
}

async function resolverCliente(q, companyId, dados) {
  const c = await findOwnerScopedCustomer(q, companyId, dados.customerId, 'id, name, phone');
  if (!c) throw erro(404, 'Cliente não encontrado nesta empresa.', 'CUSTOMER_NOT_FOUND');
  const nome = dados.customerName || textoLimpo(c.name, 255);
  if (!nome) throw erro(422, 'Falta o nome da cliente.', 'COND_CLIENTE_NOME');
  const bruto = dados.customerPhone !== null && dados.customerPhone !== undefined && String(dados.customerPhone).trim() !== ''
    ? dados.customerPhone : c.phone;
  const tel = normalizarTelefone(textoLimpo(bruto, 30));
  if (!tel.ok) throw erro(422, tel.error, tel.code);
  const telefone = telefoneValido(bruto);
  if (!telefone) {
    throw erro(422, 'Falta o telefone da cliente com DDD, como (11) 98888-7777. É por ele que você lembra a devolução.', 'COND_TELEFONE');
  }
  return { id: c.id, nome, telefone };
}

/** Os itens do corpo sao os mesmos da condicional gravada? (multiconjunto) */
function mesmasPecas(itensDoCorpo, itensGravados) {
  const k = (i) => `${i.product_id}|${i.variant_id || ''}`;
  const a = itensDoCorpo.map(k).sort();
  const b = (itensGravados || []).map(k).sort();
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

async function buscarPorChave(q, companyId, chave) {
  const { rows } = await q.query(
    `SELECT id FROM condicionais WHERE company_id = $1 AND idempotency_key = $2 LIMIT 1`,
    [companyId, chave]
  );
  return rows[0] || null;
}

async function responderRepeticao(companyId, ja, itensDoCorpo, hoje) {
  const cond = await lerCondicionalCompleta(db, companyId, ja.id, { hoje });
  if (!cond || !mesmasPecas(itensDoCorpo, cond.items)) {
    throw erro(409,
      `Já guardamos uma condicional${cond ? ` (${cond.numero_exibicao})` : ''} com outras peças nesta tentativa. Se esta for uma condicional nova, toque de novo em Guardar.`,
      'IDEMPOTENCY_KEY_REUSED',
      { condicional_id: ja.id });
  }
  return { status: 200, condicional: cond, repetido: true, avisos: [] };
}

const REPETIDO = Symbol('condicional-repetida');

/**
 * Guarda a condicional. Devolve { status: 201|200, condicional, repetido, avisos }.
 * Lanca erro com .status (4xx) para a rota responder.
 */
/**
 * O numero colidiu (alguem gravou condicional sem passar pela sequencia, ex.:
 * importacao): a sequencia da loja volta a partir do maior numero gravado.
 */
async function ressincronizarNumeracao(q, companyId) {
  await q.query(
    `INSERT INTO condicional_sequencias (company_id, ultimo)
     SELECT $1, COALESCE(MAX(numero), 0) FROM condicionais WHERE company_id = $1
     ON CONFLICT (company_id) DO UPDATE
       SET ultimo = GREATEST(condicional_sequencias.ultimo, EXCLUDED.ultimo), updated_at = NOW()`,
    [companyId]
  );
}

async function guardarCondicional(args) {
  const { companyId, userId, body, chave, hoje = hojeSP(), agora = new Date(), _tentativa = 1 } = args;
  const lido = lerCorpo(body, { hoje });
  if (lido.erro) throw erro(lido.erro.status, lido.erro.message, lido.erro.code);
  const dados = lido.dados;

  // Repeticao que chega depois da primeira ter terminado: responde logo.
  if (chave) {
    const ja = await buscarPorChave(db, companyId, chave);
    if (ja) return responderRepeticao(companyId, ja, dados.itens, hoje);
  }

  const { rows: [loja] } = await db.query(`SELECT pdv_settings FROM companies WHERE id = $1`, [companyId]);
  const settings = (loja && loja.pdv_settings) || {};
  const dueDate = dados.dueDate || somarDias(hoje, lerPrazoPadrao(settings));
  const termos = lerTermos(settings);
  const semEstoqueLiberado = lerVendaSemEstoque(settings);

  await conferirPecas(db, companyId, dados.itens, agora);
  const cliente = await resolverCliente(db, companyId, dados);

  const client = await db.connect();
  let condId;
  let repetidoDe = null;
  let numeroColidiu = false;
  let avisos = [];
  try {
    await client.query('BEGIN');
    if (chave) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`condicional:${companyId}:${chave}`]);
      const ja = await buscarPorChave(client, companyId, chave);
      if (ja) throw Object.assign(new Error('repetida'), { [REPETIDO]: ja });
    }
    // Uma condicional por vez em cada produto, em ordem fixa (sem deadlock).
    const pids = [...new Set(dados.itens.map((i) => i.product_id))].sort();
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('condicional-peca:' || s.pid))
         FROM (SELECT t.pid FROM unnest($1::text[]) WITH ORDINALITY AS t(pid, n) ORDER BY t.n) s`,
      [pids]
    );
    avisos = await conferirLivres(client, companyId, dados.itens);
    if (avisos.length && !semEstoqueLiberado) {
      throw erro(409, `Não dá para levar: ${avisos.map(fraseDaFalta).join(' ')}`, 'COND_SEM_SALDO', { faltas: avisos });
    }
    avisos = avisos.map((a) => ({ ...a, mensagem: AVISO_SEM_ESTOQUE }));

    const { rows: [seq] } = await client.query(
      `INSERT INTO condicional_sequencias (company_id, ultimo) VALUES ($1, 1)
       ON CONFLICT (company_id) DO UPDATE
         SET ultimo = condicional_sequencias.ultimo + 1, updated_at = NOW()
       RETURNING ultimo`,
      [companyId]
    );
    const { rows: [c] } = await client.query(
      `INSERT INTO condicionais
         (company_id, numero, customer_id, customer_name, customer_phone,
          seller_id, employee_id, seller_name, due_date, status, notes, terms_snapshot,
          created_by, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, 'aberta', $10, $11, $12, $13)
       RETURNING id`,
      [
        companyId, seq.ultimo, cliente.id, cliente.nome, cliente.telefone,
        dados.sellerId, dados.employeeId, dados.sellerName, dueDate, dados.notes, termos,
        userId || null, chave,
      ]
    );
    condId = c.id;
    const it = dados.itens;
    await client.query(
      `INSERT INTO condicional_itens
         (condicional_id, product_id, variant_id, product_name, variant_label, color_name, size_label, unit_price, situacao, added_at)
       SELECT $1, t.product_id, t.variant_id, t.product_name, t.variant_label, t.color_name, t.size_label, t.unit_price, 'com_cliente',
              -- 1 microssegundo por linha: as pecas voltam na ordem em que foram escolhidas.
              NOW() + (t.n * interval '1 microsecond')
         FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::numeric[])
              WITH ORDINALITY AS t(product_id, variant_id, product_name, variant_label, color_name, size_label, unit_price, n)
        ORDER BY t.n`,
      [
        condId,
        it.map((x) => x.product_id), it.map((x) => x.variant_id), it.map((x) => x.nome),
        it.map((x) => x.variant_label), it.map((x) => x.color_name), it.map((x) => x.size_label),
        it.map((x) => x.unit_price),
      ]
    );
    await client.query(
      `INSERT INTO condicional_eventos (condicional_id, company_id, tipo, dados, user_id)
       VALUES ($1, $2, 'criada', $3::jsonb, $4)`,
      [condId, companyId, JSON.stringify({
        pecas: it.length,
        total: round2(it.reduce((s, x) => s + x.unit_price, 0)),
        due_date: dueDate,
        ...(avisos.length ? { sem_saldo: avisos.length } : {}),
      }), userId || null]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e && e[REPETIDO]) repetidoDe = e[REPETIDO];
    else if (chave && e && e.code === '23505' && String(e.constraint || '') === INDICE_CHAVE) repetidoDe = 'buscar';
    else if (e && e.code === '23505' && String(e.constraint || '') === INDICE_NUMERO) numeroColidiu = true;
    else throw e;
  } finally {
    client.release();
  }
  if (numeroColidiu) {
    // Uma nova tentativa, com a sequencia acertada; colidiu de novo, 409 claro.
    if (_tentativa >= 2) {
      throw erro(409, 'Não deu para numerar a condicional agora. Toque de novo em Guardar.', 'COND_NUMERO_CONFLITO');
    }
    await ressincronizarNumeracao(db, companyId);
    return guardarCondicional({ ...args, _tentativa: _tentativa + 1 });
  }
  if (repetidoDe === 'buscar') {
    repetidoDe = await buscarPorChave(db, companyId, chave);
    if (!repetidoDe) throw erro(409, 'Esta condicional mudou enquanto era guardada. Tente de novo.', 'COND_CONFLITO');
  }
  if (repetidoDe) return responderRepeticao(companyId, repetidoDe, dados.itens, hoje);
  const condicional = await lerCondicionalCompleta(db, companyId, condId, { hoje, agora });
  return { status: 201, condicional, repetido: false, avisos };
}

// ─── Leitura ──────────────────────────────────────────────────

/**
 * Situacao mostrada (derivada, fuso de SP). Palavras da tela:
 *   com_cliente  "Com a cliente"  aberta, peca com ela, prazo nao venceu
 *   vence_hoje   "Vence hoje"     aberta, peca com ela, due_date = hoje
 *   atrasada     "Atrasada"       aberta, peca com ela, hoje > due_date (R11)
 *   a_cobrar     aberta sem peca com ela, mas com peca que "ficou" sem venda
 *   concluida    "Concluída"      encerrada (com ou sem venda)
 *   cancelada    "Cancelada"
 * parcial = aberta com parte das pecas ja decidida.
 */
function derivarSituacao({ status, due_date: due, com_cliente: comCliente = 0, decididas = 0 }, hoje = hojeSP()) {
  if (status === 'cancelada') return { situacao: 'cancelada', parcial: false, dias_de_atraso: 0 };
  if (status === 'encerrada') return { situacao: 'concluida', parcial: false, dias_de_atraso: 0 };
  const parcial = Number(decididas) > 0;
  if (!(Number(comCliente) > 0)) return { situacao: 'a_cobrar', parcial, dias_de_atraso: 0 };
  if (due && due < hoje) return { situacao: 'atrasada', parcial, dias_de_atraso: diasEntre(due, hoje) };
  if (due && due === hoje) return { situacao: 'vence_hoje', parcial, dias_de_atraso: 0 };
  return { situacao: 'com_cliente', parcial, dias_de_atraso: 0 };
}

/** Preco de hoje de cada (produto, variante) das pecas. Map 'pid|vid' -> preco (ou ausente). */
async function precosDeHoje(companyId, itens, agora = new Date()) {
  const mapa = new Map();
  const pids = [...new Set(itens.map((i) => i.product_id).filter(Boolean).map(String))];
  if (!pids.length) return mapa;
  const vids = [...new Set(itens.map((i) => i.variant_id).filter(Boolean).map(String))];
  const cat = await lerCatalogo(db, companyId, pids, vids);
  for (const it of itens) {
    const pid = String(it.product_id);
    const vid = it.variant_id ? String(it.variant_id) : '';
    const p = cat.produtos.get(pid);
    if (!p) continue;
    if (vid) {
      const v = cat.variantes.get(vid);
      if (!v || String(v.product_id) !== pid) continue;
      mapa.set(`${pid}|${vid}`, round2(precoEfetivoDaVariante(v, p, agora)));
    } else {
      mapa.set(`${pid}|`, round2(precoEfetivoDoProduto(p, agora)));
    }
  }
  return mapa;
}

function resumoDosItens(itens) {
  const r = { pecas: 0, com_cliente: 0, ficou: 0, a_cobrar: 0, voltou: 0, voltou_defeito: 0, valor_total: 0, valor_com_cliente: 0, valor_a_cobrar: 0 };
  for (const i of itens) {
    const preco = Number(i.unit_price) || 0;
    r.pecas += 1;
    r.valor_total += preco;
    if (i.situacao === 'com_cliente') { r.com_cliente += 1; r.valor_com_cliente += preco; }
    if (i.situacao === 'ficou') {
      r.ficou += 1;
      if (!i.sale_id) { r.a_cobrar += 1; r.valor_a_cobrar += preco; }
    }
    if (i.situacao === 'voltou') r.voltou += 1;
    if (i.situacao === 'voltou_defeito') r.voltou_defeito += 1;
  }
  r.valor_total = round2(r.valor_total);
  r.valor_com_cliente = round2(r.valor_com_cliente);
  r.valor_a_cobrar = round2(r.valor_a_cobrar);
  return r;
}

/** Linha do banco + itens + eventos -> corpo da resposta. */
function apresentarCondicional(c, itens, eventos, { hoje = hojeSP(), precos = null } = {}) {
  const items = (itens || []).map((i) => {
    const unitPrice = Number(i.unit_price);
    const chaveDoPreco = `${i.product_id}|${i.variant_id || ''}`;
    const precoHoje = precos && precos.has(chaveDoPreco) ? precos.get(chaveDoPreco) : null;
    return {
      id: i.id,
      product_id: i.product_id,
      variant_id: i.variant_id || null,
      product_name: i.product_name,
      variant_label: i.variant_label || null,
      color_name: i.color_name || null,
      size_label: i.size_label || null,
      unit_price: unitPrice,
      preco_hoje: precoHoje,
      preco_mudou: precoHoje !== null && Math.round(precoHoje * 100) !== Math.round(unitPrice * 100),
      situacao: i.situacao,
      defect_note: i.defect_note || null,
      decided_at: i.decided_at || null,
      decided_by: i.decided_by || null,
      sale_id: i.sale_id || null,
      added_at: i.added_at,
    };
  });
  const resumo = resumoDosItens(items);
  const sit = derivarSituacao({
    status: c.status, due_date: c.due_date, com_cliente: resumo.com_cliente,
    decididas: resumo.pecas - resumo.com_cliente,
  }, hoje);
  return {
    id: c.id,
    company_id: c.company_id,
    numero: Number(c.numero),
    numero_exibicao: numeroExibicao(c.numero),
    status: c.status,
    ...sit,
    customer_id: c.customer_id || null,
    customer_name: c.customer_name,
    customer_phone: c.customer_phone,
    seller_id: c.seller_id || null,
    employee_id: c.employee_id || null,
    seller_name: c.seller_name || null,
    due_date: c.due_date,
    notes: c.notes || null,
    terms: c.terms_snapshot || null,
    created_by: c.created_by || null,
    created_at: c.created_at,
    updated_at: c.updated_at,
    closed_at: c.closed_at || null,
    cancelled_at: c.cancelled_at || null,
    cancel_reason: c.cancel_reason || null,
    resumo,
    items,
    events: (eventos || []).map((e) => ({
      id: e.id,
      tipo: e.tipo,
      item_id: e.item_id || null,
      dados: e.dados || null,
      user_id: e.user_id || null,
      created_at: e.created_at,
    })),
  };
}

/** Condicional com pecas, eventos e o preco de hoje. null = nao e desta loja. */
async function lerCondicionalCompleta(q, companyId, condId, { hoje = hojeSP(), agora = new Date(), comPrecoDeHoje = true } = {}) {
  const { rows } = await q.query(
    `SELECT id, company_id, numero, customer_id, customer_name, customer_phone,
            seller_id, employee_id, seller_name, due_date::text AS due_date, status, notes,
            terms_snapshot, created_by, created_at, updated_at, closed_at, cancelled_at, cancel_reason
       FROM condicionais WHERE id = $1 AND company_id = $2`,
    [condId, companyId]
  );
  if (!rows.length) return null;
  const [{ rows: itens }, { rows: eventos }] = await Promise.all([
    q.query(
      `SELECT id, product_id, variant_id, product_name, variant_label, color_name, size_label,
              unit_price, situacao, defect_note, decided_at, decided_by, sale_id, added_at
         FROM condicional_itens WHERE condicional_id = $1 ORDER BY added_at, id`,
      [condId]
    ),
    q.query(
      `SELECT id, tipo, item_id, dados, user_id, created_at
         FROM condicional_eventos WHERE condicional_id = $1 ORDER BY created_at, id`,
      [condId]
    ),
  ]);
  let precos = null;
  if (comPrecoDeHoje) {
    try {
      precos = await precosDeHoje(companyId, itens, agora);
    } catch (e) {
      // O preco de hoje e so informativo: falhou, o detalhe sai sem ele.
      console.error('[condicional] preco de hoje indisponivel:', e && e.message);
    }
  }
  return apresentarCondicional(rows[0], itens, eventos, { hoje, precos });
}

module.exports = {
  MAX_PECAS,
  AVISO_SEM_ESTOQUE,
  PRAZO_PADRAO_DIAS,
  PRAZO_MAX_DIAS,
  TERMOS_MAX,
  condicionalLiberada,
  hojeSP,
  somarDias,
  diasEntre,
  numeroExibicao,
  lerPrazoPadrao,
  lerTermos,
  termosLimpos,
  lerChave,
  lerCorpo,
  telefoneValido,
  mesmasPecas,
  fraseDaFalta,
  guardarCondicional,
  derivarSituacao,
  resumoDosItens,
  apresentarCondicional,
  lerCondicionalCompleta,
};
