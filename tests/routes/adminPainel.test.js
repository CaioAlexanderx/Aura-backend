// ============================================================
// /admin/painel — a API do painel de blocos da Gestão Aura.
//
// As respostas são conferidas contra tests/fixtures/painel/*.json: é o
// contrato que o front usa. Os dados vêm de tests/helpers/fakePainelDb.js
// (lojas inventadas), nunca do banco de produção.
//
// Mudou o formato de propósito? Regrave as fixtures e revise o diff:
//   PAINEL_FIXTURES=write npx jest tests/routes/adminPainel.test.js tests/routes/usageScreens.test.js
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../../src/config/database');
const router = require('../../src/routes/adminPainel');
const painel = require('../../src/services/painelDiario');
const { calcularAlertas } = require('../../src/services/painelAlertas');
const { BLOCOS } = require('../../src/services/painelBlocos');
const fake = require('../helpers/fakePainelDb');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'painel');
// Sem validade: o relógio do teste é fixo em 13/10/2026.
const staff = jwt.sign({ id: fake.USER, role: 'admin' }, 'aura-test-secret-2026');
const cliente = jwt.sign({ id: fake.USER, role: 'client', company: fake.id(2) }, 'aura-test-secret-2026');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin/painel', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  return app;
}

const api = (metodo, url, token = staff) => request(makeApp())[metodo]('/admin/painel' + url).set('Authorization', 'Bearer ' + token);

// Confere a resposta contra a fixture (ou a regrava com PAINEL_FIXTURES=write).
function conferir(nome, body) {
  const arq = path.join(FIXTURES, nome + '.json');
  if (process.env.PAINEL_FIXTURES === 'write') fs.writeFileSync(arq, JSON.stringify(body, null, 2) + '\n');
  expect(body).toEqual(JSON.parse(fs.readFileSync(arq, 'utf8')));
}

// O que o job teria gravado para o dia, a partir do banco de mentira.
async function gravadosDoDia() {
  fake.ligar(db.query);
  const { resultados, empresas } = await painel.calcularBlocos({ hoje: fake.HOJE });
  await painel.aplicarVariacao({ hoje: fake.HOJE, resultados });
  const alertas = await calcularAlertas({ hoje: fake.HOJE, empresas });
  const calculado_em = '2026-10-13T09:00:04.000Z';
  return {
    gravados: Object.entries(resultados).map(([bloco, dados]) => ({ bloco, dados: JSON.parse(JSON.stringify(dados)), calculado_em })),
    alertas,
  };
}

let doDia;

