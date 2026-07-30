// ============================================================
// AURA DOJÔ — F7.2: sincronização contínua dojô → federação (unitário)
//
// Por que UNITÁRIO e não só integração: o que este PR decide é uma REGRA
// (o que sobe, o que nunca sobe, e o que acontece com campo vazio). Regra
// se testa direto, com um client de transação de mentira — sem Express,
// sem token, sem fila de mocks para desalinhar.
//
// ⚠️ MOCK POR SQL (o client despacha por matcher), NUNCA fila posicional:
// a ordem interna do sync (SAVEPOINT → SELECT → UPDATE → trilha → RELEASE)
// é detalhe de implementação e não pode virar contrato de teste.
// Matcher pode ser regex OU função — algumas queries só se distinguem por
// DOIS pedaços da SQL (mesma convenção de karateDojoFederate.test.js).
// ============================================================
'use strict';

const sync = require('../../src/services/karateIdentitySync');
const { IDENTITY_FIELDS } = require('../../src/services/karateStudentIdentityLink');

const dojoId = 'd0000000-0000-0000-0000-000000000002';
const outroDojoId = 'd0000000-0000-0000-0000-000000000003';
const fedId = 'fed00000-0000-0000-0000-000000000001';
const sid = 'a1000000-0000-0000-0000-00000000000a';

const matches = (m, s) => (typeof m === 'function' ? Boolean(m(s)) : m.test(s));

// Client de transação de mentira. `dispatch(sql, params)` devolve o
// resultado OU um Error (que é lançado, para simular falha do banco).
function fakeClient(dispatch = () => null) {
  const client = {
    query: jest.fn(async (sql, params) => {
      const r = dispatch(String(sql), params);
      if (r instanceof Error) throw r;
      return r || { rows: [] };
    }),
  };
  client.sqls = () => client.query.mock.calls.map((c) => String(c[0]));
  client.find = (m) => client.query.mock.calls.find((c) => matches(m, String(c[0])));
  client.count = (m) => client.sqls().filter((s) => matches(m, s)).length;
  client.hit = (m) => client.count(m) > 0;
  return client;
}

const isCandidate = (s) => /FROM customers c/.test(s) && /karate_identity_managed_by = 'dojo'/.test(s);
const isBatchCandidate = (s) => /JOIN customers c ON c\.id = s\.practitioner_id/.test(s);
const isFedUpdate = (s) => /^UPDATE customers SET/.test(s.trim());
const isAudit = (s) => /INSERT INTO karate_identity_audit/.test(s);

// Ficha do ALUNO como o RETURNING do UPDATE devolve (colunas do dojô).
const studentRow = (over = {}) => ({
  id: sid,
  full_name: 'João Praticante',
  birth_date: '1995-04-12',
  cpf: '52998224725',
  rg: '1234567',
  sex: 'M',
  phone: '91999990000',
  email: 'aluno@exemplo.com',
  zip_code: '66000000',
  street: 'Av. Nazaré',
  number: '100',
  complement: null,
  neighborhood: 'Nazaré',
  city: 'Belém',
  state: 'PA',
  photo_url: null,
  karate_photo_url: 'https://cdn/foto.jpg',
  ...over,
});

// Ficha do PRATICANTE como o SELECT de candidato devolve (aliases = key).
const fedRow = (over = {}) => ({
  practitioner_id: 'p1',
  practitioner_label: 'João Praticante',
  fpkt_number: 'FPKT-123',
  full_name: 'João Praticante',
  birth_date: '1995-04-12',
  cpf: '52998224725',
  rg: '1234567',
  sex: 'masculino', // vocabulário canônico da federação
  phone: '91999990000',
  email: 'aluno@exemplo.com',
  zip_code: '66000000',
  street: 'Av. Nazaré',
  number: '100',
  complement: null,
  neighborhood: 'Nazaré',
  city: 'Belém',
  state: 'PA',
  photo_url: 'https://cdn/foto.jpg',
  ...over,
});

