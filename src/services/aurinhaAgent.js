// ============================================================
// AURA. — aurinhaAgent.js
// Loop da Aurinha: recebe uma conversa com inbound novo, monta o
// contexto da loja, roda tool-use com o Claude e enfileira a resposta
// no ig_outbox (pending_approval no modo aprovação; pending direto
// quando a loja já liberou envio automático).
//
// Regras estruturais (não dependem do modelo se comportar):
//  - Só roda se hub_agent_settings.enabled e status da conversa = 'ia'
//    (status humano/precisa_humano → a equipe está no comando).
//  - "escalar" marca a conversa precisa_humano ANTES de enfileirar a
//    mensagem de acolhimento — nunca fica IA respondendo em paralelo.
//  - Toda ação vira hub_agent_events (auditoria).
//  - Erro nunca sobe para o webhook: loga, marca evento 'erro' e sai.
// ============================================================
'use strict';

const db = require('../config/database');
const { callClaude } = require('./claudeClient');
const { buildSystemPrompt, CATEGORIES } = require('./aurinhaPrompt');
const igOutbox = require('./igOutbox');

// Modelo da Aurinha — override por env ou por hub_agent_settings.model.
// Piloto roda Sonnet 5 (decisão 30/08: se apertar em algum caso, o teste
// pega e a argumentação pelo Opus como upsell fica mais forte). A taxa
// de edição/rejeição em hub_agent_events é a métrica da comparação.
const AURINHA_MODEL = process.env.AURINHA_MODEL || 'claude-sonnet-5';
const MAX_TOOL_ROUNDS = 6;
const HISTORY_LIMIT = 20;

// ── Ferramentas (formato Anthropic) ─────────────────────────
const TOOLS = [
  {
    name: 'buscar_produtos',
    description: 'Busca produtos da loja pelo nome (busca parcial, sem acento estrito). Retorna nome, preço, estoque total e id. Use antes de afirmar qualquer coisa sobre produto, preço ou estoque.',
    input_schema: {
      type: 'object',
      properties: { termo: { type: 'string', description: 'termo de busca, ex.: "blusa canelada"' } },
      required: ['termo'],
    },
  },
  {
    name: 'detalhe_produto',
    description: 'Detalha um produto pelo id retornado por buscar_produtos: preço, estoque e variações (tamanho/cor) com estoque por variação quando existirem.',
    input_schema: {
      type: 'object',
      properties: { produto_id: { type: 'string', description: 'id (uuid) do produto' } },
      required: ['produto_id'],
    },
  },
  {
    name: 'info_loja',
    description: 'Retorna informações da loja: horário de funcionamento, endereço, política de troca, desconto Pix, opções de entrega e retirada, link da loja virtual.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'escalar',
    description: 'Escala a conversa para a equipe humana da loja. Use para: reclamação/defeito, pedido de desconto além do Pix cadastrado, promessa de prazo, ou qualquer pergunta que você não consegue responder com segurança.',
    input_schema: {
      type: 'object',
      properties: {
        motivo:    { type: 'string', description: 'explicação interna curta para a equipe' },
        categoria: { type: 'string', enum: CATEGORIES },
      },
      required: ['motivo'],
    },
  },
];

