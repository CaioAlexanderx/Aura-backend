// ============================================================
// AURA DOJÔ — F7.3-A: unit da GUARDA ÚNICA de escrita de identidade
//
// Alvo: src/services/karateIdentityWriteGuard.js — sem Express, sem
// Postgres. É o módulo que decide, para TODOS os canais da federação, se
// uma escrita em customers pode tocar a PESSOA.
//
// A REGRA, EM UMA FRASE
//   Ficha com customers.karate_identity_managed_by = 'dojo' não aceita
//   escrita de CAMPO DE IDENTIDADE por nenhum canal da federação — e a
//   recusa diz QUAL dojô mantém aquela ficha.
//
// ── POR QUE ESTE ARQUIVO EXISTE ─────────────────────────────
// A promessa central do PR é uma promessa de LISTA: "o que o dojô
// sincroniza é exatamente o que a federação deixa de escrever, e o que a
// federação EMITE continua livre". Promessa de lista só vale se for
// EXECUTADA — o primeiro describe abaixo é literalmente essa execução.
// Se alguém acrescentar `karate_registration_number` a IDENTITY_FIELDS
// (ou `rg` a FEDERATION_OWNED_COLS), este arquivo fica vermelho antes de
// a matrícula de alguém virar 409 em produção.
//
// ── ESTILO DE MOCK ──────────────────────────────────────────
// Despacho por TEXTO do SQL (regex), nunca por fila posicional. A guarda
// emite SAVEPOINT/RELEASE/ROLLBACK em volta da leitura do dono: com fila
// posicional, cada linha nova de defensivo empurraria todas as respostas
// um degrau e o CI ficaria vermelho pelo motivo errado.
// ============================================================
'use strict';

const guard = require('../src/services/karateIdentityWriteGuard');
const { FEDERATION_OWNED_COLS } = require('../src/services/karateIdentitySync');
const { EXIT_REASONS, EXIT_LABELS } = require('../src/services/karateDojoExitState');

const {
  CHANNELS,
  IDENTITY_COLS,
  FEDERATION_ALWAYS_ALLOWED,
  OVERRIDE_FLAG_KEY,
  OVERRIDE_REASON_KEY,
  CODE_BLOCKED,
  CODE_OVERRIDE_FORBIDDEN,
  CODE_OVERRIDE_REASON,
  assertGuardListsAreDisjoint,
  assertIdentityWriteAllowed,
  loadIdentityOwner,
  buildOverrideChanges,
  writeOverrideAudit,
  identityGuardBody,
  identityOwnershipPayload,
  isIdentityGuardError,
} = guard;

// ── Fixtures ────────────────────────────────────────────────
const DOJO_ID = 'dojo-uuid-0001';
const DOJO_NAME = 'Dojô Kondei Brasil';
const PRACT_ID = 'pract-uuid-0001';
const FED_ID = 'fed-uuid-0001';

// Linha do OWNER_SQL com a identidade na FEDERAÇÃO — o caminho de 9.783
// dos 9.783 praticantes de hoje.
function federationOwnerRow(overrides = {}) {
  return {
    id: PRACT_ID,
    practitioner_label: 'Ana Preta',
    fpkt_number: 'FPKT-001',
    federation_id: FED_ID,
    karate_identity_managed_by: 'federation',
    karate_identity_dojo_id: null,
    identity_dojo_name: null,
    ...overrides,
  };
}

// Ficha ADOTADA por um dojô (F7.1).
function dojoOwnerRow(overrides = {}) {
  return federationOwnerRow({
    karate_identity_managed_by: 'dojo',
    karate_identity_dojo_id: DOJO_ID,
    identity_dojo_name: DOJO_NAME,
    ...overrides,
  });
}