const run = (client, over = {}) =>
  sync.syncStudentIdentity(client, {
    dojoId,
    federationId: fedId,
    studentId: sid,
    practitionerId: 'p1',
    student: studentRow(),
    actor: { userId: 'u1', label: 'sensei@dojo.com.br' },
    ...over,
  });

// ════════════════════════════════════════════════════════════
// O QUE NUNCA SOBE
// ════════════════════════════════════════════════════════════
describe('F7.2 — a federação continua dona do que ela EMITE', () => {
  test('nenhum campo da lista de identidade aponta para coluna da federação', () => {
    // A guarda roda no require; aqui ela é AFIRMADA, para o dia em que
    // alguém acrescentar um campo novo a IDENTITY_FIELDS.
    expect(() => sync.assertIdentityFieldsAreSafe()).not.toThrow();
    const fedCols = IDENTITY_FIELDS.map((f) => f.fedCol);
    for (const proibida of sync.FEDERATION_OWNED_COLS) {
      expect(fedCols).not.toContain(proibida);
    }
    // e o inverso: matrícula, papéis, filiação e faixa estão de fato na
    // lista de proibidos (não basta "não estar na de identidade").
    for (const c of ['karate_registration_number', 'is_arbiter', 'is_instructor', 'is_active', 'dojo_id']) {
      expect(sync.FEDERATION_OWNED_COLS).toContain(c);
    }
  });

  test('o UPDATE gerado só mexe em identidade — matrícula, papéis, faixa e dojo_id nunca aparecem', async () => {
    const client = fakeClient((s) => {
      if (isCandidate(s)) return { rows: [fedRow({ phone: '91888880000', city: 'Ananindeua' })] };
      if (isFedUpdate(s)) return { rows: [{ id: 'p1' }] };
      return null;
    });

    const res = await run(client);
    expect(res.status).toBe('ok');
    expect(res.synced).toBe(true);

    const upd = String(client.find(isFedUpdate)[0]);
    const setClause = upd.split('WHERE')[0]; // o WHERE cita as colunas de gestão de propósito
    for (const proibida of sync.FEDERATION_OWNED_COLS) {
      expect(setClause).not.toContain(`${proibida} =`);
    }
    expect(setClause).toContain('phone =');
    expect(setClause).toContain('city =');
  });
});

