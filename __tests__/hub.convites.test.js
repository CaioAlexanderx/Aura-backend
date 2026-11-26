// ============================================================
// AURA — WhatsApp · Conversas: conversa FECHADA e convites
//
//  (1) catálogo: 4 convites UTILITY; o corpo do modelo na Meta nasce com
//      {{1}}..{{n}} na ordem do texto, sem variável no começo nem no fim.
//  (2) listar: estado de cada modelo, campos, saldo de avisos, wa.me da loja.
//  (3) enviar: INSERT na fila + reserva de 1 aviso NA MESMA transação;
//      sem saldo, nada entra na fila; conversa aberta e modelo não aprovado
//      barram; duplo clique não gasta dois; sem o módulo de saldo, bloqueia.
//  (4) preparar: só dono/admin; cria só os modelos que faltam.
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/services/whatsapp', () => ({ createTemplate: jest.fn(), graphPost: jest.fn() }));
jest.mock('../src/services/hubWhatsapp', () => ({ marcarRespostaHumana: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/services/waOutbox', () => ({
  decryptToken: (t) => t,
  normalizePhone: (p) => String(p || '').replace(/\D+/g, '') || null,
  windowOpenAt: (d) => !!(d && Date.now() - new Date(d).getTime() < 24 * 3600000),
  getContact: jest.fn().mockResolvedValue(null),
  loadPauseReason: jest.fn().mockResolvedValue(null),
  applyTemplateStatus: jest.fn().mockResolvedValue(undefined),
}));
const mockSaldo = { reservar: jest.fn(), getSaldos: jest.fn() };
jest.mock('../src/services/waSaldo', () => mockSaldo, { virtual: true });

const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const wa = require('../src/services/whatsapp');
const waOutbox = require('../src/services/waOutbox');
const hubWhatsapp = require('../src/services/hubWhatsapp');
const convites = require('../src/services/hubConvites');

const COMPANY = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const horas = (h) => new Date(Date.now() - h * 3600000).toISOString();

function app(role = 'owner') {
  const a = express();
  a.use(express.json());
  a.use('/companies/:id/hub', (req, _res, next) => { req.user = { id: 'user-1' }; req.companyRole = role; next(); },
    require('../src/routes/hubSocialConvites'));
  return a;
}

let conversa;
let loja;
let modelos;
let client;
let inserts;
let eventos;

