// ============================================================
// AURA Studio — A marca da loja no pos-compra (Fase 4 · BE-6)
//
// ── O PROBLEMA ─────────────────────────────────────────────────────────
// A cliente compra numa loja rosa, com a letra e o logo da lojista, e o
// link de aprovar a arte e o de acompanhar o pedido abriam numa pagina
// azul-marinho de outra empresa (app/aprovacao/[token].tsx cravava
// #1E3A8A). "Do link no WhatsApp ao 'Pronto', o cliente continua na mesma
// loja" (FASEAMENTO_VITRINE_STUDIO.md, Fase 4).
//
// ── O QUE ESTE MODULO FAZ ──────────────────────────────────────────────
//   1. `montarMarca`: o que a pagina publica precisa para se vestir de
//      loja — nome, logo, cor principal, tipografia, WhatsApp, endereco
//      da loja. So dado DA LOJA, que ja e publico na vitrine; nada do
//      cliente passa por aqui.
//   2. `linkDoPosCompra`: para onde os links de aprovacao e de
//      acompanhamento apontam. Com a chave `vitrine_v2` ligada, para o
//      endereco da loja (`<loja>/aprovacao/<token>`); desligada, para o
//      de sempre (APP_PUBLIC_URL). A chave e o que garante que o app que
//      desenha a pagina nova ja esta no ar naquela loja — mesma regra do
//      link do e-mail (digitalOrderNotifications.linkDoPedidoDaVitrine).
//
// Os enderecos antigos (`/aprovacao/<token>`, `/acompanhar/<token>`) nao
// saem do ar: sao links ja enviados no WhatsApp de clientes.
//
// Nome sem `name`: `companies` nao tem essa coluna (CLAUDE.md, armadilha
// 2). `site_name` da vitrine vence; sem ele, trade_name/legal_name.
// ============================================================
'use strict';

const db = require('../config/database');
const { vitrineV2Ligada } = require('./vitrineV2');

// Import tardio: storefrontBuilder carrega meio mundo, e as rotas publicas
// de aprovacao e acompanhamento nao precisam dele no resto do caminho.
function urlDaLojaDe(config) {
  const { urlDaLoja } = require('./storefrontBuilder');
  return urlDaLoja(config);
}

const texto = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * A marca da loja para a pagina publica, ou null quando a empresa nao
 * tem vitrine (sem slug nao ha endereco nem tema a aplicar).
 *
 * @param {object} row  digital_channel_config (+ company_display_name,
 *                      studio_settings de companies)
 */
function montarMarca(row) {
  if (!row || !texto(row.slug)) return null;
  const ss = row.studio_settings && typeof row.studio_settings === 'object' ? row.studio_settings : {};
  return {
    slug: String(row.slug).trim().toLowerCase(),
    nome: texto(row.site_name) || texto(row.company_display_name),
    logo_url: texto(row.logo_url),
    primary_color: texto(row.primary_color),
    font_family: texto(row.font_family) || 'classic',
    // O mesmo numero que a confirmacao do pedido usa (confirmacaoDoPedido).
    whatsapp: texto(row.whatsapp) || texto(row.phone) || texto(ss.approval_wa_phone),
    // "Ir para a loja" da pagina de link invalido e o "Pedir outro igual".
    url: urlDaLojaDe(row),
    // O app desenha a pagina nova no endereco antigo so com a chave: e a
    // chave que decide quando a loja real troca de cara (vitrineV2.js).
    vitrine_v2: vitrineV2Ligada(ss),
  };
}

const SQL_DA_MARCA = `
  SELECT dcc.slug, dcc.site_name, dcc.logo_url, dcc.primary_color, dcc.font_family,
         dcc.whatsapp, dcc.phone, dcc.address, dcc.is_published,
         dcc.custom_domain, dcc.custom_domain_status,
         COALESCE(c.trade_name, c.legal_name) AS company_display_name,
         COALESCE(c.studio_settings, '{}'::jsonb) AS studio_settings
    FROM digital_channel_config dcc
    JOIN companies c ON c.id = dcc.company_id
   WHERE dcc.company_id = $1
   LIMIT 1`;

/**
 * A linha da vitrine de uma empresa, ou null. Best-effort de proposito:
 * a marca e o enfeite da pagina, nunca o motivo de ela nao abrir — base
 * sem alguma coluna (42703/42P01) ou qualquer falha vira "sem marca", e a
 * pagina abre com o visual de sempre.
 */
async function vitrineDaEmpresa(companyId) {
  if (!companyId) return null;
  try {
    const { rows } = await db.query(SQL_DA_MARCA, [companyId]);
    return rows[0] || null;
  } catch (e) {
    if (e.code !== '42703' && e.code !== '42P01') {
      console.error('[marcaDaLoja] vitrine indisponivel:', e.message);
    }
    return null;
  }
}

/** A marca de uma empresa (ver montarMarca), ou null. */
async function marcaDaEmpresa(companyId) {
  return montarMarca(await vitrineDaEmpresa(companyId));
}

const TIPOS = new Set(['aprovacao', 'acompanhar']);

/**
 * O link de aprovacao ou de acompanhamento que a loja manda a cliente.
 *
 * @param {object} p
 * @param {object} p.config  digital_channel_config (slug, dominio proprio, is_published)
 * @param {object} p.studioSettings companies.studio_settings (a chave)
 * @param {'aprovacao'|'acompanhar'} p.tipo
 * @param {string} p.token
 */
function linkDoPosCompra({ config, studioSettings, tipo, token }) {
  if (!TIPOS.has(tipo)) throw new Error('tipo de link invalido: ' + tipo);
  const t = encodeURIComponent(String(token || ''));
  const ss = studioSettings !== undefined ? studioSettings : (config && config.studio_settings);
  // Loja despublicada nao serve a casca no endereco dela: o link iria
  // para um 404. Fica no endereco de sempre, que abre sem depender disso.
  const naLoja = config && texto(config.slug) && config.is_published !== false && vitrineV2Ligada(ss);
  if (naLoja) return `${urlDaLojaDe(config)}/${tipo}/${t}`;
  return `${process.env.APP_PUBLIC_URL || ''}/${tipo}/${t}`;
}

/** linkDoPosCompra de uma empresa, lendo a vitrine dela. */
async function linkDoPosCompraDaEmpresa(companyId, tipo, token) {
  const config = await vitrineDaEmpresa(companyId);
  return linkDoPosCompra({ config, tipo, token });
}

module.exports = {
  montarMarca,
  vitrineDaEmpresa,
  marcaDaEmpresa,
  linkDoPosCompra,
  linkDoPosCompraDaEmpresa,
};
