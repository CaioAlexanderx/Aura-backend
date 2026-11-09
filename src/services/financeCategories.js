// ============================================================
// AURA. — Categorias e subcategorias do Financeiro (migration 434)
//
// Criado: 09/11/2026. Aprovado pelo Caio (mockup
// mockup-categorias-financeiro.html: A gestao, B nova categoria, C escolha no
// lancamento, D relatorio, E migracao).
//
// O CONTRATO QUE NAO PODE QUEBRAR
//   transactions.category continua guardando o NOME DA CATEGORIA-MAE. Quem casa
//   por texto segue casando: 'Vendas' (pdv.js), 'Taxas de cartão' (taxa da
//   maquininha), ILIKE 'Crediario%A Receber%' (ledger, financialReceivables,
//   undoPayment, reschedule) e fornecedores/troca/devolucao
//   (services/resultadoDoPeriodo.js). A subcategoria mora so em category_id.
//   - As "usadas pela Aura" (is_system) NAO renomeiam nem arquivam: o nome
//     delas e o texto que esse codigo procura.
//   - Renomear uma categoria DA LOJA reescreve o texto dos lancamentos dela
//     (decisao 2 do Caio). "Juntar" move os lancamentos e reescreve o texto
//     dos que mudaram. Arquivar nao mexe em lancamento nenhum.
//
// POR LOJA (decisao 1): tudo escopado pela empresa da URL. "Em todas as
// minhas lojas" cria a mesma categoria nas empresas do mesmo dono
// (getOwnerScopedCompanyIds). No consolidado, nomes iguais somam juntos (o
// app agrupa pelo nome normalizado).
//
// PADROES PREGUICOSOS: a primeira leitura da empresa semeia a lista padrao
// (com subcategorias sugeridas). Toda escrita chama garantirPadroes antes,
// para que a primeira categoria criada de outra loja nao impeca a semeadura
// dela.
//
// LANCAMENTOS ANTIGOS: ligados por scripts/migrar-categorias-financeiro.js
// (dry-run por padrao). Ate la a contagem da gestao casa o texto pelo mesmo
// resolverTexto() que o script usa, entao os numeros ja saem certos.
// ============================================================
'use strict';

const db = require('../config/database');

