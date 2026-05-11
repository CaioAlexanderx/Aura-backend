// ============================================================
// AURA. — Narrative Generator
// Gera narrativas de texto para os relatórios automáticos.
// Usa Claude Haiku 4.5 com fallback determinístico.
// Timeout: 8s por chamada. Concorrência: max 5 simultâneas.
// ============================================================

'use strict';

const { callClaude } = require('./claudeClient');

// ---------------------------------------------------------------------------
// Concurrency limiter (substituto de p-limit)
// ---------------------------------------------------------------------------
function createLimiter(concurrency) {
  let running = 0;
  const queue = [];

  function run() {
    while (running < concurrency && queue.length > 0) {
      running++;
      const { fn, resolve, reject } = queue.shift();
      fn()
        .then(v => { running--; resolve(v); run(); })
        .catch(e => { running--; reject(e); run(); });
    }
  }

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      run();
    });
  };
}

const limit = createLimiter(5); // max 5 chamadas simultâneas ao Haiku

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `Você é o analista de negócios da Aura, assistente para pequenos negócios brasileiros.
Escreva exatamente as frases solicitadas sobre os dados fornecidos.
Regras obrigatórias:
- Use verbos imperativos (crie, reforce, investigue, priorize, monitore)
- Seja específico — cite números quando relevante
- NUNCA use condicional: "se", "caso", "pode ajudar", "talvez", "poderia"
- Não repita números que já estão exibidos nos cards
- Destaque o que é relevante ou surpreendente
- Responda apenas com o texto das frases, sem prefixo, lista ou markdown`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function bestDay(dailyRevenue) {
  if (!dailyRevenue || !dailyRevenue.length) return 'sábado';
  return dailyRevenue.reduce((a, b) => (b.value > a.value ? b : a)).day;
}

function worstDay(dailyRevenue) {
  if (!dailyRevenue || !dailyRevenue.length) return null;
  return dailyRevenue.reduce((a, b) => (b.value < a.value ? b : a));
}

function fmtBRL(v) {
  const n = Math.round(v * 100) / 100;
  const [int, dec] = n.toFixed(2).split('.');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (dec === '00' ? '' : ',' + dec);
}

// ---------------------------------------------------------------------------
// buildSectionPrompt
// ---------------------------------------------------------------------------
function buildSectionPrompt(section, data, maxSentences) {
  switch (section) {
    case 'faturamento_semanal': {
      const { dailyRevenue, kpis } = data;
      const best = dailyRevenue && dailyRevenue.length
        ? dailyRevenue.reduce((a, b) => (b.value > a.value ? b : a))
        : null;
      const worst = dailyRevenue && dailyRevenue.length
        ? dailyRevenue.reduce((a, b) => (b.value < a.value ? b : a))
        : null;
      // kpis.revenue é o campo correto (não revenue_total)
      const total = kpis && kpis.revenue != null
        ? `R$${fmtBRL(kpis.revenue)}`
        : 'valor não disponível';
      return (
        `Escreva ${maxSentences} frase${maxSentences !== 1 ? 's' : ''} sobre o faturamento da semana. ` +
        (best ? `Melhor dia: ${best.day} com R$${fmtBRL(best.value)}. ` : '') +
        (worst ? `Pior dia: ${worst.day} com R$${fmtBRL(worst.value)}. ` : '') +
        `Total semanal: ${total}.`
      );
    }

    case 'top_produtos': {
      const { topProducts } = data;
      const p = topProducts && topProducts.length ? topProducts[0] : null;
      if (!p) return 'Escreva 1 frase sobre os produtos mais vendidos da semana. Dados não disponíveis.';
      return (
        `Escreva 1 frase sobre os produtos mais vendidos da semana. ` +
        `Produto líder: ${p.name} com R$${fmtBRL(p.revenue)} em ${p.qty} unidades.`
      );
    }

    case 'formas_pagamento': {
      const { payments } = data;
      const pm = payments && payments.length ? payments[0] : null;
      if (!pm) return 'Escreva 1 frase sobre as formas de pagamento da semana. Dados não disponíveis.';
      return (
        `Escreva 1 frase sobre as formas de pagamento da semana. ` +
        `Principal método: ${pm.name} com ${pm.pct}% do total.`
      );
    }

    default:
      return `Escreva ${maxSentences} frase${maxSentences !== 1 ? 's' : ''} resumindo os dados da seção "${section}".`;
  }
}