// ════════════════════════════════════════════════════════════
// SÓ FICHA ADOTADA PELO DOJÔ CERTO
// ════════════════════════════════════════════════════════════
describe('F7.2 — sync só acontece com ficha adotada por ESTE dojô', () => {
  test('praticante gerido pela FEDERAÇÃO não é tocado (os 9.783 seguem intactos)', async () => {
    // O guarda está no WHERE: managed_by='dojo'. Ficha da federação não
    // volta na consulta → nada a fazer, nenhum UPDATE.
    const client = fakeClient((s) => (isCandidate(s) ? { rows: [] } : null));

    const res = await run(client);
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('NOT_ADOPTED_BY_THIS_DOJO');
    expect(client.hit(isFedUpdate)).toBe(false);
    expect(client.hit(isAudit)).toBe(false);
    expect(client.sqls()).toContain('RELEASE SAVEPOINT sp_identity_sync');
  });

  test('o dojô do TOKEN entra na consulta — não dá para sincronizar ficha de outro dojô', async () => {
    const client = fakeClient((s) => (isCandidate(s) ? { rows: [] } : null));
    await run(client, { dojoId: outroDojoId });

    const sel = client.find(isCandidate);
    expect(String(sel[0])).toContain("karate_identity_managed_by = 'dojo'");
    expect(String(sel[0])).toContain('karate_identity_dojo_id = $2');
    expect(sel[1]).toEqual(['p1', outroDojoId]);
  });

  test('aluno sem practitioner_id não custa nem uma query', async () => {
    const client = fakeClient();
    const res = await sync.syncStudentIdentity(client, {
      dojoId, studentId: sid, practitionerId: null, student: studentRow(),
    });
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('NO_PRACTITIONER');
    expect(client.query).not.toHaveBeenCalled();
  });

  test('fichas já iguais: nenhuma escrita, nenhuma trilha (idempotente)', async () => {
    const client = fakeClient((s) => (isCandidate(s) ? { rows: [fedRow()] } : null));
    const res = await run(client);
    expect(res.status).toBe('ok');
    expect(res.synced).toBe(false);
    expect(res.reason).toBe('ALREADY_IN_SYNC');
    expect(client.hit(isFedUpdate)).toBe(false);
    expect(client.hit(isAudit)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════
// A DECISÃO MAIS PERIGOSA DA FASE: CAMPO ESVAZIADO
// ════════════════════════════════════════════════════════════
describe('F7.2 — vazio no dojô NÃO apaga a federação', () => {
  test('sensei apaga o telefone do aluno → o telefone do praticante continua lá', async () => {
    const client = fakeClient((s) => {
      if (isCandidate(s)) return { rows: [fedRow()] };
      if (isFedUpdate(s)) return { rows: [{ id: 'p1' }] };
      return null;
    });

    const res = await run(client, { student: studentRow({ phone: null }) });

    // Nada mudou além disso, e "isso" é justamente o que NÃO sobe.
    expect(res.synced).toBe(false);
    expect(client.hit(isFedUpdate)).toBe(false);
  });

  test('o caso real: aluno de antes da 262 (sem RG/endereço) não apaga o cadastro da federação', async () => {
    const client = fakeClient((s) => {
      if (isCandidate(s)) return { rows: [fedRow({ phone: '91777770000' })] };
      if (isFedUpdate(s)) return { rows: [{ id: 'p1' }] };
      return null;
    });

    // Aluno antigo: só nome/nascimento/cpf/telefone; RG e endereço vazios.
    const antigo = studentRow({
      rg: null, zip_code: null, street: null, number: null,
      complement: null, neighborhood: null, city: null, state: null,
      karate_photo_url: null, photo_url: null,
    });

    const res = await run(client, { student: antigo });

    // Só o telefone (que o dojô TEM e diverge) sobe. RG e endereço da
    // federação ficam de fora do SET — que é o ponto inteiro da regra.
    expect(res.fields).toEqual(['phone']);
    const setClause = String(client.find(isFedUpdate)[0]).split('WHERE')[0];
    expect(setClause).toContain('phone =');
    for (const col of ['rg', 'zip_code', 'street', 'city', 'state', 'karate_photo_url']) {
      expect(setClause).not.toContain(`${col} =`);
    }
  });

  test('planSync: vencedor vazio é sempre pulado, campo a campo', () => {
    // Dojô vazio em TUDO, federação preenchida em tudo → zero escrita.
    const plan = sync.planSync(() => null, () => 'valor da federação');
    expect(plan.writes).toEqual([]);
    expect(plan.changes).toEqual([]);
  });

  test('string só com espaço também é vazio (não apaga)', () => {
    const plan = sync.planSync(() => '   ', () => 'João');
    expect(plan.writes).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════
// VOCABULÁRIO E TRILHA
// ════════════════════════════════════════════════════════════
describe('F7.2 — o que sobe, sobe no vocabulário da federação', () => {
  test('sexo do dojô (F) vira o canônico (feminino) e CEP/UF são normalizados', async () => {
    const client = fakeClient((s) => {
      if (isCandidate(s)) return { rows: [fedRow({ sex: 'masculino', zip_code: null, state: 'AM' })] };
      if (isFedUpdate(s)) return { rows: [{ id: 'p1' }] };
      return null;
    });

    await run(client, { student: studentRow({ sex: 'F', zip_code: '66.000-000', state: 'pa' }) });

    const [sql, vals] = client.find(isFedUpdate);
    const setClause = String(sql).split('WHERE')[0];
    const idx = (col) => Number(setClause.match(new RegExp(`${col} = \\$(\\d+)`))[1]) - 1;

    expect(vals[idx('sex')]).toBe('feminino');   // nunca 'F' em customers
    expect(vals[idx('zip_code')]).toBe('66000000');
    expect(vals[idx('state')]).toBe('PA');
  });

  test('trilha registra antes e depois, com action=sync e o ator do token', async () => {
    const client = fakeClient((s) => {
      if (isCandidate(s)) return { rows: [fedRow({ phone: '91777770000' })] };
      if (isFedUpdate(s)) return { rows: [{ id: 'p1' }] };
      return null;
    });

    await run(client);

    const audit = client.find(isAudit);
    expect(audit).toBeDefined();
    const p = audit[1];
    expect(p[7]).toBe('sync');      // action
    expect(p[8]).toBe('sync_job');  // source permitido pelo CHECK da 263
    const changes = JSON.parse(p[9]);
    const phone = changes.find((c) => c.field === 'phone');
    expect(phone).toMatchObject({
      winner: 'dojo',
      federation_before: '91777770000',
      federation_after: '91999990000',
      dojo_before: '91999990000',
      dojo_after: '91999990000',
    });
    expect(p[11]).toBe('sensei@dojo.com.br'); // actor_label
  });

  test('sync sem trilha não acontece: trilha impossível descarta a escrita', async () => {
    const client = fakeClient((s) => {
      if (isCandidate(s)) return { rows: [fedRow({ phone: '91777770000' })] };
      if (isFedUpdate(s)) return { rows: [{ id: 'p1' }] };
      if (isAudit(s)) return Object.assign(new Error('relation "karate_identity_audit" does not exist'), { code: '42P01' });
      // fallback roster_events também indisponível
      if (/INSERT INTO karate_dojo_roster_events/.test(s)) {
        return Object.assign(new Error('relation "karate_dojo_roster_events" does not exist'), { code: '42P01' });
      }
      return null;
    });

    const res = await run(client);
    expect(res.status).toBe('failed');
    expect(client.sqls()).toContain('ROLLBACK TO SAVEPOINT sp_identity_sync');
  });
});

// ════════════════════════════════════════════════════════════
// FALHA DO SYNC NÃO DERRUBA O SALVAMENTO
// ════════════════════════════════════════════════════════════
describe('F7.2 — falha isolada por SAVEPOINT (nunca ROLLBACK da transação)', () => {
  test('erro no UPDATE da federação → ROLLBACK TO SAVEPOINT, status failed, sem exceção', async () => {
    const client = fakeClient((s) => {
      if (isCandidate(s)) return { rows: [fedRow({ phone: '91777770000' })] };
      if (isFedUpdate(s)) return Object.assign(new Error('deadlock detected'), { code: '40P01' });
      return null;
    });

    const res = await run(client);

    expect(res.status).toBe('failed');
    expect(res.synced).toBe(false);
    expect(res.error_code).toBe('40P01');
    // Descarta SÓ o sync: quem commita é o chamador, e o UPDATE do aluno
    // (feito antes, fora deste módulo) sobrevive.
    expect(client.sqls()).toContain('ROLLBACK TO SAVEPOINT sp_identity_sync');
    expect(client.sqls()).not.toContain('ROLLBACK');
    expect(client.sqls()).not.toContain('COMMIT');
  });

  test('migration 262 pendente (42703) degrada para SCHEMA_PENDING, sem lançar', async () => {
    const client = fakeClient((s) => {
      if (isCandidate(s)) {
        return Object.assign(
          new Error('column "karate_identity_managed_by" does not exist'),
          { code: '42703' }
        );
      }
      return null;
    });

    const res = await run(client);
    expect(res.status).toBe('failed');
    expect(res.reason).toBe('SCHEMA_PENDING');
    expect(client.sqls()).toContain('ROLLBACK TO SAVEPOINT sp_identity_sync');
  });

  test('o sync NUNCA lança — nem quando o próprio rollback do savepoint falha', async () => {
    const client = fakeClient((s) => {
      if (isCandidate(s)) return Object.assign(new Error('connection terminated'), { code: '57P01' });
      if (/ROLLBACK TO SAVEPOINT/.test(s)) return new Error('connection terminated');
      return null;
    });

    await expect(run(client)).resolves.toMatchObject({ status: 'failed' });
  });
});

// ════════════════════════════════════════════════════════════
// LOTE — 500 LINHAS NÃO VIRAM 500 IDAS AO BANCO
// ════════════════════════════════════════════════════════════
describe('F7.2 — sync em lote (import)', () => {
  const batchRow = (id, over = {}) => {
    const row = {
      student_id: id,
      student_label: `Aluno ${id}`,
      practitioner_id: `p_${id}`,
      practitioner_label: `Prat ${id}`,
      fpkt_number: `FPKT-${id}`,
    };
    const d = studentRow();
    const f = fedRow();
    for (const field of IDENTITY_FIELDS) {
      row[`d_${field.key}`] = d[field.dojoCol] != null ? d[field.dojoCol] : null;
      row[`f_${field.key}`] = f[field.key] != null ? f[field.key] : null;
    }
    return Object.assign(row, over);
  };

  test('lista vazia → ZERO query (é o caso de todo import de hoje)', async () => {
    const client = fakeClient();
    const res = await sync.syncStudentsBatch(client, { dojoId, studentIds: [] });
    expect(res.status).toBe('ok');
    expect(res.synced).toBe(0);
    expect(client.query).not.toHaveBeenCalled();
  });

  test('N alunos → UMA query de candidatos e UPDATE só em quem diverge', async () => {
    const rows = [
      batchRow('s1', { d_phone: '91111110000', f_phone: '91999990000' }), // diverge
      batchRow('s2'),                                                     // igual
      batchRow('s3', { d_city: 'Ananindeua', f_city: 'Belém' }),          // diverge
    ];
    const client = fakeClient((s) => {
      if (isBatchCandidate(s)) return { rows };
      if (isFedUpdate(s)) return { rows: [{ id: 'x' }] };
      return null;
    });

    const res = await sync.syncStudentsBatch(client, {
      dojoId, federationId: fedId, studentIds: ['s1', 's2', 's3'], actor: { userId: 'u1', label: 'sensei' },
    });

    expect(res.status).toBe('ok');
    expect(res.checked).toBe(3);
    expect(res.synced).toBe(2); // o que já estava igual não gera escrita

    // A ASSERÇÃO QUE IMPORTA: candidatos em UMA query só, não uma por aluno.
    expect(client.count(isBatchCandidate)).toBe(1);
    expect(client.find(isBatchCandidate)[1]).toEqual([['s1', 's2', 's3'], dojoId]);
    expect(String(client.find(isBatchCandidate)[0])).toContain('s.id = ANY($1::uuid[])');

    // 2 UPDATEs (um por ficha divergente), nunca 3.
    expect(client.count(isFedUpdate)).toBe(2);
    // trilha por ficha sincronizada, com o source do lote
    const audits = client.query.mock.calls.filter((c) => isAudit(String(c[0])));
    expect(audits.length).toBe(2);
    expect(audits[0][1][8]).toBe('import');
  });

  test('escopo do lote: só alunos DESTE dojô e só fichas adotadas por ele', async () => {
    const client = fakeClient((s) => (isBatchCandidate(s) ? { rows: [] } : null));
    await sync.syncStudentsBatch(client, { dojoId, studentIds: ['s1'] });

    const sql = String(client.find(isBatchCandidate)[0]);
    expect(sql).toContain('s.dojo_id = $2');
    expect(sql).toContain("c.karate_identity_managed_by = 'dojo'");
    expect(sql).toContain('c.karate_identity_dojo_id = $2');
    expect(sql).toContain('FOR UPDATE OF c');
  });

  test('falha no lote descarta só o lote (SAVEPOINT próprio), sem lançar', async () => {
    const client = fakeClient((s) => {
      if (isBatchCandidate(s)) return Object.assign(new Error('boom'), { code: '42703' });
      return null;
    });

    const res = await sync.syncStudentsBatch(client, { dojoId, studentIds: ['s1'] });
    expect(res.status).toBe('failed');
    expect(res.synced).toBe(0);
    expect(client.sqls()).toContain('ROLLBACK TO SAVEPOINT sp_identity_sync_batch');
    expect(client.sqls()).not.toContain('ROLLBACK');
  });
});