// ── Normalizacao (espelho de finance_category_norm, migration 434) ──────
function normalizarNome(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function limparNome(s) {
  return String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
}

// ── Linhas do DRE (substituem o dre_category_map, que tem 0 linhas) ─────
const DRE_LINES = {
  income: [
    { key: 'receita_vendas', label: 'Receita de vendas' },
    { key: 'receita_servicos', label: 'Receita de serviços' },
    { key: 'outras_receitas', label: 'Outras receitas' },
    { key: 'deducoes', label: 'Devoluções e abatimentos' },
  ],
  expense: [
    { key: 'compras_mercadoria', label: 'Compras de mercadoria' },
    { key: 'despesas_variaveis', label: 'Despesas variáveis' },
    { key: 'despesas_fixas', label: 'Despesas fixas' },
    { key: 'pessoal', label: 'Pessoal' },
    { key: 'impostos', label: 'Impostos' },
    { key: 'despesas_financeiras', label: 'Despesas financeiras' },
    { key: 'deducoes', label: 'Devoluções e abatimentos' },
    { key: 'outras_despesas', label: 'Outras despesas' },
  ],
};
// Categoria nova: despesa entra como variavel, receita como outras receitas.
const DRE_PADRAO = { income: 'outras_receitas', expense: 'despesas_variaveis' };

function dreLineValida(kind, key) {
  return (DRE_LINES[kind] || []).some(function (l) { return l.key === key; });
}
function rotuloDaDre(kind, key) {
  const l = (DRE_LINES[kind] || []).find(function (x) { return x.key === key; });
  return l ? l.label : null;
}

const CORES = ['#7c3aed', '#dc2626', '#059669', '#d97706', '#0891b2', '#db2777', '#64748b', '#a1a1aa'];
const COR_RE = /^#[0-9a-f]{6}$/i;

// ── Lista padrao (mockup, secao A) ──────────────────────────────────────
// system = "usada pela Aura": o Caixa, o Crediario, a troca, a taxa da
// maquininha e o resultado do periodo contam com o nome dela.
const PADROES = [
  { kind: 'expense', name: 'Fornecedores', color: '#dc2626', dre: 'compras_mercadoria', system: true, subs: ['Mercadoria para revenda', 'Embalagens'] },
  { kind: 'expense', name: 'Fixas', color: '#7c3aed', dre: 'despesas_fixas', subs: ['Aluguel', 'Energia', 'Internet e telefone', 'Contador'] },
  { kind: 'expense', name: 'Folha', color: '#059669', dre: 'pessoal', subs: ['Salários', 'Pró-labore', 'Comissões'] },
  { kind: 'expense', name: 'Impostos', color: '#d97706', dre: 'impostos', subs: ['DAS do Simples'] },
  { kind: 'expense', name: 'Taxas de cartão', color: '#0891b2', dre: 'despesas_financeiras', system: true, subs: [] },
  { kind: 'expense', name: 'Marketing', color: '#db2777', dre: 'despesas_variaveis', subs: ['Anúncios'] },
  { kind: 'expense', name: 'Operacional', color: '#64748b', dre: 'despesas_variaveis', subs: ['Frete e entregas', 'Manutenção'] },
  { kind: 'expense', name: 'Trocas e devoluções', color: '#a855f7', dre: 'deducoes', system: true, subs: [] },
  { kind: 'expense', name: 'Outros', color: '#a1a1aa', dre: 'outras_despesas', system: true, subs: [] },
  { kind: 'income', name: 'Vendas', color: '#059669', dre: 'receita_vendas', system: true, subs: ['Balcão', 'Loja online'] },
  { kind: 'income', name: 'Serviços', color: '#7c3aed', dre: 'receita_servicos', subs: ['Ajustes e consertos'] },
  { kind: 'income', name: 'Crediário', color: '#d97706', dre: 'receita_vendas', system: true, subs: [] },
  { kind: 'income', name: 'Investimentos', color: '#0891b2', dre: 'outras_receitas', subs: ['Dinheiro do sócio', 'Rendimentos'] },
  { kind: 'income', name: 'Trocas e devoluções', color: '#a855f7', dre: 'deducoes', system: true, subs: [] },
  { kind: 'income', name: 'Outros', color: '#a1a1aa', dre: 'outras_receitas', system: true, subs: [] },
];
const SISTEMA = PADROES.filter(function (p) { return p.system; });

// Usadas pela Aura que nao aparecem na escolha manual do lancamento: quem
// grava e o proprio sistema (troca/devolucao e a taxa da maquininha). O app
// ainda mostra a categoria se ela ja for a do lancamento em edicao.
const FORA_DA_ESCOLHA = ['trocas e devolucoes', 'taxas de cartao'];
// E nao recebem "Juntar": o texto delas seria reescrito para um nome que o
// resultado do periodo nao reconhece como troca.
const NAO_RECEBE_JUNCAO = ['trocas e devolucoes'];

function naEscolhaManual(cat) {
  return !(cat.is_system && FORA_DA_ESCOLHA.indexOf(cat.name_norm) !== -1);
}

// ── Textos que nao casam pelo nome mas tem dono certo (mockup, secao E) ─
// [categoria-mae, subcategoria?] em nome normalizado, por tipo. Chaves do
// "Categorizar com IA" (categorize.js, snake_case) e o 'purchase' da
// importacao de NF-e (importData.js) entram aqui.
const APELIDOS = {
  income: {
    'canal digital': ['vendas', 'loja online'],
    venda: ['vendas'],
    servico: ['servicos'],
    servico_pj: ['servicos'],
    receita_diversa: ['outros'],
    outros: ['outros'],
  },
  expense: {
    purchase: ['fornecedores'],
    fornecedor: ['fornecedores'],
    compra_produto: ['fornecedores', 'mercadoria para revenda'],
    mercadoria: ['fornecedores', 'mercadoria para revenda'],
    estoque: ['fornecedores', 'mercadoria para revenda'],
    imposto: ['impostos'],
    das: ['impostos', 'das do simples'],
    folha: ['folha'],
    salario: ['folha', 'salarios'],
    prolabore: ['folha', 'pro-labore'],
    comissao: ['folha', 'comissoes'],
    inss: ['folha'],
    fgts: ['folha'],
    aluguel: ['fixas', 'aluguel'],
    energia: ['fixas', 'energia'],
    internet: ['fixas', 'internet e telefone'],
    telefone: ['fixas', 'internet e telefone'],
    seguro: ['fixas'],
    assinatura: ['fixas'],
    marketing: ['marketing'],
    frete: ['operacional', 'frete e entregas'],
    manutencao: ['operacional', 'manutencao'],
    juros: ['outros'],
    emprestimo: ['outros'],
    tarifa: ['outros'],
    outros: ['outros'],
  },
};

// Textos da federacao de karate (anuidade): fora da migracao.
function foraDaMigracao(texto) {
  const n = normalizarNome(texto);
  return !n || /^annuity_/.test(n) || n === 'anuidade';
}

// ── Indice em memoria das categorias de uma loja ────────────────────────
// So as NAO arquivadas resolvem texto.
function montarIndice(rows) {
  const porId = new Map();
  const topo = new Map();      // 'kind|norm' -> categoria de 1o nivel
  const subs = new Map();      // parentId -> Map(norm -> sub)
  rows.forEach(function (r) { porId.set(r.id, r); });
  rows.forEach(function (r) {
    if (r.archived_at) return;
    if (!r.parent_id) topo.set(r.kind + '|' + r.name_norm, r);
    else {
      if (!subs.has(r.parent_id)) subs.set(r.parent_id, new Map());
      subs.get(r.parent_id).set(r.name_norm, r);
    }
  });
  return { porId: porId, topo: topo, subs: subs };
}

/**
 * Para onde vai um texto de categoria antigo.
 * @returns {object|null} a categoria (ou subcategoria) que o texto ganha, ou
 *   null quando nao casa com nada (vira categoria da loja na migracao).
 */
function resolverTexto(kind, texto, indice) {
  const n = normalizarNome(texto);
  if (!n) return null;
  const direto = indice.topo.get(kind + '|' + n);
  if (direto) return direto;
  let alvo = null;
  if (/^crediario/.test(n)) alvo = kind === 'income' ? ['crediario'] : null;
  else if (/^troca/.test(n) || /^devolu/.test(n)) alvo = ['trocas e devolucoes'];
  else if (APELIDOS[kind] && APELIDOS[kind][n]) alvo = APELIDOS[kind][n];
  else if (APELIDOS[kind] && APELIDOS[kind][n.replace(/\s+/g, '_')]) alvo = APELIDOS[kind][n.replace(/\s+/g, '_')];
  if (!alvo) return null;
  const mae = indice.topo.get(kind + '|' + alvo[0]);
  if (!mae) return null;
  if (alvo[1]) {
    const sub = (indice.subs.get(mae.id) || new Map()).get(alvo[1]);
    if (sub) return sub;
  }
  return mae;
}

// ── Transacao com o pool ────────────────────────────────────────────────
async function comTransacao(fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ja caiu */ }
    throw e;
  } finally {
    client.release();
  }
}

