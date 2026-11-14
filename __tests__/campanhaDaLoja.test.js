// ============================================================
// Campanha de Black Friday da loja online (p-118, 14/11/2026)
//
// Banco de mentira: as regras puras, a ligacao das rotas e o payload da
// vitrine. A conta do resumo no Postgres de verdade (visibilidade do grupo,
// variante, agendada, vencida, arredondamento) esta em
// campanhaDaLoja.banco.test.js.
//
// O que mais importa: loja sem campanha e sem promocao recebe o payload
// IDENTICO ao de antes — nenhuma chave nova.
// ============================================================
'use strict';

jest.mock('../src/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireCompanyAccess: () => (req, res, next) => next(),
  requirePlan: () => (req, res, next) => next(),
  requireRole: (...roles) => (req, res, next) => (roles.includes(req.user && req.user.role)
    ? next() : res.status(403).json({ error: 'sem permissao' })),
}));
jest.mock('../src/services/cacheDaPaginaDaLoja', () => ({
  esquecerPagina: jest.fn(), lembrarPagina: jest.fn(), paginaLembrada: jest.fn(() => null),
}));
jest.mock('../src/services/mpGateway', () => ({ temGatewayAtivo: jest.fn(async () => false) }));

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const cache = require('../src/services/cacheDaPaginaDaLoja');
const campanha = require('../src/services/campanhaDaLoja');
const { buildStorefront } = require('../src/services/storefrontBuilder');

const CID = '56135b5d-defa-4225-aa2c-e6b9433c98ea';
const base = `/companies/${CID}/digital-channel/campanha`;

const erroPg = (code) => Object.assign(new Error('pg ' + code), { code });

/** Banco por SQL: [regex, rows | Error | fn(sql, params)]. */
function banco(regras) {
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params) => {
    const s = String(sql);
    for (const [re, r] of regras) {
      if (!re.test(s)) continue;
      if (r instanceof Error) throw r;
      const rows = typeof r === 'function' ? r(s, params) : r;
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
}

const RESUMO = /WITH vis AS/;
const resumo = (o) => [{ no_ar: 0, agendadas: 0, ate_pct: 0, ate_data: null, comeca_em: null, ...o }];
const CONFIG = {
  company_id: CID, slug: 'boutique', is_published: true, site_name: 'Boutique Aurora',
  require_product_image: false, show_prices: true, bf_ativa: false, bf_titulo: 'black_friday',
};

let papel = 'client';
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 'u1', role: papel }; next(); });
app.use('/companies/:id', require('../src/routes/private'));

beforeEach(() => {
  papel = 'client';
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  banco([]);
});
afterEach(() => jest.restoreAllMocks());

