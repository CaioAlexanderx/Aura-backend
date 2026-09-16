// ============================================================
// AURA KARATÊ — Prefixo do código de filiação (unitário)
//
// O bug que estes testes travam: nextDojoAffiliationId devolvia `FPKT-NNN`
// HARDCODED para QUALQUER federação. Ao criar a segunda federação (JKA Teste,
// 16/09/2026) os 10 dojôs dela nasceram FPKT-001..FPKT-010 — o código de
// filiação de uma federação carimbado na outra.
//
// A RESTRIÇÃO DURA é a inversa da correção: a federação incumbente NÃO pode
// mudar. Por isso o primeiro teste aqui é o da não-regressão (dojôs FPKT
// continuam FPKT), e ele vale mesmo com a coluna nova ausente (42703) —
// o backend sobe antes da migration 337.
//
// ⚠️ MOCK POR SQL (o client despacha por matcher), NUNCA fila posicional:
// a ordem interna (advisory lock → MAX → SELECT da federação) é detalhe de
// implementação e não pode virar contrato de teste. Mesma convenção de
// karateIdentitySync.test.js.
// ============================================================
'use strict';

const {
  nextDojoAffiliationId,
  resolveAffiliationPrefix,
  affiliationPrefixOf,
  normalizeAffiliationPrefix,
  derivePrefixFromIdentity,
} = require('../../src/services/karateService');

const FED = 'fed00000-0000-0000-0000-000000000001';

const isLock = (s) => /pg_advisory_xact_lock/.test(s);
const isMax = (s) => /FROM companies/.test(s) && /vertical = 'karate_dojo'/.test(s);
const isFed = (s) => /karate_affiliation_prefix/.test(s) && /WHERE id = \$1/.test(s);
const isFedSemColuna = (s) => /NULL::text AS prefix/.test(s);

// Client de transação de mentira. Responde pelo CONTEÚDO do SQL.
//   ultimoId  — o maior fpkt_affiliation_id já emitido pela federação (ou null)
//   fedRow    — a linha de companies da federação ({ prefix, slug, name })
//   semColuna — true simula a migration 337 pendente (42703 no primeiro SELECT)
function fakeClient({ ultimoId = null, fedRow = {}, semColuna = false } = {}) {
  const client = {
    query: jest.fn(async (sql) => {
      const s = String(sql);
      if (isLock(s)) return { rows: [] };
      if (isMax(s)) return { rows: ultimoId ? [{ fpkt_affiliation_id: ultimoId }] : [] };
      if (isFed(s)) {
        if (semColuna) {
          const e = new Error('column "karate_affiliation_prefix" does not exist');
          e.code = '42703';
          throw e;
        }
        return { rows: [{ prefix: fedRow.prefix ?? null, slug: fedRow.slug ?? null, name: fedRow.name ?? null }] };
      }
      if (isFedSemColuna(s)) {
        return { rows: [{ prefix: null, slug: fedRow.slug ?? null, name: fedRow.name ?? null }] };
      }
      throw new Error('SQL inesperado no teste: ' + s.slice(0, 120));
    }),
  };
  client.sqls = () => client.query.mock.calls.map((c) => String(c[0]));
  return client;
}

describe('não-regressão: a federação incumbente continua igual', () => {
  test('dojôs já numerados FPKT-NNN continuam FPKT, mesmo sem a coluna nova', async () => {
    const client = fakeClient({ ultimoId: 'FPKT-013', semColuna: true });
    await expect(nextDojoAffiliationId(client, FED)).resolves.toBe('FPKT-014');
  });

  test('a coluna declarada bate com o que os dojôs já usam — nada muda', async () => {
    const client = fakeClient({ ultimoId: 'FPKT-013', fedRow: { prefix: 'FPKT', slug: 'fpkt' } });
    await expect(nextDojoAffiliationId(client, FED)).resolves.toBe('FPKT-014');
  });

  test('o advisory lock por federação continua sendo tomado', async () => {
    const client = fakeClient({ ultimoId: 'FPKT-013' });
    await nextDojoAffiliationId(client, FED);
    expect(client.sqls().some(isLock)).toBe(true);
  });
});

