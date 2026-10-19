// ============================================================
// AURA. — Serviço de CNPJ
// Validação + Lookup real: cnpj.ws, com CNPJá aberta e BrasilAPI de reserva
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

// ── Consulta à Receita: cnpj.ws → CNPJá aberta → BrasilAPI ───
// INC-2026-10-19-03: o cnpj.ws parou de responder e, como era a única
// fonte, o cadastro travava em "CNPJ lookup timeout" (500 após 8,5 s).
// Agora o cnpj.ws continua primeiro; em timeout, erro de rede, 429 ou 5xx
// cai no CNPJá aberto (sem chave, poucas consultas por minuto por IP) e,
// por último, na BrasilAPI. 404 de qualquer fonte é "não encontrado" e não
// consulta a próxima. Prazos somados (8,5 s) cabem no abort de 10 s do app.
const FONTE_TIMEOUT_MS = { 'cnpj.ws': 3000, cnpja: 3000, brasilapi: 2500 };

function _httpGet(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const req = https.get(url, { headers: { 'User-Agent': 'Aura-Backend/1.0', Accept: 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('error', (e) => finish(reject, e));
      res.on('end', () => {
        try { finish(resolve, { status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { finish(resolve, { status: res.statusCode, body: data }); }
      });
    });
    req.on('error', (e) => finish(reject, e));
    // Prazo total (não só ociosidade do socket): resposta lenta também corta.
    timer = setTimeout(() => {
      finish(reject, new Error('CNPJ lookup timeout'));
      try { req.destroy(); } catch (_) {}
    }, timeoutMs);
  });
}

const _sim = (v) => String(v || '').trim().toLowerCase() === 'sim';
const _digitos = (v) => String(v == null ? '' : v).replace(/\D/g, '');
// CNAE numérico (CNPJá/BrasilAPI: 600001) → 7 dígitos como o cnpj.ws ("0600-0/01" → "0600001").
const _cnae = (v) => { const d = _digitos(v); return d ? d.padStart(7, '0') : ''; };
// Booleano de opção → o formato 'Sim'/'Não' do bloco `simples` do cnpj.ws.
// Ausente/nulo fica null: regimeDaReceita então cai na heurística de porte
// (fonte 'estimado', confirmar: true) em vez de afirmar um regime.
const _simNao = (v) => (v === true ? 'Sim' : v === false ? 'Não' : null);

function _montar(cleaned, campos, regimeRf, fonte) {
  const regime = regimeDaReceita(regimeRf);
  const blocoSimples = regimeRf.simples || null;
  return {
    cnpj:               formatCNPJ(cleaned),
    cnpj_raw:           cleaned,
    ...campos,
    // Detecções automáticas
    suggested_regime:   regime.regime,
    regime_fonte:       regime.fonte,
    regime_confirmar:   regime.confirmar,
    simples_optante:    _sim(blocoSimples && blocoSimples.simples),
    mei_optante:        _sim(blocoSimples && blocoSimples.mei),
    suggested_vertical: detectVerticalFromCNAE(campos.cnae_principal.code),
    is_mei:             _sim(blocoSimples && blocoSimples.mei),
    is_active:          String(campos.rf_situation || '').toUpperCase() === 'ATIVA',
    rf_fonte:           fonte,
  };
}

// cnpj.ws — formato original (o de antes do INC-2026-10-19-03).
function _deCnpjWs(rf, cleaned) {
  const est = rf.estabelecimento || {};
  const cnaeCode = (est.atividade_principal?.subclasse || '').replace(/\D/g, '');
  return _montar(cleaned, {
    legal_name:         rf.razao_social              || '',
    trade_name:         est.nome_fantasia             || '',
    legal_nature:       rf.natureza_juridica?.descricao || '',
    legal_nature_code:  (rf.natureza_juridica?.id || '').replace(/\D/g, ''),
    company_size:       rf.porte?.descricao           || '',
    rf_situation:       est.situacao_cadastral        || '',
    opening_date:       est.data_inicio_atividade     || null,
    email:              est.email ? est.email.toLowerCase() : '',
    phone:              est.ddd1 && est.telefone1 ? `(${est.ddd1}) ${est.telefone1}` : '',
    address_street:     est.logradouro    || '',
    address_number:     est.numero        || '',
    address_complement: est.complemento   || '',
    address_district:   est.bairro        || '',
    address_city:       est.cidade?.nome  || '',
    address_state:      est.estado?.sigla || '',
    address_zip:        est.cep ? est.cep.replace(/\D/g, '') : '',
    cnae_principal: { code: cnaeCode, description: est.atividade_principal?.descricao || '' },
    cnaes_secundarios: (est.atividades_secundarias || []).map(c => ({
      code:        (c.subclasse || '').replace(/\D/g, ''),
      description: c.descricao || '',
    })),
  }, rf, 'cnpj.ws');
}

// CNPJá aberta (open.cnpja.com/office/:cnpj), conferido com 33000167000101:
//   razao_social ← company.name · nome_fantasia ← alias · natureza ← company.nature {id,text}
//   porte ← company.size.text · situação ← status.text ("Ativa") · abertura ← founded
//   e-mail ← emails[0].address · telefone ← phones[0] {area,number}
//   endereço ← address {street,number,details,district,city,state,zip}
//   CNAE ← mainActivity/sideActivities {id,text} · regime ← company.simples.optant /
//   company.simei.optant (booleanos), a mesma regra do bloco simples do cnpj.ws.
//   company.members (sócios) não é lido.
function _deCnpja(o, cleaned) {
  const co = o.company || {};
  const ad = o.address || {};
  const tel = Array.isArray(o.phones) && o.phones[0];
  const mail = Array.isArray(o.emails) && o.emails[0] && o.emails[0].address;
  const simples = { simples: _simNao(co.simples && co.simples.optant), mei: _simNao(co.simei && co.simei.optant) };
  return _montar(cleaned, {
    legal_name:         co.name || '',
    trade_name:         o.alias || '',
    legal_nature:       (co.nature && co.nature.text) || '',
    legal_nature_code:  _digitos(co.nature && co.nature.id),
    company_size:       (co.size && co.size.text) || '',
    rf_situation:       (o.status && o.status.text) || '',
    opening_date:       o.founded || null,
    email:              mail ? String(mail).toLowerCase() : '',
    phone:              tel && tel.area && tel.number ? `(${tel.area}) ${tel.number}` : '',
    address_street:     ad.street   || '',
    address_number:     ad.number   || '',
    address_complement: ad.details  || '',
    address_district:   ad.district || '',
    address_city:       ad.city     || '',
    address_state:      ad.state    || '',
    address_zip:        _digitos(ad.zip),
    cnae_principal: { code: _cnae(o.mainActivity && o.mainActivity.id), description: (o.mainActivity && o.mainActivity.text) || '' },
    cnaes_secundarios: (o.sideActivities || []).map(c => ({ code: _cnae(c.id), description: c.text || '' })),
  }, {
    simples: simples.simples || simples.mei ? simples : null,
    porte: { descricao: (co.size && co.size.text) || '' },
  }, 'cnpja');
}

// BrasilAPI (brasilapi.com.br/api/cnpj/v1/:cnpj), conferido com 33000167000101:
//   razao_social, nome_fantasia, natureza_juridica (texto) + codigo_natureza_juridica,
//   porte ("DEMAIS", "MICRO EMPRESA"), descricao_situacao_cadastral ("ATIVA"),
//   data_inicio_atividade, email, ddd_telefone_1 ("2121660000" = DDD + número),
//   logradouro/numero/complemento/bairro/municipio/uf/cep, cnae_fiscal + descrição,
//   cnaes_secundarios {codigo,descricao}. Regime ← opcao_pelo_simples /
//   opcao_pelo_mei (true/false/null; null = sem registro → heurística de porte,
//   como o cnpj.ws sem bloco). As datas de exclusão não entram, como no #805.
//   qsa (sócios) não é lido.
function _deBrasilApi(b, cleaned) {
  const tel = _digitos(b.ddd_telefone_1);
  const simples = { simples: _simNao(b.opcao_pelo_simples), mei: _simNao(b.opcao_pelo_mei) };
  return _montar(cleaned, {
    legal_name:         b.razao_social || '',
    trade_name:         b.nome_fantasia || '',
    legal_nature:       b.natureza_juridica || '',
    legal_nature_code:  _digitos(b.codigo_natureza_juridica),
    company_size:       b.porte || '',
    rf_situation:       b.descricao_situacao_cadastral || '',
    opening_date:       b.data_inicio_atividade || null,
    email:              b.email ? String(b.email).toLowerCase() : '',
    phone:              tel.length >= 10 ? `(${tel.slice(0, 2)}) ${tel.slice(2)}` : '',
    address_street:     b.logradouro  || '',
    address_number:     b.numero      || '',
    address_complement: b.complemento || '',
    address_district:   b.bairro      || '',
    address_city:       b.municipio   || '',
    address_state:      b.uf          || '',
    address_zip:        _digitos(b.cep),
    cnae_principal: { code: _cnae(b.cnae_fiscal), description: b.cnae_fiscal_descricao || '' },
    cnaes_secundarios: (b.cnaes_secundarios || [])
      .filter(c => c && Number(c.codigo))
      .map(c => ({ code: _cnae(c.codigo), description: c.descricao || '' })),
  }, {
    simples: simples.simples || simples.mei ? simples : null,
    porte: { descricao: b.porte || '' },
  }, 'brasilapi');
}

const FONTES = [
  { nome: 'cnpj.ws',   url: (c) => `https://publica.cnpj.ws/cnpj/${c}`,          converter: _deCnpjWs },
  { nome: 'cnpja',     url: (c) => `https://open.cnpja.com/office/${c}`,         converter: _deCnpja },
  { nome: 'brasilapi', url: (c) => `https://brasilapi.com.br/api/cnpj/v1/${c}`,  converter: _deBrasilApi },
];

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

  // Só o motivo de cada falha vai ao log: nada de sócio nem dado da empresa.
  const falhas = [];
  let result = null;
  for (const fonte of FONTES) {
    let resp;
    try {
      resp = await _httpGet(fonte.url(cleaned), FONTE_TIMEOUT_MS[fonte.nome]);
    } catch (e) {
      falhas.push(`${fonte.nome}: ${e && e.message ? e.message : 'erro de rede'}`);
      continue;
    }
    if (resp.status === 404) throw new Error('CNPJ não encontrado na Receita Federal');
    if (resp.status !== 200 || !resp.body || typeof resp.body !== 'object') {
      falhas.push(`${fonte.nome}: status ${resp.status}`);
      continue;
    }
    try {
      result = fonte.converter(resp.body, cleaned);
    } catch (e) {
      falhas.push(`${fonte.nome}: resposta inesperada`);
      continue;
    }
    if (fonte.nome !== 'cnpj.ws') {
      console.warn(`[cnpj] consulta respondida por ${fonte.nome} (${falhas.join('; ')})`);
    }
    break;
  }

  if (!result) {
    console.error(`[cnpj] nenhuma fonte respondeu (${falhas.join('; ')})`);
    const err = new Error('Não conseguimos consultar a Receita agora. Tente de novo em alguns minutos.');
    err.status = 503;
    err.code = 'CNPJ_FONTES_INDISPONIVEIS';
    throw err;
  }

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
  FONTE_TIMEOUT_MS,
};
