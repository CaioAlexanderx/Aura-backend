// ============================================================
// AURA Studio — Storefront Publico (sem auth)
// GET  /storefront/:slug/studio/products  — lista produtos personalizaveis
// POST /storefront/:slug/studio/order     — cria pedido Studio
// GET  /storefront/:slug/studio/order/:oid — poll status do pedido
// POST /storefront/:slug/studio/upload    — upload de imagem/pdf (cliente envia foto)
// GET  /storefront/:slug/studio/shipping-quote — cotacao de frete por CEP (S2)
// POST /storefront/:slug/studio/bulk-quote — preco de um lote, sem gravar (S0)
// POST /storefront/:slug/studio/bulk-order — registra o lote como rascunho (S0)
//
// Nivel 1 Sub-onda D (25/05/2026)
// 25/05/2026 (Loja Digital Studio fechamento):
//   + price_delta de option/color somado ao effectivePrice
//   + revisions policy exposta em products + poll (max_revisions_included,
//     extra_revision_price, revision_policy_text)
//   + upload R2 publico pro cliente enviar foto direto da pagina
// 26/05/2026 (Verso):
//   + back_price_delta somado ao subtotal quando customization.has_back_selected
// 03/06/2026 (Guia de medidas):
//   + UPLOAD_ALLOWED_TYPES agora aceita application/pdf (arte/gabarito do cliente)
//   + customization_config devolvido inteiro em GET /products (size_guide flui)
// 16/06/2026 (Visibilidade na vitrine):
//   + filtro studio_storefront_visible IS NOT FALSE em GET /products — o
//     lojista escolhe quais itens aparecem na Loja Virtual (toggle no
//     configurador do produto). Default true preserva o comportamento atual.
//
// Fluxo:
//  1. Cliente entra em loja.getaura.com.br/:slug/studio
//  2. Ve grid de produtos is_personalizable=true com customization_config
//  3. Toca produto -> abre configurador (fields text/image/template/color/option)
//  4. Preview SVG ao vivo via PersonalizationPreview no frontend
//  5. Envia POST com items[].customization JSONB
//  6. Backend cria digital_orders com vertical='studio',
//     studio_production_status='pending_art', e salva personalizacao
//     em digital_order_items.customization
//
// Pagamento: aceita Pix (estatico ou MP), cartao MP CheckoutPro, e
// on_delivery. Mesma logica do storefront.js — copiada aqui pra deixar
// o fluxo Studio independente e rastreavel.
//
// IMPORTANTE:
//  - Trigger fn_studio_consume_inputs_digital decrementa estoque de insumos
//    quando digital_order_items eh inserido com produto is_personalizable
//  - View studio_orders UNE digital_orders Studio + sales personalizaveis;
//    KDS de producao consome essa view
// ============================================================
'use strict';

const router              = require('express').Router();
const db                  = require('../config/database');
const notify              = require('../services/digitalOrderNotifications');
const { generatePix }     = require('../services/pixService');
const { onOrderConfirmed } = require('../services/digitalOrderConfirmation');
const { createMpPixPayment, createMpPreference } = require('../services/mpService');
const { uploadToR2 }      = require('../utils/r2Storage');
const { calculateShippingQuote } = require('../services/shippingQuote');
const { COURIER, validateCourierPickup } = require('../services/courierPickup');
const {
  fetchStorefrontCategories, fetchPrimaryCategoryLinks,
  // S0 do redesign (03/09/2026): banner e redes sociais existem no
  // digital_channel_config desde sempre e so a loja comum lia. A vitrine
  // Studio desenhava um cabecalho fixo e nao tinha rodape com contato.
  parseBanners,
  // Rodape (04/09/2026): o resumo de horario e o CNPJ formatado ja eram
  // calculados aqui para a loja comum. A vitrine Studio nao tinha rodape
  // nenhum — repetir as duas regras seria a quinta copia da mesma coisa.
  resumoDeHorario, formatarCnpj,
} = require('../services/storefrontBuilder');
const { montarRodape } = require('../services/rodapeInstitucional');
// Empresa de teste: nao notifica ninguem nem cria cobranca de verdade.
const { ehLojaDeTeste, anotarBloqueio, pixDeTeste } = require('../services/lojaDeTeste');
const { normalizarDataDoLote } = require('../services/dataDoLote');
// Pico: a loja continua no ar e o botao vira orcamento.
const { modoDaLoja } = require('../services/modoDaLoja');
const { rastreadoresDaLoja } = require('../services/rastreadores');
const { montarRedes } = require('../services/redesSociais');
const { cotarLote } = require('../services/studioLote');
const { unitPriceForQty, buildLadder } = require('../services/studioQtyTiers');
const { filtroDeFoto } = require('../services/catalogoPaginado');
// Selo NOVO com a mesma regra da loja comum (redesign 09/2026).
const { ehNovo } = require('../services/homeDaLoja');
const { initialArtStatus } = require('../services/artReview');

function validateCpfCnpj(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, '');
  if (d.length === 11) return validateCpf(d) ? d : false;
  if (d.length === 14) return validateCnpj(d) ? d : false;
  return false;
}
function validateCpf(d) {
  if (/^(\d)\1{10}$/.test(d)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += parseInt(d[i]) * (10 - i);
  let r = (s * 10) % 11; if (r === 10) r = 0;
  if (r !== parseInt(d[9])) return false;
  s = 0;
  for (let i = 0; i < 10; i++) s += parseInt(d[i]) * (11 - i);
  r = (s * 10) % 11; if (r === 10) r = 0;
  return r === parseInt(d[10]);
}
function validateCnpj(d) {
  if (/^(\d)\1{13}$/.test(d)) return false;
  const w1 = [5,4,3,2,9,8,7,6,5,4,3,2];
  const w2 = [6,5,4,3,2,9,8,7,6,5,4,3,2];
  let s = 0;
  for (let i = 0; i < 12; i++) s += parseInt(d[i]) * w1[i];
  let r = s % 11; r = r < 2 ? 0 : 11 - r;
  if (r !== parseInt(d[12])) return false;
  s = 0;
  for (let i = 0; i < 13; i++) s += parseInt(d[i]) * w2[i];
  r = s % 11; r = r < 2 ? 0 : 11 - r;
  return r === parseInt(d[13]);
}

// Visibility canonica de products (alinhada com storefrontBuilder/storefront.js)
function listVisibilityWhere(cidParam) {
  return `(company_id = ${cidParam} OR (
    is_group_shared = true
    AND company_id IN (
      SELECT id FROM companies
      WHERE COALESCE(NULLIF(billing_owner_company_id, id), id) = (
        SELECT COALESCE(NULLIF(billing_owner_company_id, id), id)
        FROM companies WHERE id = ${cidParam}
      )
    )
  ))`;
}

// ─────────────────────────────────────────────
// computeChoicesDelta — soma price_delta de campos do tipo
// 'option' / 'color' baseado nos valores selecionados em
// `customization`. Inclusivo: aceita value scalar ou array.
//
// Exemplo cfg.fields[i].config.choices = [
//   { value: 'p', label: 'Pequeno', price_delta: 0 },
//   { value: 'g', label: 'Grande',  price_delta: 5.00 }
// ]
// Se customization[fieldId] === 'g' → soma 5.00
// ─────────────────────────────────────────────
function computeChoicesDelta(cfg, customization) {
  if (!cfg || !Array.isArray(cfg.fields) || !customization) return 0;
  let delta = 0;
  for (const f of cfg.fields) {
    if (f.type !== 'option' && f.type !== 'color') continue;
    const choices = f.config?.choices;
    if (!Array.isArray(choices) || choices.length === 0) continue;
    const selected = customization[f.id];
    if (selected == null) continue;
    // Suporta scalar ou array (multi-select futuro)
    const sels = Array.isArray(selected) ? selected : [selected];
    for (const s of sels) {
      const c = choices.find(ch => ch.value === s || ch.label === s);
      if (c && typeof c.price_delta === 'number' && !isNaN(c.price_delta)) {
        delta += c.price_delta;
      }
    }
  }
  return delta;
}

// ─────────────────────────────────────────────
// computeBackDelta — retorna o valor cobrado pelo verso quando
// o cliente marca `customization.has_back_selected = true` E o
// produto tem cfg.has_back=true E cfg.back_charge_enabled=true.
// Retorna 0 em qualquer outro cenário (backwards-compatible).
// ─────────────────────────────────────────────
function computeBackDelta(cfg, customization) {
  if (!cfg || cfg.has_back !== true) return 0;
  if (cfg.back_charge_enabled !== true) return 0;
  if (!customization || customization.has_back_selected !== true) return 0;
  const v = cfg.back_price_delta;
  if (typeof v !== 'number' || !isFinite(v) || v <= 0) return 0;
  return v;
}

// ─────────────────────────────────────────────
// computeMiddleDelta — mesmo contrato do verso, para a faixa central /
// wrap 360 (caneca, copo). Cobrado so quando o cliente marca
// `customization.has_middle_selected = true` e a loja ligou a cobranca.
// ─────────────────────────────────────────────
function computeMiddleDelta(cfg, customization) {
  if (!cfg || cfg.has_middle !== true) return 0;
  if (cfg.middle_charge_enabled !== true) return 0;
  if (!customization || customization.has_middle_selected !== true) return 0;
  const v = cfg.middle_price_delta;
  if (typeof v !== 'number' || !isFinite(v) || v <= 0) return 0;
  return v;
}

// CORS publico — mesma config do storefront.js
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-ID');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Mesmo endereco da loja comum — as duas vitrines chamam a mesma API, e
// dividir isso em duas constantes e como as duas lojas divergem.
const { enderecoDaApi } = require('../config/enderecoDaApi');
const STOREFRONT_API_BASE = enderecoDaApi();

// Limites de upload (cliente envia foto/pdf pra personalizar)
const UPLOAD_MAX_BYTES = 15 * 1024 * 1024; // 15MB
const UPLOAD_ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'application/pdf',
]);

