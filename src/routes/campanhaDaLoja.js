// ============================================================
// AURA. — Campanha de Black Friday da loja online (p-118, 14/11/2026)
// Mount: /companies/:id/digital-channel/campanha (private.js, plano Negocio
// ou Expansao, como o resto da loja online). Migration 451.
//
// GET /   estado da campanha para a pagina Black Friday do painel:
//         { loja_online{existe,publicada,slug}, ativa, titulo, titulos[],
//           no_ar, agendada, promocoes{no_ar,agendadas,ate_pct,ate_data,
//           comeca_em,fora_da_loja}, pode_ligar, periodo_padrao{inicio,fim} }
//         promocoes conta SO o que a loja online mostra; fora_da_loja diz
//         quantas pecas em promocao a vitrine nao mostra (p-123a).
// GET /fora-da-loja  as pecas que a loja online nao mostra, com o motivo,
//         para o assistente marcar: { produtos: [{id, motivo}], limite }.
// PUT /   { ativa?: boolean, titulo?: 'black_friday' |
//           'black_friday_da_loja' | 'ofertas_de_novembro',
//           titulo_texto?: string|null (ate 28), frase_texto?: string|null
//           (ate 90) }  — p-122, migration 453. Texto invalido (tamanho,
//           "%"/"R$", quebra de linha, emoji): 422 TEXTO_DA_FAIXA_INVALIDO
//           com `campo` e a mensagem. null ou so espacos = opcao pronta.
//         Ligar exige ao menos uma promocao no ar ou agendada (409
//         BF_SEM_PROMOCAO). Desligar e trocar o titulo sempre podem.
//
// Por empresa: cada CNPJ do grupo liga a sua (a linha de
// digital_channel_config e da empresa). As promocoes contadas sao as que a
// loja online desta empresa mostra, com a mesma visibilidade da grade —
// produto compartilhado do grupo entra como na vitrine.
// Permissao: a mesma do PUT da configuracao da loja online.
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireRole } = require('../middleware/auth');
const { logAuditAction, contextoDaRequisicao } = require('../middleware/auditLog');
const { esquecerPagina } = require('../services/cacheDaPaginaDaLoja');
const { listVisibilityWhere } = require('../services/storefrontBuilder');
const {
  TITULOS, resumoDasPromocoes, estadoParaOPainel, pecasForaDaLoja, LIMITE_FORA_DA_LOJA,
  normalizarTextoDaFaixa, LIMITE_DO_TITULO, LIMITE_DA_FRASE,
} = require('../services/campanhaDaLoja');

const MIGRATION_PENDING = {
  error: 'A campanha de Black Friday ainda está sendo instalada. Tente de novo em alguns minutos.',
  code: 'MIGRATION_PENDING',
};
const SEM_PROMOCAO = {
  error: 'Para ligar a campanha, monte antes pelo menos um desconto. Assim a faixa da loja mostra uma promoção de verdade.',
  code: 'BF_SEM_PROMOCAO',
};
const SEM_LOJA_ONLINE = {
  error: 'Configure a loja online antes de ligar a campanha.',
  code: 'SEM_LOJA_ONLINE',
};
/**
 * O 409 de ligar sem promocao na loja. Com promocao so em peca que a loja
 * nao mostra, diz isso (QA 14/11: a lojista tinha 3 itens no ar no Caixa e
 * nao entendia por que a chave nao ligava).
 */
function semPromocaoNaLoja(foraDaLoja) {
  const n = Number(foraDaLoja) || 0;
  if (n <= 0) return SEM_PROMOCAO;
  const pecas = n === 1 ? 'O seu produto em promoção não aparece' : `Os seus ${n} produtos em promoção não aparecem`;
  return {
    ...SEM_PROMOCAO,
    error: `${pecas} na loja online (estão fora da vitrine ou sem foto). Mostre pelo menos um na loja para ligar a campanha.`,
    fora_da_loja: n,
  };
}