describe('regras puras', () => {
  test('os tres titulos, com o nome da loja no segundo', () => {
    expect(campanha.opcoesDeTitulo('Boutique Aurora')).toEqual([
      { id: 'black_friday', texto: 'Black Friday' },
      { id: 'black_friday_da_loja', texto: 'Black Friday da Boutique Aurora' },
      { id: 'ofertas_de_novembro', texto: 'Ofertas de novembro' },
    ]);
    expect(campanha.textoDoTitulo('qualquer', 'X')).toBe('Black Friday');
    expect(campanha.textoDoTitulo('black_friday_da_loja', '')).toBe('Black Friday');
  });

  test('periodo padrao: 27/11 a 30/11 do ano em Brasilia', () => {
    expect(campanha.periodoPadrao(new Date('2026-11-14T12:00:00Z'))).toEqual({ inicio: '2026-11-27', fim: '2026-11-30' });
    // 31/12 as 23h em Brasilia ainda e 2026.
    expect(campanha.periodoPadrao(new Date('2027-01-01T02:00:00Z'))).toEqual({ inicio: '2026-11-27', fim: '2026-11-30' });
  });

  test('payload: nada sem promocao no ar, mesmo com a campanha ligada', () => {
    expect(campanha.chavesDoPayload(CONFIG, campanha.SEM_PROMOCAO, 'X')).toEqual({});
    expect(campanha.chavesDoPayload({ ...CONFIG, bf_ativa: true }, { ...campanha.SEM_PROMOCAO, agendadas: 3 }, 'X')).toEqual({});
    expect(campanha.chavesDoPayload(null, null, 'X')).toEqual({});
  });

  test('payload: promocao no ar sem campanha = so tem_promocao', () => {
    expect(campanha.chavesDoPayload(CONFIG, { no_ar: 2, agendadas: 0, ate_pct: 30, ate_data: '2026-11-30' }, 'X'))
      .toEqual({ tem_promocao: true });
  });

  test('payload: campanha ligada e promocao no ar = campanha calculada no servidor', () => {
    const c = { ...CONFIG, bf_ativa: true, bf_titulo: 'black_friday_da_loja' };
    expect(campanha.chavesDoPayload(c, { no_ar: 42, agendadas: 0, ate_pct: 40, ate_data: '2026-11-30' }, 'Boutique Aurora'))
      .toEqual({
        tem_promocao: true,
        campanha: { ativa: true, titulo: 'Black Friday da Boutique Aurora', ate_pct: 40, ate_data: '2026-11-30' },
      });
  });

  test('painel: no ar, agendada e desligada', () => {
    const ligada = { ...CONFIG, bf_ativa: true };
    const noAr = campanha.estadoParaOPainel(ligada, { no_ar: 3, agendadas: 0, ate_pct: 30, ate_data: '2026-11-30', comeca_em: null }, 'B');
    expect(noAr).toMatchObject({ ativa: true, no_ar: true, agendada: false, pode_ligar: true });
    const agend = campanha.estadoParaOPainel(ligada, { no_ar: 0, agendadas: 3, ate_pct: 0, ate_data: null, comeca_em: '2026-11-27' }, 'B');
    expect(agend).toMatchObject({ ativa: true, no_ar: false, agendada: true, pode_ligar: true });
    const nada = campanha.estadoParaOPainel(CONFIG, campanha.SEM_PROMOCAO, 'B');
    expect(nada).toMatchObject({ ativa: false, no_ar: false, agendada: false, pode_ligar: false });
    expect(campanha.estadoParaOPainel(null, campanha.SEM_PROMOCAO, 'B').loja_online).toEqual({ existe: false, publicada: false, slug: null });
  });

  test('resumo: o SQL usa a visibilidade da grade, arredonda para baixo e recebe o agora', async () => {
    banco([[RESUMO, (s, p) => { expect(p).toEqual([CID, '2026-11-28T12:00:00.000Z']); return resumo({ no_ar: '2', ate_pct: '30', ate_data: '2026-11-30' }); }]]);
    const r = await campanha.resumoDasPromocoes({ cid: CID, visibilidade: '(company_id = $1)', agora: new Date('2026-11-28T12:00:00Z') });
    expect(r).toEqual({ no_ar: 2, agendadas: 0, ate_pct: 30, ate_data: '2026-11-30', comeca_em: null });
    const sql = campanha.sqlDoResumo('(company_id = $1)', false);
    expect(sql).toContain('FLOOR((1 - promo / base) * 100)');
    expect(sql).toContain('dcv.featured_product_ids');
    expect(sql).toContain('v.stock_qty > 0');
  });

  test('resumo: base sem as colunas de promocao = sem promocao; outro erro sobe', async () => {
    banco([[RESUMO, erroPg('42703')]]);
    await expect(campanha.resumoDasPromocoes({ cid: CID, visibilidade: 'TRUE' })).resolves.toEqual(campanha.SEM_PROMOCAO);
    banco([[RESUMO, erroPg('57014')]]);
    await expect(campanha.resumoDasPromocoes({ cid: CID, visibilidade: 'TRUE' })).rejects.toThrow('57014');
  });
});