/**
 * O bloco `site` do payload, num lugar so.
 *
 * Ele nascia escrito DUAS vezes nesta mesma rota — uma no retorno de loja
 * sem produto, outra no retorno normal — e as duas ja tinham divergido: a
 * de cima nao mandava `tagline` nem `cover_url`. Campo que existe num
 * caminho e nao no outro e a loja mudando de cara conforme o estoque.
 *
 * S0 (03/09/2026) acrescenta banners e redes sociais. As duas colunas
 * existem no digital_channel_config desde sempre e so a loja comum lia:
 * a vitrine Studio desenhava um cabecalho fixo e um rodape sem contato.
 */
function montarSite(config, nomeDaEmpresa) {
  return {
    name: config.site_name || nomeDaEmpresa,
    tagline: config.tagline || '',
    primary_color: config.primary_color || '#1E3A8A',
    accent_color: config.accent_color || '#EC4899',
    logo_url: config.logo_url || null,
    cover_url: config.cover_url || null,
    // Tipografia escolhida pela lojista. A coluna `font_family` ja
    // existia e so a loja comum consumia; a vitrine Studio ignorava e
    // renderizava sempre no par padrao.
    font_family: config.font_family || 'classic',
    // Mesmo caso da tipografia: a coluna existe, o painel deixa escolher e
    // so a loja comum consumia.
    card_style: config.card_style || 'editorial',
    // WhatsApp da loja. A loja comum ja tinha barra de contato; a
    // vitrine Studio nao expunha o numero, entao a duvida de quem
    // esta comprando ("serve no meu tamanho?", "da tempo pro dia
    // 12?") nao tinha para onde ir — e essa duvida e o que fecha
    // venda de personalizado.
    whatsapp: config.whatsapp || config.phone || null,
    // A MESMA funcao da loja comum: banner com fallback para a capa e a
    // tagline, no maximo 3, e a versao de celular quando existe.
    banners: parseBanners(config.banners, config.cover_url, config.tagline, config.description),
    // Instagram, TikTok e Facebook normalizados, com a URL pronta.
    redes: montarRedes(config),
    // O que o rodape da loja comum mostra na coluna de identidade
    // (04/09/2026). Endereco, horario e CNPJ ja estavam no banco e so
    // aquela vitrine lia: a do Studio terminava a pagina no ultimo
    // produto, sem dizer de quem e a loja nem onde ela fica.
    endereco: config.address || '',
    horario_resumo: resumoDeHorario(config.business_hours, config.always_open === true),
    cnpj_formatado: formatarCnpj(config.company_cnpj),
    // GA4 e Pixel (04/09/2026): as colunas existiam desde a migration 220
    // e o painel gravava; nenhuma loja lia. Validados aqui — ID mal
    // copiado vira null, nao script quebrado. Ver services/rastreadores.js.
    rastreadores: rastreadoresDaLoja(config),
  };
}

