// ============================================================
// A home nasce do estoque — as regras dos blocos (redesign 09/2026)
//
// O que se trava aqui sao DECISOES, nao detalhes: a janela do ranking, o
// que conta como "ultimas unidades", o minimo abaixo do qual o bloco
// some, o prazo do selo NOVO, e o formato do destino interno do CTA.
// Cada numero foi decidido com Caio em 02/09/2026 e esta no parecer.
//
// Sem Postgres local, o SQL e conferido pela FONTE (como
// paridadeDosPayloads faz). Nao e elegante, mas e o que pega "troca
// entrou no ranking" antes de chegar em producao.
// ============================================================
const fs = require('fs');
const path = require('path');

const home = require('../src/services/homeDaLoja');
const catalogo = require('../src/services/catalogoPaginado');
const { destinoDoCta } = require('../src/services/storefrontBuilder');

const fonteHome = fs.readFileSync(path.join(__dirname, '../src/services/homeDaLoja.js'), 'utf8');
const fonteBuilder = fs.readFileSync(path.join(__dirname, '../src/services/storefrontBuilder.js'), 'utf8');
const fontePage = fs.readFileSync(path.join(__dirname, '../src/templates/storefrontPage.js'), 'utf8');

/** So o codigo: comentario que EXPLICA a regra nao pode fazer o teste passar. */
function semComentarios(src) {
  return src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

describe('selo NOVO', () => {
  const agora = new Date('2026-09-02T12:00:00Z');
  test('peca cadastrada ha 13 dias e nova', () => {
    expect(home.ehNovo('2026-08-20T12:00:00Z', agora)).toBe(true);
  });
  test('ha 15 dias nao e mais', () => {
    expect(home.ehNovo('2026-08-18T12:00:00Z', agora)).toBe(false);
  });
  test('exatamente 14 dias ja nao e', () => {
    expect(home.ehNovo('2026-08-19T12:00:00Z', agora)).toBe(false);
  });
  test('sem data nao e novo (nem quebra)', () => {
    expect(home.ehNovo(null)).toBe(false);
    expect(home.ehNovo('abc')).toBe(false);
  });
  test('o prazo e 14 dias', () => {
    expect(home.DIAS_DE_NOVO).toBe(14);
  });
});

describe('o bloco some abaixo do minimo', () => {
  test('um cartao sozinho nao e bloco', () => {
    expect(home.aplicarMinimo([{ id: 1 }])).toEqual([]);
  });
  test('dois ja e', () => {
    expect(home.aplicarMinimo([{ id: 1 }, { id: 2 }])).toHaveLength(2);
  });
  test('lista ausente vira vazia', () => {
    expect(home.aplicarMinimo(undefined)).toEqual([]);
  });
  test('o minimo e 2 e os limites sao 4 / 4 / 8', () => {
    expect(home.MINIMO_PARA_O_BLOCO).toBe(2);
    expect(home.LIMITE_MAIS_VENDIDOS).toBe(4);
    expect(home.LIMITE_ULTIMAS_UNIDADES).toBe(4);
    expect(home.LIMITE_NOVIDADES).toBe(8);
  });
});

describe('ranking de vendas', () => {
  test('a janela e de 90 dias', () => {
    expect(catalogo.JANELA_DE_VENDAS_DIAS).toBe(90);
    expect(catalogo.VENDIDOS_RECENTES).toContain("INTERVAL '90 days'");
  });
  test('troca NAO conta como venda (armadilha 5)', () => {
    expect(catalogo.VENDIDOS_RECENTES).toContain("<> 'troca'");
  });
  test('venda cancelada tambem nao', () => {
    expect(catalogo.VENDIDOS_RECENTES).toContain("<> 'cancelled'");
  });
  test('a ordenacao "mais vendidos" da grade usa a MESMA conta', () => {
    expect(catalogo.ordemSql('mais_vendidos')).toContain(catalogo.VENDIDOS_RECENTES);
  });
  test('o bloco da home usa a MESMA conta', () => {
    expect(semComentarios(fonteHome)).toContain('VENDIDOS_RECENTES');
  });
});

describe('ultimas unidades', () => {
  test('a regra e saldo total <= GREATEST(minimo cadastrado, 1)', () => {
    expect(home.NO_LIMITE).toContain('GREATEST(COALESCE(products.stock_min, 0), 1)');
  });
  test('o saldo total soma as variantes quando ha variante', () => {
    expect(home.ESTOQUE_TOTAL).toContain('SUM(v.stock_qty)');
    expect(home.ESTOQUE_TOTAL).toContain('ELSE products.stock_qty');
  });
});

describe('montarHome', () => {
  test('mapeia cada bloco com a funcao da grade e carrega restam / vendidos / is_new', async () => {
    // Sem banco: as consultas falham e o modulo tem que voltar vazio, NAO
    // derrubar a loja. O log fica — silencio ja escondeu bug de SQL.
    const erro = jest.spyOn(console, 'error').mockImplementation(() => {});
    const h = await home.montarHome({ cid: 'x', visibilityWhere: 'TRUE', exigeFoto: false });
    expect(h).toEqual({ mais_vendidos: [], ultimas_unidades: [], novidades: [] });
    expect(erro).toHaveBeenCalled();
    erro.mockRestore();
  });
});

describe('o payload leva a home ate a pagina', () => {
  test('o builder exporta `home` no payload', () => {
    // \r? porque o builder e CRLF no repo.
    expect(semComentarios(fonteBuilder)).toMatch(/\n\s+home,\r?\n/);
  });
  test('o builder marca is_new em todo produto', () => {
    expect(semComentarios(fonteBuilder)).toContain('is_new: ehNovo(p.created_at)');
  });
  test('a tira ganha capa_url (banner ou foto do mais vendido)', () => {
    const f = semComentarios(fonteBuilder);
    expect(f).toContain('c.capa_url = c.banner_url || capas[c.caminho] || null');
  });
  test('o CNPJ sai em site', () => {
    expect(semComentarios(fonteBuilder)).toContain('cnpj:          company.cnpj || null');
  });
  test('storefrontPage copia `home` pro storeData (copia campo a campo)', () => {
    expect(semComentarios(fontePage)).toContain('home: data.home');
  });
  test('a faixa de preco sai em facetas.preco', () => {
    expect(semComentarios(fonteBuilder)).toContain('facetas.preco = await faixaDePreco(');
  });
});

describe('destino do CTA do banner', () => {
  test('http(s) continua valendo', () => {
    expect(destinoDoCta('https://loja.com/x')).toBe('https://loja.com/x');
    expect(destinoDoCta('http://loja.com')).toBe('http://loja.com');
  });
  test('categoria da propria loja: #cat=/caminho', () => {
    expect(destinoDoCta('#cat=/vestidos')).toBe('#cat=/vestidos');
    expect(destinoDoCta('#cat=/vestidos/festa')).toBe('#cat=/vestidos/festa');
  });
  test('o que nao e nem um nem outro vira vazio', () => {
    expect(destinoDoCta('javascript:alert(1)')).toBe('');
    expect(destinoDoCta('#cat=')).toBe('');
    expect(destinoDoCta('#cat=vestidos')).toBe('');
    expect(destinoDoCta('#outra')).toBe('');
    expect(destinoDoCta('/vestidos')).toBe('');
    expect(destinoDoCta('')).toBe('');
    expect(destinoDoCta(null)).toBe('');
  });
});

describe('filtro de preco na pagina do catalogo', () => {
  const fonteCat = semComentarios(fs.readFileSync(path.join(__dirname, '../src/services/catalogoPaginado.js'), 'utf8'));
  test('aceita precoMin e precoMax', () => {
    expect(fonteCat).toContain('precoMin, precoMax');
    expect(fonteCat).toContain('price >= $');
    expect(fonteCat).toContain('price <= $');
  });
  test('a rota repassa preco_min e preco_max', () => {
    const rota = semComentarios(fs.readFileSync(path.join(__dirname, '../src/routes/storefront.js'), 'utf8'));
    expect(rota).toContain('precoMin: req.query.preco_min');
    expect(rota).toContain('precoMax: req.query.preco_max');
  });
});
