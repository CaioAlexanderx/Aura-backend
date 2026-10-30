// ============================================================
// AURA. — POST /products/barcodes/generate (p-74, 30/10/2026)
// Testes com banco simulado. Postgres real (grupo, gravação e
// concorrência) em __tests__/gerarEan13*.banco.test.js.
// ============================================================
const express = require('express');
const request = require('supertest');

const { codigoDaSerie, digitoVerificadorEan13, CONTADOR_MAX } = require('../../src/services/gerarEan13');
const { validateEAN13 } = require('../../src/services/barcode');
const router = require('../../src/routes/productsBarcodeGenerate');

let db;
beforeAll(() => { db = require('../../src/config/database'); });

const cid = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const P = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const V = (n) => `11111111-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Banco de mentira: produtos visíveis, variantes ativas, o maior número
// da série no grupo e os códigos já usados no grupo.
function fakeDb({ produtos = {}, variantes = {}, maxN = 0, usados = [], perdeCorrida = [], erroUpdate = null } = {}) {
  const log = [];
  const client = {
    query: jest.fn(async (sql, params) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      log.push({ s, params });
      if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|ROLLBACK TO)/.test(s)) return { rows: [] };
      if (s.includes('pg_advisory_xact_lock')) return { rows: [{}] };
      if (s.startsWith('SELECT p.id, p.barcode FROM products p')) {
        return { rows: params[1].filter((id) => produtos[id]).map((id) => ({ id, barcode: produtos[id].barcode ?? null })) };
      }
      if (s.startsWith('SELECT pv.id, pv.product_id, pv.barcode FROM product_variants pv')) {
        return { rows: params[0].filter((id) => variantes[id]).map((id) => ({ id, ...variantes[id] })) };
      }
      if (s.includes('MAX(substr(t.code, 4, 9)::bigint)')) return { rows: [{ max_n: String(maxN) }] };
      if (s.includes('barcode = ANY($2::text[])')) {
        return { rows: params[1].filter((c) => usados.includes(c)).map((code) => ({ code })) };
      }
      if (s.startsWith('UPDATE products p')) {
        if (erroUpdate) throw erroUpdate;
        return { rows: params[0].filter((id) => !perdeCorrida.includes(id)).map((id) => ({ id })) };
      }
      if (s.startsWith('UPDATE product_variants pv')) {
        return { rows: params[0].filter((id) => !perdeCorrida.includes(id)).map((id) => ({ id })) };
      }
      if (s.startsWith('INSERT INTO audit_log')) return { rows: [] };
      throw new Error('SQL inesperado no teste: ' + s.slice(0, 80));
    }),
    release: jest.fn(),
  };
  db.connect.mockImplementation(async () => client);
  return { client, log, sqls: () => log.map((l) => l.s) };
}

function appCom({ role = 'client', companyRole = 'owner' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 'u1', role }; req.companyRole = companyRole; next(); });
  app.use('/companies/:id/products', router);
  return app;
}
const url = `/companies/${cid}/products/barcodes/generate`;

beforeEach(() => { jest.resetAllMocks(); });

describe('dígito verificador e série', () => {
  test('EAN-13 conhecido', () => {
    expect(digitoVerificadorEan13('400638133393')).toBe(1);
    expect(digitoVerificadorEan13('789123456789')).toBe(5);
  });

  test('série 210 + contador de 9 dígitos + DV, sempre EAN-13 válido', () => {
    expect(codigoDaSerie(1)).toBe('2100000000012');
    for (const n of [1, 2, 9, 10, 99, 12345, 987654321, CONTADOR_MAX]) {
      const c = codigoDaSerie(n);
      expect(c).toMatch(/^210\d{10}$/);
      expect(validateEAN13(c)).toBe(true);
    }
    expect(() => codigoDaSerie(0)).toThrow();
    expect(() => codigoDaSerie(CONTADOR_MAX + 1)).toThrow();
  });
});

describe('POST /products/barcodes/generate', () => {
  test('dry_run: devolve a prévia e não grava, não trava, não audita', async () => {
    const f = fakeDb({ produtos: { [P(1)]: {}, [P(2)]: {} }, maxN: 0 });
    const r = await request(appCom()).post(url).send({
      targets: [{ product_id: P(1), variant_id: null }, { product_id: P(2) }], dry_run: true,
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      dry_run: true,
      items: [
        { product_id: P(1), variant_id: null, barcode: codigoDaSerie(1) },
        { product_id: P(2), variant_id: null, barcode: codigoDaSerie(2) },
      ],
      skipped: [],
    });
    const sqls = f.sqls();
    expect(sqls.some((s) => s.startsWith('UPDATE'))).toBe(false);
    expect(sqls.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(false);
    expect(sqls.some((s) => s.startsWith('INSERT INTO audit_log'))).toBe(false);
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
  });

  test('sem dry_run explícito é prévia', async () => {
    const f = fakeDb({ produtos: { [P(1)]: {} } });
    const r = await request(appCom()).post(url).send({ targets: [{ product_id: P(1) }] });
    expect(r.status).toBe(200);
    expect(r.body.dry_run).toBe(true);
    expect(f.sqls().some((s) => s.startsWith('UPDATE'))).toBe(false);
  });

  test('dry_run=false: trava por grupo, grava, audita e devolve o mesmo da prévia', async () => {
    const cenario = { produtos: { [P(1)]: {} }, variantes: { [V(1)]: { product_id: P(1), barcode: null } }, maxN: 41 };
    const alvo = { targets: [{ product_id: P(1), variant_id: V(1) }, { product_id: P(1), variant_id: null }] };

    fakeDb(cenario);
    const previa = await request(appCom()).post(url).send({ ...alvo, dry_run: true });

    const f = fakeDb(cenario);
    const r = await request(appCom()).post(url).send({ ...alvo, dry_run: false });
    expect(r.status).toBe(200);
    expect(r.body.dry_run).toBe(false);
    expect(r.body.items).toEqual(previa.body.items);
    expect(r.body.items.map((i) => i.barcode)).toEqual([codigoDaSerie(42), codigoDaSerie(43)]);

    const sqls = f.sqls();
    const lock = f.log.find((l) => l.s.includes('pg_advisory_xact_lock'));
    expect(lock.s).toContain('COALESCE(NULLIF(billing_owner_company_id, id), id)');
    expect(lock.params).toEqual([cid]);
    expect(sqls.findIndex((s) => s.includes('pg_advisory_xact_lock')))
      .toBeLessThan(sqls.findIndex((s) => s.includes('MAX(substr')));
    const upV = f.log.find((l) => l.s.startsWith('UPDATE product_variants'));
    expect(upV.params).toEqual([[V(1)], [codigoDaSerie(42)]]);
    expect(upV.s).toContain("(pv.barcode IS NULL OR btrim(pv.barcode) = '')");
    const upP = f.log.find((l) => l.s.startsWith('UPDATE products'));
    expect(upP.params).toEqual([[P(1)], [codigoDaSerie(43)]]);
    const audit = f.log.find((l) => l.s.startsWith('INSERT INTO audit_log'));
    expect(audit.params[0]).toBe('u1');
    expect(JSON.parse(audit.params[3])).toMatchObject({ gerados: 2, de_produto: 1, de_variante: 1 });
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
  });

  test('nunca sobrescreve: código existente (mesmo inválido) é ja_tem_codigo', async () => {
    fakeDb({
      produtos: { [P(1)]: { barcode: 'ABC-123' }, [P(2)]: { barcode: '7891234567895' }, [P(3)]: { barcode: '  ' } },
      variantes: { [V(1)]: { product_id: P(2), barcode: '123' } },
    });
    const r = await request(appCom()).post(url).send({
      dry_run: true,
      targets: [{ product_id: P(1) }, { product_id: P(2), variant_id: V(1) }, { product_id: P(3) }],
    });
    expect(r.body.items).toEqual([{ product_id: P(3), variant_id: null, barcode: codigoDaSerie(1) }]);
    expect(r.body.skipped).toEqual([
      { product_id: P(1), variant_id: null, reason: 'ja_tem_codigo' },
      { product_id: P(2), variant_id: V(1), reason: 'ja_tem_codigo' },
    ]);
  });

  test('nao_encontrado: produto fora da visibilidade, variante de outro produto, inativa, id inválido', async () => {
    fakeDb({
      produtos: { [P(1)]: {} },
      variantes: { [V(2)]: { product_id: P(9), barcode: null } },
    });
    const r = await request(appCom()).post(url).send({
      dry_run: true,
      targets: [
        { product_id: P(7) },                    // não visível
        { product_id: P(1), variant_id: V(2) },  // variante de outro produto
        { product_id: P(1), variant_id: V(3) },  // inativa / não existe
        { product_id: 'xpto' },
        { product_id: P(1) }, { product_id: P(1), variant_id: null }, // repetido conta uma vez
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([{ product_id: P(1), variant_id: null, barcode: codigoDaSerie(1) }]);
    expect(r.body.skipped.map((s) => s.reason)).toEqual(['nao_encontrado', 'nao_encontrado', 'nao_encontrado', 'nao_encontrado']);
  });

  test('colisão: candidato já usado no grupo (produto ou variante) é pulado', async () => {
    const f = fakeDb({ produtos: { [P(1)]: {}, [P(2)]: {} }, maxN: 4, usados: [codigoDaSerie(5)] });
    const r = await request(appCom()).post(url).send({ dry_run: true, targets: [{ product_id: P(1) }, { product_id: P(2) }] });
    expect(r.body.items.map((i) => i.barcode)).toEqual([codigoDaSerie(6), codigoDaSerie(7)]);
    const conf = f.log.filter((l) => l.s.includes('barcode = ANY($2::text[])'));
    expect(conf[0].s).toContain('FROM product_variants pv');
    expect(conf[0].s).toContain('COALESCE(NULLIF(billing_owner_company_id, id), id)');
    // máximo e conferência olham o grupo inteiro, com o id da empresa
    expect(f.log.find((l) => l.s.includes('MAX(substr')).s).toContain('FROM product_variants pv');
  });

  test('corrida com outra tela: quem ganhou um código no meio vira ja_tem_codigo', async () => {
    fakeDb({ produtos: { [P(1)]: {}, [P(2)]: {} }, perdeCorrida: [P(2)] });
    const r = await request(appCom()).post(url).send({ dry_run: false, targets: [{ product_id: P(1) }, { product_id: P(2) }] });
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([{ product_id: P(1), variant_id: null, barcode: codigoDaSerie(1) }]);
    expect(r.body.skipped).toEqual([{ product_id: P(2), variant_id: null, reason: 'ja_tem_codigo' }]);
  });

  test('UNIQUE do banco estourou: 409 e nada gravado', async () => {
    const f = fakeDb({ produtos: { [P(1)]: {} }, erroUpdate: Object.assign(new Error('dup'), { code: '23505' }) });
    const r = await request(appCom()).post(url).send({ dry_run: false, targets: [{ product_id: P(1) }] });
    expect(r.status).toBe(409);
    expect(f.sqls()).toContain('ROLLBACK');
    expect(f.sqls()).not.toContain('COMMIT');
    expect(f.client.release).toHaveBeenCalled();
  });

  test('validação: sem targets ou mais de 500 -> 400', async () => {
    fakeDb();
    expect((await request(appCom()).post(url).send({ targets: [] })).status).toBe(400);
    const muitos = Array.from({ length: 501 }, (_, i) => ({ product_id: P(i) }));
    expect((await request(appCom()).post(url).send({ targets: muitos })).status).toBe(400);
    expect(db.connect).not.toHaveBeenCalled();
  });
});

describe('permissão: quem pode editar produto', () => {
  const corpo = { dry_run: true, targets: [{ product_id: P(1) }] };

  test('membro sem a tela Estoque -> 403 sem_permissao, sem abrir transação', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ is_owner: false, role_label: 'caixa', permissions: { pdv: true, painel: false } }] });
    fakeDb({ produtos: { [P(1)]: {} } });
    const r = await request(appCom({ companyRole: 'caixa' })).post(url).send(corpo);
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe('sem_permissao');
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('membro com permissions {} (vendedor) -> 403', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ is_owner: false, role_label: 'vendedor', permissions: '{}' }] });
    const r = await request(appCom({ companyRole: 'vendedor' })).post(url).send(corpo);
    expect(r.status).toBe(403);
  });

  test('membro com Estoque liberado -> 200', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ is_owner: false, role_label: 'colaborador', permissions: { estoque: true } }] });
    fakeDb({ produtos: { [P(1)]: {} } });
    const r = await request(appCom({ companyRole: 'colaborador' })).post(url).send(corpo);
    expect(r.status).toBe(200);
  });

  test('membro sem restrição gravada (permissions null) -> 200', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ is_owner: false, role_label: 'gerente', permissions: null }] });
    fakeDb({ produtos: { [P(1)]: {} } });
    const r = await request(appCom({ companyRole: 'gerente' })).post(url).send(corpo);
    expect(r.status).toBe(200);
  });

  test('dono e admin da plataforma passam sem consultar membro', async () => {
    fakeDb({ produtos: { [P(1)]: {} } });
    expect((await request(appCom({ companyRole: 'owner' })).post(url).send(corpo)).status).toBe(200);
    fakeDb({ produtos: { [P(1)]: {} } });
    expect((await request(appCom({ role: 'admin', companyRole: undefined })).post(url).send(corpo)).status).toBe(200);
    expect(db.query).not.toHaveBeenCalled();
  });
});