// ── Semeadura preguicosa ────────────────────────────────────────────────
const semeadas = new Set();
function _resetCache() { semeadas.clear(); }

// Duas idas: as maes, depois as subcategorias (o gatilho de 2 niveis le a
// mae, entao ela precisa existir num comando anterior). Roda uma vez na vida
// de cada loja. So ganha subcategoria sugerida a mae criada AGORA — categoria
// que a loja ja tinha nao recebe sugestao.
const SQL_SEMEAR_MAES = `
  INSERT INTO finance_categories (company_id, kind, name, name_norm, color, dre_line, is_system, sort_order)
  SELECT $1, d.kind, d.name, finance_category_norm(d.name), d.color, d.dre_line, d.is_system, d.sort_order
    FROM jsonb_to_recordset($2::jsonb)
      AS d(kind text, name text, color text, dre_line text, is_system boolean, sort_order int)
   WHERE NOT EXISTS (
     SELECT 1 FROM finance_categories f
      WHERE f.company_id = $1 AND f.kind = d.kind AND f.parent_id IS NULL
        AND f.archived_at IS NULL AND f.name_norm = finance_category_norm(d.name))
  RETURNING id, kind, name_norm`;

const SQL_SEMEAR_SUBS = `
  INSERT INTO finance_categories (company_id, kind, parent_id, name, name_norm, sort_order)
  SELECT $1, f.kind, f.id, d.name, finance_category_norm(d.name), d.sort_order
    FROM jsonb_to_recordset($2::jsonb) AS d(kind text, name text, parent text, sort_order int)
    JOIN finance_categories f
      ON f.company_id = $1 AND f.kind = d.kind AND f.parent_id IS NULL AND f.archived_at IS NULL
     AND f.name_norm = finance_category_norm(d.parent)
   WHERE f.id = ANY($3::uuid[])`;

function linhasDosPadroes(lista) {
  const out = [];
  lista.forEach(function (p, i) {
    out.push({ kind: p.kind, name: p.name, color: p.color, dre_line: p.dre, is_system: !!p.system, sort_order: (i + 1) * 10, parent: null });
    (p.subs || []).forEach(function (s, j) {
      out.push({ kind: p.kind, name: s, color: null, dre_line: null, is_system: false, sort_order: (j + 1) * 10, parent: p.name });
    });
  });
  return out;
}

/**
 * Garante a lista padrao da loja. Loja sem nenhuma categoria ganha a lista
 * inteira; loja que ja tem, ganha so as "usadas pela Aura" que faltarem.
 * Idempotente (trava por loja). `client` opcional: dentro de uma transacao.
 */
