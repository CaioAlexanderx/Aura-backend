// ============================================================
// AURA. — W2-03 F2: NFS-e Provider Service (Adapter Pattern)
//
// Abstrai a comunicacao com providers externos de NFS-e:
//   - Nuvem Fiscal (https://api.nuvemfiscal.com.br) — funcional
//   - Norte Notas — placeholder pra plug futuro
//   - Mock — pra dev/testing
//
// Cada adapter implementa a mesma interface NfseProvider:
//   emit(invoiceData)    -> { provider_id, status, ... }
//   consult(providerId)  -> { status, nfse_number, pdf_url, xml_url }
//   cancel(providerId, reason) -> { ok }
//
// Use getProvider(config) pra obter o adapter certo dinamicamente
// baseado no nfse_config.provider da empresa.
//
// IMPORTANTE: este service NAO acessa o DB direto. Recebe e retorna
// dados puros. As rotas em dentalNfse.js (proximo commit) que fazem
// a persistencia.
// ============================================================

// ─────────────────────────────────────────────────────────
// Erros tipados pra facilitar tratamento upstream
// ─────────────────────────────────────────────────────────

class NfseProviderError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'NfseProviderError';
    this.code = code;
    this.details = details;
  }
}

// ─────────────────────────────────────────────────────────
// Helpers comuns
// ─────────────────────────────────────────────────────────

function onlyDigits(s) {
  return (s || '').toString().replace(/\D/g, '');
}

function fmtMoney(v) {
  return parseFloat(v || 0).toFixed(2);
}

function todayBR() {
  return new Date().toISOString().substring(0, 10);
}

// ─────────────────────────────────────────────────────────
// 1. NuvemFiscalProvider
//
// API: https://api.nuvemfiscal.com.br
// Docs: https://dev.nuvemfiscal.com.br/docs/api
//
// Auth: Bearer token (api_key_encrypted decifrada antes)
//
// Endpoints chave:
//   POST   /v2/nfse                     emite
//   GET    /v2/nfse/{id}                consulta
//   GET    /v2/nfse/{id}/pdf            retorna PDF
//   POST   /v2/nfse/{id}/cancelamento   cancela
// ─────────────────────────────────────────────────────────

class NuvemFiscalProvider {
  constructor(config) {
    this.config = config;
    this.apiKey = config.apiKey; // ja decifrada por upstream
    this.ambiente = config.ambiente || 'homologacao';
    // Em homologacao a Nuvem Fiscal retorna NFS-e simuladas
    this.baseUrl = 'https://api.nuvemfiscal.com.br';
  }

