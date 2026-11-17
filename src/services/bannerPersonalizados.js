// ============================================================
// AURA. — O banner A da loja com produto personalizavel
//
// p-180 (loja unica 3.2b, 17/11/2026). Decisao do Caio (D9): na home da
// loja que tem peca personalizavel, o banner e um modelo pronto da Aura,
// com a foto da peca, o botao "Ver como fica em 3D" e a faixa de confianca
// logo abaixo (aprovar a arte, entrega, pagamento, troca). Mockup p-132,
// versao A.
//
// Onde mora a escolha: digital_channel_config.banner_personalizados
// (migration 458), um objeto JSON. NULL ou `ativo: false` = a lojista nao
// escolheu o modelo, e a home sai como hoje (o hero de sempre, com os
// banners dela). A loja SEM personalizavel nunca chega aqui: o builder so
// chama montarBanner com tem_personalizavel verdadeiro.
//
// A capa: a foto que a lojista subiu para o banner (`imagem_url`) ou, sem
// ela, a foto da peca escolhida. O mockup e o render da cascata da Producao
// (backend#761) NAO entram aqui: os dois sao a arte de UMA cliente (nome,
// foto) e nao podem ir para a vitrine publica sem o consentimento dela.
// Sem foto nenhuma, o banner nao entra e a home fica como hoje.
// ============================================================
'use strict';

function bd() { return require('../config/database'); }

const { PERSONALIZAVEL, NA_VITRINE } = require('./catalogoPaginado');

/** Os textos do modelo, quando a lojista nao escreveu os dela (mockup p-132). */
const PADRAO = Object.freeze({
  kicker: 'Feito sob encomenda',
  titulo: 'Presentes com a sua cara',
  texto: 'Escolha a peça, coloque o seu nome ou a sua arte e veja como fica antes de comprar. A gente mostra a arte para você aprovar antes de produzir.',
  botao: 'Personalizar agora',
  botao_3d: 'Ver como fica em 3D',
});

const LIMITES = Object.freeze({ kicker: 40, titulo: 80, texto: 240, botao: 40, botao_3d: 40, imagem_url: 500 });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function texto(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * O que se grava (PUT do painel) e o que se le (builder): a mesma regra.
 * Devolve o objeto saneado, ou null quando a entrada nao e objeto.
 * Texto vazio = "use o do modelo". `mostrar_3d: false` tira o segundo
 * botao; o primeiro sempre existe.
 */
function sanearBanner(raw) {
  let b = raw;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { return null; } }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const imagem = texto(b.imagem_url, LIMITES.imagem_url);
  return {
    ativo: b.ativo === true,
    produto_id: typeof b.produto_id === 'string' && UUID.test(b.produto_id.trim()) ? b.produto_id.trim() : null,
    imagem_url: /^https:\/\//i.test(imagem) ? imagem : null,
    kicker: texto(b.kicker, LIMITES.kicker),
    titulo: texto(b.titulo, LIMITES.titulo),
    texto: texto(b.texto, LIMITES.texto),
    botao: texto(b.botao, LIMITES.botao),
    botao_3d: texto(b.botao_3d, LIMITES.botao_3d),
    mostrar_3d: b.mostrar_3d !== false,
  };
}

/** R$ 150 / R$ 99,90, no formato dos selos padrao. */
function reais(n) {
  return 'R$ ' + (Number.isInteger(n) ? String(n) : n.toFixed(2).replace('.', ','));
}

/**
 * A faixa de confianca. So "Voce aprova a arte" e novo; o resto nasce do
 * que a lojista LIGOU, com a mesma regra dos selos padrao
 * (storefrontBuilder.selosPadrao): nada de "Entrega para todo o Brasil"
 * numa loja que entrega no bairro.
 */
function faixaDeConfianca(cfg) {
  const c = cfg || {};
  const itens = [{ icone: '✓', titulo: 'Você aprova a arte', texto: 'antes de produzir' }];
  if (c.delivery_enabled) {
    const piso = Number(c.delivery_free_above_amount);
    itens.push({
      icone: '→', titulo: 'Entrega',
      texto: (Number.isFinite(piso) && piso > 0) ? 'grátis acima de ' + reais(piso) : (c.delivery_eta_text || 'combinada com a loja'),
    });
  } else if (c.pickup_enabled !== false) {
    itens.push({ icone: '→', titulo: 'Retire na loja', texto: c.pickup_eta_text || 'sem custo de envio' });
  }
  if (c.has_pix || c.has_card) {
    const formas = c.has_pix && c.has_card ? 'Pix ou cartão' : (c.has_pix ? 'Pix' : 'Cartão');
    itens.push({ icone: '$', titulo: formas, texto: 'pagamento seguro' });
  } else if (c.pay_on_delivery_enabled) {
    itens.push({ icone: '$', titulo: 'Pague na entrega', texto: 'combinado com a loja' });
  }
  itens.push({ icone: '↺', titulo: 'Troca em até 7 dias', texto: 'nas peças de prateleira' });
  return itens.slice(0, 4);
}

/**
 * A peca do banner: a que a lojista escolheu, se ainda e personalizavel e
 * esta na vitrine; senao a personalizavel mais nova da vitrine. So peca
 * com foto (a capa) — a menos que a lojista tenha subido a imagem do
 * banner, que ai serve de capa.
 */
async function pecaDoBanner({ cid, visibilityWhere, produtoId, comImagemPropria }) {
  const sql = `
    SELECT id, name, NULLIF(TRIM(image_url), '') AS image_url
      FROM products
     WHERE ${visibilityWhere}
       AND is_active IS NOT FALSE
       AND ${PERSONALIZAVEL}
       AND ${NA_VITRINE}
       ${comImagemPropria ? '' : "AND NULLIF(TRIM(image_url), '') IS NOT NULL"}
     ORDER BY (id::text = $2) DESC, created_at DESC
     LIMIT 1`;
  const { rows } = await bd().query(sql, [cid, produtoId || '']);
  return rows[0] || null;
}

/**
 * O banner pronto para o payload, ou null (a home de hoje). Falhou a
 * consulta: null tambem — loja com o hero de sempre e melhor que loja
 * fora do ar.
 */
async function montarBanner({ config, cid, visibilityWhere, cfgDosSelos }) {
  const escolha = sanearBanner(config && config.banner_personalizados);
  if (!escolha || !escolha.ativo) return null;
  let peca;
  try {
    peca = await pecaDoBanner({
      cid, visibilityWhere, produtoId: escolha.produto_id, comImagemPropria: !!escolha.imagem_url,
    });
  } catch (e) {
    console.error('[storefront] peca do banner personalizados:', e.message);
    return null;
  }
  const capa = escolha.imagem_url || (peca && peca.image_url) || null;
  if (!peca || !capa) return null;
  return {
    kicker: escolha.kicker || PADRAO.kicker,
    titulo: escolha.titulo || PADRAO.titulo,
    texto: escolha.texto || PADRAO.texto,
    botao: escolha.botao || PADRAO.botao,
    botao_3d: escolha.mostrar_3d ? (escolha.botao_3d || PADRAO.botao_3d) : '',
    produto: { id: peca.id, name: peca.name, image_url: capa },
    faixa: faixaDeConfianca(cfgDosSelos),
  };
}

module.exports = { sanearBanner, faixaDeConfianca, pecaDoBanner, montarBanner, PADRAO, LIMITES };