// Ficha ADOTADA cujo dojô SAIU do Aura (F7.4): o OWNER_SQL real traz o
// estado do dojô junto (dojoStateSelect/DEFAULT_PREFIX 'identity_dojo_',
// em karateDojoExitState.js), então o fixture inclui as mesmas colunas
// prefixadas que aquele SELECT devolveria — inclusive `..._state_loaded`,
// sem a qual evaluateDojoExitFromRow devolve UNKNOWN_EXIT (dado faltante
// nunca vira "saiu"). Padrão: company inativada (o "Suspender" da UI).
function dojoExitedOwnerRow(overrides = {}) {
  return dojoOwnerRow({
    identity_dojo_state_loaded: true,
    identity_dojo_company_id: DOJO_ID,
    identity_dojo_is_active: false,
    identity_dojo_vertical: 'karate_dojo',
    identity_dojo_vertical_active: 'karate_dojo',
    ...overrides,
  });
}

// ── Despacho de mock por SQL (nunca por posição) ────────────
// `routes` é uma lista [regex, resposta]; a primeira que casar com o
// texto do SQL responde. SAVEPOINT/RELEASE/ROLLBACK e qualquer query
// nova caem no fallback sem deslocar mais nada. Uma resposta pode ser
// função — inclusive uma que devolve Promise.reject (erro de schema).
function makeRunner(routes = [], fallback = { rows: [] }) {
  const query = jest.fn().mockImplementation((sql, params) => {
    const text = typeof sql === 'string' ? sql : '';
    for (const [pattern, reply] of routes) {
      if (pattern.test(text)) {
        return Promise.resolve(typeof reply === 'function' ? reply(text, params) : reply);
      }
    }
    return Promise.resolve(fallback);
  });
  return { query };
}

function sqlList(mockFn) {
  return mockFn.mock.calls.map((c) => (typeof c[0] === 'string' ? c[0] : ''));
}

function findCall(mockFn, pattern) {
  return mockFn.mock.calls.find((c) => typeof c[0] === 'string' && pattern.test(c[0]));
}

function schemaError(code) {
  const e = new Error(
    code === '42P01'
      ? 'relation "companies" does not exist'
      : 'column c.karate_identity_managed_by does not exist'
  );
  e.code = code;
  return e;
}

// Captura o erro em vez de deixar o teste morrer nele — precisamos
// inspecionar status/code/message/identity_dojo, não só "lançou".
async function capture(promise) {
  try {
    await promise;
    return null;
  } catch (e) {
    return e;
  }
}

