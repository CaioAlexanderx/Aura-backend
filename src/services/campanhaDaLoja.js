// ============================================================
// AURA. — Campanha de Black Friday da loja online (p-118, 14/11/2026)
//
// Desenho aprovado pelo Caio no mockup "Black Friday na loja online".
// A campanha e por empresa (digital_channel_config.bf_ativa/bf_titulo,
// migration 451). O desconto e o De/Por que ja existe (migration 427): o
// mesmo preco no Caixa e na loja online. Aqui so se decide SE a loja mostra
// a faixa e O QUE ela promete.
//
// Regras:
//   - "ate N% OFF" e o MAIOR desconto real entre as promocoes no ar, nunca
//     editavel e nunca calculado no template. Arredonda PARA BAIXO, como a
//     etiqueta "-N%" do cartao (parts/promocao.js): a faixa nao promete mais
//     do que a loja da.
//   - So conta peca que a loja online mostra: a mesma regra da grade
//     (visibilidade do grupo, ativa, com saldo, foto quando a loja exige,
//     destaques e ocultas). Produto compartilhado do grupo e UMA linha: a
//     promocao dele vale em toda loja do grupo que o mostra, como na grade.
//     Variante com promocao propria entra com o preco base dela e so com
//     saldo.
//   - Ligada e sem promocao no ar (agendada), a loja continua como hoje; a
//     faixa nasce sozinha quando a primeira promocao comecar.
//   - Payload: `campanha` e `tem_promocao` so aparecem quando valem. Loja
//     sem campanha e sem promocao recebe o payload identico ao de antes.
// ============================================================
'use strict';

const db = require('../config/database');
const { EM_ESTOQUE, NA_VITRINE, COM_FOTO, filtroDeFoto } = require('./catalogoPaginado');

const TITULOS = ['black_friday', 'black_friday_da_loja', 'ofertas_de_novembro'];
const TITULO_PADRAO = 'black_friday';

/** O texto da faixa para a chave gravada. Chave desconhecida cai no padrao. */
function textoDoTitulo(chave, nomeDaLoja) {
  const nome = String(nomeDaLoja || '').trim();
  switch (chave) {
    case 'black_friday_da_loja': return nome ? `Black Friday da ${nome}` : 'Black Friday';
    case 'ofertas_de_novembro': return 'Ofertas de novembro';
    default: return 'Black Friday';
  }
}

/** As tres opcoes, ja com o nome da loja, para o painel. */
function opcoesDeTitulo(nomeDaLoja) {
  return TITULOS.map((id) => ({ id, texto: textoDoTitulo(id, nomeDaLoja) }));
}

/** Periodo padrao do assistente (27/11 a 30/11 do ano corrente, em Brasilia). */
function periodoPadrao(agora = new Date()) {
  const ano = new Date(agora.getTime() - 3 * 3600 * 1000).getUTCFullYear();
  return { inicio: `${ano}-11-27`, fim: `${ano}-11-30` };
}

const SEM_PROMOCAO = Object.freeze({ no_ar: 0, agendadas: 0, ate_pct: 0, ate_data: null, comeca_em: null, fora_da_loja: 0 });

/**
 * As promocoes da empresa, num SELECT so, separando o que a loja online
 * MOSTRA (mesma regra da grade: com saldo, foto quando a loja exige,
 * destaques e ocultas) do que ela nao mostra. `cid` vai em $1 porque
 * NA_VITRINE e a visibilidade leem $1.
 *
 *   no_ar         pecas NA LOJA com promocao valendo agora
 *   agendadas     pecas NA LOJA com promocao que ainda vai comecar
 *   ate_pct       maior desconto, para baixo, entre as no ar na loja
 *   ate_data      'YYYY-MM-DD' do ultimo fim entre as no ar, em Brasilia
 *   comeca_em     'YYYY-MM-DD' da primeira agendada, em Brasilia
 *   fora_da_loja  pecas com promocao (no ar ou agendada) que a loja online
 *                 NAO mostra: valem no Caixa, mas nao aparecem na vitrine
 *                 (QA 14/11, p-123a: a secao dizia "nenhum produto em
 *                 promocao" e a Promocao em lote, "3 itens no ar")
 *
 * So a peca que tem alguma promocao gravada passa pelos filtros da
 * vitrine: o resto do catalogo nao custa nada.
 */
