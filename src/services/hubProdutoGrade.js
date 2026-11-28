// ============================================================
// AURA. — hubProdutoGrade.js
// "Mandar produto com fotos e tamanhos" na conversa do WhatsApp
// (artboard ProdutoGrade). Contrato: contrato-produto-grade.md.
//
//  1. lerGrade: fotos, cores e tamanhos (só os livres) para o painel.
//  2. enviarProdutoGrade: fotos + legenda + "Qual tamanho?" (botões até 3,
//     lista acima disso), como mensagem de sessão, sem saldo. Reaproveita as
//     guardas do hubWhatsappEnvio (janela de 24 h, número recusado, pausa).
//  3. tratarResposta: a cliente tocou no tamanho (interactive button_reply /
//     list_reply com payload TAM:...). Grava na conversa, aplica a etiqueta
//     "Quer o M" e deixa a sugestão "Reservar e mandar o Pix".
//  4. reservarEPix: a lojista confirma; a reserva é um pedido do balcão
//     (NÃO baixa estoque; o "reservado" é calculado dos pedidos abertos) e
//     o Pix sai com a chave da loja.
//
// Estoque: o da LOJA da conversa. Produto compartilhado do grupo
// (is_group_shared) entra pela regra única de visibilidade; a linha de
// estoque dele é uma só. Livre = estoque − com clientes − reservado − para
// resolver (nunca negativo). A quantidade nunca sai para o painel/cliente.
//
// 42P01/42703 em tudo que toca tabela opcional (regra nº 1 do CLAUDE.md).
// ============================================================
'use strict';

const db = require('../config/database');
const wa = require('./whatsapp');
const envio = require('./hubWhatsappEnvio');
const { productVisibilityWhere } = require('../utils/companyGroup');
const { camposDoProduto, camposDaVariante, colunasPromo, colunasPromoNulas, comColunasPromo } = require('./precoEfetivo');
const { lerReservasSemFalhar, reservadoDaVariante } = require('./reservaDoPedido');
const { lerComClientesSemFalhar, lerParaResolverSemFalhar, comClientesDaVariante } = require('./comClientes');
const { nomeDaCorDaVariante } = require('./nomeDaCor');
const { validarNome, isMissingSchema, MAX_ETIQUETAS_POR_LOJA, COR_PADRAO } = require('./hubEtiquetas');
const { normalizarTelefoneSemRecusar } = require('../utils/telefone');
const pedidoBalcao = require('./pedidoBalcao');
const { mesmosItens } = require('./pedidoOnlineIdempotente');
const sinalDoPedido = require('./sinalDoPedido');

