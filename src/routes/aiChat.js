// ============================================================
// AURA. — BE-REV-07: Agentes IA Proxy (with real data context)
// POST /companies/:id/ai/chat — chat contextual por aba
// GET  /companies/:id/ai/activity — log de atividade
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireRole } = require('../middleware/auth');
const { getContextData } = require('../services/aiContext');

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || null;
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';

const RATE_LIMITS = { expansao: 100, negocio: 20, essencial: 0 };
let redis = null;
try { redis = require('../config/redis').default || require('../config/redis'); } catch (_) {}

async function checkRateLimit(companyId, plan) {
  const limit = RATE_LIMITS[plan] || 0;
  if (limit === 0) return false;
  if (!redis) return true;
  const key = `rl:ai:${companyId}`;
  try {
    const cnt = await redis.incr(key);
    if (cnt === 1) await redis.expire(key, 3600);
    return cnt <= limit;
  } catch (_) { return true; }
}

const SYSTEM_PROMPTS = {
  financeiro: `Voce e o Agente Financeiro da Aura. Analise os DADOS REAIS do negocio fornecidos abaixo e ajude com:
- Fluxo de caixa e projecoes baseadas nos numeros reais
- Identificar cobrancas em atraso e sugerir acoes concretas
- Analise de receitas vs despesas do mes atual
- Sugestoes para melhorar margem de lucro
Sempre responda em portugues brasileiro, de forma pratica e direta. SEMPRE use os dados reais fornecidos, nunca invente numeros.`,

  estoque: `Voce e o Agente de Estoque da Aura. Analise os DADOS REAIS do estoque fornecidos abaixo e ajude com:
- Alertas de reposicao baseados no estoque real
- Analise dos produtos mais vendidos
- Sugestoes de pedidos de compra com quantidades
- Otimizacao de estoque minimo
Sempre use os dados reais. Nunca invente numeros.`,

  crm: `Voce e o Agente de CRM da Aura. Analise os DADOS REAIS de clientes fornecidos abaixo e ajude com:
- Reativar clientes inativos com acoes especificas
- Aproveitar aniversarios para fidelizacao
- Ranking de clientes por valor gasto
- Estrategias de retencao baseadas nos dados reais
Sempre use os dados reais. Foque em acoes praticas e personalizadas.`,

  contabil: `Voce e o Agente Contabil da Aura. Analise os DADOS REAIS das obrigacoes fornecidos abaixo e ajude com:
- Lembretes de obrigacoes fiscais com prazos reais
- Estimativas de impostos baseadas no faturamento
- Orientacao sobre procedimentos
- IMPORTANTE: Tudo e estimativa e apoio contabil informativo. Nunca diga que e declaracao oficial.
Sempre use os dados reais do checklist e obrigacoes.`,

  marketing: `Voce e o Agente de Marketing da Aura. Analise os DADOS REAIS de vendas fornecidos abaixo e ajude com:
- Criar posts destacando produtos mais vendidos
- Sugestoes de promocoes baseadas no estoque e tendencias
- Textos para WhatsApp e Instagram
- Estrategias de divulgacao baseadas nos dados reais do negocio
Seja criativo mas sempre use os numeros reais.`,

  geral: `Voce e o Assistente IA da Aura, uma plataforma de gestao para pequenos negocios.
Voce tem acesso aos DADOS REAIS do negocio fornecidos abaixo. Use-os para dar respostas precisas e personalizadas.
Seja pratico, direto e responda em portugues brasileiro.
Nao forneca assessoria tributaria vinculante.`,
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

  const plan = req.user?.plan || 'essencial';
  if (plan === 'essencial') {
    return res.status(403).json({ error: 'Agentes IA disponiveis a partir do plano Negocio', requiredPlan: 'negocio' });
  }

  const allowed = await checkRateLimit(cid, plan);
  if (!allowed) {
    return res.status(429).json({ error: 'Limite de mensagens atingido. Tente novamente em 1 hora.' });
  }

  // Build enriched system prompt
  const systemPrompt = SYSTEM_PROMPTS[context] || SYSTEM_PROMPTS.geral;
  let companyContext = '';
  try {
    const { rows } = await db.query(
      `SELECT legal_name, trade_name, tax_regime, plan, vertical_active, address_city, address_state
       FROM companies WHERE id = $1`, [cid]);
    if (rows[0]) {
      const co = rows[0];
      companyContext = `\n\nEmpresa: ${co.trade_name || co.legal_name || 'N/A'} | Regime: ${co.tax_regime || 'N/A'} | Plano: ${co.plan || 'N/A'} | ${co.address_city || ''}/${co.address_state || 'SP'}`;
    }
  } catch (_) {}

  // Fetch REAL business data for this context
  let businessData = '';
  try {
    const data = await getContextData(cid, context);
    if (Object.keys(data).length > 0) {
      businessData = '\n\n=== DADOS REAIS DO NEGOCIO ===\n' + JSON.stringify(data, null, 2) + '\n=== FIM DOS DADOS ===';
    }
  } catch (_) {}

  const fullSystemPrompt = systemPrompt + companyContext + businessData;

  // Mock response if no API key
  if (!CLAUDE_API_KEY) {
    try {
      await db.query(
        `INSERT INTO ai_activity_log (company_id, user_id, agent, action, detail, status) VALUES ($1,$2,$3,'Chat',$4,'done')`,
        [cid, req.user.id, context, message.substring(0, 200)]).catch(() => {});
    } catch (_) {}
    return res.json({
      response: 'Configure CLAUDE_API_KEY no Railway para ativar os agentes com dados reais. Os dados do seu negocio estao prontos para analise.',
      context, model: 'mock',
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
      headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1024, system: fullSystemPrompt, messages }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error('Claude API error:', response.status, errData);
      return res.status(502).json({ error: 'Erro na API de IA. Tente novamente.' });
    }

    const data = await response.json();
    const text = data.content?.map(c => c.text || '').join('') || 'Sem resposta.';

    try {
      await db.query(
        `INSERT INTO ai_activity_log (company_id, user_id, agent, action, detail, status) VALUES ($1,$2,$3,'Chat',$4,'done')`,
        [cid, req.user.id, context, message.substring(0, 200)]).catch(() => {});
    } catch (_) {}

    res.json({ response: text, context, model: CLAUDE_MODEL, usage: data.usage || null });
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
      `SELECT id, agent, action, detail, status, created_at FROM ai_activity_log
       WHERE company_id=$1 ORDER BY created_at DESC LIMIT $2`, [cid, limit]);
    let summary = [];
    try {
      const { rows: sumRows } = await db.query(
        `SELECT agent, COUNT(*) AS actions FROM ai_activity_log
         WHERE company_id=$1 AND created_at >= date_trunc('month', CURRENT_DATE)
         GROUP BY agent ORDER BY actions DESC`, [cid]);
      summary = sumRows.map(r => ({ name: r.agent, actions: parseInt(r.actions) || 0 }));
    } catch (_) {}
    res.json({
      activity: rows.map(r => ({ id: r.id, agent: r.agent, action: r.action, detail: r.detail, status: r.status, time: r.created_at })),
      summary, total: rows.length,
    });
  } catch (err) {
    if (err.message?.includes('does not exist')) return res.json({ activity: [], summary: [], total: 0 });
    res.status(500).json({ error: 'Erro ao buscar atividade' });
  }
});

module.exports = router;
