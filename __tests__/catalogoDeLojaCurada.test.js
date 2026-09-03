// ============================================================
// O catalogo de uma loja com curadoria (03/09/2026)
//
// Em producao, /catalogo devolvia 500 em TODA loja que tivesse lista de
// curadoria — Davi Calcados, Looks da Jenny, FK Store e a aura — e 200 nas
// que nao tinham. A vitrine abria (a pagina 1 vem embutida no HTML), mas
// paginacao, categoria, busca, tamanho, cor e faixa de preco morriam.
//
// A CAUSA
// A lista curada era empurrada em `params` la em cima, para o ORDER BY.
// Só que o ORDER BY existe apenas na segunda consulta; a contagem nao
// ordena nada e o texto dela nunca cita esse $n. E o Postgres conta os
// parametros pelo MAIOR $n do texto: sobrando um, o Bind falha inteiro.
//
// A LICAO, que e o que este teste guarda: parametro entra na lista da
// consulta que o cita, e a contagem tem a lista dela. Nao adianta testar
// so o SQL — o defeito estava na aritmetica entre texto e parametros.
// ============================================================
const chamadas = [];
jest.mock('../src/config/database', () => ({
  query: jest.fn(async (sql, params) => {
    // COPIA, nao referencia: o codigo pode continuar empurrando na mesma
    // lista depois. Guardar a referencia mostraria a lista do FIM da
    // funcao, e o teste reprovaria implementacao correta pelo motivo
    // errado — que e como um teste vira armadilha meses depois.
    chamadas.push({ sql, params: (params || []).slice() });
    return { rows: /COUNT\(\*\)/.test(sql) ? [{ n: 7 }] : [{ id: 'p1' }] };
  }),
}));

const { paginaDoCatalogo } = require('../src/services/catalogoPaginado');

/** O maior $n citado no texto — e quantos parametros o Postgres vai exigir. */
function maiorPlaceholder(sql) {
  const achados = String(sql).match(/\$(\d+)/g) || [];
  return achados.reduce((m, s) => Math.max(m, parseInt(s.slice(1), 10)), 0);
}

const BASE = {
  cid: 'empresa-1',
  visibilityWhere: 'company_id = $1',
  exigeFoto: false,
};

beforeEach(() => { chamadas.length = 0; });

describe('cada consulta recebe exatamente os parametros que cita', () => {
  test('loja com curadoria e nenhum filtro — o caso que caiu', async () => {
    await paginaDoCatalogo({ ...BASE, featuredIds: ['a', 'b', 'c'] });

    expect(chamadas).toHaveLength(2);
    for (const { sql, params } of chamadas) {
      expect(params).toHaveLength(maiorPlaceholder(sql));
    }
  });

  test('loja sem curadoria', async () => {
    await paginaDoCatalogo({ ...BASE, featuredIds: [] });
    for (const { sql, params } of chamadas) {
      expect(params).toHaveLength(maiorPlaceholder(sql));
    }
  });

  test('curadoria junto com categoria, tamanho, cor, preco e busca', async () => {
    await paginaDoCatalogo({
      ...BASE,
      featuredIds: ['a', 'b'],
      categoria: 'masculino',
      tamanhos: ['38', '39'],
      cores: ['#000000'],
      precoMin: '50',
      precoMax: '300',
      busca: 'tenis corrida',
      ordem: 'menor-preco',
      offset: 24,
      limit: 24,
    });

    expect(chamadas).toHaveLength(2);
    for (const { sql, params } of chamadas) {
      expect(params).toHaveLength(maiorPlaceholder(sql));
    }
  });
});

describe('a contagem e a pagina continuam falando da mesma vitrine', () => {
  test('as duas usam o MESMO WHERE', async () => {
    await paginaDoCatalogo({ ...BASE, featuredIds: ['a'], categoria: 'infantil' });
    const [contagem, pagina] = chamadas;
    const where = (sql) => String(sql).split(/WHERE/)[1].split(/ORDER BY|LIMIT/)[0].trim();
    expect(where(pagina.sql)).toBe(where(contagem.sql));
  });

  test('a contagem nao ordena, e por isso nao carrega a lista curada', async () => {
    await paginaDoCatalogo({ ...BASE, featuredIds: ['a', 'b'] });
    const [contagem, pagina] = chamadas;
    expect(contagem.sql).not.toContain('array_position');
    expect(contagem.params).toEqual(['empresa-1']);
    // Na pagina, o array_position aponta para o parametro que É a lista.
    const n = parseInt(pagina.sql.match(/array_position\(\$(\d+)/)[1], 10);
    expect(pagina.params[n - 1]).toEqual(['a', 'b']);
  });

  test('a curadoria decide a ORDEM, nunca quem aparece', async () => {
    await paginaDoCatalogo({ ...BASE, featuredIds: ['a', 'b'] });
    const [, pagina] = chamadas;
    expect(pagina.sql).toContain('array_position');
    // Quem aparece e NA_VITRINE; um ANY na lista seria a regra duas vezes.
    expect(pagina.sql).not.toContain('id::text = ANY(');
  });

  test('LIMIT e OFFSET sao os dois ultimos parametros da pagina', async () => {
    await paginaDoCatalogo({ ...BASE, featuredIds: ['a'], offset: 48, limit: 24 });
    const [, pagina] = chamadas;
    expect(pagina.params.slice(-2)).toEqual([24, 48]);
  });
});
