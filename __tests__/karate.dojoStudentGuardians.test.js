// ============================================================
// AURA DOJÔ — F13: DOIS responsáveis por aluno (mãe E pai)
//
// "Vamos usar os dois contatos separados, penso que em um caso de
//  emergência com uma criança, é bom ter o contato de ambos." (Caio,
//  12/08/2026)
//
// O QUE ESTE ARQUIVO CONGELA
//   • menor com mãe E pai → DOIS vínculos, com o parentesco certo, e o
//     ÚNICO telefone da planilha no PRINCIPAL (o outro entra nomeado e
//     sem contato, com warning nominal);
//   • só mãe / só pai → um vínculo, principal, parentesco certo;
//   • adulto → NENHUM vínculo (mãe/pai continuam sendo só filiação) e o
//     contato fica no próprio aluno;
//   • irmãos → a MESMA linha de karate_dojo_guardians (a planilha real do
//     Areikan tem irmãos com o mesmo telefone; duplicar a mãe a cada filho
//     era exatamente o que a tabela escopada por dojô existe para evitar);
//   • reimportar o mesmo arquivo → nenhum vínculo novo;
//   • migration 280 pendente → SAVEPOINT segura o 42P01 e o lote inteiro
//     ainda entra (fica com o responsável principal, como antes da F13).
//
// MOCK POR ÂNCORA DE SQL, NUNCA POR FILA POSICIONAL. E o escopo é sempre
// confrontado com o DADO DA LINHA SIMULADA (g.dojo_id da fixture), nunca
// com a constante DOJO_ID do arquivo — comparar o parâmetro com a mesma
// constante que o teste passou seria tautologia: passaria mesmo que o
// handler não filtrasse por dojô nenhum.
//
// AS DUAS BUSCAS DE RESPONSÁVEL NÃO SE CANIBALIZAM: as duas começam com
// `SELECT id FROM karate_dojo_guardians`, então o despacho olha o que as
// DISTINGUE — `COALESCE(phone, '')` na busca exata (com telefone) e
// `ORDER BY (phone IS NOT NULL)` na busca por nome (sem telefone).
//
// ⚠️ O describe de DEPLOY PARCIAL fica por ÚLTIMO de propósito: ele
// desliga HAS_LINK_TABLE, que é flag de MÓDULO e nunca volta a ligar —
// qualquer caso declarado depois passaria "verde" sem testar nada.
// ============================================================
'use strict';

const svc = require('../src/services/karateDojoStudentService');
const links = require('../src/services/karateDojoStudentGuardians');
const db = require('../src/config/database');

const DOJO_ID = 'd0000000-0000-0000-0000-000000000002';
const OUTRO_DOJO = 'd0000000-0000-0000-0000-00000000dead';

// ── Âncoras de despacho ──
const isBegin = (s) => /^\s*BEGIN/.test(s);
const isCommit = (s) => /^\s*COMMIT/.test(s);
const isSavepointVerb = (s) => /^\s*(SAVEPOINT|RELEASE|ROLLBACK)\b/.test(s);
const isStudentDupCpf = (s) => /SELECT id FROM karate_dojo_students WHERE dojo_id = \$1 AND cpf = \$2/.test(s);
const isStudentDupName = (s) => /SELECT id FROM karate_dojo_students\s+WHERE dojo_id = \$1 AND lower\(full_name\)/.test(s);
const isGuardianFindExact = (s) => /SELECT id FROM karate_dojo_guardians/.test(s) && /COALESCE\(phone, ''\)/.test(s);
const isGuardianFindByName = (s) => /SELECT id FROM karate_dojo_guardians/.test(s) && /ORDER BY \(phone IS NOT NULL\)/.test(s);
const isGuardianInsert = (s) => /INSERT INTO karate_dojo_guardians/.test(s);
const isStudentInsert = (s) => /INSERT INTO karate_dojo_students\b/.test(s);
const isLinkUpsert = (s) => /INSERT INTO karate_dojo_student_guardians/.test(s);

// Posições do INSERT do aluno (a SQL é literal no service — se ela mudar,
// estes índices mudam junto e o teste avisa em vez de mentir).
const STU = { dojo: 0, name: 1, phone: 6, email: 7, guardian: 11, mother: 12, father: 13 };

