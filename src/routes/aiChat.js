// ============================================================
// AURA. — BE-REV-07: Agentes IA Proxy
// POST /companies/:id/ai/chat — chat contextual por aba
// GET  /companies/:id/ai/activity — log de atividade dos agentes
// Uses Claude Sonnet API with contextual system prompts
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireRole } = require('../middleware/auth');

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || null;
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';

// Rate limit: max requests per hour by plan
const RATE_LIMITS = { expansao: 100, negocio: 20, essencial: 0 };
let redis = null;
try { redis = require('../config/redis').default || require('../config/redis'); } catch (_) {}

async function checkRateLimit(companyId, plan) {
  const limit = RATE_LIMITS[plan] || 0;
  if (limit === 0) return false;
  if (!redis) return true; // no redis = no rate limit
  const key = `rl:ai:${companyId}`;
  try {
    const cnt = await redis.incr(key);
    if (cnt === 1) await redis.expire(key, 3600);
    return cnt <= limit;
  } catch (_) { return true; }
}

// Context-specific system prompts per tab
const SYSTEM_PROMPTS = {
  financeiro: `Voce e o Agente Financeiro da Aura. Analise dados financeiros do negocio e ajude com:
- Fluxo de caixa e projecoes
- Identificar cobran\u00e7as em atraso e sugerir acoes
- Analise de receitas vs despesas
- Sugestoes para melhorar margem de lucro
Sempre responda em portugues brasileiro, de forma pratica e direta. Use dados reais quando fornecidos.`,

  estoque: `Voce e o Agente de Estoque da Aura. Ajude com:
- Alertas de reposicao e estoque baixo
- Analise da curva ABC
- Sugestoes de pedidos de compra
- Otimizacao de estoque minimo
Sempre responda em portugues brasileiro. Seja pratico e objetivo.`,

  crm: `Voce e o Agente de CRM da Aura. Ajude com:
- Identificar clientes inativos para reativacao
- Sugerir acoes de fidelizacao
- Aniversarios e oportunidades de relacionamento
- Analise de ranking e LTV
Sempre responda em portugues brasileiro. Foque em acoes praticas.`,

  contabil: `Voce e o Agente Contabil da Aura. Ajude com:
- Lembretes de obrigacoes fiscais (DAS, eSocial, PGDAS-D)
- Estimativas de impostos
- Orientacao sobre prazos e procedimentos
- IMPORTANTE: Tudo e estimativa e apoio contabil. Nunca diga que e declaracao oficial ou assessoria tributaria.
Sempre responda em portugues brasileiro.`,

  marketing: `Voce e o Agente de Marketing da Aura. Ajude com:
- Criar posts para Instagram e WhatsApp
- Sugestoes de promocoes e campanhas
- Textos para comunicacao com clientes
- Estrategias de divulgacao para pequenos negocios
Sempre responda em portugues brasileiro. Seja criativo mas pratico.`,

  geral: `Voce e o Assistente IA da Aura, uma plataforma de gestao para pequenos negocios.
Ajude o usuario com qualquer duvida sobre o negocio. Seja pratico, direto e responda em portugues brasileiro.
Nao forneca assessoria tributaria vinculante — tudo e estimativa e apoio contabil informativo.`,
};

