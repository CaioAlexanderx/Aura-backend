// ============================================================
// Card t1-11 (estende o #820): filial paga pela matriz e dojô sem assinatura
// própria não contam como pagante nem entram na adoção nos blocos do painel.
// A empresa continua no universo (lista); dojô COM assinatura continua contando.
//
// Os dados vêm de tests/helpers/fakePainelDb.js, com três empresas a mais:
// uma filial (Villa Branca, vence_em de 18/06), um dojô sem assinatura e um
// dojô com assinatura própria.
//
// 19/10/2026 (decisão do Caio): na consulta real o dojô (vertical
// 'karate_dojo') nem entra no universo (SEM_INTERNAS; ver
// tests/routes/adminSemDojos.test.js). O banco de mentira daqui devolve as
// linhas prontas, então este arquivo segue testando só a regra em JS.
// ============================================================
'use strict';

const db = require('../../src/config/database');
const fake = require('../helpers/fakePainelDb');
const b = require('../../src/services/painelBlocos/_base');
const { fonteCompanies } = require('../../src/services/receita');

const FILIAL = fake.id(9);
const DOJO_SEM = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const DOJO_COM = 'aaaaaaaa-0000-4000-8000-0000000000a2';

function dadosComFiliaisEDojos() {
  const dados = fake.dadosPadrao();
  const base = {
    telefone: null, plan: 'essencial', ciclo: 'monthly', status: 'active', criado_em: '2026-04-01',
    trial_ate: null, segment: null, vertical_active: null, por_codigo: false, tem_cobranca: false, eh_dojo: false,
    paga_por_outra: false, dojo_sem_assinatura: false,
  };
  dados.empresas.push(
    { ...base, company_id: FILIAL, nome: 'Davi Villa Branca', plan: 'negocio', vence_em: '2026-06-18', paga_por_outra: true },
    { ...base, company_id: DOJO_SEM, nome: 'BASSAI DAI', vence_em: null, eh_dojo: true, dojo_sem_assinatura: true, vertical_active: 'karate_dojo' },
    { ...base, company_id: DOJO_COM, nome: 'Dojo Com Assinatura', vence_em: '2026-10-30', eh_dojo: true, tem_cobranca: true, vertical_active: 'karate_dojo' }
  );
  return dados;
}

let dados;

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  dados = dadosComFiliaisEDojos();
  fake.ligar(db.query, dados);
});
afterEach(() => { db.query.mockReset(); jest.restoreAllMocks(); });

const nomes = (lista) => lista.map((e) => e.nome);
const sqls = () => db.query.mock.calls.map((c) => c[0].replace(/\s+/g, ' '));

describe('carregarEmpresas', () => {
  test('pagantes sai sem a filial e sem o dojô sem assinatura; dojô com assinatura continua', async () => {
    const emp = await b.carregarEmpresas(db);
    expect(nomes(emp.pagantes)).toEqual(expect.arrayContaining(['Dojo Com Assinatura', 'Loja Aurora']));
    expect(nomes(emp.pagantes)).not.toContain('Davi Villa Branca');
    expect(nomes(emp.pagantes)).not.toContain('BASSAI DAI');
  });

  test('as empresas continuam existindo: ficam em lista e porId, e em foraDaContagem com o motivo', async () => {
    const emp = await b.carregarEmpresas(db);
    expect(nomes(emp.lista)).toEqual(expect.arrayContaining(['Davi Villa Branca', 'BASSAI DAI']));
    expect(emp.porId.has(FILIAL)).toBe(true);
    expect(emp.porId.get(FILIAL).pagante).toBe(true); // a conta está ativa
    expect(emp.porId.get(FILIAL).conta_pagante).toBe(false);
    expect(emp.foraDaContagem.map((e) => [e.nome, b.motivoForaDaContagem(e)])).toEqual([
      ['Davi Villa Branca', 'Filial paga pela matriz'],
      ['BASSAI DAI', 'Dojô sem assinatura própria'],
    ]);
  });

  test('o SQL do universo e o da fonte de MRR usam o MESMO fragmento (regra única)', async () => {
    await b.carregarEmpresas(db);
    await fonteCompanies({ db });
    const [universo, mrr] = sqls().filter((s) => s.includes('FROM companies c'));
    for (const frag of [b.PAGA_POR_OUTRA, b.DOJO_SEM_ASSINATURA]) {
      expect(universo).toContain(frag);
      expect(mrr).toContain(frag);
    }
    // dojô com assinatura própria não entra na regra
    expect(b.DOJO_SEM_ASSINATURA).toContain('c.asaas_subscription_id IS NULL');
    // as empresas NÃO saem do universo: o filtro é só de contagem
    expect(universo).not.toContain(`NOT ${b.PAGA_POR_OUTRA}`);
    expect(universo).not.toContain(`NOT ${b.DOJO_SEM_ASSINATURA}`);
    expect(mrr).toContain(`NOT ${b.PAGA_POR_OUTRA}`);
    expect(mrr).toContain(`NOT ${b.DOJO_SEM_ASSINATURA}`);
  });
});

