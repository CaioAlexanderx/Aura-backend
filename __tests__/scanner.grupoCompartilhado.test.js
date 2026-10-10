// 10/10/2026 — Davi Calçados Villa Branca: o Estoque mostrava os produtos
// da Matriz (compartilhados pelo grupo), mas o bipe no Caixa respondia
// "não achei" para todos eles. O /pdv/scan de scanner.js (o que responde em
// produção — é montado antes do pdv.js) só procurava em p.company_id=$1.
// Agora usa a mesma regra do pdv.js e da lista de produtos: produto da
// própria loja OU da dona do grupo marcado como compartilhado.
jest.mock('../src/config/database');
const db = require('../src/config/database');
const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'user-1' }; next(); },
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
}));

const scannerRouter = require('../src/routes/scanner');
const app = express();
app.use(express.json());
app.use('/companies/:id/pdv', scannerRouter);

const VILLA = 'villa-1';
const CODIGO = '7900123206385';
const REGRA_DO_GRUPO = 'p.company_id=c.billing_owner_company_id AND p.is_group_shared=TRUE';

beforeEach(() => { db.query = jest.fn(); });

const sqlDas = (calls) => calls.map(([sql]) => sql.replace(/\s+/g, ' '));

describe('GET /pdv/scan/:code · produto compartilhado pelo grupo', () => {
  it('acha a variante de um produto da Matriz bipada na loja filha', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/FROM product_variants pv/.test(sql) && /pv\.barcode=\$2/.test(sql)) {
        return { rows: [{ id: 'prod-matriz', name: 'Vizzano Tênis Samba 1430', price: '249.99',
          variant_id: 'var-39', sku_suffix: '39', price_override: null, stock_company_id: 'matriz-1' }] };
      }
      return { rows: [] };
    });
    const res = await request(app).get(`/companies/${VILLA}/pdv/scan/${CODIGO}`);
    expect(res.status).toBe(200);
    expect(res.body.match).toBe('exact');
    expect(res.body.source).toBe('variant_barcode');
    expect(res.body.variant_id).toBe('var-39');
    expect(res.body.product.stock_company_id).toBe('matriz-1');

    // Toda consulta do bipe olha a loja E a dona do grupo, com o id da loja.
    const sqls = sqlDas(db.query.mock.calls);
    expect(sqls.length).toBeGreaterThanOrEqual(2);
    for (const sql of sqls) {
      expect(sql).toContain('JOIN companies c ON c.id=$1');
      expect(sql).toContain(REGRA_DO_GRUPO);
      expect(sql).not.toMatch(/WHERE p\.company_id=\$1 AND/);
    }
    for (const [, params] of db.query.mock.calls) expect(params[0]).toBe(VILLA);
  });

  it('código que não existe em lugar nenhum continua 404', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app).get(`/companies/${VILLA}/pdv/scan/000`);
    expect(res.status).toBe(404);
    expect(res.body.match).toBe('none');
    // barcode, variante, sku e sugestão textual: todas com a regra do grupo
    const sqls = sqlDas(db.query.mock.calls);
    expect(sqls).toHaveLength(4);
    sqls.forEach((sql) => expect(sql).toContain(REGRA_DO_GRUPO));
  });

  it('o lote (/scan/batch) também enxerga o catálogo compartilhado', async () => {
    db.query.mockResolvedValue({ rows: [{ id: 'p1', barcode: CODIGO, sku: '7535', name: 'X' }] });
    const res = await request(app).post(`/companies/${VILLA}/pdv/scan/batch`).send({ codes: [CODIGO] });
    expect(res.status).toBe(200);
    expect(res.body.products[CODIGO].id).toBe('p1');
    const [sql, params] = db.query.mock.calls[0];
    expect(sql.replace(/\s+/g, ' ')).toContain(REGRA_DO_GRUPO);
    expect(params[0]).toBe(VILLA);
  });
});
