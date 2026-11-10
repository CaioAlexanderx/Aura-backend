// ============================================================
// AURA. — nfseNacional/errors: erros tipados do emissor nacional
//
// code → status HTTP sugerido para a rota (httpStatusDe). Mensagens em
// português simples: chegam à tela de quem emite.
// ============================================================
'use strict';

class NfseNacionalError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'NfseNacionalError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Falha de transporte com o Sefin/ADN. ambiguous=true: a DPS (ou o evento)
 * PODE ter sido processada — consultar antes de qualquer reenvio, e nunca
 * renumerar.
 */
class NfseNacionalTransportError extends Error {
  constructor(message, { ambiguous = false, httpStatus = null, cause = null } = {}) {
    super(message);
    this.name = 'NfseNacionalTransportError';
    this.ambiguous = ambiguous;
    this.httpStatus = httpStatus;
    if (cause) this.cause = cause;
  }
}

const STATUS_POR_CODIGO = {
  NACIONAL_DESLIGADO: 503,
  PRODUCAO_DESLIGADA: 503,
  NACIONAL_INDISPONIVEL: 503,
  CONFIG_MISSING: 400,
  CONFIG_INACTIVE: 400,
  CONFIG_NAO_APTA: 400,
  CERTIFICADO: 400,
  INVALID_INPUT: 400,
  IDEMPOTENCY_KEY: 400,
  NOT_FOUND: 404,
  ESTADO_INVALIDO: 409,
  REJEITADA: 422,
  ALIQUOTA_RETENCAO_AUSENTE: 400,
  TESTE_TRAVADO: 409,
  NAO_PODE_LIGAR: 409,
  PRODUCAO_NAO_LIBERADA: 409,
  DPS_NUMERO_JA_USADO: 409,
};

function httpStatusDe(code) {
  return STATUS_POR_CODIGO[code] || 502;
}

// ── DPS com série/número já usados por outro emissor (incidente 10/11/2026) ──

const DPS_NUMERO_JA_USADO = 'DPS_NUMERO_JA_USADO';

/** Mensagem para a tela de quem emite. Sem série/número: texto genérico. */
function mensagemDpsNumeroJaUsado(serie, numero) {
  const s = serie != null && String(serie).trim() !== '' ? String(parseInt(String(serie), 10) || serie) : null;
  const n = numero != null && String(numero).trim() !== '' ? String(numero) : null;
  const qual = s && n ? `A série ${s} e o número ${n} da DPS já foram usados` : 'A série e o número desta DPS já foram usados';
  return `${qual} por outro emissor desta empresa. Confira na configuração da NFS-e a Série da DPS e o último Número usado e tente de novo.`;
}

/**
 * A nota morreu por série/número já usados? Vale o error_codes gravado pela
 * Aura e também o rejection_reason começando pelo código (forma da correção
 * manual dos dados do incidente).
 */
function temDpsNumeroJaUsado(nota) {
  if (!nota) return false;
  let cods = nota.error_codes;
  if (typeof cods === 'string') {
    try { cods = JSON.parse(cods); } catch (_) { cods = null; }
  }
  if (Array.isArray(cods) && cods.some((c) => c && c.codigo === DPS_NUMERO_JA_USADO)) return true;
  return String(nota.rejection_reason || '').trim().startsWith(DPS_NUMERO_JA_USADO);
}

module.exports = {
  NfseNacionalError, NfseNacionalTransportError, httpStatusDe,
  DPS_NUMERO_JA_USADO, mensagemDpsNumeroJaUsado, temDpsNumeroJaUsado,
};
