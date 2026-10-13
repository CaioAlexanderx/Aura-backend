// ============================================================
// services/canary — a sequência do bipe sintético, passo a passo.
//
// fetch é injetado: o teste confere o que o canário PEDE (URL, verbo, corpo)
// e o que ele conclui de cada resposta, inclusive com cada passo falhando.
// ============================================================
'use strict';

const jwt = require('jsonwebtoken');
const canary = require('../../src/services/canary');

const COMPANY = 'b0463109-e68e-4d55-a2d4-40c8a758ae0b';
const USER = '5c19f573-0943-4263-beba-805456e32b13';
const VENDA = '11111111-2222-3333-4444-555555555555';

const CFG = { companyId: COMPANY, userId: USER, barcode: '7890000000017', baseUrl: 'https://api.test', timeoutMs: 200 };

const resp = (status, body) => ({ status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });

const PRODUTO = { id: 'prod-1', name: 'Canário', price: '19.90', stock_qty: 9999 };
const OK = {
  scan: () => resp(200, { match: 'exact', source: 'barcode', product: PRODUTO }),
  venda: () => resp(201, { sale: { id: VENDA, total_amount: '19.90' } }),
  consulta: () => resp(200, { sale: { id: VENDA, status: 'completed', total_amount: 19.9 }, items: [{}] }),
  cancela: () => resp(200, { ok: true, sale_id: VENDA }),
  caixa: () => resp(201, { sessao: { id: 'cx-1' } }),
};

// Roteia pelo verbo + caminho. `h` sobrescreve qualquer rota; uma função que
// lança simula falha de rede.
function fakeFetch(h = {}) {
  const rotas = { ...OK, ...h };
  const calls = [];
  const fn = jest.fn(async (url, init) => {
    const caminho = url.replace('https://api.test/api/v1', '');
    const metodo = init.method;
    calls.push({ metodo, caminho, corpo: init.body ? JSON.parse(init.body) : null, headers: init.headers, signal: init.signal });
    let rota;
    if (metodo === 'GET' && caminho.includes('/pdv/scan/')) rota = 'scan';
    else if (metodo === 'POST' && caminho.endsWith('/pdv/sale')) rota = 'venda';
    else if (metodo === 'GET' && caminho.includes('/sales/')) rota = 'consulta';
    else if (metodo === 'POST' && caminho.endsWith('/cancel')) rota = 'cancela';
    else if (metodo === 'POST' && caminho.endsWith('/caixa/abrir')) rota = 'caixa';
    else throw new Error('rota inesperada ' + metodo + ' ' + caminho);
    const r = rotas[rota];
    return typeof r === 'function' ? r({ calls }) : r;
  });
  fn.calls = calls;
  return fn;
}

const deps = (f, extra = {}) => ({ fetch: f, gerarToken: () => 'tok', sleep: async () => {}, ...extra });
const nomes = (r) => r.passos.map((p) => p.passo);
const rotas = (f) => f.calls.map((c) => `${c.metodo} ${c.caminho.replace(COMPANY, ':c').replace(VENDA, ':v')}`);

