// ============================================================
// AURA. — Conexão nova do WhatsApp: causas, perfil, progresso, pós-conexão
// e link por e-mail. Sem rede e sem banco (db e Meta são falsos).
// ============================================================
'use strict';

jest.mock('../src/config/database');
const db = require('../src/config/database');
const { causaDoErro } = require('../src/services/waConexao/causas');
const { montarPerfil, aplicarPerfil } = require('../src/services/waConexao/perfil');
const progresso = require('../src/services/waConexao/progresso');
const pos = require('../src/services/waConexao/posConexao');
const link = require('../src/services/waConexao/linkPorEmail');

afterEach(() => { if (db.query.mockReset) db.query.mockReset(); });

describe('causaDoErro', () => {
  const erro = (message, meta, httpStatus) => Object.assign(new Error(message), { meta, httpStatus });
  it('token vencido (190) vira conexao_caiu e leva o código', () => {
    expect(causaDoErro(erro('Error validating access token', { code: 190 }))).toEqual({ causa: 'conexao_caiu', codigo: 'meta-190' });
  });
  it('número em uso em outro lugar', () => {
    expect(causaDoErro(erro('Phone number is already registered with another provider', { code: 133005 })).causa).toBe('numero_em_outro_sistema');
  });
  it('sem permissão na página/portfólio', () => {
    expect(causaDoErro(erro('(#200) User does not have permission', { code: 200 })).causa).toBe('facebook_sem_pagina');
  });
  it('desconhecido vira outro, com código http', () => {
    expect(causaDoErro(erro('boom', null, 502))).toEqual({ causa: 'outro', codigo: 'http-502' });
  });
});

describe('montarPerfil', () => {
  it('usa só o que o cadastro tem', () => {
    const p = montarPerfil({
      trade_name: 'Lume Moda', email: 'contato@lumemoda.com.br', website: 'https://lumemoda.com.br',
      address_street: 'Rua Augusta', address_number: '1200', address_city: 'São Paulo', address_state: 'sp', address_zip: '01304-001',
    });
    expect(p.websites).toEqual(['https://lumemoda.com.br']);
    expect(p.address).toBe('Rua Augusta, 1200, São Paulo - SP, CEP 01304-001');
    expect(p.email).toBe('contato@lumemoda.com.br');
    expect(p.description).toContain('Lume Moda');
  });
  it('site inválido e e-mail ruim ficam de fora', () => {
    const p = montarPerfil({ trade_name: 'X', email: 'nao-e-email', website: 'lojax' });
    expect(p.websites).toBeUndefined();
    expect(p.email).toBeUndefined();
  });
  it('cadastro vazio não inventa nada', () => {
    expect(montarPerfil({})).toEqual({});
  });
});

