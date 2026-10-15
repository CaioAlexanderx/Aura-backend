// ============================================================
// AURA. -- Origem do cadastro (t2-09): sanitizacao pura e bloco Cadastros
// ============================================================
'use strict';

const { sanitizarOrigem } = require('../../src/services/signupOrigem');
const db = require('../../src/config/database');
const fake = require('../helpers/fakePainelDb');
const cadastros = require('../../src/services/painelBlocos/cadastros');

describe('sanitizarOrigem', () => {
  test('origem completa do contrato passa limpa', () => {
    expect(sanitizarOrigem({
      utm_source: 'instagram', utm_medium: 'social', utm_campaign: 'black-friday', utm_content: 'reels', utm_term: 'gestao',
      landing_page: '/planos', referrer: 'l.instagram.com', first_seen_at: '2026-10-14T10:00:00Z',
    })).toEqual({
      utm_source: 'instagram', utm_medium: 'social', utm_campaign: 'black-friday', utm_content: 'reels', utm_term: 'gestao',
      landing_page: '/planos', referrer: 'l.instagram.com', first_seen_at: '2026-10-14T10:00:00.000Z',
    });
  });

  test('so o que veio: o resto nao aparece', () => {
    expect(sanitizarOrigem({ landing_page: '/' })).toEqual({ landing_page: '/' });
  });

  test('limites do contrato: utm 100, landing 300, referrer 200', () => {
    const o = sanitizarOrigem({
      utm_term: 't'.repeat(500), landing_page: `/${'a'.repeat(900)}`, referrer: `${'h'.repeat(500)}.com`,
    });
    expect(o.utm_term).toHaveLength(100);
    expect(o.landing_page).toHaveLength(300);
    expect(o.referrer.length).toBeLessThanOrEqual(200);
  });

  test('landing_page: tira query, hash e dominio; garante a barra inicial', () => {
    expect(sanitizarOrigem({ landing_page: '/planos?ref=ABC123&email=a@b.com#x' }).landing_page).toBe('/planos');
    expect(sanitizarOrigem({ landing_page: 'https://getaura.com.br/comecar?ramo=otica' }).landing_page).toBe('/comecar');
    expect(sanitizarOrigem({ landing_page: 'planos' }).landing_page).toBe('/planos');
    expect(sanitizarOrigem({ landing_page: '?so=query' }).landing_page).toBe('/');
  });

  test('referrer: so o host, em minusculas, sem porta nem credencial', () => {
    expect(sanitizarOrigem({ referrer: 'https://WWW.Google.com/search?q=x' }).referrer).toBe('www.google.com');
    expect(sanitizarOrigem({ referrer: 'https://user:senha@site.com:8080/p' }).referrer).toBe('site.com');
    expect(sanitizarOrigem({ referrer: 'www.bing.com' }).referrer).toBe('www.bing.com');
    expect(sanitizarOrigem({ referrer: 'javascript:alert(1)' })).toBeNull();
    expect(sanitizarOrigem({ referrer: '<script>' })).toBeNull();
  });

  test('utm_source e utm_medium em minusculas; campanha mantem a caixa', () => {
    const o = sanitizarOrigem({ utm_source: ' Google ', utm_medium: 'CPC', utm_campaign: 'Black-Friday' });
    expect(o).toEqual({ utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'Black-Friday' });
  });

  test('first_seen_at: so data valida e plausivel', () => {
    expect(sanitizarOrigem({ first_seen_at: 'ontem' })).toBeNull();
    expect(sanitizarOrigem({ first_seen_at: '1970-01-01T00:00:00Z' })).toBeNull();
    expect(sanitizarOrigem({ first_seen_at: 20261012 })).toBeNull();
  });

  test('caractere de controle e espaco repetido saem', () => {
    expect(sanitizarOrigem({ utm_campaign: 'a\u0000b\n\n  c' }).utm_campaign).toBe('a b c');
    expect(sanitizarOrigem({ utm_campaign: '   ' })).toBeNull();
  });

  test.each([null, undefined, 'x', 3, true, [], [{ utm_source: 'a' }], {}])('entrada %p devolve null', (v) => {
    expect(sanitizarOrigem(v)).toBeNull();
  });

  test('chaves desconhecidas (inclusive pessoais) somem', () => {
    expect(sanitizarOrigem({ email: 'a@b.com', telefone: '11999990000', ip: '1.1.1.1', utm_source: 'g' })).toEqual({ utm_source: 'g' });
  });
});