async function garantirPadroes(companyId, client) {
  if (semeadas.has(companyId)) return false;
  const q = client || db;
  const c = await q.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE is_system AND parent_id IS NULL AND archived_at IS NULL)::int AS sistema
       FROM finance_categories WHERE company_id = $1`,
    [companyId]
  );
  if (c.rows[0].sistema >= SISTEMA.length) { semeadas.add(companyId); return false; }
  async function semear(cli) {
    await cli.query("SELECT pg_advisory_xact_lock(hashtext('finance_categories:' || $1::text))", [companyId]);
    const again = await cli.query('SELECT COUNT(*)::int AS total FROM finance_categories WHERE company_id = $1', [companyId]);
    const lista = again.rows[0].total === 0 ? PADROES : SISTEMA.map(function (p) { return Object.assign({}, p, { subs: [] }); });
    const linhas = linhasDosPadroes(lista);
    const maes = await cli.query(SQL_SEMEAR_MAES, [companyId, JSON.stringify(linhas.filter(function (l) { return !l.parent; }))]);
    const subs = linhas.filter(function (l) { return l.parent; });
    if (subs.length && maes.rows.length) {
      await cli.query(SQL_SEMEAR_SUBS, [companyId, JSON.stringify(subs), maes.rows.map(function (m) { return m.id; })]);
    }
  }
  if (client) await semear(client);
  else await comTransacao(semear);
  semeadas.add(companyId);
  return true;
}

async function lerCategorias(companyId, q) {
  const r = await (q || db).query(
    `SELECT id, company_id, kind, parent_id, name, name_norm, color, dre_line, is_system, sort_order, archived_at, created_at, updated_at
       FROM finance_categories WHERE company_id = $1
      ORDER BY kind, sort_order, name`,
    [companyId]
  );
  return r.rows;
}

function publica(c) {
  return {
    id: c.id, kind: c.kind, parent_id: c.parent_id || null, name: c.name,
    color: c.color || null, dre_line: c.dre_line || null, dre_label: rotuloDaDre(c.kind, c.dre_line),
    is_system: !!c.is_system, manual: naEscolhaManual(c), sort_order: c.sort_order,
    archived_at: c.archived_at || null,
  };
}

// Contagem do ano corrente, por categoria. Lancamento ja ligado conta pelo
// category_id; o que ainda nao foi ligado conta pelo texto, com a MESMA
// regra da migracao (resolverTexto).
async function contarDoAno(companyId, indice) {
  const r = await db.query(
    `SELECT category_id, type::text AS kind, category, COUNT(*)::int AS n
       FROM transactions
      WHERE company_id = $1
        AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date)
            >= date_trunc('year', NOW() AT TIME ZONE 'America/Sao_Paulo')::date
      GROUP BY 1, 2, 3`,
    [companyId]
  );
  const porCat = new Map();
  r.rows.forEach(function (row) {
    let alvo = row.category_id ? indice.porId.get(row.category_id) : null;
    if (!alvo && !row.category_id && !foraDaMigracao(row.category)) alvo = resolverTexto(row.kind, row.category, indice);
    if (!alvo) return;
    porCat.set(alvo.id, (porCat.get(alvo.id) || 0) + row.n);
  });
  return porCat;
}

function montarArvore(rows, contagem, incluirArquivadas) {
  const visiveis = rows.filter(function (c) { return incluirArquivadas || !c.archived_at; });
  const pais = visiveis.filter(function (c) { return !c.parent_id; });
  return pais.map(function (p) {
    const subs = visiveis.filter(function (s) { return s.parent_id === p.id; }).map(function (s) {
      return Object.assign(publica(s), { count: contagem ? (contagem.get(s.id) || 0) : 0 });
    });
    const direto = contagem ? (contagem.get(p.id) || 0) : 0;
    const total = direto + subs.reduce(function (a, s) { return a + s.count; }, 0);
    return Object.assign(publica(p), { count: total, count_direct: direto, subcategories: subs });
  });
}

async function lojasDoDono(companyId) {
  const { getOwnerScopedCompanyIds } = require('../utils/ownerScope');
  return getOwnerScopedCompanyIds(companyId);
}

/** GET /finance-categories */
async function listar(companyId, opts) {
  opts = opts || {};
  await garantirPadroes(companyId);
  const rows = await lerCategorias(companyId);
  const indice = montarIndice(rows);
  const res = await Promise.all([
    opts.semContagem ? Promise.resolve(null) : contarDoAno(companyId, indice),
    opts.semLojas ? Promise.resolve([companyId]) : lojasDoDono(companyId),
  ]);
  let arvore = montarArvore(rows, res[0], !!opts.incluirArquivadas);
  if (opts.kind === 'income' || opts.kind === 'expense') arvore = arvore.filter(function (c) { return c.kind === opts.kind; });
  return {
    categories: arvore,
    ano: Number(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).slice(0, 4)),
    lojas: res[1].length,
    dre_lines: DRE_LINES,
  };
}

// ── Erros de negocio ────────────────────────────────────────────────────
function erro(status, message, code) {
  const e = new Error(message);
  e.status = status; e.code_negocio = code || null;
  return e;
}

function traduzirErroPg(e) {
  if (e && e.code === '23505') return erro(409, 'Já existe uma categoria com esse nome aqui.', 'CATEGORY_EXISTS');
  if (e && e.code === '23514') return erro(400, 'Subcategoria só vale dentro de uma categoria principal do mesmo tipo.', 'CATEGORY_DEPTH');
  return e;
}

function validarNome(nome) {
  const n = limparNome(nome);
  if (!n) throw erro(400, 'Dê um nome para a categoria.', 'NAME_REQUIRED');
  if (n.length > 60) throw erro(400, 'O nome pode ter até 60 letras.', 'NAME_TOO_LONG');
  return n;
}

async function buscar(companyId, id, q) {
  const r = await (q || db).query(
    `SELECT id, company_id, kind, parent_id, name, name_norm, color, dre_line, is_system, sort_order, archived_at
       FROM finance_categories WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  return r.rows[0] || null;
}

