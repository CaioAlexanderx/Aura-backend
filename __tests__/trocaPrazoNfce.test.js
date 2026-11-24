// ============================================================
// AURA. — Troca e prazo de cancelamento da NFC-e por UF (17/11/2026)
// Card b-troca-prazo-nfce.
//
// Antes: a troca escolhia "cancela e reemite" com NFC-e de até 24 h e o
// cancelamento recusava depois de 30 min. Agora a troca usa o MESMO prazo do
// cancelamento, por UF; acima dele vai para a NF-e de devolução sem tentar
// cancelar. Sem chamada real à SEFAZ: gateway e devolução são mocks.
// ============================================================
'use strict';

jest.mock('../src/config/database', () => ({ connect: jest.fn(), query: jest.fn() }));
jest.mock('../src/services/nuvemfiscal', () => require('../__mocks__/nuvemfiscal'));
jest.mock('../src/services/trocaDevolucao55', () => ({ handle: jest.fn() }));

const db = require('../src/config/database');
const nuvemfiscal = require('../src/services/nuvemfiscal');
const trocaDevolucao55 = require('../src/services/trocaDevolucao55');
const trocaV2 = require('../src/services/trocaV2');
const prazo = require('../src/services/nfcePrazoCancelamento');

const { decideFiscalPerOrigin } = trocaV2._internal;

const AGORA = Date.parse('2026-11-17T15:00:00Z');
const minutosAtras = (m, now = AGORA) => new Date(now - m * 60000).toISOString();
const ENV = {}; // sem NFCE_CANCEL_DEADLINE_MIN: vale a tabela por UF

// Chave fictícia de NFC-e (modelo 65) com o cUF pedido.
// cUF(2) AAMM(4) CNPJ(14) mod(2) série(3) nNF(9) tpEmis(1) cNF(8) DV(1) = 44
const chave = (cuf, modelo = '65') => `${cuf}2611` + '11222333000181' + modelo + '002' + '000000900' + '1' + '12345678' + '0';
const CUF = { SP: '35', AP: '16', RJ: '33', MG: '31', BA: '29' };

describe('prazo de cancelamento por UF (nfcePrazoCancelamento)', () => {
  test('tabela: SP, AP, RJ, MG e BA com 30 minutos e fonte citada', () => {
    for (const uf of ['SP', 'AP', 'RJ', 'MG', 'BA']) {
      expect(prazo.PRAZO_NFCE_POR_UF[uf].minutos).toBe(30);
      expect(prazo.PRAZO_NFCE_POR_UF[uf].fonte).toMatch(/\S/);
    }
    expect(prazo.PRAZO_NACIONAL_MIN).toBe(30);
  });

  test.each(Object.entries(CUF))('%s: a UF sai do cUF da chave (%s)', (uf, cuf) => {
    const c = chave(cuf);
    expect(c).toHaveLength(44);
    expect(prazo.ufDaNota({ chave_acesso: c }, 'SP')).toBe(uf);
  });

  test('sem chave: UF da configuração; sem nada: SP', () => {
    expect(prazo.ufDaNota({ chave_acesso: null }, 'mg')).toBe('MG');
    expect(prazo.ufDaNota({}, null)).toBe('SP');
  });

  test.each(Object.keys(CUF))('%s: 10 min dentro, 2 h e 30 h fora', (uf) => {
    const nota = (m) => ({ chave_acesso: chave(CUF[uf]), authorized_at: minutosAtras(m) });
    const p10 = prazo.prazoDeCancelamento(nota(10), { now: AGORA, env: ENV });
    expect(p10).toMatchObject({ uf, minutos: 30, dentro: true, vencido: false, modelo: '65' });
    expect(p10.ate).toBe(new Date(AGORA - 10 * 60000 + 30 * 60000).toISOString());
    expect(prazo.prazoDeCancelamento(nota(120), { now: AGORA, env: ENV })).toMatchObject({ dentro: false, vencido: true });
    expect(prazo.prazoDeCancelamento(nota(30 * 60), { now: AGORA, env: ENV })).toMatchObject({ dentro: false, vencido: true });
  });

  test('limite: 30 min exatos ainda dentro; 31 min fora', () => {
    const n = (m) => ({ chave_acesso: chave('35'), authorized_at: minutosAtras(m) });
    expect(prazo.prazoDeCancelamento(n(30), { now: AGORA, env: ENV }).dentro).toBe(true);
    expect(prazo.prazoDeCancelamento(n(31), { now: AGORA, env: ENV }).dentro).toBe(false);
  });

  test('NFCE_CANCEL_DEADLINE_MIN continua como alavanca de operação', () => {
    const n = { chave_acesso: chave('33'), authorized_at: minutosAtras(20) };
    expect(prazo.prazoDeCancelamento(n, { now: AGORA, env: { NFCE_CANCEL_DEADLINE_MIN: '15' } })).toMatchObject({ minutos: 15, dentro: false });
  });

  test('NF-e 55: 24 h (o prazo de nfe55Eventos)', () => {
    const n = { chave_acesso: chave('35', '55'), tipo: 'nfe', authorized_at: minutosAtras(2 * 60) };
    expect(prazo.prazoDeCancelamento(n, { now: AGORA, env: ENV })).toMatchObject({ modelo: '55', minutos: 1440, dentro: true });
  });

  test('sem authorized_at: desconhecido, nem dentro nem vencido', () => {
    expect(prazo.prazoDeCancelamento({ chave_acesso: chave('35') }, { now: AGORA, env: ENV }))
      .toMatchObject({ desconhecido: true, dentro: false, vencido: false, ate: null });
  });

  test('prévia da lista do Caixa', () => {
    const p = prazo.previaFiscalDaTroca({ authorized_at: minutosAtras(10), chave_acesso: chave('31'), nuvemfiscal_id: 'nf1' }, { now: AGORA, env: ENV });
    expect(p).toMatchObject({ nfce_uf: 'MG', nfce_prazo_minutos: 30, nfce_troca_estrategia: 'cancel_reissue' });
    expect(prazo.previaFiscalDaTroca(null).nfce_troca_estrategia).toBe('none');
    expect(prazo.previaFiscalDaTroca({ authorized_at: minutosAtras(10), chave_acesso: chave('31') }, { now: AGORA, env: ENV }).nfce_troca_estrategia).toBe('devolucao_55');
  });
});