// ─────────────────────────────────────────────
// GET /storefront/:slug/studio/products
// Lista produtos da loja onde is_personalizable=true, com
// customization_config + templates vinculados + estimativa SLA.
// + revisions policy (max_revisions_included, extra_revision_price,
//   revision_policy_text) pra cliente ver antes de comprar.
// customization_config e devolvido INTEIRO (p.customization_config);
// campos como size_guide gravados dentro dele fluem automaticamente.
// Filtra studio_storefront_visible IS NOT FALSE: o lojista oculta itens
// da vitrine pelo configurador do produto (Estoque Studio).
// ─────────────────────────────────────────────
router.get('/:slug/studio/products', async (req, res) => {
  try {
    const slug = req.params.slug.toLowerCase().trim();
    const { rows: configs } = await db.query(
      `SELECT dcc.*, COALESCE(c.trade_name, c.legal_name) AS company_display_name,
              c.cnpj AS company_cnpj,
              COALESCE(c.studio_settings, '{}'::jsonb) AS studio_settings
         FROM digital_channel_config dcc
         JOIN companies c ON c.id = dcc.company_id
        WHERE dcc.slug = $1 AND dcc.is_published = true`,
      [slug]
    );
    if (!configs.length) return res.status(404).json({ error: 'Loja nao encontrada' });
    const config = configs[0];
    const cid = config.company_id;
    const ss = config.studio_settings || {};

    // Lista produtos personalizaveis (respeita visibility canonica)
    const visibility = listVisibilityWhere('$1');
    // Migration 308 — a MESMA regra da loja comum. Campo de produto que
    // vale de um lado e nao do outro ja foi o bug daqui quatro vezes;
    // ver __tests__/paridadeDosPayloads.js.
    const comFoto = filtroDeFoto(config.require_product_image === true);
    // Migration 305 — ficha tecnica. Tentar-e-cair: o backend nao roda
    // migration no boot, entao coluna nova sempre tem um intervalo em que
    // o codigo subiu e o banco nao.
    const consultaProdutos = (colsFicha) => db.query(
      `SELECT id, name, description, price, image_url, image_thumb_url, gallery_urls, category, stock_qty, created_at,
              ${colsFicha}
              customization_config
         FROM products
        WHERE ${visibility}
          AND is_active IS NOT FALSE
          AND is_personalizable = true
          AND customization_config IS NOT NULL
          AND studio_storefront_visible IS NOT FALSE
          AND ${comFoto}
        ORDER BY created_at DESC
        LIMIT 200`,
      [cid]
    );

    let products;
    try {
      ({ rows: products } = await consultaProdutos('material, medidas, cuidados,'));
    } catch (e) {
      if (e.code !== '42703') throw e;
      ({ rows: products } = await consultaProdutos(''));
    }

    // Revisions policy — exposta sempre (default null/0 = sem limite/preco)
    const revisions = {
      max_included: ss.max_revisions_included != null
        ? parseInt(ss.max_revisions_included) : 0,
      extra_price: ss.extra_revision_price != null
        ? parseFloat(ss.extra_revision_price) : 0,
      policy_text: ss.revision_policy_text || null,
    };

    // Detecta gateway de pagamento (Pix MP, Pix estatico, Cartao).
    //
    // Sobe ANTES do retorno de loja vazia (04/09/2026) porque o rodape
    // institucional lista as formas de pagamento, e ele existe nos dois
    // retornos. Calcular a lista so no caminho com produto faria a loja
    // recem-aberta anunciar formas diferentes da mesma loja com produto.
    let hasMpGateway = false;
    try {
      const { rows: gws } = await db.query(
        `SELECT id FROM companies_payment_gateways WHERE company_id = $1 AND gateway = 'mercadopago' LIMIT 1`,
        [cid]
      );
      hasMpGateway = gws.length > 0;
    } catch (_) {}
    const hasStaticPix = !!(config.pix_key && String(config.pix_key).trim());
    const hasPix = hasStaticPix || hasMpGateway;
    const cardEnabled = config.card_enabled !== false;
    const hasCard = hasMpGateway && cardEnabled;
    const hasOnDelivery = !!config.pay_on_delivery_enabled;

    // As formas de pagamento e a politica de troca JA RESOLVIDAS pelo
    // mesmo modulo que a loja comum usa. Se a vitrine remontasse a lista,
    // uma correcao no texto valeria numa loja e nao na outra.
    const rodape_institucional = montarRodape(
      { has_pix: hasPix, has_card: hasCard, pay_on_delivery_enabled: hasOnDelivery },
      config.politica_troca
    );

    if (!products.length) {
      return res.json({
        site: montarSite(config, configs[0].company_display_name),
        products: [],
        sla: { sla_base_days: 3, queue_qty: 0, total_estimate_days: 3 },
        revisions,
        numeros: { pedidos_entregues: 0 },
        pedidos: modoDaLoja(config),
        rodape_institucional,
        total_products: 0,
      });
    }

    // Pra cada produto, templates vinculados (specificos + globais)
    const productIds = products.map(p => p.id);
    let templatesByProduct = {};
    try {
      const { rows: tplRows } = await db.query(
        `SELECT pt.product_id, t.id, t.name, t.description,
                t.image_url, t.thumb_url, t.tags,
                tc.name AS category_name
           FROM studio_product_templates pt
           JOIN studio_templates t ON t.id = pt.template_id
           LEFT JOIN studio_template_categories tc ON tc.id = t.category_id
          WHERE pt.company_id = $1
            AND (pt.product_id = ANY($2::uuid[]) OR pt.product_id IS NULL)
            AND t.is_active = true
          ORDER BY pt.sort_order, t.use_count DESC
          LIMIT 500`,
        [cid, productIds]
      );
      for (const r of tplRows) {
        const pid = r.product_id || '__global__';
        if (!templatesByProduct[pid]) templatesByProduct[pid] = [];
        templatesByProduct[pid].push({
          id: r.id, name: r.name, description: r.description,
          image_url: r.image_url, thumb_url: r.thumb_url,
          tags: r.tags || [], category_name: r.category_name || null,
        });
      }
    } catch (_) { /* tabela pode nao existir em deploy antigo */ }

    // SLA estimate dinamico: base + ceil(fila / capacidade)
    const slaBaseDays = ss.default_sla_days != null ? parseInt(ss.default_sla_days) : 3;
    const capacity = Math.max(
      ss.production_capacity_per_day != null ? parseInt(ss.production_capacity_per_day) : 10,
      1
    );

    let queueQty = 0;
    try {
      const qRes = await db.query(
        `SELECT COUNT(*)::int AS qty
           FROM digital_orders
          WHERE company_id = $1 AND vertical = 'studio'
            AND studio_production_status IN ('pending_art', 'approved', 'in_production')`,
        [cid]
      );
      queueQty = parseInt(qRes.rows[0]?.qty || 0);
    } catch (_) {}

    const queueDays = Math.ceil(queueQty / capacity);
    const slaTotal = slaBaseDays + queueDays;

    // S1 (19/08/2026) — árvore de categorias no payload do Studio.
    //
    // O D3 levou a taxonomia da F0 para o payload da loja comum, mas não
    // para este. Aqui só saía o texto legado `category`, e sem id nem
    // path não há como a vitrine agrupar as 9 canecas numa página só.
    //
    // Os dois helpers vêm de storefrontBuilder de propósito: as regras
    // que importam — só categoria com is_visible_storefront entra, e só
    // o vínculo primário sai — valem igual nos dois storefronts, e uma
    // segunda implementação divergiria na primeira mudança.
    //
    // Aditivo: `category` (texto) permanece, e os campos novos saem null
    // em catálogo pré-migração. Loja sem as migrations 257/258 recebe
    // categories: [] e o payload fica idêntico ao de antes.
    // S6 (19/08/2026) — desconto progressivo. `qty_tiers` existia desde o
    // configurador de preco do lojista e NUNCA chegava na loja: o unico
    // leitor era o simulador de custo, que e outra conta (custo + mao de
    // obra + margem). Aqui sai so a escada de preco unitario — nenhum
    // campo de custo atravessa para o payload publico.
    let tiersByProduct = {};
    try {
      const { rows: regras } = await db.query(
        `SELECT product_id, qty_tiers
           FROM studio_pricing_rules
          WHERE company_id = $1 AND is_active IS NOT FALSE
            AND qty_tiers IS NOT NULL`,
        [cid]
      );
      regras.forEach((r) => { tiersByProduct[r.product_id] = r.qty_tiers; });
    } catch (e) {
      // Tabela ausente neste ambiente: loja segue sem escada (armadilha 10).
      if (e.code !== '42P01' && e.code !== '42703') throw e;
    }
    // A regra GLOBAL (product_id NULL) vale para todo produto sem regra
    // propria. Ela ficava guardada na chave "null" e ninguem a lia: a
    // lojista configurava uma escada para a loja inteira e a vitrine
    // seguia sem desconto (04/09/2026).
    const tiersGlobais = tiersByProduct['null'] ?? null;
    const faixasDe = (productId) => tiersByProduct[productId] ?? tiersGlobais;

    // S0 (03/09/2026) — quantos pedidos cada peca ja teve, e quantos a
    // loja ja entregou.
    //
    // A home do design abre com "Os queridinhos da Sheid" e um numero de
    // pedidos entregues. Os dois nasciam de contagem no cliente, que so
    // enxerga a pagina atual, ou de numero inventado. Aqui sai do banco.
    //
    // Cancelado nao conta, senao pedido desfeito viraria popularidade. A
    // janela e a vida inteira da loja de proposito: personalizado vende
    // pouco e devagar, e a janela de 90 dias da loja comum zeraria o
    // ranking de quase toda loja Studio.
    let pedidosPorProduto = {};
    let entregues = 0;
    try {
      const { rows } = await db.query(
        `SELECT i.product_id, COUNT(*)::int AS pedidos
           FROM digital_order_items i
           JOIN digital_orders o ON o.id = i.order_id
          WHERE o.company_id = $1
            AND o.vertical = 'studio'
            AND COALESCE(o.status, '') <> 'cancelled'
            AND i.product_id = ANY($2::uuid[])
          GROUP BY i.product_id`,
        [cid, productIds]
      );
      rows.forEach((r) => { pedidosPorProduto[r.product_id] = r.pedidos; });

      const { rows: ent } = await db.query(
        `SELECT COUNT(*)::int AS n FROM digital_orders
          WHERE company_id = $1 AND vertical = 'studio' AND delivered_at IS NOT NULL`,
        [cid]
      );
      entregues = ent[0] ? ent[0].n : 0;
    } catch (e) {
      // Coluna ou tabela ausente neste ambiente: a loja segue sem ranking
      // (armadilha 1). Bloco vazio some da home, que e o comportamento certo.
      if (e.code !== '42703' && e.code !== '42P01') throw e;
    }

    // S0 — que TIPO de mockup cada peca tem.
    //
    // `visual_template_key` ja saia implicitamente pelo endpoint de
    // template, um por produto e sob demanda. O card da vitrine precisa
    // do chip "Mockup 3D" na grade inteira, e 12 requisicoes para
    // desenhar 12 chips e o tipo de coisa que faz a grade piscar.
    let visualPorProduto = {};
    try {
      const { rows } = await db.query(
        `SELECT p.id, t.kind
           FROM products p
           JOIN studio_visual_templates t
             ON t.key = p.visual_template_key AND t.status = 'published'
          WHERE p.id = ANY($1::uuid[])`,
        [productIds]
      );
      rows.forEach((r) => { visualPorProduto[r.id] = r.kind; });
    } catch (e) {
      // Migration 208 pendente: sem chip, com a loja inteira de pe.
      if (e.code !== '42703' && e.code !== '42P01') throw e;
    }

    const categories = await fetchStorefrontCategories(cid);
    const categoryById = {};
    categories.forEach(c => { categoryById[c.id] = c; });
    const primaryLinkByProduct = await fetchPrimaryCategoryLinks(products.map(p => p.id));

    res.json({
      site: montarSite(config, configs[0].company_display_name),
      products: products.map(p => {
        // Produto compartilhado de outra empresa não arrasta a categoria
        // dela: só entra vínculo cuja categoria está na árvore DESTA loja.
        const cat = categoryById[primaryLinkByProduct[p.id]] || null;
        return {
          id: p.id,
          name: p.name,
          description: p.description || null,
          price: parseFloat(p.price),
          image_url: p.image_url || null,
          // Migration 317 — miniatura, a mesma da loja comum.
          thumb_url: p.image_thumb_url || null,
          // S9 — carrossel de fotos. A capa e o indice 0 e espelha
          // image_url; produto sem galeria devolve [] e o consumidor cai
          // na foto unica de antes.
          gallery_urls: Array.isArray(p.gallery_urls) ? p.gallery_urls : [],
          category: p.category || null,
          // Migration 305 — ficha tecnica. A loja comum ja mostra; a
          // vitrine nasceu sem porque esta rota tem o proprio mapeamento
          // de produto, separado de montarProdutoPublico. Sem isto a
          // ficha ja teria divergido no dia em que foi criada.
          material: p.material || null,
          medidas:  p.medidas  || null,
          cuidados: p.cuidados || null,
          // Redesign 09/2026 — selo NOVO, a mesma regra da loja comum
          // (services/homeDaLoja.js). O teste de paridade exige nos dois.
          is_new: ehNovo(p.created_at),
          category_id:   cat ? cat.id   : null,
          category_slug: cat ? cat.slug : null,
          category_path: cat ? cat.path : null,
          // S6 — escada de desconto por quantidade. [] quando a lojista
          // nao configurou faixa nenhuma, que e o caso de toda a base hoje.
          qty_tiers: buildLadder(parseFloat(p.price), faixasDe(p.id)),
          stock_qty: p.stock_qty,
          // S0 — quantos pedidos esta peca ja teve. O bloco "mais
          // pedidos" da home ordena por aqui e some quando ninguem
          // pediu nada ainda, que e o caso de toda loja Studio nova.
          pedidos: pedidosPorProduto[p.id] || 0,
          // S0 — 'model3d' | 'photo2d' | null. Vira o chip "Mockup 3D"
          // no card sem uma requisicao por produto.
          visual_kind: visualPorProduto[p.id] || null,
          customization_config: p.customization_config,
          templates: [
            ...(templatesByProduct[p.id] || []),
            ...(templatesByProduct.__global__ || []),
          ],
        };
      }),
      // Lista FLAT com parent_id — o cliente deriva a hierarquia, mesmo
      // formato do payload da loja comum e do GET /product-categories.
      categories: categories.map(c => ({
        id: c.id, name: c.name, slug: c.slug,
        path: c.path, depth: c.depth, parent_id: c.parent_id,
      })),
      sla: {
        sla_base_days: slaBaseDays,
        queue_qty: queueQty,
        capacity_per_day: capacity,
        queue_added_days: queueDays,
        // 04/09/2026 (decisao do Caio): o prazo que a loja promete e a
        // estimativa que a LOJISTA definiu, sempre. Somar a fila por cima
        // fazia a primeira caneca do dia empurrar a promessa de 3 para 4
        // dias (⌈1/10⌉ = 1), e a cliente lia um numero que ninguem tinha
        // prometido. A fila continua no payload para o painel mostrar;
        // ela so nao decide mais o que a vitrine escreve.
        total_estimate_days: slaBaseDays,
      },
      revisions,
      // S0 — os numeros que a home mostra na faixa de confianca. Saem do
      // banco ou nao saem; numero de vitrine inventado e o tipo de coisa
      // que a lojista descobre quando um cliente pergunta.
      numeros: { pedidos_entregues: entregues },
      // Pico: `aceita: false` mantem a vitrine inteira e troca o botao
      // por "pedir orcamento". Nunca vem sem motivo — loja sem botao de
      // comprar e sem explicacao parece quebrada.
      pedidos: modoDaLoja(config),
      // O mesmo rodape da loja comum: como pagar e o que acontece se a
      // peca nao servir. Sai de services/rodapeInstitucional.js.
      rodape_institucional,
      payment: {
        has_pix: hasPix,
        has_card: hasCard,
        pay_on_delivery_enabled: hasOnDelivery,
        // S0 — paridade com a loja comum (migration 309/316). O Studio
        // anunciava nada e cobrava cheio; a loja comum anuncia e cobra
        // com desconto desde a fase 6. Duas vitrines da mesma empresa
        // com regra de dinheiro diferente e o bug esperando a vez.
        pix_discount_pct: Number(config.pix_discount_pct) || 0,
        // Migration 301 — teto de parcelas DECLARADO pela lojista. So faz
        // sentido com cartao ligado: sem cartao nao ha o que parcelar.
        card_max_installments: hasCard ? (config.card_max_installments || null) : null,
      },
      // migration 288 — este payload nao expunha modalidade de entrega
      // nenhuma, entao o checkout do Studio oferecia "Retirar na loja" e
      // "Receber em casa" fixos, mesmo em loja com delivery_enabled=false
      // (o cliente escolhia e tomava 400 no fechamento). Agora as tres
      // modalidades vem do config, no mesmo formato que storefrontBuilder
      // usa na loja comum.
      delivery: {
        pickup_enabled:         config.pickup_enabled !== false,
        delivery_enabled:       config.delivery_enabled || false,
        courier_pickup_enabled: config.courier_pickup_enabled === true,
        delivery_fee:           parseFloat(config.delivery_fee) || 0,
        pickup_eta_text:        config.pickup_eta_text   || null,
        delivery_eta_text:      config.delivery_eta_text || null,
      },
      total_products: products.length,
    });
  } catch (err) {
    console.error('[studio-storefront] products error:', err);
    res.status(500).json({ error: 'Erro ao listar produtos personalizaveis' });
  }
});

