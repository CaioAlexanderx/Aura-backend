// ============================================================
// AURA KARATÊ — Testes: karateCardService.listCards expõe is_active do
// PRATICANTE (customers.is_active) sem mudar o default de listagem.
//
// Auditoria ativo/inativo (21/07/2026): a listagem admin de carteirinhas
// já fazia JOIN em customers (cu) mas nunca selecionava/devolvia
// cu.is_active — carteirinha de praticante inativo aparecia misturada sem
// marcação. Este teste cobre só o que a auditoria pediu: o campo aparece
// no retorno, SEM introduzir filtro nenhum (a listagem continua trazendo
// ativos e inativos juntos por padrão — decisão explícita da tarefa,
// diferente de belt-distribution/roster/anuidades, que default só ativos).
// `status` (kc.status, status da CARTEIRINHA) não é tocado.
//
// jest.setup.js já mocka src/config/database (db.query = jest.fn()).
// ============================================================
'use strict';

jest.mock('../src/config/database');
const db = require('../src/config/database');

const { listCards } = require('../src/services/karateCardService');

const FED_ID = 'fed-uuid-001';

beforeEach(() => jest.clearAllMocks());

describe('karateCardService.listCards — is_active do praticante', () => {
  it('devolve is_active=true/false por carteirinha, misturando ativos e inativos (SEM filtrar)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ total: '2' }] }) // COUNT
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'card-1', student_id: 's-1', is_minor: false, valid_until: '2027-01-01',
            status: 'active', issued_at: '2026-01-01', card_number: '001',
            belt_name: 'Branca', dojo_name: 'Dojô A', student_name: 'Praticante Ativo',
            practitioner_is_active: true,
          },
          {
            id: 'card-2', student_id: 's-2', is_minor: false, valid_until: '2027-01-01',
            status: 'active', issued_at: '2026-01-02', card_number: '002',
            belt_name: 'Amarela', dojo_name: 'Dojô A', student_name: 'Praticante Inativo',
            practitioner_is_active: false,
          },
        ],
      });

    const out = await listCards({ federation_id: FED_ID, page: 1, pageSize: 25 });

    expect(out.total).toBe(2);
    expect(out.data).toEqual([
      expect.objectContaining({ id: 'card-1', is_active: true }),
      expect.objectContaining({ id: 'card-2', is_active: false }),
    ]);

    // Não filtra por padrão: nenhum param novo relacionado a is_active do
    // praticante foi adicionado ao WHERE/params da query de linhas.
    const rowsCall = db.query.mock.calls[1];
    expect(rowsCall[0]).toMatch(/cu\.is_active AS practitioner_is_active/);
    expect(rowsCall[0]).not.toMatch(/WHERE[\s\S]*cu\.is_active\s*=/);
    expect(rowsCall[1]).toEqual([FED_ID, 25, 0]);
  });

  it('practitioner_is_active NULL/ausente é tratado como ativo (!== false)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ total: '1' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'card-3', student_id: 's-3', is_minor: true, valid_until: null,
          status: 'active', issued_at: '2026-01-03', card_number: '003',
          belt_name: null, dojo_name: 'Dojô B', student_name: 'Sem flag',
          practitioner_is_active: null,
        }],
      });

    const out = await listCards({ federation_id: FED_ID, page: 1, pageSize: 25 });
    expect(out.data[0].is_active).toBe(true);
  });

  it('filtro existente por kc.status (carteirinha) continua funcionando e não colide com is_active', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    await listCards({ federation_id: FED_ID, status: 'revoked', page: 1, pageSize: 25 });

    const countCall = db.query.mock.calls[0];
    expect(countCall[0]).toMatch(/kc\.status = \$2/);
    expect(countCall[1]).toEqual([FED_ID, 'revoked']);
  });
});