describe('o prefixo vem do dado, não do código', () => {
  test('federação com prefixo declarado usa o dela', async () => {
    const client = fakeClient({ ultimoId: null, fedRow: { prefix: 'JKA', slug: 'jka-teste' } });
    await expect(nextDojoAffiliationId(client, FED)).resolves.toBe('JKA-001');
  });

  test('o prefixo declarado GANHA do prefixo herdado nos dojôs', async () => {
    // Exatamente a situação da JKA Teste depois da correção: os 10 dojôs
    // antigos são FPKT-NNN, mas o 11º já nasce com o prefixo próprio.
    const client = fakeClient({ ultimoId: 'FPKT-010', fedRow: { prefix: 'JKA', slug: 'jka-teste' } });
    await expect(nextDojoAffiliationId(client, FED)).resolves.toBe('JKA-011');
  });

  test('prefixo declarado é normalizado (minúscula/hífen do admin não vaza)', async () => {
    const client = fakeClient({ fedRow: { prefix: ' jka- ' } });
    await expect(nextDojoAffiliationId(client, FED)).resolves.toBe('JKA-001');
  });

  test('federação nova, sem prefixo e sem dojô: deriva do slug', async () => {
    const client = fakeClient({ fedRow: { slug: 'jka-teste', name: 'JKA Teste' } });
    await expect(nextDojoAffiliationId(client, FED)).resolves.toBe('JKA-001');
  });

  test('sem slug, deriva das iniciais do nome', async () => {
    const fpkt = fakeClient({ fedRow: { name: 'Federacao Paulista de Karate Tradicional' } });
    await expect(nextDojoAffiliationId(fpkt, FED)).resolves.toBe('FPKT-001');

    // Uma federacao QUALQUER, para o teste nao passar por coincidencia com o
    // 'FPKT-' que estava cravado no codigo antigo.
    const outra = fakeClient({ fedRow: { name: 'Liga Mineira de Karate Tradicional' } });
    await expect(nextDojoAffiliationId(outra, FED)).resolves.toBe('LMKT-001');
  });

  test('sem nada de que derivar, usa um genérico — NUNCA o nome de outra federação', async () => {
    const client = fakeClient({ fedRow: {} });
    const id = await nextDojoAffiliationId(client, FED);
    expect(id).toBe('FED-001');
    expect(id).not.toMatch(/FPKT/);
  });
});

describe('resolveAffiliationPrefix (usada também pelo import legado)', () => {
  test('sem lastId, consulta o último código emitido', async () => {
    const client = fakeClient({ ultimoId: 'FPKT-007', semColuna: true });
    await expect(resolveAffiliationPrefix(client, FED)).resolves.toBe('FPKT');
    expect(client.sqls().filter(isMax).length).toBe(1);
  });

  test('com lastId, NÃO repete a consulta do último código', async () => {
    const client = fakeClient({ fedRow: { prefix: 'JKA' } });
    await expect(resolveAffiliationPrefix(client, FED, 'JKA-004')).resolves.toBe('JKA');
    expect(client.sqls().filter(isMax).length).toBe(0);
  });

  test('lastId null (federação sem dojô) não vira consulta nem quebra', async () => {
    const client = fakeClient({ fedRow: { slug: 'abc' } });
    await expect(resolveAffiliationPrefix(client, FED, null)).resolves.toBe('ABC');
    expect(client.sqls().filter(isMax).length).toBe(0);
  });
});

describe('helpers puros', () => {
  test('affiliationPrefixOf separa prefixo do número', () => {
    expect(affiliationPrefixOf('FPKT-014')).toBe('FPKT');
    expect(affiliationPrefixOf('JKA-001')).toBe('JKA');
    // Sem o -NNN final não há prefixo a extrair (nunca devolve a string toda).
    expect(affiliationPrefixOf('ABC')).toBeNull();
    expect(affiliationPrefixOf(null)).toBeNull();
  });

  test('normalizeAffiliationPrefix só deixa passar A-Z0-9, até 12', () => {
    expect(normalizeAffiliationPrefix('fpkt')).toBe('FPKT');
    expect(normalizeAffiliationPrefix(' jka-teste ')).toBe('JKATESTE');
    expect(normalizeAffiliationPrefix('---')).toBeNull();
    expect(normalizeAffiliationPrefix('')).toBeNull();
    expect(normalizeAffiliationPrefix('ABCDEFGHIJKLMNOP')).toBe('ABCDEFGHIJKL');
  });

  test('derivePrefixFromIdentity: slug ganha do nome', () => {
    expect(derivePrefixFromIdentity({ slug: 'jka-teste', name: 'Outra Coisa Qualquer' })).toBe('JKA');
    expect(derivePrefixFromIdentity({ name: 'Federacao Paulista de Karate Tradicional' })).toBe('FPKT');
    // Palavras de ligação (de, do, da, e) não entram nas iniciais.
    expect(derivePrefixFromIdentity({ name: 'Liga de Karate do Sul' })).toBe('LKS');
    expect(derivePrefixFromIdentity({})).toBeNull();
  });
});