function sqlDoResumo(visibilidade, exigeFoto) {
  return `
    WITH todos AS (
      SELECT id, price, promo_price, promo_starts_at, promo_ends_at,
             (${EM_ESTOQUE} AND ${filtroDeFoto(exigeFoto)} AND ${NA_VITRINE}) AS na_loja
        FROM products
       WHERE ${visibilidade}
         AND is_active IS NOT FALSE
         AND (promo_price IS NOT NULL OR EXISTS (
               SELECT 1 FROM product_variants pvp
                WHERE pvp.product_id = products.id AND pvp.promo_price IS NOT NULL))
    ),
    linhas AS (
      SELECT t.id AS pid, t.na_loja, t.price::numeric AS base, t.promo_price::numeric AS promo,
             t.promo_starts_at AS ini, t.promo_ends_at AS fim
        FROM todos t
       WHERE t.promo_price IS NOT NULL
      UNION ALL
      SELECT t.id, t.na_loja, COALESCE(v.price_override, t.price)::numeric, v.promo_price::numeric,
             v.promo_starts_at, v.promo_ends_at
        FROM product_variants v
        JOIN todos t ON t.id = v.product_id
       WHERE v.is_active = true AND v.stock_qty > 0 AND v.promo_price IS NOT NULL
    ),
    marcadas AS (
      SELECT pid, na_loja, base, promo, ini, fim,
             (promo > 0 AND promo < base AND ini <= $2::timestamptz AND fim > $2::timestamptz) AS ativa,
             (promo > 0 AND promo < base AND ini > $2::timestamptz AND fim > ini) AS agendada
        FROM linhas
       WHERE base > 0 AND ini IS NOT NULL AND fim IS NOT NULL
    )
    SELECT
      COUNT(DISTINCT pid) FILTER (WHERE ativa AND na_loja)::int AS no_ar,
      COUNT(DISTINCT pid) FILTER (WHERE agendada AND NOT ativa AND na_loja)::int AS agendadas,
      COALESCE(MAX(FLOOR((1 - promo / base) * 100)) FILTER (WHERE ativa AND na_loja), 0)::int AS ate_pct,
      to_char((MAX(fim) FILTER (WHERE ativa AND na_loja) - interval '1 millisecond') AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS ate_data,
      to_char(MIN(ini) FILTER (WHERE agendada AND na_loja) AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS comeca_em,
      COUNT(DISTINCT pid) FILTER (WHERE (ativa OR agendada) AND NOT na_loja)::int AS fora_da_loja
    FROM marcadas
  `;
}

/**
 * As pecas da empresa que a loja online NAO mostra, com o motivo, para o
 * assistente "Montar descontos da loja online" marcar (p-123a). Ativas e
 * visiveis para a empresa (grupo incluido), como a grade. Motivo, na ordem:
 * 'fora_da_vitrine' (oculta ou fora dos destaques), 'sem_foto' (a loja
 * exige foto), 'sem_estoque'. Ate LIMITE_FORA_DA_LOJA pecas.
 */
const LIMITE_FORA_DA_LOJA = 5000;

function sqlForaDaLoja(visibilidade, exigeFoto) {
  return `
    SELECT id, CASE
             WHEN NOT ${NA_VITRINE} THEN 'fora_da_vitrine'
             WHEN ${exigeFoto === true ? `NOT ${COM_FOTO}` : 'FALSE'} THEN 'sem_foto'
             ELSE 'sem_estoque'
           END AS motivo
      FROM products
     WHERE ${visibilidade}
       AND is_active IS NOT FALSE
       AND NOT (${EM_ESTOQUE} AND ${filtroDeFoto(exigeFoto)} AND ${NA_VITRINE})
     ORDER BY id
     LIMIT ${LIMITE_FORA_DA_LOJA}
  `;
}

