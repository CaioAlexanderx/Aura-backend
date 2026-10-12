// ============================================================
// AURA. — Serviço de CNPJ
// Validação + Lookup real via cnpj.ws (Receita Federal)
// Rate limit: 10 req/hora por empresa (Redis) + cache 24h
// ============================================================
const https = require('https');

// ── Validação ─────────────────────────────────────────────────
function sanitizeCNPJ(cnpj) {
  return String(cnpj).replace(/\D/g, '');
}

function validateCNPJ(cnpj) {
  const c = sanitizeCNPJ(cnpj);
  if (c.length !== 14) return false;
  if (/^(\d)\1+$/.test(c)) return false;
  const calc = (len) => {
    const w = len === 12
      ? [5,4,3,2,9,8,7,6,5,4,3,2]
      : [6,5,4,3,2,9,8,7,6,5,4,3,2];
    const s = c.slice(0,len).split('').reduce((a,d,i) => a + parseInt(d)*w[i], 0);
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return parseInt(c[12]) === calc(12) && parseInt(c[13]) === calc(13);
}

function formatCNPJ(cnpj) {
  const c = sanitizeCNPJ(cnpj);
  if (c.length !== 14) return cnpj;
  return c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

// ── Regime tributário pela Receita ─────────────────────────────
// 12/10/2026: até aqui o regime vinha da natureza jurídica — 2135 virava
// "mei" e todo o resto "simples_nacional". Dois erros: 2135 é "Empresário
// (Individual)", que inclui EI no Simples e fora dele (Luciano Messias
// ficou "mei" sendo Simples), e LTDA fora do Simples virava Simples
// (Sheid Mania, Infortech, Pefect House). Clientes reclamaram.
//
// O cnpj.ws devolve o bloco `simples` ({ simples: 'Sim'|'Não', mei:
// 'Sim'|'Não', datas }). É a fonte: MEI é optante do SIMEI; Simples é
// optante do Simples; fora do Simples a Receita não diz se é Presumido ou
// Real — sugerimos Presumido e marcamos `regime_confirmar` para a tela
// pedir confirmação. Sem o bloco, cai na heurística de porte.
function regimeDaReceita(rf) {
  const simples = rf && rf.simples ? rf.simples : null;
  const sim = (v) => String(v || '').trim().toLowerCase() === 'sim';
  const nao = (v) => String(v || '').trim().toLowerCase() === 'não' || String(v || '').trim().toLowerCase() === 'nao';
  if (simples && (sim(simples.mei) || sim(simples.simples) || nao(simples.simples))) {
    if (sim(simples.mei)) return { regime: 'mei', fonte: 'receita', confirmar: false };
    if (sim(simples.simples)) return { regime: 'simples_nacional', fonte: 'receita', confirmar: false };
    return { regime: 'lucro_presumido', fonte: 'receita', confirmar: true };
  }
  const porte = String((rf && rf.porte && rf.porte.descricao) || '').toUpperCase();
  if (porte === 'DEMAIS') return { regime: 'lucro_presumido', fonte: 'estimado', confirmar: true };
  return { regime: 'simples_nacional', fonte: 'estimado', confirmar: true };
}

// Detecta vertical sugerido pelo CNAE principal
function detectVerticalFromCNAE(cnaePrincipal) {
  if (!cnaePrincipal) return null;
  const code = String(cnaePrincipal).replace(/\D/g,'').slice(0,4);
  const map = {
    '8630': 'odonto',   '8621': 'odonto',  // atividades de saúde
    '9602': 'salao',    '9609': 'salao',    // cabeleireiros, estética
    '9601': 'lavanderia',
    '8011': null, // segurança
    '5611': 'food',     '5612': 'food',     // restaurantes, lanchonetes
    '5620': 'food',
    '4711': null, '4712': null,             // comércio varejista geral
    '9313': 'academia', '9319': 'academia', // atividades esportivas
    '4789': null, '4771': null,             // varejo
    '7500': 'pet',                          // atividades veterinárias
  };
  return map[code] || null;
}

// ── Lookup cnpj.ws (Receita Federal) ─────────────────────────
// https://publica.cnpj.ws/cnpj/:cnpj
function _httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Aura-Backend/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('CNPJ lookup timeout')); });
  });
}

