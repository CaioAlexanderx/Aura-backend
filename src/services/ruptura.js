// ============================================================
// AURA. — O que vai faltar (13/10/2026)
//
// Lista o que, no ritmo das últimas semanas, acaba antes de uma data — a
// da Black Friday é 30/11. Compra de Black Friday se faz em outubro, e a
// conta sai só do que a loja já registra: vendas e estoque. Nada é gravado.
//
// ── A FÓRMULA ──────────────────────────────────────────────────────────
//   janela           = os `janelaDias` dias inteiros antes de hoje (hoje fica
//                      fora: dia pela metade puxaria o ritmo para baixo)
//   dias abertos     = dias da janela com pelo menos uma venda na loja
//   ritmo            = unidades vendidas na janela ÷ dias abertos
//   dias de venda    = de hoje em diante, todo dia cujo dia da semana teve
//                      loja aberta ao menos uma vez na janela
//   data prevista    = o N-ésimo dia de venda, N = ⌈estoque ÷ ritmo⌉
//   demanda até a data = ritmo × dias de venda de hoje até `ate`
//   falta            = demanda > estoque
//   sugestão         = ⌈demanda × 1,2 − estoque⌉ (folga de 20%), nunca negativa
//   valor em risco   = preço × (demanda − estoque)
//
// Por que dividir pelos dias abertos e não por 14: a loja que fechou uma
// semana (férias, reforma) ou que começou a usar o sistema há 6 dias teria
// o ritmo cortado pela metade. E por que projetar pelo dia da semana: a loja
// que nunca vende no domingo não vai vender nos domingos de novembro; a que
// fechou só numa terça da janela continua contando as terças.
//
// ── O QUE É UM ITEM ────────────────────────────────────────────────────
// A unidade de estoque: a variante quando o produto tem grade, o produto
// quando não tem. É onde o PDV baixa a quantidade (routes/pdv.js).
// Item sem venda na janela não entra — sem ritmo não há previsão, e listar
// o estoque parado é outra tela.
// Item que vendeu na janela e já está zerado sai numa lista à parte
// (`zerados`): ele não "vai" faltar, já faltou — e numa loja que vende sem
// controlar estoque ele afogaria a lista principal.
//
// ── MULTI-CNPJ ─────────────────────────────────────────────────────────
// O estoque compartilhado é UMA linha de produto (is_group_shared), que
// todas as lojas do grupo baixam. Por isso:
//   - as vendas contam pelo produto, em todas as lojas do grupo: é o grupo
//     inteiro que esvazia aquela prateleira;
//   - o produto aparece uma vez, com um estoque só — na loja e no
//     consolidado;
//   - os dias abertos do item compartilhado são os dias em que QUALQUER loja
//     do grupo vendeu; os do item próprio, só os da loja dona.
// Loja × consolidado muda apenas quais produtos entram: os que a loja vê
// (dela + compartilhados do grupo) ou os de todas as lojas pedidas.
//
// ── DESEMPENHO ─────────────────────────────────────────────────────────
// Duas consultas em paralelo, qualquer que seja o número de lojas: a
// agregada (vendas da janela por produto/variante, já com estoque e preço)
// e a dos dias com venda por loja (no máximo janela × lojas linhas). As
// duas entram por sales(company_id, created_at). O painel da Gestão Aura
// usa as MESMAS duas consultas para todas as lojas de uma vez — por isso
// não há tabela de cache: ~16 lojas × duas semanas de venda é pouco, e um
// cache diário mostraria estoque de ontem numa tela de decisão de compra.
// ============================================================
'use strict';

const pool = require('../config/database');

const TZ = 'America/Sao_Paulo';
const ATE_PADRAO = '2026-11-30';
const JANELA_PADRAO = 14;
const JANELA_MIN = 7; // menos que isso não cobre todos os dias da semana
const JANELA_MAX = 90;
const FOLGA = 0.2;
const HORIZONTE_DIAS = 365;
const TOP = 10;
const DIA = /^\d{4}-\d{2}-\d{2}$/;

const num = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);
const round2 = (v) => Math.round(num(v) * 100) / 100;
const round3 = (v) => Math.round(num(v) * 1000) / 1000;