describe('aplicarPerfil', () => {
  it('manda o perfil e a foto; foto que falha não derruba o resto', async () => {
    db.query.mockResolvedValue({ rows: [{ c: { trade_name: 'Lume', logo_url: 'https://x/logo.png' } }] });
    const wa = { uploadProfilePictureHandle: jest.fn().mockRejectedValue(new Error('x')), updateBusinessProfile: jest.fn().mockResolvedValue({ success: true }) };
    const fetch = jest.fn().mockResolvedValue({ ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    const r = await aplicarPerfil('c1', { phoneNumberId: 'p1', accessToken: 't' }, { wa, fetch });
    expect(r.foto).toBe(false);
    expect(wa.updateBusinessProfile).toHaveBeenCalledWith('p1', 't', expect.objectContaining({ about: 'Lume' }));
  });
  it('com foto, leva o handle', async () => {
    db.query.mockResolvedValue({ rows: [{ c: { trade_name: 'Lume', logo_url: 'https://x/logo.png' } }] });
    const wa = { uploadProfilePictureHandle: jest.fn().mockResolvedValue('H1'), updateBusinessProfile: jest.fn().mockResolvedValue({}) };
    const fetch = jest.fn().mockResolvedValue({ ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => new Uint8Array([1]).buffer });
    const r = await aplicarPerfil('c1', { phoneNumberId: 'p1', accessToken: 't' }, { wa, fetch });
    expect(r.foto).toBe(true);
    expect(r.campos).toEqual(['foto', 'nome']);
    expect(wa.updateBusinessProfile.mock.calls[0][2].profile_picture_handle).toBe('H1');
  });
});

describe('lerProgresso', () => {
  it('sem eventos: tudo pendente, não concluído', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const r = await progresso.lerProgresso('c1');
    expect(r.itens.map((i) => i.estado)).toEqual(['pendente', 'pendente', 'pendente', 'pendente']);
    expect(r.concluido).toBe(false);
  });
  it('tudo ok ou erro: concluído; pronto se algum ok', async () => {
    db.query.mockResolvedValue({ rows: [
      { item: 'numero', estado: 'ok' }, { item: 'eventos', estado: 'ok' },
      { item: 'perfil', estado: 'erro', causa: 'outro', codigo: 'meta-100' }, { item: 'modelos', estado: 'ok' },
    ] });
    const r = await progresso.lerProgresso('c1');
    expect(r.concluido).toBe(true);
    expect(r.pronto).toBe(true);
    expect(r.itens.find((i) => i.item === 'perfil')).toEqual({ item: 'perfil', estado: 'erro', causa: 'outro', codigo: 'meta-100' });
  });
  it('indisponivel conta como concluído e leva os campos postos', async () => {
    db.query.mockResolvedValue({ rows: [
      { item: 'numero', estado: 'ok' }, { item: 'eventos', estado: 'ok' },
      { item: 'perfil', estado: 'indisponivel', causa: 'outro', codigo: 'meta-100' }, { item: 'modelos', estado: 'ok', campos: null },
    ] });
    const r = await progresso.lerProgresso('c1');
    expect(r.concluido).toBe(true);
    expect(r.itens.find((i) => i.item === 'perfil').estado).toBe('indisponivel');
  });
  it('tabela ausente não derruba', async () => {
    db.query.mockRejectedValue(Object.assign(new Error('x'), { code: '42P01' }));
    const r = await progresso.lerProgresso('c1');
    expect(r.concluido).toBe(false);
  });
});

describe('posConexao.executar', () => {
  function eventos() {
    const itens = {};
    db.query.mockImplementation((sql, params) => {
      if (String(sql).includes('INSERT INTO audit_log')) {
        const md = JSON.parse(params[4]);
        if (md.item) itens[md.item] = md.estado;
      }
      return Promise.resolve({ rows: [] });
    });
    return itens;
  }
  it('perfil falha, os outros seguem', async () => {
    const itens = eventos();
    const r = await pos.executar('c1', { registered: true, subscribed: true, wabaId: 'w', phoneNumberId: 'p', accessToken: 't' }, {
      perfil: { aplicarPerfil: jest.fn().mockRejectedValue(Object.assign(new Error('nope'), { meta: { code: 100 } })) },
      modelos: () => ({ prepararPadroesSeguro: jest.fn().mockResolvedValue({ ok: true }) }),
    });
    expect(itens).toEqual({ numero: 'ok', eventos: 'ok', perfil: 'erro', modelos: 'ok' });
    expect(r.okPerfil).toBe(false);
    expect(r.okModelos).toBe(true);
  });
  it('coexistência: a Meta recusa o perfil -> indisponivel (neutro), os outros seguem', async () => {
    const itens = eventos();
    const r = await pos.executar('c1', { registered: true, subscribed: true, coexistence: true, wabaId: 'w', phoneNumberId: 'p', accessToken: 't' }, {
      perfil: { aplicarPerfil: jest.fn().mockRejectedValue(Object.assign(new Error('not allowed'), { meta: { code: 100 } })) },
      modelos: () => ({ prepararPadroesSeguro: jest.fn().mockResolvedValue({ ok: true }) }),
    });
    expect(itens.perfil).toBe('indisponivel');
    expect(itens.modelos).toBe('ok');
    expect(r.okPerfil).toBe(true);
  });
  it('fora da coexistência, a mesma recusa continua sendo erro', async () => {
    const itens = eventos();
    await pos.executar('c1', { registered: true, subscribed: true, coexistence: false, wabaId: 'w', phoneNumberId: 'p', accessToken: 't' }, {
      perfil: { aplicarPerfil: jest.fn().mockRejectedValue(Object.assign(new Error('x'), { meta: { code: 100 } })) },
      modelos: () => ({ prepararPadroesSeguro: jest.fn().mockResolvedValue({ ok: true }) }),
    });
    expect(itens.perfil).toBe('erro');
  });
  it('número não registrado: marca erro e não prepara modelos', async () => {
    const itens = eventos();
    const prepararPadroesSeguro = jest.fn();
    await pos.executar('c1', { registered: false, subscribed: true, wabaId: 'w', phoneNumberId: 'p', accessToken: 't' }, {
      perfil: { aplicarPerfil: jest.fn().mockResolvedValue({}) },
      modelos: () => ({ prepararPadroesSeguro }),
    });
    expect(itens.numero).toBe('erro');
    expect(itens.modelos).toBe('erro');
    expect(prepararPadroesSeguro).not.toHaveBeenCalled();
  });
});

describe('linkPorEmail', () => {
  it('manda só para o e-mail de quem está logado, com o link da tela', async () => {
    const dbx = { query: jest.fn().mockResolvedValue({ rows: [{ email: 'dona@loja.com' }] }) };
    const enviarRegistrado = jest.fn().mockResolvedValue({ status: 'sent' });
    const r = await link.enviar('c1', 'u1', { db: dbx, enviarRegistrado });
    expect(r.enviado).toBe(true);
    const arg = enviarRegistrado.mock.calls[0][0];
    expect(arg.to).toBe('dona@loja.com');
    expect(arg.text).toContain('/whatsapp');
    expect(arg.tipo).toBe('wa_conexao_link');
  });
  it('sem e-mail: não manda', async () => {
    const dbx = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const r = await link.enviar('c1', 'u1', { db: dbx, enviarRegistrado: jest.fn() });
    expect(r.enviado).toBe(false);
  });
});