/**
 * POST /finance-categories
 * body: { kind, name, parent_id?, color?, dre_line?, subcategories?: string[],
 *         todas_as_lojas?: boolean }
 * "Em todas as minhas lojas" so para categoria principal, e so para o dono
 * (ou staff): cria nas empresas do mesmo dono; onde ja existe, pula.
 */
async function criar(companyId, body, ctx) {
  ctx = ctx || {};
  body = body || {};
  const nome = validarNome(body.name);
  const parentId = body.parent_id || null;
  let kind = body.kind;
  if (!parentId && kind !== 'income' && kind !== 'expense') throw erro(400, 'kind deve ser income ou expense');
  if (body.color != null && body.color !== '' && !COR_RE.test(String(body.color))) throw erro(400, 'Cor inválida (use #RRGGBB)');
  const subNomes = Array.isArray(body.subcategories) ? body.subcategories.map(limparNome).filter(Boolean) : [];
  if (subNomes.some(function (s) { return s.length > 60; })) throw erro(400, 'O nome pode ter até 60 letras.', 'NAME_TOO_LONG');
  if (subNomes.length > 30) throw erro(400, 'No máximo 30 subcategorias de uma vez');

  await garantirPadroes(companyId);
  let pai = null;
  if (parentId) {
    pai = await buscar(companyId, parentId);
    if (!pai) throw erro(404, 'Categoria não encontrada');
    if (pai.parent_id) throw erro(400, 'Subcategoria só vale dentro de uma categoria principal.', 'CATEGORY_DEPTH');
    if (pai.archived_at) throw erro(409, 'Essa categoria está arquivada.', 'CATEGORY_ARCHIVED');
    kind = pai.kind;
  }
  const dre = parentId ? null : (body.dre_line && dreLineValida(kind, body.dre_line) ? body.dre_line : DRE_PADRAO[kind]);
  if (!parentId && body.dre_line && !dreLineValida(kind, body.dre_line)) throw erro(400, 'Linha do DRE inválida');
  const cor = body.color ? String(body.color).toLowerCase() : (parentId ? null : CORES[0]);

  let lojas = [companyId];
  if (body.todas_as_lojas && !parentId) {
    if (ctx.role !== 'owner' && ctx.role !== 'admin') throw erro(403, 'Só o dono cria categoria em todas as lojas.', 'OWNER_ONLY');
    lojas = await lojasDoDono(companyId);
    if (lojas.indexOf(companyId) === -1) lojas.unshift(companyId);
    else lojas = [companyId].concat(lojas.filter(function (x) { return x !== companyId; }));
  }

  const criadasEm = [];
  const jaExistiaEm = [];
  let criada = null;
  for (let i = 0; i < lojas.length; i += 1) {
    const loja = lojas[i];
    if (loja !== companyId) await garantirPadroes(loja);
    try {
      const out = await comTransacao(async function (cli) {
        const ins = await cli.query(
          `INSERT INTO finance_categories (company_id, kind, parent_id, name, name_norm, color, dre_line, sort_order)
           VALUES ($1, $2, $3, $4, finance_category_norm($4), $5, $6,
                   COALESCE((SELECT MAX(sort_order) FROM finance_categories
                              WHERE company_id = $1 AND kind = $2
                                AND COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)
                                  = COALESCE($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)), 0) + 10)
           RETURNING *`,
          [loja, kind, loja === companyId ? parentId : null, nome, cor, dre]
        );
        const cat = ins.rows[0];
        const subs = [];
        const vistos = new Set();
        for (let j = 0; j < subNomes.length; j += 1) {
          const k = normalizarNome(subNomes[j]);
          if (vistos.has(k)) continue;
          vistos.add(k);
          const s = await cli.query(
            `INSERT INTO finance_categories (company_id, kind, parent_id, name, name_norm, sort_order)
             VALUES ($1, $2, $3, $4, finance_category_norm($4), $5) RETURNING *`,
            [loja, kind, cat.id, subNomes[j], (subs.length + 1) * 10]
          );
          subs.push(s.rows[0]);
        }
        return { cat: cat, subs: subs };
      });
      criadasEm.push(loja);
      if (loja === companyId) {
        criada = Object.assign(publica(out.cat), {
          count: 0, count_direct: 0,
          subcategories: out.subs.map(function (s) { return Object.assign(publica(s), { count: 0 }); }),
        });
      }
    } catch (e) {
      const t = traduzirErroPg(e);
      if (loja === companyId) throw t;
      if (t.code_negocio === 'CATEGORY_EXISTS') { jaExistiaEm.push(loja); continue; }
      throw t;
    }
  }
  return { category: criada, criadas_em: criadasEm, ja_existia_em: jaExistiaEm };
}

