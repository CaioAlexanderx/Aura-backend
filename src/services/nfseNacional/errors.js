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
};

function httpStatusDe(code) {
  return STATUS_POR_CODIGO[code] || 502;
}

module.exports = { NfseNacionalError, NfseNacionalTransportError, httpStatusDe };