const { erro, reais } = envio;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`, 'i');
const PAYLOAD_PREFIXO = 'TAM';
const PAYLOAD_RE = new RegExp(`^${PAYLOAD_PREFIXO}:(${UUID}):(${UUID}):(.{1,40})$`, 'i');
const MAX_FOTOS_ENVIO = 5;
const MAX_FOTOS_PADRAO = 4;
const MAX_BOTOES = 3;
const MAX_TAMANHO_PAYLOAD = 40;
const MAX_LINHAS_LISTA = 10;
const PERGUNTA = 'Qual tamanho?';
const MAX_CORPO_INTERATIVO = 1024;
const ROTULO_SUGESTAO = 'Reservar e mandar o Pix';
const ROTULO_SO_PIX = 'Mandar o Pix';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const https = (u) => /^https:\/\//i.test(String(u || '').trim());
const semAcento = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

const ATRIBUTO_TAMANHO = new Set(['tamanho', 'size', 'tam', 'tam.', 'numero', 'numeracao', 'medida']);
const ATRIBUTO_COR = new Set(['cor', 'color', 'colour', 'cores']);
const HEX_RE = /#([0-9a-fA-F]{6})\b/;
const ORDEM_LETRAS = ['PP', 'P', 'M', 'G', 'GG', 'XG', 'XGG', 'EG', 'EGG', 'G1', 'G2', 'G3'];

function ordemDoTamanho(t) {
  const u = String(t).trim().toUpperCase();
  const i = ORDEM_LETRAS.indexOf(u);
  if (i >= 0) return [0, i, u];
  const n = parseFloat(u.replace(',', '.'));
  if (Number.isFinite(n)) return [1, n, u];
  return [2, 0, u];
}

function compararTamanho(a, b) {
  const x = ordemDoTamanho(a); const y = ordemDoTamanho(b);
  return (x[0] - y[0]) || (x[1] - y[1]) || x[2].localeCompare(y[2]);
}

function slug(s) {
  return semAcento(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ── 1. Leitura ───────────────────────────────────────────────
/**
 * Carrega o produto da loja e monta a grade. Devolve { grade, porVariante } ou
 * null quando o produto não é da loja/grupo. `porVariante`: id -> { cor, tamanho,
 * preco, livres, productId } (todas as variantes ativas, inclusive sem estoque).
 */
async function carregar(companyId, productId) {
  if (!UUID_RE.test(String(productId || ''))) return null;

  const { produto, variantes } = await comColunasPromo(async (comPromo) => {
    const { rows: [p] } = await db.query(
      `-- hubgrade:produto
       SELECT p.id, p.name, p.price, p.image_url, to_jsonb(p)->>'image_thumb_url' AS image_thumb_url,
              COALESCE(p.is_group_shared, false) AS is_group_shared,
              ${comPromo ? colunasPromo('p') : colunasPromoNulas()}
         FROM products p
        WHERE p.id = $1 AND COALESCE(p.is_active, true) = true
          AND ${productVisibilityWhere('$2', 'p.')}
        LIMIT 1`,
      [productId, companyId]
    );
    if (!p) return { produto: null, variantes: [] };
    const { rows } = await db.query(
      `-- hubgrade:variantes
       SELECT pv.id, pv.sku_suffix, pv.price_override, pv.stock_qty, pv.image_url,
              to_jsonb(pv)->>'image_thumb_url' AS image_thumb_url,
              to_jsonb(pv)->>'color_name' AS color_name,
              ${comPromo ? colunasPromo('pv') : colunasPromoNulas()},
              COALESCE((SELECT json_agg(json_build_object('attribute', v.attribute_name, 'value', v.value))
                          FROM product_variant_values v WHERE v.variant_id = pv.id), '[]'::json) AS attributes
         FROM product_variants pv
        WHERE pv.product_id = $1 AND pv.is_active = true
        ORDER BY pv.created_at ASC, pv.id ASC`,
      [p.id]
    );
    return { produto: p, variantes: rows };
  });
  if (!produto) return null;

  let galeria = [];
  try {
    const { rows } = await db.query(
      `-- hubgrade:galeria
       SELECT url, thumb_url, lower(color_hex) AS color_hex
         FROM product_images WHERE product_id = $1
        ORDER BY color_hex NULLS FIRST, position ASC, created_at ASC`,
      [produto.id]
    );
    galeria = rows;
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
  }

  const ids = [produto.id];
  const [reservas, fora, resolver] = await Promise.all([
    lerReservasSemFalhar(db, companyId, ids, 'hubgrade'),
    lerComClientesSemFalhar(db, companyId, ids, 'hubgrade'),
    lerParaResolverSemFalhar(db, companyId, ids, 'hubgrade'),
  ]);

  // Cada variante: cor, tamanho, preço e livres.
  const porVariante = new Map();
  const grupos = new Map(); // chave da cor -> grupo
  for (const v of variantes) {
    const attrs = Array.isArray(v.attributes) ? v.attributes : [];
    const aCor = attrs.find((a) => ATRIBUTO_COR.has(semAcento(a.attribute)) || HEX_RE.test(String(a.value || '')));
    const aTam = attrs.find((a) => ATRIBUTO_TAMANHO.has(semAcento(a.attribute)));
    const tamanho = aTam && String(aTam.value || '').trim() ? String(aTam.value).trim() : null;
    const nomeCor = aCor ? nomeDaCorDaVariante({ ...v, attributes: attrs }) : null;
    const hexM = aCor ? String(aCor.value || '').match(HEX_RE) : null;
    const hex = hexM ? `#${hexM[1].toLowerCase()}` : null;
    const chave = hex ? hex.slice(1) : (nomeCor ? slug(nomeCor) || '_' : '_');

    const estoque = Number(v.stock_qty) || 0;
    const livres = Math.max(0, estoque
      - reservadoDaVariante(reservas, produto.id, v.id)
      - comClientesDaVariante(fora, produto.id, v.id)
      - comClientesDaVariante(resolver, produto.id, v.id));
    const preco = camposDaVariante(v, produto).preco_efetivo;

    porVariante.set(String(v.id), { productId: String(produto.id), cor: nomeCor, tamanho, preco, livres });

    if (!grupos.has(chave)) grupos.set(chave, { chave, nome: nomeCor, hex, variantes: [] });
    grupos.get(chave).variantes.push({ v, tamanho, livres, preco });
  }

  const foto = (url, thumb) => ({ url: String(url).trim(), thumb_url: https(thumb) ? String(thumb).trim() : null });
  const principal = galeria.filter((g) => !g.color_hex && https(g.url)).map((g) => foto(g.url, g.thumb_url));
  const fotosDoProduto = principal.length ? principal : (https(produto.image_url) ? [foto(produto.image_url, produto.image_thumb_url)] : []);

  const cores = [...grupos.values()].map((g) => {
    const doGrupo = galeria.filter((x) => g.hex && x.color_hex === g.hex && https(x.url)).map((x) => foto(x.url, x.thumb_url));
    const comFoto = g.variantes.find((x) => https(x.v.image_url));
    const fotoDaCor = comFoto ? String(comFoto.v.image_url).trim() : null;
    const fotos = doGrupo.length ? doGrupo : (comFoto ? [foto(comFoto.v.image_url, comFoto.v.image_thumb_url)] : []);

    // Tamanhos com estoque: uma entrada por tamanho (soma variantes repetidas).
    const porTam = new Map();
    const todosPorTam = new Map(); // a grade inteira, inclusive o tamanho sem peça (riscado no app)
    for (const x of g.variantes) {
      if (!x.tamanho) continue;
      const k = x.tamanho.toUpperCase();
      const t = todosPorTam.get(k);
      if (t) t.livres += x.livres; else todosPorTam.set(k, { tamanho: x.tamanho, livres: x.livres });
      if (x.livres <= 0) continue;
      const atual = porTam.get(k);
      if (atual) { atual.livres += x.livres; continue; }
      porTam.set(k, { tamanho: x.tamanho, variant_id: String(x.v.id), preco: x.preco, livres: x.livres });
    }
    const todosTamanhos = [...todosPorTam.values()]
      .sort((a, b) => compararTamanho(a.tamanho, b.tamanho))
      .map((t) => ({ tamanho: t.tamanho, disponivel: t.livres > 0, ultimo: t.livres === 1 }));
    const tamanhos = [...porTam.values()]
      .sort((a, b) => compararTamanho(a.tamanho, b.tamanho))
      .map((t) => ({ tamanho: t.tamanho, variant_id: t.variant_id, preco: t.preco, ultimo: t.livres === 1 }));
    const semTamanho = g.variantes.some((x) => !x.tamanho && x.livres > 0);
    const primeira = g.variantes.find((x) => x.livres > 0) || g.variantes[0];
    return {
      chave: g.chave, nome: g.nome, hex: g.hex,
      preco: primeira ? primeira.preco : camposDoProduto(produto).preco_efetivo,
      foto: fotoDaCor, fotos,
      disponivel: tamanhos.length > 0 || semTamanho,
      tamanhos,
      todos_tamanhos: todosTamanhos,
    };
  });

  return {
    grade: {
      produto: {
        id: produto.id, nome: produto.name, preco: camposDoProduto(produto).preco_efetivo,
        compartilhado: produto.is_group_shared === true,
      },
      fotos: fotosDoProduto,
      cores,
      tem_grade: variantes.length > 0,
    },
    porVariante,
  };
}