// ─────────────────────────────────────────────
// Validacao de customization vs customization_config do produto
//
// 18/08/2026 — S0 (F1_CONTEUDO_STUDIO.md): a regra "todo campo required
// e exigido isoladamente" tornava a compra IMPOSSIVEL em loja publicada.
// A Sheid Mania marcou "Obrigatorio" em Texto, Foto do cliente, Template
// da galeria e Cor ao mesmo tempo. A intencao da lojista e legitima ("o
// cliente precisa me dizer o que estampar"), mas `image` e `template`
// preenchem o MESMO slot de arte — o proprio motor visual le
// `values.image || values.template` (compose3dMug.ts). Exigir os dois
// juntos e uma condicao que nenhum cliente consegue satisfazer.
//
// Duas correcoes, ambas espelhadas em useStorefront.ts (commitConfigure)
// no aura-app. As duas validacoes precisam concordar: divergencia entre
// elas faz o app aceitar o item no carrinho e o backend recusar o pedido
// no fechamento — o pior dos dois mundos pro cliente.
//
//   1. GRUPO DE ORIGEM DA ARTE: campos `image` e `template` do mesmo lado
//      formam um grupo. Se ao menos um for required, basta UM preenchido.
//      Com um unico campo do tipo no lado, o comportamento e identico ao
//      anterior — nao ha relaxamento onde a lojista pediu um campo so.
//      `art_service = 'designer'` ("crie minha arte pra mim") satisfaz o
//      grupo inteiro: quem contratou a criacao nao tem arte pra enviar.
//
//   2. LADO INATIVO: campo `side: 'back'` so e exigido quando o verso
//      esta ativo, replicando effectiveBackSelected do app. Antes, produto
//      com verso opcional e campo obrigatorio no verso era aceito pelo app
//      e recusado aqui.
// ─────────────────────────────────────────────
const ART_SOURCE_TYPES = new Set(['image', 'template']);

function isFilledValue(v) {
  return !(v == null || (typeof v === 'string' && !v.trim()));
}

// Mesma regra de effectiveBackSelected (aura-app): verso sem cobranca
// esta sempre ativo; com cobranca, depende da escolha do cliente.
function backIsActive(config, values) {
  if (!config || config.has_back !== true) return false;
  if (config.back_charge_enabled !== true) return true;
  return !!values && values.has_back_selected === true;
}

// Mesma regra do verso para a faixa central (caneca/copo).
function middleIsActive(config, values) {
  if (!config || config.has_middle !== true) return false;
  if (config.middle_charge_enabled !== true) return true;
  return !!values && values.has_middle_selected === true;
}

function fieldSideOf(f) {
  if (!f) return 'front';
  if (f.side === 'back') return 'back';
  if (f.side === 'middle') return 'middle';
  return 'front';
}

function validateCustomizationValues(config, values) {
  if (!config || typeof config !== 'object') return null; // produto nao personalizavel
  if (!values || typeof values !== 'object') {
    return 'customization obrigatoria';
  }
  if (!Array.isArray(config.fields)) return null;

  const backActive = backIsActive(config, values);
  const middleActive = middleIsActive(config, values);
  const ladoAtivo = (lado) =>
    lado === 'back' ? backActive : lado === 'middle' ? middleActive : true;
  const fields = config.fields.filter((f) => f && ladoAtivo(fieldSideOf(f)));

  // "Crie minha arte pra mim" dispensa o cliente de enviar arte.
  const artServiceHired = fields.some(
    (f) => f.config && f.config.is_art_service === true && values[f.id] === 'designer'
  );

  // Grupo de origem da arte, por lado.
  for (const side of ['front', 'back', 'middle']) {
    const group = fields.filter(
      (f) => ART_SOURCE_TYPES.has(f.type) && fieldSideOf(f) === side
    );
    if (!group.some((f) => f.required)) continue;
    if (artServiceHired) continue;
    if (group.some((f) => isFilledValue(values[f.id]))) continue;
    const labels = group.map((f) => `"${f.label || f.id}"`).join(' ou ');
    return `informe a arte em ${labels}`;
  }

  for (const f of fields) {
    if (ART_SOURCE_TYPES.has(f.type)) continue; // ja coberto pelo grupo
    if (f.required && !isFilledValue(values[f.id])) {
      return `campo "${f.label || f.id}" obrigatorio`;
    }
  }
  return null;
}

// ─────────────────────────────────────────────
// POST /storefront/:slug/studio/upload
// Upload publico de imagem ou PDF (cliente envia foto/gabarito direto da pagina).
// Sem auth — protegido por slug + tamanho/tipo + key isolada por company.
// Body: { content_base64, content_type, filename? }
// Tipos aceitos: image/png, image/jpeg, image/jpg, image/webp, application/pdf
// Para application/pdf: split('/').pop() retorna 'pdf' — ext correta automaticamente.
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// GET /storefront/:slug/studio/shipping-quote?cep=&subtotal=
//
// 18/08/2026 — S2 (F1_CONTEUDO_STUDIO.md §3.4). A loja comum calcula
// frete por CEP desde a Fase 5b; o Studio cobrava sempre o delivery_fee
// fixo e ignorava frete gratis acima de X e faixa por distancia, mesmo
// com a lojista tendo configurado as duas coisas no mesmo
// digital_channel_config. Quem vende caneca personalizada vende para
// fora da cidade — sem cotacao, o cliente so descobre o frete depois de
// preencher o pedido inteiro.
//
// A regra em si nao e reimplementada: calculateShippingQuote recebe a
// row de digital_channel_config, e o Studio resolve a MESMA row pelo
// slug. Uma implementacao, dois storefronts.
// ─────────────────────────────────────────────
router.get('/:slug/studio/shipping-quote', async (req, res) => {
  try {
    const slug = req.params.slug.toLowerCase().trim();
    const { rows } = await db.query(
      `SELECT * FROM digital_channel_config WHERE slug = $1 AND is_published = true`,
      [slug]
    );
    if (!rows.length) return res.status(404).json({ error: 'Loja nao encontrada' });
    const config = rows[0];

    if (!config.delivery_enabled) {
      return res.status(400).json({ error: 'Loja nao faz entregas' });
    }

    const cep = String(req.query.cep || '').trim();
    if (!cep) return res.status(400).json({ error: 'cep obrigatorio' });

    const subtotal = parseFloat(req.query.subtotal) || 0;
    if (subtotal < 0) return res.status(400).json({ error: 'subtotal invalido' });

    const quote = await calculateShippingQuote(config, cep, subtotal);
    res.json(quote);
  } catch (err) {
    console.error('[studio-storefront] shipping-quote error:', err);
    res.status(500).json({ error: 'Erro ao calcular frete' });
  }
});

