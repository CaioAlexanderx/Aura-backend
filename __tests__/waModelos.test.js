// ============================================================
// AURA — WhatsApp: modelos editáveis (tela nova, 26/11/2026)
// Prova: validação do Editor, texto novo só vale depois de aprovado,
// limite de edição da Meta (1/24h, 10/30d), restaurar, sino.
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/services/whatsapp', () => ({ createTemplate: jest.fn() }));
jest.mock('../src/services/lojaEvents', () => ({ emitLojaEvent: jest.fn().mockResolvedValue({ id: 'n1' }) }));

const db = require('../src/config/database');
const wa = require('../src/services/whatsapp');
const lojaEvents = require('../src/services/lojaEvents');
const catalogo = require('../src/services/waAutomaticas/modelos');
const store = require('../src/services/waAutomaticas/modelosStore');

const COMPANY = '11111111-1111-1111-1111-111111111111';
const antes = catalogo.obter('cred_antes');
const oferta = catalogo.obter('cred_oferta');
const checkDe = (r, id) => r.checks.find((c) => c.id === id);

describe('catálogo', () => {
  test('são 16 modelos, cada um com template_base único e categoria certa', () => {
    expect(catalogo.MODELOS).toHaveLength(16);
    expect(new Set(catalogo.MODELOS.map((m) => m.template_base)).size).toBe(16);
    const util = catalogo.MODELOS.filter((m) => m.categoria === 'UTILITY').map((m) => m.key);
    expect(util.sort()).toEqual(['cred_antes', 'cred_atraso', 'cred_dia']);
  });

  test('todo texto padrão passa na própria validação', () => {
    for (const m of catalogo.MODELOS) {
      const r = catalogo.validar(m, m.texto_padrao);
      expect({ key: m.key, ok: r.ok, falhas: r.checks.filter((c) => !c.ok) }).toEqual({ key: m.key, ok: true, falhas: [] });
    }
  });
});

describe('validação do Editor', () => {
  test('termina em campo: barra e sugere ponto final', () => {
    const r = catalogo.validar(antes, 'Oi, {Nome}. Sua parcela vence {Vencimento}: {Valor}');
    expect(r.ok).toBe(false);
    expect(checkDe(r, 'termina')).toMatchObject({ ok: false, correcao: 'PONTO_FINAL' });
  });

  test('começa em campo: barra', () => {
    expect(checkDe(catalogo.validar(antes, '{Nome}, sua parcela vence hoje.'), 'comeca').ok).toBe(false);
  });

  test('dois campos colados: barra e sugere separar; com palavra no meio passa', () => {
    const colado = catalogo.validar(antes, 'Oi, {Nome}. Parcela {Parcela}{Valor} vence hoje.');
    expect(checkDe(colado, 'colados')).toMatchObject({ ok: false, correcao: 'SEPARAR' });
    const ok = catalogo.validar(antes, 'Oi, {Nome}. Parcela {Parcela}, {Valor} vence hoje.');
    expect(checkDe(ok, 'colados').ok).toBe(true);
  });

  test('aviso com oferta vira MARKETING: barra e devolve o trecho; a oferta do crediário pode', () => {
    const texto = 'Oi, {Nome}. A parcela {Parcela} vence hoje. Pagando hoje, 5% de desconto no Pix.';
    const r = catalogo.validar(antes, texto);
    expect(checkDe(r, 'oferta')).toMatchObject({ ok: false, correcao: 'TIRAR_OFERTA' });
    expect(checkDe(r, 'oferta').trecho).toMatch(/desconto/);
    expect(checkDe(catalogo.validar(antes, 'Oi, {Nome}. A parcela {Parcela} vence hoje.'), 'oferta').ok).toBe(true);
    expect(checkDe(catalogo.validar(oferta, 'Oi, {Nome}. Tem 10% de desconto na {Nome da loja}, e você tem {Limite livre}. Venha ver.'), 'oferta')).toBeUndefined();
  });

  test('limite de 1.024 caracteres', () => {
    const longo = `Oi, {Nome}. ${'a'.repeat(1100)} fim.`;
    const r = catalogo.validar(antes, longo);
    expect(checkDe(r, 'tamanho')).toMatchObject({ ok: false, limite: 1024 });
    expect(checkDe(catalogo.validar(antes, 'Oi, {Nome}. Vence hoje.'), 'tamanho').ok).toBe(true);
  });

  test('campo desconhecido e texto vazio', () => {
    expect(checkDe(catalogo.validar(antes, 'Oi, {Cor}. Vence hoje.'), 'campos').ok).toBe(false);
    expect(catalogo.validar(antes, '   ').ok).toBe(false);
  });

  test('conversão para a Meta numera na ordem e monta os parâmetros do envio', () => {
    const { corpo, ordem } = catalogo.paraCorpoMeta('Oi, {Nome}. Vence {Vencimento}: {Valor}.');
    expect(corpo).toBe('Oi, {{1}}. Vence {{2}}: {{3}}.');
    expect(ordem).toEqual(['Nome', 'Vencimento', 'Valor']);
    const comp = catalogo.componentesDeEnvio('Oi, {Nome}. Vence {Vencimento}: {Valor}.', { Nome: 'Ana', Vencimento: 'hoje', Valor: 'R$ 10,00' });
    expect(comp[0].parameters.map((p) => p.text)).toEqual(['Ana', 'hoje', 'R$ 10,00']);
  });
});