// ---------------------------------------------------------------------------
// fallbackNarrative
// ---------------------------------------------------------------------------
function fallbackNarrative(section, data) {
  switch (section) {
    case 'faturamento_semanal': {
      const { dailyRevenue } = data;
      const best = bestDay(dailyRevenue);
      const worst = worstDay(dailyRevenue);
      if (worst) {
        return `O melhor dia foi ${best}. Monitore ${worst.day}, que registrou o menor volume da semana.`;
      }
      return `Monitore a evolução diária do faturamento para identificar padrões de alta e baixa.`;
    }

    case 'top_produtos': {
      const { topProducts } = data;
      const p = topProducts && topProducts.length ? topProducts[0] : null;
      if (p) {
        return `Reforce o estoque de ${p.name}, líder em receita com R$${fmtBRL(p.revenue)}.`;
      }
      return `Priorize os produtos com maior giro para garantir disponibilidade contínua.`;
    }

    case 'formas_pagamento': {
      const { payments } = data;
      const pm = payments && payments.length ? payments[0] : null;
      if (pm) {
        return `${pm.name} concentrou ${pm.pct}% dos pagamentos — monitore a diversificação dos métodos.`;
      }
      return `Monitore a distribuição das formas de pagamento para identificar preferências dos clientes.`;
    }

    default:
      return `Analise os dados desta seção para identificar oportunidades de melhoria.`;
  }
}

// ---------------------------------------------------------------------------
// generateSection
// ---------------------------------------------------------------------------
async function generateSection(section, data, maxSentences) {
  const userPrompt = buildSectionPrompt(section, data, maxSentences);

  try {
    const result = await Promise.race([
      callClaude({
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 150,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 8000)
      ),
    ]);
    return result.text.trim();
  } catch (err) {
    console.warn(`[narrativeGenerator] fallback para seção ${section}:`, err.message);
    return fallbackNarrative(section, data);
  }
}

// ---------------------------------------------------------------------------
// selectPriorities — lógica determinística, sem Haiku
// ---------------------------------------------------------------------------
function selectPriorities({ health, kpis, dailyRevenue, staleProducts, dormantCustomers, financeiroInsights }) {
  const candidates = [];

  // 1. Inadimplência (maior impacto)
  const lever = financeiroInsights && financeiroInsights.biggest_lever;
  if (lever && lever.amount > 0) {
    candidates.push({
      weight: lever.amount,
      action: `Cobrar <b>R$ ${fmtBRL(lever.amount)}</b> em atraso de <b>${lever.count || ''} cliente${lever.count !== 1 ? 's' : ''}</b>.`,
      impact: `Impacto direto no caixa de ${lever.impact_days || 'alguns'} dias`,
      cta_label: 'Abrir cobranças',
      cta_url: 'https://app.getaura.com.br/financeiro',
    });
  }

  // 2. Produto parado
  if (staleProducts && staleProducts.length > 0) {
    const p = staleProducts[0];
    candidates.push({
      weight: 5000,
      action: `Movimentar <b>${p.name}</b> — parado há <b>${p.days_idle != null ? p.days_idle : '14+'} dias</b> sem venda.`,
      impact: `Crie uma promoção ou reposicione no PDV para girar o estoque`,
      cta_label: 'Ver estoque',
      cta_url: 'https://app.getaura.com.br/estoque',
    });
  }

  // 3. Pior dia da semana
  const worst = worstDay(dailyRevenue);
  if (worst) {
    candidates.push({
      weight: 3000,
      action: `Criar uma promoção para <b>${worst.day}</b>.`,
      impact: `Foi o dia mais fraco — uma oferta pode equilibrar o fluxo`,
      cta_label: 'Criar cupom',
      cta_url: 'https://app.getaura.com.br/marketing',
    });
  }

  // 4. Queda de receita > 15%
  if (kpis && kpis.revenue_delta < -15) {
    candidates.push({
      weight: 8000,
      action: `Investigar a queda de <b>${Math.abs(kpis.revenue_delta).toFixed(1)}%</b> na receita desta semana.`,
      impact: `Verifique fechamentos antecipados ou queda de movimento`,
      cta_label: 'Ver histórico',
      cta_url: 'https://app.getaura.com.br/vendas',
    });
  }

  // 5. Clientes sumidos
  if (dormantCustomers && dormantCustomers.count > 0) {
    candidates.push({
      weight: 2000,
      action: `<b>${dormantCustomers.count} cliente${dormantCustomers.count !== 1 ? 's' : ''}</b> não voltaram há mais de 30 dias.`,
      impact: `Envie uma mensagem de retorno`,
      cta_label: 'Ver clientes',
      cta_url: 'https://app.getaura.com.br/clientes',
    });
  }

  // Ordenar por weight desc, pegar top 3
  candidates.sort((a, b) => b.weight - a.weight);
  return candidates
    .slice(0, 3)
    .map(({ action, impact, cta_label, cta_url }) => ({ action, impact, cta_label, cta_url }));
}

// ---------------------------------------------------------------------------
// generateWeeklyNarratives — ponto de entrada principal
// ---------------------------------------------------------------------------
async function generateWeeklyNarratives(reportData) {
  const { kpis, dailyRevenue, topProducts, payments } = reportData;

  const [revenueNarr, productsNarr, paymentsNarr] = await Promise.all([
    limit(() => generateSection('faturamento_semanal', { dailyRevenue, kpis }, 2)),
    limit(() => generateSection('top_produtos', { topProducts }, 1)),
    limit(() => generateSection('formas_pagamento', { payments }, 1)),
  ]);

  return {
    revenue: revenueNarr,
    products: productsNarr,
    payments: paymentsNarr,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { generateWeeklyNarratives, selectPriorities };
