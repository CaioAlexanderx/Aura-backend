// ============================================================
// AURA. — Busca pelo nome da cor (CP6 da revisão de cores, 14/11/2026)
//
// Vitrine e lista de produtos acham a peça pelo color_name da variante, e
// "preta" acha "Preto" (as grafias da mesma cor na paleta única). A vitrine
// SEM busca segue com a consulta de sempre, byte a byte.
// ============================================================
'use strict';

const chamadas = [];
jest.mock('../src/config/database', () => ({
  query: jest.fn(async (sql, params) => {
    chamadas.push({ sql: String(sql), params: (params || []).slice() });
    return { rows: /COUNT\(\*\)/.test(sql) ? [{ n: 1 }] : [] };
  }),
}));

const { paginaDoCatalogo } = require('../src/services/catalogoPaginado');
const { grafiasDaMesmaCor } = require('../src/services/paletaDeCores');
const { nomesDeCorDasVariantes } = require('../src/services/nomeDaCor');

const BASE = { cid: 'empresa-1', visibilityWhere: 'company_id = $1', exigeFoto: false };
const maior = (sql) => (sql.match(/\$(\d+)/g) || []).reduce((m, s) => Math.max(m, parseInt(s.slice(1), 10)), 0);

beforeEach(() => { chamadas.length = 0; });

describe('grafias da mesma cor', () => {
  test('preta/preto e apelidos, sem acento e sem caixa', () => {
    expect(grafiasDaMesmaCor('PRETA')).toEqual(['preta', 'preto', 'black', 'negro', 'negra']);
    expect(grafiasDaMesmaCor('Preto')).toEqual(['preto', 'preta', 'black', 'negro', 'negra']);
    expect(grafiasDaMesmaCor('verde-água')).toEqual(['verde agua', 'tiffany']);
  });
  test('palavra que não é cor fica só ela', () => {
    expect(grafiasDaMesmaCor('vestido')).toEqual(['vestido']);
    expect(grafiasDaMesmaCor('  ')).toEqual([]);
  });
});

describe('nomes de cor das variantes (lista de produtos)', () => {
  const cor = (hex, tam) => [{ attribute: 'Cor', value: hex }, { attribute: 'Tamanho', value: tam }];
  test('o nome da regra e o color_name gravado, sem repetir e sem hex', () => {
    expect(nomesDeCorDasVariantes([
      { color_name: 'Preta', sku_suffix: 'PRETA-M', attributes: cor('#000000', 'M') },
      { color_name: 'Preta', sku_suffix: 'PRETA-G', attributes: cor('#000000', 'G') },
      { color_name: 'AZUL ESCUR', sku_suffix: 'AZUL ESCUR-M', attributes: cor('#1F2A44', 'M') },
      { color_name: null, sku_suffix: 'CAQUI-M', attributes: cor('#C3B091', 'M') },
      { color_name: '#FFFFFF', sku_suffix: 'FFFFFF-M', attributes: cor('#FFFFFF', 'M') },
      { color_name: null, sku_suffix: 'P', attributes: [{ attribute: 'Tamanho', value: 'P' }] },
    ])).toEqual(['Preta', 'Cinza escuro', 'AZUL ESCUR', 'Caqui', 'Branco']);
    expect(nomesDeCorDasVariantes(null)).toEqual([]);
  });
});

describe('vitrine', () => {
  test('sem busca: nada de cor na consulta (igual à de antes)', async () => {
    await paginaDoCatalogo({ ...BASE });
    for (const c of chamadas) {
      expect(c.sql).not.toContain('pvc');
      expect(c.sql).not.toContain('LIKE ANY');
    }
    expect(chamadas[0].params).toEqual(['empresa-1']);
  });

  test('com busca: cada termo acha pelo nome ou pela cor da variante (com as grafias da mesma cor)', async () => {
    await paginaDoCatalogo({ ...BASE, busca: 'Vestido PRETA' });
    const [contagem, pagina] = chamadas;
    for (const c of chamadas) expect(c.params).toHaveLength(maior(c.sql));
    expect(contagem.sql).toContain('LIKE ANY');
    expect(contagem.params).toEqual([
      'empresa-1',
      '%vestido%', ['%vestido%'],
      '%preta%', ['%preta%', '%preto%', '%black%', '%negro%', '%negra%'],
    ]);
    expect(pagina.sql.split('pvc.color_name').length - 1).toBe(2);
  });
});