// ── Execução das ferramentas (SQL direto, escopo por company) ─
async function execTool(companyId, channelConfig, name, input) {
  if (name === 'buscar_produtos') {
    const termo = `%${String(input.termo || '').trim()}%`;
    const { rows } = await db.query(
      `-- aurinha:buscar-produtos
       SELECT id, name, price, stock_qty FROM products
        WHERE company_id = $1 AND name ILIKE $2
        ORDER BY stock_qty DESC, name ASC LIMIT 8`,
      [companyId, termo]
    );
    if (!rows.length) return { encontrados: 0, produtos: [] };
    return {
      encontrados: rows.length,
      produtos: rows.map(r => ({
        id: r.id, nome: r.name,
        preco: r.price != null ? Number(r.price) : null,
        estoque_total: r.stock_qty != null ? Number(r.stock_qty) : null,
      })),
    };
  }

  if (name === 'detalhe_produto') {
    const { rows } = await db.query(
      `SELECT id, name, price, stock_qty FROM products
        WHERE company_id = $1 AND id = $2 LIMIT 1`,
      [companyId, input.produto_id]
    );
    if (!rows.length) return { erro: 'produto não encontrado' };
    const p = rows[0];
    let variacoes = [];
    try {
      const { rows: vars } = await db.query(
        `SELECT sku_suffix, price_override, stock_qty FROM product_variants
          WHERE product_id = $1 ORDER BY sku_suffix ASC LIMIT 40`,
        [p.id]
      );
      variacoes = vars.map(v => ({
        variacao: v.sku_suffix,
        preco: v.price_override != null ? Number(v.price_override) : (p.price != null ? Number(p.price) : null),
        estoque: v.stock_qty != null ? Number(v.stock_qty) : null,
      }));
    } catch (e) {
      if (e.code !== '42P01') throw e; // tabela pode não existir em ambiente parcial
    }
    return {
      id: p.id, nome: p.name,
      preco: p.price != null ? Number(p.price) : null,
      estoque_total: p.stock_qty != null ? Number(p.stock_qty) : null,
      variacoes,
    };
  }

  if (name === 'info_loja') {
    const cfg = channelConfig || {};
    return {
      horario: cfg.always_open ? 'aberta 24 horas' : (cfg.business_hours || 'não informado'),
      endereco: cfg.address || cfg.pickup_address || 'não informado',
      politica_troca: cfg.politica_troca || 'não informada — escale se o cliente insistir em detalhes',
      desconto_pix_pct: Number(cfg.pix_discount_pct || 0),
      retirada: !!cfg.pickup_enabled,
      retirada_detalhe: cfg.pickup_eta_text || null,
      entrega: !!cfg.delivery_enabled,
      entrega_detalhe: cfg.delivery_eta_text || null,
      loja_virtual: cfg.slug ? `https://loja.getaura.com.br/${cfg.slug}` : null,
    };
  }

  if (name === 'escalar') {
    // Executada de verdade FORA do loop (handleInbound) — aqui só ecoa
    // para o modelo saber que foi registrada.
    return { escalada_registrada: true };
  }

  return { erro: `ferramenta desconhecida: ${name}` };
}

async function logEvent(companyId, conversationId, type, detail, userId = null) {
  await db.query(
    `INSERT INTO hub_agent_events (company_id, conversation_id, type, detail, user_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [companyId, conversationId, type, detail ? JSON.stringify(detail) : null, userId]
  ).catch(() => {});
}

async function loadSettings(companyId) {
  try {
    const { rows } = await db.query(
      `SELECT enabled, approval_mode, model, extra_instructions
         FROM hub_agent_settings WHERE company_id = $1 LIMIT 1`,
      [companyId]
    );
    return rows[0] || null;
  } catch (e) {
    if (e.code === '42P01') return null; // migration 312 pendente
    throw e;
  }
}

async function loadChannelConfig(companyId) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM digital_channel_config WHERE company_id = $1 LIMIT 1`,
      [companyId]
    );
    return rows[0] || null;
  } catch (e) {
    if (e.code === '42P01') return null;
    throw e;
  }
}