router.post('/:slug/studio/upload', async (req, res) => {
  try {
    const slug = req.params.slug.toLowerCase().trim();
    const { content_base64, content_type, filename } = req.body || {};

    if (!content_base64 || typeof content_base64 !== 'string') {
      return res.status(400).json({ error: 'content_base64 obrigatorio' });
    }
    if (!content_type || !UPLOAD_ALLOWED_TYPES.has(String(content_type).toLowerCase())) {
      return res.status(400).json({
        error: 'content_type invalido. Aceitos: ' + Array.from(UPLOAD_ALLOWED_TYPES).join(', ')
      });
    }

    // Resolve cid pelo slug
    const { rows: configs } = await db.query(
      `SELECT company_id FROM digital_channel_config
        WHERE slug = $1 AND is_published = true LIMIT 1`,
      [slug]
    );
    if (!configs.length) return res.status(404).json({ error: 'Loja nao encontrada' });
    const cid = configs[0].company_id;

    // Decodifica base64 + valida tamanho
    let buf;
    try {
      // Aceita data URL (data:image/png;base64,...) ou base64 puro
      const b64 = content_base64.includes(',')
        ? content_base64.split(',')[1]
        : content_base64;
      buf = Buffer.from(b64, 'base64');
    } catch (e) {
      return res.status(400).json({ error: 'content_base64 invalido' });
    }
    if (buf.length === 0) {
      return res.status(400).json({ error: 'arquivo vazio' });
    }
    if (buf.length > UPLOAD_MAX_BYTES) {
      return res.status(413).json({
        error: `arquivo muito grande (max ${UPLOAD_MAX_BYTES / (1024*1024)}MB)`
      });
    }

    // Key isolada por company pra evitar colisao entre lojas
    // Para application/pdf: split('/').pop() retorna 'pdf' corretamente
    const ext = String(content_type).split('/').pop().replace('jpeg', 'jpg');
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 10);
    const key = `studio/storefront/${cid}/${ts}-${rand}.${ext}`;

    const r = await uploadToR2(key, buf, content_type);
    if (!r?.success) {
      console.error('[studio-storefront/upload] uploadToR2 falhou', r);
      return res.status(500).json({ error: 'Erro ao salvar arquivo' });
    }

    res.json({
      ok: true,
      url: r.url,
      key: r.key,
      content_type,
      size_bytes: buf.length,
    });
  } catch (err) {
    console.error('[studio-storefront/upload] error:', err);
    res.status(500).json({ error: 'Erro ao processar upload' });
  }
});