function versao(over) {
  return {
    id: 'v-' + over.versao, modelo: 'cred_antes', texto: 'Oi, {Nome}. Texto {Valor} aqui.',
    template_name: 'aura_cred_antes_v' + over.versao, estado: 'APPROVED', motivo: null,
    criado_em: new Date('2026-11-01T12:00:00Z'), decidido_em: null, ...over,
  };
}
function simular({ versoes = [], padrao = 'APPROVED' } = {}) {
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params) => {
    if (/wa:modelos-versoes/.test(sql)) return { rows: versoes };
    if (/wa:modelos-padroes/.test(sql)) return { rows: padrao ? [{ name: 'aura_cred_antes', status: padrao }] : [] };
    if (/wa:modelos-cred/.test(sql)) return { rows: [{ wa_waba_id: 'W1', wa_access_token: 'tok' }] };
    if (/wa:modelos-decisao/.test(sql)) {
      const v = versoes.find((x) => x.template_name === params[1] && x.estado === 'PENDING');
      if (v) { v.estado = params[2]; v.motivo = params[3]; }
      return { rows: v ? [{ id: v.id, modelo: v.modelo, versao: v.versao }] : [] };
    }
    return { rows: [] };
  });
}
const AGORA = new Date('2026-11-26T15:00:00Z').getTime();