/**
 * PATCH /finance-categories/:catId
 * body: { name?, color?, dre_line?, sort_order?, archived?: boolean }
 */
async function atualizar(companyId, catId, body) {
  body = body || {};
  await garantirPadroes(companyId);
  return comTransacao(async function (cli) {
    const cat = await buscar(companyId, catId, cli);
    if (!cat) throw erro(404, 'Categoria não encontrada');
    let renomeou = null;
    const sets = []; const vals = [];
    function set(col, v) { vals.push(v); sets.push(col + ' = $' + vals.length); }

    if (body.name !== undefined) {
      const nome = validarNome(body.name);
      if (nome !== cat.name) {
        if (cat.is_system) throw erro(409, 'Essa categoria é usada pela Aura e não muda de nome.', 'CATEGORY_SYSTEM');
        set('name', nome);
        set('name_norm', normalizarNome(nome));
        renomeou = nome;
      }
    }
    if (body.color !== undefined) {
      if (body.color !== null && body.color !== '' && !COR_RE.test(String(body.color))) throw erro(400, 'Cor inválida (use #RRGGBB)');
      set('color', body.color ? String(body.color).toLowerCase() : null);
    }
    if (body.dre_line !== undefined) {
      if (cat.parent_id) throw erro(400, 'Subcategoria segue a linha do DRE da categoria principal');
      if (!dreLineValida(cat.kind, body.dre_line)) throw erro(400, 'Linha do DRE inválida');
      set('dre_line', body.dre_line);
    }
    if (body.sort_order !== undefined) {
      const so = parseInt(body.sort_order, 10);
      if (!Number.isFinite(so)) throw erro(400, 'sort_order inválido');
      set('sort_order', so);
    }
    let arquivar = null;
    if (body.archived !== undefined) {
      arquivar = !!body.archived;
      if (arquivar && cat.is_system) throw erro(409, 'Essa categoria é usada pela Aura e não sai da lista.', 'CATEGORY_SYSTEM');
      if (!arquivar && cat.archived_at && cat.parent_id) {
        const pai = await buscar(companyId, cat.parent_id, cli);
        if (pai && pai.archived_at) throw erro(409, 'Desarquive a categoria principal primeiro.', 'PARENT_ARCHIVED');
      }
      if (arquivar && !cat.archived_at) sets.push('archived_at = NOW()');
      if (!arquivar && cat.archived_at) sets.push('archived_at = NULL');
    }
    if (!sets.length) return { category: publica(cat), lancamentos_renomeados: 0 };

    vals.push(catId, companyId);
    let upd;
    try {
      upd = await cli.query(
        'UPDATE finance_categories SET ' + sets.join(', ') + ' WHERE id = $' + (vals.length - 1) + ' AND company_id = $' + vals.length + ' RETURNING *',
        vals
      );
    } catch (e) { throw traduzirErroPg(e); }

    if (arquivar === true && !cat.parent_id) {
      await cli.query(
        'UPDATE finance_categories SET archived_at = NOW() WHERE parent_id = $1 AND company_id = $2 AND archived_at IS NULL',
        [catId, companyId]
      );
    }

    // Decisao 2: renomear categoria DA LOJA reescreve o texto dos lancamentos
    // dela (os ligados, os das subcategorias e os antigos que casam pelo
    // nome velho — esses ganham a ligacao junto). Subcategoria nao tem
    // texto proprio no lancamento: nada a reescrever.
    let renomeados = 0;
    if (renomeou && !cat.parent_id) {
      const r = await cli.query(
        `UPDATE transactions t
            SET category = $3, category_id = COALESCE(t.category_id, $1), updated_at = NOW()
          WHERE t.company_id = $2
            AND (t.category_id = $1
                 OR t.category_id IN (SELECT id FROM finance_categories WHERE parent_id = $1 AND company_id = $2)
                 OR (t.category_id IS NULL AND t.type::text = $4 AND finance_category_norm(t.category) = $5))`,
        [catId, companyId, renomeou, cat.kind, cat.name_norm]
      );
      renomeados = r.rowCount || 0;
    }
    return { category: publica(upd.rows[0]), lancamentos_renomeados: renomeados };
  });
}

