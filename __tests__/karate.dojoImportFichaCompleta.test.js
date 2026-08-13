// ============================================================
// AURA DOJÔ — F12: importador com a ficha completa da planilha real
//
// Cobre os normalizadores PUROS do import (sem mock de banco — mesmo
// espírito de __tests__/karate.dojoStudentParentage.test.js e
// __tests__/karate.beltScale.test.js: função exportada, entrada→saída),
// e a orquestração transacional em cenários que não estão em
// tests/integration/karateDojoStudents.test.js (aquele arquivo cobre o
// caso "clássico" de 8 campos; este cobre os 15 da planilha real).
//
// Casos aqui espelham literalmente os exemplos do enunciado do produto:
//   - "(16) 9811-49883" → "16981149883" (máscara errada na origem, 11
//     dígitos corretos)
//   - "4º Kyu - Azul Escura" (variante feminina) → mesmo nível canônico
//     que "Azul Escuro" (ver __tests__/karate.beltScale.test.js)
//   - "1º Kyu - Marrom", "10º Kyu - Branca", "Preta 1º Dan"
//   - CPF com DV inválido: importa mesmo assim, marcado para revisão
//   - responsável derivado de mãe/pai para menor sem guardian_name
//   - idade desconhecida (sem birth_date): tratado como adulto, com warning
//
// F13 (12/08/2026): o responsável derivado deixou de ser UM ("a mãe, ou o
// pai se a mãe estiver vazia") e passou a ser OS DOIS. O caso abaixo foi
// reescrito no PR que fez a mudança — a cobertura ampla da F13 (só mãe, só
// pai, adulto, irmãos, reimportação, deploy parcial) vive em
// __tests__/karate.dojoStudentGuardians.test.js.
// ============================================================
'use strict';

const svc = require('../src/services/karateDojoStudentService');

