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

  // ── splitAddress ────────────────────────────────────────────────────
  // 13/08/2026: a versão anterior pegava o ÚLTIMO número da string e por
  // isso o COMPLEMENTO virava o número da casa — medido em produção no
  // ensaio de 21 linhas do Areikan:
  //   "Rua Manoel Rodrigues Jacob 1451 - AP 74" gravou number='74'
  //   "Rua 21 Lote 15, quadra 12"               gravou number='12'
  // 129 dos 476 endereços da planilha (27%) trazem complemento no texto.
  // A regra nova procura o número da VIA (primeiro número depois do nome
  // da via e ANTES de qualquer marcador de complemento) e devolve um
  // terceiro campo, `complement`. Os 3 casos antigos continuam aqui, só
  // com o campo novo — o contrato de retorno mudou no mesmo PR.
  describe('splitAddress — o número é o da VIA, nunca o do complemento', () => {
    describe('COM complemento no texto: o número correto é o da via', () => {
      test.each([
        ['Rua Manoel Rodrigues Jacob 1451 - AP 74', 'Rua Manoel Rodrigues Jacob', '1451', 'AP 74'],
        ['Rua Carlos Gomes 1884 - Ap. 131', 'Rua Carlos Gomes', '1884', 'Ap. 131'],
        ['Rua Imaculada Conceição 3377 AP 401', 'Rua Imaculada Conceição', '3377', 'AP 401'],
        ['Avenida São Geraldo 229 AP 84', 'Avenida São Geraldo', '229', 'AP 84'],
        ['Avenida Martinho Gerhard Rolfsen 1027 - casa 39', 'Avenida Martinho Gerhard Rolfsen', '1027', 'casa 39'],
        ['Rua Professora Adélia Izique 1101, apto 908', 'Rua Professora Adélia Izique', '1101', 'apto 908'],
        ['Rua Comendador Pedro Morganti 1509 ap.92', 'Rua Comendador Pedro Morganti', '1509', 'ap.92'],
        ['Rua Lilia Elisa Eberle Lupo 841 casa C51', 'Rua Lilia Elisa Eberle Lupo', '841', 'casa C51'],
        ['Rua Benedito Jesus Santos Miguel 46, apto 06', 'Rua Benedito Jesus Santos Miguel', '46', 'apto 06'],
        ['Avenida Governador Orestes Quercia 1301 (b. 23 / ap. 101)', 'Avenida Governador Orestes Quercia', '1301', '(b. 23 / ap. 101)'],
        ['Avenida Deputado Federal Mário Eugênio 600 casa J4', 'Avenida Deputado Federal Mário Eugênio', '600', 'casa J4'],
        ['Avenida Dom Pedro II 1195, apto 42', 'Avenida Dom Pedro II', '1195', 'apto 42'],
        ['Rua Bahia 2790 - bloco H apto 44', 'Rua Bahia', '2790', 'bloco H apto 44'],
        ['Avenida José Bonifácio 797 - apto 121', 'Avenida José Bonifácio', '797', 'apto 121'],
        ['Rua Gonçalves Dias 878 - casa 07', 'Rua Gonçalves Dias', '878', 'casa 07'],
        ['Avenida Rodrigo Fernando Grillo 587 apto 1 BL 1', 'Avenida Rodrigo Fernando Grillo', '587', 'apto 1 BL 1'],
        ['Avenida Sebastião Aparecido Lopes 177, apto 304-Bloco 2', 'Avenida Sebastião Aparecido Lopes', '177', 'apto 304-Bloco 2'],
        ['Avenida Oswaldo Gonçalves de Jesus 387 quadra C lote 24', 'Avenida Oswaldo Gonçalves de Jesus', '387', 'quadra C lote 24'],
        ["Avenida Mari Amélia de Amorim Dael'Olio 278 - Qd D lote 8", "Avenida Mari Amélia de Amorim Dael'Olio", '278', 'Qd D lote 8'],
        ['Rua Lilia Elisa Eberle Lupo 501 - Quadra C lote 13', 'Rua Lilia Elisa Eberle Lupo', '501', 'Quadra C lote 13'],
        ['Rua Nívea Cunha Fenerich 201 - casa 18', 'Rua Nívea Cunha Fenerich', '201', 'casa 18'],
        // "15" faz parte do NOME da via; o número de porta é o 890
        ['Avenida 15 de Novembro 890 Apto 112', 'Avenida 15 de Novembro', '890', 'Apto 112'],
        ['Avenida João Porsani R A, 64 LT 08 Quadra A', 'Avenida João Porsani R A', '64', 'LT 08 Quadra A'],
        ['Avenida Deputado Federal Mário Eugênio 595, casa i 14', 'Avenida Deputado Federal Mário Eugênio', '595', 'casa i 14'],
        // "N°" colado no número
        ['Avenida Ipê Branco N°63 casa H12', 'Avenida Ipê Branco', '63', 'casa H12'],
        // linhas REAIS gravadas errado no ensaio de 21 (produção, 13/08/2026)
        ['Rua Comendador Pedro Morganti 1409 - Apto. 96', 'Rua Comendador Pedro Morganti', '1409', 'Apto. 96'],
        ['Alameda 2 246 Quadra 12, lote 11/12', 'Alameda 2', '246', 'Quadra 12, lote 11/12'],
        ['Alameda 2 n 246 Quadra 12, lote 11/12', 'Alameda 2', '246', 'Quadra 12, lote 11/12'],
      ])('%s → street=%s number=%s complement=%s', (raw, street, number, complement) => {
        expect(svc.splitAddress(raw)).toEqual({ street, number, complement });
      });
    });

    // DECISÃO (regra de ouro): sem número de porta reconhecível, number
    // fica NULL. "Casa J2" e "Lote 15" identificam a unidade dentro do
    // condomínio, não a porta na via — gravá-los em `number` faria a ficha
    // AFIRMAR algo falso e quebraria ordenação/busca por número. Nada se
    // perde: o texto vai inteiro para `complement`.
    describe('SEM número de via: number NULL, complemento preservado', () => {
      test('"Avenida Nadima Damha Casa J2" → number null, "Casa J2" vira complemento', () => {
        expect(svc.splitAddress('Avenida Nadima Damha Casa J2'))
          .toEqual({ street: 'Avenida Nadima Damha', number: null, complement: 'Casa J2' });
      });
      test('"Rua 21 Lote 15, quadra 12" → "21" é o NOME da via; não há número de porta', () => {
        expect(svc.splitAddress('Rua 21 Lote 15, quadra 12'))
          .toEqual({ street: 'Rua 21', number: null, complement: 'Lote 15, quadra 12' });
      });
    });

    // Os 347 simples (73% da planilha) NÃO podem quebrar.
    describe('SIMPLES (347 dos 476): número no fim, sem complemento', () => {
      test.each([
        ['Avenida São Geraldo 131', 'Avenida São Geraldo', '131'],
        ['Rua Lázaro Pedroso 577', 'Rua Lázaro Pedroso', '577'],
        ['Avenida Miguel Damha 40', 'Avenida Miguel Damha', '40'],
        ['Rua Pedro Álvares Cabral 253', 'Rua Pedro Álvares Cabral', '253'],
        ['Avenida das Bromélias 93', 'Avenida das Bromélias', '93'],
        ['Rua João Gurgel 173', 'Rua João Gurgel', '173'],
        // número no NOME da via, sem complemento: o de porta ainda é o 890
        ['Avenida 15 de Novembro 890', 'Avenida 15 de Novembro', '890'],
        // linhas reais do ensaio de 21 que já estavam certas
        ['Avenida Irma Antonia de Arruda Camargo 352', 'Avenida Irma Antonia de Arruda Camargo', '352'],
        ['Rua Clóvis Silveira Bueno 1114', 'Rua Clóvis Silveira Bueno', '1114'],
        ['Rua Miguel Cortez 478', 'Rua Miguel Cortez', '478'],
        // casos do teste ORIGINAL desta suíte (contrato só ganhou complement)
        ['Rua Exemplo 123', 'Rua Exemplo', '123'],
        ['Avenida Teste, 45A', 'Avenida Teste', '45A'],
      ])('%s → street=%s number=%s (complement null)', (raw, street, number) => {
        expect(svc.splitAddress(raw)).toEqual({ street, number, complement: null });
      });
    });

    describe('SEM nenhum dígito: number null e street inteiro', () => {
      test.each([
        'Avenida Aagide Hermes Callera',
        'Rua Padre Duarte',
        'Avenida Jorge Miguel Saba',
        'Travessa Sem Numero',
      ])('%s → tudo em street (dado faltante é neutro, não erro)', (raw) => {
        expect(svc.splitAddress(raw)).toEqual({ street: raw, number: null, complement: null });
      });
    });

    describe('guardas contra o remédio virar doença', () => {
      test('palavra de complemento no NOME da via não vira complemento ("Rua Casa Branca 100")', () => {
        expect(svc.splitAddress('Rua Casa Branca 100'))
          .toEqual({ street: 'Rua Casa Branca', number: '100', complement: null });
      });
      test('número do NOME da via sem número de porta → number null (nunca chutar "15")', () => {
        expect(svc.splitAddress('Avenida 15 de Novembro'))
          .toEqual({ street: 'Avenida 15 de Novembro', number: null, complement: null });
      });
      test('espaços repetidos são normalizados, não perdem texto', () => {
        expect(svc.splitAddress('  Rua   Exemplo   123  '))
          .toEqual({ street: 'Rua Exemplo', number: '123', complement: null });
      });
      test('ausente/vazio → os três campos null', () => {
        expect(svc.splitAddress(null)).toEqual({ street: null, number: null, complement: null });
        expect(svc.splitAddress('')).toEqual({ street: null, number: null, complement: null });
        expect(svc.splitAddress('   ')).toEqual({ street: null, number: null, complement: null });
      });
    });

    // Invariante do PR: NADA de texto se perde. street + number +
    // complement, concatenados, reconstroem o endereço original a menos de
    // pontuação separadora, espaços e do RÓTULO "nº/N°" (que deixa de ser
    // texto e vira o campo `number`).
    test('invariante: street + number + complement reconstroem o endereço original', () => {
      const amostra = [
        'Rua Manoel Rodrigues Jacob 1451 - AP 74',
        'Rua 21 Lote 15, quadra 12',
        'Avenida Nadima Damha Casa J2',
        'Avenida Governador Orestes Quercia 1301 (b. 23 / ap. 101)',
        'Avenida Sebastião Aparecido Lopes 177, apto 304-Bloco 2',
        'Alameda 2 246 Quadra 12, lote 11/12',
        'Avenida 15 de Novembro 890 Apto 112',
        'Avenida Aagide Hermes Callera',
        'Rua Exemplo 123',
      ];
      const soLetrasENumeros = (s) => String(s || '').toLowerCase().replace(/[^0-9a-zà-ÿ]/gi, '');
      for (const raw of amostra) {
        const r = svc.splitAddress(raw);
        const rebuilt = soLetrasENumeros([r.street, r.number, r.complement].filter(Boolean).join(' '));
        expect(rebuilt).toBe(soLetrasENumeros(raw));
      }
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

  // 13/08/2026 — o complemento tem coluna PRÓPRIA (karate_dojo_students.
  // complement, text, já existente: nenhuma migration neste PR). Antes ele
  // ficava grudado em `street` e o apartamento ia parar em `number`.
  test('endereço com complemento: number é o da VIA e o complemento vai para a coluna complement', async () => {
    const db = require('../src/config/database');
    const client = buildClient((s) => {
      if (isNameDup(s)) return { rows: [] };
    });
    db.connect = jest.fn().mockResolvedValueOnce(client);

    const rows = [{ full_name: 'Mora No Apto', address: 'Rua Manoel Rodrigues Jacob 1451 - AP 74' }];
    const res = await svc.importStudents(dojoId, rows, {});

    expect(res.created).toBe(1);
    const insert = client.calls.find((c) => isStudentInsert(c[0]));
    expect(insert[0]).toContain('complement'); // a coluna entra no INSERT
    expect(insert[1][15]).toBe('Rua Manoel Rodrigues Jacob'); // street
    expect(insert[1][16]).toBe('1451');                       // number: a VIA, não o "74" do AP
    expect(insert[1][17]).toBe('AP 74');                      // complement
  });

  test('complement explícito da planilha tem prioridade e o street/number já separados não são reprocessados', async () => {
    const db = require('../src/config/database');
    const client = buildClient((s) => {
      if (isNameDup(s)) return { rows: [] };
    });
    db.connect = jest.fn().mockResolvedValueOnce(client);

    const rows = [{
      full_name: 'Planilha Nova',
      street: 'Rua Já Separada', number: '10', complement: 'Bloco B apto 3',
      address: 'Rua Ignorada 999 casa 1',
    }];
    const res = await svc.importStudents(dojoId, rows, {});

    expect(res.created).toBe(1);
    const p = client.calls.find((c) => isStudentInsert(c[0]))[1];
    expect(p[15]).toBe('Rua Já Separada');
    expect(p[16]).toBe('10');
    expect(p[17]).toBe('Bloco B apto 3');
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