describe('texto novo só vale depois de aprovado', () => {
  test('pendente aparece como texto_novo, mas o envio usa o anterior', async () => {
    simular({
      versoes: [
        versao({ versao: 1, estado: 'APPROVED', texto: 'Oi, {Nome}. Texto aprovado {Valor}.' }),
        versao({ versao: 2, estado: 'PENDING', texto: 'Oi, {Nome}. Texto NOVO {Valor}.' }),
      ],
    });
    const item = await store.obter(COMPANY, 'cred_antes');
    expect(item.estado).toBe('EM_APROVACAO');
    expect(item.texto_novo).toMatch(/NOVO/);
    expect(item.texto_em_uso).toMatch(/aprovado/);
    const envio = await store.resolverParaEnvio(COMPANY, 'cred_antes');
    expect(envio.templateName).toBe('aura_cred_antes_v1');
    expect(envio.texto).not.toMatch(/NOVO/);
  });

  test('sem versão aprovada vale o padrão da Aura', async () => {
    simular({ versoes: [versao({ versao: 1, estado: 'PENDING' })] });
    const envio = await store.resolverParaEnvio(COMPANY, 'cred_antes');
    expect(envio.templateName).toBe('aura_cred_antes');
    expect(envio.texto).toBe(antes.texto_padrao);
  });

  test('aprovou: passa a valer e avisa no sino; recusou: o anterior segue e avisa com o motivo', async () => {
    simular({ versoes: [versao({ versao: 1, estado: 'PENDING', template_name: 'aura_cred_antes_v1' })] });
    await store.onTemplateStatus(COMPANY, { name: 'aura_cred_antes_v1', status: 'APPROVED' });
    expect(lojaEvents.emitLojaEvent).toHaveBeenCalledWith(
      'loja_wa_modelo_aprovado',
      expect.objectContaining({ company_id: COMPANY, modelo_titulo: 'Antes do vencimento' }),
      { dedupeSuffix: 'v-1' }
    );
    expect((await store.resolverParaEnvio(COMPANY, 'cred_antes')).templateName).toBe('aura_cred_antes_v1');

    lojaEvents.emitLojaEvent.mockClear();
    simular({ versoes: [versao({ versao: 1, estado: 'PENDING', template_name: 'aura_cred_antes_v1' })] });
    await store.onTemplateStatus(COMPANY, { name: 'aura_cred_antes_v1', status: 'REJECTED', reason: 'TAG_CONTENT_MISMATCH' });
    expect(lojaEvents.emitLojaEvent).toHaveBeenCalledWith(
      'loja_wa_modelo_reprovado',
      expect.objectContaining({ motivo: expect.stringMatching(/propaganda/) }),
      { dedupeSuffix: 'v-1' }
    );
    const item = await store.obter(COMPANY, 'cred_antes');
    expect(item.estado).toBe('NAO_APROVADA');
    expect(item.texto_em_uso).toBe(antes.texto_padrao);
  });

  test('status de template que não é versão da lojista não faz nada', async () => {
    lojaEvents.emitLojaEvent.mockClear();
    simular({ versoes: [] });
    expect(await store.onTemplateStatus(COMPANY, { name: 'parcela_lembrete', status: 'APPROVED' })).toBeNull();
    expect(lojaEvents.emitLojaEvent).not.toHaveBeenCalled();
  });
});