// ── datas ('YYYY-MM-DD', sem fuso) ──────────────────────────────
function paraUTC(ymd) {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
const somaDias = (ymd, n) => new Date(paraUTC(ymd) + n * 86400000).toISOString().slice(0, 10);
const diasEntre = (de, ate) => Math.round((paraUTC(ate) - paraUTC(de)) / 86400000);
const diaDaSemana = (ymd) => new Date(paraUTC(ymd)).getUTCDay();
const hojeBRT = (agora = Date.now()) => new Date(agora - 3 * 3600000).toISOString().slice(0, 10);
function dataValida(ymd) {
  return typeof ymd === 'string' && DIA.test(ymd) && somaDias(ymd, 0) === ymd;
}

// 30/11 enquanto ele não passou; depois, 30 dias à frente.
function atePadrao(hoje) {
  return hoje <= ATE_PADRAO ? ATE_PADRAO : somaDias(hoje, 30);
}

function erroDeParametro(mensagem) {
  return Object.assign(new Error(mensagem), { statusCode: 400, code: 'RUPTURA_PARAMETRO' });
}

/**
 * Confere `ate` e `janela` (da query ou de quem chama o serviço).
 * Ausente vira padrão; presente e inválido é erro 400 — devolver a previsão
 * de outra data sem avisar seria pior do que recusar.
 */
function normalizarParametros({ ate, janela, hoje = hojeBRT() } = {}) {
  let ateFinal = atePadrao(hoje);
  if (ate !== undefined && ate !== null && ate !== '') {
    if (!dataValida(ate)) throw erroDeParametro('ate deve ser uma data YYYY-MM-DD');
    if (ate < hoje) throw erroDeParametro('ate não pode ser uma data passada');
    if (diasEntre(hoje, ate) > HORIZONTE_DIAS) throw erroDeParametro(`ate vai no máximo ${HORIZONTE_DIAS} dias à frente`);
    ateFinal = ate;
  }
  let janelaFinal = JANELA_PADRAO;
  if (janela !== undefined && janela !== null && janela !== '') {
    const n = Number(janela);
    if (!Number.isInteger(n) || n < JANELA_MIN || n > JANELA_MAX) {
      throw erroDeParametro(`janela deve ser um número inteiro de ${JANELA_MIN} a ${JANELA_MAX} dias`);
    }
    janelaFinal = n;
  }
  return { hoje, ate: ateFinal, janelaDias: janelaFinal };
}

// ── a conta ─────────────────────────────────────────────────────
/**
 * Os dias de venda daqui para a frente: de hoje até o horizonte, os dias
 * cujo dia da semana aparece em `diasAbertos`.
 */
function diasDeVendaFuturos(diasAbertos, hoje) {
  const semana = new Set(diasAbertos.map(diaDaSemana));
  const futuros = [];
  for (let i = 0; i <= HORIZONTE_DIAS; i++) {
    const dia = somaDias(hoje, i);
    if (semana.has(diaDaSemana(dia))) futuros.push(dia);
  }
  return futuros;
}

/**
 * A previsão de um item.
 *
 * @param {object} p
 * @param {number} p.estoque      quantidade atual
 * @param {number} p.unidades     vendidas na janela
 * @param {string[]} p.diasAbertos dias da janela com loja aberta
 * @param {string[]} [p.futuros]  dias de venda à frente (diasDeVendaFuturos); calculado se ausente
 * @param {string} p.hoje
 * @param {string} p.ate
 * @param {number} [p.preco]
 * @returns {object|null} null quando não há ritmo (sem venda ou sem dia aberto)
 */
function projetar({ estoque, unidades, diasAbertos, futuros, hoje, ate, preco = 0 }) {
  const vendidas = num(unidades);
  const abertos = Array.isArray(diasAbertos) ? diasAbertos.length : 0;
  if (vendidas <= 0 || abertos <= 0) return null;

  const saldo = Math.max(0, num(estoque));
  const ritmo = vendidas / abertos;
  const dias = futuros || diasDeVendaFuturos(diasAbertos, hoje);

  // O estoque acaba durante o N-ésimo dia de venda. O 1e-9 tira o ruído do
  // ponto flutuante: 6 ÷ (12/6) dá 3, não 3,0000000000000004 → 4.
  const n = Math.ceil(saldo / ritmo - 1e-9);
  const dataPrevista = saldo <= 0 ? hoje : (dias[n - 1] || null);

  const diasAteAData = dias.filter((d) => d <= ate).length;
  const demanda = ritmo * diasAteAData;
  const faltam = Math.max(0, demanda - saldo);
  const sugestao = Math.max(0, Math.ceil(demanda * (1 + FOLGA) - saldo - 1e-9));

  return {
    ritmo_diario: round2(ritmo),
    dias_ate_acabar: dataPrevista ? diasEntre(hoje, dataPrevista) : null,
    data_prevista: dataPrevista,
    faltara: faltam > 1e-9,
    demanda_ate_a_data: round2(demanda),
    unidades_faltantes: round2(faltam),
    sugestao_compra: sugestao,
    valor_em_risco: round2(num(preco) * faltam),
  };
}

function codigoDe(l) {
  if (l.barcode) return l.barcode;
  const sku = [l.sku, l.sku_suffix].filter(Boolean).join('-');
  return sku || null;
}

/**
 * Junta as linhas do banco com os dias abertos e devolve o que a tela usa.
 *
 * @param {object[]} linhas  resultado de SQL_ITENS
 * @param {object[]} dias    resultado de SQL_DIAS ({ company_id, grupo_id, dia })
 */
function montarRuptura(linhas, dias, { hoje, ate }) {
  const porLoja = new Map();
  const porGrupo = new Map();
  const juntar = (mapa, chave, dia) => {
    if (!mapa.has(chave)) mapa.set(chave, new Set());
    mapa.get(chave).add(dia);
  };
  for (const d of dias || []) {
    juntar(porLoja, d.company_id, d.dia);
    juntar(porGrupo, d.grupo_id, d.dia);
  }
  const lista = (conjunto) => (conjunto ? Array.from(conjunto).sort() : []);
  // Os dias à frente dependem só de quais dias a loja abriu: uma conta por
  // loja (ou grupo), não uma por item.
  const memo = new Map();
  const abertosDe = (l) => {
    const chave = l.is_group_shared ? `g:${l.grupo_id}` : `l:${l.company_id}`;
    if (!memo.has(chave)) {
      const abertos = lista(l.is_group_shared ? porGrupo.get(l.grupo_id) : porLoja.get(l.company_id));
      memo.set(chave, { abertos, futuros: diasDeVendaFuturos(abertos, hoje) });
    }
    return memo.get(chave);
  };

  const itens = [];
  const zerados = [];
  for (const l of linhas || []) {
    const { abertos, futuros } = abertosDe(l);
    const estoque = round3(l.estoque);
    const preco = round2(l.preco);
    const previsao = projetar({ estoque, unidades: l.unidades, diasAbertos: abertos, futuros, hoje, ate, preco });
    if (!previsao) continue;
    const item = {
      product_id: l.product_id,
      variant_id: l.variant_id || null,
      nome: l.nome || '',
      variante: l.variante || null,
      codigo: codigoDe(l),
      unidade: l.unidade || 'un',
      loja: { company_id: l.company_id, nome: l.loja || '' },
      compartilhado: l.is_group_shared === true,
      estoque,
      preco,
      vendas_na_janela: round3(l.unidades),
      dias_com_loja_aberta: abertos.length,
      ultima_venda: l.ultima_venda || null,
      ...previsao,
    };
    (estoque > 0 ? itens : zerados).push(item);
  }

  // Quem acaba primeiro vem primeiro; sem data (além de um ano) fica no fim.
  itens.sort((a, b) => (a.data_prevista || '9999').localeCompare(b.data_prevista || '9999')
    || b.valor_em_risco - a.valor_em_risco
    || a.nome.localeCompare(b.nome));
  zerados.sort((a, b) => b.ritmo_diario - a.ritmo_diario || a.nome.localeCompare(b.nome));

  return { itens, zerados, resumo: resumir(itens, zerados) };
}

function resumir(itens, zerados) {
  const emRisco = itens.filter((i) => i.faltara);
  const top = emRisco.slice()
    .sort((a, b) => b.valor_em_risco - a.valor_em_risco || (a.data_prevista || '').localeCompare(b.data_prevista || ''))
    .slice(0, TOP);
  return {
    itens_com_venda: itens.length + zerados.length,
    itens_em_risco: emRisco.length,
    unidades_faltantes: round2(emRisco.reduce((s, i) => s + i.unidades_faltantes, 0)),
    valor_em_risco: round2(emRisco.reduce((s, i) => s + i.valor_em_risco, 0)),
    sugestao_total: emRisco.reduce((s, i) => s + i.sugestao_compra, 0),
    primeira_ruptura: emRisco.length ? emRisco[0].data_prevista : null,
    zerados: zerados.length,
    top,
  };
}

// ── consultas ───────────────────────────────────────────────────
// $1 = hoje, $2 = dias da janela, $3 = empresas de referência (uuid[]).
const GRUPO = (a) => `COALESCE(NULLIF(${a}.billing_owner_company_id, ${a}.id), ${a}.id)`;
// Todas as empresas dos grupos das empresas de referência (a própria, quando
// não há grupo).
const EMPRESAS_DO_GRUPO = `(
    SELECT g.id FROM companies g
     WHERE ${GRUPO('g')} IN (SELECT ${GRUPO('r')} FROM companies r WHERE r.id = ANY($3::uuid[]))
  )`;
// Venda que baixou estoque: tudo menos a cancelada. A troca entra — o valor
// dela não é receita, mas a peça nova saiu da prateleira.
const VENDAS_DA_JANELA = `s.company_id IN ${EMPRESAS_DO_GRUPO}
    AND s.created_at >= (($1::date - $2::int)::timestamp AT TIME ZONE '${TZ}')
    AND s.created_at <  (($1::date)::timestamp AT TIME ZONE '${TZ}')
    AND COALESCE(s.status, 'completed') <> 'cancelled'`;

// O que a loja vê no Estoque (listVisibilityWhere de routes/products.js):
// os produtos dela e os compartilhados do grupo.
const ESCOPO_VISIVEL = `(p.company_id = ANY($3::uuid[])
    OR (p.is_group_shared = true AND p.company_id IN ${EMPRESAS_DO_GRUPO}))`;
// Só os produtos das próprias empresas: o painel soma por loja dona, e o
// compartilhado conta uma vez, em quem o cadastrou.
const ESCOPO_PROPRIO = `p.company_id = ANY($3::uuid[])`;

const sqlItens = (escopo) => `
  WITH vendas AS (
    SELECT si.product_id, si.variant_id,
           SUM(si.quantity) AS unidades,
           MAX(s.created_at) AS ultima_venda
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
     WHERE ${VENDAS_DA_JANELA}
       AND si.product_id IS NOT NULL
     GROUP BY si.product_id, si.variant_id
  )
  SELECT p.id AS product_id,
         pv.id AS variant_id,
         p.company_id,
         ${GRUPO('c')} AS grupo_id,
         COALESCE(c.trade_name, c.legal_name) AS loja,
         p.is_group_shared,
         p.name AS nome,
         COALESCE(
           (SELECT string_agg(pvv.value, ' / ' ORDER BY pvv.attribute_name)
              FROM product_variant_values pvv WHERE pvv.variant_id = pv.id),
           NULLIF(pv.sku_suffix, '')
         ) AS variante,
         NULLIF(p.sku, '') AS sku,
         NULLIF(pv.sku_suffix, '') AS sku_suffix,
         COALESCE(NULLIF(pv.barcode, ''), NULLIF(p.barcode, '')) AS barcode,
         p.unit AS unidade,
         COALESCE(pv.price_override, p.price) AS preco,
         CASE WHEN pv.id IS NULL THEN p.stock_qty ELSE pv.stock_qty END AS estoque,
         v.unidades,
         v.ultima_venda
    FROM vendas v
    JOIN products p ON p.id = v.product_id
    JOIN companies c ON c.id = p.company_id
    LEFT JOIN product_variants pv
           ON pv.id = v.variant_id AND pv.product_id = p.id AND pv.is_active = true
   WHERE p.is_active = true
     AND p.duration_minutes IS NULL
     AND v.unidades > 0
     AND (
       (v.variant_id IS NOT NULL AND pv.id IS NOT NULL)
       OR (v.variant_id IS NULL AND NOT EXISTS (
             SELECT 1 FROM product_variants x WHERE x.product_id = p.id AND x.is_active = true))
     )
     AND ${escopo}`;

const SQL_ITENS_VISIVEIS = sqlItens(ESCOPO_VISIVEL);
const SQL_ITENS_PROPRIOS = sqlItens(ESCOPO_PROPRIO);

const SQL_DIAS = `
  SELECT s.company_id,
         ${GRUPO('c')} AS grupo_id,
         to_char((s.created_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS dia
    FROM sales s
    JOIN companies c ON c.id = s.company_id
   WHERE ${VENDAS_DA_JANELA}
   GROUP BY 1, 2, 3`;

async function consultar(db, sql, params) {
  const { rows } = await db.query(sql, params);
  return rows || [];
}

async function carregar({ db, sqlDosItens, empresas, hoje, janelaDias }) {
  const params = [hoje, janelaDias, empresas];
  const [linhas, dias] = await Promise.all([
    consultar(db, sqlDosItens, params),
    consultar(db, SQL_DIAS, params),
  ]);
  return { linhas, dias };
}

const cabecalho = ({ hoje, ate, janelaDias }) => ({
  hoje,
  ate,
  janela_dias: janelaDias,
  janela: { de: somaDias(hoje, -janelaDias), ate: somaDias(hoje, -1) },
  folga_pct: FOLGA * 100,
});

/**
 * O que vai faltar numa loja — ou no grupo, quando `companyIds` traz mais de
 * uma empresa (o estoque compartilhado entra uma vez só).
 *
 * @param {object} p
 * @param {string} p.companyId      loja de referência
 * @param {string[]} [p.companyIds] lojas do consolidado (inclui a de referência)
 * @param {string} [p.ate]          'YYYY-MM-DD' — padrão 30/11/2026
 * @param {number} [p.janelaDias]   padrão 14
 * @param {string} [p.hoje]         dia em Brasília (testes)
 */
async function calcularRuptura({ companyId, companyIds, ate, janelaDias, hoje, db = pool } = {}) {
  if (!companyId) throw erroDeParametro('companyId obrigatório');
  const p = normalizarParametros({ ate, janela: janelaDias, hoje: hoje || hojeBRT() });
  const empresas = Array.from(new Set([companyId, ...(companyIds || [])]));
  const { linhas, dias } = await carregar({
    db, sqlDosItens: SQL_ITENS_VISIVEIS, empresas, hoje: p.hoje, janelaDias: p.janelaDias,
  });
  return {
    ...cabecalho(p),
    escopo: empresas.length > 1 ? 'grupo' : 'loja',
    empresas,
    ...montarRuptura(linhas, dias, p),
  };
}

/**
 * O resumo por loja para o painel da Gestão Aura. Uma passada para todas as
 * empresas; cada item conta na loja dona do estoque.
 *
 * @param {object} p
 * @param {Array<{company_id:string,nome:string,telefone?:string}>} p.empresas
 */
async function calcularRupturaPorLoja({ empresas, ate, janelaDias, hoje, db = pool } = {}) {
  const p = normalizarParametros({ ate, janela: janelaDias, hoje: hoje || hojeBRT() });
  const universo = empresas || [];
  const base = { ...cabecalho(p) };
  if (!universo.length) {
    return { ...base, resumo: { lojas: 0, lojas_com_risco: 0, itens_em_risco: 0, valor_em_risco: 0 }, lojas: [] };
  }

  const { linhas, dias } = await carregar({
    db, sqlDosItens: SQL_ITENS_PROPRIOS, empresas: universo.map((e) => e.company_id),
    hoje: p.hoje, janelaDias: p.janelaDias,
  });
  const { itens, zerados } = montarRuptura(linhas, dias, p);

  const porLoja = new Map(universo.map((e) => [e.company_id, { itens: [], zerados: [] }]));
  for (const i of itens) porLoja.get(i.loja.company_id)?.itens.push(i);
  for (const z of zerados) porLoja.get(z.loja.company_id)?.zerados.push(z);

  const lojas = universo
    .map((e) => {
      const dela = porLoja.get(e.company_id);
      const r = resumir(dela.itens, dela.zerados);
      return {
        company_id: e.company_id,
        nome: e.nome,
        telefone: e.telefone || null,
        itens_com_venda: r.itens_com_venda,
        itens_em_risco: r.itens_em_risco,
        zerados: r.zerados,
        unidades_faltantes: r.unidades_faltantes,
        valor_em_risco: r.valor_em_risco,
        primeira_ruptura: r.primeira_ruptura,
        top: r.top.slice(0, 3),
      };
    })
    .filter((l) => l.itens_em_risco > 0 || l.zerados > 0)
    .sort((a, b) => b.valor_em_risco - a.valor_em_risco || b.itens_em_risco - a.itens_em_risco || a.nome.localeCompare(b.nome));

  return {
    ...base,
    resumo: {
      lojas: universo.length,
      lojas_com_risco: lojas.filter((l) => l.itens_em_risco > 0).length,
      itens_em_risco: lojas.reduce((s, l) => s + l.itens_em_risco, 0),
      valor_em_risco: round2(lojas.reduce((s, l) => s + l.valor_em_risco, 0)),
    },
    lojas,
  };
}

module.exports = {
  calcularRuptura,
  calcularRupturaPorLoja,
  normalizarParametros,
  projetar,
  diasDeVendaFuturos,
  montarRuptura,
  hojeBRT,
  ATE_PADRAO,
  JANELA_PADRAO,
  FOLGA,
  // exportadas para os testes conferirem a forma das consultas
  SQL_ITENS_VISIVEIS,
  SQL_ITENS_PROPRIOS,
  SQL_DIAS,
};