// A guarda avisa no log quando degrada por schema pendente; isso é
// comportamento desejado, mas não precisa poluir a saída do CI.
let warnSpy;
beforeAll(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterAll(() => { warnSpy.mockRestore(); });

// ════════════════════════════════════════════════════════════
// A PROMESSA EXECUTÁVEL DO PR: as listas não se cruzam
// ════════════════════════════════════════════════════════════
describe('assertGuardListsAreDisjoint — a proteção é executada, não prometida', () => {
  it('não lança no estado atual do repositório (roda também no require do módulo)', () => {
    expect(() => assertGuardListsAreDisjoint()).not.toThrow();
  });

  it('nenhuma coluna de IDENTITY_COLS está em FEDERATION_ALWAYS_ALLOWED', () => {
    const clash = IDENTITY_COLS.filter((c) => FEDERATION_ALWAYS_ALLOWED.includes(c));
    expect(clash).toEqual([]);
  });

  it('nenhuma coluna de IDENTITY_COLS está em FEDERATION_OWNED_COLS (a lista da F7.2)', () => {
    const clash = IDENTITY_COLS.filter((c) => FEDERATION_OWNED_COLS.includes(c));
    expect(clash).toEqual([]);
  });

  it('as duas listas da federação continuam não-vazias (senão o teste acima passaria por vacuidade)', () => {
    expect(FEDERATION_ALWAYS_ALLOWED.length).toBeGreaterThan(5);
    expect(FEDERATION_OWNED_COLS.length).toBeGreaterThan(5);
    expect(IDENTITY_COLS.length).toBeGreaterThan(10);
  });
});

describe('IDENTITY_COLS — o que é a PESSOA (derivado de IDENTITY_FIELDS)', () => {
  it('cobre nome, CPF, RG, nascimento, sexo e contato', () => {
    for (const col of ['name', 'cpf_cnpj', 'rg', 'birth_date', 'sex', 'phone', 'email']) {
      expect(IDENTITY_COLS).toContain(col);
    }
  });

  it('cobre o endereço COMPLETO (endereço meio-protegido não protege nada)', () => {
    for (const col of ['zip_code', 'street', 'number', 'complement', 'neighborhood', 'city', 'state']) {
      expect(IDENTITY_COLS).toContain(col);
    }
  });

  it('cobre as DUAS colunas de foto — photo_url é porta lateral para a mesma informação', () => {
    expect(IDENTITY_COLS).toContain('karate_photo_url');
    expect(IDENTITY_COLS).toContain('photo_url');
  });

  it('NÃO cobre o que a federação EMITE: matrícula, situação, dojô e papéis', () => {
    for (const col of [
      'karate_registration_number',
      'is_active',
      'dojo_id',
      'federation_id',
      'is_student',
      'is_arbiter',
      'is_instructor',
      'is_examiner',
      'is_assistant',
      'affiliation_since',
    ]) {
      expect(IDENTITY_COLS).not.toContain(col);
    }
  });

  it('NÃO cobre parent_guardian_id nem guardian_* (decisão consciente: o dojô não os sincroniza hoje)', () => {
    for (const col of [
      'parent_guardian_id',
      'guardian_name',
      'guardian_cpf',
      'guardian_phone',
      'guardian_relationship',
    ]) {
      expect(IDENTITY_COLS).not.toContain(col);
    }
  });

  it('NÃO cobre as próprias colunas de gestão da ficha', () => {
    expect(IDENTITY_COLS).not.toContain('karate_identity_managed_by');
    expect(IDENTITY_COLS).not.toContain('karate_identity_dojo_id');
  });
});

// ════════════════════════════════════════════════════════════
// FICHA DA FEDERAÇÃO — segue exatamente como sempre foi
// ════════════════════════════════════════════════════════════
describe('ficha gerida pela FEDERAÇÃO → libera', () => {
  it('campo de identidade em ficha da federação passa sem bloqueio e sem override', async () => {
    const out = await assertIdentityWriteAllowed({
      owner: federationOwnerRow(),
      columns: ['name', 'phone', 'street'],
      channel: CHANNELS.FEDERATION_ADMIN,
      canOverride: true,
      body: {},
    });
    expect(out.blocked).toBe(false);
    expect(out.overridden).toBe(false);
    expect(out.managedBy).toBe('federation');
    expect(out.dojo).toBeNull();
    expect(out.columns).toEqual(['name', 'phone', 'street']);
  });

  it('identityOwnershipPayload devolve o contrato de leitura da UI', () => {
    expect(identityOwnershipPayload(federationOwnerRow())).toEqual({
      identity_managed_by: 'federation',
      identity_dojo: null,
      identity_previous_dojo: null,
      identity_dojo_exit: null,
    });
    expect(identityOwnershipPayload(dojoOwnerRow())).toEqual({
      identity_managed_by: 'dojo',
      identity_dojo: { id: DOJO_ID, name: DOJO_NAME },
      identity_previous_dojo: null,
      identity_dojo_exit: null,
    });
  });
});

// ════════════════════════════════════════════════════════════
// FICHA DO DOJÔ — 409 que DIZ O NOME do dojô
// ════════════════════════════════════════════════════════════
describe('ficha mantida por DOJÔ + campo de identidade → 409 IDENTITY_MANAGED_BY_DOJO', () => {
  it('lança 409 com o NOME do dojô na mensagem (não o id) e identity_dojo {id,name} no corpo', async () => {
    const e = await capture(assertIdentityWriteAllowed({
      owner: dojoOwnerRow(),
      columns: ['name', 'cpf_cnpj'],
      channel: CHANNELS.FEDERATION_ADMIN,
      canOverride: true,
      body: {},
    }));

    expect(e).not.toBeNull();
    expect(isIdentityGuardError(e)).toBe(true);
    expect(e.status).toBe(409);
    expect(e.code).toBe(CODE_BLOCKED);

    // O ponto da recusa é ACIONÁVEL: quem lê tem que saber com QUEM falar.
    expect(e.message).toContain(DOJO_NAME);
    expect(e.message).not.toContain(DOJO_ID);

    const body = identityGuardBody(e);
    expect(body.code).toBe(CODE_BLOCKED);
    expect(body.identity_managed_by).toBe('dojo');
    expect(body.identity_dojo).toEqual({ id: DOJO_ID, name: DOJO_NAME });
    expect(body.blocked_fields).toEqual(['name', 'cpf_cnpj']);
    expect(body.error).toBe(e.message);
  });

  it('body MISTO é recusado INTEIRO, e blocked_fields lista só as colunas de identidade', async () => {
    const e = await capture(assertIdentityWriteAllowed({
      owner: dojoOwnerRow(),
      columns: ['is_active', 'karate_registration_number', 'rg', 'birth_date'],
      channel: CHANNELS.FEDERATION_ADMIN,
      canOverride: true,
      body: {},
    }));
    expect(e.status).toBe(409);
    expect(identityGuardBody(e).blocked_fields).toEqual(['rg', 'birth_date']);
  });

  it('canal PÚBLICO fala com o sensei/aluno: cita o dojô e NÃO oferece override (a porta não existe)', async () => {
    const e = await capture(assertIdentityWriteAllowed({
      owner: dojoOwnerRow(),
      columns: ['phone'],
      channel: CHANNELS.SELF_SERVICE,
      canOverride: false,
      body: {},
    }));
    expect(e.status).toBe(409);
    expect(e.code).toBe(CODE_BLOCKED);
    expect(e.message).toContain(DOJO_NAME);
    expect(e.message).not.toContain(OVERRIDE_FLAG_KEY);
    expect(e.message).not.toContain(DOJO_ID);
  });

  it('dojô sem nome legível degrada para um sujeito genérico, nunca para o uuid', async () => {
    const e = await capture(assertIdentityWriteAllowed({
      owner: dojoOwnerRow({ identity_dojo_name: null }),
      columns: ['name'],
      channel: CHANNELS.FEDERATION_ADMIN,
      canOverride: true,
      body: {},
    }));
    expect(e.status).toBe(409);
    expect(e.message).not.toContain(DOJO_ID);
    expect(identityGuardBody(e).identity_dojo).toEqual({ id: DOJO_ID, name: null });
  });
});

// ════════════════════════════════════════════════════════════
// DOJÔ QUE SAIU DO AURA (F7.4) — a gestão da ficha volta sozinha
// ════════════════════════════════════════════════════════════
describe('identityOwnershipPayload — dojô SAIU do Aura → gestão volta para a federação', () => {
  it('managed_by volta a "federation" e os campos novos dizem QUAL era o dojô e POR QUE ele saiu', () => {
    expect(identityOwnershipPayload(dojoExitedOwnerRow())).toEqual({
      identity_managed_by: 'federation',
      identity_dojo: null,
      identity_previous_dojo: { id: DOJO_ID, name: DOJO_NAME },
      identity_dojo_exit: {
        reason: EXIT_REASONS.COMPANY_INACTIVE,
        label: EXIT_LABELS[EXIT_REASONS.COMPANY_INACTIVE],
      },
    });
  });

  it('NÃO é a mesma coisa que "ficha da federação desde sempre": identity_previous_dojo prova que ela foi adotada', () => {
    const exited = identityOwnershipPayload(dojoExitedOwnerRow());
    const neverAdopted = identityOwnershipPayload(federationOwnerRow());
    expect(exited.identity_managed_by).toBe(neverAdopted.identity_managed_by);
    expect(exited.identity_previous_dojo).not.toBeNull();
    expect(neverAdopted.identity_previous_dojo).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════
// SÓ COLUNA FEDERATIVA — decide SEM IR AO BANCO
// ════════════════════════════════════════════════════════════
describe('ficha do dojô + só colunas FEDERATIVAS → libera sem custo de query', () => {
  it('não chama o runner nenhuma vez (matrícula/papéis/situação não custam uma ida ao banco)', async () => {
    // O runner até saberia responder "esta ficha é do dojô" — o teste
    // prova que ele NÃO é perguntado.
    const runner = makeRunner([[/practitioner_label/, { rows: [dojoOwnerRow()] }]]);

    const out = await assertIdentityWriteAllowed({
      runner,
      practitionerId: PRACT_ID,
      columns: [
        'karate_registration_number',
        'is_active',
        'dojo_id',
        'parent_guardian_id',
        'is_arbiter',
        'guardian_name',
      ],
      channel: CHANNELS.FEDERATION_ADMIN,
      canOverride: true,
      body: {},
    });

    expect(runner.query).not.toHaveBeenCalled();
    expect(out.blocked).toBe(false);
    expect(out.overridden).toBe(false);
    expect(out.columns).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════
// OVERRIDE — ato explícito, nunca padrão
// ════════════════════════════════════════════════════════════
describe('override pedido em canal SEM staffWrite → 403 IDENTITY_OVERRIDE_NOT_ALLOWED', () => {
  it('recusa explicitamente (token não é credencial de staff)', async () => {
    const e = await capture(assertIdentityWriteAllowed({
      owner: dojoOwnerRow(),
      columns: ['phone'],
      channel: CHANNELS.SELF_SERVICE,
      canOverride: false,
      body: { [OVERRIDE_FLAG_KEY]: true, [OVERRIDE_REASON_KEY]: 'motivo longo o suficiente' },
    }));
    expect(e.status).toBe(403);
    expect(e.code).toBe(CODE_OVERRIDE_FORBIDDEN);
    expect(identityGuardBody(e).blocked_fields).toEqual(['phone']);
  });

  it('a flag como STRING "true" também é um pedido — e também é recusada', async () => {
    const e = await capture(assertIdentityWriteAllowed({
      owner: dojoOwnerRow(),
      columns: ['email'],
      channel: CHANNELS.DOJO_PORTAL,
      canOverride: false,
      body: { [OVERRIDE_FLAG_KEY]: 'true' },
    }));
    expect(e.status).toBe(403);
    expect(e.code).toBe(CODE_OVERRIDE_FORBIDDEN);
  });

  it('recusa mesmo quando a ficha é da FEDERAÇÃO — quem tentou precisa saber que a porta não existe', async () => {
    const e = await capture(assertIdentityWriteAllowed({
      owner: federationOwnerRow(),
      columns: ['phone'],
      channel: CHANNELS.SELF_SERVICE,
      canOverride: false,
      body: { [OVERRIDE_FLAG_KEY]: true },
    }));
    expect(e.status).toBe(403);
    expect(e.code).toBe(CODE_OVERRIDE_FORBIDDEN);
  });

  it('flag ausente/false não é pedido de override (não vira 403 por engano)', async () => {
    const out = await assertIdentityWriteAllowed({
      owner: federationOwnerRow(),
      columns: ['phone'],
      channel: CHANNELS.SELF_SERVICE,
      canOverride: false,
      body: { [OVERRIDE_FLAG_KEY]: false },
    });
    expect(out.blocked).toBe(false);
  });
});

describe('override em canal COM staffWrite', () => {
  const OVERRIDE_ARGS = {
    owner: dojoOwnerRow(),
    columns: ['name', 'rg'],
    channel: CHANNELS.FEDERATION_ADMIN,
    canOverride: true,
  };

  it('sem motivo → 422 IDENTITY_OVERRIDE_REASON_REQUIRED, citando o dojô e a chave que falta', async () => {
    const e = await capture(assertIdentityWriteAllowed({
      ...OVERRIDE_ARGS,
      body: { [OVERRIDE_FLAG_KEY]: true },
    }));
    expect(e.status).toBe(422);
    expect(e.code).toBe(CODE_OVERRIDE_REASON);
    expect(e.message).toContain(OVERRIDE_REASON_KEY);
    expect(e.message).toContain(DOJO_NAME);
    expect(identityGuardBody(e).identity_dojo).toEqual({ id: DOJO_ID, name: DOJO_NAME });
  });

  it('motivo CURTO (ou só espaço) também é 422 — "corrigi porque sim" não é trilha', async () => {
    const curto = await capture(assertIdentityWriteAllowed({
      ...OVERRIDE_ARGS,
      body: { [OVERRIDE_FLAG_KEY]: true, [OVERRIDE_REASON_KEY]: 'oops' },
    }));
    expect(curto.status).toBe(422);
    expect(curto.code).toBe(CODE_OVERRIDE_REASON);

    const branco = await capture(assertIdentityWriteAllowed({
      ...OVERRIDE_ARGS,
      body: { [OVERRIDE_FLAG_KEY]: true, [OVERRIDE_REASON_KEY]: '        ' },
    }));
    expect(branco.status).toBe(422);
    expect(branco.code).toBe(CODE_OVERRIDE_REASON);
  });

  it('com motivo → overridden:true, reason preenchido (aparado) e o dojô identificado', async () => {
    const out = await assertIdentityWriteAllowed({
      ...OVERRIDE_ARGS,
      body: {
        [OVERRIDE_FLAG_KEY]: true,
        [OVERRIDE_REASON_KEY]: '  Ofício 12/2026: correção de grafia por determinação judicial  ',
      },
      actor: { userId: 'u-1', label: 'Staff FPKT' },
    });
    expect(out.blocked).toBe(false);
    expect(out.overridden).toBe(true);
    expect(out.managedBy).toBe('dojo');
    expect(out.dojo).toEqual({ id: DOJO_ID, name: DOJO_NAME });
    expect(out.columns).toEqual(['name', 'rg']);
    expect(out.reason).toBe('Ofício 12/2026: correção de grafia por determinação judicial');
    expect(out.actor).toEqual({ userId: 'u-1', label: 'Staff FPKT' });
  });
});

// ════════════════════════════════════════════════════════════
// LEITURA DO DONO — defensiva a schema pendente (262)
// ════════════════════════════════════════════════════════════
describe('loadIdentityOwner — degradação por schema pendente', () => {
  it('42703 (coluna ausente) devolve managedBy federation, sem lançar', async () => {
    const runner = makeRunner([[/practitioner_label/, () => Promise.reject(schemaError('42703'))]]);
    const owner = await loadIdentityOwner(runner, PRACT_ID);
    expect(owner.managedBy).toBe('federation');
    expect(owner.schemaPending).toBe(true);
    expect(owner.dojo).toBeNull();
  });

  it('42P01 (tabela ausente) degrada do mesmo jeito', async () => {
    const runner = makeRunner([[/practitioner_label/, () => Promise.reject(schemaError('42P01'))]]);
    const owner = await loadIdentityOwner(runner, PRACT_ID);
    expect(owner.managedBy).toBe('federation');
    expect(owner.schemaPending).toBe(true);
  });

  it('com savepoint:true emite SAVEPOINT e ROLLBACK TO SAVEPOINT — a tx do chamador não é envenenada', async () => {
    const runner = makeRunner([[/practitioner_label/, () => Promise.reject(schemaError('42703'))]]);
    const owner = await loadIdentityOwner(runner, PRACT_ID, { savepoint: true });
    expect(owner.managedBy).toBe('federation');

    // Asserção pelo TEXTO do SQL — nunca por posição na fila.
    const all = sqlList(runner.query);
    expect(all.some((s) => /^\s*SAVEPOINT sp_identity_guard\s*$/.test(s))).toBe(true);
    expect(all.some((s) => /ROLLBACK TO SAVEPOINT sp_identity_guard/.test(s))).toBe(true);
    // E NUNCA um ROLLBACK nu, que desfaria a transação inteira do chamador.
    expect(all.some((s) => /^\s*ROLLBACK\s*;?\s*$/i.test(s))).toBe(false);
  });

  it('caminho feliz com savepoint solta o SAVEPOINT com RELEASE (não com ROLLBACK)', async () => {
    const runner = makeRunner([[/practitioner_label/, { rows: [dojoOwnerRow()] }]]);
    const owner = await loadIdentityOwner(runner, PRACT_ID, { savepoint: true });
    expect(owner.managedBy).toBe('dojo');
    expect(owner.dojo).toEqual({ id: DOJO_ID, name: DOJO_NAME });

    const all = sqlList(runner.query);
    expect(all.some((s) => /RELEASE SAVEPOINT sp_identity_guard/.test(s))).toBe(true);
    expect(all.some((s) => /ROLLBACK TO SAVEPOINT/.test(s))).toBe(false);
  });

  it('erro que NÃO é de schema sobe (não é degradação, é falha)', async () => {
    const boom = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const runner = makeRunner([[/practitioner_label/, () => Promise.reject(boom)]]);
    const e = await capture(loadIdentityOwner(runner, PRACT_ID, { savepoint: true }));
    expect(e).toBe(boom);
  });

  it('sem practitionerId nem vai ao banco', async () => {
    const runner = makeRunner();
    const owner = await loadIdentityOwner(runner, null);
    expect(runner.query).not.toHaveBeenCalled();
    expect(owner.managedBy).toBe('federation');
    expect(owner.found).toBe(false);
  });

  it('praticante inexistente (0 linhas) não vira "adotado"', async () => {
    const runner = makeRunner([[/practitioner_label/, { rows: [] }]]);
    const owner = await loadIdentityOwner(runner, PRACT_ID);
    expect(owner.found).toBe(false);
    expect(owner.managedBy).toBe('federation');
  });

  it('a guarda usa loadIdentityOwner quando o chamador não traz a linha pronta', async () => {
    const runner = makeRunner([[/practitioner_label/, { rows: [dojoOwnerRow()] }]]);
    const e = await capture(assertIdentityWriteAllowed({
      runner,
      practitionerId: PRACT_ID,
      columns: ['name'],
      channel: CHANNELS.FEDERATION_ADMIN,
      canOverride: true,
      body: {},
    }));
    expect(e.status).toBe(409);
    expect(findCall(runner.query, /practitioner_label/)).toBeTruthy();
    expect(findCall(runner.query, /practitioner_label/)[1]).toEqual([PRACT_ID]);
  });
});

// ════════════════════════════════════════════════════════════
// TRILHA DO OVERRIDE
// ════════════════════════════════════════════════════════════
describe('buildOverrideChanges — só entra o que REALMENTE muda', () => {
  it('ignora campo cujo valor não muda e monta federation_before/after nos que mudam', () => {
    const before = { name: 'Ana Preta', phone: '11999990000', rg: null };
    const changes = buildOverrideChanges(before, [
      { col: 'name', value: 'Ana Preta' },        // idêntico → não é evento
      { col: 'phone', value: '11988887777' },     // muda
      { col: 'rg', value: '123456789' },          // vazio → preenchido
      { col: 'is_active', value: false },         // não é identidade → fora
    ]);

    expect(changes.map((c) => c.field)).toEqual(['phone', 'rg']);

    const phone = changes.find((c) => c.field === 'phone');
    expect(phone.winner).toBe('federation');
    expect(phone.federation_before).toBe('11999990000');
    expect(phone.federation_after).toBe('11988887777');
    expect(typeof phone.label).toBe('string');
    expect(phone.label.length).toBeGreaterThan(0);

    const rg = changes.find((c) => c.field === 'rg');
    expect(rg.federation_before).toBeNull();
    expect(rg.federation_after).toBe('123456789');
  });

  it('campo ausente na linha anterior vira federation_before null (nunca undefined no jsonb)', () => {
    const changes = buildOverrideChanges({}, [{ col: 'city', value: 'São Paulo' }]);
    expect(changes).toHaveLength(1);
    expect(changes[0].federation_before).toBeNull();
    expect(changes[0].federation_after).toBe('São Paulo');
  });

  it('lista vazia / linha anterior nula não quebram', () => {
    expect(buildOverrideChanges(null, [])).toEqual([]);
    expect(buildOverrideChanges(null, undefined)).toEqual([]);
  });
});

describe('writeOverrideAudit — action/source dentro do CHECK da migration 263', () => {
  // Os dois CHECKs da 263, escritos aqui para o teste falhar se alguém
  // trocar o valor por um rótulo "mais bonito" que o banco recusaria com
  // 23514 (a trilha se perderia e o override inteiro seria descartado).
  const CHECK_ACTIONS = ['adopt', 'release', 'sync'];
  const CHECK_SOURCES = ['dojo_federate', 'dojo_unfederate', 'federation_admin', 'sync_job', 'import'];

  it('grava em karate_identity_audit com action=sync, source=federation_admin e o motivo no changes', async () => {
    const client = makeRunner();
    const reason = 'Ofício 12/2026: correção de grafia por determinação judicial';

    const table = await writeOverrideAudit(client, {
      federationId: FED_ID,
      practitionerId: PRACT_ID,
      practitionerLabel: 'Ana Preta',
      fpktNumber: 'FPKT-001',
      dojoId: DOJO_ID,
      changes: buildOverrideChanges({ name: 'Ana P.' }, [{ col: 'name', value: 'Ana Preta' }]),
      reason,
      actor: { userId: 'staff1', label: 'Staff FPKT' },
    });

    expect(table).toBe('karate_identity_audit');

    const insert = findCall(client.query, /INSERT INTO karate_identity_audit/i);
    expect(insert).toBeTruthy();

    const params = insert[1];
    // $8 = action, $9 = source, $10 = changes (jsonb)
    expect(params[7]).toBe('sync');
    expect(params[8]).toBe('federation_admin');
    expect(CHECK_ACTIONS).toContain(params[7]);
    expect(CHECK_SOURCES).toContain(params[8]);

    const changes = JSON.parse(params[9]);
    expect(changes[0].field).toBe(OVERRIDE_FLAG_KEY);
    expect(changes[0].winner).toBe('federation');
    expect(changes[0].reason).toBe(reason);
    // O antes/depois de cada campo vem junto do motivo.
    expect(changes.map((c) => c.field)).toContain('name');

    // Ator sem uuid válido não derruba a trilha: vira null e o rastro
    // humano fica em actor_label.
    expect(params[10]).toBeNull();
    expect(params[11]).toBe('Staff FPKT');

    // Roda em SAVEPOINT: uma trilha que falha não pode envenenar a
    // transação do UPDATE que ela está registrando.
    const all = sqlList(client.query);
    expect(all.some((s) => /SAVEPOINT sp_identity_audit/.test(s))).toBe(true);
  });

  it('sem motivo, o campo do override vai com reason null (a chamada não inventa texto)', async () => {
    const client = makeRunner();
    await writeOverrideAudit(client, { practitionerId: PRACT_ID, dojoId: DOJO_ID });
    const insert = findCall(client.query, /INSERT INTO karate_identity_audit/i);
    const changes = JSON.parse(insert[1][9]);
    expect(changes).toHaveLength(1);
    expect(changes[0].reason).toBeNull();
  });
});
