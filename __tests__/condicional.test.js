// ============================================================
// AURA. — Venda condicional (C2): regras sem banco
// services/condicional.js, services/listaDeCondicionais.js,
// routes/meCondicionais.js (quem ve a loja), modules.js e pdvSettings.js.
// O que a condicional grava (e o que NAO grava) esta em
// condicional.banco.test.js.
// ============================================================
'use strict';

const c = require('../src/services/condicional');
const lista = require('../src/services/listaDeCondicionais');
const { _lojaEntra } = require('../src/routes/meCondicionais');
const { MODULE_PLAN_MAP } = require('../src/services/modules');

const P = '11111111-2222-3333-4444-555555555555';
const V = '66666666-7777-8888-9999-000000000000';
const CLI = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const HOJE = '2026-11-25';
const base = (extra) => ({ customer_id: CLI, items: [{ product_id: P }], ...extra });

describe('lerCorpo (R2)', () => {
  test('peca, cliente e data dentro do prazo', () => {
    const { dados } = c.lerCorpo(base({ items: [{ product_id: P, variant_id: V }, { product_id: P }], due_date: '2026-11-28' }), { hoje: HOJE });
    expect(dados.itens).toEqual([{ product_id: P, variant_id: V }, { product_id: P, variant_id: null }]);
    expect(dados).toMatchObject({ customerId: CLI, dueDate: '2026-11-28' });
  });

  test('sem peca, peca sem produto e quantidade diferente de 1 sao recusadas', () => {
    expect(c.lerCorpo(base({ items: [] }), { hoje: HOJE }).erro.code).toBe('COND_SEM_PECAS');
    expect(c.lerCorpo(base({ items: [{ product_name: 'avulso' }] }), { hoje: HOJE }).erro.code).toBe('COND_ITEM_INVALIDO');
    expect(c.lerCorpo(base({ items: [{ product_id: P, quantity: 2 }] }), { hoje: HOJE }).erro.code).toBe('COND_QUANTIDADE');
    expect(c.lerCorpo(base({ items: [{ product_id: P, quantity: 1 }] }), { hoje: HOJE }).dados).toBeTruthy();
    expect(c.lerCorpo(base({ items: new Array(c.MAX_PECAS + 1).fill({ product_id: P }) }), { hoje: HOJE }).erro.code)
      .toBe('COND_PECAS_DEMAIS');
  });

  test('uuids em minusculas (chave dos Maps e da repeticao)', () => {
    const { dados } = c.lerCorpo({
      customer_id: CLI.toUpperCase(), seller_id: P.toUpperCase(),
      items: [{ product_id: ` ${P.toUpperCase()} `, variant_id: V.toUpperCase() }],
    }, { hoje: HOJE });
    expect(dados.itens).toEqual([{ product_id: P, variant_id: V }]);
    expect(dados).toMatchObject({ customerId: CLI, sellerId: P });
  });

  test('aviso de quem vende sem estoque: texto exato', () => {
    expect(c.AVISO_SEM_ESTOQUE).toBe('Sem unidade livre. Entra mesmo assim porque sua loja vende sem estoque.');
  });

  test('cliente e obrigatoria', () => {
    expect(c.lerCorpo({ items: [{ product_id: P }] }, { hoje: HOJE }).erro).toMatchObject({ status: 422, code: 'COND_CLIENTE_OBRIGATORIO' });
    expect(c.lerCorpo(base({ customer_id: 'abc' }), { hoje: HOJE }).erro).toMatchObject({ status: 404, code: 'CUSTOMER_NOT_FOUND' });
  });

  test('devolucao: hoje vale, ontem nao, ate hoje + 30', () => {
    expect(c.lerCorpo(base({ due_date: HOJE }), { hoje: HOJE }).dados.dueDate).toBe(HOJE);
    expect(c.lerCorpo(base({ due_date: '2026-11-24' }), { hoje: HOJE }).erro.code).toBe('COND_DATA');
    expect(c.lerCorpo(base({ due_date: '2026-12-25' }), { hoje: HOJE }).dados.dueDate).toBe('2026-12-25');
    expect(c.lerCorpo(base({ due_date: '2026-12-26' }), { hoje: HOJE }).erro.code).toBe('COND_DATA');
    expect(c.lerCorpo(base({ due_date: '2026-02-30' }), { hoje: HOJE }).erro.code).toBe('COND_DATA');
    // Sem data: o prazo padrao da loja entra na hora de guardar.
    expect(c.lerCorpo(base({}), { hoje: HOJE }).dados.dueDate).toBeNull();
  });
});