beforeEach(() => {
  db.query.mockReset();
  wa.createTemplate.mockReset().mockResolvedValue({ id: 'm1', status: 'PENDING' });
  waOutbox.applyTemplateStatus.mockClear();
  waOutbox.getContact.mockReset().mockResolvedValue(null);
  waOutbox.loadPauseReason.mockReset().mockResolvedValue(null);
  hubWhatsapp.marcarRespostaHumana.mockClear();
  mockSaldo.reservar.mockReset().mockResolvedValue({ ok: true, fonte: 'franquia', restante: 71, baixo: false });
  mockSaldo.getSaldos.mockReset().mockResolvedValue({
    ativo: true, mes: '2026-11',
    saldos: { avisos: { restante: 72, total: 100, esgotado: false, renova_em: '2026-12-01', pacote: { qty: 200, preco_centavos: 1900 } } },
  });
  conversa = { id: CONV, channel: 'whatsapp', external_id: '5511988887777', last_inbound_at: horas(40), nome: 'Bia Torres' };
  loja = { trade_name: 'Lume Moda', legal_name: 'Lume LTDA', wa_phone_display: '+55 11 98765-0000', wa_waba_id: 'WABA1', has_token: true };
  modelos = [{ name: 'aura_convite_chegou', status: 'APPROVED' }];
  inserts = [];
  eventos = [];
  client = {
    query: jest.fn(async (sql, params) => {
      const s = String(sql);
      eventos.push(s.trim().split('\n')[0].slice(0, 40));
      if (s.includes('hubconvite:enfileira')) {
        inserts.push(params);
        return { rows: inserts.length > 1 && params[9] === inserts[0][9] ? [] : [{ id: params[0] }] };
      }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  db.connect.mockReset().mockResolvedValue(client);
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (s.includes('hubconvite:conv')) return Promise.resolve({ rows: params[1] === COMPANY ? [conversa] : [] });
    if (s.includes('hubconvite:loja')) return Promise.resolve({ rows: [loja] });
    if (s.includes('hubconvite:modelos')) return Promise.resolve({ rows: modelos });
    if (s.includes('SELECT wa_access_token')) return Promise.resolve({ rows: [{ wa_access_token: 'tok' }] });
    return Promise.resolve({ rows: [] });
  });
});

describe('catálogo', () => {
  it('4 convites UTILITY com template aura_convite_<chave>', () => {
    expect(convites.CATALOGO.map((c) => c.key)).toEqual(['chegou', 'orcamento', 'retirada', 'pagamento']);
    convites.CATALOGO.forEach((c) => {
      expect(c.categoria).toBe('UTILITY');
      expect(c.template).toBe(`aura_convite_${c.key}`);
    });
  });

  it('o corpo na Meta usa {{1}}..{{n}} na ordem do texto e nenhum modelo começa ou termina em variável', () => {
    for (const c of convites.CATALOGO) {
      const { texto, exemplos } = convites.corpoDoModelo(c);
      const n = (texto.match(/\{\{\d+\}\}/g) || []).length;
      expect(exemplos).toHaveLength(n);
      for (let i = 1; i <= n; i++) expect(texto).toContain(`{{${i}}}`);
      expect(texto.indexOf('{{1}}')).toBeGreaterThan(0);
      expect(texto.trim().endsWith('}}')).toBe(false);
      expect(texto).not.toMatch(/\}\}\{\{/);
      expect(texto.length).toBeLessThanOrEqual(1024);
    }
  });

  it('um campo repetido vira o mesmo número só uma vez e o texto final usa os valores', () => {
    const c = convites.porChave('chegou');
    const { valores } = convites.validarCampos(c, { produto: 'o cinto de couro em preto', ate: 'sábado' }, { nome: 'Bia', loja: 'Lume Moda' });
    expect(convites.montarTexto(c, valores)).toBe(
      'Oi, Bia. Chegou o cinto de couro em preto que você perguntou na Lume Moda. Guardo um para você até sábado. Para falar com a gente, é só responder esta mensagem.');
  });

  it('campo vazio, comprido ou com quebra de linha', () => {
    const c = convites.porChave('chegou');
    const auto = { nome: 'Bia', loja: 'Lume' };
    expect(() => convites.validarCampos(c, { produto: '  ', ate: 'sábado' }, auto)).toThrow(/Produto/);
    expect(() => convites.validarCampos(c, { produto: 'x'.repeat(61), ate: 'sábado' }, auto)).toThrow(/no máximo 60/);
    const { valores } = convites.validarCampos(c, { produto: 'um\n\n cinto\t  preto', ate: 'sábado' }, auto);
    expect(valores.produto).toBe('um cinto preto');
  });

  it('a lojista não consegue trocar o nome do cliente nem o da loja (campos automáticos)', () => {
    const c = convites.porChave('chegou');
    const { valores } = convites.validarCampos(c, { produto: 'o cinto', ate: 'sábado', nome: 'HACK', loja: 'HACK' }, { nome: 'Bia', loja: 'Lume Moda' });
    expect(valores.nome).toBe('Bia');
    expect(valores.loja).toBe('Lume Moda');
  });

  it('meuLink monta o wa.me do número da loja', () => {
    expect(convites.meuLink({ wa_phone_display: '+55 11 98765-0000' })).toBe('https://wa.me/5511987650000');
    expect(convites.meuLink({ wa_phone_display: '(11) 98765-0000' })).toBe('https://wa.me/5511987650000');
    expect(convites.meuLink({ wa_phone_display: null })).toBeNull();
  });
});

describe('GET convites', () => {
  it('traz estado de cada modelo, campos, saldo e o link da loja', async () => {
    const res = await request(app()).get(`/companies/${COMPANY}/hub/conversations/${CONV}/convites`);
    expect(res.status).toBe(200);
    expect(res.body.aberta).toBe(false);
    expect(res.body.conectado).toBe(true);
    expect(res.body.meu_link).toBe('https://wa.me/5511987650000');
    expect(res.body.auto).toEqual({ nome: 'Bia', loja: 'Lume Moda' });
    expect(res.body.saldo).toMatchObject({ restante: 72, total: 100, esgotado: false });
    const por = Object.fromEntries(res.body.convites.map((c) => [c.key, c]));
    expect(por.chegou).toMatchObject({ estado: 'APPROVED', pronto: true });
    expect(por.orcamento).toMatchObject({ estado: 'NAO_CRIADO', pronto: false });
    expect(por.chegou.campos.map((f) => f.key)).toEqual(['nome', 'produto', 'loja', 'ate']);
    expect(por.chegou.campos.find((f) => f.key === 'nome').auto).toBe(true);
  });

  it('sem módulo de saldo o saldo vem null (a tela mostra só "Usa 1 aviso")', async () => {
    mockSaldo.getSaldos.mockRejectedValue(new Error('x'));
    const res = await request(app()).get(`/companies/${COMPANY}/hub/conversations/${CONV}/convites`);
    expect(res.body.saldo).toBeNull();
  });

  it('conversa de outra loja → 404', async () => {
    const res = await request(app()).get(`/companies/99999999-9999-4999-8999-999999999999/hub/conversations/${CONV}/convites`);
    expect(res.status).toBe(404);
  });
});

describe('POST convite', () => {
  const enviar = (body = { key: 'chegou', campos: { produto: 'o cinto de couro em preto', ate: 'sábado' } }) =>
    request(app()).post(`/companies/${COMPANY}/hub/conversations/${CONV}/convites`).send(body);

  it('enfileira o modelo com os parâmetros na ordem e reserva 1 aviso na MESMA transação', async () => {
    const res = await enviar();
    expect(res.status).toBe(200);
    const ordem = eventos.map((e) => e.replace(/\s+/g, ' '));
    expect(ordem[0]).toBe('BEGIN');
    const iInsert = eventos.findIndex((e) => e.includes('hubconvite:enfileira'));
    const iCommit = eventos.indexOf('COMMIT');
    expect(iInsert).toBeGreaterThan(0);
    expect(iCommit).toBeGreaterThan(iInsert);
    expect(mockSaldo.reservar).toHaveBeenCalledTimes(1);
    const [runner, opts] = mockSaldo.reservar.mock.calls[0];
    expect(runner).toBe(client);
    expect(opts).toMatchObject({ companyId: COMPANY, bucket: 'avisos', conversaId: CONV });
    expect(opts.refKey).toMatch(new RegExp(`^convite:${CONV}:chegou:\\d{4}-\\d{2}-\\d{2}$`));
    const p = inserts[0];
    expect(p[3]).toBe('aura_convite_chegou');
    expect(p[4]).toBe('pt_BR');
    expect(JSON.parse(p[5])[0].parameters.map((x) => x.text)).toEqual(['Bia', 'o cinto de couro em preto', 'Lume Moda', 'sábado']);
    expect(p[6]).toContain('Oi, Bia. Chegou o cinto de couro em preto');
    expect(eventos).not.toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
    expect(hubWhatsapp.marcarRespostaHumana).toHaveBeenCalledWith(COMPANY, CONV, 'user-1');
  });

  it('sem saldo: ROLLBACK, nada entra na fila e a resposta diz que acabou', async () => {
    mockSaldo.reservar.mockResolvedValue({ ok: false, code: 'SALDO_ESGOTADO', restante: 0, renova_em: '2026-12-01' });
    const res = await enviar();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SALDO_ESGOTADO');
    expect(eventos).toContain('ROLLBACK');
    expect(eventos).not.toContain('COMMIT');
    expect(hubWhatsapp.marcarRespostaHumana).not.toHaveBeenCalled();
  });

  it('erro ao ler o saldo bloqueia (na dúvida, bloqueia)', async () => {
    mockSaldo.reservar.mockResolvedValue({ ok: false, code: 'SALDO_INDISPONIVEL' });
    const res = await enviar();
    expect(res.status).toBe(503);
    expect(eventos).toContain('ROLLBACK');
  });

  it('conversa ABERTA: não gasta aviso, manda responder direto', async () => {
    conversa.last_inbound_at = horas(2);
    const res = await enviar();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONVERSA_ABERTA');
    expect(db.connect).not.toHaveBeenCalled();
    expect(mockSaldo.reservar).not.toHaveBeenCalled();
  });

  it('modelo ainda não aprovado pelo WhatsApp: não sai', async () => {
    const res = await enviar({ key: 'orcamento', campos: { valor: 'R$ 10', ate: '03/12' } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('MODELO_NAO_APROVADO');
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('campo faltando → 422 e nada é reservado', async () => {
    const res = await enviar({ key: 'chegou', campos: { produto: 'o cinto' } });
    expect(res.status).toBe(422);
    expect(res.body.campo).toBe('ate');
    expect(db.connect).not.toHaveBeenCalled();
  });

  it('convite desconhecido → 404', async () => {
    const res = await enviar({ key: 'promo', campos: {} });
    expect(res.status).toBe(404);
  });

  it('duplo clique no mesmo dia: o segundo não entra na fila nem gasta aviso', async () => {
    expect((await enviar()).status).toBe(200);
    mockSaldo.reservar.mockClear();
    const dois = await enviar();
    expect(dois.status).toBe(409);
    expect(dois.body.code).toBe('CONVITE_REPETIDO');
    expect(mockSaldo.reservar).not.toHaveBeenCalled();
    expect(eventos).toContain('ROLLBACK');
  });

  it('número em atenção (qualidade) NÃO barra aviso; conta restrita barra', async () => {
    waOutbox.loadPauseReason.mockResolvedValue('QUALIDADE_BAIXA');
    expect((await enviar()).status).toBe(200);
    waOutbox.loadPauseReason.mockResolvedValue('CONTA_RESTRITA');
    const res = await enviar();
    expect(res.body.code).toBe('PAUSADO');
  });

  it('número recusado pela Meta barra', async () => {
    waOutbox.getContact.mockResolvedValue({ invalid_at: new Date().toISOString() });
    expect((await enviar()).body.code).toBe('TELEFONE_INVALIDO_META');
  });

  it('WhatsApp desconectado barra', async () => {
    loja.has_token = false;
    expect((await enviar()).body.code).toBe('NAO_CONECTADO');
  });

  it('sem o módulo de saldo neste servidor: bloqueia, sem abrir transação', async () => {
    const reservar = mockSaldo.reservar;
    mockSaldo.reservar = undefined; // o servidor ainda não tem o saldo do agente A
    try {
      const res = await enviar();
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('SALDO_INDISPONIVEL');
      expect(db.connect).not.toHaveBeenCalled();
    } finally {
      mockSaldo.reservar = reservar;
    }
  });
});

describe('preparar modelos', () => {
  it('cria só os que faltam, como UTILITY, com exemplos', async () => {
    const res = await request(app()).post(`/companies/${COMPANY}/hub/convites/preparar`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ criados: 3, ja_existiam: 1 });
    expect(wa.createTemplate).toHaveBeenCalledTimes(3);
    const [waba, token, corpo] = wa.createTemplate.mock.calls[0];
    expect([waba, token]).toEqual(['WABA1', 'tok']);
    expect(corpo).toMatchObject({ name: 'aura_convite_orcamento', language: 'pt_BR', category: 'UTILITY' });
    expect(corpo.components[0].example.body_text[0]).toHaveLength(4);
    expect(waOutbox.applyTemplateStatus).toHaveBeenCalledTimes(3);
  });

  it('só dono ou admin', async () => {
    const res = await request(app('employee')).post(`/companies/${COMPANY}/hub/convites/preparar`).send({});
    expect(res.status).toBe(403);
    expect(wa.createTemplate).not.toHaveBeenCalled();
  });

  it('a Meta recusa → 502 legível', async () => {
    wa.createTemplate.mockRejectedValue(new Error('x'));
    const res = await request(app()).post(`/companies/${COMPANY}/hub/convites/preparar`).send({});
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('META_RECUSOU');
  });
});