const faltaMigration = (err) => err && (err.code === '42703' || err.code === '42P01');

// p-122: as colunas do texto escrito (453). Base sem elas: le sem, e a
// campanha segue com as opcoes prontas (gravar texto devolve 503).
// Sem a 453, confere de novo em 5 minutos (a migration roda com o processo
// antigo no ar).
let semTextosAte = 0;
const COLUNAS = 'company_id, slug, is_published, site_name, require_product_image, show_prices, bf_ativa, bf_titulo';

async function lerConfig(cid) {
  if (Date.now() >= semTextosAte) {
    try {
      const { rows } = await db.query(
        `SELECT ${COLUNAS}, bf_titulo_texto, bf_frase_texto
           FROM digital_channel_config WHERE company_id = $1`,
        [cid]
      );
      return rows[0] || null;
    } catch (e) {
      if (!(e && e.code === '42703')) throw e;
      semTextosAte = Date.now() + 5 * 60 * 1000;
    }
  }
  const { rows } = await db.query(
    `SELECT ${COLUNAS}
       FROM digital_channel_config WHERE company_id = $1`,
    [cid]
  );
  return rows[0] || null;
}

async function nomeDaLoja(cid, config) {
  if (config && config.site_name) return config.site_name;
  const { rows } = await db.query(
    `SELECT COALESCE(trade_name, legal_name) AS nome FROM companies WHERE id = $1`, [cid]);
  return (rows[0] && rows[0].nome) || 'Loja';
}

async function estado(cid, config) {
  const resumo = await resumoDasPromocoes({
    cid,
    visibilidade: listVisibilityWhere('$1'),
    exigeFoto: !!(config && config.require_product_image === true),
  });
  return estadoParaOPainel(config, resumo, await nomeDaLoja(cid, config));
}

router.get('/', async (req, res) => {
  const cid = req.params.id;
  try {
    const config = await lerConfig(cid);
    res.json(await estado(cid, config));
  } catch (err) {
    if (faltaMigration(err)) return res.status(503).json(MIGRATION_PENDING);
    console.error('[campanha] GET:', err.message);
    res.status(500).json({ error: 'Não deu para carregar a campanha agora. Tente de novo.' });
  }
});

router.get('/fora-da-loja', async (req, res) => {
  const cid = req.params.id;
  try {
    const config = await lerConfig(cid);
    const produtos = await pecasForaDaLoja({
      cid,
      visibilidade: listVisibilityWhere('$1'),
      exigeFoto: !!(config && config.require_product_image === true),
    });
    res.json({ produtos, limite: LIMITE_FORA_DA_LOJA });
  } catch (err) {
    if (faltaMigration(err)) return res.status(503).json(MIGRATION_PENDING);
    console.error('[campanha] fora da loja:', err.message);
    res.status(500).json({ error: 'Não deu para ver o que a loja mostra agora. Tente de novo.' });
  }
});

const tem = (b, k) => Object.prototype.hasOwnProperty.call(b, k);

/** Corpo do PUT validado, ou { erro } (400) / { erro, status: 422, campo }. */
function lerCorpo(body) {
  const b = body || {};
  const out = {};
  // p-122: o texto escrito pela loja. Ausente = nao mexe; null/'' = volta a
  // opcao pronta.
  for (const [campo, limite, rotulo] of [
    ['titulo_texto', LIMITE_DO_TITULO, 'O título da faixa'],
    ['frase_texto', LIMITE_DA_FRASE, 'A frase da faixa grande'],
  ]) {
    if (!tem(b, campo)) continue;
    const r = normalizarTextoDaFaixa(b[campo], { limite, rotulo });
    if (r.erro) return { erro: r.erro, status: 422, campo };
    out[campo] = r.valor;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'ativa')) {
    if (typeof b.ativa !== 'boolean') return { erro: 'ativa deve ser true ou false' };
    out.ativa = b.ativa;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'titulo')) {
    if (!TITULOS.includes(b.titulo)) return { erro: `titulo deve ser um de: ${TITULOS.join(', ')}` };
    out.titulo = b.titulo;
  }
  if (out.ativa === undefined && out.titulo === undefined && !tem(out, 'titulo_texto') && !tem(out, 'frase_texto')) {
    return { erro: 'Nada para mudar: envie ativa, titulo, titulo_texto e/ou frase_texto' };
  }
  return out;
}