describe('telefone valido (R2)', () => {
  test('DDD + numero, com mascara ou +55', () => {
    expect(c.telefoneValido('(11) 98888-7777')).toBe('11988887777');
    expect(c.telefoneValido('+55 11 98888-7777')).toBe('11988887777');
    expect(c.telefoneValido('1133334444')).toBe('1133334444');
  });
  test('sem DDD, vazio ou longo demais: invalido', () => {
    expect(c.telefoneValido('98888-7777')).toBeNull();
    expect(c.telefoneValido('')).toBeNull();
    expect(c.telefoneValido(null)).toBeNull();
    expect(c.telefoneValido('119888877770000')).toBeNull();
  });
});

describe('situacao derivada no fuso de Sao Paulo (R11)', () => {
  test('hoje e o dia de SP, nao o de UTC', () => {
    // 23h30 de 25/11 em SP = 02h30 de 26/11 em UTC.
    expect(c.hojeSP(new Date('2026-11-26T02:30:00Z'))).toBe('2026-11-25');
  });

  test('atrasada so com peca ainda com a cliente', () => {
    expect(c.derivarSituacao({ status: 'aberta', due_date: '2026-11-22', com_cliente: 2 }, HOJE))
      .toEqual({ situacao: 'atrasada', parcial: false, dias_de_atraso: 3 });
    expect(c.derivarSituacao({ status: 'aberta', due_date: HOJE, com_cliente: 1, decididas: 1 }, HOJE))
      .toEqual({ situacao: 'vence_hoje', parcial: true, dias_de_atraso: 0 });
    expect(c.derivarSituacao({ status: 'aberta', due_date: '2026-11-26', com_cliente: 1 }, HOJE).situacao).toBe('com_cliente');
    // Tudo decidido, peca que ficou ainda sem venda: nao e atrasada.
    expect(c.derivarSituacao({ status: 'aberta', due_date: '2026-11-01', com_cliente: 0, decididas: 2 }, HOJE).situacao).toBe('a_cobrar');
  });

  test('encerrada e "Concluída"; cancelada', () => {
    expect(c.derivarSituacao({ status: 'encerrada', due_date: '2026-11-01' }, HOJE).situacao).toBe('concluida');
    expect(c.derivarSituacao({ status: 'cancelada', due_date: '2026-11-01' }, HOJE).situacao).toBe('cancelada');
  });
});

describe('prazo, termos, numero e chave', () => {
  test('prazo padrao: 1 a 30 vale; fora, 3', () => {
    expect(c.lerPrazoPadrao({ condicional_prazo_padrao: 7 })).toBe(7);
    expect(c.lerPrazoPadrao({ condicional_prazo_padrao: '5' })).toBe(5);
    expect(c.lerPrazoPadrao({ condicional_prazo_padrao: 31 })).toBe(3);
    expect(c.lerPrazoPadrao({ condicional_prazo_padrao: 2.5 })).toBe(3);
    expect(c.lerPrazoPadrao({})).toBe(3);
    expect(c.lerPrazoPadrao(null)).toBe(3);
  });

  test('termos: sem texto, null; com texto, mantem as linhas', () => {
    expect(c.lerTermos({ condicional_termos: '   ' })).toBeNull();
    expect(c.lerTermos({})).toBeNull();
    expect(c.lerTermos({ condicional_termos: ' Linha 1\r\nLinha 2 ' })).toBe('Linha 1\nLinha 2');
  });

  test('numero exibido como C-0031', () => {
    expect(c.numeroExibicao(31)).toBe('C-0031');
    expect(c.numeroExibicao(12345)).toBe('C-12345');
  });

  test('Idempotency-Key do cabecalho vence a do corpo; chave curta nao vale', () => {
    expect(c.lerChave({ headers: { 'idempotency-key': 'chave-do-app-123' }, body: { idempotency_key: 'outra-chave-999' } })).toBe('chave-do-app-123');
    expect(c.lerChave({ headers: {}, body: { idempotency_key: 'chave-do-corpo-1' } })).toBe('chave-do-corpo-1');
    expect(c.lerChave({ headers: { 'idempotency-key': 'x' } })).toBeNull();
  });

  test('mesmas pecas: multiconjunto, sem ordem', () => {
    const a = [{ product_id: P, variant_id: V }, { product_id: P, variant_id: null }];
    expect(c.mesmasPecas(a, [{ product_id: P }, { product_id: P, variant_id: V }])).toBe(true);
    expect(c.mesmasPecas(a, [{ product_id: P, variant_id: V }])).toBe(false);
    expect(c.mesmasPecas(a, [{ product_id: P, variant_id: V }, { product_id: P, variant_id: V }])).toBe(false);
  });

  test('frase do 409 cita a condicional que segura a peca (R4)', () => {
    expect(c.fraseDaFalta({ nome: 'Vestido (M)', reservado: 0, condicionais: [{ numero_exibicao: 'C-0031' }] }))
      .toBe('"Vestido (M)": está com cliente na C-0031.');
    expect(c.fraseDaFalta({ nome: 'Cinto', reservado: 1, condicionais: [] })).toMatch(/separada num pedido/);
    expect(c.fraseDaFalta({ nome: 'Cinto', reservado: 0, condicionais: [] })).toMatch(/sem unidade/);
  });
});

