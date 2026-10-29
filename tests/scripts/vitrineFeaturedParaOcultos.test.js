// ============================================================
// scripts/vitrine-featured-para-ocultos.js (tq-57)
//
// O que este teste guarda: o dry-run não escreve; o --apply só mexe nas
// lojas pedidas, guarda o backup ANTES do UPDATE e volta (ROLLBACK) se a
// vitrine mudar; o desfazer devolve o que estava no backup. O banco é um
// fake que simula o fragmento NA_VITRINE em JS.
// ============================================================
'use strict';

jest.mock('../../src/config/database', () => ({ query: jest.fn(), connect: jest.fn() }));

const { lerArgs, planejar, executar } = require('../../scripts/vitrine-featured-para-ocultos');

const silencio = () => {};

// Simula NA_VITRINE: (lista vazia OU está na lista) E não está nos ocultos.
function naVitrine(cfg, id) {
  const f = cfg.featured_product_ids || [];
  const h = cfg.hidden_product_ids || [];
  return (f.length === 0 || f.includes(id)) && !h.includes(id);
}

function fakeDb({ lojas, produtos, quebrarDepois = false }) {
  const escritas = [];
  const ordem = [];
  const cfgDe = (cid) => lojas.find((l) => l.company_id === cid);
  const responder = async (sql, params = []) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) { ordem.push(sql.trim()); return { rows: [] }; }
    if (/FOR UPDATE/.test(sql)) return { rows: [structuredClone(cfgDe(params[0]))] };
    if (/jsonb_array_length\(featured_product_ids\) > 0/.test(sql)) {
      const pedidas = params[0];
      return { rows: lojas
        .filter((l) => (l.featured_product_ids || []).length > 0)
        .filter((l) => !pedidas || pedidas.includes(l.slug))
        .map((l) => structuredClone(l)) };
    }
    if (/AS na_vitrine/.test(sql)) {
      const cfg = cfgDe(params[0]);
      return { rows: (produtos[params[0]] || []).map((p) => ({
        id: p.id, ativo: p.ativo !== false,
        na_vitrine: quebrarDepois && cfg._atualizada ? !naVitrine(cfg, p.id) : naVitrine(cfg, p.id),
      })) };
    }
    if (/UPDATE digital_channel_config/.test(sql)) {
      ordem.push('UPDATE');
      escritas.push({ sql, params });
      const cfg = cfgDe(params[0]);
      if (!cfg) return { rowCount: 0 };
      if (/featured_product_ids = '\[\]'::jsonb/.test(sql)) {
        cfg.featured_product_ids = [];
        cfg.hidden_product_ids = params[1];
        cfg._atualizada = true;
      } else {
        cfg.featured_product_ids = JSON.parse(params[1]);
        cfg.hidden_product_ids = params[2];
      }
      return { rowCount: 1 };
    }
    throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
  };
  const db = {
    query: jest.fn(responder),
    connect: jest.fn(async () => ({ query: responder, release: () => {} })),
  };
  return { db, escritas, ordem };
}

const LOJAS = () => [
  // Escondeu 2 de 5 pela lista de inclusão; já tinha 1 oculto antigo.
  { company_id: 'c1', slug: 'adega', is_published: true, featured_product_ids: ['p1', 'p2', 'p3'], hidden_product_ids: ['p4'] },
  { company_id: 'c2', slug: 'moda', is_published: true, featured_product_ids: ['m1'], hidden_product_ids: [] },
  { company_id: 'c3', slug: 'sem-lista', is_published: true, featured_product_ids: [], hidden_product_ids: [] },
];
const PRODUTOS = {
  c1: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }, { id: 'p5', ativo: false }],
  c2: [{ id: 'm1' }, { id: 'm2' }],
};

describe('lerArgs', () => {
  test('sem nada é dry-run de todas', () => {
    expect(lerArgs([])).toMatchObject({ apply: false, lojas: null });
  });
  test('--apply exige --lojas, e "todas" não é slug', () => {
    expect(() => lerArgs(['--apply'])).toThrow(/--lojas/);
    expect(() => lerArgs(['--apply', '--lojas', 'todas'])).toThrow(/não é um slug/);
    expect(lerArgs(['--lojas', 'a, b', '--apply'])).toMatchObject({ apply: true, lojas: ['a', 'b'] });
  });
  test('opção desconhecida para', () => {
    expect(() => lerArgs(['--tudo'])).toThrow(/desconhecida/);
  });
});

