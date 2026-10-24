// ============================================================
// Pix Automático — cliente da Asaas (tq-104, 24/10/2026)
//
// Sem rede: asaasRequest é mockado (ou fetch, para o asaasClient). Confere
// o corpo que vai para a Asaas, o prazo das chamadas, o log sem dado
// pessoal e a chave de sandbox separada.
// ============================================================
'use strict';

afterEach(() => {
  jest.restoreAllMocks();
  jest.resetModules();
  delete process.env.ASAAS_ENV;
  delete process.env.ASAAS_SANDBOX_API_KEY;
  delete process.env.ASAAS_API_KEY;
  delete process.env.ASAAS_URL;
});

function carregar() {
  jest.resetModules();
  const asaasRequest = jest.fn();
  jest.doMock('../src/services/asaasClient', () => ({ asaasRequest }));
  const cliente = require('../src/services/pixAutomatico');
  return { cliente, asaasRequest };
}

const base = {
  customerId: 'cus_000111222',
  valor: 140.83,
  primeiroDebito: '2099-02-18',
  dataFim: '2099-12-18',
  contractId: 'AURA0123456789abtest',
  descricao: 'Assinatura Aura',
};

describe('criarAutorizacao', () => {
  test('manda SUBSCRIPTION, retryPolicy de 3 em 7 dias, mensal e valor fixo, com prazo na chamada', async () => {
    const { cliente, asaasRequest } = carregar();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    asaasRequest.mockResolvedValue({
      id: 'auth-1', status: 'CREATED', payload: '000201...copia', encodedImage: 'iVBOR',
      immediateQrCode: { expirationDate: '2099-01-02 12:00:00', conciliationIdentifier: 'x' },
      subscriptionId: 'sub_novo',
    });

    const { autorizacao, corpo } = await cliente.criarAutorizacao(base);

    expect(asaasRequest).toHaveBeenCalledTimes(1);
    const [method, path, body, apiKey, opts] = asaasRequest.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/pix/automatic/authorizations');
    expect(apiKey).toBeUndefined();
    expect(opts).toEqual({ timeoutMs: cliente.TIMEOUT_MS });
    expect(body).toEqual(corpo);
    expect(body).toMatchObject({
      customerId: 'cus_000111222',
      frequency: 'MONTHLY',
      paymentCreationMode: 'SUBSCRIPTION',
      retryPolicy: 'ALLOW_THREE_IN_SEVEN_DAYS',
      value: 140.83,
      startDate: '2099-02-18',
      finishDate: '2099-12-18',
      immediateQrCode: { originalValue: 140.83, expirationSeconds: 48 * 3600 },
    });
    expect(body.contractId.length).toBeLessThanOrEqual(35);
    expect(body.description.length).toBeLessThanOrEqual(35);

    const resumo = cliente.resumoDaAutorizacao(autorizacao);
    expect(resumo).toMatchObject({
      id: 'auth-1', status: 'CREATED', copia_e_cola: '000201...copia', qr_code_base64: 'iVBOR',
      expira_em: '2099-01-02 12:00:00', subscription_id: 'sub_novo',
    });
  });

  test('sem data_fim não manda finishDate (prazo indeterminado)', () => {
    const { cliente } = carregar();
    const corpo = cliente.montarCorpoDaAutorizacao({ ...base, dataFim: null });
    expect(corpo).not.toHaveProperty('finishDate');
  });

  test('recusa valor zero, data inválida e fim antes do início, sem chamar a Asaas', async () => {
    const { cliente, asaasRequest } = carregar();
    await expect(cliente.criarAutorizacao({ ...base, valor: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(cliente.criarAutorizacao({ ...base, primeiroDebito: '18/02/2099' })).rejects.toMatchObject({ status: 400 });
    await expect(cliente.criarAutorizacao({ ...base, dataFim: '2099-01-01' })).rejects.toMatchObject({ status: 400 });
    expect(asaasRequest).not.toHaveBeenCalled();
  });

  test('o log não leva o corpo (cliente, copia e cola) nem a query', async () => {
    const { cliente, asaasRequest } = carregar();
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    asaasRequest.mockResolvedValueOnce({ id: 'auth-1', payload: 'COPIA-E-COLA-SECRETO' });
    await cliente.criarAutorizacao(base);
    const e = new Error('CPF/CNPJ do cliente 123.456.789-00 inválido');
    e.asaasStatus = 400; e.asaasBody = { errors: [{ code: 'invalid_customer', description: e.message }] };
    asaasRequest.mockRejectedValueOnce(e);
    await expect(cliente.listarInstrucoes({ paymentId: 'pay_9' })).rejects.toBe(e);

    const tudo = [...log.mock.calls, ...errLog.mock.calls].map((c) => c.join(' ')).join('\n');
    expect(tudo).toContain('POST /pix/automatic/authorizations -> ok');
    expect(tudo).toContain('GET /pix/automatic/paymentInstructions -> falhou status=400 code=invalid_customer');
    expect(tudo).not.toMatch(/cus_000111222|COPIA-E-COLA|123\.456|pay_9/);
  });
});

describe('outras chamadas', () => {
  test('desligar notificações é PUT no cliente com notificationDisabled', async () => {
    const { cliente, asaasRequest } = carregar();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    asaasRequest.mockResolvedValue({ id: 'cus_1' });
    await cliente.desligarNotificacoesDoCliente('cus_1');
    expect(asaasRequest).toHaveBeenCalledWith('PUT', '/customers/cus_1', { notificationDisabled: true },
      undefined, { timeoutMs: cliente.TIMEOUT_MS });
  });

  test('consultar e cancelar autorização', async () => {
    const { cliente, asaasRequest } = carregar();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    asaasRequest.mockResolvedValue({ id: 'a/b' });
    await cliente.consultarAutorizacao('a/b');
    await cliente.cancelarAutorizacao('a/b');
    expect(asaasRequest.mock.calls[0].slice(0, 2)).toEqual(['GET', '/pix/automatic/authorizations/a%2Fb']);
    expect(asaasRequest.mock.calls[1].slice(0, 2)).toEqual(['DELETE', '/pix/automatic/authorizations/a%2Fb']);
  });

  test('cancelar a instrução de um ciclo: quita a cobrança por outro meio e relê as instruções', async () => {
    const { cliente, asaasRequest } = carregar();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    asaasRequest.mockImplementation(async (method, path) => {
      if (path.startsWith('/pix/automatic/paymentInstructions')) {
        const feito = asaasRequest.mock.calls.some((c) => c[1].endsWith('/receiveInCash'));
        return { data: [{ id: 'pi_1', status: feito ? 'CANCELLED' : 'SCHEDULED' }] };
      }
      if (method === 'GET' && path === '/payments/pay_1') return { id: 'pay_1', value: 140.83 };
      return {};
    });
    const r = await cliente.cancelarInstrucaoDoCiclo({ paymentId: 'pay_1', dataPagamento: '2099-02-10' });
    const quitar = asaasRequest.mock.calls.find((c) => c[1] === '/payments/pay_1/receiveInCash');
    expect(quitar[2]).toEqual({ paymentDate: '2099-02-10', value: 140.83, notifyCustomer: false });
    expect(asaasRequest.mock.calls[0][1]).toBe('/pix/automatic/paymentInstructions?paymentId=pay_1');
    expect(r).toMatchObject({
      instrucoes_antes: [{ id: 'pi_1', status: 'SCHEDULED' }],
      instrucoes_depois: [{ id: 'pi_1', status: 'CANCELLED' }],
      alguma_viva: false,
    });
  });

  test('modo excluir_cobranca apaga a cobrança do ciclo', async () => {
    const { cliente, asaasRequest } = carregar();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    asaasRequest.mockResolvedValue({ data: [] });
    await cliente.cancelarInstrucaoDoCiclo({ paymentId: 'pay_2', modo: 'excluir_cobranca' });
    expect(asaasRequest.mock.calls.map((c) => c[0] + ' ' + c[1])).toContain('DELETE /payments/pay_2');
  });
});

describe('asaasClient.asaasRequest', () => {
  function comFetch(impl) {
    jest.resetModules();
    jest.dontMock('../src/services/asaasClient');
    const f = jest.fn(impl);
    global.fetch = f;
    return { f, client: jest.requireActual('../src/services/asaasClient') };
  }
  const ok = async () => ({ ok: true, status: 200, json: async () => ({ ok: 1 }) });
  const realFetch = global.fetch;
  afterAll(() => { global.fetch = realFetch; });

  test('sandbox com ASAAS_SANDBOX_API_KEY usa a chave de sandbox e a base do sandbox', async () => {
    process.env.ASAAS_API_KEY = 'chave-prod';
    process.env.ASAAS_ENV = 'sandbox';
    process.env.ASAAS_SANDBOX_API_KEY = 'chave-sandbox';
    const { f, client } = comFetch(ok);
    await client.asaasRequest('GET', '/x');
    expect(f.mock.calls[0][0]).toBe('https://sandbox.asaas.com/api/v3/x');
    expect(f.mock.calls[0][1].headers.access_token).toBe('chave-sandbox');
  });

  test('sem ASAAS_SANDBOX_API_KEY, nada muda: segue ASAAS_API_KEY', async () => {
    process.env.ASAAS_API_KEY = 'chave-prod';
    process.env.ASAAS_ENV = 'sandbox';
    const { f, client } = comFetch(ok);
    await client.asaasRequest('GET', '/x');
    expect(f.mock.calls[0][1].headers.access_token).toBe('chave-prod');
  });

  test('em produção a chave de sandbox é ignorada, e a apiKey da chamada sempre vence', async () => {
    process.env.ASAAS_API_KEY = 'chave-prod';
    process.env.ASAAS_SANDBOX_API_KEY = 'chave-sandbox';
    const { f, client } = comFetch(ok);
    await client.asaasRequest('GET', '/x');
    await client.asaasRequest('GET', '/x', null, 'chave-subconta');
    expect(f.mock.calls[0][0]).toBe('https://api.asaas.com/v3/x');
    expect(f.mock.calls[0][1].headers.access_token).toBe('chave-prod');
    expect(f.mock.calls[1][1].headers.access_token).toBe('chave-subconta');
    expect(f.mock.calls[0][1].signal).toBeUndefined();
  });

  test('timeoutMs aborta a chamada parada', async () => {
    process.env.ASAAS_API_KEY = 'chave-prod';
    const { client } = comFetch((url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
      });
    }));
    await expect(client.asaasRequest('GET', '/x', null, undefined, { timeoutMs: 20 }))
      .rejects.toMatchObject({ asaasTimeout: true });
  });
});