// POST /companies/:id/ai/chat
router.post('/chat', requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const cid = req.params.id;
  const { message, context = 'geral', history = [] } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'message e obrigatorio' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'Mensagem muito longa (max 2000 caracteres)' });
  }

  // Check plan
  const plan = req.user?.plan || 'essencial';
  if (plan === 'essencial') {
    return res.status(403).json({ error: 'Agentes IA disponiveis a partir do plano Expansao', requiredPlan: 'expansao' });
  }

  // Rate limit
  const allowed = await checkRateLimit(cid, plan);
  if (!allowed) {
    return res.status(429).json({ error: 'Limite de mensagens atingido. Tente novamente em 1 hora.' });
  }

  // Get system prompt
  const systemPrompt = SYSTEM_PROMPTS[context] || SYSTEM_PROMPTS.geral;

  // Build enriched system prompt with company context
  let companyContext = '';
  try {
    const { rows } = await db.query(
      `SELECT c.legal_name, c.trade_name, c.tax_regime, c.plan, c.vertical_active,
              c.address_city, c.address_state
       FROM companies c WHERE c.id = $1`, [cid]
    );
    if (rows[0]) {
      const co = rows[0];
      companyContext = `\n\nContexto da empresa:\n- Nome: ${co.trade_name || co.legal_name || 'N/A'}\n- Regime: ${co.tax_regime || 'N/A'}\n- Plano: ${co.plan || 'N/A'}\n- Cidade: ${co.address_city || 'N/A'}/${co.address_state || 'SP'}`;
      if (co.vertical_active) companyContext += `\n- Vertical: ${co.vertical_active}`;
    }
  } catch (_) {}

  const fullSystemPrompt = systemPrompt + companyContext;

  // If no API key, return a helpful mock response
  if (!CLAUDE_API_KEY) {
    const mockResponses = {
      financeiro: 'Com base nos seus dados, seu fluxo de caixa esta saudavel com margem de 46,6%. Recomendo cobrar os 2 clientes em atraso (Joao Santos R$ 1.240 e Carlos Lima R$ 430) via WhatsApp para manter a saude financeira.',
      estoque: 'Identifiquei 3 produtos abaixo do estoque minimo: Pomada modeladora (2 un.), Condicionador Premium (3 un.) e Pos-Barba Premium (2 un.). Custo estimado de reposicao: R$ 132,00. Sugiro criar um pedido de compra.',
      crm: 'Voce tem 8 clientes inativos ha mais de 30 dias e 1 aniversario proximo (Joao Santos - 08/04). Sugiro enviar uma mensagem de reativacao com oferta especial e parabens antecipados para o Joao.',
      contabil: 'Proximo vencimento: DAS-MEI em 20/04 (R$ 76,90). Estimativa informativa. O QR Code Pix esta disponivel na aba de checkpoints. Lembre-se de verificar o eSocial ate 15/04.',
      marketing: 'Que tal um post no Instagram destacando o combo Corte+Barba por R$ 65? Texto sugerido: "Combo que e sucesso! Corte + barba completa por apenas R$ 65. Agende agora pelo WhatsApp!"',
      geral: 'Como posso ajudar com seu negocio? Posso analisar financas, estoque, clientes, obrigacoes contabeis ou criar conteudo de marketing. Escolha uma area ou me faca uma pergunta!',
    };
    // Log activity
    try {
      await db.query(
        `INSERT INTO ai_activity_log (company_id, user_id, agent, action, detail, status)
         VALUES ($1, $2, $3, 'Chat', $4, 'done')`,
        [cid, req.user.id, context, message.substring(0, 200)]
      ).catch(() => {});
    } catch (_) {}

    return res.json({
      response: mockResponses[context] || mockResponses.geral,
      context,
      model: 'mock',
      note: 'Resposta demonstrativa. Configure CLAUDE_API_KEY no Railway para respostas reais.',
    });
  }

  // Real Claude API call
  try {
    const messages = [
      ...history.slice(-10).map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: message.trim() },
    ];

    const response = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: fullSystemPrompt,
        messages,
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error('Claude API error:', response.status, errData);
      return res.status(502).json({ error: 'Erro na API de IA. Tente novamente.' });
    }

    const data = await response.json();
    const text = data.content?.map(c => c.text || '').join('') || 'Sem resposta.';

    // Log activity
    try {
      await db.query(
        `INSERT INTO ai_activity_log (company_id, user_id, agent, action, detail, status)
         VALUES ($1, $2, $3, 'Chat', $4, 'done')`,
        [cid, req.user.id, context, message.substring(0, 200)]
      ).catch(() => {});
    } catch (_) {}

    res.json({
      response: text,
      context,
      model: CLAUDE_MODEL,
      usage: data.usage || null,
    });
  } catch (err) {
    console.error('AI chat error:', err);
    res.status(500).json({ error: 'Erro ao processar mensagem' });
  }
});

// GET /companies/:id/ai/activity
router.get('/activity', async (req, res) => {
  const cid = req.params.id;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);

  try {
    const { rows } = await db.query(
      `SELECT id, agent, action, detail, status, created_at
       FROM ai_activity_log
       WHERE company_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [cid, limit]
    );

    // Agent summary
    let summary = [];
    try {
      const { rows: sumRows } = await db.query(
        `SELECT agent,
                COUNT(*) AS actions,
                COUNT(DISTINCT DATE(created_at)) AS active_days
         FROM ai_activity_log
         WHERE company_id = $1
           AND created_at >= date_trunc('month', CURRENT_DATE)
         GROUP BY agent
         ORDER BY actions DESC`,
        [cid]
      );
      summary = sumRows.map(r => ({
        name: r.agent,
        actions: parseInt(r.actions) || 0,
        active_days: parseInt(r.active_days) || 0,
      }));
    } catch (_) {}

    res.json({
      activity: rows.map(r => ({
        id: r.id,
        agent: r.agent,
        action: r.action,
        detail: r.detail,
        status: r.status,
        time: r.created_at,
      })),
      summary,
      total: rows.length,
    });
  } catch (err) {
    // Graceful fallback if table doesn't exist
    if (err.message?.includes('does not exist')) {
      return res.json({ activity: [], summary: [], total: 0 });
    }
    console.error('ai activity error:', err);
    res.status(500).json({ error: 'Erro ao buscar atividade' });
  }
});

module.exports = router;