describe('enviar texto novo', () => {
  const bom = 'Oi, {Nome}. A parcela {Parcela} vence {Vencimento}: {Valor}. Qualquer coisa, me fala.';

  test('cria template NOVO e versionado na Meta, sem tocar no atual', async () => {
    simular({ versoes: [versao({ versao: 1, estado: 'APPROVED', criado_em: new Date('2026-10-01T00:00:00Z') })] });
    wa.createTemplate.mockResolvedValue({ id: '999', status: 'PENDING' });
    const r = await store.enviarTextoNovo(COMPANY, 'cred_antes', bom, { agora: AGORA });
    expect(r.versao).toBe(2);
    const [waba, , tpl] = wa.createTemplate.mock.calls[0];
    expect(waba).toBe('W1');
    expect(tpl).toMatchObject({ name: 'aura_cred_antes_v2', category: 'UTILITY', language: 'pt_BR' });
    expect(tpl.components[0].text).toBe('Oi, {{1}}. A parcela {{2}} vence {{3}}: {{4}}. Qualquer coisa, me fala.');
    expect(tpl.components[0].example.body_text[0]).toHaveLength(4);
    const insert = db.query.mock.calls.find((c) => /wa:modelos-nova-versao/.test(c[0]));
    expect(insert[1]).toEqual([COMPANY, 'cred_antes', 2, bom, 'aura_cred_antes_v2']);
  });

  test('texto inválido é recusado no servidor e nada vai à Meta', async () => {
    simular();
    wa.createTemplate.mockClear();
    await expect(store.enviarTextoNovo(COMPANY, 'cred_antes', 'Oi, {Nome}. Vence {Valor}', { agora: AGORA }))
      .rejects.toMatchObject({ status: 422, code: 'TEXTO_INVALIDO' });
    expect(wa.createTemplate).not.toHaveBeenCalled();
  });

  test('já há texto em aprovação: 409', async () => {
    simular({ versoes: [versao({ versao: 1, estado: 'PENDING', criado_em: new Date('2026-10-01T00:00:00Z') })] });
    await expect(store.enviarTextoNovo(COMPANY, 'cred_antes', bom, { agora: AGORA }))
      .rejects.toMatchObject({ status: 409, code: 'EM_APROVACAO' });
  });

  test('limite da Meta: 1 edição em 24 h bloqueia com a hora de voltar', async () => {
    simular({ versoes: [versao({ versao: 1, estado: 'APPROVED', criado_em: new Date(AGORA - 3 * 3600 * 1000) })] });
    wa.createTemplate.mockClear();
    const err = await store.enviarTextoNovo(COMPANY, 'cred_antes', bom, { agora: AGORA }).catch((e) => e);
    expect(err).toMatchObject({ status: 429, code: 'EDICAO_LIMITE_24H' });
    expect(err.extra.proxima_em).toBe(new Date(AGORA + 21 * 3600 * 1000).toISOString());
    expect(wa.createTemplate).not.toHaveBeenCalled();
  });

  test('limite da Meta: 10 em 30 dias bloqueia; recusadas não contam', async () => {
    const dias = (n) => new Date(AGORA - n * 24 * 3600 * 1000);
    const dez = Array.from({ length: 10 }, (_, i) => versao({ versao: i + 1, estado: 'APPROVED', criado_em: dias(2 + i * 2) }));
    simular({ versoes: dez });
    await expect(store.enviarTextoNovo(COMPANY, 'cred_antes', bom, { agora: AGORA }))
      .rejects.toMatchObject({ status: 429, code: 'EDICAO_LIMITE_30D' });

    const comRecusadas = dez.map((v, i) => (i < 3 ? { ...v, estado: 'REJECTED' } : v));
    simular({ versoes: comRecusadas });
    wa.createTemplate.mockResolvedValue({ id: '1', status: 'PENDING' });
    await expect(store.enviarTextoNovo(COMPANY, 'cred_antes', bom, { agora: AGORA })).resolves.toMatchObject({ versao: 11 });
  });

  test('sem WhatsApp conectado: 409 NAO_CONECTADO', async () => {
    simular();
    db.query.mockImplementation(async (sql) => {
      if (/wa:modelos-cred/.test(sql)) return { rows: [{ wa_waba_id: null, wa_access_token: null }] };
      return { rows: [] };
    });
    await expect(store.enviarTextoNovo(COMPANY, 'cred_antes', bom, { agora: AGORA }))
      .rejects.toMatchObject({ status: 409, code: 'NAO_CONECTADO' });
  });
});

describe('restaurar', () => {
  test('texto da Aura volta a valer e o pendente deixa de poder ser promovido', async () => {
    simular({ versoes: [versao({ versao: 1, estado: 'APPROVED' }), versao({ versao: 2, estado: 'PENDING' })] });
    await store.restaurarPadrao(COMPANY, 'cred_antes');
    const sqls = db.query.mock.calls.map((c) => c[0]);
    expect(sqls.some((s) => /wa:modelos-restaurar-supera/.test(s))).toBe(true);
    const ins = db.query.mock.calls.find((c) => /wa:modelos-restaurar\n/.test(c[0]));
    expect(ins[1]).toEqual([COMPANY, 'cred_antes', 3, 'aura_cred_antes']);
  });

  test('versão PADRAO mais nova que a aprovada manda o envio de volta ao padrão', () => {
    const item = store.montarEstado(antes, [
      versao({ versao: 1, estado: 'APPROVED' }),
      versao({ versao: 2, estado: 'PADRAO', texto: null, template_name: 'aura_cred_antes' }),
    ], 'APPROVED');
    expect(item.template_em_uso).toBe('aura_cred_antes');
    expect(item.texto_em_uso).toBe(antes.texto_padrao);
  });
});

describe('padrão ainda não aprovado', () => {
  test('estado AGUARDANDO_PADRAO', () => {
    expect(store.montarEstado(antes, [], 'PENDING').estado).toBe('AGUARDANDO_PADRAO');
    expect(store.montarEstado(antes, [], 'APPROVED').estado).toBe('PRONTA');
  });
});