describe('payload da vitrine (buildStorefront)', () => {
  const PRODUTO = { id: 'p-1', name: 'Vestido', description: null, price: '100.00', image_url: null, category: 'V', stock_qty: 3, created_at: '2026-08-01T00:00:00Z' };
  const montar = (config, r) => {
    banco([
      [/SELECT id, name, description/, [PRODUTO]],
      [RESUMO, r || resumo()],
    ]);
    return buildStorefront({ ...CONFIG, ...config });
  };

  test('sem promocao e sem campanha: nenhuma chave nova', async () => {
    const out = await montar({});
    expect(out).not.toHaveProperty('tem_promocao');
    expect(out).not.toHaveProperty('campanha');
    const ligadaSemPromo = await montar({ bf_ativa: true });
    expect(Object.keys(ligadaSemPromo)).toEqual(Object.keys(out));
  });

  test('promocao no ar no catalogo: tem_promocao; campanha ligada: campanha', async () => {
    const r = resumo({ no_ar: 5, ate_pct: 40, ate_data: '2026-11-30' });
    expect((await montar({}, r)).tem_promocao).toBe(true);
    expect((await montar({}, r)).campanha).toBeUndefined();
    const out = await montar({ bf_ativa: true, bf_titulo: 'ofertas_de_novembro' }, r);
    expect(out.campanha).toEqual({ ativa: true, titulo: 'Ofertas de novembro', ate_pct: 40, ate_data: '2026-11-30' });
  });

  test('loja que esconde os precos nem pergunta', async () => {
    const out = await montar({ show_prices: false, bf_ativa: true }, resumo({ no_ar: 5, ate_pct: 40 }));
    expect(out).not.toHaveProperty('tem_promocao');
    expect(out).not.toHaveProperty('campanha');
    expect(db.query.mock.calls.some(([s]) => RESUMO.test(String(s)))).toBe(false);
  });

  test('erro no resumo: a loja abre sem a faixa', async () => {
    banco([[/SELECT id, name, description/, [PRODUTO]], [RESUMO, erroPg('57014')]]);
    const out = await buildStorefront({ ...CONFIG, bf_ativa: true });
    expect(out).not.toHaveProperty('campanha');
    expect(out.products).toHaveLength(1);
  });
});

describe('rotas /digital-channel/campanha', () => {
  const regras = (config, r, extra = []) => [
    ...extra,
    [/FROM digital_channel_config WHERE company_id/, config ? [config] : []],
    [RESUMO, r || resumo()],
  ];

  test('GET: o estado para o painel', async () => {
    banco(regras({ ...CONFIG, bf_ativa: true }, resumo({ no_ar: 3, ate_pct: 30, ate_data: '2026-11-30' })));
    const res = await request(app).get(base);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      loja_online: { existe: true, publicada: true, slug: 'boutique' },
      ativa: true, titulo: 'black_friday', no_ar: true, pode_ligar: true,
      promocoes: { no_ar: 3, ate_pct: 30, ate_data: '2026-11-30' },
    });
    expect(res.body.titulos[1].texto).toBe('Black Friday da Boutique Aurora');
  });

  test('GET sem loja online: existe false (o app esconde a secao)', async () => {
    banco(regras(null, resumo(), [[/FROM companies/, [{ nome: 'Fulana ME' }]]]));
    const res = await request(app).get(base);
    expect(res.status).toBe(200);
    expect(res.body.loja_online.existe).toBe(false);
    expect(res.body.ativa).toBe(false);
  });

  test('PUT ligar sem promocao no ar nem agendada: 409 BF_SEM_PROMOCAO, nada gravado', async () => {
    banco(regras(CONFIG, resumo()));
    const res = await request(app).put(base).send({ ativa: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BF_SEM_PROMOCAO');
    expect(res.body.error).toMatch(/monte antes pelo menos um desconto/);
    expect(db.query.mock.calls.some(([s]) => /UPDATE digital_channel_config/.test(String(s)))).toBe(false);
  });

  test('PUT ligar com promocao agendada: grava, esquece a home guardada e registra', async () => {
    const salvo = { ...CONFIG, bf_ativa: true, bf_titulo: 'black_friday_da_loja' };
    banco(regras(CONFIG, resumo({ agendadas: 4, comeca_em: '2026-11-27' }), [[/UPDATE digital_channel_config/, (s, p) => {
      expect(p).toEqual([CID, true, 'black_friday_da_loja']);
      return [salvo];
    }]]));
    const res = await request(app).put(base).send({ ativa: true, titulo: 'black_friday_da_loja' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ativa: true, titulo: 'black_friday_da_loja', agendada: true, no_ar: false });
    expect(cache.esquecerPagina).toHaveBeenCalledWith('boutique');
    expect(db.query.mock.calls.some(([s, p]) => /INSERT INTO audit_log/.test(String(s)) && p[2] === 'digital_channel.black_friday')).toBe(true);
  });

  test('PUT desligar ou trocar o titulo nao pede promocao', async () => {
    banco(regras({ ...CONFIG, bf_ativa: true }, resumo(), [[/UPDATE digital_channel_config/, [CONFIG]]]));
    expect((await request(app).put(base).send({ ativa: false })).status).toBe(200);
    expect((await request(app).put(base).send({ titulo: 'ofertas_de_novembro' })).status).toBe(200);
  });

  test('PUT valida o corpo', async () => {
    banco(regras(CONFIG, resumo()));
    expect((await request(app).put(base).send({ titulo: 'MEGA SALDAO' })).status).toBe(400);
    expect((await request(app).put(base).send({ ativa: 'sim' })).status).toBe(400);
    expect((await request(app).put(base).send({})).status).toBe(400);
  });

  test('PUT sem loja online: 409 SEM_LOJA_ONLINE', async () => {
    banco(regras(null, resumo()));
    const res = await request(app).put(base).send({ ativa: false });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SEM_LOJA_ONLINE');
  });

  test('migration 451 ausente: 503 MIGRATION_PENDING', async () => {
    banco([[/FROM digital_channel_config WHERE company_id/, erroPg('42703')]]);
    expect((await request(app).get(base)).body.code).toBe('MIGRATION_PENDING');
    expect((await request(app).put(base).send({ ativa: false })).status).toBe(503);
  });

  test('PUT pede o mesmo papel do PUT da loja online', async () => {
    papel = 'viewer';
    banco(regras(CONFIG, resumo()));
    expect((await request(app).put(base).send({ ativa: false })).status).toBe(403);
  });
});

