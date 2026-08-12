// ============================================================
// AURA DOJÔ — F11: regressão do 500 da PRIMEIRA ASSUNÇÃO REAL (11/08/2026)
//
// O aceite com `target_company_id` devolvia 500 genérico e derrubava a
// transação inteira — nada gravado, pedido ainda `pending`. A causa não
// estava em nenhuma validação nem em nenhuma escrita de negócio: estava na
// TRILHA. `uq_karate_dojo_registry_assumptions_request` (migration 275) é
// um índice único PARCIAL (`WHERE request_id IS NOT NULL`), e o INSERT
// declarava `ON CONFLICT (request_id)` sem predicado. O Postgres não infere
// índice parcial sem o WHERE: devolve 42P10.
//
// Estes testes fecham as duas travas do fix:
//   1. a especificação REPETE o predicado do índice;
//   2. os passos de TRILHA toleram 42P10 (o log não derruba o ato), mas os
//      passos que MOVEM DADOS continuam estritos — degradar lá em silêncio
//      perderia trabalho do sensei.
//
// ⚠️ MOCK POR SQL, nunca fila posicional (convenção deste repo): o client
// falso decide o que devolver LENDO a query, então inserir/remover um passo
// no serviço não quebra o teste por deslocamento de índice.
// ============================================================
'use strict';

const svc = require('../../src/services/karateDojoRegistryAssumptionService');

// ids de fixture em uuid hex válido (actor_id/uuid entram em coluna uuid)
const FED = '11111111-1111-4111-8111-111111111111';
const REQUEST = '22222222-2222-4222-8222-222222222222';
const FROM_CO = '33333333-3333-4333-8333-333333333333';
const TO_CO = '44444444-4444-4444-8444-444444444444';
const SENSEI = '55555555-5555-4555-8555-555555555555';
const ACTOR = '66666666-6666-4666-8666-666666666666';

const RESULT = Object.freeze({
  from_company_id: FROM_CO,
  from_company_name: 'DOJO NOVO DO SENSEI',
  to_company_id: TO_CO,
  to_company_name: 'ESCOLA DE KARATE AREIKAN',
  user_id: SENSEI,
  from_company_was_empty: true,
  from_company_discarded: true,
  migrated: {},
  kept_at_source: {},
  schema_pending: [],
  migrated_rows: 0,
});

function pgError(code, message) {
  const e = new Error(message || `erro pg ${code}`);
  e.code = code;
  return e;
}

// Client falso: roteia POR CONTEÚDO DA QUERY. `failures` mapeia um trecho de
// SQL para o erro que aquele passo deve lançar.
function makeClient(failures) {
  const sqls = [];
  const fails = failures || {};
  return {
    sqls,
    query: jest.fn(async (sql) => {
      const text = String(sql);
      sqls.push(text);
      for (const marker of Object.keys(fails)) {
        if (text.includes(marker)) throw fails[marker];
      }
      if (/^\s*(SAVEPOINT|RELEASE|ROLLBACK)/i.test(text)) return { rows: [], rowCount: 0 };
      if (text.includes('assumption:trail')) {
        return { rows: [{ id: '77777777-7777-4777-8777-777777777777' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
}

function trailSql(client) {
  return client.sqls.find((s) => s.includes('assumption:trail')) || '';
}

describe('F11 — trilha da assunção do registro federativo', () => {
  test('o INSERT da trilha repete o predicado do índice PARCIAL da 275', async () => {
    const client = makeClient();
    const out = await svc.writeAssumptionTrail(client, {
      federationId: FED,
      requestId: REQUEST,
      result: RESULT,
      actorId: ACTOR,
      fpktNumber: 'FPKT-137',
    });

    const sql = trailSql(client);
    expect(sql).toContain('karate_dojo_registry_assumptions');
    // O ponto do bug: sem este WHERE o Postgres devolve 42P10.
    expect(sql).toMatch(/ON CONFLICT\s*\(request_id\)\s*WHERE\s+request_id\s+IS\s+NOT\s+NULL\s+DO\s+NOTHING/i);
    expect(out.trail_persisted).toBe(true);
  });

  test('42P10 na trilha DEGRADA — o aceite não cai por causa do log', async () => {
    const client = makeClient({
      'assumption:trail': pgError(
        '42P10',
        'there is no unique or exclusion constraint matching the ON CONFLICT specification'
      ),
    });

    const out = await svc.writeAssumptionTrail(client, {
      federationId: FED,
      requestId: REQUEST,
      result: RESULT,
      actorId: ACTOR,
      fpktNumber: 'FPKT-137',
    });

    expect(out.trail_persisted).toBe(false);
    // degradar é voltar ao SAVEPOINT, nunca envenenar a transação
    expect(client.sqls.some((s) => /ROLLBACK TO SAVEPOINT/i.test(s))).toBe(true);
  });

  test('42P01 (migration 275 não aplicada) também degrada', async () => {
    const client = makeClient({
      'assumption:trail': pgError('42P01', 'relation "karate_dojo_registry_assumptions" does not exist'),
    });
    const out = await svc.writeAssumptionTrail(client, {
      federationId: FED,
      requestId: REQUEST,
      result: RESULT,
      actorId: ACTOR,
      fpktNumber: 'FPKT-137',
    });
    expect(out.trail_persisted).toBe(false);
  });

  test('erro de verdade na trilha SOBE (não vira degradação silenciosa)', async () => {
    const client = makeClient({
      'assumption:trail': pgError('23503', 'insert or update violates foreign key constraint'),
    });
    await expect(
      svc.writeAssumptionTrail(client, {
        federationId: FED,
        requestId: REQUEST,
        result: RESULT,
        actorId: ACTOR,
        fpktNumber: 'FPKT-137',
      })
    ).rejects.toMatchObject({ code: '23503' });
  });

  test('actor_id não-uuid vai NULL na coluna e cru em actor_ref (não derruba o aceite)', async () => {
    const client = makeClient();
    await svc.writeAssumptionTrail(client, {
      federationId: FED,
      requestId: REQUEST,
      result: RESULT,
      actorId: 'staff1',
      fpktNumber: 'FPKT-137',
    });
    const call = client.query.mock.calls.find((c) => String(c[0]).includes('assumption:trail'));
    const params = call[1];
    expect(params[5]).toBeNull();      // actor_id (uuid)
    expect(params[6]).toBe('staff1');  // actor_ref (text)
  });
});

describe('F11 — safeStep: a tolerância a 42P10 é EXCLUSIVA da trilha', () => {
  test('sem extraCodes, 42P10 SOBE (passo de migração de dados é estrito)', async () => {
    const client = makeClient();
    await expect(
      svc.safeStep(client, 'mover karate_dojo_students', () => {
        throw pgError('42P10', 'no unique or exclusion constraint');
      })
    ).rejects.toMatchObject({ code: '42P10' });
  });

  test('com extraCodes ["42P10"], degrada e devolve null', async () => {
    const client = makeClient();
    const out = await svc.safeStep(
      client,
      'trilha',
      () => {
        throw pgError('42P10', 'no unique or exclusion constraint');
      },
      svc.TRAIL_TOLERATED_CODES
    );
    expect(out).toBeNull();
  });

  test('42P01/42703 degradam sempre, com ou sem extraCodes', async () => {
    const client = makeClient();
    for (const code of svc.SCHEMA_PENDING_CODES) {
      // eslint-disable-next-line no-await-in-loop
      const out = await svc.safeStep(client, `schema ${code}`, () => {
        throw pgError(code);
      });
      expect(out).toBeNull();
    }
  });
});