async function lookupCNPJ(cnpj, redis) {
  const cleaned = sanitizeCNPJ(cnpj);
  if (!validateCNPJ(cleaned)) throw new Error('CNPJ inválido');

  // Cache Redis 24h
  const cacheKey = `cnpj:ws:v2:${cleaned}`; // v2 (12/10/2026): regime pela Receita
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return { ...JSON.parse(cached), _from_cache: true };
    } catch (_) {}
  }

  const { status, body } = await _httpGet(
    `https://publica.cnpj.ws/cnpj/${cleaned}`
  );

  if (status !== 200) {
    throw new Error(
      status === 404 ? 'CNPJ não encontrado na Receita Federal' :
      status === 429 ? 'Limite de consultas atingido. Tente novamente em alguns minutos.' :
      `Erro na consulta RF (status ${status})`
    );
  }

  const rf  = body;
  const est = rf.estabelecimento || {};
  const sim = (v) => String(v || '').trim().toLowerCase() === 'sim';

  // Códigos normalizados
  const cnaeCode = (est.atividade_principal?.subclasse || '').replace(/\D/g, '');
  const natCode  = (rf.natureza_juridica?.id            || '').replace(/\D/g, '');

  // Telefone
  const phone = est.ddd1 && est.telefone1
    ? `(${est.ddd1}) ${est.telefone1}`
    : '';

  const result = {
    cnpj:               formatCNPJ(cleaned),
    cnpj_raw:           cleaned,
    legal_name:         rf.razao_social              || '',
    trade_name:         est.nome_fantasia             || '',
    legal_nature:       rf.natureza_juridica?.descricao || '',
    legal_nature_code:  natCode,
    company_size:       rf.porte?.descricao           || '',
    rf_situation:       est.situacao_cadastral        || '',
    opening_date:       est.data_inicio_atividade     || null,
    email:              est.email ? est.email.toLowerCase() : '',
    phone,
    // Endereço
    address_street:     est.logradouro    || '',
    address_number:     est.numero        || '',
    address_complement: est.complemento   || '',
    address_district:   est.bairro        || '',
    address_city:       est.cidade?.nome  || '',
    address_state:      est.estado?.sigla || '',
    address_zip:        est.cep ? est.cep.replace(/\D/g,'') : '',
    // CNAEs
    cnae_principal: {
      code:        cnaeCode,
      description: est.atividade_principal?.descricao || '',
    },
    cnaes_secundarios: (est.atividades_secundarias || []).map(c => ({
      code:        (c.subclasse || '').replace(/\D/g,''),
      description: c.descricao || '',
    })),
    // Detecções automáticas
    suggested_regime:   regimeDaReceita(rf).regime,
    regime_fonte:       regimeDaReceita(rf).fonte,
    regime_confirmar:   regimeDaReceita(rf).confirmar,
    simples_optante:    sim(rf.simples && rf.simples.simples),
    mei_optante:        sim(rf.simples && rf.simples.mei),
    suggested_vertical: detectVerticalFromCNAE(cnaeCode),
    is_mei:             sim(rf.simples && rf.simples.mei),
    is_active:          (est.situacao_cadastral || '').toUpperCase() === 'ATIVA',
  };

  // Cache 24h
  if (redis) {
    try { await redis.setex(cacheKey, 86400, JSON.stringify(result)); } catch (_) {}
  }

  return result;
}

module.exports = {
  regimeDaReceita,
  sanitizeCNPJ,
  validateCNPJ,
  formatCNPJ,
  detectVerticalFromCNAE,
  lookupCNPJ,
};
