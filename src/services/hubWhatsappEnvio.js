// ============================================================
// AURA. — hubWhatsappEnvio.js
// Mensagens de SESSÃO da tela de Conversas do WhatsApp: produto do
// catálogo, orçamento, Pix da loja, link da loja, foto e áudio.
//
// Só dentro da conversa aberta (24 h desde a última mensagem do cliente):
// é mensagem de atendimento, não gasta aviso nem novidade. Por isso aqui
// NÃO passa por saldo. Fora da janela nada sai (JANELA_FECHADA) — o
// convite da conversa fechada é outro caminho (reserva de avisos).
//
// Vai direto pela Cloud API (e não pela wa_outbox): o lojista está olhando
// a tela e precisa saber na hora se saiu. As mesmas guardas da fila valem:
// telefone recusado pela Meta, pausa da conta e janela. O servidor monta o
// texto a partir do que o banco diz (nome, preço, chave Pix, link): o app
// só manda ids.
//
// 42P01/42703 em tudo que toca tabela opcional (regra nº 1 do CLAUDE.md).
// ============================================================
'use strict';

const db = require('../config/database');
const wa = require('./whatsapp');
const waOutbox = require('./waOutbox');
const hubWhatsapp = require('./hubWhatsapp');
const { buildStaticBrCode, validatePixKey } = require('./staticPixService');
const { camposDoProduto, colunasPromo, colunasPromoNulas, comColunasPromo } = require('./precoEfetivo');

const TIPOS = ['produto', 'orcamento', 'pix', 'link_loja'];
const STOREFRONT_BASE = () => process.env.STOREFRONT_BASE_URL || 'https://loja.getaura.com.br';
const APP_URL = () => process.env.APP_URL || 'https://app.getaura.com.br';

function isMissingSchema(e) { return e && (e.code === '42P01' || e.code === '42703'); }

function erro(code, message, status = 422) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

function reais(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/ /g, ' ');
}

function dataCurta(d) {
  const x = d ? new Date(d) : null;
  if (!x || Number.isNaN(x.getTime())) return '';
  return x.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
}