async function lerGrade(companyId, productId) {
  const r = await carregar(companyId, productId);
  return r ? r.grade : null;
}

// ── 2. Envio ─────────────────────────────────────────────────
function legendaDaGrade({ nome, cor, preco, tamanhos, mais = 0 }) {
  const partes = [nome];
  if (cor) partes.push(cor);
  partes.push(reais(preco));
  if (tamanhos && tamanhos.length) {
    const rotulos = tamanhos.map((t) => (t.ultimo ? `${t.tamanho} (último)` : t.tamanho));
    const lista = rotulos.length === 1 ? rotulos[0] : `${rotulos.slice(0, -1).join(', ')} e ${rotulos[rotulos.length - 1]}`;
    partes.push(`Tem ${lista}${mais > 0 ? ` (e mais ${mais})` : ''}`);
  }
  return partes.join(' · ');
}

function escolherCor(grade, cor) {
  if (cor) {
    const alvo = semAcento(cor).replace(/^#/, '');
    const achada = grade.cores.find((c) => c.chave === alvo || semAcento(c.nome) === alvo);
    if (!achada) throw erro('COR_NAO_ENCONTRADA', 'Essa cor não é deste produto.', 404);
    if (!achada.disponivel) throw erro('COR_SEM_ESTOQUE', 'Essa cor está sem estoque na loja.');
    return achada;
  }
  if (!grade.tem_grade) return null;
  const disponiveis = grade.cores.filter((c) => c.disponivel);
  if (!disponiveis.length) throw erro('PRODUTO_SEM_ESTOQUE', 'Este produto está sem estoque na loja.');
  if (disponiveis.length > 1) throw erro('ESCOLHA_A_COR', 'Escolha a cor que vai na mensagem.', 400);
  return disponiveis[0];
}

function fotosDoEnvio(grade, cor, pedidas) {
  const doProduto = grade.fotos.map((f) => f.url);
  const daCor = cor ? cor.fotos.map((f) => f.url) : [];
  const permitidas = new Set([...doProduto, ...daCor, ...(cor && cor.foto ? [cor.foto] : [])]);
  if (pedidas !== undefined && pedidas !== null) {
    if (!Array.isArray(pedidas)) throw erro('FOTO_INVALIDA', 'fotos precisa ser uma lista de endereços.', 400);
    const urls = [...new Set(pedidas.map((u) => String(u || '').trim()))];
    if (urls.length > MAX_FOTOS_ENVIO) throw erro('FOTO_INVALIDA', `Até ${MAX_FOTOS_ENVIO} fotos por mensagem.`, 400);
    if (urls.some((u) => !permitidas.has(u))) throw erro('FOTO_INVALIDA', 'Uma das fotos não é deste produto.');
    return urls;
  }
  return (daCor.length ? daCor : doProduto).slice(0, MAX_FOTOS_PADRAO);
}

function payloadDoTamanho(productId, variantId, tamanho) {
  return `${PAYLOAD_PREFIXO}:${productId}:${variantId}:${tamanho}`;
}

// `unica` ({ foto, corpo }): botões com a foto no cabeçalho e o texto junto, numa bolha só.
// Título que a Meta aceita (botão até 20, linha até 24); o que passa do limite vira "…" em vez de recusa.
function tituloCurto(t, max) {
  const x = String(t);
  return x.length <= max ? x : `${x.slice(0, max - 1)}…`;
}

/**
 * O que dá para oferecer de verdade: o payload TAM:... cabe no id da Meta só com tamanho de
 * até 40 caracteres, e a lista mostra no máximo 10. `mais` = quantos ficaram de fora
 * (a legenda avisa "e mais N").
 */
function ofertaDeTamanhos(tamanhos) {
  const cabem = tamanhos.filter((t) => String(t.tamanho).length <= MAX_TAMANHO_PAYLOAD);
  const ofertados = cabem.slice(0, MAX_LINHAS_LISTA);
  return { ofertados, mais: tamanhos.length - ofertados.length };
}

function cabeEmBotoes(tamanhos) {
  const titulos = tamanhos.map((t) => tituloCurto(t.tamanho, 20).toUpperCase());
  return tamanhos.length <= MAX_BOTOES && new Set(titulos).size === titulos.length;
}

function montarPergunta(productId, tamanhos, unica = null) {
  if (cabeEmBotoes(tamanhos)) {
    return {
      formato: 'botoes',
      opcoes: tamanhos.map((t) => t.tamanho),
      graph: {
        type: 'interactive',
        interactive: {
          type: 'button',
          ...(unica ? { header: { type: 'image', image: { link: unica.foto } } } : {}),
          body: { text: unica ? unica.corpo : PERGUNTA },
          action: {
            buttons: tamanhos.map((t) => ({
              type: 'reply', reply: { id: payloadDoTamanho(productId, t.variant_id, t.tamanho), title: tituloCurto(t.tamanho, 20) },
            })),
          },
        },
      },
    };
  }
  const linhas = tamanhos.slice(0, MAX_LINHAS_LISTA);
  return {
    formato: 'lista',
    opcoes: linhas.map((t) => t.tamanho),
    graph: {
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: PERGUNTA },
        action: {
          button: 'Escolher o tamanho',
          sections: [{
            title: 'Tamanhos',
            rows: linhas.map((t) => ({ id: payloadDoTamanho(productId, t.variant_id, t.tamanho), title: tituloCurto(t.tamanho, 24) })),
          }],
        },
      },
    },
  };
}

