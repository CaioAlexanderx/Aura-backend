// ============================================================
// AURA. — Aura Notas / Gestão (STAFF): validadores + normalizadores puros
// Roadmap NFC-e própria v1 — painel interno de gestão fiscal (Gestão Aura),
// que substitui o antigo painel da Nuvem Fiscal.
//
// Só funções PURAS (sem db, sem I/O) → 100% testáveis em unit sem supertest.
// A rota (routes/adminAuraNotas.js) importa e compõe estas peças.
// ============================================================
'use strict';

// Whitelist de regime tributário (espelha routes/company.js).
const TAX_REGIMES = ['mei', 'simples', 'simples_nacional', 'lucro_presumido', 'lucro_real', 'pessoa_fisica'];

// Providers aceitos no seletor do painel. 'auto' é açúcar de UI → NULL no banco
// (NULL = modo AUTO: engine quando apta, senão gateway — ver routes/nfce.js).
const PROVIDER_INPUTS = [null, 'auto', 'sefaz_sp', 'nuvemfiscal'];

/** true se a string contém SÓ dígitos (não-vazia). */
function isDigits(v) {
  return typeof v === 'string' && /^[0-9]+$/.test(v);
}

/**
 * Normaliza o provider recebido do painel para o valor de banco.
 * @returns {{ ok:true, value:(null|'sefaz_sp'|'nuvemfiscal'|undefined) } | { ok:false, error:string }}
 * 'auto' e null -> NULL (modo AUTO). undefined -> não mexe. Fora da whitelist -> erro.
 */
function normalizeProvider(input) {
  if (input === undefined) return { ok: true, value: undefined }; // não mexe
  if (input === null || input === 'auto') return { ok: true, value: null };
  if (input === 'sefaz_sp' || input === 'nuvemfiscal') return { ok: true, value: input };
  return { ok: false, error: "provider inválido (use 'auto', 'sefaz_sp' ou 'nuvemfiscal')" };
}

/** Valida Inscrição Estadual: só dígitos (ou 'ISENTO'). Aceita null/'' (limpa). */
function validateInscricaoEstadual(v) {
  if (v === undefined) return { ok: true, value: undefined };
  if (v === null || v === '') return { ok: true, value: null };
  const s = String(v).trim();
  if (s.toUpperCase() === 'ISENTO') return { ok: true, value: 'ISENTO' };
  if (!isDigits(s)) return { ok: false, error: 'Inscrição Estadual deve conter apenas dígitos (ou ISENTO)' };
  return { ok: true, value: s };
}

/** Valida CEP: 8 dígitos. Aceita null/'' (limpa). */
function validateCep(v) {
  if (v === undefined) return { ok: true, value: undefined };
  if (v === null || v === '') return { ok: true, value: null };
  const s = String(v).replace(/\D/g, '');
  if (!isDigits(s) || s.length !== 8) return { ok: false, error: 'CEP inválido (8 dígitos)' };
  return { ok: true, value: s };
}

/** Valida código IBGE do município: 7 dígitos. Aceita null/'' (limpa). */
function validateIbge(v) {
  if (v === undefined) return { ok: true, value: undefined };
  if (v === null || v === '') return { ok: true, value: null };
  const s = String(v).trim();
  if (!isDigits(s) || s.length !== 7) return { ok: false, error: 'Código IBGE inválido (7 dígitos)' };
  return { ok: true, value: s };
}

/** Valida regime tributário contra a whitelist. Aceita null/'' (limpa). */
function validateTaxRegime(v) {
  if (v === undefined) return { ok: true, value: undefined };
  if (v === null || v === '') return { ok: true, value: null };
  if (!TAX_REGIMES.includes(v)) return { ok: false, error: 'Regime tributário inválido' };
  return { ok: true, value: v };
}

/** Valida ambiente NFC-e. */
function validateAmbiente(v) {
  if (v === undefined) return { ok: true, value: undefined };
  if (v !== 'producao' && v !== 'homologacao') {
    return { ok: false, error: "ambiente inválido (use 'producao' ou 'homologacao')" };
  }
  return { ok: true, value: v };
}

/** Valida UF: 2 letras. */
function validateUf(v) {
  if (v === undefined) return { ok: true, value: undefined };
  const s = String(v || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(s)) return { ok: false, error: 'UF inválida (2 letras)' };
  return { ok: true, value: s };
}

/** Valida série da emissão própria (inteiro 1–999). */
function validateSerieSefazSp(v) {
  if (v === undefined) return { ok: true, value: undefined };
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1 || n > 999) {
    return { ok: false, error: 'serie_sefaz_sp inválida (inteiro 1–999)' };
  }
  return { ok: true, value: n };
}

/**
 * Valida o CSC ID (idToken): numérico, até 6 dígitos (padrão SEFAZ).
 * Obrigatório (não aceita vazio) — a rota /csc grava id+token juntos.
 */
function validateCscId(v) {
  const s = String(v == null ? '' : v).trim();
  if (!isDigits(s) || s.length < 1 || s.length > 6) {
    return { ok: false, error: 'csc_id inválido (numérico, até 6 dígitos)' };
  }
  return { ok: true, value: s };
}

/** Valida o CSC token: 36 caracteres alfanuméricos (código de segurança do contribuinte). */
function validateCscToken(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^[A-Za-z0-9]{36}$/.test(s)) {
    return { ok: false, error: 'csc_token inválido (36 caracteres alfanuméricos)' };
  }
  return { ok: true, value: s };
}

/**
 * Replica a lógica do modo AUTO de routes/nfce.js (NFC-e) para exibição no
 * painel: qual provedor a emissão vai USAR em regime normal (ignorando o
 * breaker, que é transitório e reportado à parte).
 *   provider='nuvemfiscal' -> gateway (kill-switch);
 *   provider='sefaz_sp'    -> engine (forçado);
 *   NULL/auto              -> engine SE apta (A1 vigente + CSC), senão gateway.
 * @param {string|null} provider  valor de nfce_config.provider
 * @param {boolean} engineCapable A1 vigente salvo + CSC configurado
 * @returns {'sefaz_sp'|'nuvemfiscal'}
 */
function providerEfetivo(provider, engineCapable) {
  const wantSefaz = provider !== 'nuvemfiscal' && (provider === 'sefaz_sp' || !!engineCapable);
  return wantSefaz ? 'sefaz_sp' : 'nuvemfiscal';
}

/** csc_ok = CSC configurado (id + algum token, cifrado ou legado em claro). */
function cscOk(config) {
  return !!(config && config.csc_id && (config.csc_token_enc || config.csc_token));
}

/**
 * engine_capable = apta a emitir pela engine própria: CSC configurado E
 * certificado A1 vigente (not_after no futuro). Espelha engineCapable() de
 * routes/nfce.js (que também consulta company_certificates).
 */
function engineCapable(config, certValid) {
  return cscOk(config) && !!certValid;
}

/** Dias restantes até not_after (arredondado pra baixo). null se sem data. */
function daysLeft(notAfter, now) {
  if (!notAfter) return null;
  const end = new Date(notAfter).getTime();
  const ref = (now ? new Date(now) : new Date()).getTime();
  return Math.floor((end - ref) / 86400000);
}

module.exports = {
  TAX_REGIMES, PROVIDER_INPUTS,
  isDigits, normalizeProvider,
  validateInscricaoEstadual, validateCep, validateIbge, validateTaxRegime,
  validateAmbiente, validateUf, validateSerieSefazSp,
  validateCscId, validateCscToken,
  providerEfetivo, cscOk, engineCapable, daysLeft,
};
