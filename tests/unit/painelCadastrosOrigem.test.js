// ============================================================
// Card t2-13: no bloco Cadastros, quem entrou com o código COMECAR aparece
// como "Site (COMECAR)" e não como "Código de convite". Só outro código é
// convite; sem código segue "Site (self-service)".
// ============================================================
'use strict';

const db = require('../../src/config/database');
const fake = require('../helpers/fakePainelDb');
const b = require('../../src/services/painelBlocos/_base');
const cadastros = require('../../src/services/painelBlocos/cadastros');

const base = {
  telefone: null, plan: 'negocio', ciclo: 'monthly', status: 'trial', criado_em: '2026-10-10',
  trial_ate: '2026-10-17', vence_em: null, segment: null, vertical_active: null, tem_cobranca: false,
  eh_dojo: false, por_codigo: false, codigo_acesso: null,
};

function dadosComOrigens() {
  const dados = fake.dadosPadrao();
  dados.empresas = [
    { ...base, company_id: fake.id(1), nome: 'Veio pelo COMECAR', por_codigo: true, codigo_acesso: 'COMECAR' },
    { ...base, company_id: fake.id(2), nome: 'COMECAR minúsculo', por_codigo: true, codigo_acesso: 'comecar' },
    { ...base, company_id: fake.id(3), nome: 'Veio por convite', por_codigo: true, codigo_acesso: 'DAVI10' },
    { ...base, company_id: fake.id(4), nome: 'Veio sem código' },
  ];
  return dados;
}

beforeEach(() => { fake.ligar(db.query, dadosComOrigens()); });
afterEach(() => db.query.mockReset());

describe('origemDe', () => {
  test('COMECAR (qualquer caixa, com espaço) é Site (COMECAR)', () => {
    expect(cadastros.origemDe({ por_codigo: true, codigo_acesso: 'COMECAR' })).toBe('Site (COMECAR)');
    expect(cadastros.origemDe({ por_codigo: true, codigo_acesso: ' comecar ' })).toBe('Site (COMECAR)');
  });
  test('outro código é Código de convite; sem código é Site (self-service)', () => {
    expect(cadastros.origemDe({ por_codigo: true, codigo_acesso: 'DAVI10' })).toBe('Código de convite');
    expect(cadastros.origemDe({ por_codigo: true })).toBe('Código de convite');
    expect(cadastros.origemDe({ por_codigo: false })).toBe('Site (self-service)');
  });
});

describe('bloco Cadastros', () => {
  const calcular = () => cadastros.calcular({ hoje: fake.HOJE, periodo: 30, db });
  const origemDe = (r, nome) => r.lista.find((l) => l.nome === nome).origem;

  test('todos os cadastros com COMECAR saem como Site (COMECAR)', async () => {
    const r = await calcular();
    expect(origemDe(r, 'Veio pelo COMECAR')).toBe('Site (COMECAR)');
    expect(origemDe(r, 'COMECAR minúsculo')).toBe('Site (COMECAR)');
    expect(origemDe(r, 'Veio por convite')).toBe('Código de convite');
    expect(origemDe(r, 'Veio sem código')).toBe('Site (self-service)');
  });

  test('a série de origem e o indicador "por código de convite" contam só convite', async () => {
    const r = await calcular();
    const origens = r.detalhe.series.find((s) => s.titulo.startsWith('Origem')).pontos;
    expect(origens).toEqual(expect.arrayContaining([
      { rotulo: 'Site (COMECAR)', valor: 2 },
      { rotulo: 'Código de convite', valor: 1 },
      { rotulo: 'Site (self-service)', valor: 1 },
    ]));
    expect(r.detalhe.indicadores.find((i) => i.rotulo === 'Por código de convite').valor).toBe(1);
    expect(r.resumo).toBe('3 self-service · 1 por código');
  });

  test('o universo traz o código normalizado (maiúsculo, sem espaço)', async () => {
    await b.carregarEmpresas(db);
    const sql = db.query.mock.calls[0][0].replace(/\s+/g, ' ');
    expect(sql).toContain("UPPER(NULLIF(TRIM(c.access_code_used), '')) AS codigo_acesso");
  });
});