/**
 * POST /finance-categories/:catId/merge  { target_id }
 * Move os lancamentos da origem para o destino e arquiva a origem.
 *   principal -> principal: as subcategorias vao junto (a de mesmo nome se
 *     funde com a do destino); os lancamentos ganham o texto do destino.
 *   sub -> sub (de qualquer mae do mesmo tipo) ou sub -> principal.
 *   principal -> sub: recusado.
 */
async function juntar(companyId, catId, targetId) {
  if (!targetId) throw erro(400, 'Escolha com qual categoria juntar');
  if (targetId === catId) throw erro(400, 'Escolha outra categoria');
  await garantirPadroes(companyId);
  return comTransacao(async function (cli) {
    const src = await buscar(companyId, catId, cli);
    const dst = await buscar(companyId, targetId, cli);
    if (!src || !dst) throw erro(404, 'Categoria não encontrada');
    if (src.kind !== dst.kind) throw erro(400, 'Só dá para juntar despesa com despesa e receita com receita');
    if (src.is_system) throw erro(409, 'Essa categoria é usada pela Aura e não sai da lista.', 'CATEGORY_SYSTEM');
    if (dst.archived_at) throw erro(409, 'A categoria de destino está arquivada.', 'CATEGORY_ARCHIVED');
    if (dst.is_system && NAO_RECEBE_JUNCAO.indexOf(dst.name_norm) !== -1) throw erro(409, 'Essa categoria é preenchida só pela Aura.', 'CATEGORY_SYSTEM');
    if (!src.parent_id && dst.parent_id) throw erro(400, 'Escolha uma categoria principal para juntar.', 'MERGE_INTO_SUB');
    // sub -> a propria mae cai no ramo de baixo: vira "sem subcategoria".
    const maeDst = dst.parent_id ? await buscar(companyId, dst.parent_id, cli) : dst;
    let movidos = 0;

    if (!src.parent_id) {
      // Antigos so por texto ganham a ligacao antes de mudar de lugar.
      await cli.query(
        `UPDATE transactions SET category_id = $1
          WHERE company_id = $2 AND category_id IS NULL AND type::text = $3 AND finance_category_norm(category) = $4`,
        [src.id, companyId, src.kind, src.name_norm]
      );
      const subsSrc = (await cli.query('SELECT * FROM finance_categories WHERE parent_id = $1 AND company_id = $2', [src.id, companyId])).rows;
      const subsDst = (await cli.query('SELECT * FROM finance_categories WHERE parent_id = $1 AND company_id = $2 AND archived_at IS NULL', [dst.id, companyId])).rows;
      for (let i = 0; i < subsSrc.length; i += 1) {
        const x = subsSrc[i];
        const igual = subsDst.find(function (y) { return y.name_norm === x.name_norm; });
        if (igual) {
          const r = await cli.query(
            'UPDATE transactions SET category_id = $1, category = $2, updated_at = NOW() WHERE category_id = $3 AND company_id = $4',
            [igual.id, dst.name, x.id, companyId]
          );
          movidos += r.rowCount || 0;
          await cli.query('UPDATE finance_categories SET archived_at = COALESCE(archived_at, NOW()) WHERE id = $1', [x.id]);
        } else {
          try {
            await cli.query('UPDATE finance_categories SET parent_id = $1 WHERE id = $2', [dst.id, x.id]);
          } catch (e) { throw traduzirErroPg(e); }
          const r = await cli.query(
            'UPDATE transactions SET category = $1, updated_at = NOW() WHERE category_id = $2 AND company_id = $3',
            [dst.name, x.id, companyId]
          );
          movidos += r.rowCount || 0;
        }
      }
      const r = await cli.query(
        'UPDATE transactions SET category_id = $1, category = $2, updated_at = NOW() WHERE category_id = $3 AND company_id = $4',
        [dst.id, dst.name, src.id, companyId]
      );
      movidos += r.rowCount || 0;
    } else {
      const r = await cli.query(
        'UPDATE transactions SET category_id = $1, category = $2, updated_at = NOW() WHERE category_id = $3 AND company_id = $4',
        [dst.id, maeDst.name, src.id, companyId]
      );
      movidos += r.rowCount || 0;
    }
    await cli.query('UPDATE finance_categories SET archived_at = COALESCE(archived_at, NOW()) WHERE id = $1', [src.id]);
    return { moved: movidos, target: publica(dst) };
  });
}

// ── Migracao dos lancamentos antigos (script) ───────────────────────────
// Plano puro (so leitura). Sem categorias ainda, simula a lista padrao em
// memoria — o dry-run fala do que o --apply faria.
function categoriasSimuladas(companyId) {
  const rows = [];
  let n = 0;
  linhasDosPadroes(PADROES).forEach(function (l) {
    n += 1;
    const id = 'simulada-' + n;
    const pai = l.parent ? rows.find(function (r) { return !r.parent_id && r.kind === l.kind && r.name === l.parent; }) : null;
    rows.push({ id: id, company_id: companyId, kind: l.kind, parent_id: pai ? pai.id : null, name: l.name, name_norm: normalizarNome(l.name), is_system: l.is_system, archived_at: null });
  });
  return rows;
}