describe('configuracao', () => {
  const base = { CANARY_COMPANY_ID: COMPANY, CANARY_USER_ID: USER, CANARY_BARCODE: '789' };

  test('sem as três envs fica dormente', () => {
    expect(canary.configuracao({})).toBeNull();
    for (const falta of Object.keys(base)) {
      const env = { ...base };
      delete env[falta];
      expect(canary.configuracao(env)).toBeNull();
    }
  });

  test('id que não é UUID também é dormente (nada de SQL/URL solta)', () => {
    expect(canary.configuracao({ ...base, CANARY_COMPANY_ID: "x'; DROP TABLE sales;--" })).toBeNull();
    expect(canary.configuracao({ ...base, CANARY_USER_ID: 'abc' })).toBeNull();
  });

  test('CANARY_ENABLED=false desliga mesmo com tudo configurado', () => {
    expect(canary.configuracao({ ...base, CANARY_ENABLED: 'false' })).toBeNull();
    expect(canary.configuracao({ ...base, CANARY_ENABLED: 'FALSE' })).toBeNull();
    expect(canary.configuracao({ ...base, CANARY_ENABLED: 'true' })).not.toBeNull();
  });

  test('base: CANARY_BASE_URL sem barra no fim; sem ela, o endereço público da API', () => {
    expect(canary.configuracao({ ...base, CANARY_BASE_URL: 'https://api.getaura.com.br///' }).baseUrl).toBe('https://api.getaura.com.br');
    expect(canary.configuracao({ ...base }).baseUrl).toMatch(/^https:\/\//);
    expect(canary.configuracao({ ...base, CANARY_TIMEOUT_MS: '3000' }).timeoutMs).toBe(3000);
    expect(canary.configuracao({ ...base, CANARY_TIMEOUT_MS: 'x' }).timeoutMs).toBe(15000);
  });
});

describe('gerarToken', () => {
  test('mesmo segredo do JWT, do usuário de serviço, como token de acesso de 5 min', () => {
    const token = canary.gerarToken(CFG, { secret: 'segredo-de-teste' });
    const p = jwt.verify(token, 'segredo-de-teste');
    expect(p).toMatchObject({ id: USER, company: COMPANY, type: 'access', canary: true });
    expect(p.exp - p.iat).toBe(300);
    expect(() => jwt.verify(token, 'outro')).toThrow();
  });
});

describe('executar — caminho feliz', () => {
  test('bipe → venda de 1 un. em dinheiro → consulta → cancela, medindo cada passo', async () => {
    const f = fakeFetch();
    const r = await canary.executar(CFG, deps(f));

    expect(r.ok).toBe(true);
    expect(r.erro).toBeNull();
    expect(r.passo_falho).toBeNull();
    expect(nomes(r)).toEqual(['token', 'bipe', 'venda', 'consulta', 'cancela']);
    expect(r.passos.every((p) => p.ok && typeof p.ms === 'number')).toBe(true);
    expect(r.venda_id).toBe(VENDA);
    expect(r.venda_pendente).toBe(false);

    expect(rotas(f)).toEqual([
      'GET /companies/:c/pdv/scan/7890000000017',
      'POST /companies/:c/pdv/sale',
      'GET /companies/:c/sales/:v',
      'POST /companies/:c/sales/:v/cancel',
    ]);
    const venda = f.calls[1].corpo;
    expect(venda.items).toEqual([{ product_id: 'prod-1', quantity: 1, unit_price: 19.9 }]);
    expect(venda.payment_method).toBe('dinheiro');
    expect(venda.payments).toEqual([{ method: 'dinheiro', value: 19.9 }]);
    expect(venda.notes).toBe(canary.MARCA_VENDA); // marca de origem na própria venda
    expect(f.calls[0].headers.Authorization).toBe('Bearer tok');
  });

  test('bipe por variante: manda variant_id e o preço efetivo', async () => {
    const f = fakeFetch({
      scan: () => resp(200, {
        match: 'exact', source: 'variant_barcode', product: { ...PRODUTO, price: '10.00' },
        variant_id: 'var-9', effective_price: '12.50',
      }),
      consulta: () => resp(200, { sale: { id: VENDA, status: 'completed', total_amount: 12.5 } }),
    });
    const r = await canary.executar(CFG, deps(f));
    expect(r.ok).toBe(true);
    expect(f.calls[1].corpo.items[0]).toEqual({ product_id: 'prod-1', variant_id: 'var-9', quantity: 1, unit_price: 12.5 });
  });
});

describe('executar — cada passo falhando', () => {
  test('token que não assina: nada é chamado', async () => {
    const f = fakeFetch();
    const r = await canary.executar(CFG, deps(f, { gerarToken: () => { throw new Error('JWT_SECRET ausente'); } }));
    expect(r.ok).toBe(false);
    expect(r.passo_falho).toBe('token');
    expect(r.erro).toMatch(/token: .*JWT_SECRET ausente/);
    expect(f).not.toHaveBeenCalled();
  });

  test('bipe com 500: para aí, sem vender nem cancelar', async () => {
    const f = fakeFetch({ scan: () => resp(500, { error: 'Erro na busca do código' }) });
    const r = await canary.executar(CFG, deps(f));
    expect(r.ok).toBe(false);
    expect(r.passo_falho).toBe('bipe');
    expect(r.erro).toMatch(/^bipe: HTTP 500/);
    expect(nomes(r)).toEqual(['token', 'bipe']);
    expect(rotas(f)).toHaveLength(1);
    expect(r.venda_id).toBeNull();
    expect(r.venda_pendente).toBe(false);
  });

  test('bipe que não acha o produto canário é falha com o motivo', async () => {
    const f = fakeFetch({ scan: () => resp(404, { match: 'none', error: 'Produto não encontrado' }) });
    const r = await canary.executar(CFG, deps(f));
    expect(r.passo_falho).toBe('bipe');
    expect(r.erro).toMatch(/404.*Produto não encontrado.*match=none/);
  });

  test('bipe que cai em sugestão (207) não vale: o código tem que casar exato', async () => {
    const f = fakeFetch({ scan: () => resp(207, { match: 'partial', suggestions: [PRODUTO] }) });
    const r = await canary.executar(CFG, deps(f));
    expect(r.passo_falho).toBe('bipe');
    expect(rotas(f)).toHaveLength(1);
  });

  test('queda de rede no bipe: erro de rede, status 0', async () => {
    const f = fakeFetch({ scan: () => { throw new Error('getaddrinfo ENOTFOUND api.test'); } });
    const r = await canary.executar(CFG, deps(f));
    expect(r.passo_falho).toBe('bipe');
    expect(r.erro).toMatch(/falha de rede: getaddrinfo ENOTFOUND/);
    expect(r.passos[1].status).toBe(0);
  });

  test('requisição sem resposta no tempo-limite vira falha, não trava', async () => {
    const f = fakeFetch({
      scan: ({ calls }) => new Promise((_, rej) => {
        calls[0].signal.addEventListener('abort', () => { const e = new Error('abortado'); e.name = 'AbortError'; rej(e); });
      }),
    });
    const r = await canary.executar({ ...CFG, timeoutMs: 20 }, deps(f));
    expect(r.passo_falho).toBe('bipe');
    expect(r.erro).toMatch(/sem resposta em 20 ms/);
  });

  test('venda 409 por estoque: falha na venda, nada a cancelar', async () => {
    const f = fakeFetch({ venda: () => resp(409, { error: 'Estoque insuficiente para "Canário". Disponivel: 0' }) });
    const r = await canary.executar(CFG, deps(f));
    expect(r.passo_falho).toBe('venda');
    expect(r.erro).toMatch(/venda: HTTP 409.*Estoque insuficiente/);
    expect(nomes(r)).toEqual(['token', 'bipe', 'venda']);
    expect(rotas(f)).toHaveLength(2);
    expect(r.venda_pendente).toBe(false);
  });

  test('venda 500: falha na venda', async () => {
    const f = fakeFetch({ venda: () => resp(500, { error: 'Erro ao registrar venda' }) });
    const r = await canary.executar(CFG, deps(f));
    expect(r.passo_falho).toBe('venda');
    expect(r.erro).toMatch(/HTTP 500 \(esperado 201\)/);
  });

  test('caixa fechado: abre pelo caminho real e repete a venda uma vez', async () => {
    let n = 0;
    const f = fakeFetch({
      venda: () => (n++ === 0 ? resp(409, { error: 'Abra o caixa', code: 'CAIXA_REQUIRED' }) : OK.venda()),
    });
    const r = await canary.executar(CFG, deps(f));
    expect(r.ok).toBe(true);
    expect(rotas(f)).toEqual([
      'GET /companies/:c/pdv/scan/7890000000017',
      'POST /companies/:c/pdv/sale',
      'POST /companies/:c/caixa/abrir',
      'POST /companies/:c/pdv/sale',
      'GET /companies/:c/sales/:v',
      'POST /companies/:c/sales/:v/cancel',
    ]);
    expect(r.passos.find((p) => p.passo === 'venda').detalhe.caixa_aberto).toBe(true);
  });

  test('caixa fechado e que não abre: falha na venda com o motivo', async () => {
    const f = fakeFetch({
      venda: () => resp(409, { error: 'Abra o caixa', code: 'CAIXA_REQUIRED' }),
      caixa: () => resp(500, { error: 'boom' }),
    });
    const r = await canary.executar(CFG, deps(f));
    expect(r.passo_falho).toBe('venda');
    expect(r.erro).toMatch(/caixa fechado e não abriu: HTTP 500/);
  });

  test('consulta que não confere: falha na consulta, MAS cancela a venda', async () => {
    const f = fakeFetch({ consulta: () => resp(200, { sale: { id: VENDA, status: 'completed', total_amount: 99 } }) });
    const r = await canary.executar(CFG, deps(f));
    expect(r.ok).toBe(false);
    expect(r.passo_falho).toBe('consulta');
    expect(r.erro).toMatch(/consulta: venda consultada não confere/);
    expect(nomes(r)).toEqual(['token', 'bipe', 'venda', 'consulta', 'cancela']);
    expect(r.passos[4].ok).toBe(true);
    expect(r.venda_pendente).toBe(false);
  });

  test('consulta 404/500: falha na consulta e ainda cancela', async () => {
    const f = fakeFetch({ consulta: () => resp(404, { error: 'Venda nao encontrada' }) });
    const r = await canary.executar(CFG, deps(f));
    expect(r.passo_falho).toBe('consulta');
    expect(rotas(f).pop()).toBe('POST /companies/:c/sales/:v/cancel');
  });

  test('cancela falhando: tenta de novo uma vez e, se persistir, deixa a venda pendente', async () => {
    const f = fakeFetch({ cancela: () => resp(500, { error: 'Erro ao cancelar' }) });
    const r = await canary.executar(CFG, deps(f));
    expect(r.ok).toBe(false);
    expect(r.passo_falho).toBe('cancela');
    expect(r.venda_pendente).toBe(true);
    expect(r.venda_id).toBe(VENDA);
    expect(rotas(f).filter((x) => x.endsWith('/cancel'))).toHaveLength(2);
  });

  test('cancela que falha na 1ª e passa na 2ª: execução ok', async () => {
    let n = 0;
    const f = fakeFetch({ cancela: () => (n++ === 0 ? resp(503, {}) : OK.cancela()) });
    const r = await canary.executar(CFG, deps(f));
    expect(r.ok).toBe(true);
    expect(r.venda_pendente).toBe(false);
  });

  test('"já está cancelada" conta como estornada', async () => {
    const f = fakeFetch({ cancela: () => resp(400, { error: 'Venda ja esta cancelada' }) });
    const r = await canary.executar(CFG, deps(f));
    expect(r.ok).toBe(true);
    expect(r.venda_pendente).toBe(false);
  });
});
