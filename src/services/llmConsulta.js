// ============================================================
// AURA. — IA Modo Consulta · service Anthropic Claude Haiku 4.5
// PR18 (2026-04-27)
//
// Wrapper unico pra todas as chamadas LLM do feature
// "IA Aura no Modo Consulta". Centraliza:
//   - chamada HTTP a Anthropic Messages API
//   - calculo de custo USD (price table por modelo)
//   - log em ai_usage_log (sem conteudo, so metadata)
//   - timeout + erro consistente
//
// Por que NAO reusa callClaude do dentalAi.js:
//   - dentalAi usa Sonnet 4 (pra chat persistente);
//   - Modo Consulta usa Haiku 4.5 (latencia + custo);
//   - cost tracking centralizado nasce aqui;
//   - manter dentalAi.js intacto pra nao quebrar feature ja em prod.
//
// Env: CLAUDE_API_KEY (mesma var do aiChat.js + dentalAi.js).
// Modelo default: claude-haiku-4-5-20251001.
// Override: passar `model` no opts.
// ============================================================

const db = require('../config/database');

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || null;
const CLAUDE_URL     = 'https://api.anthropic.com/v1/messages';

// Modelo default — Haiku 4.5 cobre 95% dos casos cobrados do consulta.
// Pra um dia rotear por intent (Sonnet pra summarize complexo), expor
// em opts.model. Por ora, simples.
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 25000;

// ─────────────────────────────────────────────────────────
// Tabela de precos USD por 1M tokens.
// Atualizar conforme Anthropic publica novos pricing.
// Source: https://www.anthropic.com/pricing
// ─────────────────────────────────────────────────────────
const MODEL_PRICING = {
  'claude-haiku-4-5-20251001':  { in: 0.25,  out: 1.25 },
  'claude-haiku-4-5':           { in: 0.25,  out: 1.25 },
  'claude-sonnet-4-6':          { in: 3.00,  out: 15.00 },
  'claude-sonnet-4-20250514':   { in: 3.00,  out: 15.00 },
  'claude-opus-4-6':            { in: 15.00, out: 75.00 },
};

function calcCostUsd(model, tokensIn, tokensOut) {
  const p = MODEL_PRICING[model] || MODEL_PRICING[DEFAULT_MODEL];
  const inUsd  = (tokensIn  / 1_000_000) * p.in;
  const outUsd = (tokensOut / 1_000_000) * p.out;
  return Number((inUsd + outUsd).toFixed(6));
}

// ─────────────────────────────────────────────────────────
// callConsultaLLM — funcao principal exportada.
//
// Parametros:
//   { companyId, userId, appointmentId, intent, systemPrompt,
//     userMessage, history?, model?, maxTokens?, timeoutMs? }
//
// Retorna:
//   { ok: true,  text, tokens_in, tokens_out, cost_usd, latency_ms, model }
//   { ok: false, error, status, latency_ms }
//
// Em ambos os casos, escreve uma linha em ai_usage_log
// (status 'ok' | 'error' | 'timeout' | 'rate_limited').
//
// Se CLAUDE_API_KEY ausente, devolve resposta simulada
// (mesmo padrao do dentalAi.js) e loga status='error'
// com error_message='no_api_key'.
// ─────────────────────────────────────────────────────────
async function callConsultaLLM(opts) {
  const {
    companyId, userId = null, appointmentId = null,
    intent, systemPrompt, userMessage, history = [],
    model     = DEFAULT_MODEL,
    maxTokens = DEFAULT_MAX_TOKENS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts || {};

  if (!companyId || !intent || !systemPrompt || !userMessage) {
    throw new Error('callConsultaLLM: companyId, intent, systemPrompt e userMessage sao obrigatorios');
  }

  const startedAt = Date.now();

  // Sem key configurada → fallback simulado + log de error
  if (!CLAUDE_API_KEY) {
    const text = `[CLAUDE_API_KEY nao configurada no servidor]\n\nResposta simulada para intent='${intent}'. Configure CLAUDE_API_KEY no Railway pra ativar a IA do Modo Consulta.`;
    await logUsage({
      companyId, userId, appointmentId,
      intent, model, tokensIn: 0, tokensOut: 0, costUsd: 0,
      latencyMs: Date.now() - startedAt,
      status: 'error', errorMessage: 'no_api_key',
    });
    return { ok: true, text, tokens_in: 0, tokens_out: 0, cost_usd: 0, latency_ms: 0, model, simulated: true };
  }

  const messages = [
    ...history.slice(-10).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const resp = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages,
      }),
      signal: controller?.signal,
    });
    if (timer) clearTimeout(timer);

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      const errMsg = errData.error?.message || `HTTP ${resp.status}`;
      const latency = Date.now() - startedAt;
      await logUsage({
        companyId, userId, appointmentId,
        intent, model, tokensIn: 0, tokensOut: 0, costUsd: 0,
        latencyMs: latency,
        status: resp.status === 429 ? 'rate_limited' : 'error',
        errorMessage: errMsg.substring(0, 500),
      });
      return { ok: false, error: `Erro Claude API: ${errMsg}`, status: resp.status, latency_ms: latency };
    }

    const data = await resp.json();
    const text = data.content?.map((c) => c.text || '').join('') || 'Sem resposta.';
    const tokensIn  = data.usage?.input_tokens  || 0;
    const tokensOut = data.usage?.output_tokens || 0;
    const costUsd   = calcCostUsd(model, tokensIn, tokensOut);
    const latency   = Date.now() - startedAt;

    await logUsage({
      companyId, userId, appointmentId,
      intent, model, tokensIn, tokensOut, costUsd, latencyMs: latency,
      status: 'ok',
    });

    return {
      ok: true,
      text,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd,
      latency_ms: latency,
      model,
    };
  } catch (err) {
    if (timer) clearTimeout(timer);
    const latency = Date.now() - startedAt;
    const isTimeout = err.name === 'AbortError';
    const status = isTimeout ? 'timeout' : 'error';
    const errMsg = isTimeout
      ? `Timeout (>${Math.round(timeoutMs / 1000)}s) na chamada a Claude`
      : `Erro ao chamar Claude: ${err.message || err}`;
    await logUsage({
      companyId, userId, appointmentId,
      intent, model, tokensIn: 0, tokensOut: 0, costUsd: 0,
      latencyMs: latency,
      status, errorMessage: errMsg.substring(0, 500),
    });
    return { ok: false, error: errMsg, status: isTimeout ? 504 : 500, latency_ms: latency };
  }
}

