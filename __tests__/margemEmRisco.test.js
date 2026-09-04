// ============================================================
// Quais pecas ficaram no prejuizo (04/09/2026)
//
// A composicao (peca → insumos) e a view de resumo ja calculavam custo e
// margem. O que faltava era o AVISO: a lojista sobe o preco da louca de
// R$ 8 para R$ 11, salva, e nada acontece. Duas semanas depois descobre
// no fim do mes que vendeu no prejuizo.
//
// Ela e boa de producao e ruim de preco — e por isso este e o recurso
// que paga a mensalidade.
// ============================================================
const fs = require('fs');
const path = require('path');
const {
  MARGEM_MINIMA_PADRAO, margemMinima, situacao,
  pecasEmRisco, precoParaOPiso, recadoDoRisco,
} = require('../src/services/margemEmRisco');

const linha = (o) => ({
  product_id: o.id || 'p1',
  product_name: o.nome || 'CANECA BRANCA',
  product_price: o.preco != null ? o.preco : 39.9,
  total_cost: o.custo != null ? o.custo : 12,
  margin_pct: o.margem,
});

describe('o piso e dela', () => {
  test('usa o numero que a lojista definiu', () => {
    expect(margemMinima({ margem_minima_pct: 45 })).toBe(45);
  });

  test('sem numero definido, cai no padrao', () => {
    expect(margemMinima({})).toBe(MARGEM_MINIMA_PADRAO);
    expect(margemMinima(null)).toBe(MARGEM_MINIMA_PADRAO);
  });

  test('piso absurdo cai no padrao', () => {
    // 99% reprovaria a loja inteira; -10 nao reprovaria nada. Nos dois
    // casos o alerta vira ruido que ela aprende a ignorar.
    expect(margemMinima({ margem_minima_pct: 99 })).toBe(MARGEM_MINIMA_PADRAO);
    expect(margemMinima({ margem_minima_pct: -10 })).toBe(MARGEM_MINIMA_PADRAO);
  });
});

describe('prejuizo nao e margem baixa', () => {
  test('margem negativa e prejuizo', () => {
    expect(situacao(-8, 30)).toBe('prejuizo');
  });

  test('abaixo do piso, mas com lucro, e outra coisa', () => {
    expect(situacao(12, 30)).toBe('abaixo');
  });

  test('no piso exato ja esta ok', () => {
    expect(situacao(30, 30)).toBe('ok');
  });

  test('sem dado nao se inventa veredito', () => {
    // Peca sem composicao nao "ficou" ruim: ela nunca foi medida.
    expect(situacao(null, 30)).toBe('sem_dado');
    expect(situacao(undefined, 30)).toBe('sem_dado');
  });
});

describe('a lista, da pior para a menos ruim', () => {
  const linhas = [
    linha({ id: 'ok', nome: 'Kit', margem: 55 }),
    linha({ id: 'apertada', nome: 'Caneca', margem: 18 }),
    linha({ id: 'perdendo', nome: 'Chopp', margem: -5 }),
    linha({ id: 'sem', nome: 'Sem composicao', margem: null }),
  ];

  test('so entra quem precisa de atencao', () => {
    const r = pecasEmRisco(linhas, 30);
    expect(r.map((p) => p.product_id)).toEqual(['perdendo', 'apertada']);
  });

  test('a que perde dinheiro vem primeiro', () => {
    expect(pecasEmRisco(linhas, 30)[0].situacao).toBe('prejuizo');
  });

  test('peca sem composicao nao entra na lista', () => {
    // Misturar as duas faria a lojista perseguir cadastro em vez de preco.
    expect(pecasEmRisco(linhas, 30).some((p) => p.product_id === 'sem')).toBe(false);
  });

  test('loja saudavel devolve lista vazia', () => {
    expect(pecasEmRisco([linha({ margem: 55 })], 30)).toEqual([]);
  });

  test('entrada invalida nao quebra', () => {
    expect(pecasEmRisco(null, 30)).toEqual([]);
    expect(pecasEmRisco(undefined, 30)).toEqual([]);
  });
});

describe('por quanto ela passa a vender', () => {
  test('devolve o preco que recoloca a peca no piso', () => {
    // Custo 21, piso 30% → 21 / 0.7 = 30.
    expect(precoParaOPiso(21, 30)).toBe(30);
  });

  test('arredonda para CIMA', () => {
    // Para baixo deixaria a peca um centavo abaixo do piso que ela pediu.
    const p = precoParaOPiso(12.34, 30);
    expect(p).toBe(17.63);
    expect(12.34 / p).toBeLessThanOrEqual(0.7);
  });

  test('sem custo, nao ha o que sugerir', () => {
    expect(precoParaOPiso(0, 30)).toBeNull();
    expect(precoParaOPiso(null, 30)).toBeNull();
  });
});

describe('o recado muda com a gravidade', () => {
  const pecas = (arr) => pecasEmRisco(arr, 30);

  test('uma peca no prejuizo tem nome', () => {
    const r = recadoDoRisco(pecas([linha({ nome: 'CANECA CHOPP', margem: -4 })]), 30);
    expect(r).toContain('CANECA CHOPP');
    expect(r).toContain('mais do que vende');
  });

  test('uma peca apertada tambem', () => {
    const r = recadoDoRisco(pecas([linha({ nome: 'CANECA BRANCA', margem: 20 })]), 30);
    expect(r).toContain('CANECA BRANCA');
    expect(r).toContain('30%');
  });

  test('prejuizo e aperto na mesma frase, sem esconder o prejuizo', () => {
    const r = recadoDoRisco(pecas([
      linha({ id: 'a', margem: -3 }), linha({ id: 'b', margem: 10 }), linha({ id: 'c', margem: 12 }),
    ]), 30);
    expect(r).toMatch(/1 peca passou a custar mais do que vende/);
    expect(r).toContain('outras 2');
  });

  test('loja saudavel nao recebe recado nenhum', () => {
    expect(recadoDoRisco([], 30)).toBeNull();
  });
});

describe('o aviso chega quando ela sobe o custo', () => {
  const rota = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'studio.js'), 'utf8');

  test('mudar o custo devolve o estrago junto', () => {
    // E o ponto do recurso: ela sobe o preco da louca e ve na hora, sem
    // ir procurar produto por produto.
    expect(rota).toContain("if (req.body.unit_cost !== undefined) {");
    expect(rota).toContain('margem: await lerRisco(req.params.id)');
  });

  test('falha no calculo nao derruba o salvamento do insumo', () => {
    const trecho = rota.slice(rota.indexOf("if (req.body.unit_cost !== undefined)"),
                              rota.indexOf("router.delete('/inputs/:iid'"));
    expect(trecho).toContain('catch');
    expect(trecho).toContain('res.json(r.rows[0])');
  });

  test('base sem a view de resumo responde lista vazia, nao 500', () => {
    expect(rota).toContain("err.code === '42P01'");
  });

  test('a rota nao recalcula margem — le a view que ja calcula', () => {
    // Uma segunda conta de margem divergiria da tela de composicao.
    const trecho = rota.slice(rota.indexOf('async function lerRisco'),
                              rota.indexOf("router.get('/margem/risco'"));
    expect(trecho).toContain('studio_compositions_summary');
    expect(trecho).not.toContain('total_cost /');
  });
});
