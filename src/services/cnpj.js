// ============================================================
// AURA. — Serviço de CNPJ
// Validação + Lookup real via BrasilAPI (Receita Federal)
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

// ── Detecção de tipo pela natureza jurídica ────────────────────
// Natureza 2135 = MEI — Microempreendedor Individual
function detectRegimeFromNature(legalNatureCode) {
  if (!legalNatureCode) return null;
  const code = String(legalNatureCode).replace(/\D/g,'');
  if (code === '2135') return 'mei';
  return 'simples_nacional'; // padrão para demais PJ pequenas
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

// ── Lookup BrasilAPI (Receita Federal) ────────────────────────
// https://brasilapi.com.br/api/cnpj/v1/:cnpj
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
  const cacheKey = `cnpj:rf:${cleaned}`;
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return { ...JSON.parse(cached), _from_cache: true };
    } catch (_) {}
  }

  const { status, body } = await _httpGet(
    `https://brasilapi.com.br/api/cnpj/v1/${cleaned}`
  );

  if (status !== 200) {
    throw new Error(
      status === 404 ? 'CNPJ não encontrado na Receita Federal' :
      status === 429 ? 'Limite de consultas atingido. Tente novamente em alguns minutos.' :
      `Erro na consulta RF (status ${status})`
    );
  }

  const rf = body;

  // Normaliza para o formato interno da Aura
  const cnaeCode  = rf.cnae_fiscal?.toString() || '';
  const natCode   = rf.natureza_juridica?.toString().replace(/\D/g,'') || '';

  const result = {
    cnpj:               formatCNPJ(cleaned),
    cnpj_raw:           cleaned,
    legal_name:         rf.razao_social || '',
    trade_name:         rf.nome_fantasia || '',
    legal_nature:       rf.descricao_natureza_juridica || '',
    legal_nature_code:  natCode,
    company_size:       rf.porte || '',
    rf_situation:       rf.descricao_situacao_cadastral || '',
    opening_date:       rf.data_inicio_atividade || null,
    email:              rf.email ? rf.email.toLowerCase() : '',
    phone:              rf.ddd_telefone_1 ? `(${rf.ddd_telefone_1}) ${rf.telefone_1||''}`.trim() : '',
    // Endereço
    address_street:     rf.logradouro    || '',
    address_number:     rf.numero        || '',
    address_complement: rf.complemento   || '',
    address_district:   rf.bairro        || '',
    address_city:       rf.municipio     || '',
    address_state:      rf.uf            || '',
    address_zip:        rf.cep           ? rf.cep.replace(/\D/g,'') : '',
    // CNAEs
    cnae_principal: {
      code:        cnaeCode,
      description: rf.cnae_fiscal_descricao || '',
    },
    cnaes_secundarios: (rf.cnaes_secundarios || []).map(c => ({
      code:        c.codigo?.toString() || '',
      description: c.descricao || '',
    })),
    // Detecções automáticas
    suggested_regime:   detectRegimeFromNature(natCode),
    suggested_vertical: detectVerticalFromCNAE(cnaeCode),
    is_mei:             natCode === '2135',
    is_active:          (rf.descricao_situacao_cadastral || '').toUpperCase() === 'ATIVA',
  };

  // Cache 24h
  if (redis) {
    try { await redis.setex(cacheKey, 86400, JSON.stringify(result)); } catch (_) {}
  }

  return result;
}

module.exports = {
  sanitizeCNPJ,
  validateCNPJ,
  formatCNPJ,
  detectRegimeFromNature,
  detectVerticalFromCNAE,
  lookupCNPJ,
};