describe('blocos', () => {
  const calcular = (id, extra = {}) => require(`../../src/services/painelBlocos/${id}`)
    .calcular({ hoje: fake.HOJE, db, ...extra });

  test('pagantes: não conta a filial (nem acusa o vencimento de 18/06) nem o dojô sem assinatura', async () => {
    const r = await calcular('pagantes');
    expect(nomes(r.lista)).not.toContain('Davi Villa Branca');
    expect(nomes(r.lista)).not.toContain('BASSAI DAI');
    expect(nomes(r.lista)).toContain('Dojo Com Assinatura');
    expect(r.valor).toBe(r.lista.length);
    expect(r.detalhe.insight || '').not.toContain('Villa Branca');
  });

  test('pagantes: mostra quem ficou de fora e por quê', async () => {
    const r = await calcular('pagantes');
    const ind = r.detalhe.indicadores.find((i) => i.rotulo === 'Fora da contagem');
    expect(ind.valor).toBe(2);
    const lista = r.detalhe.listas.find((l) => l.titulo === 'Ativas fora da contagem');
    expect(lista.linhas.map((l) => [l.nome, l.motivo])).toEqual([
      ['Davi Villa Branca', 'Filial paga pela matriz'],
      ['BASSAI DAI', 'Dojô sem assinatura própria'],
    ]);
  });

  test('pagantes sem ninguém fora da contagem: o formato não muda', async () => {
    dados.empresas = dados.empresas.filter((e) => ![FILIAL, DOJO_SEM].includes(e.company_id));
    const r = await calcular('pagantes');
    expect(r.detalhe.indicadores.map((i) => i.rotulo)).not.toContain('Fora da contagem');
    expect(r.detalhe.listas.map((l) => l.titulo)).not.toContain('Ativas fora da contagem');
  });

  test('adoção por recurso: o denominador não inclui a filial nem o dojô sem assinatura', async () => {
    const emp = await b.carregarEmpresas(db);
    const r = await calcular('adocao', { empresas: emp });
    expect(r.lista[0].de).toBe(emp.pagantes.length);
    const lojas = r.detalhe.listas[1].linhas.map((l) => l.nome);
    expect(lojas).not.toContain('Davi Villa Branca');
    expect(lojas).not.toContain('BASSAI DAI');
    expect(lojas).toContain('Dojo Com Assinatura');
  });

  test('pagantes sem venda: filial e dojô sem assinatura não viram "pagante sem venda"', async () => {
    const r = await calcular('pagantes_sem_venda', { periodo: 7 });
    expect(nomes(r.lista)).not.toContain('Davi Villa Branca');
    expect(nomes(r.lista)).not.toContain('BASSAI DAI');
  });

  test('acesso: a situação da filial não é "Pagante" e o dojô sem assinatura não entra em "nunca entrou"', async () => {
    const r = await calcular('acesso');
    const nunca = r.detalhe.listas.find((l) => l.titulo === 'Quem nunca entrou').linhas;
    expect(nunca.find((l) => l.nome === 'BASSAI DAI')).toBeUndefined();
    const filial = nunca.find((l) => l.nome === 'Davi Villa Branca');
    expect(filial.situacao).toBe('Sem cobrança própria');
    expect(nomes(r.lista)).not.toContain('Davi Villa Branca');
  });

  test('frentes: a filial não vira pagante nem trial; a loja continua na lista', async () => {
    const r = await calcular('frentes');
    const linha = r.lista.find((l) => l.nome === 'Davi Villa Branca');
    expect(linha.situacao).toBe('Sem cobrança própria');
    expect(r.detalhe.listas[1].linhas.find((l) => l.nome === 'Davi Villa Branca')).toBeDefined();
    expect(r.detalhe.indicadores[0].nota).toContain('sem cobrança própria');
  });

  test('trials por degrau: a filial ativa não aparece como "assinou" nem como trial vencido', async () => {
    const r = await calcular('trials_degrau');
    expect(nomes(r.lista)).not.toContain('Davi Villa Branca');
  });
});
