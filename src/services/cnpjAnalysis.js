// ============================================================
// AURA. — Serviço de Análise de Prospect por CNPJ (FEAT-01)
// Uso interno: Analista Comercial no painel Gestão Aura
// ============================================================

const { validateCNPJ, sanitizeCNPJ, formatCNPJ } = require('./cnpj');

const RF_API_URL = 'https://publica.cnpj.ws/cnpj';

const CNAE_VERTICAL_MAP = {
  '8650': 'odontologia',
  '9602': 'barbearia',
  '9603': 'barbearia',
  '9609': 'estetica',
  '5611': 'food',
  '5612': 'food',
  '9313': 'academia',
  '7500': 'pet',
};

function detectCnaeCategory(cnae) {
  if (!cnae) return 'general';
  const code = String(cnae).replace(/\D/g, '');
  if (/^4[67]/.test(code)) return 'icms';
  return 'general';
}

function detectVertical(cnae) {
  if (!cnae) return null;
  const code = String(cnae).replace(/[-\/]/g, '').substring(0, 4);
  for (const [prefix, vertical] of Object.entries(CNAE_VERTICAL_MAP)) {
    const cleanPrefix = prefix.replace(/\D/g, '');
    if (code.startsWith(cleanPrefix)) return vertical;
  }
  return null;
}

function inferRegime(rfData) {
  const porte = rfData.porte?.descricao || '';
  if (porte.includes('MEI') || porte.includes('MICRO EMPREENDEDOR')) return 'mei';
  if (porte.includes('ME') || porte.includes('MICRO EMPRESA')) return 'simples_nacional';
  if (porte.includes('EPP')) return 'simples_nacional';
  return 'simples_nacional';
}

function recommendPlan(regime, hasEmployees, vertical) {
  if (regime === 'mei' && !hasEmployees) {
    return {
      plan: 'essencial', price: 99,
      reason: 'MEI sem funcionário — o Plano Essencial cobre 100% das suas obrigações automaticamente.',
      pitch_points: [
        'DAS-MEI calculado e QR Code gerado automaticamente todo mês',
        'NF-e emitida automaticamente em toda venda para PJ',
        'Controle do limite de R$81k em tempo real',
        'DASN-SIMEI: Aura prepara tudo, você confirma em 5 minutos',
      ],
    };
  }
  if (regime === 'mei' && hasEmployees) {
    return {
      plan: 'negocio', price: 179,
      reason: 'MEI com funcionário — o Plano Negócio inclui folha de pagamento completa.',
      pitch_points: [
        'Folha de pagamento com INSS + FGTS + holerite gerados automaticamente',
        'DAE eSocial gerado junto com a folha',
        '13º salário calculado e alertado automaticamente',
        'CRM completo para gestão de clientes',
      ],
    };
  }
  if (vertical) {
    return {
      plan: 'negocio', price: 179,
      reason: `ME no Simples Nacional com atividade de ${vertical} — Plano Negócio + módulo vertical.`,
      pitch_points: [
        'PGDAS-D: Aura segrega receitas por anexo e pré-preenche o portal',
        'DEFIS: Aura consolida o ano inteiro para você confirmar em 15 minutos',
        `Módulo ${vertical} disponível como add-on por R$69/mês`,
        'Fator R monitorado automaticamente para manter alíquota menor',
      ],
    };
  }
  return {
    plan: 'negocio', price: 179,
    reason: 'ME no Simples Nacional — Plano Negócio cobre todas as obrigações fiscais mensais e anuais.',
    pitch_points: [
      'PGDAS-D: Aura segrega receitas por anexo e pré-preenche o portal',
      'DEFIS: Aura consolida o ano inteiro para você confirmar em 15 minutos',
      'NF-e emitida automaticamente em toda venda para PJ',
      'Fator R monitorado automaticamente para manter alíquota menor',
    ],
  };
}

async function analyzeCNPJ(cnpj) {
  const cleaned = sanitizeCNPJ(cnpj);
  if (!validateCNPJ(cleaned)) throw new Error('CNPJ inválido');

  const response = await fetch(`${RF_API_URL}/${cleaned}`, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });

  if (response.status === 429) throw new Error('Limite de consultas atingido. Aguarde alguns minutos.');
  if (response.status === 404) throw new Error('CNPJ não encontrado na Receita Federal.');
  if (!response.ok) throw new Error(`Erro na consulta à Receita Federal: ${response.status}`);

  const rf = await response.json();

  const cnaeCode     = rf.cnae_fiscal;
  const cnaeDesc     = rf.cnae_fiscal_descricao || '';
  const regime       = inferRegime(rf);
  const cnaeCategory = detectCnaeCategory(cnaeCode);
  const vertical     = detectVertical(cnaeCode);
  const hasEmployees = (rf.qsa?.length > 0) || false;
  const situacao     = rf.situacao_cadastral?.descricao || 'ATIVA';
  const isActive     = situacao === 'ATIVA';

  const recommendation = recommendPlan(regime, hasEmployees, vertical);
  const marketCost = recommendation.plan === 'essencial' ? 239 : 649;
  const savings    = marketCost - recommendation.price;

  return {
    cnpj:     formatCNPJ(cleaned),
    cnpj_raw: cleaned,
    company: {
      name:         rf.razao_social,
      trade_name:   rf.nome_fantasia || null,
      situation:    situacao,
      is_active:    isActive,
      opening_date: rf.data_inicio_atividade,
      porte:        rf.porte?.descricao || null,
    },
    fiscal_profile: {
      cnae_code:          cnaeCode,
      cnae_desc:          cnaeDesc,
      cnae_category:      cnaeCategory,
      regime_inferred:    regime,
      regime_label:       regime === 'mei' ? 'MEI' : 'ME / Simples Nacional',
      has_employees:      hasEmployees,
      vertical_detected:  vertical,
    },
    recommendation: {
      ...recommendation,
      market_cost: marketCost,
      savings:     savings,
      savings_pct: Math.round((savings / marketCost) * 100),
    },
    alerts: [
      !isActive     && '⚠️ CNPJ com situação irregular — verificar antes de fechar contrato',
      cnaeCategory === 'icms' && '📋 Atividade de comércio — verificar Inscrição Estadual',
      vertical     && `🎯 Atividade de ${vertical} detectada — mencionar módulo vertical`,
    ].filter(Boolean),
    consulted_at: new Date().toISOString(),
    source:      'Receita Federal (API pública)',
    disclaimer:  'Regime tributário inferido pelo porte cadastral. Confirmar com o prospect.',
  };
}

module.exports = { analyzeCNPJ };