async function lerTextosSemLigacao(companyId, q) {
  const r = await (q || db).query(
    `SELECT type::text AS kind, category, COUNT(*)::int AS n
       FROM transactions
      WHERE company_id = $1 AND category_id IS NULL
        AND category IS NOT NULL AND btrim(category) <> ''
      GROUP BY 1, 2
      ORDER BY 3 DESC`,
    [companyId]
  );
  return r.rows.filter(function (x) { return !foraDaMigracao(x.category); });
}

/**
 * Plano de uma loja: cada texto antigo -> categoria (existente ou a criar).
 * Nao escreve nada.
 */
async function planejarMigracao(companyId, q) {
  let rows = await lerCategorias(companyId, q);
  const simulada = rows.length === 0;
  if (simulada) rows = categoriasSimuladas(companyId);
  const indice = montarIndice(rows);
  const textos = await lerTextosSemLigacao(companyId, q);
  const ligar = [];
  const criar = new Map(); // 'kind|norm' -> { kind, name, n, textos: [] }
  textos.forEach(function (t) {
    const alvo = resolverTexto(t.kind, t.category, indice);
    if (alvo) {
      const mae = alvo.parent_id ? indice.porId.get(alvo.parent_id) : null;
      ligar.push({ kind: t.kind, texto: t.category, n: t.n, categoria: mae ? mae.name + ' › ' + alvo.name : alvo.name, category_id: alvo.id });
    } else {
      const k = t.kind + '|' + normalizarNome(t.category);
      if (!criar.has(k)) criar.set(k, { kind: t.kind, name: limparNome(t.category).slice(0, 60), n: 0, textos: [] });
      const c = criar.get(k); c.n += t.n; c.textos.push(t.category);
    }
  });
  return { company_id: companyId, semeia_padroes: simulada, ligar: ligar, criar: Array.from(criar.values()) };
}

/**
 * Aplica o plano de uma loja numa transacao. Idempotente: so toca
 * lancamento com category_id NULL e nunca reescreve texto.
 * @returns {{ plano, ligados: string[], criadas: string[] }} ids, para o
 *   backup do script (caminho de volta).
 */
async function aplicarMigracao(companyId) {
  return comTransacao(async function (cli) {
    await garantirPadroes(companyId, cli);
    await cli.query("SELECT pg_advisory_xact_lock(hashtext('finance_categories:' || $1::text))", [companyId]);
    const plano = await planejarMigracao(companyId, cli);
    const criadas = [];
    const pares = plano.ligar.map(function (l) { return { kind: l.kind, texto: l.texto, id: l.category_id }; });
    for (let i = 0; i < plano.criar.length; i += 1) {
      const c = plano.criar[i];
      const ins = await cli.query(
        `INSERT INTO finance_categories (company_id, kind, name, name_norm, color, dre_line, sort_order)
         VALUES ($1, $2, $3, finance_category_norm($3), '#64748b', $4,
                 COALESCE((SELECT MAX(sort_order) FROM finance_categories WHERE company_id = $1 AND kind = $2 AND parent_id IS NULL), 0) + 10)
         RETURNING id`,
        [companyId, c.kind, c.name, DRE_PADRAO[c.kind]]
      );
      criadas.push(ins.rows[0].id);
      c.textos.forEach(function (t) { pares.push({ kind: c.kind, texto: t, id: ins.rows[0].id }); });
    }
    let ligados = [];
    if (pares.length) {
      const r = await cli.query(
        `UPDATE transactions t SET category_id = m.cat
           FROM unnest($2::text[], $3::text[], $4::uuid[]) AS m(kind, texto, cat)
          WHERE t.company_id = $1 AND t.category_id IS NULL
            AND t.type::text = m.kind AND t.category = m.texto
         RETURNING t.id`,
        [companyId, pares.map(function (p) { return p.kind; }), pares.map(function (p) { return p.texto; }), pares.map(function (p) { return p.id; })]
      );
      ligados = r.rows.map(function (x) { return x.id; });
    }
    return { plano: plano, ligados: ligados, criadas: criadas };
  });
}

module.exports = {
  normalizarNome,
  limparNome,
  DRE_LINES,
  DRE_PADRAO,
  PADROES,
  SISTEMA,
  APELIDOS,
  CORES,
  montarIndice,
  resolverTexto,
  foraDaMigracao,
  naEscolhaManual,
  linhasDosPadroes,
  garantirPadroes,
  listar,
  criar,
  atualizar,
  juntar,
  planejarMigracao,
  aplicarMigracao,
  _resetCache,
};