describe('trava CONDICIONAL_LIBERADA', () => {
  afterEach(() => { delete process.env.CONDICIONAL_LIBERADA; });
  test('desligada: so equipe Aura e admin', () => {
    expect(c.condicionalLiberada({ user: { id: 'u', role: 'client' } })).toBe(false);
    expect(c.condicionalLiberada({ user: { id: 'u', role: 'client', is_staff: true } })).toBe(true);
    expect(c.condicionalLiberada({ user: { id: 'u', role: 'admin' } })).toBe(true);
  });
  test('ligada: todo lojista', () => {
    process.env.CONDICIONAL_LIBERADA = 'true';
    expect(c.condicionalLiberada({ user: { id: 'u', role: 'client' } })).toBe(true);
  });
});

describe('lista', () => {
  test('filtro desconhecido cai em em_aberto (o padrao)', () => {
    expect(lista.lerFiltro('')).toBe('em_aberto');
    expect(lista.lerFiltro('xyz')).toBe('em_aberto');
    expect(lista.lerFiltro('com_cliente')).toBe('com_cliente');
    expect(lista.lerFiltro('a_cobrar')).toBe('a_cobrar');
    expect(lista.lerFiltro('ATRASADAS')).toBe('atrasadas');
    expect(lista.lerFiltro('todos')).toBe('todas');
  });

  test('o SQL tem um parametro para cada $n', () => {
    for (const filtro of lista.FILTROS) {
      for (const q of ['', 'Ana', 'C-0031', '11988']) {
        const { sql, params } = lista.montarConsultaDaLista({ empresas: ['x'], filtro, q, limit: 30, offset: 0, hoje: HOJE });
        const maior = Math.max(...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
        expect(maior).toBe(params.length);
      }
    }
  });

  test('busca por numero: "C-0031" procura o 31', () => {
    const { params, sql } = lista.montarConsultaDaLista({ empresas: ['x'], filtro: 'todas', q: 'C-0031', limit: 30, offset: 0, hoje: HOJE });
    expect(params[2]).toBe('0031');
    expect(sql).toMatch(/c\.numero::text = ltrim\(\$3, '0'\)/);
  });

  test('atrasadas primeiro na ordem (R11)', () => {
    const { sql } = lista.montarConsultaDaLista({ empresas: ['x'], limit: 30, offset: 0, hoje: HOJE });
    expect(sql.replace(/\s+/g, ' ')).toMatch(/ORDER BY \(c\.status = 'aberta' AND r\.com_cliente > 0 AND c\.due_date < \$2::date\) DESC/);
  });

  test('totalizador "R$ X em N peças com M clientes"', () => {
    expect(lista.textoDoTotalizador({ valor: 1379, pecas: 7, clientes: 3 })).toBe('R$ 1.379,00 em 7 peças com 3 clientes');
    expect(lista.textoDoTotalizador({ valor: 89.9, pecas: 1, clientes: 1 })).toBe('R$ 89,90 em 1 peça com 1 cliente');
    expect(lista.apresentarNumeros(null)).toEqual({
      totalizador: { valor: 0, pecas: 0, clientes: 0, texto: 'R$ 0,00 em 0 peças com 0 clientes' },
      valor_a_cobrar: 0,
      counts: { em_aberto: 0, com_cliente: 0, vence_hoje: 0, atrasadas: 0, a_cobrar: 0, concluidas: 0, canceladas: 0, todas: 0 },
    });
  });
});

describe('modulo e permissao', () => {
  test('vendas.condicionais e do Essencial, como vendas.pedidos', () => {
    expect(MODULE_PLAN_MAP['vendas.condicionais']).toBe('essencial');
    expect(MODULE_PLAN_MAP['vendas.condicionais']).toBe(MODULE_PLAN_MAP['vendas.pedidos']);
  });

  test('consolidado: a permissao de Vendas decide a loja', () => {
    expect(_lojaEntra({ isOwner: true, permissions: { vendas: false } })).toBe(true);
    expect(_lojaEntra({ roleLabel: 'owner' })).toBe(true);
    expect(_lojaEntra({ permissions: null })).toBe(true);
    expect(_lojaEntra({ permissions: { vendas: true } })).toBe(true);
    expect(_lojaEntra({ permissions: { 'vendas.condicionais': true } })).toBe(true);
    expect(_lojaEntra({ permissions: { pdv: true, vendas: false } })).toBe(false);
    expect(_lojaEntra({ permissions: {} })).toBe(false);
  });
});