describe('bloco Cadastros -- origem do site', () => {
  const base = {
    telefone: null, plan: 'negocio', ciclo: 'monthly', status: 'trial', criado_em: '2026-10-10',
    trial_ate: '2026-10-17', vence_em: null, segment: null, vertical_active: null, tem_cobranca: false,
    eh_dojo: false, por_codigo: false, codigo_acesso: null,
  };
  const dados = (cadastrosOrigem) => {
    const d = fake.dadosPadrao();
    d.empresas = [
      { ...base, company_id: fake.id(1), nome: 'Loja do Google' },
      { ...base, company_id: fake.id(2), nome: 'Loja do Insta' },
      { ...base, company_id: fake.id(3), nome: 'Loja sem origem' },
    ];
    if (cadastrosOrigem) d.cadastrosOrigem = cadastrosOrigem;
    return d;
  };
  const calcular = () => cadastros.calcular({ hoje: fake.HOJE, periodo: 30, db });
  afterEach(() => db.query.mockReset());

  test('sem nenhum cadastro com origem: bloco igual ao de antes (sem coluna, serie nem indicador novo)', async () => {
    fake.ligar(db.query, dados());
    const r = await calcular();
    expect(r.detalhe.listas[0].colunas.map((c) => c.chave)).toEqual(['nome', 'criado_em', 'origem', 'frente', 'plano', 'status']);
    expect(r.detalhe.series.map((s) => s.titulo)).toEqual(['Cadastros por semana', 'Origem · 30 dias', 'Frente escolhida']);
    expect(r.detalhe.indicadores).toHaveLength(3);
    expect(r.lista[0]).not.toHaveProperty('fonte');
  });

  test('com origem do site: ganha colunas Fonte/Campanha, series e o indicador; o que existia fica', async () => {
    fake.ligar(db.query, dados([
      { company_id: fake.id(1), utm_source: 'google', utm_campaign: 'otica-outubro', referrer: 'www.google.com' },
      { company_id: fake.id(2), utm_source: null, utm_campaign: null, referrer: 'l.instagram.com' },
    ]));
    const r = await calcular();
    const linhas = r.lista;
    const por = (nome) => linhas.find((l) => l.nome === nome);
    expect(por('Loja do Google')).toMatchObject({ fonte: 'google', campanha: 'otica-outubro', origem: 'Site (self-service)' });
    expect(por('Loja do Insta')).toMatchObject({ fonte: 'l.instagram.com', campanha: '—' });
    expect(por('Loja sem origem')).toMatchObject({ fonte: '—', campanha: '—' });
    expect(r.detalhe.listas[0].colunas.map((c) => c.chave)).toEqual(
      ['nome', 'criado_em', 'origem', 'frente', 'plano', 'status', 'fonte', 'campanha']
    );
    const fontes = r.detalhe.series.find((s) => s.titulo.startsWith('Fonte do site')).pontos;
    expect(fontes).toEqual(expect.arrayContaining([{ rotulo: 'google', valor: 1 }, { rotulo: 'l.instagram.com', valor: 1 }]));
    expect(r.detalhe.series.find((s) => s.titulo.startsWith('Campanha')).pontos).toEqual([{ rotulo: 'otica-outubro', valor: 1 }]);
    expect(r.detalhe.indicadores.find((i) => i.rotulo === 'Com origem do site').valor).toBe(2);
    // o que ja existia continua
    expect(r.detalhe.series.some((s) => s.titulo.startsWith('Origem ·'))).toBe(true);
    expect(r.detalhe.indicadores.find((i) => i.rotulo === 'Em 30 dias').valor).toBe(3);
  });

  test('coluna signup_origin ainda nao existe (42703): o bloco sai sem a origem, sem cair', async () => {
    const d = dados();
    fake.ligar(db.query, d);
    const original = db.query.getMockImplementation();
    db.query.mockImplementation((sql, params) => {
      if (String(sql).includes('-- cadastros:origem')) {
        return Promise.reject(Object.assign(new Error('column c.signup_origin does not exist'), { code: '42703' }));
      }
      return original(sql, params);
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await calcular();
    expect(r.detalhe.listas[0].colunas).toHaveLength(6);
    expect(r.detalhe.indicadores).toHaveLength(3);
    console.warn.mockRestore();
  });
});