// ─────────────────────────────────────────────────────────
// logUsage — INSERT em ai_usage_log. Sem conteudo das mensagens.
// Erro de log nao falha a request principal — apenas console.error.
// ─────────────────────────────────────────────────────────
async function logUsage(p) {
  try {
    await db.query(
      `INSERT INTO ai_usage_log
        (company_id, user_id, appointment_id, feature, intent, model,
         tokens_in, tokens_out, cost_usd, latency_ms, status, error_message)
       VALUES ($1,$2,$3,'consulta',$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        p.companyId, p.userId, p.appointmentId,
        p.intent, p.model,
        p.tokensIn, p.tokensOut, p.costUsd, p.latencyMs,
        p.status, p.errorMessage || null,
      ],
    );
  } catch (err) {
    console.error('[llmConsulta] logUsage failed (non-fatal):', err.message);
  }
}

// ─────────────────────────────────────────────────────────
// checkMonthlyQuota — antes de chamar callConsultaLLM, verificar
// se a empresa ainda esta dentro da quota mensal.
//
// Retorna:
//   { ok: true,  used, total, remaining }
//   { ok: false, used, total, remaining: 0, message }
//
// Se ai_monthly_quota IS NULL, e ilimitado (Personalizado).
// ─────────────────────────────────────────────────────────
async function checkMonthlyQuota(companyId) {
  try {
    const { rows } = await db.query(
      `SELECT ai_monthly_quota FROM companies WHERE id = $1`,
      [companyId],
    );
    const quota = rows[0]?.ai_monthly_quota;
    if (quota == null) {
      return { ok: true, used: null, total: null, remaining: null, unlimited: true };
    }

    const { rows: usage } = await db.query(
      `SELECT COUNT(*)::int AS used
         FROM ai_usage_log
        WHERE company_id = $1
          AND feature = 'consulta'
          AND status = 'ok'
          AND created_at >= date_trunc('month', NOW())`,
      [companyId],
    );
    const used = usage[0]?.used || 0;
    const remaining = Math.max(0, quota - used);

    if (used >= quota) {
      return {
        ok: false, used, total: quota, remaining: 0,
        message: `Cota mensal de IA esgotada (${quota} chamadas). Aguarde a virada do mes ou contate suporte para upgrade.`,
      };
    }
    return { ok: true, used, total: quota, remaining };
  } catch (err) {
    console.error('[llmConsulta] quota check failed:', err.message);
    // Erro de quota nao bloqueia (fail-open) pra nao matar consulta por bug nosso
    return { ok: true, used: 0, total: null, remaining: null, error: err.message };
  }
}

module.exports = {
  callConsultaLLM,
  checkMonthlyQuota,
  calcCostUsd,
  DEFAULT_MODEL,
  MODEL_PRICING,
};
