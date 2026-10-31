jest.mock('../../src/services/extraSeats', () => ({ getExtraSeatsForCompany: jest.fn() }));

const { getExtraSeatsForCompany } = require('../../src/services/extraSeats');
const { planoOuAssentoExtra } = require('../../src/middleware/planoOuAssentoExtra');

function chamar(req) {
  const gate = planoOuAssentoExtra('negocio', 'expansao');
  const res = { status: jest.fn(function () { return res; }), json: jest.fn(function () { return res; }) };
  const next = jest.fn();
  return gate(req, res, next).then(() => ({ res, next }));
}

describe('planoOuAssentoExtra', () => {
  beforeEach(() => getExtraSeatsForCompany.mockReset());

  test('plano com equipe passa sem consultar acessos extras', async () => {
    const { next } = await chamar({ user: { plan: 'negocio' }, params: { id: 'c1' } });
    expect(next).toHaveBeenCalled();
    expect(getExtraSeatsForCompany).not.toHaveBeenCalled();
  });

  test('Essencial com acesso extra pago passa', async () => {
    getExtraSeatsForCompany.mockResolvedValue(1);
    const { next, res } = await chamar({ user: { plan: 'essencial' }, params: { id: 'c1' } });
    expect(getExtraSeatsForCompany).toHaveBeenCalledWith('c1');
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('Essencial sem acesso extra recebe o mesmo 403 de antes', async () => {
    getExtraSeatsForCompany.mockResolvedValue(0);
    const { next, res } = await chamar({ user: { plan: 'essencial' }, params: { id: 'c1' } });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Plano atual não inclui esta funcionalidade',
      required_plans: ['negocio', 'expansao'],
      current_plan: 'essencial',
    });
  });

  test('falha na leitura nega', async () => {
    getExtraSeatsForCompany.mockRejectedValue(new Error('banco fora'));
    const { next, res } = await chamar({ user: { plan: 'essencial' }, params: { id: 'c1' } });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('sem usuario responde 401', async () => {
    const { res } = await chamar({ params: { id: 'c1' } });
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