// Banco simulado. `state.guardians` e `state.students` são as LINHAS —
// é contra elas que o escopo é conferido.
function makeDb(state, overrides = {}) {
  const calls = [];
  let gseq = 0;
  let sseq = 0;
  const client = {
    query: jest.fn(async (sql, params) => {
      const s = String(sql);
      calls.push([s, params]);
      if (isBegin(s) || isCommit(s) || isSavepointVerb(s)) return { rows: [] };

      const custom = overrides.dispatch && overrides.dispatch(s, params);
      if (custom !== undefined) {
        if (custom instanceof Error) throw custom;
        return custom;
      }

      if (isStudentDupCpf(s)) {
        // ESCOPO: o dojo_id do parâmetro é confrontado com o da LINHA.
        const hit = state.students.find((r) => r.dojo_id === params[0] && r.cpf === params[1]);
        return { rows: hit ? [{ id: hit.id }] : [] };
      }
      if (isStudentDupName(s)) {
        const hit = state.students.find(
          (r) => r.dojo_id === params[0] &&
            String(r.full_name).toLowerCase() === String(params[1]).toLowerCase() &&
            (r.birth_date || null) === (params[2] || null)
        );
        return { rows: hit ? [{ id: hit.id }] : [] };
      }
      if (isGuardianFindExact(s)) {
        const hit = state.guardians.find(
          (g) => g.dojo_id === params[0] &&
            String(g.full_name).toLowerCase() === String(params[1]).toLowerCase() &&
            (g.phone || '') === (params[2] || '')
        );
        return { rows: hit ? [{ id: hit.id }] : [] };
      }
      if (isGuardianFindByName(s)) {
        const hits = state.guardians
          .filter((g) => g.dojo_id === params[0] && String(g.full_name).toLowerCase() === String(params[1]).toLowerCase())
          .sort((a, b) => Number(!!b.phone) - Number(!!a.phone));
        return { rows: hits.length ? [{ id: hits[0].id }] : [] };
      }
      if (isGuardianInsert(s)) {
        gseq += 1;
        const row = { id: `g${gseq}`, dojo_id: params[0], full_name: params[1], phone: params[2], email: params[3], relationship: params[4] };
        state.guardians.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (isStudentInsert(s)) {
        sseq += 1;
        const row = { id: `stu${sseq}`, dojo_id: params[STU.dojo], full_name: params[STU.name], cpf: params[3], birth_date: params[2] };
        state.students.push(row);
        return { rows: [{ id: row.id, practitioner_id: null }] };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  client.calls = calls;
  client.sqls = () => calls.map((c) => c[0]);
  client.of = (m) => calls.filter((c) => m(c[0]));
  db.connect.mockImplementationOnce(() => client);
  return client;
}

function linkTuples(client) {
  const call = client.of(isLinkUpsert)[0];
  if (!call) return [];
  const out = [];
  for (let i = 0; i < call[1].length; i += 4) {
    out.push({ student_id: call[1][i], guardian_id: call[1][i + 1], relationship: call[1][i + 2], is_primary: call[1][i + 3] });
  }
  return out;
}

beforeEach(() => {
  db.query.mockReset();
  db.connect.mockReset();
});

describe('F13 — import: o menor ganha MÃE e PAI, cada um com o seu papel', () => {
  test('mãe E pai → DOIS vínculos; o telefone único da planilha fica com o PRINCIPAL', async () => {
    const state = { guardians: [], students: [] };
    const client = makeDb(state);

    const res = await svc.importStudents(DOJO_ID, [{
      full_name: 'Caio Marmorato Toloi', birth_date: '2015-06-01',
      mother_name: 'Maria Toloi', father_name: 'José Toloi',
      phone: '16981149883', email: 'maria@exemplo.com',
    }], {});

    expect(res.created).toBe(1);

    // DOIS responsáveis criados — não um "ou".
    const inserts = client.of(isGuardianInsert);
    expect(inserts.length).toBe(2);
    const [mae, pai] = inserts.map((c) => c[1]);
    expect(mae[1]).toBe('Maria Toloi');
    expect(mae[2]).toBe('16981149883');       // telefone
    expect(mae[3]).toBe('maria@exemplo.com'); // e-mail
    expect(mae[4]).toBe('mãe');               // parentesco
    expect(pai[1]).toBe('José Toloi');
    expect(pai[2]).toBeNull();                // a planilha traz UM contato só
    expect(pai[3]).toBeNull();
    expect(pai[4]).toBe('pai');

    // DOIS vínculos, exatamente UM principal.
    const tuples = linkTuples(client);
    expect(tuples.length).toBe(2);
    expect(tuples.filter((t) => t.is_primary === true).length).toBe(1);
    expect(tuples.find((t) => t.is_primary)).toMatchObject({ relationship: 'mãe' });
    expect(tuples.find((t) => !t.is_primary)).toMatchObject({ relationship: 'pai' });
    for (const t of tuples) expect(t.student_id).toBe(state.students[0].id);
    expect(res.guardian_links).toEqual({ written: true, count: 2 });

    // O sensei é AVISADO de quem ficou sem contato, pelo nome.
    const w = res.warnings.find((x) => x.code === 'GUARDIAN_SEM_CONTATO');
    expect(w).toBeDefined();
    expect(w.row).toBe(1);
    expect(w.message).toContain('José Toloi');

    // guardian_id (coluna legada) segue apontando para o PRINCIPAL.
    const stu = client.of(isStudentInsert)[0][1];
    expect(stu[STU.guardian]).toBe(tuples.find((t) => t.is_primary).guardian_id);
    // Filiação continua sendo gravada nas duas colunas, como sempre.
    expect(stu[STU.mother]).toBe('Maria Toloi');
    expect(stu[STU.father]).toBe('José Toloi');
    // contactMovedToGuardian: o contato é do ADULTO, não da criança de 10 anos.
    expect(stu[STU.phone]).toBeNull();
    expect(stu[STU.email]).toBeNull();
  });

  test('só mãe → um vínculo principal com parentesco "mãe" e sem warning de contato', async () => {
    const state = { guardians: [], students: [] };
    const client = makeDb(state);

    const res = await svc.importStudents(DOJO_ID, [{
      full_name: 'Filha Da Ana', birth_date: '2016-01-01',
      mother_name: 'Ana Sozinha', phone: '11999998888',
    }], {});

    expect(res.created).toBe(1);
    expect(client.of(isGuardianInsert).length).toBe(1);
    expect(client.of(isGuardianInsert)[0][1][4]).toBe('mãe');
    expect(linkTuples(client)).toEqual([
      { student_id: 'stu1', guardian_id: 'g1', relationship: 'mãe', is_primary: true },
    ]);
    expect(res.warnings.some((w) => w.code === 'GUARDIAN_SEM_CONTATO')).toBe(false);
    expect(res.warnings.some((w) => w.code === 'MENOR_SEM_RESPONSAVEL')).toBe(false);
  });

  test('só pai → o pai É o principal (não existe "mãe ausente = sem responsável")', async () => {
    const state = { guardians: [], students: [] };
    const client = makeDb(state);

    const res = await svc.importStudents(DOJO_ID, [{
      full_name: 'Filho Do Pedro', birth_date: '2017-01-01',
      father_name: 'Pedro Sozinho', phone: '11988887777',
    }], {});

    expect(res.created).toBe(1);
    const ins = client.of(isGuardianInsert)[0][1];
    expect(ins[1]).toBe('Pedro Sozinho');
    expect(ins[2]).toBe('11988887777'); // sem mãe, o contato é DELE
    expect(ins[4]).toBe('pai');
    expect(linkTuples(client)).toEqual([
      { student_id: 'stu1', guardian_id: 'g1', relationship: 'pai', is_primary: true },
    ]);
  });

  test('adulto com mãe e pai na planilha → NENHUM vínculo; o contato é dele mesmo', async () => {
    const state = { guardians: [], students: [] };
    const client = makeDb(state);

    const res = await svc.importStudents(DOJO_ID, [{
      full_name: 'Adulto Feito', birth_date: '1990-01-01',
      mother_name: 'Mãe Do Adulto', father_name: 'Pai Do Adulto',
      phone: '11977776666', email: 'adulto@exemplo.com',
    }], {});

    expect(res.created).toBe(1);
    expect(client.of(isGuardianInsert).length).toBe(0);
    expect(client.of(isLinkUpsert).length).toBe(0);
    expect(res.guardian_links).toEqual({ written: false, count: 0 });

    const stu = client.of(isStudentInsert)[0][1];
    expect(stu[STU.phone]).toBe('11977776666');
    expect(stu[STU.email]).toBe('adulto@exemplo.com');
    expect(stu[STU.guardian]).toBeNull();
    // filiação continua gravada — é identidade, não responsabilidade
    expect(stu[STU.mother]).toBe('Mãe Do Adulto');
    expect(stu[STU.father]).toBe('Pai Do Adulto');
  });

  test('guardian_name explícito continua ganhando de mãe/pai (planilha de 8 campos, byte a byte)', async () => {
    const state = { guardians: [], students: [] };
    const client = makeDb(state);

    await svc.importStudents(DOJO_ID, [{
      full_name: 'Sob Tutela', birth_date: '2014-01-01',
      guardian_name: 'Tia Legal', guardian_phone: '11955554444',
      mother_name: 'Mãe Que Não Responde',
    }], {});

    const inserts = client.of(isGuardianInsert);
    expect(inserts.length).toBe(1);
    expect(inserts[0][1][1]).toBe('Tia Legal');
    expect(inserts[0][1][4]).toBeNull(); // caminho legado não inventa parentesco
    expect(linkTuples(client)).toEqual([
      { student_id: 'stu1', guardian_id: 'g1', relationship: null, is_primary: true },
    ]);
  });
});

describe('F13 — irmãos compartilham o responsável (não duplicam a pessoa)', () => {
  test('dois irmãos, mesma mãe e mesmo pai → 2 responsáveis no total, 4 vínculos', async () => {
    const state = { guardians: [], students: [] };
    const client = makeDb(state);

    const res = await svc.importStudents(DOJO_ID, [
      { full_name: 'Caio Marmorato Toloi', birth_date: '2015-06-01', mother_name: 'Maria Toloi', father_name: 'José Toloi', phone: '16981149883' },
      { full_name: 'Lucas Marmorato Toloi', birth_date: '2013-02-02', mother_name: 'Maria Toloi', father_name: 'José Toloi', phone: '16981149883' },
    ], {});

    expect(res.created).toBe(2);
    // 2 pessoas, não 4 linhas — é a razão de karate_dojo_guardians ser
    // escopada por DOJÔ e não por aluno.
    expect(client.of(isGuardianInsert).length).toBe(2);
    expect(state.guardians.length).toBe(2);

    const tuples = linkTuples(client);
    expect(tuples.length).toBe(4);
    expect(new Set(tuples.map((t) => t.guardian_id)).size).toBe(2);
    expect(new Set(tuples.map((t) => t.student_id)).size).toBe(2);
    // cada aluno tem exatamente um principal
    for (const sid of new Set(tuples.map((t) => t.student_id))) {
      expect(tuples.filter((t) => t.student_id === sid && t.is_primary === true).length).toBe(1);
    }
  });

  test('o pai SEM contato reusa o pai que já existe COM contato (busca por nome)', async () => {
    // Cenário real: o pai já é responsável principal de um filho mais
    // velho (com telefone). No irmão ele entra como segundo responsável,
    // sem telefone — e não pode virar um SEGUNDO cadastro da mesma pessoa.
    const state = {
      guardians: [{ id: 'g-pai-existente', dojo_id: DOJO_ID, full_name: 'José Toloi', phone: '16988887777' }],
      students: [],
    };
    const client = makeDb(state);

    await svc.importStudents(DOJO_ID, [{
      full_name: 'Caçula', birth_date: '2018-01-01',
      mother_name: 'Maria Toloi', father_name: 'José Toloi', phone: '16981149883',
    }], {});

    // Só a MÃE é criada; o pai é reaproveitado.
    const inserts = client.of(isGuardianInsert);
    expect(inserts.length).toBe(1);
    expect(inserts[0][1][1]).toBe('Maria Toloi');

    const tuples = linkTuples(client);
    expect(tuples.map((t) => t.guardian_id)).toContain('g-pai-existente');
    expect(client.of(isGuardianFindByName).length).toBe(1);
  });

  test('ESCOPO: responsável homônimo de OUTRO dojô não é reusado (nem o com telefone, nem o sem)', async () => {
    // A fixture é de OUTRO dojô. O mock confere o parâmetro contra
    // g.dojo_id DA LINHA — se o service parasse de escopar, este caso
    // reusaria o responsável alheio e falharia aqui.
    const state = {
      guardians: [
        { id: 'g-alheia', dojo_id: OUTRO_DOJO, full_name: 'Maria Toloi', phone: '16981149883' },
        { id: 'g-alheio', dojo_id: OUTRO_DOJO, full_name: 'José Toloi', phone: '16988887777' },
      ],
      students: [],
    };
    const client = makeDb(state);

    await svc.importStudents(DOJO_ID, [{
      full_name: 'Aluno Deste Dojô', birth_date: '2015-06-01',
      mother_name: 'Maria Toloi', father_name: 'José Toloi', phone: '16981149883',
    }], {});

    const inserts = client.of(isGuardianInsert);
    expect(inserts.length).toBe(2);                 // criou os dois AQUI
    for (const c of inserts) expect(c[1][0]).toBe(DOJO_ID);
    const tuples = linkTuples(client);
    expect(tuples.map((t) => t.guardian_id)).not.toContain('g-alheia');
    expect(tuples.map((t) => t.guardian_id)).not.toContain('g-alheio');
    // e a busca perguntou pelo dojô do token, não pelo do body
    for (const c of [...client.of(isGuardianFindExact), ...client.of(isGuardianFindByName)]) {
      expect(c[1][0]).toBe(DOJO_ID);
    }
  });
});

describe('F13 — reimportação não duplica vínculo', () => {
  test('mesma planilha de novo: alunos já cadastrados são SKIPPED e nenhum vínculo é escrito', async () => {
    const state = {
      guardians: [{ id: 'g-mae', dojo_id: DOJO_ID, full_name: 'Maria Toloi', phone: '16981149883' }],
      students: [{ id: 'stu-antigo', dojo_id: DOJO_ID, full_name: 'Caio Marmorato Toloi', birth_date: '2015-06-01', cpf: null }],
    };
    const client = makeDb(state);

    const res = await svc.importStudents(DOJO_ID, [{
      full_name: 'Caio Marmorato Toloi', birth_date: '2015-06-01',
      mother_name: 'Maria Toloi', father_name: 'José Toloi', phone: '16981149883',
    }], {});

    expect(res.created).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.warnings.some((w) => w.code === 'DUP_NAME_NO_CPF')).toBe(true);
    expect(client.of(isLinkUpsert).length).toBe(0);
    expect(client.of(isGuardianInsert).length).toBe(0);
    expect(res.guardian_links).toEqual({ written: false, count: 0 });
  });

  test('e, se um vínculo repetido chegasse, o upsert é idempotente por (student_id, guardian_id)', () => {
    const { sql } = links.buildLinkInsert([
      { student_id: 's1', guardian_id: 'g1', relationship: 'mãe', is_primary: true },
    ]);
    expect(sql).toMatch(/ON CONFLICT \(student_id, guardian_id\)/);
    expect(sql).toMatch(/DO UPDATE/);
  });
});

describe('F13 — 42P10: o ON CONFLICT não pode mirar o índice PARCIAL', () => {
  // uq_kdsg_one_primary_per_student é PARCIAL (WHERE is_primary). O
  // arbiter do upsert é o índice TOTAL (student_id, guardian_id) — e
  // índice total NÃO leva predicado. Esta é a asserção estrutural que
  // impede alguém "otimizar" o upsert para o arbiter errado.
  test('o arbiter é o par completo, nunca student_id sozinho', () => {
    const { sql } = links.buildLinkInsert([{ student_id: 's1', guardian_id: 'g1', relationship: null, is_primary: true }]);
    expect(sql).not.toMatch(/ON CONFLICT \(student_id\)/);
    expect(sql).not.toMatch(/ON CONFLICT[^)]*\)\s*WHERE/i);
  });

  test('o principal é garantido REBAIXANDO o anterior, não por upsert no índice parcial', async () => {
    const seen = [];
    const exec = { query: jest.fn(async (s) => { seen.push(String(s)); return { rows: [] }; }) };
    await links.replaceLinks(exec, 's1', [{ guardian_id: 'g1', relationship: 'mãe', is_primary: true }]);
    const demoteAt = seen.findIndex((s) => /tag:student_guardian_demote/.test(s));
    const upsertAt = seen.findIndex((s) => /tag:student_guardian_link_upsert/.test(s));
    expect(demoteAt).toBeGreaterThanOrEqual(0);
    // REBAIXAR ANTES: índice único não é DEFERRABLE, dois is_primary no
    // mesmo aluno estouram 23505 na hora do INSERT, não no COMMIT.
    expect(demoteAt).toBeLessThan(upsertAt);
  });
});

describe('F13 — validação do corpo (guardians)', () => {
  test('lista válida entra em data.guardians, normalizada', () => {
    const { errors, data } = svc.validateStudentPayload({
      full_name: 'Aluno',
      guardians: [
        { full_name: '  Maria  ', phone: ' 169 ', relationship: 'mãe', is_primary: true },
        { guardian_id: ' g2 ', relationship: 'pai' },
      ],
    });
    expect(errors).toEqual([]);
    expect(data.guardians).toEqual([
      { guardian_id: null, full_name: 'Maria', cpf: null, phone: '169', email: null, relationship: 'mãe', is_primary: true },
      { guardian_id: 'g2', full_name: null, cpf: null, phone: null, email: null, relationship: 'pai', is_primary: false },
    ]);
  });

  test('ausente é NEUTRO (não entra em data — PATCH não mexe em vínculo)', () => {
    const { errors, data } = svc.validateStudentPayload({ belt_label: 'Amarela' }, { partial: true });
    expect(errors).toEqual([]);
    expect(data).not.toHaveProperty('guardians');
  });

  test('null/[] é a escolha EXPLÍCITA de ficar sem responsável', () => {
    expect(svc.validateStudentPayload({ guardians: null }, { partial: true }).data.guardians).toEqual([]);
    expect(svc.validateStudentPayload({ guardians: [] }, { partial: true }).data.guardians).toEqual([]);
  });

  test('inválido é ERRO (não é "dado faltante")', () => {
    expect(svc.validateStudentPayload({ guardians: 'a mãe' }, { partial: true }).errors)
      .toEqual(['guardians deve ser uma lista']);
    expect(svc.validateStudentPayload({ guardians: [{}] }, { partial: true }).errors[0])
      .toMatch(/guardian_id .* full_name/);
    expect(svc.validateStudentPayload({ guardians: [1, 2, 3, 4, 5].map(() => ({ full_name: 'A' })) }, { partial: true }).errors[0])
      .toMatch(new RegExp(`Máximo de ${svc.MAX_GUARDIANS_PER_STUDENT}`));
  });
});

describe('F13 — a ficha devolve a lista, sem query nova', () => {
  test('GET traz guardians na MESMA query e mantém guardian/guardian_id (compatibilidade)', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'stu1', full_name: 'Criança', birth_date: '2015-06-01', status: 'active',
        guardian_id: 'g1', guardian_full_name: 'Maria', guardian_phone: '169',
        guardian_email: null, guardian_cpf: null, guardian_relationship: 'mãe',
        guardians_json: [
          { id: 'g1', full_name: 'Maria', cpf: null, phone: '169', email: null, relationship: 'mãe', is_primary: true },
          { id: 'g2', full_name: 'José', cpf: null, phone: null, email: null, relationship: 'pai', is_primary: false },
        ],
      }],
    });

    const s = await svc.getStudent(DOJO_ID, 'stu1');

    expect(db.query.mock.calls.length).toBe(1); // NENHUMA query nova
    expect(String(db.query.mock.calls[0][0])).toMatch(/karate_dojo_student_guardians/);
    expect(db.query.mock.calls[0][1]).toEqual(['stu1', DOJO_ID]);
    expect(s.guardians.map((g) => [g.full_name, g.relationship, g.is_primary]))
      .toEqual([['Maria', 'mãe', true], ['José', 'pai', false]]);
    // o contrato antigo continua de pé
    expect(s.guardian_id).toBe('g1');
    expect(s.guardian).toMatchObject({ id: 'g1', full_name: 'Maria' });
  });

  test('aluno com guardian_id mas SEM vínculo: o legado é costurado como principal', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        id: 'stu1', full_name: 'Criança', status: 'active',
        guardian_id: 'g9', guardian_full_name: 'Só Legado', guardian_phone: '11',
        guardian_relationship: 'mãe', guardians_json: [],
      }],
    });
    const s = await svc.getStudent(DOJO_ID, 'stu1');
    expect(s.guardians).toEqual([
      { id: 'g9', full_name: 'Só Legado', cpf: null, phone: '11', email: null, relationship: 'mãe', is_primary: true },
    ]);
  });

  test('json_agg pode voltar como STRING (driver sem parse) — a leitura aguenta', () => {
    const out = links.guardiansFromRow(
      { guardians_json: '[{"id":"g1","full_name":"Maria","is_primary":true}]' },
      null
    );
    expect(out).toEqual([
      { id: 'g1', full_name: 'Maria', cpf: null, phone: null, email: null, relationship: null, is_primary: true },
    ]);
  });
});