  async _request(method, path, body) {
    if (!this.apiKey) {
      throw new NfseProviderError(
        'Nuvem Fiscal API key nao configurada',
        'CONFIG_MISSING'
      );
    }

    const url = `${this.baseUrl}${path}`;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 30000) : null;

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller?.signal,
      });
      if (timer) clearTimeout(timer);

      const isJson = (response.headers.get('content-type') || '').includes('application/json');
      const data = isJson ? await response.json().catch(() => ({})) : null;

      if (!response.ok) {
        throw new NfseProviderError(
          data?.message || `Nuvem Fiscal HTTP ${response.status}`,
          data?.error || `HTTP_${response.status}`,
          data
        );
      }

      return data;
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (err instanceof NfseProviderError) throw err;
      if (err.name === 'AbortError') {
        throw new NfseProviderError('Timeout na Nuvem Fiscal (>30s)', 'TIMEOUT');
      }
      throw new NfseProviderError(
        err.message || 'Erro de rede ao contatar Nuvem Fiscal',
        'NETWORK_ERROR'
      );
    }
  }

  // Mapeia o payload interno Aura pro formato Nuvem Fiscal v2
  _buildPayload(invoiceData) {
    const {
      company,        // { cnpj, legal_name, address_*, inscricao_municipal, regime_tributario }
      config,         // nfse_config completo
      rps_number,
      rps_serie,
      service_code,
      service_description,
      service_amount,
      iss_rate,
      iss_value,
      iss_retained,
      deductions,
      recipient,      // { type, name, doc, email, phone, address }
      competence_date,
    } = invoiceData;

    return {
      // Provedor (a clinica que emite)
      provedor: {
        cpf_cnpj: onlyDigits(company.cnpj),
        inscricao_municipal: config.inscricao_municipal || undefined,
      },
      // RPS
      referencia: `AURA-${rps_serie}-${rps_number}`,
      ambiente: this.ambiente,
      infDPS: {
        tpAmb: this.ambiente === 'producao' ? 1 : 2,
        dhEmi: new Date().toISOString(),
        verAplic: 'aura-1.0',
        serie: rps_serie,
        nDPS: String(rps_number),
        dCompet: competence_date || todayBR(),

        prest: {
          CNPJ: onlyDigits(company.cnpj),
          IM: config.inscricao_municipal,
          regTrib: {
            opSimpNac: config.optante_simples_nacional ? '1' : '2',
            regEspTrib: this._mapRegimeEspecial(config.regime_especial),
          },
        },

        toma: {
          [recipient.type === 'pj' ? 'CNPJ' : 'CPF']: onlyDigits(recipient.doc),
          xNome: recipient.name,
          email: recipient.email || undefined,
          fone: onlyDigits(recipient.phone) || undefined,
          end: recipient.address ? {
            xLgr:    recipient.address.logradouro,
            nro:     recipient.address.numero,
            xCpl:    recipient.address.complemento || undefined,
            xBairro: recipient.address.bairro,
            cMun:    recipient.address.codigo_municipio,
            xMun:    recipient.address.municipio,
            UF:      recipient.address.uf,
            CEP:     onlyDigits(recipient.address.cep),
          } : undefined,
        },

        serv: {
          locPrest: {
            cLocPrestacao: company.codigo_municipio || undefined,
          },
          cServ: {
            cTribNac:   service_code,
            xDescServ:  service_description,
            cNBS:       service_code,
          },
        },

        valores: {
          vServPrest: { vServ: fmtMoney(service_amount) },
          vDescIncond: '0.00',
          vDescCond: '0.00',
          trib: {
            tribMun: {
              tribISSQN: iss_retained ? '2' : '1',
              pAliq: fmtMoney(iss_rate),
            },
            totTrib: {
              vTotTrib: fmtMoney(iss_value),
            },
          },
        },
      },
    };
  }

  _mapRegimeEspecial(regime) {
    const map = {
      micro_empresa_municipal:    '1',
      estimativa:                 '2',
      sociedade_profissional:     '3',
      cooperativa:                '4',
      mei:                        '6',
      me_epp_simples_nacional:    '5',
    };
    return map[regime] || undefined;
  }

  async emit(invoiceData) {
    const payload = this._buildPayload(invoiceData);
    const data = await this._request('POST', '/v2/nfse', payload);

    return {
      provider:         'nuvem_fiscal',
      provider_id:      data.id,
      status:           this._mapStatus(data.status),
      nfse_number:      data.numero || null,
      verification_code: data.codigo_verificacao || null,
      pdf_url:          data.pdf?.url || null,
      xml_url:          data.xml?.url || null,
      issued_at:        data.data_emissao || null,
      raw_response:     data,
    };
  }

  async consult(providerId) {
    if (!providerId) {
      throw new NfseProviderError('provider_id obrigatorio', 'INVALID_INPUT');
    }
    const data = await this._request('GET', `/v2/nfse/${providerId}`);

    return {
      status:           this._mapStatus(data.status),
      nfse_number:      data.numero || null,
      verification_code: data.codigo_verificacao || null,
      pdf_url:          data.pdf?.url || null,
      xml_url:          data.xml?.url || null,
      issued_at:        data.data_emissao || null,
      rejection_reason: data.mensagem_retorno || null,
      raw_response:     data,
    };
  }

  async cancel(providerId, reason) {
    if (!providerId) {
      throw new NfseProviderError('provider_id obrigatorio', 'INVALID_INPUT');
    }
    if (!reason || reason.length < 15) {
      throw new NfseProviderError(
        'Motivo de cancelamento muito curto (min 15 caracteres)',
        'INVALID_INPUT'
      );
    }

    const data = await this._request(
      'POST',
      `/v2/nfse/${providerId}/cancelamento`,
      { justificativa: reason }
    );
    return { ok: true, raw_response: data };
  }

  _mapStatus(status) {
    // Nuvem Fiscal usa: pendente | processando | autorizado | rejeitado | cancelado
    const map = {
      pendente:    'pendente',
      processando: 'processando',
      autorizado:  'autorizada',
      rejeitado:   'rejeitada',
      cancelado:   'cancelada',
    };
    return map[status] || 'pendente';
  }
}

// ─────────────────────────────────────────────────────────
// 2. NorteNotasProvider — placeholder
//
// Quando assinarmos com Norte Notas, este adapter fica funcional.
// A interface ja existe pra que dentalNfse.js consiga chamar
// sem mudanca quando a empresa trocar de provider.
//
// REFERENCIA pra preencher: docs Norte Notas (a obter)
// ─────────────────────────────────────────────────────────

class NorteNotasProvider {
  constructor(config) {
    this.config = config;
  }

  async emit(_invoiceData) {
    throw new NfseProviderError(
      'Provider Norte Notas ainda nao implementado. Use Nuvem Fiscal por enquanto.',
      'PROVIDER_NOT_IMPLEMENTED'
    );
  }

  async consult(_providerId) {
    throw new NfseProviderError(
      'Provider Norte Notas ainda nao implementado',
      'PROVIDER_NOT_IMPLEMENTED'
    );
  }

  async cancel(_providerId, _reason) {
    throw new NfseProviderError(
      'Provider Norte Notas ainda nao implementado',
      'PROVIDER_NOT_IMPLEMENTED'
    );
  }
}

