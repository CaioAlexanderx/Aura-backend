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

  // ── splitAddress ──────────────────────────────────────────────
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
//
// F14 (13/08/2026) — POR QUE ESTE BLOCO FOI REESCRITO
// O handler deixou de fazer ~10 queries POR LINHA e passou a fazer um
// número FIXO de queries por LOTE (ver o cabeçalho de importStudents). Os
// SQLs mudaram, então os despachos do mock mudam no MESMO PR — e, junto,
// as asserções que só faziam sentido em SQL de uma linha por vez
// (`params[6]` era o telefone daquela linha; agora `params[8]` é o ARRAY
// de telefones do lote).
//
// O mock virou um BANCO DE MENTIRA em vez de uma pilha de respostas
// prontas: ele responde às leituras a partir de `existing`, o conjunto de
// linhas que "já estão no banco DAQUELE dojô", indexado por dojo_id. Isso
// tira a tautologia da versão anterior por dois lados:
//   • o escopo é confrontado com DADO: se o handler mandar o dojo_id
//     errado, o banco de mentira não acha nada e o caso de reimportação
//     falha — antes, o teste só comparava params[0] com a constante do
//     próprio arquivo, o que é sempre verdade e não prova escopo nenhum;
//   • a resposta depende do que foi PERGUNTADO: os CPFs/nomes que voltam
//     são os que o handler mandou e que existem lá, não uma linha fixa.
// ============================================================
describe('F12/F14 — import transacional: tag, responsável mãe/pai, idade desconhecida', () => {
  const dojoId = 'd0000000-0000-0000-0000-000000000002';
  const OUTRO_DOJO = 'd0000000-0000-0000-0000-00000000dead';

  // ── Despacho por SQL (âncora de comentário `-- tag:` onde existe) ──
  // Nenhum predicado novo canibaliza os antigos: as âncoras `tag:` são
  // únicas, e "karate_dojo_student_guardians"/"karate_dojo_student_tags"
  // não casam com /karate_dojo_students/ (o "s" final não bate).
  function isBegin(s) { return /^BEGIN/.test(s.trim()); }
  function isCommit(s) { return /^COMMIT/.test(s.trim()); }
  function isRollback(s) { return /^ROLLBACK/.test(s.trim()); }
  function isIdleGuard(s) { return /SET\s+LOCAL\s+idle_in_transaction_session_timeout/i.test(s); }
  function isSavepoint(s) { return /^(SAVEPOINT|RELEASE SAVEPOINT)/.test(s.trim()); }
  function isCpfDup(s) { return /tag:import_dedupe_cpf/.test(s); }
  function isNameDup(s) { return /tag:import_dedupe_name_birth/.test(s); }
  function isTagUpsert(s) { return /INSERT INTO karate_dojo_tags/.test(s); }
  function isGuardianLookup(s) { return /tag:import_guardian_lookup/.test(s); }
  function isGuardianInsert(s) { return /INSERT INTO karate_dojo_guardians/.test(s); }
  function isStudentInsert(s) { return /INSERT INTO karate_dojo_students/.test(s); }
  function isTagLink(s) { return /INSERT INTO karate_dojo_student_tags/.test(s); }
  function isGuardianLink(s) { return /INSERT INTO karate_dojo_student_guardians/.test(s); }

  // Ordem das colunas do INSERT em lote de alunos. $1 é o dojo_id; de $2
  // em diante é um array por coluna, nesta ordem.
  const STUDENT_COLS = [
    'id', 'full_name', 'birth_date', 'cpf', 'rg', 'sex', 'phone', 'email',
    'belt_label', 'belt_order', 'status', 'guardian_id',
    'mother_name', 'father_name', 'zip_code', 'street', 'number', 'complement',
    'neighborhood', 'city', 'state',
  ];
  function col(params, name) {
    const i = STUDENT_COLS.indexOf(name);
    if (i < 0) throw new Error(`coluna desconhecida no INSERT de alunos: ${name}`);
    return params[1 + i];
  }
  // Guardas: se o INSERT mudar de forma, o teste precisa QUEBRAR aqui e
  // não passar por acidente lendo o array errado.
  function studentInsertOf(client) {
    const call = client.calls.find((c) => isStudentInsert(c[0]));
    if (!call) return null;
    expect(call[1]).toHaveLength(1 + STUDENT_COLS.length);
    return call[1];
  }

  const lower = (v) => String(v).toLowerCase();

  // ── Banco de mentira: responde às LEITURAS a partir de `existing` ──
  // `existing` é { [dojo_id]: { students: [...], guardians: [...] } }.
  function buildClient(existing = {}, extra = () => undefined) {
    const calls = [];
    const tagStore = new Map(); // lower(nome) → { id, name }
    let tagSeq = 0;
    const client = {
      query: jest.fn(async (sql, params) => {
        const s = String(sql);
        calls.push([s, params]);
        if (isBegin(s) || isCommit(s) || isRollback(s) || isIdleGuard(s) || isSavepoint(s)) return {};

        const custom = extra(s, params);
        if (custom !== undefined) return custom;

        const scope = existing[params && params[0]] || { students: [], guardians: [] };

        if (isCpfDup(s)) {
          const asked = params[1] || [];
          const rows = (scope.students || [])
            .filter((st) => st.cpf && asked.includes(st.cpf))
            .map((st) => ({ cpf: st.cpf }));
          return { rows };
        }

        if (isNameDup(s)) {
          const names = params[1] || [];
          const births = params[2] || [];
          const rows = [];
          for (let i = 0; i < names.length; i++) {
            const hit = (scope.students || []).some(
              (st) => lower(st.full_name) === lower(names[i])
                && (st.birth_date || null) === (births[i] || null)
            );
            if (hit) rows.push({ ord: String(i + 1) });
          }
          return { rows };
        }

        if (isGuardianLookup(s)) {
          const names = params[1] || [];
          const phones = params[2] || [];
          const rows = [];
          for (let i = 0; i < names.length; i++) {
            const cands = (scope.guardians || [])
              .filter((g) => lower(g.full_name) === lower(names[i]))
              .filter((g) => phones[i] == null || (g.phone || '') === (phones[i] || ''))
              // mesmo desempate do SQL: quem tem telefone primeiro, depois o mais antigo
              .sort((a, b) => (b.phone ? 1 : 0) - (a.phone ? 1 : 0) || a.seq - b.seq);
            if (cands.length) rows.push({ ord: String(i + 1), id: cands[0].id, has_phone: !!cands[0].phone });
          }
          return { rows };
        }

        if (isTagUpsert(s)) {
          const names = params[1] || [];
          const rows = [];
          for (const name of names) {
            const key = lower(name);
            if (!tagStore.has(key)) { tagSeq += 1; tagStore.set(key, { id: `tag${tagSeq}`, name }); }
            rows.push({ id: tagStore.get(key).id, name: tagStore.get(key).name });
          }
          return { rows };
        }

        if (isStudentInsert(s)) {
          // RETURNING id, practitioner_id — os ids são os que o handler
          // gerou e mandou; practitioner_id é sempre NULL no import.
          return { rows: (params[1] || []).map((id) => ({ id, practitioner_id: null })) };
        }

        return { rows: [] };
      }),
      release: jest.fn(),
    };
    client.calls = calls;
    return client;
  }

  function mount(client) {
    const db = require('../src/config/database');
    db.connect = jest.fn().mockResolvedValueOnce(client);
  }

  // ── F14: o custo do lote não cresce com o número de linhas ──
  describe('F14 — número de idas ao banco é FIXO por lote (era ~10 por linha)', () => {
    function lote(n) {
      const rows = [];
      for (let i = 0; i < n; i++) {
        rows.push({
          full_name: `Aluno ${i}`,
          birth_date: '2015-06-01',
          mother_name: `Mãe ${i}`,
          father_name: `Pai ${i}`,
          phone: '91988887777',
          academia: 'Escola I Karate Areikan',
        });
      }
      return rows;
    }

    test('3 linhas e 30 linhas custam exatamente as MESMAS queries', async () => {
      const c3 = buildClient({});
      mount(c3);
      const r3 = await svc.importStudents(dojoId, lote(3), {});

      const c30 = buildClient({});
      mount(c30);
      const r30 = await svc.importStudents(dojoId, lote(30), {});

      expect(r3.created).toBe(3);
      expect(r30.created).toBe(30);
      // O número de queries é o mesmo — é ESTE o conserto do PR.
      expect(c30.calls.length).toBe(c3.calls.length);
      // E as escritas em lote acontecem UMA vez cada, para 30 alunos.
      expect(c30.calls.filter((c) => isStudentInsert(c[0]))).toHaveLength(1);
      expect(c30.calls.filter((c) => isGuardianInsert(c[0]))).toHaveLength(1);
      expect(c30.calls.filter((c) => isTagLink(c[0]))).toHaveLength(1);
      expect(c30.calls.filter((c) => isTagUpsert(c[0]))).toHaveLength(1);
      expect(c30.calls.filter((c) => isNameDup(c[0]))).toHaveLength(1);
      expect(c30.calls.filter((c) => isGuardianLookup(c[0]))).toHaveLength(1);
      // 30 alunos entram no MESMO INSERT (e 60 responsáveis no mesmo insert).
      expect(studentInsertOf(c30)[1]).toHaveLength(30);
      const gIns = c30.calls.find((c) => isGuardianInsert(c[0]));
      expect(gIns[1][2]).toHaveLength(60);
    });

    test('a transação abre com o teto de ociosidade (SET LOCAL) antes de qualquer escrita', async () => {
      const client = buildClient({});
      mount(client);
      await svc.importStudents(dojoId, lote(1), {});

      expect(isBegin(client.calls[0][0])).toBe(true);
      expect(isIdleGuard(client.calls[1][0])).toBe(true);
      // SET LOCAL (e não SET puro): fora da transação o pooler em modo
      // transaction descarta o parâmetro — foi assim que a transação
      // órfã de 8 minutos passou pelo SET do pool em src/config/database.js.
      expect(client.calls[1][0]).toMatch(/SET\s+LOCAL/i);
      expect(client.calls[1][0]).not.toMatch(/\$\d/); // SET não aceita parâmetro
    });
  });

  test('Academia vira tag: UM upsert para o lote e um vínculo por aluno', async () => {
    const client = buildClient({});
    mount(client);

    const rows = [
      { full_name: 'Aluno Um', cpf: '52998224725', academia: 'Escola I Karate Areikan' },
      { full_name: 'Aluno Dois', cpf: '11144477735', academia: 'escola i karate areikan' }, // mesma tag, case diferente
    ];
    const res = await svc.importStudents(dojoId, rows, {});

    expect(res.created).toBe(2);
    const tagUpserts = client.calls.filter((c) => isTagUpsert(c[0]));
    // 1 upsert só, com 1 nome: as duas linhas colapsam na mesma chave
    // normalizada em minúsculas antes de o SQL ser montado.
    expect(tagUpserts).toHaveLength(1);
    expect(tagUpserts[0][1][0]).toBe(dojoId);
    expect(tagUpserts[0][1][1]).toEqual(['Escola I Karate Areikan']);
    // O arbiter repete a EXPRESSÃO do índice (uq_karate_dojo_tags_dojo_name_ci).
    expect(tagUpserts[0][0]).toMatch(/ON CONFLICT \(dojo_id, lower\(name\)\)/);

    const tagLinks = client.calls.filter((c) => isTagLink(c[0]));
    expect(tagLinks).toHaveLength(1);
    // Os dois alunos, com a MESMA tag — e os student_id são exatamente os
    // ids que foram gravados no INSERT de alunos.
    const ids = col(studentInsertOf(client), 'id');
    expect(tagLinks[0][1][0]).toEqual(ids);
    expect(tagLinks[0][1][1]).toEqual(['tag1', 'tag1']);
  });

  // F13 (12/08/2026): este caso ANTES afirmava "responsável vira a MÃE".
  // O handler mudou (mãe E pai), então o caso muda no MESMO PR.
  // F14: o INSERT dos dois responsáveis virou UM só, com arrays.
  test('menor sem guardian_name explícito: mãe E pai viram responsáveis; o telefone/e-mail da linha fica com a MÃE', async () => {
    const client = buildClient({});
    mount(client);

    const rows = [{
      full_name: 'Criança Menor', birth_date: '2015-06-01',
      mother_name: 'Maria da Silva', father_name: 'José da Silva',
      phone: '91988887777', email: 'mae@exemplo.com',
    }];
    const res = await svc.importStudents(dojoId, rows, {});

    expect(res.created).toBe(1);
    expect(res.warnings.some((w) => w.code === 'MENOR_SEM_RESPONSAVEL')).toBe(false); // achou os pais: sem warning

    const gIns = client.calls.filter((c) => isGuardianInsert(c[0]));
    expect(gIns).toHaveLength(1);
    const [gScope, gIds, gNames, gPhones, gEmails, gRels] = gIns[0][1];
    expect(gScope).toBe(dojoId);
    expect(gNames).toEqual(['Maria da Silva', 'José da Silva']);
    // MÃE: fica com o contato ÚNICO da planilha e com o parentesco certo.
    // PAI: entra NOMEADO e SEM contato — inventar um telefone (copiar o da
    // mãe) seria pior do que não ter; numa emergência, dois números iguais
    // é UM número com aparência de dois.
    expect(gPhones).toEqual(['91988887777', null]);
    expect(gEmails).toEqual(['mae@exemplo.com', null]);
    expect(gRels).toEqual(['mãe', 'pai']);

    const semContato = res.warnings.find((w) => w.code === 'GUARDIAN_SEM_CONTATO');
    expect(semContato).toMatchObject({ row: 1 });
    expect(semContato.message).toContain('José da Silva');

    // DOIS vínculos, um só principal (a mãe, que tem o contato) — e os ids
    // do vínculo são os MESMOS que foram inseridos (aluno e responsáveis),
    // não valores inventados pelo mock.
    const params = studentInsertOf(client);
    const studentId = col(params, 'id')[0];
    const link = client.calls.find((c) => isGuardianLink(c[0]));
    expect(link[1]).toEqual([studentId, gIds[0], 'mãe', true, studentId, gIds[1], 'pai', false]);

    // guardian_id (legado) segue apontando para a MÃE — asserção original
    // preservada: nenhuma ficha existente muda de responsável principal.
    expect(col(params, 'guardian_id')).toEqual([gIds[0]]);
    // O telefone/email do PRÓPRIO aluno ficam null (o contato migrou para
    // o responsável — evita registrar o contato do adulto como se fosse da
    // criança de 10 anos).
    expect(col(params, 'phone')).toEqual([null]);
    expect(col(params, 'email')).toEqual([null]);
    // mother_name/father_name são filiação e são gravados SEMPRE, mesmo
    // quando os dois também são os responsáveis.
    expect(col(params, 'mother_name')).toEqual(['Maria da Silva']);
    expect(col(params, 'father_name')).toEqual(['José da Silva']);
  });

  // F14 — o "cache do lote" da F13 virou índice de chaves distintas. Este
  // caso é o que prova que ele continua fazendo o serviço para o qual foi
  // criado: 87 responsáveis da planilha real do Areikan são compartilhados
  // por irmãos.
  test('irmãos compartilham a MESMA mãe: um INSERT de responsável, dois vínculos', async () => {
    const client = buildClient({});
    mount(client);

    const rows = [
      { full_name: 'Caio Marmorato Toloi', birth_date: '2014-03-02', mother_name: 'Ana Marmorato', phone: '1699998888' },
      { full_name: 'Lucas Marmorato Toloi', birth_date: '2016-07-19', mother_name: 'Ana Marmorato', phone: '1699998888' },
    ];
    const res = await svc.importStudents(dojoId, rows, {});

    expect(res.created).toBe(2);
    const gIns = client.calls.filter((c) => isGuardianInsert(c[0]));
    expect(gIns).toHaveLength(1);
    expect(gIns[0][1][2]).toEqual(['Ana Marmorato']); // UMA linha de responsável
    const guardianId = gIns[0][1][1][0];

    const params = studentInsertOf(client);
    expect(col(params, 'guardian_id')).toEqual([guardianId, guardianId]);

    const link = client.calls.find((c) => isGuardianLink(c[0]));
    const ids = col(params, 'id');
    expect(link[1]).toEqual([ids[0], guardianId, 'mãe', true, ids[1], guardianId, 'mãe', true]);
  });

  // F14 — a busca SEM telefone (o segundo responsável) tem que continuar
  // aceitando a pessoa que já existe COM telefone; senão um pai já
  // cadastrado vira uma SEGUNDA linha sem contato.
  test('pai já cadastrado COM telefone é reaproveitado pela busca sem telefone (não vira segundo cadastro)', async () => {
    const client = buildClient({
      [dojoId]: {
        students: [],
        guardians: [{ id: 'g-pai-existente', full_name: 'José da Silva', phone: '1633334444', seq: 1 }],
      },
    });
    mount(client);

    const rows = [{
      full_name: 'Criança Menor', birth_date: '2015-06-01',
      mother_name: 'Maria da Silva', father_name: 'José da Silva',
      phone: '91988887777',
    }];
    const res = await svc.importStudents(dojoId, rows, {});

    expect(res.created).toBe(1);
    const gIns = client.calls.filter((c) => isGuardianInsert(c[0]));
    // Só a MÃE é criada; o pai é reaproveitado.
    expect(gIns[0][1][2]).toEqual(['Maria da Silva']);

    const link = client.calls.find((c) => isGuardianLink(c[0]));
    expect(link[1]).toContain('g-pai-existente');
  });

  test('menor sem mãe nem pai na planilha: continua entrando com warning MENOR_SEM_RESPONSAVEL (nunca bloqueia)', async () => {
    const client = buildClient({});
    mount(client);

    const rows = [{ full_name: 'Órfão De Planilha', birth_date: '2016-01-01' }];
    const res = await svc.importStudents(dojoId, rows, {});

    expect(res.created).toBe(1);
    expect(res.skipped).toBe(0);
    expect(res.warnings.some((w) => w.row === 1 && w.code === 'MENOR_SEM_RESPONSAVEL')).toBe(true);
    expect(client.calls.some((c) => isGuardianInsert(c[0]))).toBe(false);
    // sem responsável nenhum, nenhum vínculo é escrito (nem SAVEPOINT),
    // e nem a busca de responsáveis chega a ser feita
    expect(client.calls.some((c) => isGuardianLink(c[0]))).toBe(false);
    expect(client.calls.some((c) => isGuardianLookup(c[0]))).toBe(false);
  });

  test('sem birth_date (idade desconhecida): tratado como adulto, telefone/email ficam no próprio aluno, warning declarado', async () => {
    const client = buildClient({});
    mount(client);

    const rows = [{
      full_name: 'Idade Desconhecida', mother_name: 'Mãe Desconhecida',
      phone: '91977776666', email: 'quemsabe@exemplo.com',
    }];
    const res = await svc.importStudents(dojoId, rows, {});

    expect(res.created).toBe(1);
    expect(res.warnings.some((w) => w.row === 1 && w.code === 'AGE_UNKNOWN_TREATED_AS_ADULT')).toBe(true);
    // adulto: NENHUM responsável é criado a partir da mãe (é só filiação aqui)
    expect(client.calls.some((c) => isGuardianInsert(c[0]))).toBe(false);
    const params = studentInsertOf(client);
    // telefone/email do próprio aluno (não migraram para ninguém)
    expect(col(params, 'phone')).toEqual(['91977776666']);
    expect(col(params, 'email')).toEqual(['quemsabe@exemplo.com']);
    expect(col(params, 'mother_name')).toEqual(['Mãe Desconhecida']);
  });

  test('CPF com DV inválido: importa mesmo assim, com warning de revisão (nunca bloqueia a linha)', async () => {
    const client = buildClient({});
    mount(client);

    const rows = [{ full_name: 'CPF Torto', cpf: '52998224726' }]; // DV inválido de propósito
    const res = await svc.importStudents(dojoId, rows, {});

    expect(res.created).toBe(1);
    expect(res.warnings.some((w) => w.row === 1 && w.code === 'CPF_CHECKSUM_INVALID')).toBe(true);
    expect(col(studentInsertOf(client), 'cpf')).toEqual(['52998224726']); // CPF entra assim mesmo
  });

  // 13/08/2026 — o complemento tem coluna PRÓPRIA (karate_dojo_students.
  // complement, text, já existente). Antes ele ficava grudado em `street`
  // e o apartamento ia parar em `number`.
  test('endereço com complemento: number é o da VIA e o complemento vai para a coluna complement', async () => {
    const client = buildClient({});
    mount(client);

    const rows = [{ full_name: 'Mora No Apto', address: 'Rua Manoel Rodrigues Jacob 1451 - AP 74' }];
    const res = await svc.importStudents(dojoId, rows, {});

    expect(res.created).toBe(1);
    const call = client.calls.find((c) => isStudentInsert(c[0]));
    expect(call[0]).toContain('complement'); // a coluna entra no INSERT
    expect(col(call[1], 'street')).toEqual(['Rua Manoel Rodrigues Jacob']);
    expect(col(call[1], 'number')).toEqual(['1451']); // a VIA, não o "74" do AP
    expect(col(call[1], 'complement')).toEqual(['AP 74']);
  });

  test('complement explícito da planilha tem prioridade e o street/number já separados não são reprocessados', async () => {
    const client = buildClient({});
    mount(client);

    const rows = [{
      full_name: 'Planilha Nova',
      street: 'Rua Já Separada', number: '10', complement: 'Bloco B apto 3',
      address: 'Rua Ignorada 999 casa 1',
    }];
    const res = await svc.importStudents(dojoId, rows, {});

    expect(res.created).toBe(1);
    const params = studentInsertOf(client);
    expect(col(params, 'street')).toEqual(['Rua Já Separada']);
    expect(col(params, 'number')).toEqual(['10']);
    expect(col(params, 'complement')).toEqual(['Bloco B apto 3']);
  });

  // ── Dedupe: as DUAS mensagens continuam saindo no caso certo ──
  describe('dedupe (a política de SKIP não mudou)', () => {
    test('reimportação de linha SEM CPF: dedupe por (dojo_id, nome, nascimento) evita duplicar', async () => {
      const client = buildClient({
        [dojoId]: { students: [{ full_name: 'Já Importado Antes', birth_date: '2000-01-01' }], guardians: [] },
      });
      mount(client);

      const rows = [{ full_name: 'Já Importado Antes', birth_date: '2000-01-01' }];
      const res = await svc.importStudents(dojoId, rows, {});

      expect(res.created).toBe(0);
      expect(res.skipped).toBe(1);
      expect(res.warnings.some((w) => w.row === 1 && w.code === 'DUP_NAME_NO_CPF')).toBe(true);
      expect(client.calls.some((c) => isStudentInsert(c[0]))).toBe(false);
    });

    test('reimportação do MESMO arquivo (linha com CPF) continua protegida por (dojo_id, cpf)', async () => {
      const client = buildClient({
        [dojoId]: { students: [{ full_name: 'Repetido', cpf: '52998224725' }], guardians: [] },
      });
      mount(client);

      const rows = [{ full_name: 'Repetido', cpf: '52998224725' }];
      const res = await svc.importStudents(dojoId, rows, {});

      expect(res.created).toBe(0);
      expect(res.skipped).toBe(1);
      expect(res.warnings.some((w) => w.row === 1 && w.code === 'DUP_CPF')).toBe(true);
    });

    // ESCOPO CONFRONTADO COM DADO, não com a constante: o mesmo aluno
    // "já existe", mas em OUTRO dojô. Se o handler mandar o dojo_id
    // errado na query de dedupe, o banco de mentira devolve a duplicata e
    // este caso quebra.
    test('o dedupe é POR DOJÔ: o mesmo CPF em outro dojô não bloqueia a linha', async () => {
      const client = buildClient({
        [OUTRO_DOJO]: { students: [{ full_name: 'Repetido', cpf: '52998224725' }], guardians: [] },
      });
      mount(client);

      const res = await svc.importStudents(dojoId, [{ full_name: 'Repetido', cpf: '52998224725' }], {});

      expect(res.created).toBe(1);
      expect(res.skipped).toBe(0);
      const dedupe = client.calls.find((c) => isCpfDup(c[0]));
      expect(dedupe[1][0]).toBe(dojoId);
      expect(dedupe[1][1]).toEqual(['52998224725']);
    });

    // As duas mensagens de DUP_CPF não são intercambiáveis, e qual delas
    // sai depende de a chave existir OU NÃO no banco — exatamente como no
    // laço antigo, que só marcava a chave como "vista no lote" depois de
    // ela sobreviver à consulta.
    test('chave NOVA repetida no lote: a 2ª linha leva "duplicado no lote"', async () => {
      const client = buildClient({});
      mount(client);

      const res = await svc.importStudents(dojoId, [
        { full_name: 'Primeira', cpf: '52998224725' },
        { full_name: 'Segunda', cpf: '52998224725' },
      ], {});

      expect(res.created).toBe(1);
      expect(res.skipped).toBe(1);
      const w = res.warnings.filter((x) => x.code === 'DUP_CPF');
      expect(w).toHaveLength(1);
      expect(w[0].row).toBe(2);
      expect(w[0].message).toMatch(/duplicado no lote/);
    });

    test('chave que JÁ ESTÁ no banco e repetida no lote: as DUAS linhas levam "já cadastrado"', async () => {
      const client = buildClient({
        [dojoId]: { students: [{ full_name: 'Primeira', cpf: '52998224725' }], guardians: [] },
      });
      mount(client);

      const res = await svc.importStudents(dojoId, [
        { full_name: 'Primeira', cpf: '52998224725' },
        { full_name: 'Segunda', cpf: '52998224725' },
      ], {});

      expect(res.created).toBe(0);
      expect(res.skipped).toBe(2);
      const w = res.warnings.filter((x) => x.code === 'DUP_CPF');
      expect(w.map((x) => x.row)).toEqual([1, 2]);
      for (const x of w) expect(x.message).toMatch(/já cadastrado neste dojô/);
    });

    test('linha vazia demais (sem full_name) é ignorada sem tocar o banco de dedupe/insert', async () => {
      const client = buildClient({});
      mount(client);

      const res = await svc.importStudents(dojoId, [{ full_name: '   ' }], {});

      expect(res.created).toBe(0);
      expect(res.skipped).toBe(1);
      expect(res.warnings[0]).toMatchObject({ row: 1, code: 'MISSING_NAME' });
      expect(client.calls.some((c) => isStudentInsert(c[0]))).toBe(false);
      expect(client.calls.some((c) => isCpfDup(c[0]))).toBe(false);
      expect(client.calls.some((c) => isNameDup(c[0]))).toBe(false);
    });
  });

  // ── Os warnings continuam saindo agrupados por LINHA ──
  // Esta é a parte que a reescrita mais poderia ter quebrado sem ninguém
  // notar: agora as fases rodam para o lote inteiro, e uma implementação
  // ingênua devolveria os avisos agrupados por FASE.
  test('a ordem dos warnings é por linha, e dentro da linha é a de sempre', async () => {
    const client = buildClient({});
    mount(client);

    const res = await svc.importStudents(dojoId, [
      { full_name: 'Linha Um', phone: '123' },                       // INVALID_PHONE + AGE_UNKNOWN
      { full_name: 'Linha Dois', birth_date: '2015-01-01', email: 'nao-e-email',
        mother_name: 'Mãe Dois', father_name: 'Pai Dois' },          // INVALID_EMAIL + GUARDIAN_SEM_CONTATO
    ], {});

    expect(res.created).toBe(2);
    expect(res.warnings.map((w) => [w.row, w.code])).toEqual([
      [1, 'INVALID_PHONE'],
      [1, 'AGE_UNKNOWN_TREATED_AS_ADULT'],
      [2, 'INVALID_EMAIL'],
      [2, 'GUARDIAN_SEM_CONTATO'],
    ]);
  });

  test('erro no meio do lote dá ROLLBACK e devolve a conexão', async () => {
    const boom = new Error('42703 column does not exist');
    const client = buildClient({}, (s) => {
      if (isStudentInsert(s)) throw boom;
      return undefined;
    });
    mount(client);

    await expect(svc.importStudents(dojoId, [{ full_name: 'Qualquer' }], {})).rejects.toThrow(boom);
    expect(client.calls.some((c) => isRollback(c[0]))).toBe(true);
    expect(client.calls.some((c) => isCommit(c[0]))).toBe(false);
    expect(client.release).toHaveBeenCalled();
  });
});