describe('F12 — normalizadores puros do import (sem banco)', () => {
  describe('normalizePhoneDigits — máscara da origem é ignorada, só os dígitos importam', () => {
    test('máscara errada da planilha real: 11 dígitos corretos mesmo com hífen fora do lugar', () => {
      expect(svc.normalizePhoneDigits('(16) 9811-49883')).toBe('16981149883');
    });
    test('10 dígitos (fixo) também é válido', () => {
      expect(svc.normalizePhoneDigits('(91) 3222-1234')).toBe('9132221234');
    });
    test('menos de 10 dígitos → null (dado inválido, não string truncada)', () => {
      expect(svc.normalizePhoneDigits('123')).toBeNull();
    });
    test('null/undefined/vazio → null (dado faltante é neutro)', () => {
      expect(svc.normalizePhoneDigits(null)).toBeNull();
      expect(svc.normalizePhoneDigits(undefined)).toBeNull();
      expect(svc.normalizePhoneDigits('')).toBeNull();
    });
  });

  describe('isValidCpfChecksum — mod 11 padrão; import NUNCA bloqueia por isso', () => {
    test('CPF válido', () => {
      expect(svc.isValidCpfChecksum('52998224725')).toBe(true);
    });
    test('CPF com DV inválido (16 casos assim na planilha real do Areikan)', () => {
      expect(svc.isValidCpfChecksum('52998224726')).toBe(false);
    });
    test('11 dígitos repetidos nunca é válido, mesmo passando pelo mod 11 por acidente', () => {
      expect(svc.isValidCpfChecksum('11111111111')).toBe(false);
    });
    test('menos/mais de 11 dígitos → false', () => {
      expect(svc.isValidCpfChecksum('123')).toBe(false);
      expect(svc.isValidCpfChecksum('529982247250')).toBe(false);
    });
  });

  describe('splitAddress — 96% da planilha real tem o número grudado no fim da rua', () => {
    test('número grudado sem vírgula', () => {
      expect(svc.splitAddress('Rua Exemplo 123')).toEqual({ street: 'Rua Exemplo', number: '123' });
    });
    test('número com vírgula antes e sufixo de letra', () => {
      expect(svc.splitAddress('Avenida Teste, 45A')).toEqual({ street: 'Avenida Teste', number: '45A' });
    });
    test('sem número reconhecível no fim → tudo vira street, number null (neutro, não erro)', () => {
      expect(svc.splitAddress('Travessa Sem Numero')).toEqual({ street: 'Travessa Sem Numero', number: null });
    });
    test('ausente/vazio → os dois campos null', () => {
      expect(svc.splitAddress(null)).toEqual({ street: null, number: null });
      expect(svc.splitAddress('')).toEqual({ street: null, number: null });
    });
  });

  describe('normalizeImportStatus — vocabulário tolerante da coluna "Ativo"', () => {
    test.each([
      ['Sim', 'active'], ['sim', 'active'], ['Ativo', 'active'], ['TRUE', 'active'], ['1', 'active'],
      ['Não', 'inactive'], ['nao', 'inactive'], ['Inativo', 'inactive'], ['FALSE', 'inactive'], ['0', 'inactive'],
    ])('%s → %s (reconhecido)', (raw, expected) => {
      const r = svc.normalizeImportStatus(raw);
      expect(r).toEqual({ status: expected, recognized: true });
    });

    test('ausente (null/undefined/"") → active, reconhecido (default neutro do import de sempre)', () => {
      expect(svc.normalizeImportStatus(null)).toEqual({ status: 'active', recognized: true });
      expect(svc.normalizeImportStatus(undefined)).toEqual({ status: 'active', recognized: true });
      expect(svc.normalizeImportStatus('')).toEqual({ status: 'active', recognized: true });
    });

    test('valor não reconhecido → active, MAS recognized:false (chamador decide o warning)', () => {
      expect(svc.normalizeImportStatus('talvez')).toEqual({ status: 'active', recognized: false });
    });

    test('boolean literal (JSON já parseado) também funciona', () => {
      expect(svc.normalizeImportStatus(true)).toEqual({ status: 'active', recognized: true });
      expect(svc.normalizeImportStatus(false)).toEqual({ status: 'inactive', recognized: true });
    });
  });

  describe('detectImportBeltLevel / parseImportBeltLabel — fonte única é karateBeltScale.js', () => {
    test('"1º Kyu - Marrom" → nível marrom, kyu 1', () => {
      expect(svc.detectImportBeltLevel('1º Kyu - Marrom')).toBe('marrom');
      expect(svc.parseImportBeltLabel('1º Kyu - Marrom')).toEqual({
        belt_label: 'Marrom 1º kyu', belt_order: expect.any(Number), recognized: true,
      });
    });

    test('"10º Kyu - Branca" → nível branca (faixa iniciante)', () => {
      expect(svc.detectImportBeltLevel('10º Kyu - Branca')).toBe('branca');
      const r = svc.parseImportBeltLabel('10º Kyu - Branca');
      expect(r.recognized).toBe(true);
      expect(r.belt_label).toBe('Branca');
    });

    test('"Preta 1º Dan" e faixas pretas até 4º Dan (12 alunos na planilha real)', () => {
      expect(svc.parseImportBeltLabel('Preta 1º Dan')).toEqual({ belt_label: 'Preta 1º dan', belt_order: expect.any(Number), recognized: true });
      const dan4 = svc.parseImportBeltLabel('Preta 4º Dan');
      expect(dan4.belt_label).toBe('Preta 4º dan');
      expect(dan4.recognized).toBe(true);
    });

    test('"4º Kyu - Azul Escura" (variante feminina) resolve para o MESMO nível canônico que "Azul Escuro"', () => {
      const feminino = svc.parseImportBeltLabel('4º Kyu - Azul Escura');
      const masculino = svc.parseImportBeltLabel('4º Kyu - Azul Escuro');
      expect(feminino.recognized).toBe(true);
      expect(feminino.belt_label).toBe(masculino.belt_label);
      expect(feminino.belt_order).toBe(masculino.belt_order);
      expect(feminino.belt_label).toBe('Azul Escuro'); // grafia canônica de karateBeltScale.js
    });

    test('texto irreconhecível → recognized:false, belt_label/belt_order null (não bloqueia a linha)', () => {
      expect(svc.parseImportBeltLabel('Faixa Roxa de Bolinhas')).toEqual({
        belt_label: null, belt_order: null, recognized: false,
      });
    });

    test('ausente/vazio → recognized:true (dado faltante é neutro, diferente de valor inválido)', () => {
      expect(svc.parseImportBeltLabel(null)).toEqual({ belt_label: null, belt_order: null, recognized: true });
      expect(svc.parseImportBeltLabel('')).toEqual({ belt_label: null, belt_order: null, recognized: true });
    });

    test('faixas coloridas de kyu único não exigem número (ex.: "Amarela" sozinha)', () => {
      const r = svc.parseImportBeltLabel('Amarela');
      expect(r.recognized).toBe(true);
      expect(r.belt_label).toBe('Amarela');
    });
  });
});

