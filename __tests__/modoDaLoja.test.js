// ============================================================
// A loja aceita pedido agora? (04/09/2026)
//
// Em dezembro e em maio a lojista vende o que nao consegue produzir. A
// unica saida que ela tinha era DESPUBLICAR a loja — que joga fora
// tambem a vitrine, e com ela o orcamento que daria para produzir em
// janeiro.
//
// O que estes testes guardam: que fechar a loja nao apaga a loja, que a
// data fecha sozinha (porque as 23h do dia 20 ninguem abre o painel), e
// que o fechamento vale no SERVIDOR e nao so no botao.
// ============================================================
const fs = require('fs');
const path = require('path');
const { modoDaLoja, hojeNoBrasil, comoData } = require('../src/services/modoDaLoja');

const EM = (iso) => new Date(iso);

describe('loja aberta', () => {
  test('sem nada configurado, aceita', () => {
    const m = modoDaLoja({});
    expect(m.aceita).toBe(true);
    expect(m.motivo).toBeNull();
  });

  test('com data no futuro, aceita', () => {
    const m = modoDaLoja({ pedidos_ate: '2026-12-20' }, EM('2026-09-04T12:00:00Z'));
    expect(m.aceita).toBe(true);
    expect(m.pedidos_ate).toBe('2026-12-20');
  });

  test('no ULTIMO dia ainda aceita', () => {
    // "Aceito pedidos ate dia 20" inclui o dia 20. Fechar de manha no
    // proprio dia seria quebrar a promessa escrita na vitrine.
    const m = modoDaLoja({ pedidos_ate: '2026-12-20' }, EM('2026-12-20T14:00:00Z'));
    expect(m.aceita).toBe(true);
  });
});

describe('loja fechada para pedido', () => {
  test('a lojista fechou na mao', () => {
    const m = modoDaLoja({ pedidos_pausados: true });
    expect(m.aceita).toBe(false);
    expect(m.motivo).toBe('pausado');
  });

  test('a data passou, e ela fechou sozinha', () => {
    const m = modoDaLoja({ pedidos_ate: '2026-12-20' }, EM('2026-12-21T10:00:00Z'));
    expect(m.aceita).toBe(false);
    expect(m.motivo).toBe('prazo');
  });

  test('fechado na mao vence a data futura', () => {
    const m = modoDaLoja({ pedidos_pausados: true, pedidos_ate: '2027-01-01' }, EM('2026-09-04T12:00:00Z'));
    expect(m.aceita).toBe(false);
    expect(m.motivo).toBe('pausado');
  });

  test('fechado NUNCA vem sem recado', () => {
    // Uma loja sem botao de comprar e sem explicacao parece quebrada.
    for (const c of [{ pedidos_pausados: true }, { pedidos_ate: '2020-01-01' }]) {
      const m = modoDaLoja(c);
      expect(m.aceita).toBe(false);
      expect(typeof m.recado).toBe('string');
      expect(m.recado.length).toBeGreaterThan(30);
      // A frase e lida pela CLIENTE, na vitrine: vai com acento.
      expect(m.recado).toMatch(/orçamento/i);
    }
  });
});

describe('o fuso, que decide um dia inteiro', () => {
  test('as 22h de Brasilia ainda e o mesmo dia', () => {
    // O servidor roda em UTC: sem o deslocamento, entre 21h e 24h a data
    // ja virou la e a loja fecharia um dia antes do combinado.
    expect(hojeNoBrasil(EM('2026-12-20T23:30:00Z'))).toBe('2026-12-20');
  });

  test('e a loja com prazo ate dia 20 ainda aceita nesse instante', () => {
    const m = modoDaLoja({ pedidos_ate: '2026-12-20' }, EM('2026-12-20T23:30:00Z'));
    expect(m.aceita).toBe(true);
  });
});

describe('a data, venha como vier do banco', () => {
  test('Date do driver do Postgres', () => {
    expect(comoData(new Date('2026-12-20T00:00:00Z'))).toBe('2026-12-20');
  });

  test('texto com hora junto', () => {
    expect(comoData('2026-12-20T03:00:00.000Z')).toBe('2026-12-20');
  });

  test('nulo e lixo nao viram data', () => {
    expect(comoData(null)).toBeNull();
    expect(comoData('dezembro')).toBeNull();
    expect(comoData('')).toBeNull();
  });
});

describe('a trava vale no servidor', () => {
  const rota = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'studioStorefront.js'), 'utf8');

  test('o POST de pedido recusa quando a loja esta fechada', () => {
    // Uma pagina aberta antes de a lojista fechar continuaria enviando.
    expect(rota).toContain('const modo = modoDaLoja(config);');
    expect(rota).toContain('if (!modo.aceita) {');
    expect(rota).toContain('res.status(409)');
  });

  test('a recusa devolve o recado, nao um codigo seco', () => {
    const trecho = rota.slice(rota.indexOf('if (!modo.aceita) {'), rota.indexOf('// MP gateway'));
    expect(trecho).toContain('error: modo.recado');
  });

  test('os dois retornos do payload levam o modo', () => {
    expect((rota.match(/pedidos: modoDaLoja\(config\)/g) || []).length).toBe(2);
  });
});