describe('F13 — PATCH da ficha grava o conjunto de responsáveis', () => {
  test('guardians: [mãe, pai] → prune + demote + upsert, e guardian_id vira o principal', async () => {
    const seen = [];
    db.query.mockImplementation(async (sql, params) => {
      const s = String(sql);
      seen.push(s);
      if (/FROM karate_dojo_students s/.test(s) && /LIMIT 1/.test(s)) {
        return { rows: [{ id: 'stu1', full_name: 'Criança', birth_date: '2015-06-01', status: 'active', guardian_id: null, practitioner_id: null }] };
      }
      if (/tag:guardian_scope_check/.test(s)) return { rows: [{ id: params[0] }] };
      if (/tag:guardian_find\b/.test(s)) return { rows: [] };
      if (/tag:guardian_create/.test(s)) return { rows: [{ id: 'g-mae' }] };
      if (/^\s*UPDATE karate_dojo_students/m.test(s)) return { rows: [{ id: 'stu1', full_name: 'Criança', status: 'active', guardian_id: 'g-mae' }] };
      if (/tag:student_guardian_list/.test(s)) {
        return { rows: [
          { id: 'g-mae', full_name: 'Maria', cpf: null, phone: '169', email: null, relationship: 'mãe', is_primary: true },
          { id: 'g-pai', full_name: 'José', cpf: null, phone: null, email: null, relationship: 'pai', is_primary: false },
        ] };
      }
      return { rows: [] };
    });

    const { data } = svc.validateStudentPayload({
      guardians: [
        { full_name: 'Maria', phone: '169', relationship: 'mãe' },
        { guardian_id: 'g-pai', relationship: 'pai' },
      ],
    }, { partial: true });

    const out = await svc.updateStudent(DOJO_ID, 'stu1', data, {});

    expect(out.guardian_id).toBe('g-mae');
    expect(out.guardians.map((g) => g.full_name)).toEqual(['Maria', 'José']);
    expect(out.guardian).toMatchObject({ id: 'g-mae' }); // shape legado segue o principal
    const tags = seen.map((s) => (s.match(/-- tag:(\w+)/) || [])[1]).filter(Boolean);
    expect(tags).toEqual(expect.arrayContaining([
      'guardian_find', 'guardian_create', 'guardian_scope_check',
      'student_guardian_prune', 'student_guardian_demote', 'student_guardian_link_upsert', 'student_guardian_list',
    ]));
    expect(tags.indexOf('student_guardian_demote')).toBeLessThan(tags.indexOf('student_guardian_link_upsert'));
  });

  test('guardians: [] em MENOR volta a ser 422 MENOR_SEM_RESPONSAVEL (a lista manda em guardian_id)', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/FROM karate_dojo_students s/.test(String(sql))) {
        return { rows: [{ id: 'stu1', full_name: 'Criança', birth_date: '2015-06-01', status: 'active', guardian_id: 'g-antiga', practitioner_id: null }] };
      }
      return { rows: [] };
    });
    const { data } = svc.validateStudentPayload({ guardians: [] }, { partial: true });
    await expect(svc.updateStudent(DOJO_ID, 'stu1', data, {}))
      .rejects.toMatchObject({ status: 422, code: 'MENOR_SEM_RESPONSAVEL' });
  });

  test('responsável de OUTRO dojô no corpo → 422 GUARDIAN_NOT_FOUND (id do body nunca entra sem conferência)', async () => {
    db.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (/FROM karate_dojo_students s/.test(s) && /LIMIT 1/.test(s)) {
        return { rows: [{ id: 'stu1', full_name: 'Adulto', birth_date: '1990-01-01', status: 'active', guardian_id: null, practitioner_id: null }] };
      }
      if (/tag:guardian_scope_check/.test(s)) return { rows: [] }; // não é deste dojô
      return { rows: [] };
    });
    const { data } = svc.validateStudentPayload({ guardians: [{ guardian_id: 'g-de-outro-dojo' }] }, { partial: true });
    await expect(svc.updateStudent(DOJO_ID, 'stu1', data, {}))
      .rejects.toMatchObject({ status: 422, code: 'GUARDIAN_NOT_FOUND' });
  });
});