describe('troca: decideFiscalPerOrigin com o prazo da UF', () => {
  const venda = (id, minutos, { uf = 'SP', gateway = true } = {}) => ({
    id,
    nfce: {
      id: `nfce_${id}`,
      nuvemfiscal_id: gateway ? `nf_${id}` : null,
      chave_acesso: chave(CUF[uf]),
      authorized_at: minutosAtras(minutos),
    },
  });
  const decide = (vendas, pedida = 'per_origin') =>
    decideFiscalPerOrigin(vendas, vendas.map((v) => ({ original_sale_id: v.id })), pedida, { now: AGORA, env: ENV });

  test.each(Object.keys(CUF))('%s: troca com 10 min cancela; com 2 h e 30 h vai para a devolução', (uf) => {
    const m = decide([venda('a', 10, { uf }), venda('b', 120, { uf }), venda('c', 30 * 60, { uf })]);
    expect(m.get('a')).toBe('cancel_reissue');
    expect(m.get('b')).toBe('devolucao_55');
    expect(m.get('c')).toBe('devolucao_55');
  });

  test('emissão própria: devolução em qualquer idade (até com 10 min)', () => {
    const m = decide([venda('a', 10, { gateway: false })]);
    expect(m.get('a')).toBe('devolucao_55');
  });

  test('cancel_reissue explícito (app antigo, venda de menos de 24 h): fora do prazo não tenta cancelar', () => {
    const m = decide([venda('a', 10), venda('b', 120), venda('c', 10, { gateway: false })], 'cancel_reissue');
    expect(m.get('a')).toBe('cancel_reissue');
    expect(m.get('b')).toBe('devolucao_55');
    expect(m.get('c')).toBe('devolucao_55');
  });

  test('devolucao_55 e none pedidos continuam respeitados', () => {
    expect(decide([venda('a', 10)], 'devolucao_55').get('a')).toBe('devolucao_55');
    expect(decide([venda('a', 10)], 'none').get('a')).toBe('none');
  });
});

// ── a troca inteira, com client de mentira ───────────────────
const EMPRESA = 'c0000000-0000-0000-0000-000000000001';
const VENDA = 'a0000000-0000-0000-0000-000000000001';
const ITEM = 'b0000000-0000-0000-0000-000000000001';
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