async function enviarProdutoGrade({ companyId, conversationId, userId, dados = {} }) {
  const productId = dados.product_id;
  if (!productId) throw erro('DADOS_INCOMPLETOS', 'product_id obrigatório', 400);
  // Primeiro as guardas: conversa fechada, pausa e número recusado não leem nem gravam nada.
  const { creds, phone } = await envio.prepararEnvio(companyId, conversationId);

  const carregado = await carregar(companyId, productId);
  if (!carregado) throw erro('PRODUTO_NAO_ENCONTRADO', 'Produto não encontrado', 404);
  const { grade } = carregado;

  const cor = escolherCor(grade, dados.cor);
  const tamanhos = cor ? cor.tamanhos : [];
  const fotos = fotosDoEnvio(grade, cor, dados.fotos);
  const perguntar = dados.perguntar_tamanho === true;
  const oferta = perguntar ? ofertaDeTamanhos(tamanhos) : null;
  if (perguntar && !oferta.ofertados.length) {
    throw erro('SEM_TAMANHO_PARA_PERGUNTAR', 'Este produto não tem tamanhos com estoque para perguntar.');
  }
  // A legenda anuncia só o que a pergunta oferece; o resto vem como "e mais N".
  const doTexto = oferta ? oferta.ofertados : tamanhos;

  const preco = cor ? cor.preco : grade.produto.preco;
  const legenda = legendaDaGrade({ nome: grade.produto.nome, cor: cor && cor.nome, preco, tamanhos: doTexto, mais: oferta ? oferta.mais : 0 });
  const post = (corpo) => wa.graphPost(`/${creds.phoneNumberId}/messages`, creds.accessToken, {
    messaging_product: 'whatsapp', to: phone, ...corpo,
  });

  // Uma bolha só: foto no cabeçalho dos botões + legenda e pergunta no corpo (até 3
  // tamanhos e 1024 caracteres). Lista (acima de 3) não aceita foto no cabeçalho, e
  // texto longo não cabe: nesses casos seguem foto com legenda + pergunta em separado.
  const corpoUnico = `${legenda}

${PERGUNTA}`;
  if (perguntar && fotos.length && cabeEmBotoes(oferta.ofertados) && corpoUnico.length <= MAX_CORPO_INTERATIVO) {
    for (let i = 1; i < fotos.length; i++) await post({ type: 'image', image: { link: fotos[i] } });
    const p = montarPergunta(grade.produto.id, oferta.ofertados, { foto: fotos[0], corpo: corpoUnico });
    const wamid = envio.wamidDe(await post(p.graph));
    await gravarCartao({
      companyId, conversationId, userId, wamid, legenda, grade, cor, preco, tamanhos, fotos,
      extra: { pergunta: true, formato: p.formato, opcoes: p.opcoes },
    });
    return { ok: true, wamid, content: legenda };
  }

  // Fotos (a 1ª leva a legenda) ou, sem foto, só o texto.
  let primeira = null;
  if (fotos.length) {
    for (let i = 0; i < fotos.length; i++) {
      const resp = await post({ type: 'image', image: i === 0 ? { link: fotos[i], caption: legenda } : { link: fotos[i] } });
      if (i === 0) {
        primeira = envio.wamidDe(resp);
        await gravarCartao({ companyId, conversationId, userId, wamid: primeira, legenda, grade, cor, preco, tamanhos, fotos });
      }
    }
  } else {
    const resp = await post({ type: 'text', text: { body: legenda, preview_url: false } });
    primeira = envio.wamidDe(resp);
    await gravarCartao({ companyId, conversationId, userId, wamid: primeira, legenda, grade, cor, preco, tamanhos, fotos });
  }

  if (perguntar) {
    const p = montarPergunta(grade.produto.id, oferta.ofertados);
    const resp = await post(p.graph);
    await envio.gravarNaThread({
      companyId, conversationId, userId, wamid: envio.wamidDe(resp), content: PERGUNTA,
      metadata: { tipo: 'pergunta_tamanho', formato: p.formato, opcoes: p.opcoes, product_id: grade.produto.id },
    });
  }
  return { ok: true, wamid: primeira, content: legenda };
}

// Cartão da thread: a grade inteira, com disponivel:false no tamanho sem peça.
function todosDaCor(cor, tamanhos) {
  if (cor && Array.isArray(cor.todos_tamanhos)) {
    return cor.todos_tamanhos.map((t) => ({ tamanho: t.tamanho, disponivel: t.disponivel, ultimo: t.ultimo }));
  }
  return tamanhos.map((t) => ({ tamanho: t.tamanho, disponivel: true, ultimo: t.ultimo }));
}

function gravarCartao({ companyId, conversationId, userId, wamid, legenda, grade, cor, preco, tamanhos, fotos, extra = {} }) {
  return envio.gravarNaThread({
    companyId, conversationId, userId, wamid, content: legenda,
    metadata: {
      tipo: 'produto', product_id: grade.produto.id, ...extra,
      variant_ids: tamanhos.map((t) => t.variant_id),
      nome: grade.produto.nome, preco, image_url: fotos[0] || null,
      cartao: {
        tipo: 'produto', nome: grade.produto.nome, cor: (cor && cor.nome) || null, preco,
        fotos, tamanhos: todosDaCor(cor, tamanhos),
      },
    },
  });
}