// ── Credenciais e guardas ────────────────────────────────────
async function carregarCredenciais(companyId) {
  try {
    const { rows } = await db.query(
      `-- hubenvio:creds
       SELECT wa_phone_number_id, wa_access_token FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    const r = rows[0];
    if (!r || !r.wa_phone_number_id || !r.wa_access_token) return null;
    return { phoneNumberId: r.wa_phone_number_id, accessToken: waOutbox.decryptToken(r.wa_access_token) };
  } catch (e) {
    if (e.code === '42703') return null;
    throw e;
  }
}

async function carregarConversa(companyId, conversationId) {
  const { rows } = await db.query(
    `-- hubenvio:conv
     SELECT id, channel, external_id, customer_id, customer_name, last_inbound_at
       FROM hub_conversations WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [conversationId, companyId]
  );
  return rows[0] || null;
}

/**
 * Tudo que precisa ser verdade antes de qualquer mensagem de sessão sair.
 * Devolve { conv, creds, phone } ou joga erro com { code, status }.
 */
async function prepararEnvio(companyId, conversationId) {
  const conv = await carregarConversa(companyId, conversationId);
  if (!conv) throw erro('CONVERSA_NAO_ENCONTRADA', 'Conversa não encontrada', 404);
  if (conv.channel !== 'whatsapp') throw erro('CANAL_NAO_SUPORTADO', 'Este envio é só para conversas do WhatsApp', 400);
  if (!waOutbox.windowOpenAt(conv.last_inbound_at)) {
    throw erro('JANELA_FECHADA', 'A conversa fechou. Use um convite pronto para falar primeiro.');
  }
  const phone = waOutbox.normalizePhone(conv.external_id);
  if (!phone) throw erro('TELEFONE_INVALIDO', 'Telefone da conversa inválido', 400);

  const contato = await waOutbox.getContact(companyId, phone).catch(() => null);
  if (contato && contato.invalid_at) {
    throw erro('TELEFONE_INVALIDO_META', 'O WhatsApp recusou este número. Nada foi enviado.');
  }
  const pausa = await waOutbox.loadPauseReason(companyId);
  if (pausa) throw erro('PAUSADO', 'O WhatsApp da loja está pausado. Nada foi enviado.');

  const creds = await carregarCredenciais(companyId);
  if (!creds) throw erro('SEM_CREDENCIAIS', 'O WhatsApp da loja não está conectado.', 409);
  return { conv, creds, phone };
}

// ── Montagem de cada tipo ────────────────────────────────────
async function montarProduto(companyId, { product_id: productId }) {
  if (!productId) throw erro('DADOS_INCOMPLETOS', 'product_id obrigatório', 400);
  const { rows } = await comColunasPromo((comPromo) => db.query(
    `-- hubenvio:produto
     SELECT id, name, price, image_url, ${comPromo ? colunasPromo() : colunasPromoNulas()}
       FROM products
      WHERE id = $1 AND company_id = $2 AND COALESCE(is_active, true) = true LIMIT 1`,
    [productId, companyId]
  ));
  const p = rows[0];
  if (!p) throw erro('PRODUTO_NAO_ENCONTRADO', 'Produto não encontrado', 404);
  const preco = camposDoProduto(p).preco_efetivo;
  const legenda = `*${p.name}*\n${reais(preco)}`;
  const img = String(p.image_url || '').trim();
  const comFoto = /^https:\/\//i.test(img);
  return {
    graph: comFoto
      ? { type: 'image', image: { link: img, caption: legenda } }
      : { type: 'text', text: { body: legenda, preview_url: false } },
    content: legenda,
    metadata: { tipo: 'produto', product_id: p.id, nome: p.name, preco, image_url: comFoto ? img : null },
  };
}

async function montarOrcamento(companyId, { quote_id: quoteId }) {
  if (!quoteId) throw erro('DADOS_INCOMPLETOS', 'quote_id obrigatório', 400);
  let q;
  try {
    ({ rows: [q] } = await db.query(
      `-- hubenvio:orcamento
       SELECT id, token, status, total, expires_at, customer_name, created_at,
              (SELECT COUNT(*)::int FROM studio_quotes x WHERE x.company_id = studio_quotes.company_id AND x.created_at <= studio_quotes.created_at) AS numero
         FROM studio_quotes WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [quoteId, companyId]
    ));
  } catch (e) {
    if (isMissingSchema(e)) throw erro('ORCAMENTO_INDISPONIVEL', 'Orçamentos não disponíveis nesta loja', 409);
    throw e;
  }
  if (!q) throw erro('ORCAMENTO_NAO_ENCONTRADO', 'Orçamento não encontrado', 404);
  if (q.status !== 'sent' || !q.token) {
    throw erro('ORCAMENTO_NAO_ENVIADO', 'Este orçamento ainda não foi enviado ao cliente. Envie por Personalizados primeiro.');
  }
  if (q.expires_at && new Date(q.expires_at).getTime() < Date.now()) {
    throw erro('ORCAMENTO_VENCIDO', 'Este orçamento já venceu.');
  }
  const url = `${APP_URL()}/orcamento/${q.token}`;
  const linhas = ['*Orçamento*', `Total ${reais(q.total)}`];
  if (q.expires_at) linhas.push(`Vale até ${dataCurta(q.expires_at)}`);
  linhas.push(`Veja e aprove: ${url}`);
  const texto = linhas.join('\n');
  // Itens para o cartão da thread (nome, quantidade, valor unitário). Sem a tabela de itens o cartão sai só com o total.
  let itens = [];
  try {
    const { rows } = await db.query(
      `-- hubenvio:orcamento-itens
       SELECT description, quantity, unit_price FROM studio_quote_items WHERE quote_id = $1 ORDER BY sort_order, created_at LIMIT 30`,
      [q.id]
    );
    itens = rows.map((r) => ({ nome: r.description, qtd: Number(r.quantity), valor: Number(r.unit_price) }));
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
  }
  return {
    graph: { type: 'text', text: { body: texto, preview_url: true } },
    content: texto,
    metadata: {
      tipo: 'orcamento', quote_id: q.id, total: Number(q.total), url,
      // `cartao`: o que a thread do app desenha (Main.dc.html). Mensagens antigas não têm; o app lê o texto.
      cartao: {
        numero: q.numero != null ? Number(q.numero) : null,
        itens,
        total: Number(q.total),
        validade: q.expires_at ? new Date(q.expires_at).toISOString() : null,
        url,
      },
    },
  };
}

async function carregarLoja(companyId) {
  let cfg = null;
  try {
    ({ rows: [cfg] } = await db.query(
      `-- hubenvio:loja
       SELECT d.slug, d.is_published, d.pix_key, d.pix_key_type, d.pix_holder_name, d.pix_holder_city,
              d.tagline, d.logo_url, d.description,
              c.trade_name, c.legal_name
         FROM companies c
         LEFT JOIN digital_channel_config d ON d.company_id = c.id
        WHERE c.id = $1 LIMIT 1`,
      [companyId]
    ));
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
  }
  return cfg || {};
}

async function montarPix(companyId, { amount = null }) {
  const loja = await carregarLoja(companyId);
  const nome = loja.pix_holder_name || loja.trade_name || loja.legal_name || 'Loja';
  if (!loja.pix_key) throw erro('SEM_PIX', 'A loja ainda não cadastrou a chave Pix. Cadastre no canal digital.', 409);
  const v = validatePixKey(loja.pix_key, loja.pix_key_type);
  if (!v.valid) throw erro('PIX_INVALIDO', 'A chave Pix da loja está inválida. Confira no canal digital.', 409);
  const valor = amount != null && Number(amount) > 0 ? Math.round(Number(amount) * 100) / 100 : null;
  const codigo = buildStaticBrCode({
    pixKey: v.normalized, amount: valor, beneficiaryName: nome, beneficiaryCity: loja.pix_holder_city || 'BRASIL',
  });
  const cabecalho = valor ? `Pix da ${nome}: ${reais(valor)}` : `Pix da ${nome}`;
  const texto = `${cabecalho}\nPix copia e cola:\n${codigo}`;
  return {
    graph: { type: 'text', text: { body: texto, preview_url: false } },
    content: texto,
    metadata: { tipo: 'pix', valor, loja: nome, cartao: { valor, loja: nome, chave: v.normalized, codigo } },
  };
}

async function montarLinkLoja(companyId) {
  const loja = await carregarLoja(companyId);
  if (!loja.slug || !loja.is_published) {
    throw erro('LOJA_NAO_PUBLICADA', 'A loja online ainda não está publicada.', 409);
  }
  const nome = loja.trade_name || loja.legal_name || 'nossa loja';
  const url = `${STOREFRONT_BASE()}/${loja.slug}`;
  const texto = `${nome} · loja online\n${url}`;
  return {
    graph: { type: 'text', text: { body: texto, preview_url: true } },
    content: texto,
    metadata: {
      tipo: 'link_loja', url,
      cartao: {
        loja: nome, url,
        imagem: /^https:\/\//i.test(String(loja.logo_url || '')) ? loja.logo_url : null,
        descricao: String(loja.tagline || loja.description || '').trim().slice(0, 160) || null,
      },
    },
  };
}

async function montar(tipo, companyId, dados) {
  if (tipo === 'produto') return montarProduto(companyId, dados);
  if (tipo === 'orcamento') return montarOrcamento(companyId, dados);
  if (tipo === 'pix') return montarPix(companyId, dados);
  if (tipo === 'link_loja') return montarLinkLoja(companyId);
  throw erro('TIPO_INVALIDO', `tipo inválido (${TIPOS.join(', ')})`, 400);
}

// ── Gravação na thread ───────────────────────────────────────
async function gravarNaThread({ companyId, conversationId, userId, wamid, content, metadata }) {
  try {
    await db.query(
      `-- hubenvio:grava
       INSERT INTO hub_messages
         (company_id, conversation_id, channel, direction, author, external_message_id, content, metadata)
       VALUES ($1,$2,'whatsapp','outbound','humano',$3,$4,$5)
       ON CONFLICT (company_id, channel, external_message_id)
         WHERE external_message_id IS NOT NULL DO NOTHING`,
      [companyId, conversationId, wamid, content, JSON.stringify({ ...metadata, source_type: 'humano', sessao: true })]
    );
  } catch (e) {
    // A mensagem já saiu: falha de espelho nunca vira "não enviou".
    console.error('[HUB-ENVIO] thread não gravada: %s', e.message);
  }
  await hubWhatsapp.marcarRespostaHumana(companyId, conversationId, userId || null);
}

function wamidDe(resp) {
  return (resp && resp.messages && resp.messages[0] && resp.messages[0].id) || null;
}

/**
 * Envia um dos tipos de mensagem de sessão. Devolve { ok, wamid, content }.
 * Joga Error com .code/.status nos casos que o lojista precisa ler.
 */
async function enviarSessao({ companyId, conversationId, userId, tipo, dados = {} }) {
  const { creds, phone } = await prepararEnvio(companyId, conversationId);
  const msg = await montar(tipo, companyId, dados);
  const resp = await wa.graphPost(`/${creds.phoneNumberId}/messages`, creds.accessToken, {
    messaging_product: 'whatsapp', to: phone, ...msg.graph,
  });
  const wamid = wamidDe(resp);
  await gravarNaThread({ companyId, conversationId, userId, wamid, content: msg.content, metadata: msg.metadata });
  return { ok: true, wamid, content: msg.content };
}

module.exports = {
  TIPOS, enviarSessao, prepararEnvio, montar, gravarNaThread, carregarCredenciais, wamidDe, reais, erro,
};