router.put('/', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const cid = req.params.id;
  const pedido = lerCorpo(req.body);
  if (pedido.erro) {
    if (pedido.status === 422) {
      return res.status(422).json({ error: pedido.erro, code: 'TEXTO_DA_FAIXA_INVALIDO', campo: pedido.campo });
    }
    return res.status(400).json({ error: pedido.erro });
  }
  try {
    const config = await lerConfig(cid);
    if (!config) return res.status(409).json(SEM_LOJA_ONLINE);

    if (pedido.ativa === true && config.bf_ativa !== true) {
      const atual = await estado(cid, config);
      if (!atual.pode_ligar) return res.status(409).json(semPromocaoNaLoja(atual.promocoes.fora_da_loja));
    }

    const comTextos = tem(pedido, 'titulo_texto') || tem(pedido, 'frase_texto');
    const params = [cid, pedido.ativa === undefined ? null : pedido.ativa, pedido.titulo === undefined ? null : pedido.titulo];
    // p-122: os textos so entram no UPDATE quando vieram no corpo — a
    // chave e o titulo pronto continuam gravando numa base sem a 453.
    let textos = '';
    if (comTextos) {
      params.push(tem(pedido, 'titulo_texto'), tem(pedido, 'titulo_texto') ? pedido.titulo_texto : null,
        tem(pedido, 'frase_texto'), tem(pedido, 'frase_texto') ? pedido.frase_texto : null);
      textos = `
              bf_titulo_texto = CASE WHEN $4::boolean THEN $5::varchar ELSE bf_titulo_texto END,
              bf_frase_texto = CASE WHEN $6::boolean THEN $7::varchar ELSE bf_frase_texto END,`;
    }
    const { rows } = await db.query(
      `UPDATE digital_channel_config
          SET bf_ativa = COALESCE($2::boolean, bf_ativa),
              bf_titulo = COALESCE($3::text, bf_titulo),${textos}
              updated_at = NOW()
        WHERE company_id = $1
        RETURNING *`,
      params
    );
    const salvo = rows[0] || config;
    // A home da loja fica guardada 60 s: a faixa liga e desliga na hora.
    esquecerPagina(salvo.slug || undefined);

    logAuditAction(
      req.user?.id || null, cid, 'digital_channel.black_friday',
      `Campanha de Black Friday ${salvo.bf_ativa ? 'ligada' : 'desligada'} (${salvo.bf_titulo})`,
      {
        antes: { ativa: config.bf_ativa === true, titulo: config.bf_titulo, titulo_texto: config.bf_titulo_texto || null, frase_texto: config.bf_frase_texto || null },
        depois: { ativa: salvo.bf_ativa === true, titulo: salvo.bf_titulo, titulo_texto: salvo.bf_titulo_texto || null, frase_texto: salvo.bf_frase_texto || null },
      },
      contextoDaRequisicao(req)
    );

    res.json(await estado(cid, salvo));
  } catch (err) {
    if (faltaMigration(err)) return res.status(503).json(MIGRATION_PENDING);
    console.error('[campanha] PUT:', err.message);
    res.status(500).json({ error: 'Não deu para salvar a campanha agora. Tente de novo.' });
  }
});

module.exports = router;
module.exports.lerCorpo = lerCorpo;
module.exports._resetarParaTeste = () => { semTextosAte = 0; };