// ============================================================
// Transacional: cenários da ficha completa que tests/integration/
// karateDojoStudents.test.js NÃO cobre (aquele arquivo mantém o cenário
// clássico de 8 campos). Mock por SQL (regex), nunca fila posicional —
// mesma convenção do resto do repo.
// ============================================================
describe('F12 — import transacional: tag, responsável mãe/pai, idade desconhecida', () => {
  const dojoId = 'd0000000-0000-0000-0000-000000000002';

  function isBegin(s) { return /^BEGIN/.test(s.trim()); }
  function isCommit(s) { return /^COMMIT/.test(s.trim()); }
  function isCpfDup(s) { return /SELECT id FROM karate_dojo_students WHERE dojo_id = \$1 AND cpf = \$2/.test(s); }
  function isNameDup(s) { return /SELECT id FROM karate_dojo_students\s+WHERE dojo_id = \$1 AND lower\(full_name\)/.test(s); }
  function isTagUpsert(s) { return /INSERT INTO karate_dojo_tags/.test(s); }
  function isGuardianLookup(s) { return /SELECT id FROM karate_dojo_guardians/.test(s); }
  function isGuardianInsert(s) { return /INSERT INTO karate_dojo_guardians/.test(s); }
  function isStudentInsert(s) { return /INSERT INTO karate_dojo_students/.test(s); }
  function isTagLink(s) { return /INSERT INTO karate_dojo_student_tags/.test(s); }
  function isGuardianLink(s) { return /INSERT INTO karate_dojo_student_guardians/.test(s); }

  function buildClient(dispatch) {
    let seq = 0;
    const calls = [];
    const client = {
      query: jest.fn(async (sql, params) => {
        const s = String(sql);
        calls.push([s, params]);
        if (isBegin(s) || isCommit(s)) return {};
        const custom = dispatch(s, params);
        if (custom !== undefined) return custom;
        if (isStudentInsert(s)) { seq += 1; return { rows: [{ id: `stu${seq}`, practitioner_id: null }] }; }
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    client.calls = calls;
    return client;
  }

  test('Academia vira tag: cria na primeira ocorrência, reusa (cache) nas seguintes do mesmo lote', async () => {
    const db = require('../src/config/database');
    const client = buildClient((s) => {
      if (isCpfDup(s)) return { rows: [] };
      if (isTagUpsert(s)) return { rows: [{ id: 'tag-areikan' }] };
    });
    db.connect.mockResolvedValueOnce ? db.connect.mockResolvedValueOnce(client) : (db.connect = jest.fn().mockResolvedValueOnce(client));

    const rows = [
      { full_name: 'Aluno Um', cpf: '52998224725', academia: 'Escola I Karate Areikan' },
      { full_name: 'Aluno Dois', cpf: '11144477735', academia: 'escola i karate areikan' }, // mesma tag, case diferente
    ];
    const res = await svc.importStudents(dojoId, rows, {});

    expect(res.created).toBe(2);
    const tagUpserts = client.calls.filter((c) => isTagUpsert(c[0]));
    // 1 upsert só: a segunda linha reusa via cache local do lote (mesma
    // chave normalizada em minúsculas), não bate no banco de novo.
    expect(tagUpserts.length).toBe(1);
    expect(tagUpserts[0][1][0]).toBe(dojoId);
    const tagLinks = client.calls.filter((c) => isTagLink(c[0]));
    expect(tagLinks.length).toBe(2);
  });

  // F13 (12/08/2026): este caso ANTES afirmava "responsável vira a MÃE".
  // O handler mudou (mãe E pai), então o caso muda no MESMO PR. Note o
  // mock: ele devolve um id DIFERENTE por ordem de inserção — a versão
  // antiga devolvia 'g-mae' para qualquer INSERT, o que colapsava os dois
  // responsáveis em um e deixava o caso verde por acidente.
  test('menor sem guardian_name explícito: mãe E pai viram responsáveis; o telefone/e-mail da linha fica com a MÃE', async () => {
    const db = require('../src/config/database');
    let gseq = 0;
    const client = buildClient((s) => {
      if (isNameDup(s)) return { rows: [] };
      if (isGuardianLookup(s)) return { rows: [] };
      if (isGuardianInsert(s)) { gseq += 1; return { rows: [{ id: `g${gseq}` }] }; }
    });
    db.connect = jest.fn().mockResolvedValueOnce(client);

    const rows = [{
      full_name: 'Criança Menor', birth_date: '2015-06-01',
      mother_name: 'Maria da Silva', father_name: 'José da Silva',
      phone: '91988887777', email: 'mae@exemplo.com',
    }];
    const res = await svc.importStudents(dojoId, rows, {});

    expect(res.created).toBe(1);
    expect(res.warnings.some((w) => w.code === 'MENOR_SEM_RESPONSAVEL')).toBe(false); // achou os pais: sem warning

    const guardianInserts = client.calls.filter((c) => isGuardianInsert(c[0]));
    expect(guardianInserts.length).toBe(2);
    // MÃE: fica com o contato ÚNICO da planilha e com o parentesco certo.
    expect(guardianInserts[0][1]).toEqual([dojoId, 'Maria da Silva', '91988887777', 'mae@exemplo.com', 'mãe']);
    // PAI: entra NOMEADO e SEM contato — inventar um telefone (copiar o da
    // mãe) seria pior do que não ter; numa emergência, dois números iguais
    // é UM número com aparência de dois.
    expect(guardianInserts[1][1]).toEqual([dojoId, 'José da Silva', null, null, 'pai']);
    const semContato = res.warnings.find((w) => w.code === 'GUARDIAN_SEM_CONTATO');
    expect(semContato).toMatchObject({ row: 1 });
    expect(semContato.message).toContain('José da Silva');

    // DOIS vínculos, um só principal (a mãe, que tem o contato).
    const link = client.calls.find((c) => isGuardianLink(c[0]));
    expect(link[1]).toEqual(['stu1', 'g1', 'mãe', true, 'stu1', 'g2', 'pai', false]);

    const studentInsert = client.calls.find((c) => isStudentInsert(c[0]));
    // guardian_id (legado) segue apontando para a MÃE — asserção original
    // preservada: nenhuma ficha existente muda de responsável principal.
    expect(studentInsert[1]).toEqual(expect.arrayContaining(['g1']));
    // O telefone/email do PRÓPRIO aluno ficam null (o contato migrou para
    // o responsável — evita registrar o contato do adulto como se fosse da
    // criança de 10 anos).
    expect(studentInsert[1][6]).toBeNull();
    expect(studentInsert[1][7]).toBeNull();
    // mother_name/father_name são filiação e são gravados SEMPRE, mesmo
    // quando os dois também são os responsáveis.
    expect(studentInsert[1]).toEqual(expect.arrayContaining(['Maria da Silva', 'José da Silva']));
  });

  test('menor sem mãe nem pai na planilha: continua entrando com warning MENOR_SEM_RESPONSAVEL (nunca bloqueia)', async () => {
    const db = require('../src/config/database');
    const client = buildClient((s) => {
      if (isNameDup(s)) return { rows: [] };
    });
    db.connect = jest.fn().mockResolvedValueOnce(client);

    const rows = [{ full_name: 'Órfão De Planilha', birth_date: '2016-01-01' }];
    const res = await svc.importStudents(dojoId, rows, {});

    expect(res.created).toBe(1);
    expect(res.skipped).toBe(0);
    expect(res.warnings.some((w) => w.row === 1 && w.code === 'MENOR_SEM_RESPONSAVEL')).toBe(true);
    expect(client.calls.some((c) => isGuardianInsert(c[0]))).toBe(false);
    // sem responsável nenhum, nenhum vínculo é escrito (nem SAVEPOINT)
    expect(client.calls.some((c) => isGuardianLink(c[0]))).toBe(false);
  });

  test('sem birth_date (idade desconhecida): tratado como adulto, telefone/email ficam no próprio aluno, warning declarado', async () => {
    const db = require('../src/config/database');
    const client = buildClient((s) => {
      if (isNameDup(s)) return { rows: [] };
    });
    db.connect = jest.fn().mockResolvedValueOnce(client);

    const rows = [{
      full_name: 'Idade Desconhecida', mother_name: 'Mãe Desconhecida',
      phone: '91977776666', email: 'quemsabe@exemplo.com',
    }];
    const res = await svc.importStudents(dojoId, rows, {});

    expect(res.created).toBe(1);
    expect(res.warnings.some((w) => w.row === 1 && w.code === 'AGE_UNKNOWN_TREATED_AS_ADULT')).toBe(true);
    // adulto: NENHUM responsável é criado a partir da mãe (é só filiação aqui)
    expect(client.calls.some((c) => isGuardianInsert(c[0]))).toBe(false);
    const studentInsert = client.calls.find((c) => isStudentInsert(c[0]));
    // telefone/email do próprio aluno (não migraram para ninguém)
    expect(studentInsert[1]).toEqual(expect.arrayContaining(['91977776666', 'quemsabe@exemplo.com']));
  });

  test('CPF com DV inválido: importa mesmo assim, com warning de revisão (nunca bloqueia a linha)', async () => {
    const db = require('../src/config/database');
    const client = buildClient((s) => {
      if (isCpfDup(s)) return { rows: [] };
    });
    db.connect = jest.fn().mockResolvedValueOnce(client);

    const rows = [{ full_name: 'CPF Torto', cpf: '52998224726' }]; // DV inválido de propósito
    const res = await svc.importStudents(dojoId, rows, {});

    expect(res.created).toBe(1);
    expect(res.warnings.some((w) => w.row === 1 && w.code === 'CPF_CHECKSUM_INVALID')).toBe(true);
    const studentInsert = client.calls.find((c) => isStudentInsert(c[0]));
    expect(studentInsert[1]).toEqual(expect.arrayContaining(['52998224726'])); // CPF entra assim mesmo
  });

  test('reimportação de linha SEM CPF: dedupe por (dojo_id, nome, nascimento) evita duplicar', async () => {
    const db = require('../src/config/database');
    const client = buildClient((s) => {
      if (isNameDup(s)) return { rows: [{ id: 'ja-existe' }] }; // já está no banco
    });
    db.connect = jest.fn().mockResolvedValueOnce(client);

    const rows = [{ full_name: 'Já Importado Antes', birth_date: '2000-01-01' }];
    const res = await svc.importStudents(dojoId, rows, {});

    expect(res.created).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.warnings.some((w) => w.row === 1 && w.code === 'DUP_NAME_NO_CPF')).toBe(true);
    expect(client.calls.some((c) => isStudentInsert(c[0]))).toBe(false);
  });

  test('reimportação do MESMO arquivo (linha com CPF) continua protegida por (dojo_id, cpf)', async () => {
    const db = require('../src/config/database');
    const client = buildClient((s) => {
      if (isCpfDup(s)) return { rows: [{ id: 'ja-existe' }] };
    });
    db.connect = jest.fn().mockResolvedValueOnce(client);

    const rows = [{ full_name: 'Repetido', cpf: '52998224725' }];
    const res = await svc.importStudents(dojoId, rows, {});

    expect(res.created).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.warnings.some((w) => w.row === 1 && w.code === 'DUP_CPF')).toBe(true);
  });

  test('linha vazia demais (sem full_name) é ignorada sem tocar o banco de dedupe/insert', async () => {
    const db = require('../src/config/database');
    const client = buildClient(() => undefined);
    db.connect = jest.fn().mockResolvedValueOnce(client);

    const res = await svc.importStudents(dojoId, [{ full_name: '   ' }], {});

    expect(res.created).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.warnings[0]).toMatchObject({ row: 1, code: 'MISSING_NAME' });
    expect(client.calls.some((c) => isStudentInsert(c[0]))).toBe(false);
  });
});