// ── 3. Resposta da cliente ───────────────────────────────────
/** { payload, titulo, formato } do toque interativo; null se não é botão/lista de resposta. */
function lerResposta(msg) {
  const i = msg && msg.type === 'interactive' ? msg.interactive : null;
  if (!i) return null;
  if (i.button_reply) return { payload: String(i.button_reply.id || ''), titulo: String(i.button_reply.title || ''), formato: 'botao' };
  if (i.list_reply) return { payload: String(i.list_reply.id || ''), titulo: String(i.list_reply.title || ''), formato: 'lista' };
  return null;
}

function lerPayload(payload) {
  const m = String(payload || '').match(PAYLOAD_RE);
  return m ? { productId: m[1], variantId: m[2], tamanho: m[3].trim() } : null;
}

// Tamanho de verdade: letras da grade, número de calçado/roupa, único ou um tamanho desta grade.
// Etiqueta manual como "Quer o vestido da vitrine" não é nossa e nunca é apagada.
function ehTamanhoConhecido(t, daGrade) {
  const u = String(t || '').trim().toUpperCase();
  if (!u) return false;
  return ORDEM_LETRAS.includes(u) || ['U', 'UNICO', 'ÚNICO'].includes(u) || /^\d{1,3}([.,]\d)?$/.test(u)
    || (daGrade || []).some((x) => String(x).trim().toUpperCase() === u);
}

function ehEtiquetaDeTamanho(nome, daGrade) {
  const m = String(nome || '').match(/^quer o (.+)$/i);
  return !!m && ehTamanhoConhecido(m[1], daGrade);
}