beforeAll(async () => {
  // O número da Aura está ligado neste arquivo: o bloco Contatos, o alerta e a
  // ficha da conversa leem o hub (dados em fakePainelDb.hub*).
  process.env.AURA_COMPANY_ID = fake.AURA_COMPANY;
  jest.useFakeTimers({ now: fake.AGORA, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'] });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  doDia = await gravadosDoDia();
  db.query.mockReset();
});
afterAll(() => { delete process.env.AURA_COMPANY_ID; jest.useRealTimers(); jest.restoreAllMocks(); });
afterEach(() => db.query.mockReset());

// Banco com o dia já calculado pelo job.
function comDiaGravado() {
  const dados = fake.dadosPadrao();
  dados.gravados = doDia.gravados;
  dados.alertasGravados = doDia.alertas;
  return fake.ligar(db.query, dados);
}

describe('acesso', () => {
  test('sem token → 401; cliente comum → 403', async () => {
    expect((await request(makeApp()).get('/admin/painel/hoje')).status).toBe(401);
    for (const [metodo, url] of [['get', '/hoje'], ['get', '/blocos/pagantes'], ['get', '/layout'], ['put', '/layout'], ['post', '/recalcular'], ['get', `/clientes/${fake.id(1)}/ficha`], ['get', `/contatos/${fake.conv(1)}`]]) {
      expect((await api(metodo, url, cliente)).status).toBe(403);
    }
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('GET /admin/painel/hoje', () => {
  test('lê o que o job gravou (ao_vivo: false) — fixture hoje.json', async () => {
    const { escritas } = comDiaGravado();
    const res = await api('get', '/hoje');
    expect(res.status).toBe(200);
    expect(res.body.ao_vivo).toBe(false);
    expect(res.body.calculado_em).toBe('2026-10-13T09:00:04.000Z');
    // 09h BRT de 13/10 → próximo cálculo às 06h BRT de 14/10
    expect(res.body.proximo_calculo).toBe('2026-10-14T09:00:00.000Z');
    expect(res.body.blocos.map((b) => b.id)).toEqual(BLOCOS.map((b) => b.id));
    for (const b of res.body.blocos) {
      expect(Object.keys(b).sort()).toEqual(['fonte', 'grupo', 'id', 'resumo', 'serie', 'titulo', 'unidade', 'valor', 'variacao']);
    }
    // só leitura: 2 consultas do painel + a leitura do hub para o alerta de
    // contato (que depende do relógio e por isso não vem gravado) + a leitura
    // ao vivo dos erros por minuto (últimos 60 min, também não vem gravada)
    const sqls = db.query.mock.calls.map((c) => c[0]);
    const doPainel = sqls.filter((q) => !q.includes('-- contatos:') && !q.includes('FROM erros_por_minuto'));
    expect(doPainel).toHaveLength(2);
    expect(sqls.filter((q) => q.includes('-- contatos:')).length).toBeGreaterThan(0);
    expect(sqls.filter((q) => q.includes('FROM erros_por_minuto'))).toHaveLength(1);
    expect(escritas).toHaveLength(0);
    conferir('hoje', res.body);
  });

  test('sem linha do dia calcula ao vivo e avisa (ao_vivo: true), sem gravar', async () => {
    const { escritas } = fake.ligar(db.query);
    const res = await api('get', '/hoje');
    expect(res.status).toBe(200);
    expect(res.body.ao_vivo).toBe(true);
    expect(res.body.blocos).toHaveLength(BLOCOS.length);
    expect(res.body.alertas.length).toBeGreaterThan(0);
    expect(escritas).toHaveLength(0);

    // mesmos números do que o job gravaria
    comDiaGravado();
    const gravado = await api('get', '/hoje');
    expect(res.body.blocos).toEqual(gravado.body.blocos);
    expect(res.body.alertas).toEqual(gravado.body.alertas);
  });

  test('tabela do painel ainda não existe (42P01): cai no cálculo ao vivo', async () => {
    const dados = fake.dadosPadrao();
    const escritas = [];
    db.query.mockImplementation(async (sql, params) => {
      if (/painel_blocos_diarios|painel_alertas/.test(sql)) {
        const err = new Error('relation does not exist');
        err.code = '42P01';
        throw err;
      }
      return { rows: fake.responder(dados, escritas, sql, params) };
    });
    const res = await api('get', '/hoje');
    expect(res.status).toBe(200);
    expect(res.body.ao_vivo).toBe(true);
    expect(res.body.blocos.find((b) => b.id === 'pagantes').variacao).toEqual({ d7: null, d30: null });
  });

  test('variação de 7 e 30 dias vem da linha do dia correspondente; sem linha, null', async () => {
    comDiaGravado();
    const { body } = await api('get', '/hoje');
    const bloco = (id) => body.blocos.find((b) => b.id === id);
    expect(bloco('pagantes').valor).toBe(5);
    expect(bloco('pagantes').variacao).toEqual({ d7: 1, d30: 2 });
    expect(bloco('receita').variacao).toEqual({ d7: 73.34, d30: null });
    expect(bloco('fiscal').variacao).toEqual({ d7: null, d30: null });
  });

  test('alertas: os cinco tipos, cada um apontando loja, verbo e bloco', async () => {
    comDiaGravado();
    const { body } = await api('get', '/hoje');
    expect(body.alertas).toEqual([
      { tipo: 'pagante_anual_vencendo', company_id: fake.id(1), titulo: 'Loja Aurora vence amanhã', detalhe: 'Anual · sem venda há 22 dias', verbo: 'Ligar', bloco: 'pagantes_sem_venda' },
      { tipo: 'trial_com_venda_vencendo', company_id: fake.id(5), titulo: 'Ótica Visão: trial com venda vence amanhã', detalhe: '3 vendas no trial', verbo: 'Oferecer', bloco: 'trials_degrau' },
      { tipo: 'pagamento_sem_loja', company_id: null, titulo: 'R$ 140,83 recebido sem loja vinculada', detalhe: 'Asaas · 12/10', verbo: 'Vincular', bloco: 'receita' },
      { tipo: 'nfce_rejeitada', company_id: fake.id(2), titulo: 'Mercado Bela Vista: 1 NFC-e rejeitada em 7 dias', detalhe: 'Rejeição 327: CFOP inválido', verbo: 'Ver', bloco: 'fiscal' },
      // 05:30 → 09:00 BRT: 3h30 sem resposta humana (a Aurinha já respondeu)
      { tipo: 'contato_sem_resposta', company_id: null, titulo: '+55 12 98888-0077 sem resposta há 3 h 30 min', detalhe: 'WhatsApp +55 12 98888-0077 · https://wa.me/5512988880077 · Aurinha já respondeu', verbo: 'Responder', bloco: 'contatos' },
    ]);
  });

  test('alerta de contato vale o de agora, não o gravado às 06h', async () => {
    // O que o job das 06h gravou não tem contato (de madrugada não se avisa):
    // o /hoje de 09h BRT traz o contato mesmo assim.
    const dados = fake.dadosPadrao();
    dados.gravados = doDia.gravados;
    dados.alertasGravados = doDia.alertas.filter((a) => a.tipo !== 'contato_sem_resposta');
    fake.ligar(db.query, dados);
    const { body } = await api('get', '/hoje');
    expect(body.alertas.filter((a) => a.tipo === 'contato_sem_resposta')).toHaveLength(1);

    // à noite o alerta some (a Aurinha está de plantão); o resto continua
    jest.setSystemTime(new Date('2026-10-14T00:30:00.000Z')); // 21h30 BRT
    try {
      fake.ligar(db.query, dados);
      const noite = await api('get', '/hoje');
      expect(noite.body.alertas.map((a) => a.tipo)).not.toContain('contato_sem_resposta');
      expect(noite.body.alertas).toHaveLength(body.alertas.length - 1);
    } finally {
      jest.setSystemTime(fake.AGORA);
    }
  });
});

describe('GET /admin/painel/blocos/:id — uma rota por bloco', () => {
  test.each(BLOCOS.map((b) => [b.id]))('%s — fixture blocos.%s.json', async (id) => {
    comDiaGravado();
    const res = await api('get', '/blocos/' + id);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'ao_vivo', 'calculado_em', 'fonte', 'id', 'indicadores', 'insight', 'listas', 'periodo',
      'resumo', 'series', 'titulo', 'unidade', 'valor',
    ]);
    expect(res.body.id).toBe(id);
    expect(res.body.ao_vivo).toBe(false);
    for (const i of res.body.indicadores) expect(Object.keys(i).sort()).toEqual(['nota', 'rotulo', 'valor']);
    for (const l of res.body.listas) {
      expect(Object.keys(l).sort()).toEqual(['colunas', 'linhas', 'titulo']);
      // toda coluna declarada existe nas linhas
      for (const linha of l.linhas) for (const c of l.colunas) expect(linha).toHaveProperty(c.chave);
      // lista de lojas: cada linha diz qual loja é
      if (l.colunas.some((c) => c.tipo === 'loja')) {
        for (const linha of l.linhas) {
          expect(linha).toHaveProperty('company_id');
          expect(linha).toHaveProperty('telefone');
        }
      }
    }
    for (const s of res.body.series) expect(Object.keys(s).sort()).toEqual(['pontos', 'tipo', 'titulo']);
    conferir('blocos.' + id, res.body);
  });

  test('período padrão vem gravado; outro período é calculado ao vivo', async () => {
    comDiaGravado();
    const padrao = await api('get', '/blocos/pagantes?periodo=30');
    expect(padrao.body.ao_vivo).toBe(false);
    expect(padrao.body.periodo).toBe(30);

    db.query.mockClear();
    const outro = await api('get', '/blocos/pagantes?periodo=90');
    expect(outro.status).toBe(200);
    expect(outro.body.ao_vivo).toBe(true);
    expect(outro.body.periodo).toBe(90);
    expect(outro.body.listas[0].colunas.map((c) => c.rotulo)).toContain('Vendas 90d');
    // a janela pedida chega na consulta
    const sqls = db.query.mock.calls.map((c) => c[0].replace(/\s+/g, ' '));
    expect(sqls.some((s) => s.includes('FROM sales') && s.includes('$1::date - 90'))).toBe(true);
  });

  test('períodos aceitos: 7, 30 e 90', async () => {
    comDiaGravado();
    for (const p of [7, 30, 90]) expect((await api('get', `/blocos/cadastros?periodo=${p}`)).status).toBe(200);
    for (const p of ['15', '0', 'abc', '']) {
      const res = await api('get', `/blocos/cadastros?periodo=${p}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/7, 30 ou 90/);
    }
  });

  test('bloco que não existe → 404', async () => {
    comDiaGravado();
    expect((await api('get', '/blocos/nps')).status).toBe(404);
  });

  test('contas internas e lojas fora do universo não entram em nenhuma lista', async () => {
    comDiaGravado();
    const res = await api('get', '/blocos/plataforma');
    const ontem = res.body.series[0].pontos[res.body.series[0].pontos.length - 1];
    expect(ontem).toEqual({ rotulo: '12/10', dia: '2026-10-12', valor: 13 }); // 9 + 4, sem as 50 da conta interna
    expect(JSON.stringify(res.body)).not.toContain('cccccccc');
  });

  test('trials por degrau: cada conta num degrau só, sem os dojôs', async () => {
    comDiaGravado();
    const { body } = await api('get', '/blocos/trials_degrau');
    const degrau = Object.fromEntries(body.listas.map((l) => [l.titulo, l.linhas.map((x) => x.nome)]));
    expect(degrau).toEqual({
      'Só cadastro': [],
      'Com produtos': ['Bazar Novo'],
      Venderam: ['Ótica Visão'],
      'Viram checkout': ['Tech Assist'],
      Assinaram: ['Papelaria Sol'],
    });
    expect(body.valor).toBe(4);
    expect(body.series[0].pontos.map((p) => p.valor)).toEqual([4, 3, 2, 1, 1]);
  });

  test('trials por degrau: cada linha diz o modo do trial e quando a primeira venda o iniciou', async () => {
    comDiaGravado();
    const { body } = await api('get', '/blocos/trials_degrau');
    const linhas = body.listas.flatMap((l) => l.linhas);
    const modo = Object.fromEntries(linhas.map((l) => [l.nome, [l.trial_mode, l.started_by_sale_at]]));
    expect(modo).toEqual({
      'Ótica Visão': ['primeira_venda', fake.ts('2026-10-07')], // vendeu: os 7 dias correm
      'Tech Assist': ['primeira_venda', null],                  // ainda não vendeu: vence_em é o teto
      'Bazar Novo': ['fixo', null],                             // conta por código
      'Papelaria Sol': ['fixo', null],
    });
  });

  test('trials por degrau sem a migration 379: todo mundo fixo e o funil não zera', async () => {
    const dados = fake.dadosPadrao();
    const banco = {
      query: async (sql, params) => {
        if (sql.includes('trial_started_by_sale_at')) throw Object.assign(new Error('column c.trial_mode does not exist'), { code: '42703' });
        return { rows: fake.responder(dados, [], sql, params) };
      },
    };
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const bloco = await require('../../src/services/painelBlocos/trials_degrau').calcular({ hoje: fake.HOJE, db: banco });
    const linhas = bloco.lista;
    expect(linhas.map((l) => l.trial_mode)).toEqual(['fixo', 'fixo', 'fixo', 'fixo']);
    expect(linhas.find((l) => l.nome === 'Ótica Visão')).toMatchObject({ vendas: 3, produtos: 40, started_by_sale_at: null });
    console.warn.mockRestore();
  });

  test('uso por funcionalidade: lojas distintas em 7 dias, no período e desde sempre', async () => {
    comDiaGravado();
    const { body } = await api('get', '/blocos/uso_funcionalidade');
    const caixa = body.listas[0].linhas.find((l) => l.modulo === 'caixa');
    expect(caixa).toMatchObject({ rotulo: 'Caixa', lojas_7d: 4, lojas_periodo: 5, eventos_periodo: 176, lojas_total: 5 });
    expect(caixa.lojas[0]).toEqual({ company_id: fake.id(2), nome: 'Mercado Bela Vista' });
    const os = body.listas[0].linhas.find((l) => l.modulo === 'ordens_servico');
    expect(os).toMatchObject({ lojas_7d: 0, lojas_periodo: 0, lojas_total: 1 });
  });
});

describe('GET /admin/painel/clientes/:cid/ficha', () => {
  test('junta clients-360, health, logins, Asaas, módulos e linha do tempo — fixture clientes.ficha.json', async () => {
    comDiaGravado();
    const res = await api('get', `/clientes/${fake.id(1)}/ficha`);
    expect(res.status).toBe(200);
    expect(res.body.nome).toBe('Loja Aurora');
    expect(res.body.cliente.ativacao).toEqual({ importou: true, abriu_caixa: true, vendeu: true, viu_checkout: false });
    expect(res.body.health).toMatchObject({ score: 45, risk_level: 'attention' });
    expect(res.body.logins).toEqual({ ultimos_30d: 3, dias_ativos_30d: 3, ultimo_acesso: '2026-10-08T15:00:00.000Z' });
    expect(res.body.modulos).toEqual(['Caixa', 'Studio pedidos', 'Estoque']);
    expect(res.body.asaas[0]).toEqual({ evento: 'PAYMENT_DELETED', quando: '2026-09-21T09:00:00.000Z', valor: 140.83, vencimento: '2026-10-14' });
    expect(res.body.linha_do_tempo.map((e) => e.titulo)).toEqual([
      'Login', 'Cobrança apagada na Asaas', 'Venda', 'NFC-e autorizada', 'Pagamento recebido',
    ]);
    expect(res.body.linha_do_tempo.length).toBeLessThanOrEqual(10);
    expect(res.body.vendas_por_semana).toHaveLength(12);
    expect(res.body.alertas.map((a) => a.tipo)).toEqual(['pagante_anual_vencendo']);
    conferir('clientes.ficha', res.body);
  });

  test('a consulta do clients-360 é a mesma, filtrada pela empresa', async () => {
    comDiaGravado();
    await api('get', `/clientes/${fake.id(1)}/ficha`);
    const c360 = db.query.mock.calls.find((c) => c[0].includes('ck ON true'));
    expect(c360[0]).toContain('WHERE c.id = $1');
    expect(c360[1]).toEqual([fake.id(1)]);
  });

  test('empresa que não existe ou id fora do formato → 404', async () => {
    comDiaGravado();
    expect((await api('get', `/clientes/${fake.id(9)}/ficha`)).status).toBe(404);
    db.query.mockClear();
    expect((await api('get', '/clientes/nao-e-uuid/ficha')).status).toBe(404);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('GET /admin/painel/contatos/:conversaId', () => {
  test('conversa inteira: telefone completo, link, empresa, quem respondeu e mensagens — fixture contatos.conversa.json', async () => {
    fake.ligar(db.query);
    const res = await api('get', `/contatos/${fake.conv(1)}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      conversa_id: fake.conv(1),
      canal: 'whatsapp',
      telefone: '5511999900002',
      telefone_formatado: '+55 11 99990-0002',
      telefone_mascarado: '+55 11 *****-0002',
      link_whatsapp: 'https://wa.me/5511999900002',
      nome: 'Renata Lima',
      empresa: { company_id: fake.id(2), nome: 'Mercado Bela Vista' },
    });
    expect(res.body.contato_atual).toMatchObject({ situacao: 'humano', situacao_rotulo: 'Caio', espera_min: 510 });
    expect(res.body.mensagens.map((m) => [m.direcao, m.autor])).toEqual([
      ['recebida', 'cliente'], ['enviada', 'aurinha'], ['enviada', 'humano'],
    ]);
    // sempre do tenant Aura, só WhatsApp
    const consulta = db.query.mock.calls.find((c) => c[0].replace(/\s+/g, ' ').includes('-- contatos:conversa '));
    expect(consulta[1]).toEqual([fake.conv(1), fake.AURA_COMPANY]);
    conferir('contatos.conversa', res.body);
  });

  test('conversa que ainda espera resposta: aponta desde quando', async () => {
    fake.ligar(db.query);
    const { body } = await api('get', `/contatos/${fake.conv(2)}`);
    expect(body.nome).toBeNull();
    expect(body.empresa).toBeNull();
    expect(body.contato_atual).toMatchObject({
      situacao: 'aurinha', espera_min: null, sem_resposta_humana_desde: '2026-10-13T08:30:00.000Z',
    });
  });

  test('id que não é de conversa da Aura (ou não é uuid) → 404', async () => {
    fake.ligar(db.query);
    expect((await api('get', `/contatos/${fake.conv(9)}`)).status).toBe(404);
    db.query.mockClear();
    expect((await api('get', '/contatos/nao-e-uuid')).status).toBe(404);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('número da Aura não ligado (sem AURA_COMPANY_ID) → 404 e nenhuma consulta', async () => {
    fake.ligar(db.query);
    const anterior = process.env.AURA_COMPANY_ID;
    delete process.env.AURA_COMPANY_ID;
    try {
      expect((await api('get', `/contatos/${fake.conv(1)}`)).status).toBe(404);
      expect(db.query).not.toHaveBeenCalled();
    } finally {
      process.env.AURA_COMPANY_ID = anterior;
    }
  });
});

describe('GET e PUT /admin/painel/layout', () => {
  test('sem layout salvo: todos os blocos, visíveis, na ordem padrão — fixture layout.get.json', async () => {
    fake.ligar(db.query);
    const res = await api('get', '/layout');
    expect(res.status).toBe(200);
    expect(res.body.padrao).toBe(true);
    expect(res.body.blocos.map((b) => b.id)).toEqual(BLOCOS.map((b) => b.id));
    expect(res.body.blocos.every((b) => b.visivel)).toBe(true);
    expect(db.query.mock.calls[0][1]).toEqual([fake.USER]);
    conferir('layout.get', res.body);
  });

  test('PUT grava ordem e visibilidade do usuário — fixture layout.put.json', async () => {
    const { escritas } = fake.ligar(db.query);
    const body = { blocos: [{ id: 'receita', visivel: true }, { id: 'pagantes', visivel: true }, { id: 'contatos', visivel: false }] };
    const res = await api('put', '/layout').send(body);
    expect(res.status).toBe(200);
    expect(res.body.padrao).toBe(false);
    expect(res.body.blocos.slice(0, 3).map((b) => [b.id, b.visivel])).toEqual([['receita', true], ['pagantes', true], ['contatos', false]]);
    // o que não veio no body entra depois, visível
    expect(res.body.blocos).toHaveLength(BLOCOS.length);

    expect(escritas).toHaveLength(1);
    expect(escritas[0].sql).toContain('ON CONFLICT (user_id) DO UPDATE');
    expect(escritas[0].params[0]).toBe(fake.USER);
    expect(JSON.parse(escritas[0].params[1])).toEqual(res.body.blocos.map(({ id, visivel }) => ({ id, visivel })));
    conferir('layout.put', { requisicao: body, resposta: res.body });
  });

  test('GET devolve o layout salvo; bloco novo no catálogo entra no fim', async () => {
    const dados = fake.dadosPadrao();
    dados.layout = { blocos: [{ id: 'fiscal', visivel: false }, { id: 'bloco_antigo', visivel: true }, { id: 'receita', visivel: true }], updated_at: '2026-10-12T20:00:00.000Z' };
    fake.ligar(db.query, dados);
    const { body } = await api('get', '/layout');
    expect(body.padrao).toBe(false);
    expect(body.blocos.slice(0, 2).map((b) => [b.id, b.visivel])).toEqual([['fiscal', false], ['receita', true]]);
    expect(body.blocos.map((b) => b.id)).not.toContain('bloco_antigo');
    expect(body.blocos).toHaveLength(BLOCOS.length);
  });

  test.each([
    ['sem blocos', {}],
    ['blocos não é lista', { blocos: 'receita' }],
    ['bloco desconhecido', { blocos: [{ id: 'nps', visivel: true }] }],
    ['bloco repetido', { blocos: [{ id: 'receita' }, { id: 'receita' }] }],
    ['item sem id', { blocos: [{ visivel: true }] }],
    ['item nulo', { blocos: [null] }],
  ])('PUT inválido (%s) → 400 e nada gravado', async (_n, body) => {
    const { escritas } = fake.ligar(db.query);
    const res = await api('put', '/layout').send(body);
    expect(res.status).toBe(400);
    expect(escritas).toHaveLength(0);
  });
});

describe('POST /admin/painel/recalcular', () => {
  test('roda o passo diário e responde duração e erros — fixture recalcular.json', async () => {
    const { escritas } = fake.ligar(db.query);
    const res = await api('post', '/recalcular');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.erros).toEqual([]);
    expect(res.body.dia).toBe(fake.HOJE);
    expect(typeof res.body.duracao_ms).toBe('number');
    expect(res.body.blocos.slice().sort()).toEqual(BLOCOS.map((b) => b.id).sort());
    expect(res.body.mrr_total).toBe(553);
    expect(escritas.map((e) => e.tabela)).toEqual([
      'client_health_scores', 'aura_revenue_snapshot', 'painel_blocos_diarios', 'painel_alertas', 'painel_alertas',
    ]);
    conferir('recalcular', { ...res.body, blocos: res.body.blocos.slice().sort() });
  });

  test('um bloco quebrado não derruba os outros: 200, ok false e o erro na resposta', async () => {
    const dados = fake.dadosPadrao();
    const escritas = [];
    db.query.mockImplementation(async (sql, params) => {
      if (sql.includes('FROM credit_installments')) throw new Error('timeout no crediário');
      return { rows: fake.responder(dados, escritas, sql, params) };
    });
    const res = await api('post', '/recalcular');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.erros).toEqual([{ etapa: 'bloco:crediario', erro: 'timeout no crediário' }]);
    expect(res.body.blocos).not.toContain('crediario');
    expect(res.body.blocos).toHaveLength(BLOCOS.length - 1);
    // os outros 14 foram gravados
    const gravado = JSON.parse(escritas.find((e) => e.tabela === 'painel_blocos_diarios').params[1]);
    expect(gravado.map((g) => g.bloco)).not.toContain('crediario');
    expect(gravado).toHaveLength(BLOCOS.length - 1);
  });
});

describe('passo diário — gravação idempotente', () => {
  test('rodar duas vezes no mesmo dia regrava as mesmas linhas (upsert), sem duplicar', async () => {
    const { escritas } = fake.ligar(db.query);
    await painel.rodarPainelDiario({ hoje: fake.HOJE });
    const primeira = escritas.splice(0);
    await painel.rodarPainelDiario({ hoje: fake.HOJE });

    expect(escritas.map((e) => [e.tabela, e.params])).toEqual(primeira.map((e) => [e.tabela, e.params]));

    const sqlDe = (tabela) => primeira.filter((e) => e.tabela === tabela).map((e) => e.sql).join(' ');
    expect(sqlDe('painel_blocos_diarios')).toContain('ON CONFLICT (dia, bloco) DO UPDATE');
    expect(sqlDe('painel_alertas')).toContain('ON CONFLICT (dia, tipo, chave) DO UPDATE');
    expect(sqlDe('aura_revenue_snapshot')).toContain('ON CONFLICT (reference_month) DO UPDATE');
    expect(sqlDe('client_health_scores')).toContain('ON CONFLICT (company_id) DO UPDATE');
  });

  test('uma linha por bloco, com o dia de Brasília', async () => {
    const { escritas } = fake.ligar(db.query);
    await painel.rodarPainelDiario({ hoje: fake.HOJE });
    const blocos = escritas.find((e) => e.tabela === 'painel_blocos_diarios');
    expect(blocos.params[0]).toBe(fake.HOJE);
    const linhas = JSON.parse(blocos.params[1]);
    expect(linhas.map((l) => l.bloco).sort()).toEqual(BLOCOS.map((b) => b.id).sort());
    for (const l of linhas) {
      expect(Object.keys(l.dados).sort()).toEqual(['detalhe', 'fonte', 'lista', 'resumo', 'serie', 'unidade', 'valor', 'variacao']);
    }
  });

  test('alertas do dia: apaga os que não valem mais e regrava os atuais', async () => {
    const { escritas } = fake.ligar(db.query);
    await painel.rodarPainelDiario({ hoje: fake.HOJE });
    const [apaga, grava] = escritas.filter((e) => e.tabela === 'painel_alertas');
    expect(apaga.sql).toMatch(/^DELETE FROM painel_alertas WHERE dia = \$1::date AND NOT/);
    expect(apaga.params[1]).toEqual([
      `pagante_anual_vencendo:${fake.id(1)}`, `trial_com_venda_vencendo:${fake.id(5)}`,
      'pagamento_sem_loja:w4', `nfce_rejeitada:${fake.id(2)}`,
      `contato_sem_resposta:${fake.conv(2)}`,
    ]);
    expect(JSON.parse(grava.params[1])).toHaveLength(5);
  });

  test('hojeBRT: 02h UTC ainda é o dia anterior em Brasília', () => {
    expect(painel.hojeBRT(Date.parse('2026-10-13T02:59:00Z'))).toBe('2026-10-12');
    expect(painel.hojeBRT(Date.parse('2026-10-13T03:00:00Z'))).toBe('2026-10-13');
  });
});