// ── p-122: o texto escrito pela loja (migration 453) ─────────

describe('texto da faixa escrito pela loja (p-122)', () => {
  const rotas = require('../src/routes/campanhaDaLoja');
  beforeEach(() => rotas._resetarParaTeste());
  const titulo = (v) => campanha.normalizarTextoDaFaixa(v, { limite: 28, rotulo: 'O título da faixa' });
  const W28 = 'W'.repeat(28);
  const regras = (config, r, extra = []) => [
    ...extra,
    [/FROM digital_channel_config WHERE company_id/, config ? [config] : []],
    [RESUMO, r || resumo()],
  ];

  test('normaliza: pontas e espacos repetidos saem; vazio volta a opcao pronta', () => {
    expect(titulo('  Semana   da  Moda  ')).toEqual({ valor: 'Semana da Moda' });
    expect(titulo('   ')).toEqual({ valor: null });
    expect(titulo('')).toEqual({ valor: null });
    expect(titulo(null)).toEqual({ valor: null });
    expect(titulo(W28)).toEqual({ valor: W28 });
    expect(titulo('Ação Ótima é já, ok?')).toEqual({ valor: 'Ação Ótima é já, ok?' });
  });

  test('recusa com mensagem gentil: tamanho, "%", "R$", quebra de linha, emoji', () => {
    expect(titulo(W28 + 'W').erro).toBe('O título da faixa cabe em até 28 caracteres (agora são 29).');
    expect(titulo('Tudo 50% off').erro).toMatch(/não pode ter “%” nem “R\$”/);
    expect(titulo('Tudo por R$ 10').erro).toMatch(/não pode ter “%” nem “R\$”/);
    expect(titulo('tudo por r$10').erro).toMatch(/não pode ter/);
    expect(titulo('Linha 1\nLinha 2').erro).toBe('O título da faixa vai numa linha só: tire a quebra de linha.');
    expect(titulo('Black Friday 🔥').erro).toMatch(/não aceita emoji/);
    expect(titulo(42).erro).toMatch(/precisa ser um texto/);
    expect(campanha.normalizarTextoDaFaixa('x'.repeat(91), { limite: 90, rotulo: 'A frase da faixa grande' }).erro)
      .toBe('A frase da faixa grande cabe em até 90 caracteres (agora são 91).');
  });

  test('payload: titulo ja com o texto escrito; frase so quando escrita', () => {
    const r = { no_ar: 2, agendadas: 0, ate_pct: 30, ate_data: '2026-11-30' };
    const c = { ...CONFIG, bf_ativa: true, bf_titulo: 'ofertas_de_novembro' };
    expect(campanha.chavesDoPayload(c, r, 'X').campanha).toEqual({ ativa: true, titulo: 'Ofertas de novembro', ate_pct: 30, ate_data: '2026-11-30' });
    expect(campanha.chavesDoPayload({ ...c, bf_titulo_texto: '', bf_frase_texto: '  ' }, r, 'X').campanha).not.toHaveProperty('frase');
    expect(campanha.chavesDoPayload({ ...c, bf_titulo_texto: 'Semana Aurora', bf_frase_texto: 'Só até domingo.' }, r, 'X').campanha)
      .toEqual({ ativa: true, titulo: 'Semana Aurora', ate_pct: 30, ate_data: '2026-11-30', frase: 'Só até domingo.' });
  });

  test('painel: os textos, o titulo que a faixa mostra e os limites', () => {
    const e = campanha.estadoParaOPainel({ ...CONFIG, bf_titulo_texto: 'Semana Aurora' }, campanha.SEM_PROMOCAO, 'B');
    expect(e).toMatchObject({ titulo_texto: 'Semana Aurora', frase_texto: null, titulo_final: 'Semana Aurora', limites: { titulo: 28, frase: 90 } });
    expect(campanha.estadoParaOPainel(CONFIG, campanha.SEM_PROMOCAO, 'B').titulo_final).toBe('Black Friday');
  });

  test('PUT: texto invalido = 422 com o campo, nada gravado', async () => {
    banco(regras(CONFIG, resumo()));
    const res = await request(app).put(base).send({ titulo_texto: 'Tudo 70% OFF' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'TEXTO_DA_FAIXA_INVALIDO', campo: 'titulo_texto' });
    expect(res.body.error).toMatch(/O título da faixa não pode ter/);
    const frase = await request(app).put(base).send({ frase_texto: 'x'.repeat(91) });
    expect(frase.status).toBe(422);
    expect(frase.body.campo).toBe('frase_texto');
    expect(db.query.mock.calls.some(([s]) => /UPDATE digital_channel_config/.test(String(s)))).toBe(false);
  });

  test('PUT: grava o texto normalizado; null volta a opcao pronta; so os campos enviados', async () => {
    const updates = [];
    banco(regras(CONFIG, resumo(), [[/UPDATE digital_channel_config/, (s, p) => { updates.push([s, p]); return [{ ...CONFIG, bf_titulo_texto: p[4] }]; }]]));
    let res = await request(app).put(base).send({ titulo_texto: '  Semana   Aurora ' });
    expect(res.status).toBe(200);
    expect(updates[0][1]).toEqual([CID, null, null, true, 'Semana Aurora', false, null]);
    expect(updates[0][0]).toContain('bf_titulo_texto = CASE WHEN $4::boolean THEN $5::varchar ELSE bf_titulo_texto END');
    expect(res.body.titulo_final).toBe('Semana Aurora');
    res = await request(app).put(base).send({ titulo_texto: null, frase_texto: 'Só até domingo.' });
    expect(updates[1][1]).toEqual([CID, null, null, true, null, true, 'Só até domingo.']);
    // Sem texto no corpo, o UPDATE e o de antes (base sem a 453 continua gravando a chave).
    await request(app).put(base).send({ ativa: false });
    expect(updates[2][0]).not.toContain('bf_titulo_texto');
    expect(updates[2][1]).toEqual([CID, false, null]);
  });

  test('base sem a 453: le sem as colunas e a chave continua funcionando', async () => {
    let primeira = true;
    banco([
      [/bf_titulo_texto, bf_frase_texto/, () => { if (primeira) { primeira = false; throw erroPg('42703'); } return []; }],
      ...regras({ ...CONFIG, bf_ativa: true }, resumo({ no_ar: 1, ate_pct: 10 })),
    ]);
    const res = await request(app).get(base);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ativa: true, titulo_texto: null, titulo_final: 'Black Friday' });
  });
});