// ─────────────────────────────────────────────
// POST /storefront/:slug/studio/order
// Cria pedido Studio (digital_orders + digital_order_items
//  com customization JSONB). Marca vertical='studio' e
//  studio_production_status='pending_art' automaticamente.
//
// effectivePrice = product.price + soma(price_delta das choices
//   selecionadas em customization.option/color) + back_delta
//   (quando customization.has_back_selected e cfg.back_charge_enabled)
// ─────────────────────────────────────────────
router.post('/:slug/studio/order', async (req, res) => {
  const slug = req.params.slug.toLowerCase().trim();
  const {
    customer_name, customer_phone, customer_email,
    delivery_type, delivery_address, notes, items,
    payment_method,
    request_nfce, customer_cpf_cnpj,
    address_zip, address_street, address_number, address_complement,
    address_neighborhood, address_city, address_state,
    expected_delivery_fee,
  } = req.body;

  if (!customer_name || !customer_phone) {
    return res.status(400).json({ error: 'Nome e telefone sao obrigatorios' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Informe ao menos 1 item no pedido' });
  }

  try {
    const { rows: configs } = await db.query(
      `SELECT dcc.*, COALESCE(c.trade_name, c.legal_name) AS company_display_name
         FROM digital_channel_config dcc
         JOIN companies c ON c.id = dcc.company_id
        WHERE dcc.slug = $1 AND dcc.is_published = true`, [slug]);
    if (!configs.length) return res.status(404).json({ error: 'Loja nao encontrada' });
    const config = configs[0];
    const cid = config.company_id;

    // A trava do pico vale no SERVIDOR, nao so no botao. Uma pagina
    // aberta antes de a lojista fechar a loja continuaria enviando — e o
    // pedido que ela nao consegue produzir entraria assim mesmo.
    const modo = modoDaLoja(config);
    if (!modo.aceita) {
      return res.status(409).json({
        error: modo.recado,
        motivo: modo.motivo,
        pedidos_ate: modo.pedidos_ate,
      });
    }

    // MP gateway
    let mpGateway = null;
    try {
      const { rows: gws } = await db.query(
        `SELECT access_token, public_key FROM companies_payment_gateways WHERE company_id = $1 AND gateway = 'mercadopago' LIMIT 1`,
        [cid]
      );
      mpGateway = gws[0] || null;
    } catch (_) {}
    const hasMpGateway = !!mpGateway;
    const cardEnabled = config.card_enabled !== false;
    const hasCard = hasMpGateway && cardEnabled;
    const hasStaticPix = !!(config.pix_key && String(config.pix_key).trim());
    const hasPix = hasStaticPix || hasMpGateway;
    const hasOnDelivery = !!config.pay_on_delivery_enabled;

    const dtype = delivery_type || 'pickup';
    if (dtype === 'delivery' && !config.delivery_enabled) {
      return res.status(400).json({ error: 'Entrega nao disponivel nesta loja' });
    }
    if (dtype === 'pickup' && config.pickup_enabled === false) {
      return res.status(400).json({ error: 'Retirada nao disponivel nesta loja' });
    }

    // Retirada por app (migration 288): o cliente contrata Uber/99 e diz
    // quem vai buscar. Sem nome e placa a lojista entrega a personalizacao
    // de alguem para o primeiro motoboy que citar o numero do pedido.
    let courierData = null;
    if (dtype === COURIER) {
      const r = validateCourierPickup(config, req.body);
      if (r.error) return res.status(400).json({ error: r.error });
      courierData = r;
    }

    let cpfNorm = null;
    if (request_nfce || customer_cpf_cnpj) {
      cpfNorm = validateCpfCnpj(customer_cpf_cnpj);
      if (cpfNorm === false) {
        return res.status(400).json({ error: 'CPF/CNPJ invalido' });
      }
      if (request_nfce && !cpfNorm) {
        return res.status(400).json({ error: 'CPF/CNPJ obrigatorio quando solicitar NFCe' });
      }
    }

    let pmethod = (payment_method || '').toLowerCase().trim();
    if (!pmethod) {
      pmethod = hasPix ? 'pix' : (hasCard ? 'card' : (hasOnDelivery ? 'on_delivery' : null));
    }
    if (!pmethod) {
      return res.status(400).json({ error: 'Esta loja nao aceita pagamentos no momento' });
    }
    if (!['pix', 'card', 'on_delivery'].includes(pmethod)) {
      return res.status(400).json({ error: 'payment_method invalido. Use pix, card ou on_delivery' });
    }
    if (pmethod === 'pix' && !hasPix) {
      return res.status(400).json({ error: 'Esta loja nao aceita Pix' });
    }
    if (pmethod === 'card' && !hasCard) {
      return res.status(400).json({ error: 'Esta loja nao aceita cartao' });
    }
    if (pmethod === 'on_delivery' && !hasOnDelivery) {
      return res.status(400).json({ error: 'Esta loja nao aceita pagamento na entrega' });
    }

    // Busca produtos + valida que todos sao personalizaveis
    const productIds = items.map(i => i.product_id);
    const { rows: products } = await db.query(
      `SELECT id, name, price, stock_qty, image_url, is_active,
              is_personalizable, customization_config
         FROM products
        WHERE id::text = ANY($1) AND ${listVisibilityWhere('$2')}`,
      [productIds.map(String), cid]
    );
    const productMap = Object.fromEntries(products.map(p => [p.id, p]));

    // S6 — as faixas de quantidade que o payload publico exibiu. Sao
    // relidas aqui do banco, nunca aceitas do cliente: preco de venda e
    // decisao do servidor.
    const tiersByProductOrder = {};
    try {
      const { rows: regras } = await db.query(
        `SELECT product_id, qty_tiers
           FROM studio_pricing_rules
          WHERE company_id = $1 AND is_active IS NOT FALSE
            AND qty_tiers IS NOT NULL`,
        [cid]
      );
      regras.forEach((r) => { tiersByProductOrder[r.product_id] = r.qty_tiers; });
      // A mesma queda para a regra global que a listagem faz: o pedido
      // tem que cobrar o preco que a pagina mostrou.
      if (tiersByProductOrder['null'] != null) {
        tiersByProductOrder.__global = tiersByProductOrder['null'];
      }
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') throw e;
    }

    const orderItems = [];
    let subtotal = 0;
    let hasStudioItem = false;
    let totalBackDeltaAdded = 0; // rastreabilidade pro log
    let totalMiddleDeltaAdded = 0;

    for (const item of items) {
      const p = productMap[item.product_id];
      if (!p) return res.status(400).json({ error: `Produto ${item.product_id} nao encontrado` });
      if (p.is_active === false) return res.status(400).json({ error: `Produto "${p.name}" nao esta disponivel` });
      if (!p.is_personalizable) {
        return res.status(400).json({ error: `Produto "${p.name}" nao e personalizavel — use /storefront/:slug/order` });
      }

      const qty = parseInt(item.quantity) || 1;
      if (qty < 1) return res.status(400).json({ error: `Quantidade invalida para "${p.name}"` });

      // Valida customization values vs config (campos required)
      const cfg = p.customization_config;
      const valErr = validateCustomizationValues(cfg, item.customization);
      if (valErr) {
        return res.status(400).json({ error: `Personalizacao de "${p.name}": ${valErr}` });
      }

      // S6 — desconto progressivo. A faixa incide sobre o preco de tabela;
      // os deltas de personalizacao sao adicionais e entram DEPOIS. Sem
      // isso o cliente veria a escada na pagina e pagaria o preco cheio.
      const listPrice = parseFloat(p.price);
      const basePrice = unitPriceForQty(
        listPrice, tiersByProductOrder[p.id] ?? tiersByProductOrder.__global, qty);
      if (basePrice !== listPrice) {
        console.log(`[studio/storefront/order] faixa de quantidade em "${p.name}": ${qty}un R$${listPrice.toFixed(2)} -> R$${basePrice.toFixed(2)}`);
      }
      const choicesDelta = computeChoicesDelta(cfg, item.customization);

      // Verso (frente/verso) — soma back_price_delta quando cliente marcou
      const backDelta = computeBackDelta(cfg, item.customization);
      if (backDelta > 0) {
        const itemBackTotal = backDelta * qty;
        totalBackDeltaAdded += itemBackTotal;
        console.log(`[studio/storefront/order] back delta aplicado em "${p.name}": R$${backDelta.toFixed(2)} x ${qty} = R$${itemBackTotal.toFixed(2)}`);
      }

      // Meio (faixa central / wrap 360) — mesmo contrato do verso
      const middleDelta = computeMiddleDelta(cfg, item.customization);
      if (middleDelta > 0) {
        const itemMiddleTotal = middleDelta * qty;
        totalMiddleDeltaAdded += itemMiddleTotal;
        console.log(`[studio/storefront/order] middle delta aplicado em "${p.name}": R$${middleDelta.toFixed(2)} x ${qty} = R$${itemMiddleTotal.toFixed(2)}`);
      }

      const effectivePrice = basePrice + choicesDelta + backDelta + middleDelta;
      const itemSubtotal = effectivePrice * qty;
      subtotal += itemSubtotal;
      hasStudioItem = true;

      orderItems.push({
        product_id:    p.id,
        product_name:  p.name,
        product_image: p.image_url,
        unit_price:    effectivePrice,
        quantity:      qty,
        subtotal:      itemSubtotal,
        customization: item.customization || null,
        // S5 — entra na fila de triagem so quem mandou arte propria.
        art_review_status: initialArtStatus(cfg, item.customization),
        // metadata auxiliar (nao persistida — so resposta)
        _base_price: basePrice,
        _choices_delta: choicesDelta,
        _back_delta: backDelta,
      });
    }

    if (!hasStudioItem) {
      return res.status(400).json({ error: 'Pedido Studio precisa de ao menos 1 produto personalizavel' });
    }

    if (totalMiddleDeltaAdded > 0) {
      console.log(`[studio/storefront/order] total middle_delta somado ao subtotal: R$${totalMiddleDeltaAdded.toFixed(2)}`);
    }
    if (totalBackDeltaAdded > 0) {
      console.log(`[studio/storefront/order] total back_delta somado ao subtotal: R$${totalBackDeltaAdded.toFixed(2)}`);
    }

    // Frete (S2, 18/08/2026) — mesma regra da loja comum. Antes daqui o
    // Studio cobrava sempre config.delivery_fee, ignorando frete gratis
    // acima de X e faixa por distancia que a lojista ja configurava no
    // mesmo digital_channel_config.
    //
    // O valor NUNCA vem do cliente: e recalculado no servidor a partir do
    // CEP. expected_delivery_fee serve so para detectar cotacao velha —
    // se o cliente cotou, deixou a aba aberta e a lojista mudou a tabela,
    // ele leva 409 em vez de pagar um frete que nao existe mais.
    //
    // Sem CEP, cai no delivery_fee fixo: e o comportamento de antes do S2
    // e o unico possivel sem saber o destino.
    let delivery_fee = 0;
    let shippingMeta = null;
    if (dtype === 'delivery') {
      if (address_zip) {
        const cleanZip = String(address_zip).replace(/\D/g, '');
        const quote = await calculateShippingQuote(config, cleanZip, subtotal);
        shippingMeta = quote;
        if (quote.error && quote.fee == null) {
          return res.status(400).json({
            error: quote.error,
            distance_km: quote.distance_km,
          });
        }
        delivery_fee = parseFloat(quote.fee) || 0;

        if (expected_delivery_fee != null && expected_delivery_fee !== '') {
          const expected = parseFloat(expected_delivery_fee);
          if (Number.isFinite(expected) && Math.abs(expected - delivery_fee) > 0.01) {
            return res.status(409).json({
              error: 'Valor de frete desatualizado. Atualize a pagina e tente de novo.',
              server_fee: delivery_fee,
              client_fee: expected,
            });
          }
        }
      } else {
        delivery_fee = parseFloat(config.delivery_fee) || 0;
      }
    }
    // Desconto do Pix — a MESMA conta da loja comum (storefront.js), e
    // pelo mesmo motivo: o percentual e da loja e a pagina do produto
    // mostra o valor com desconto. Calculado AQUI, nunca confiado no que
    // o cliente mandou. Frete nao entra no desconto.
    //
    // S0 (03/09/2026). Ate aqui a vitrine Studio nao aplicava nada: a
    // loja anunciava 5% no Pix pela migration 309 e o pedido cobrava
    // cheio — exatamente o defeito que a fase 6 corrigiu do outro lado.
    // Hoje as duas lojas Studio estao em 0%, entao ninguem foi cobrado a
    // mais; a paridade entra antes de alguem ligar o desconto.
    const pixPct = Number(config.pix_discount_pct) || 0;
    const discount_amount = (pmethod === 'pix' && pixPct > 0)
      ? Math.round(subtotal * pixPct) / 100
      : 0;
    const total = subtotal - discount_amount + delivery_fee;

    // Pedido Studio nasce sempre como pending_payment (Pix/cartao) ou
    // confirmed (on_delivery). studio_production_status='pending_art'.
    const initialStatus = pmethod === 'on_delivery' ? 'confirmed' : 'pending_payment';

    const client = await db.connect();
    let order;
    try {
      await client.query('BEGIN');
      let composedAddress = delivery_address || null;
      if (dtype === 'delivery' && !composedAddress && address_street) {
        composedAddress = `${address_street}, ${address_number}` +
          (address_complement ? ` (${address_complement})` : '') +
          ` - ${address_neighborhood}, ${address_city}/${String(address_state || '').toUpperCase()}` +
          (address_zip ? ` - CEP ${String(address_zip).replace(/\D/g, '')}` : '');
      }

      // As colunas de desconto (migration 316) entram por ultimo e SO
      // quando o banco ja as tem — o runner aplica antes do deploy, mas
      // base sem a migration nao pode derrubar o pedido inteiro
      // (armadilha 1). Mesmo padrao da loja comum.
      const insertPedido = (comDesconto) => client.query(`
        INSERT INTO digital_orders (
          company_id, order_number, customer_name, customer_phone, customer_email,
          delivery_type, delivery_address, delivery_fee, subtotal, total,
          status, payment_status, payment_method, notes,
          confirmed_at,
          customer_cpf_cnpj, nfce_requested,
          address_zip, address_street, address_number, address_complement,
          address_neighborhood, address_city, address_state,
          courier_name, courier_plate,
          vertical, studio_production_status${comDesconto ? ', discount_amount, discount_reason' : ''}
        ) VALUES (
          $1, next_digital_order_number($1), $2, $3, $4,
          $5, $6, $7, $8, $9,
          $10, 'pending', $11, $12,
          CASE WHEN $10 = 'confirmed' THEN NOW() ELSE NULL END,
          $13, $14,
          $15, $16, $17, $18,
          $19, $20, $21,
          $22, $23,
          'studio', 'pending_art'${comDesconto ? ', $24, $25' : ''}
        ) RETURNING *
      `, [
        cid, customer_name, customer_phone, customer_email || null,
        dtype, composedAddress, delivery_fee, subtotal, total,
        initialStatus, pmethod, notes || null,
        cpfNorm || null, !!request_nfce,
        address_zip ? String(address_zip).replace(/\D/g, '') : null,
        address_street || null, address_number || null, address_complement || null,
        address_neighborhood || null, address_city || null,
        address_state ? String(address_state).toUpperCase() : null,
        courierData ? courierData.courier_name : null,
        courierData ? courierData.courier_plate : null,
        ...(comDesconto ? [discount_amount, discount_amount > 0 ? 'pix' : null] : []),
      ]);

      let newOrder;
      try {
        ({ rows: [newOrder] } = await insertPedido(true));
      } catch (e) {
        if (e.code !== '42703') throw e;
        // Sem as colunas de desconto: grava o pedido do jeito antigo. O
        // total ja esta calculado, entao o cliente paga o valor certo; o
        // que se perde e a linha do desconto no historico.
        await client.query('ROLLBACK');
        await client.query('BEGIN');
        ({ rows: [newOrder] } = await insertPedido(false));
      }
      order = newOrder;

      for (const item of orderItems) {
        await client.query(`
          INSERT INTO digital_order_items
            (order_id, product_id, product_name, product_image, unit_price, quantity, subtotal,
             customization, art_review_status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
        `, [order.id, item.product_id, item.product_name, item.product_image,
            item.unit_price, item.quantity, item.subtotal,
            item.customization ? JSON.stringify(item.customization) : null,
            // S5 — 'pendente' so quando ha arte DE CLIENTE para olhar.
            // Quem contratou a criacao nao entra na fila: ali quem produz
            // e a lojista, e o fluxo lojista -> cliente ja cobre.
            item.art_review_status || null]);
      }
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    // Pagamento Pix / Cartao (mesma logica do storefront.js principal)
    let pixData = null;
    const lojaDeTeste = await ehLojaDeTeste(cid);
    if (pmethod === 'pix' && lojaDeTeste) {
      // Loja de teste nao cria cobranca em gateway. A tela de
      // confirmacao renderiza inteira — que e o ponto de poder testa-la.
      anotarBloqueio(`cobranca Pix do pedido #${order.order_number}`, cid);
      pixData = pixDeTeste(order, total);
    } else if (pmethod === 'pix') {
      if (hasMpGateway) {
        try {
          pixData = await createMpPixPayment({
            accessToken:   mpGateway.access_token,
            total,
            orderId:       order.id,
            orderNumber:   order.order_number,
            customerEmail: customer_email || null,
            description:   `Pedido Studio #${order.order_number}`,
          });
          await db.query(
            `UPDATE digital_orders SET mp_payment_id = $1, updated_at = NOW() WHERE id = $2`,
            [pixData.payment_id, order.id]
          );
        } catch (mpErr) {
          console.error('[studio-storefront] MP Pix error, fallback static:', mpErr.message);
          pixData = await generatePix({ order, company_id: cid, total });
          if (pixData) {
            await db.query(`
              UPDATE digital_orders SET
                asaas_payment_id     = $1,
                asaas_pix_qrcode     = $2,
                asaas_pix_payload    = $3,
                asaas_pix_expires_at = $4
              WHERE id = $5
            `, [pixData.payment_id, pixData.qrcode, pixData.payload, pixData.expires_at, order.id]);
          }
        }
      } else {
        pixData = await generatePix({ order, company_id: cid, total });
        if (pixData) {
          await db.query(`
            UPDATE digital_orders SET
              asaas_payment_id     = $1,
              asaas_pix_qrcode     = $2,
              asaas_pix_payload    = $3,
              asaas_pix_expires_at = $4
            WHERE id = $5
          `, [pixData.payment_id, pixData.qrcode, pixData.payload, pixData.expires_at, order.id]);
        }
      }
    }

    let cardData = null;
    if (pmethod === 'card') {
      try {
        const hasCustomDomain = config.custom_domain && config.custom_domain_status === 'active';
        const backBase = hasCustomDomain
          ? `https://${config.custom_domain}`
          : `${STOREFRONT_API_BASE}/api/v1/storefront/${slug}/page`;
        cardData = await createMpPreference({
          accessToken:     mpGateway.access_token,
          orderId:         order.id,
          orderNumber:     order.order_number,
          orderItems,
          customerEmail:   customer_email || null,
          payerCpf:        cpfNorm || null,
          storeName:       config.company_display_name || null,
          notificationUrl: `${STOREFRONT_API_BASE}/api/v1/webhooks/mp`,
          backUrlSuccess:  `${backBase}?order_id=${order.id}&payment=approved`,
          backUrlFailure:  `${backBase}?order_id=${order.id}&payment=failed`,
          backUrlPending:  `${backBase}?order_id=${order.id}&payment=pending`,
        });
      } catch (mpErr) {
        console.error('[studio-storefront] MP Preference error:', mpErr.message);
        return res.status(500).json({ error: 'Erro ao criar preferencia de pagamento. Tente novamente.' });
      }
    }

    // on_delivery: pedido confirmed -> notifica imediatamente
    if (initialStatus === 'confirmed') {
      onOrderConfirmed(order.id)
        .catch(err => console.error('[studio-storefront] onOrderConfirmed error:', err.message));
      notify.notifyPaymentConfirmed({ order })
        .catch(err => console.error('[studio-storefront] notifyPaymentConfirmed error:', err.message));
    }

    res.status(201).json({
      order_id:       order.id,
      order_number:   order.order_number,
      // 05/09/2026: link de acompanhamento, pronto para a confirmacao
      // mostrar. O token vem do RETURNING * (DEFAULT no banco, migration
      // 322); null enquanto a migration nao rodou — a tela simplesmente
      // nao mostra o bloco.
      track_url: order.public_token
        ? `${process.env.APP_PUBLIC_URL || ''}/acompanhar/${order.public_token}`
        : null,
      total,
      delivery_fee,
      subtotal,
      status:         initialStatus,
      payment_method: pmethod,
      shipping:       shippingMeta,
      studio_production_status: 'pending_art',
      pix: pixData ? {
        qrcode:     pixData.qrcode,
        payload:    pixData.payload,
        expires_at: pixData.expires_at,
        mode:       pixData.mode || null,
      } : null,
      card: cardData ? {
        init_point:    cardData.init_point,
        preference_id: cardData.preference_id,
      } : null,
    });
  } catch (err) {
    console.error('[studio-storefront] create order error:', err);
    res.status(500).json({ error: 'Erro ao criar pedido Studio' });
  }
});

// ─────────────────────────────────────────────
// GET /storefront/:slug/studio/order/:oid
// Poll de status do pedido Studio (cliente acompanha).
// Inclui revisions policy pra cliente ver no estagio "sent".
// ─────────────────────────────────────────────
router.get('/:slug/studio/order/:oid', async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT o.id, o.order_number, o.status, o.payment_status, o.payment_method,
             o.total, o.delivery_type, o.studio_production_status,
             o.asaas_pix_expires_at, o.confirmed_at, o.delivered_at, o.cancelled_at,
             COALESCE(c.studio_settings, '{}'::jsonb) AS studio_settings,
             COALESCE(c.trade_name, c.legal_name) AS shop_name
        FROM digital_orders o
        JOIN digital_channel_config dcc ON dcc.company_id = o.company_id
        JOIN companies c ON c.id = o.company_id
       WHERE o.id = $1 AND dcc.slug = $2 AND o.vertical = 'studio'
    `, [req.params.oid, req.params.slug.toLowerCase().trim()]);
    if (!rows.length) return res.status(404).json({ error: 'Pedido nao encontrado' });
    const row = rows[0];
    const ss = row.studio_settings || {};
    const { studio_settings, ...rest } = row;
    res.json({
      ...rest,
      revisions: {
        max_included: ss.max_revisions_included != null
          ? parseInt(ss.max_revisions_included) : 0,
        extra_price: ss.extra_revision_price != null
          ? parseFloat(ss.extra_revision_price) : 0,
        policy_text: ss.revision_policy_text || null,
      },
      sla_days: ss.default_sla_days != null ? parseInt(ss.default_sla_days) : 3,
      shop_wa_phone: ss.approval_wa_phone || null,
    });
  } catch (err) {
    console.error('[studio-storefront] poll error:', err);
    res.status(500).json({ error: 'Erro ao buscar pedido' });
  }
});

// ═════════════════════════════════════════════════════════════
// Orcamento em lote, publico (S0 · 03/09/2026)
//
// "50 canecas com o nome de cada convidado, quanto fica?" era uma
// conversa de WhatsApp que a lojista respondia na mao, e o wizard que
// calcula isso morava so no painel, atras de login. A pessoa que esta
// organizando o casamento nao tem login.
//
// Duas rotas, e a diferenca entre elas e proposital:
//   bulk-quote  — so calcula, nao grava nada. Pode ser chamada a cada
//                 tecla enquanto a pessoa cola a lista de nomes.
//   bulk-order  — grava o evento, e grava como RASCUNHO. Pedido em lote
//                 e conversa: quem confirma e a lojista, olhando. Um
//                 evento "confirmado" criado por qualquer um da internet
//                 entraria na fila de producao dela sem ninguem ter dito
//                 sim.
//
// O preco unitario vem SEMPRE do produto no banco. Aceitar preco do
// cliente faria a cotacao ser o que ele quisesse.
// ═════════════════════════════════════════════════════════════

/** Resolve loja + produto para as duas rotas de lote. Devolve erro pronto. */
async function lojaEProdutoDoLote(slug, productId) {
  const { rows: cfg } = await db.query(
    `SELECT company_id FROM digital_channel_config
      WHERE slug = $1 AND is_published = true LIMIT 1`,
    [slug]
  );
  if (!cfg.length) return { erro: [404, 'Loja nao encontrada'] };
  const cid = cfg[0].company_id;

  if (!productId) return { erro: [400, 'product_id obrigatorio'] };
  const { rows: prod } = await db.query(
    `SELECT id, name, price FROM products
      WHERE id = $1
        AND ${listVisibilityWhere('$2')}
        AND is_active IS NOT FALSE
        AND is_personalizable = true
        AND studio_storefront_visible IS NOT FALSE
      LIMIT 1`,
    [productId, cid]
  );
  if (!prod.length) return { erro: [404, 'Produto nao encontrado nesta loja'] };

  // A escada da LOJISTA — a mesma do produto avulso (04/09/2026). Regra
  // do produto vence; sem ela, a regra global da loja; sem nenhuma, o
  // lote sai sem desconto, em vez dos 5% que uma tabela fixa nossa
  // inventava. Ver services/studioLote.js.
  let faixas = null;
  try {
    const { rows: regras } = await db.query(
      `SELECT product_id, qty_tiers FROM studio_pricing_rules
        WHERE company_id = $1 AND is_active IS NOT FALSE AND qty_tiers IS NOT NULL
          AND (product_id = $2 OR product_id IS NULL)`,
      [cid, productId]
    );
    const propria = regras.find((r) => r.product_id === productId);
    const global = regras.find((r) => r.product_id == null);
    faixas = (propria || global || {}).qty_tiers ?? null;
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') throw e;
  }
  return { cid, produto: prod[0], faixas };
}

/** A lista de nomes, limpa. Cada linha vira uma peca. */
function nomesDoLote(bruto) {
  const arr = Array.isArray(bruto)
    ? bruto
    : String(bruto || '').split(/\r?\n/);
  return arr.map((n) => String(n || '').trim()).filter(Boolean).slice(0, 200);
}

// POST /storefront/:slug/studio/bulk-quote — { product_id, qty } ou { product_id, names[] }
router.post('/:slug/studio/bulk-quote', async (req, res) => {
  try {
    const { produto, faixas, erro } = await lojaEProdutoDoLote(
      req.params.slug.toLowerCase().trim(), req.body?.product_id);
    if (erro) return res.status(erro[0]).json({ error: erro[1] });

    // A tela manda a lista enquanto a pessoa digita; `qty` serve pros
    // tres cartoes de faixa, que sao numeros redondos sem nome nenhum.
    const qty = req.body?.names != null
      ? nomesDoLote(req.body.names).length
      : Math.max(0, Math.floor(Number(req.body?.qty) || 0));

    res.json({
      product: { id: produto.id, name: produto.name, price: parseFloat(produto.price) },
      ...cotarLote(qty, parseFloat(produto.price), faixas),
    });
  } catch (err) {
    console.error('[studio-storefront] bulk-quote error:', err.message);
    res.status(500).json({ error: 'Erro ao calcular o lote' });
  }
});

// POST /storefront/:slug/studio/bulk-order — cria o evento como rascunho
router.post('/:slug/studio/bulk-order', async (req, res) => {
  const b = req.body || {};
  try {
    const { cid, produto, faixas, erro } = await lojaEProdutoDoLote(
      req.params.slug.toLowerCase().trim(), b.product_id);
    if (erro) return res.status(erro[0]).json({ error: erro[1] });

    const evento = String(b.event_name || '').trim();
    if (evento.length < 2) return res.status(400).json({ error: 'Diga de qual evento se trata' });

    // WhatsApp obrigatorio: o evento nasce rascunho e a lojista precisa
    // responder. Sem contato, o registro so ocupa a fila dela.
    const fone = String(b.customer_phone || '').replace(/\D/g, '');
    if (fone.length < 10) return res.status(400).json({ error: 'WhatsApp com DDD obrigatorio' });

    const nomes = nomesDoLote(b.names);
    if (!nomes.length) return res.status(400).json({ error: 'Cole ao menos um nome' });

    // A cliente escreve "20/09/2026", como a tela sugere; a coluna e DATE.
    // Sem isto o Postgres lia mes 20, a rota devolvia 500 e o orcamento
    // se perdia no ultimo passo (QA de 04/09/2026). Ver services/dataDoLote.
    const prazo = normalizarDataDoLote(b.delivery_deadline);
    if (prazo.erro) return res.status(400).json({ error: prazo.erro });
    const dataDoEvento = normalizarDataDoLote(b.event_date);
    if (dataDoEvento.erro) return res.status(400).json({ error: dataDoEvento.erro });

    const preco = parseFloat(produto.price);
    const cot = cotarLote(nomes.length, preco, faixas);

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows: [ev] } = await client.query(
        `INSERT INTO studio_bulk_events
           (company_id, event_name, event_date, customer_name, customer_phone, customer_email,
            product_id, product_name_snapshot, base_unit_price, total_qty, total_amount,
            discount_pct, delivery_deadline, notes, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'draft',NULL)
         RETURNING id, event_name, total_qty, total_amount, discount_pct, status`,
        [cid, evento, dataDoEvento.data,
         String(b.customer_name || '').trim() || null, fone,
         String(b.customer_email || '').trim() || null,
         produto.id, produto.name, preco, nomes.length, cot.total_amount,
         cot.discount_pct, prazo.data,
         String(b.notes || '').trim() || null]
      );

      const valores = [];
      const params = [ev.id];
      nomes.forEach((nome, i) => {
        valores.push(`($1, $${params.length + 1}, $${params.length + 2})`);
        params.push(i + 1, nome);
      });
      await client.query(
        `INSERT INTO studio_bulk_event_items (event_id, line_number, recipient_name)
         VALUES ${valores.join(', ')}`,
        params
      );
      await client.query('COMMIT');

      res.status(201).json({ event: ev, item_count: nomes.length, pricing: cot });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }
  } catch (err) {
    if (err.code === '42P01') {
      // Migration 133 pendente neste ambiente (armadilha 10).
      return res.status(503).json({ error: 'Orcamento em lote indisponivel nesta loja' });
    }
    console.error('[studio-storefront] bulk-order error:', err.message);
    res.status(500).json({ error: 'Erro ao registrar o orcamento' });
  }
});

// ─── GET /:slug/studio — endereco publico da vitrine de personalizados ───
// loja.getaura.com.br/:slug/studio e o endereco que o painel divulga (botao
// "Ver como cliente" e o card de WhatsApp). Ele NUNCA existiu: o
// customDomainMiddleware reescreve loja.getaura.com.br/x/y para
// /api/v1/storefront/x/y, e aqui so havia /studio/products, /studio/order e
// afins. A lojista clicava e caia num JSON de erro.
//
// 04/09/2026 — a vitrine MUDOU DE CASA, e este 302 foi feito para isso.
// Ela agora e servida em `loja.getaura.com.br/<slug>`, sem sufixo: empresa
// em modo Studio tem uma loja so, nesse endereco (ver
// services/vitrineStudioShell.js). Este caminho antigo continua de pe e
// leva para la — quem tiver o link com `/studio` no fim nao quebra, e a
// barra de endereco passa a mostrar o endereco bom.
function urlVitrineStudio(slug) {
  const lojaUrl = process.env.STOREFRONT_PUBLIC_URL || 'https://loja.getaura.com.br';
  return `${lojaUrl}/${encodeURIComponent(slug)}`;
}

router.get('/:slug/studio', function(req, res) {
  res.redirect(302, urlVitrineStudio(req.params.slug));
});

// Forma antiga com id de produto no fim — era o que o painel gerava ate
// 19/08/2026. Nao ha rota de produto na vitrine, entao cai na loja: melhor
// a loja certa do que um erro. Declarada DEPOIS das rotas especificas
// (/studio/products, /studio/order...) para nao engoli-las.
router.get('/:slug/studio/:pid', function(req, res, next) {
  // Nao sequestra os subcaminhos reais da API, caso algum seja adicionado
  // depois desta linha por engano.
  const reservados = ['products', 'order', 'upload', 'shipping-quote',
                      'bulk-quote', 'bulk-order'];
  if (reservados.includes(req.params.pid)) return next();
  res.redirect(302, urlVitrineStudio(req.params.slug));
});

module.exports = router;
// Exposto para teste — mesma convencao de karateDojoBeltExams.__validateFile.
module.exports.__validateCustomizationValues = validateCustomizationValues;
// Expostos pro teste: o delta de preco do verso/meio e regra de dinheiro,
// e regra de dinheiro sem teste e onde o cliente final e cobrado errado.
module.exports.__computeBackDelta = computeBackDelta;
module.exports.__computeMiddleDelta = computeMiddleDelta;