async function aplicarEtiqueta(companyId, conversationId, tamanho, tamanhosDaGrade = []) {
  const v = validarNome(`Quer o ${tamanho}`.slice(0, 30));
  if (!v.ok) return null;
  let client;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    // Dois toques juntos na mesma conversa: um de cada vez (troca + aplica atômicos).
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`hubgrade-etiqueta:${conversationId}`]);
    const achar = async () => {
      const { rows } = await client.query(
        `-- hubgrade:etiqueta-achar
         SELECT id FROM hub_labels WHERE company_id = $1 AND lower(name) = lower($2) LIMIT 1`,
        [companyId, v.nome]
      );
      return rows[0] ? rows[0].id : null;
    };
    let id = await achar();
    if (!id) {
      const { rows: [{ n }] } = await client.query(`-- hubgrade:etiqueta-conta
        SELECT COUNT(*)::int AS n FROM hub_labels WHERE company_id = $1`, [companyId]);
      if (n >= MAX_ETIQUETAS_POR_LOJA) { await client.query('ROLLBACK'); return null; }
      const { rows } = await client.query(
        `-- hubgrade:etiqueta-cria
         INSERT INTO hub_labels (company_id, name, color) VALUES ($1,$2,$3)
         ON CONFLICT (company_id, lower(name)) DO NOTHING RETURNING id`,
        [companyId, v.nome, COR_PADRAO]
      );
      id = rows[0] ? rows[0].id : await achar();
    }
    if (!id) { await client.query('ROLLBACK'); return null; }
    // Uma "Quer o <tamanho>" por conversa: a nova troca a anterior (a cliente mudou de ideia).
    const { rows: atuais } = await client.query(
      `-- hubgrade:etiqueta-quer
       SELECT cl.label_id, l.name FROM hub_conversation_labels cl
         JOIN hub_labels l ON l.id = cl.label_id
        WHERE cl.conversation_id = $1 AND l.company_id = $2 AND cl.label_id <> $3 AND lower(l.name) LIKE 'quer o %'`,
      [conversationId, companyId, id]
    );
    const sair = atuais.filter((r) => ehEtiquetaDeTamanho(r.name, tamanhosDaGrade)).map((r) => r.label_id);
    if (sair.length) {
      await client.query(
        `-- hubgrade:etiqueta-troca
         DELETE FROM hub_conversation_labels WHERE conversation_id = $1 AND label_id = ANY($2::uuid[])`,
        [conversationId, sair]
      );
    }
    await client.query(
      `-- hubgrade:etiqueta-aplica
       INSERT INTO hub_conversation_labels (conversation_id, label_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [conversationId, id]
    );
    await client.query('COMMIT');
    return { id, nome: v.nome };
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (isMissingSchema(e)) return null;
    throw e;
  } finally {
    if (client) client.release();
  }
}

/**
 * Trata o toque no tamanho. Chamado pelo webhook DEPOIS de a mensagem da
 * cliente estar na conversa. { handled:false } = não é nosso, fluxo normal.
 */
async function tratarResposta({ companyId, msg, conversationId }) {
  const toque = lerResposta(msg);
  const p = toque && lerPayload(toque.payload);
  if (!p || !conversationId) return { handled: false };

  const carregado = await carregar(companyId, p.productId);
  const v = carregado && carregado.porVariante.get(p.variantId);
  if (!v || v.productId !== p.productId) return { handled: false };

  const tamanho = p.tamanho || v.tamanho || toque.titulo;
  const content = toque.formato === 'lista' ? `Escolheu na lista: ${tamanho}` : `Tocou no botão: ${tamanho}`;
  const base = { product_id: p.productId, variant_id: p.variantId, tamanho, nome: carregado.grade.produto.nome, cor: v.cor || null, preco: v.preco };
  // Sem o Pedido liberado a reserva dá 403: a sugestão é só "Mandar o Pix" (o app usa o envio de Pix).
  const reserva = pedidoBalcao.pedidoLiberado();
  const sugestao = {
    tipo: reserva ? 'reservar_e_mandar_pix' : 'mandar_pix',
    rotulo: reserva ? ROTULO_SUGESTAO : ROTULO_SO_PIX, reserva, ...base, quantidade: 1,
    estado: v.livres > 0 ? 'pendente' : 'sem_estoque',
  };
  const { rows } = await db.query(
    `-- hubgrade:resposta-grava
     UPDATE hub_messages
        SET content = $1, metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
      WHERE company_id = $3 AND channel = 'whatsapp' AND conversation_id = $4 AND external_message_id = $5
      RETURNING id`,
    [content, JSON.stringify({ produto_grade: base, sugestao }), companyId, conversationId, msg.id]
  );
  const daGrade = carregado.grade.cores.flatMap((c) => (c.todos_tamanhos || []).map((t) => t.tamanho));
  const etiqueta = await aplicarEtiqueta(companyId, conversationId, tamanho, daGrade);
  return { handled: true, resultado: 'TAMANHO', tamanho, message_id: rows[0] ? rows[0].id : null, etiqueta };
}

// ── Chave do pedido, trava do envio ──────────────────────────
const MAX_TENTATIVAS_CHAVE = 6;
// Pedido aberto (não pago nem entregue): "andou" = a lojista já começou a separar (preparing/ready),
// o que NÃO prova pagamento. Pago é outra coisa (ver pedidoPago).
const STATUS_ANDOU = ['preparing', 'ready'];
const STATUS_ABERTOS = ['pending', 'pending_payment', 'confirmed', ...STATUS_ANDOU];
// Reserva sem mensagem só retoma pedido criado há pouco (falha no meio); mais velho abre a próxima chave.
const JANELA_RETOMADA_MIN = 15;

/**
 * Pedido do balcão já pago? O pedido nasce `pending` e nada no fluxo dele muda payment_status:
 * o sinal grava studio_payments (kind 'deposit') e liga deposit_paid. Conta como pago:
 * deposit_paid, sinal pago acima de zero (a mesma conta de sinalDoPedido.comSinal),
 * payment_status fora de pending ou status encerrado (delivered e afins). preparing/ready
 * ("andou") NÃO contam como pago.
 */
async function pedidoPago(r) {
  if (r.deposit_paid === true || String(r.deposit_paid) === 'true') return true;
  if (!STATUS_ABERTOS.includes(String(r.status))) return true; // entregue e afins
  if (String(r.payment_status) !== 'pending') return true;
  try {
    const c = await sinalDoPedido.comSinal(db, { id: r.id, total: r.total });
    return Number(c.sinal_pago) > 0;
  } catch (e) {
    if (isMissingSchema(e)) return false;
    throw e;
  }
}

/**
 * O pedido desta reserva pela chave (e as chaves -2, -3... das tentativas seguintes).
 * Só é reaproveitado o pedido NÃO cancelado, ainda sem pagamento (ver pedidoPago) e com os
 * MESMOS itens (produto, variante e quantidade). Cancelado, já pago ou de outra quantidade
 * passam para a próxima chave: a cliente nunca paga duas vezes a mesma peça.
 * Sem mensagem: só retoma pedido pendente criado nos últimos 15 minutos e que ainda não
 * "andou" (preparing/ready); mais velho ou andado abre a próxima chave (um Pix pago e não
 * registrado não volta a ser cobrado).
 * Reserva ligada a uma mensagem (`pagoEncerra`): pedido pago dessa mensagem não é refeito nem
 * reenviado ({ pago: true }); o que só "andou" é reaproveitado e o Pix reenviado (nunca
 * `pago`); pedido aberto com OUTRA quantidade dá 409 (não abre um segundo pedido que
 * prenderia mais peças).
 * Devolve { existente: {id, order_number, total, quantidade} | null, chave, pago }.
 */
async function acharPedidoDaChave(companyId, base, itens, { pagoEncerra = false } = {}) {
  const candidatas = [base, ...Array.from({ length: MAX_TENTATIVAS_CHAVE - 1 }, (_, n) => `${base}-${n + 2}`)];
  const { rows } = await db.query(
    `-- hubgrade:pedido-da-chave
     SELECT o.id, o.order_number, o.total, o.idempotency_key, o.status::text AS status,
            o.payment_status::text AS payment_status, to_jsonb(o)->>'deposit_paid' AS deposit_paid,
            (o.status::text ILIKE 'cancel%' OR o.cancelled_at IS NOT NULL) AS cancelado,
            (o.created_at > now() - interval '${JANELA_RETOMADA_MIN} minutes') AS recente,
            COALESCE((SELECT json_agg(json_build_object('product_id', i.product_id, 'variant_id', i.variant_id, 'quantity', i.quantity))
                        FROM digital_order_items i WHERE i.order_id = o.id), '[]'::json) AS itens
       FROM digital_orders o WHERE o.company_id = $1 AND o.idempotency_key = ANY($2::text[])`,
    [companyId, candidatas]
  );
  const porChave = new Map(rows.map((r) => [r.idempotency_key, r]));
  for (const chave of candidatas) {
    const r = porChave.get(chave);
    if (!r) return { existente: null, chave, pago: false };
    if (r.cancelado) continue;
    const gravados = Array.isArray(r.itens) ? r.itens : [];
    if (!mesmosItens(itens, gravados)) {
      if (pagoEncerra) {
        throw erro('RESERVA_COM_OUTRA_QUANTIDADE', `Já existe o pedido ${r.order_number || ''} dessa mensagem com outra quantidade. Cancele-o antes de reservar de novo.`.replace('  ', ' '), 409);
      }
      continue;
    }
    const existente = {
      id: r.id, order_number: r.order_number, total: Number(r.total),
      quantidade: gravados.reduce((t, x) => t + Number(x.quantity || 0), 0),
    };
    if (await pedidoPago(r)) {
      if (pagoEncerra) return { existente, chave, pago: true };
      continue;
    }
    if (pagoEncerra) return { existente, chave, pago: false };
    // Sem mensagem: só retomada de falha (recente e ainda não separado).
    if (r.recente === true && !STATUS_ANDOU.includes(String(r.status))) return { existente, chave, pago: false };
  }
  throw erro('RESERVA_REPETIDA_DEMAIS', 'Essa reserva já foi refeita várias vezes. Faça um novo pedido pelo Caixa.', 409);
}

/** Marca a sugestão como "enviando" (atômico). Quem chega depois leva 409. Trava vence em 2 minutos. */
async function reservarEnvio(companyId, mensagemId) {
  const { rows } = await db.query(
    `-- hubgrade:sugestao-enviando
     UPDATE hub_messages
        SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{sugestao}',
              COALESCE(metadata->'sugestao', '{}'::jsonb)
              || jsonb_build_object('estado', 'enviando', 'enviando_em', to_jsonb(now()::text)))
      WHERE id = $1 AND company_id = $2
        AND COALESCE(metadata->'sugestao'->>'estado', '') <> 'feita'
        AND NOT (COALESCE(metadata->'sugestao'->>'estado', '') = 'enviando'
                 AND (metadata->'sugestao'->>'enviando_em')::timestamptz > now() - interval '2 minutes')
      RETURNING id`,
    [mensagemId, companyId]
  );
  if (!rows.length) throw erro('JA_RESERVADO', 'Essa peça já foi reservada ou está sendo reservada agora.', 409);
}

async function liberarEnvio(companyId, mensagemId) {
  try {
    await db.query(
      `-- hubgrade:sugestao-liberar
       UPDATE hub_messages
          SET metadata = jsonb_set(metadata, '{sugestao}', (metadata->'sugestao') || '{"estado":"pendente"}'::jsonb)
        WHERE id = $1 AND company_id = $2 AND metadata->'sugestao'->>'estado' = 'enviando'`,
      [mensagemId, companyId]
    );
  } catch (e) {
    console.error('[HUB-GRADE] sugestão não liberada: %s', e.message);
  }
}

// ── 4. Reservar e mandar o Pix ───────────────────────────────
async function reservarEPix({
  companyId, conversationId, userId, dados = {}, pedidoLiberado = false, condicionalLiberada = false,
}) {
  if (!pedidoLiberado) throw erro('PEDIDO_NAO_LIBERADO', 'A reserva de peças ainda não está liberada para esta loja.', 403);
  // Conversa fechada, pausa, número recusado: nada é gravado.
  const { conv, creds, phone } = await envio.prepararEnvio(companyId, conversationId);

  let sug = null;
  let mensagemId = null;
  if (dados.message_id) {
    if (!UUID_RE.test(String(dados.message_id))) throw erro('MENSAGEM_NAO_ENCONTRADA', 'Mensagem não encontrada', 404);
    const { rows } = await db.query(
      `-- hubgrade:msg
       SELECT id, metadata FROM hub_messages WHERE id = $1 AND conversation_id = $2 AND company_id = $3 LIMIT 1`,
      [dados.message_id, conversationId, companyId]
    );
    const meta = rows[0] && rows[0].metadata;
    sug = meta && typeof meta === 'object' ? meta.sugestao : null;
    if (!rows[0] || !sug || sug.tipo !== 'reservar_e_mandar_pix') {
      throw erro('SUGESTAO_NAO_ENCONTRADA', 'Essa conversa não tem uma sugestão de reserva nessa mensagem.', 404);
    }
    if (sug.estado === 'feita') {
      throw erro('JA_RESERVADO', 'Essa peça já foi reservada.', 409);
    }
    mensagemId = rows[0].id;
  }
  const productId = (sug && sug.product_id) || dados.product_id;
  const variantId = (sug && sug.variant_id) || dados.variant_id;
  if (!productId || !variantId) throw erro('DADOS_INCOMPLETOS', 'Informe message_id ou product_id e variant_id', 400);
  const quantidade = dados.quantity == null ? ((sug && sug.quantidade) || 1) : Number(dados.quantity);
  if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > 20) {
    throw erro('QUANTIDADE_INVALIDA', 'A quantidade precisa ser um número inteiro de peças.', 400);
  }

  const hoje = pedidoBalcao.hojeSP();
  const base = mensagemId ? `wa-res-${conversationId}-${mensagemId}` : `wa-res-${conversationId}-${variantId}-${hoje}`;
  // B/E: o pedido desta tentativa já existe (falha depois de criar)? Só reenvia o Pix.
  // Pedido cancelado nunca é reaproveitado: a próxima tentativa usa outra chave.
  const { existente, chave, pago } = await acharPedidoDaChave(
    companyId, base, [{ product_id: productId, variant_id: variantId, quantity: quantidade }], { pagoEncerra: !!mensagemId },
  );
  // H: o pedido desta mensagem já está pago (o "feita" não chegou a gravar): não reenvia o Pix, só fecha a sugestão.
  if (pago) {
    await marcarFeita(companyId, mensagemId, sug, existente, existente.quantidade);
    return { ok: true, ja_pago: true, order_id: existente.id, order_number: existente.order_number, total: existente.total };
  }

  // Preço e nome vêm do banco, nunca do corpo.
  const carregado = await carregar(companyId, productId);
  if (!carregado) throw erro('PRODUTO_NAO_ENCONTRADO', 'Produto não encontrado', 404);
  const v = carregado.porVariante.get(String(variantId));
  if (!v || v.productId !== String(carregado.grade.produto.id)) {
    throw erro('VARIANTE_INDISPONIVEL', 'Essa variação não é deste produto.', 404);
  }
  // Com pedido já criado a peça está reservada por ele: o saldo livre não é mais pré-checado.
  if (!existente && v.livres < quantidade) {
    throw erro('PEDIDO_SEM_SALDO', `Não dá para separar: só ${String(v.livres).replace('.', ',')} livre${v.livres === 1 ? '' : 's'} desse tamanho.`, 409);
  }
  const nome = carregado.grade.produto.nome;
  const rotuloVariante = [v.cor, v.tamanho].filter(Boolean).join(' · ') || null;
  const total = existente ? round2(existente.total) : round2(quantidade * round2(v.preco));

  // O Pix primeiro: loja sem Pix recusa antes de criar o pedido.
  const pix = await envio.montar('pix', companyId, { amount: total });

  // D: marca a sugestão como "enviando" de forma atômica; duplo clique recebe 409 e não manda o Pix de novo.
  if (mensagemId) await reservarEnvio(companyId, mensagemId);
  let pedido = existente;
  try {
    if (!pedido) {
      ({ pedido } = await pedidoBalcao.guardarPedido({
        companyId, userId,
        chave,
        hoje,
        comCondicional: condicionalLiberada,
        body: {
          items: [{ product_id: productId, variant_id: variantId, variant_label: rotuloVariante, quantity: quantidade, unit_price: v.preco }],
          customer_id: conv.customer_id || null,
          customer_name: conv.customer_name || null,
          customer_phone: normalizarTelefoneSemRecusar(conv.external_id),
          notes: 'Reservado pela conversa do WhatsApp',
        },
      }));
    }
    return await enviarReservaEPix({
      companyId, conversationId, userId, creds, phone, pedido, pix, nome, rotuloVariante, total,
      productId, variantId, quantidade, mensagemId, sug,
    });
  } catch (e) {
    // Falhou antes de ficar pronto: libera a sugestão para a lojista tentar de novo (o pedido, se criado, é reaproveitado pela chave).
    if (mensagemId) await liberarEnvio(companyId, mensagemId);
    throw e;
  }
}

function quantidadeDoPedido(pedido, padrao) {
  if (pedido && Number.isFinite(Number(pedido.quantidade)) && Number(pedido.quantidade) > 0) return Number(pedido.quantidade);
  const itens = pedido && Array.isArray(pedido.items) ? pedido.items : [];
  const soma = itens.reduce((t, x) => t + Number(x.quantity || 0), 0);
  return soma > 0 ? soma : padrao;
}

async function marcarFeita(companyId, mensagemId, sug, pedido, quantidade) {
  if (!mensagemId) return;
  const feita = { ...sug, estado: 'feita', quantidade, order_id: pedido.id, order_number: pedido.order_number };
  await db.query(
    `-- hubgrade:sugestao-feita
     UPDATE hub_messages SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2 AND company_id = $3`,
    [JSON.stringify({ sugestao: feita }), mensagemId, companyId]
  ).catch((e) => console.error('[HUB-GRADE] sugestão não atualizada: %s', e.message));
}

async function enviarReservaEPix({
  companyId, conversationId, userId, creds, phone, pedido, pix, nome, rotuloVariante, total,
  productId, variantId, quantidade, mensagemId, sug,
}) {
  // I: a quantidade gravada é a do pedido de fato (não a do corpo da requisição).
  const qtdReal = quantidadeDoPedido(pedido, quantidade);
  const post = (corpo) => wa.graphPost(`/${creds.phoneNumberId}/messages`, creds.accessToken, {
    messaging_product: 'whatsapp', to: phone, ...corpo,
  });
  const intro = `Separei ${nome}${rotuloVariante ? ` (${rotuloVariante})` : ''} pra você. Total ${reais(total)}. `
    + 'Copie o código da próxima mensagem e cole no app do seu banco, em Pix > Pix copia e cola.';
  const r1 = await post({ type: 'text', text: { body: intro, preview_url: false } });
  await envio.gravarNaThread({
    companyId, conversationId, userId, wamid: envio.wamidDe(r1), content: intro,
    metadata: { tipo: 'reserva', order_id: pedido.id, order_number: pedido.order_number, product_id: productId, variant_id: variantId, quantidade: qtdReal, total },
  });
  const codigo = pix.metadata.cartao.codigo;
  const r2 = await post({ type: 'text', text: { body: codigo, preview_url: false } });
  await envio.gravarNaThread({
    companyId, conversationId, userId, wamid: envio.wamidDe(r2), content: codigo,
    metadata: { ...pix.metadata, order_id: pedido.id },
  });

  if (mensagemId) await marcarFeita(companyId, mensagemId, sug, pedido, qtdReal);
  return { ok: true, order_id: pedido.id, order_number: pedido.order_number, total, wamid: envio.wamidDe(r1) };
}

module.exports = {
  PAYLOAD_PREFIXO, ROTULO_SUGESTAO,
  lerGrade, enviarProdutoGrade, tratarResposta, reservarEPix, acharPedidoDaChave,
  legendaDaGrade, montarPergunta, lerResposta, lerPayload, payloadDoTamanho, compararTamanho,
};