function clientDaTroca(nfce) {
  const sqls = [];
  const c = {
    release: jest.fn(),
    query: jest.fn(async (sql, params) => {
      const s = norm(sql);
      sqls.push(s);
      if (/^SELECT s\.id, s\.status, s\.company_id/.test(s)) {
        return { rows: [{ id: VENDA, status: 'completed', company_id: EMPRESA, seller_id: 'u1', employee_id: null, created_at: nfce.authorized_at, total_amount: '100.00', customer_id: 'cli-1' }] };
      }
      if (/^SELECT id, sale_id, product_id, variant_id, quantity, unit_price, product_name_snapshot, discount, total_price FROM sale_items/.test(s)) {
        return { rows: [{ id: ITEM, sale_id: VENDA, product_id: 'prod-1', variant_id: null, quantity: '1', unit_price: '100.00', product_name_snapshot: 'Vestido' }] };
      }
      if (/^SELECT DISTINCT ON \(ne\.sale_id\)/.test(s)) return { rows: [{ sale_id: VENDA, ...nfce }] };
      if (/^SELECT id FROM customers WHERE id = \$1/.test(s)) return { rows: [{ id: params[0] }] };
      if (/information_schema\.columns/.test(s)) return { rows: [{ n: '2' }] };
      if (/^INSERT INTO sales/.test(s)) return { rows: [{ id: 'troca-1', company_id: params[0], customer_id: params[1] }] };
      if (/^INSERT INTO nfce_emissions/.test(s)) return { rows: [{ id: 'em-pendente' }] };
      if (/^INSERT INTO troca_payouts/.test(s)) return { rows: [{ id: 'po-1' }] };
      if (/^SELECT p\.company_id AS stock_company_id/.test(s)) return { rows: [{ stock_company_id: EMPRESA }] };
      if (/^SELECT company_id FROM products WHERE id=\$1/.test(s)) return { rows: [{ company_id: EMPRESA }] };
      return { rows: [], rowCount: 1 };
    }),
  };
  return { c, sqls };
}

function resFalso() {
  const r = { statusCode: 200, body: null };
  r.status = jest.fn((code) => { r.statusCode = code; return r; });
  r.json = jest.fn((b) => { r.body = b; return r; });
  return r;
}

function reqTroca(nfceStrategy) {
  return {
    params: { id: EMPRESA },
    user: { id: 'user-1' },
    body: {
      original_sale_ids: [VENDA],
      returned_items: [{ original_sale_id: VENDA, original_sale_item_id: ITEM, product_id: 'prod-1', quantity: 1, unit_price: 100 }],
      new_items: [],
      refund_splits: [{ method: 'dinheiro', amount: 100 }],
      nfce_strategy: nfceStrategy,
    },
  };
}

describe('troca inteira: cancela só dentro do prazo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [] });
    trocaDevolucao55.handle.mockResolvedValue({ status: 'autorizada', devolucao_chave: '35261111222333000181550010000000011000000011' });
  });

  const nfceGateway = (minutos) => ({
    id: 'nfce-1', nuvemfiscal_id: 'nf-1', chave_acesso: chave('35'), authorized_at: minutosAtras(minutos, Date.now()),
    numero: 900, status: 'autorizada', config_uf: 'SP',
  });

  test.each([
    ['10 min', 10, 'cancel_reissue'],
    ['2 h', 120, 'devolucao_55'],
    ['30 h', 30 * 60, 'devolucao_55'],
  ])('troca com %s (app antigo pede cancel_reissue)', async (_rot, minutos, esperado) => {
    const { c } = clientDaTroca(nfceGateway(minutos));
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca('cancel_reissue'), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.fiscal.per_origin.map((p) => p.strategy)).toEqual([esperado]);
    if (esperado === 'cancel_reissue') {
      expect(nuvemfiscal.cancelNfce).toHaveBeenCalledTimes(1);
      expect(trocaDevolucao55.handle).not.toHaveBeenCalled();
    } else {
      expect(nuvemfiscal.cancelNfce).not.toHaveBeenCalled();
      expect(trocaDevolucao55.handle).toHaveBeenCalledTimes(1);
    }
  });

  test('2 h com per_origin (app novo): devolução, sem tentar cancelar', async () => {
    const { c } = clientDaTroca(nfceGateway(120));
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca('per_origin'), res);
    expect(res.statusCode).toBe(201);
    expect(nuvemfiscal.cancelNfce).not.toHaveBeenCalled();
    expect(res.body.fiscal.per_origin[0]).toMatchObject({ strategy: 'devolucao_55', status: 'autorizada' });
  });

  test('emissão própria com 10 min e cancel_reissue explícito: devolução, não mais 409', async () => {
    const { c } = clientDaTroca({ ...nfceGateway(10), nuvemfiscal_id: null });
    db.connect.mockResolvedValue(c);
    const res = resFalso();
    await trocaV2.handle(reqTroca('cancel_reissue'), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.fiscal.per_origin[0].strategy).toBe('devolucao_55');
    expect(nuvemfiscal.cancelNfce).not.toHaveBeenCalled();
  });
});
