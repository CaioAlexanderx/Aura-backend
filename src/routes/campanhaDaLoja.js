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
//           'black_friday_da_loja' | 'ofertas_de_novembro' }
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
const { TITULOS, resumoDasPromocoes, estadoParaOPainel, pecasForaDaLoja, LIMITE_FORA_DA_LOJA } = require('../services/campanhaDaLoja');

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

async function lerConfig(cid) {
  const { rows } = await db.query(
    `SELECT company_id, slug, is_published, site_name, require_product_image, show_prices, bf_ativa, bf_titulo
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

/** Corpo do PUT validado, ou { erro }. */
function lerCorpo(body) {
  const b = body || {};
  const out = {};
  if (Object.prototype.hasOwnProperty.call(b, 'ativa')) {
    if (typeof b.ativa !== 'boolean') return { erro: 'ativa deve ser true ou false' };
    out.ativa = b.ativa;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'titulo')) {
    if (!TITULOS.includes(b.titulo)) return { erro: `titulo deve ser um de: ${TITULOS.join(', ')}` };
    out.titulo = b.titulo;
  }
  if (out.ativa === undefined && out.titulo === undefined) return { erro: 'Nada para mudar: envie ativa e/ou titulo' };
  return out;
}

router.put('/', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const cid = req.params.id;
  const pedido = lerCorpo(req.body);
  if (pedido.erro) return res.status(400).json({ error: pedido.erro });
  try {
    const config = await lerConfig(cid);
    if (!config) return res.status(409).json(SEM_LOJA_ONLINE);

    if (pedido.ativa === true && config.bf_ativa !== true) {
      const atual = await estado(cid, config);
      if (!atual.pode_ligar) return res.status(409).json(semPromocaoNaLoja(atual.promocoes.fora_da_loja));
    }

    const { rows } = await db.query(
      `UPDATE digital_channel_config
          SET bf_ativa = COALESCE($2::boolean, bf_ativa),
              bf_titulo = COALESCE($3::text, bf_titulo),
              updated_at = NOW()
        WHERE company_id = $1
        RETURNING company_id, slug, is_published, site_name, require_product_image, show_prices, bf_ativa, bf_titulo`,
      [cid, pedido.ativa === undefined ? null : pedido.ativa, pedido.titulo === undefined ? null : pedido.titulo]
    );
    const salvo = rows[0] || config;
    // A home da loja fica guardada 60 s: a faixa liga e desliga na hora.
    esquecerPagina(salvo.slug || undefined);

    logAuditAction(
      req.user?.id || null, cid, 'digital_channel.black_friday',
      `Campanha de Black Friday ${salvo.bf_ativa ? 'ligada' : 'desligada'} (${salvo.bf_titulo})`,
      { antes: { ativa: config.bf_ativa === true, titulo: config.bf_titulo }, depois: { ativa: salvo.bf_ativa === true, titulo: salvo.bf_titulo } },
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