// ⚠️ ÚLTIMO describe do arquivo: desliga HAS_LINK_TABLE (flag de MÓDULO,
// que nunca volta a ligar). Qualquer caso declarado depois daqui passaria
// verde sem exercitar o vínculo.
describe('F13 — deploy parcial: migration 280 pendente não pode derrubar o import', () => {
  test('42P01 no vínculo é contido por SAVEPOINT — o lote COMMITA e os alunos entram', async () => {
    const state = { guardians: [], students: [] };
    const client = makeDb(state, {
      dispatch: (s) => {
        if (isLinkUpsert(s)) {
          const e = new Error('relation "karate_dojo_student_guardians" does not exist');
          e.code = '42P01';
          return e;
        }
        return undefined;
      },
    });

    expect(links.hasLinkTable()).toBe(true); // ainda de pé ANTES

    const res = await svc.importStudents(DOJO_ID, [{
      full_name: 'Criança', birth_date: '2015-06-01',
      mother_name: 'Maria', father_name: 'José', phone: '169',
    }], {});

    expect(res.created).toBe(1);                      // o aluno ENTROU
    expect(res.guardian_links.written).toBe(false);
    const sqls = client.sqls().map((s) => s.trim());
    expect(sqls.some((s) => /^SAVEPOINT sp_kdsg_links/.test(s))).toBe(true);
    expect(sqls.some((s) => /^ROLLBACK TO SAVEPOINT sp_kdsg_links/.test(s))).toBe(true);
    expect(sqls).toContain('COMMIT');
    expect(sqls.some((s) => /^ROLLBACK$/.test(s))).toBe(false); // a transação NÃO caiu
    // guardian_id (o principal) foi gravado — comportamento pré-F13 intacto
    expect(client.of(isStudentInsert)[0][1][STU.guardian]).toBe('g1');
    expect(links.hasLinkTable()).toBe(false);         // degradou
  });

  test('degradado, a ficha continua sendo servida e a SQL não menciona mais a tabela nova', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'stu1', full_name: 'Criança', status: 'active', guardian_id: 'g1',
        guardian_full_name: 'Maria', guardian_phone: '169', guardian_relationship: 'mãe' }],
    });
    const s = await svc.getStudent(DOJO_ID, 'stu1');
    expect(String(db.query.mock.calls[0][0])).not.toMatch(/karate_dojo_student_guardians/);
    expect(s.guardians).toEqual([
      { id: 'g1', full_name: 'Maria', cpf: null, phone: '169', email: null, relationship: 'mãe', is_primary: true },
    ]);
  });
});