// Histórico da conversa em turns Anthropic (inbound = user, outbound = assistant).
async function loadHistory(conversationId) {
  const { rows } = await db.query(
    `SELECT direction, content FROM ig_messages
      WHERE conversation_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [conversationId, HISTORY_LIMIT]
  );
  const turns = [];
  for (const r of rows.reverse()) {
    const role = r.direction === 'inbound' ? 'user' : 'assistant';
    const content = String(r.content || '').slice(0, 2000);
    if (!content) continue;
    // Anthropic aceita turns consecutivos do mesmo role (são combinados).
    turns.push({ role, content });
  }
  // Primeiro turn precisa ser 'user'
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

function parseFinalJson(text) {
  let s = String(text || '').trim();
  const fence = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  const parsed = JSON.parse(s);
  if (!parsed || typeof parsed.resposta !== 'string' || !parsed.resposta.trim()) {
    throw new Error('resposta ausente no JSON da Aurinha');
  }
  return parsed;
}

// ── Entrada principal — chamada pelo webhook após persistir o inbound ─
// Nunca lança: falha vira evento 'erro' + log.
async function handleInbound(companyId, conversationId) {
  try {
    const settings = await loadSettings(companyId);
    if (!settings || !settings.enabled) return { handled: false, reason: 'DESATIVADA' };

    const { rows: convRows } = await db.query(
      `SELECT id, external_id, status, category, customer_name
         FROM hub_conversations WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [conversationId, companyId]
    );
    const conv = convRows[0];
    if (!conv) return { handled: false, reason: 'CONVERSA_INEXISTENTE' };
    if (conv.status !== 'ia') return { handled: false, reason: 'CONVERSA_NAO_IA' };

    const { rows: compRows } = await db.query(
      `SELECT trade_name, legal_name FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    const company = compRows[0] || {};
    const channelConfig = await loadChannelConfig(companyId);
    const system = buildSystemPrompt({ company, channelConfig, settings });
    const messages = await loadHistory(conversationId);
    if (!messages.length) return { handled: false, reason: 'SEM_INBOUND' };

    const model = settings.model || AURINHA_MODEL;
    let escalada = null;
    let result = null;

    // Loop de tool use
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      result = await callClaude({
        messages, system, model,
        maxTokens: 1024,
        tools: TOOLS,
      });
      if (result.stopReason !== 'tool_use') break;

      messages.push({ role: 'assistant', content: result.content });
      const toolResults = [];
      for (const tu of result.toolUses) {
        if (tu.name === 'escalar') {
          escalada = {
            motivo: String(tu.input?.motivo || 'sem motivo informado').slice(0, 500),
            categoria: CATEGORIES.includes(tu.input?.categoria) ? tu.input.categoria : null,
          };
        }
        let output;
        try {
          output = await execTool(companyId, channelConfig, tu.name, tu.input || {});
        } catch (e) {
          output = { erro: String(e.message || e).slice(0, 300) };
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify(output),
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    let parsed;
    try {
      parsed = parseFinalJson(result.text);
    } catch (e) {
      // Modelo fugiu do contrato: escala em vez de mandar texto cru para o cliente.
      escalada = escalada || { motivo: `Aurinha não produziu resposta válida (${String(e.message).slice(0, 120)})`, categoria: null };
      parsed = { resposta: null, categoria: null, escalar: escalada };
    }

    const categoria = CATEGORIES.includes(parsed.categoria) ? parsed.categoria : (escalada?.categoria || null);
    if (categoria && categoria !== conv.category) {
      await db.query(
        `UPDATE hub_conversations SET category = $1, updated_at = NOW() WHERE id = $2`,
        [categoria, conversationId]
      ).catch(() => {});
      await logEvent(companyId, conversationId, 'categorizada', { categoria });
    }

    const querEscalar = escalada || (parsed.escalar && parsed.escalar !== false ? {
      motivo: String(parsed.escalar.motivo || 'escalada pela Aurinha').slice(0, 500),
      categoria,
    } : null);

    if (querEscalar) {
      // precisa_humano ANTES de enfileirar o acolhimento — trava novas respostas da IA.
      await db.query(
        `UPDATE hub_conversations
            SET status = 'precisa_humano', handoff_reason = $1, updated_at = NOW()
          WHERE id = $2 AND status = 'ia'`,
        [querEscalar.motivo, conversationId]
      );
      await logEvent(companyId, conversationId, 'handoff', querEscalar);
    }

    if (parsed.resposta && parsed.resposta.trim()) {
      const enq = await igOutbox.enqueue({
        companyId,
        conversationId,
        toIgId: conv.external_id,
        textBody: parsed.resposta.trim(),
        sourceType: 'aurinha',
        needsApproval: !!settings.approval_mode,
      });
      await logEvent(companyId, conversationId, 'resposta_sugerida', {
        outbox_id: enq.id || null, status: enq.status || null,
        aprovacao: !!settings.approval_mode, escalada: !!querEscalar,
        tokens_in: result.inputTokens, tokens_out: result.outputTokens, model: result.model,
      });
    }

    return { handled: true, escalada: !!querEscalar, categoria };
  } catch (err) {
    console.error('[AURINHA] handleInbound error:', err.message);
    await logEvent(companyId, conversationId, 'erro', { message: String(err.message).slice(0, 500) });
    return { handled: false, reason: 'ERRO', error: err.message };
  }
}

module.exports = { handleInbound, TOOLS, AURINHA_MODEL };