describe('planejar', () => {
  test('ocultos = ocultos de hoje + o que está fora da lista, inativo incluído; sem divergência', () => {
    const cfg = LOJAS()[0];
    const produtos = PRODUTOS.c1.map((p) => ({ id: p.id, ativo: p.ativo !== false, na_vitrine: naVitrine(cfg, p.id) }));
    const plano = planejar(cfg, produtos);
    expect(plano.ocultos).toEqual(['p4', 'p5']);
    expect(plano.novosOcultos).toBe(1);
    expect(plano.ativosNaVitrine).toBe(3);
    expect(plano.divergencias).toEqual([]);
  });

  test('aponta divergência quando a vitrine de hoje não bate com a simulação', () => {
    const cfg = LOJAS()[1];
    // m1 está na lista mas o banco diz que hoje NÃO aparece (ex.: oculto por regra que o plano não conhece).
    const plano = planejar(cfg, [{ id: 'm1', ativo: true, na_vitrine: false }, { id: 'm2', ativo: true, na_vitrine: false }]);
    expect(plano.divergencias).toEqual(['m1']);
  });
});

describe('executar', () => {
  test('dry-run não escreve nada', async () => {
    const { db, escritas } = fakeDb({ lojas: LOJAS(), produtos: PRODUTOS });
    const r = await executar([], { db, log: silencio, tabela: silencio });
    expect(r.modo).toBe('dry-run');
    expect(r.planos.map((p) => p.slug)).toEqual(['adega', 'moda']);
    expect(escritas).toEqual([]);
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('--apply converte só a loja pedida, com backup antes do UPDATE', async () => {
    const lojas = LOJAS();
    const { db, escritas, ordem } = fakeDb({ lojas, produtos: PRODUTOS });
    const arquivos = [];
    const escreverArquivo = jest.fn((f, txt) => { arquivos.push(JSON.parse(txt)); ordem.push('BACKUP'); });
    const r = await executar(['--lojas', 'adega', '--apply', '--backup', 'b.json'], {
      db, log: silencio, tabela: silencio, escreverArquivo,
    });
    expect(r.resultados).toEqual([{ slug: 'adega', resultado: 'convertida: 1 produto(s) foram para os ocultos' }]);
    expect(escritas).toHaveLength(1);
    expect(lojas[0].featured_product_ids).toEqual([]);
    expect(lojas[0].hidden_product_ids).toEqual(['p4', 'p5']);
    // A outra loja não foi tocada.
    expect(lojas[1].featured_product_ids).toEqual(['m1']);
    // Backup com o estado ANTERIOR, gravado antes do UPDATE.
    expect(arquivos[0].lojas[0]).toMatchObject({ slug: 'adega', featured_product_ids: ['p1', 'p2', 'p3'], hidden_product_ids: ['p4'] });
    expect(ordem.indexOf('BACKUP')).toBeLessThan(ordem.indexOf('UPDATE'));
    expect(ordem[ordem.length - 1]).toBe('COMMIT');
  });

  test('se a vitrine mudaria depois do UPDATE, volta (ROLLBACK)', async () => {
    const lojas = LOJAS();
    const { db, ordem } = fakeDb({ lojas, produtos: PRODUTOS, quebrarDepois: true });
    const r = await executar(['--lojas', 'moda', '--apply', '--backup', 'b.json'], {
      db, log: silencio, tabela: silencio, escreverArquivo: () => {},
    });
    expect(r.resultados[0].resultado).toMatch(/ROLLBACK/);
    expect(ordem).toContain('ROLLBACK');
    expect(ordem).not.toContain('COMMIT');
  });

  test('slug sem lista de inclusão para antes de qualquer escrita', async () => {
    const { db, escritas } = fakeDb({ lojas: LOJAS(), produtos: PRODUTOS });
    await expect(executar(['--lojas', 'sem-lista', '--apply'], { db, log: silencio, tabela: silencio }))
      .rejects.toThrow(/sem-lista/);
    expect(escritas).toEqual([]);
  });

  test('desfazer: sem --apply só mostra; com --apply devolve o backup', async () => {
    const lojas = LOJAS();
    lojas[0].featured_product_ids = [];
    lojas[0].hidden_product_ids = ['p4', 'p5'];
    const backup = JSON.stringify({ lojas: [{ company_id: 'c1', slug: 'adega', featured_product_ids: ['p1', 'p2', 'p3'], hidden_product_ids: ['p4'] }] });
    const { db, escritas } = fakeDb({ lojas, produtos: PRODUTOS });
    const lerArquivo = () => backup;

    await executar(['--desfazer', 'b.json'], { db, log: silencio, tabela: silencio, lerArquivo });
    expect(escritas).toEqual([]);

    const r = await executar(['--desfazer', 'b.json', '--apply'], { db, log: silencio, tabela: silencio, lerArquivo });
    expect(r.resultados).toEqual([{ slug: 'adega', resultado: 'restaurada' }]);
    expect(lojas[0].featured_product_ids).toEqual(['p1', 'p2', 'p3']);
    expect(lojas[0].hidden_product_ids).toEqual(['p4']);
  });
});
