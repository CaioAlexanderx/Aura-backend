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
const { EM_ESTOQUE, NA_VITRINE, filtroDeFoto } = require('./catalogoPaginado');

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

// ── O texto escrito pela loja (p-122, 14/11/2026, migration 453) ──
//
// Pedido do Caio: alem das tres opcoes prontas, a loja escreve o titulo da
// faixa (ate 28: cabe em duas linhas da faixa fina no celular e numa linha
// acima de 1100 px) e a frase da faixa grande (ate 90). O "ate N% OFF" e a
// data seguem calculados: o texto nao aceita "%" nem "R$" (nao promete
// desconto diferente do real). Uma linha so, sem emoji; espacos das pontas
// e repetidos saem. Vazio (ou so espacos) = a opcao pronta.
const LIMITE_DO_TITULO = 28;
const LIMITE_DA_FRASE = 90;
const QUEBRA_DE_LINHA = /[\r\n\u2028\u2029]/;
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/u;
const CONTROLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/**
 * O texto da faixa como sera gravado, ou o erro em portugues gentil.
 * `rotulo`: "O título da faixa" / "A frase da faixa grande".
 * Devolve { valor } (string ou null = volta a opcao pronta) ou { erro }.
 */
function normalizarTextoDaFaixa(bruto, { limite, rotulo }) {
  if (bruto === null || bruto === undefined) return { valor: null };
  if (typeof bruto !== 'string') return { erro: `${rotulo} precisa ser um texto.` };
  if (QUEBRA_DE_LINHA.test(bruto)) return { erro: `${rotulo} vai numa linha só: tire a quebra de linha.` };
  const texto = bruto.replace(/\s+/g, ' ').trim();
  if (!texto) return { valor: null };
  if (CONTROLE.test(texto)) return { erro: `${rotulo} tem um caractere que a loja não mostra. Escreva só com letras, números e pontuação.` };
  if (EMOJI.test(texto)) return { erro: `${rotulo} não aceita emoji: a faixa usa só letras, números e pontuação.` };
  if (texto.includes('%') || /r\$/i.test(texto)) {
    return { erro: `${rotulo} não pode ter “%” nem “R$”: o desconto da faixa é calculado pelas suas promoções, para nunca prometer mais do que a loja dá.` };
  }
  const n = Array.from(texto).length;
  if (n > limite) return { erro: `${rotulo} cabe em até ${limite} caracteres (agora são ${n}).` };
  return { valor: texto };
}

/** O titulo que a faixa mostra: o escrito pela loja ou a opcao pronta. */
function tituloFinal(config, nomeDaLoja) {
  const escrito = config && typeof config.bf_titulo_texto === 'string' ? config.bf_titulo_texto.trim() : '';
  return escrito || textoDoTitulo(config && config.bf_titulo, nomeDaLoja);
}

/** A frase da faixa grande escrita pela loja, ou null (o texto padrao). */
function fraseEscrita(config) {
  const escrita = config && typeof config.bf_frase_texto === 'string' ? config.bf_frase_texto.trim() : '';
  return escrita || null;
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

const SEM_PROMOCAO = Object.freeze({ no_ar: 0, agendadas: 0, ate_pct: 0, ate_data: null, comeca_em: null });

/**
 * As promocoes que a loja online mostra, num SELECT so. `cid` vai em $1
 * porque NA_VITRINE e a visibilidade leem $1.
 *
 *   no_ar      pecas (produto) com promocao valendo agora
 *   agendadas  pecas com promocao que ainda vai comecar
 *   ate_pct    maior desconto, para baixo, entre as no ar (0 sem nenhuma)
 *   ate_data   'YYYY-MM-DD' do ultimo fim entre as no ar, em Brasilia
 *   comeca_em  'YYYY-MM-DD' da primeira agendada, em Brasilia
 */
function sqlDoResumo(visibilidade, exigeFoto) {
  return `
    WITH vis AS (
      SELECT id, price, promo_price, promo_starts_at, promo_ends_at
        FROM products
       WHERE ${visibilidade}
         AND is_active IS NOT FALSE
         AND ${EM_ESTOQUE}
         AND ${filtroDeFoto(exigeFoto)}
         AND ${NA_VITRINE}
    ),
    linhas AS (
      SELECT vis.id AS pid, vis.price::numeric AS base, vis.promo_price::numeric AS promo,
             vis.promo_starts_at AS ini, vis.promo_ends_at AS fim
        FROM vis
       WHERE vis.promo_price IS NOT NULL
      UNION ALL
      SELECT vis.id, COALESCE(v.price_override, vis.price)::numeric, v.promo_price::numeric,
             v.promo_starts_at, v.promo_ends_at
        FROM product_variants v
        JOIN vis ON vis.id = v.product_id
       WHERE v.is_active = true AND v.stock_qty > 0 AND v.promo_price IS NOT NULL
    ),
    marcadas AS (
      SELECT pid, base, promo, ini, fim,
             (promo > 0 AND promo < base AND ini <= $2::timestamptz AND fim > $2::timestamptz) AS ativa,
             (promo > 0 AND promo < base AND ini > $2::timestamptz AND fim > ini) AS agendada
        FROM linhas
       WHERE base > 0 AND ini IS NOT NULL AND fim IS NOT NULL
    )
    SELECT
      COUNT(DISTINCT pid) FILTER (WHERE ativa)::int AS no_ar,
      COUNT(DISTINCT pid) FILTER (WHERE agendada AND NOT ativa)::int AS agendadas,
      COALESCE(MAX(FLOOR((1 - promo / base) * 100)) FILTER (WHERE ativa), 0)::int AS ate_pct,
      to_char((MAX(fim) FILTER (WHERE ativa) - interval '1 millisecond') AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS ate_data,
      to_char(MIN(ini) FILTER (WHERE agendada) AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS comeca_em
    FROM marcadas
  `;
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
    // p-122: titulo ja com o texto final (o escrito ou a opcao pronta);
    // `frase` so quando a loja escreveu — sem ela a pagina sai igual.
    const frase = fraseEscrita(config);
    out.campanha = {
      ativa: true,
      titulo: tituloFinal(config, nomeDaLoja),
      ate_pct: r.ate_pct,
      ate_data: r.ate_data,
      ...(frase ? { frase } : {}),
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
    // p-122: o texto escrito pela loja (null = a opcao pronta / o padrao) e
    // o titulo que a faixa mostra agora, para a previa do painel.
    titulo_texto: (config && config.bf_titulo_texto) || null,
    frase_texto: (config && config.bf_frase_texto) || null,
    titulo_final: tituloFinal(config, nomeDaLoja),
    limites: { titulo: LIMITE_DO_TITULO, frase: LIMITE_DA_FRASE },
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
  LIMITE_DO_TITULO, LIMITE_DA_FRASE, normalizarTextoDaFaixa, tituloFinal, fraseEscrita,
  sqlDoResumo, resumoDasPromocoes, chavesDoPayload, estadoParaOPainel,
};
