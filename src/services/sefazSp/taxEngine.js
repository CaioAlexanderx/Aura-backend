// ============================================================
// AURA. — sefazSp/taxEngine: motor tributário mínimo-viável SP (Simples)
// Roadmap NFC-e própria v1 — S3.2.
//
// ESCOPO DO PILOTO: Simples Nacional (CRT 1) e MEI (CRT 4). Regime
// normal (CRT 3) fica nos gateways (decisão ⚠️ do roadmap).
//
// CSOSN por products.tax_profile (definido com o CONTADOR da piloto):
//   simples_padrao (default/NULL) → 102 (sem permissão de crédito)
//   simples_isento_faixa          → 103 (isenção por faixa de receita)
//   simples_st                    → 500 (ICMS cobrado antes por ST)
//   simples_outros                → 900 (casos especiais)
//
// PIS/COFINS varejo Simples: CST 49 (outras operações de saída) — o
// recolhimento é pelo DAS, não na nota. PARIDADE: o gateway usava
// PISNT/CST 07 e a SEFAZ-SP aceitou (88% de autorização, zero rejeição
// tributária); mantemos 07 por padrão até a REVISÃO DO CONTADOR
// (S3.2: 20 notas de homolog antes da virada). Trocável por env
// NFCE_PIS_COFINS_CST=49.
// ============================================================
'use strict';

const CSOSN_BY_PROFILE = {
  simples_padrao: '102',
  simples_isento_faixa: '103',
  simples_st: '500',
  simples_outros: '900',
};

const VALID_PROFILES = Object.keys(CSOSN_BY_PROFILE);

/** Grupo ICMSSN do XSD por CSOSN (102/103/300/400 compartilham o grupo 102). */
function icmsGroupForCsosn(csosn) {
  if (['102', '103', '300', '400'].includes(csosn)) return 'ICMSSN102';
  if (csosn === '500') return 'ICMSSN500';
  if (csosn === '900') return 'ICMSSN900';
  throw new Error(`taxEngine: CSOSN não suportado no piloto (${csosn})`);
}

/**
 * Resolve a tributação de um item.
 * @param {{ taxProfile?: string|null, crt: number }} p
 * @returns {{ csosn, icmsGroup, orig, pisCst, cofinsCst }}
 */
function resolveItemTax({ taxProfile, crt }) {
  if (crt !== 1 && crt !== 4) {
    throw new Error('taxEngine: piloto cobre apenas Simples Nacional/MEI (CRT 1|4). Regime normal usa o gateway.');
  }
  const profile = taxProfile || 'simples_padrao';
  const csosn = CSOSN_BY_PROFILE[profile];
  if (!csosn) {
    throw new Error(`taxEngine: tax_profile desconhecido ("${taxProfile}"). Válidos: ${VALID_PROFILES.join(', ')}`);
  }
  const pisCofinsCst = process.env.NFCE_PIS_COFINS_CST === '49' ? '49' : '07';
  return {
    csosn,
    icmsGroup: icmsGroupForCsosn(csosn),
    orig: '0',              // nacional — origem por produto chega com o contador (S5)
    pisCst: pisCofinsCst,
    cofinsCst: pisCofinsCst,
  };
}

/**
 * Validação local de NCM (formato). A validação contra a tabela oficial
 * acontece de fato na SEFAZ (rejeição 778, já no catálogo amigável);
 * aqui barramos o que NUNCA passa: formato errado.
 */
function validateNcm(ncm) {
  const clean = String(ncm || '').replace(/\D/g, '');
  if (clean === '00000000') {
    return { valid: true, ncm: clean, warning: 'NCM 00000000 (não classificado) — alta chance de rejeição 778. Defina o NCM real do produto.' };
  }
  if (!/^\d{8}$/.test(clean)) {
    return { valid: false, ncm: clean, error: `NCM "${ncm}" inválido — esperado 8 dígitos` };
  }
  // capítulos válidos: 01–97 (98/99 são usos especiais não aplicáveis a varejo)
  const cap = parseInt(clean.slice(0, 2), 10);
  if (cap < 1 || cap > 97) {
    return { valid: false, ncm: clean, error: `NCM "${clean}" com capítulo inexistente (${clean.slice(0, 2)})` };
  }
  return { valid: true, ncm: clean };
}

module.exports = { resolveItemTax, validateNcm, icmsGroupForCsosn, CSOSN_BY_PROFILE, VALID_PROFILES };
