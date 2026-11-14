// Código IBGE pelo CEP (ViaCEP) — 14/11/2026, NF-e 55 de venda.
'use strict';

const { ibgePeloCep, normalizarCep, _limparCache } = require('../../src/services/ibgePeloCep');

const resposta = (body, ok = true) => async () => ({ ok, json: async () => body });

beforeEach(() => _limparCache());

describe('ibgePeloCep', () => {
  it('devolve ibge, município e UF do ViaCEP (URL /ws/<cep>/json/)', async () => {
    const fetchImpl = jest.fn(resposta({ cep: '12245-000', logradouro: 'Avenida Central', bairro: 'Jardim', localidade: 'Sao Jose dos Campos', uf: 'SP', ibge: '3549904' }));
    const r = await ibgePeloCep('12245-000', { fetchImpl });
    expect(r).toEqual({ ibge: '3549904', municipio: 'Sao Jose dos Campos', uf: 'SP', logradouro: 'Avenida Central', bairro: 'Jardim', cep: '12245000' });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://viacep.com.br/ws/12245000/json/');
  });

  it('usa o cache na segunda consulta do mesmo CEP', async () => {
    const fetchImpl = jest.fn(resposta({ localidade: 'Jacarei', uf: 'SP', ibge: '3524402' }));
    await ibgePeloCep('12327000', { fetchImpl });
    await ibgePeloCep('12327-000', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('CEP inexistente ({erro: true}), HTTP ruim, rede caída e CEP mal formado viram null', async () => {
    expect(await ibgePeloCep('99999999', { fetchImpl: resposta({ erro: true }) })).toBeNull();
    expect(await ibgePeloCep('11111111', { fetchImpl: resposta({}, false) })).toBeNull();
    expect(await ibgePeloCep('22222222', { fetchImpl: async () => { throw new Error('ECONNRESET'); } })).toBeNull();
    const nunca = jest.fn();
    expect(await ibgePeloCep('123', { fetchImpl: nunca })).toBeNull();
    expect(nunca).not.toHaveBeenCalled();
  });

  it('falha de rede não fica no cache', async () => {
    await ibgePeloCep('33333333', { fetchImpl: async () => { throw new Error('timeout'); } });
    const r = await ibgePeloCep('33333333', { fetchImpl: resposta({ localidade: 'X', uf: 'SP', ibge: '3550308' }) });
    expect(r.ibge).toBe('3550308');
  });

  it('timeout curto aborta a chamada', async () => {
    const lento = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('abort'))));
    expect(await ibgePeloCep('44444444', { fetchImpl: lento, timeoutMs: 20 })).toBeNull();
  });

  it('normalizarCep', () => {
    expect(normalizarCep('12.245-000')).toBe('12245000');
    expect(normalizarCep('1224500')).toBeNull();
  });
});