async function pecasForaDaLoja({ cid, visibilidade, exigeFoto = false, q = db.query.bind(db) }) {
  const { rows } = await q(sqlForaDaLoja(visibilidade, exigeFoto), [cid]);
  return (rows || []).map((r) => ({ id: r.id, motivo: r.motivo }));
}

/**
 * Resumo das promocoes da loja online. `visibilidade` e o WHERE de
 * visibilidade com $1 (listVisibilityWhere do storefrontBuilder — passado
 * por quem chama para nao criar dependencia circular).
 * Sem as colunas de promocao (42703) ou sem tabela (42P01): sem promocao.
 */
async function resumoDasPromocoes({ cid, visibilidade, exigeFoto = false, agora = new Date(), q = db.query.bind(db) }) {
  try {
    const { rows } = await q(sqlDoResumo(visibilidade, exigeFoto), [cid, agora.toISOString()]);
    const r = rows && rows[0];
    if (!r) return { ...SEM_PROMOCAO };
    return {
      no_ar: Number(r.no_ar) || 0,
      agendadas: Number(r.agendadas) || 0,
      ate_pct: Number(r.ate_pct) || 0,
      ate_data: r.ate_data || null,
      comeca_em: r.comeca_em || null,
      fora_da_loja: Number(r.fora_da_loja) || 0,
    };
  } catch (e) {
    if (e && (e.code === '42703' || e.code === '42P01')) return { ...SEM_PROMOCAO };
    throw e;
  }
}

/**
 * As chaves que a campanha acrescenta ao payload publico da loja. `{}`
 * quando nada vale — o payload sai identico ao de antes.
 *
 *   tem_promocao  true quando ha promocao no ar no catalogo inteiro (a
 *                 pagina so carrega a primeira pagina de pecas; o "De"
 *                 riscado precisa saber do resto)
 *   campanha      { ativa: true, titulo, ate_pct, ate_data } so com a
 *                 campanha ligada E promocao no ar
 */
function chavesDoPayload(config, resumo, nomeDaLoja) {
  const r = resumo || SEM_PROMOCAO;
  if (!(r.no_ar > 0)) return {};
  const out = { tem_promocao: true };
  if (config && config.bf_ativa === true && r.ate_pct > 0) {
    out.campanha = {
      ativa: true,
      titulo: textoDoTitulo(config.bf_titulo, nomeDaLoja),
      ate_pct: r.ate_pct,
      ate_data: r.ate_data,
    };
  }
  return out;
}

/** O que o painel le (GET e resposta do PUT). */
function estadoParaOPainel(config, resumo, nomeDaLoja, agora = new Date()) {
  const r = resumo || SEM_PROMOCAO;
  const ativa = !!(config && config.bf_ativa === true);
  const titulo = config && TITULOS.includes(config.bf_titulo) ? config.bf_titulo : TITULO_PADRAO;
  return {
    loja_online: {
      existe: !!config,
      publicada: !!(config && config.is_published === true),
      slug: (config && config.slug) || null,
    },
    ativa,
    titulo,
    titulos: opcoesDeTitulo(nomeDaLoja),
    // A faixa esta na loja agora? Ligada E com promocao no ar.
    no_ar: ativa && r.no_ar > 0 && r.ate_pct > 0,
    // Ligada, sem promocao no ar e com agendada: a faixa nasce sozinha.
    agendada: ativa && !(r.no_ar > 0) && r.agendadas > 0,
    promocoes: { ...r },
    pode_ligar: r.no_ar + r.agendadas > 0,
    periodo_padrao: periodoPadrao(agora),
  };
}

module.exports = {
  TITULOS, TITULO_PADRAO, SEM_PROMOCAO,
  textoDoTitulo, opcoesDeTitulo, periodoPadrao,
  sqlDoResumo, resumoDasPromocoes, chavesDoPayload, estadoParaOPainel,
  sqlForaDaLoja, pecasForaDaLoja, LIMITE_FORA_DA_LOJA,
};