// ─────────────────────────────────────────────────────────
// 3. MockProvider — pra dev/testing local
//
// Simula respostas sem chamar API externa. Util pra:
//   - Testar fluxo end-to-end no UAT sem custo real
//   - Desenvolvimento offline
//   - CI tests
// ─────────────────────────────────────────────────────────

class MockProvider {
  constructor(_config) {
    this.notas = new Map(); // in-memory store
  }

  async emit(invoiceData) {
    const fakeId = 'mock-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const fakeNumber = String(Math.floor(Math.random() * 1000000) + 100000);
    const note = {
      id:                fakeId,
      number:            fakeNumber,
      verification_code: 'MOCK' + Math.random().toString(36).slice(2, 10).toUpperCase(),
      service_amount:    invoiceData.service_amount,
      issued_at:         new Date().toISOString(),
      status:            'autorizada',
    };
    this.notas.set(fakeId, note);

    return {
      provider:          'mock',
      provider_id:       fakeId,
      status:            'autorizada',
      nfse_number:       fakeNumber,
      verification_code: note.verification_code,
      pdf_url:           `https://example.com/mock-nfse/${fakeId}.pdf`,
      xml_url:           `https://example.com/mock-nfse/${fakeId}.xml`,
      issued_at:         note.issued_at,
      raw_response:      { mocked: true, note },
    };
  }

  async consult(providerId) {
    const note = this.notas.get(providerId);
    if (!note) {
      return {
        status: 'rejeitada',
        rejection_reason: '[MOCK] NFS-e nao encontrada',
      };
    }
    return {
      status:            note.status,
      nfse_number:       note.number,
      verification_code: note.verification_code,
      pdf_url:           `https://example.com/mock-nfse/${providerId}.pdf`,
      xml_url:           `https://example.com/mock-nfse/${providerId}.xml`,
      issued_at:         note.issued_at,
      raw_response:      { mocked: true, note },
    };
  }

  async cancel(providerId, reason) {
    const note = this.notas.get(providerId);
    if (note) {
      note.status = 'cancelada';
      note.cancel_reason = reason;
    }
    return { ok: true, raw_response: { mocked: true } };
  }
}

// ─────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────

function getProvider(nfseConfig) {
  if (!nfseConfig) {
    throw new NfseProviderError('nfse_config nao encontrado', 'CONFIG_MISSING');
  }
  if (!nfseConfig.is_active) {
    throw new NfseProviderError('NFS-e desativada nesta empresa', 'CONFIG_INACTIVE');
  }

  const adapterConfig = {
    apiKey:   nfseConfig._decrypted_api_key, // upstream decifra antes
    ambiente: nfseConfig.ambiente,
    inscricao_municipal:      nfseConfig.inscricao_municipal,
    regime_tributario:        nfseConfig.regime_tributario,
    regime_especial:          nfseConfig.regime_especial,
    optante_simples_nacional: nfseConfig.optante_simples_nacional,
  };

  switch (nfseConfig.provider) {
    case 'nuvem_fiscal':
      return new NuvemFiscalProvider(adapterConfig);
    case 'norte_notas':
      return new NorteNotasProvider(adapterConfig);
    case 'mock':
      return new MockProvider(adapterConfig);
    default:
      throw new NfseProviderError(
        `Provider desconhecido: ${nfseConfig.provider}`,
        'INVALID_PROVIDER'
      );
  }
}

// ─────────────────────────────────────────────────────────
// Helper: validar invoiceData antes de emitir
// ─────────────────────────────────────────────────────────

function validateInvoiceData(invoiceData) {
  const errors = [];

  if (!invoiceData.company?.cnpj) errors.push('CNPJ da empresa obrigatorio');
  if (!invoiceData.config?.inscricao_municipal) {
    errors.push('Inscricao municipal obrigatoria. Configure em nfse_config.');
  }
  if (!invoiceData.rps_number) errors.push('rps_number obrigatorio');
  if (!invoiceData.service_code) errors.push('service_code obrigatorio');
  if (!invoiceData.service_description) errors.push('service_description obrigatorio');
  if (!invoiceData.service_amount || invoiceData.service_amount <= 0) {
    errors.push('service_amount deve ser > 0');
  }

  const r = invoiceData.recipient;
  if (!r) {
    errors.push('Tomador (recipient) obrigatorio');
  } else {
    if (!r.name) errors.push('Nome do tomador obrigatorio');
    if (!r.doc) errors.push('CPF/CNPJ do tomador obrigatorio');
    if (r.type === 'pj' && onlyDigits(r.doc).length !== 14) {
      errors.push('CNPJ do tomador deve ter 14 digitos');
    }
    if (r.type === 'pf' && onlyDigits(r.doc).length !== 11) {
      errors.push('CPF do tomador deve ter 11 digitos');
    }
  }

  return errors;
}

module.exports = {
  getProvider,
  validateInvoiceData,
  NfseProviderError,
  NuvemFiscalProvider,
  NorteNotasProvider,
  MockProvider,
};
