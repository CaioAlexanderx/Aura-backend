// ============================================================
// AURA. — Modelos de mensagem do crediário (migration 462) — regras puras
//
// Sem banco: validação (nome, 1.000 letras, variáveis), os prontos da Aura e
// a leitura da régua (quais textos são da loja e qual vira padrão). O
// comportamento no Postgres (limite, padrão único, outra loja, importação da
// régua uma vez só) está em credito.modelosDeMensagem.banco.test.js.
// ============================================================
'use strict';

const svc = require('../src/services/credit/messageTemplates');

describe('validação', () => {
  it('nome obrigatório e até 40 letras', () => {
    expect(() => svc.validarNome('  ')).toThrow('Dê um nome ao modelo.');
    expect(svc.validarNome('  Lembrete  ')).toBe('Lembrete');
    expect(() => svc.validarNome('x'.repeat(41))).toThrow('passa de 40');
    expect(svc.validarNome('é'.repeat(40))).toHaveLength(40);
  });

  it('texto até 1.000 letras, contando emoji como uma letra (char_length)', () => {
    expect(svc.validarTexto('a'.repeat(1000))).toHaveLength(1000);
    expect(() => svc.validarTexto('a'.repeat(1001))).toThrow('1.000 letras');
    const emoji = '😀'.repeat(1000); // 2000 unidades UTF-16, 1000 letras
    expect(() => svc.validarTexto(emoji)).not.toThrow();
    expect(() => svc.validarTexto('')).toThrow('Escreva o texto do modelo.');
  });

  it('só as variáveis que o app preenche', () => {
    expect(() => svc.validarTexto('Oi {nome}, {loja} {valor} {vencimento} {parcela} {dias} {saldo} {pix}')).not.toThrow();
    let e;
    try { svc.validarTexto('Oi {nome}, pague em {link_pix} ou {pix_copia_e_cola}'); } catch (x) { e = x; }
    expect(e.status).toBe(422);
    expect(e.code_negocio).toBe('VARIAVEL_DESCONHECIDA');
    expect(e.message).toContain('{link_pix}, {pix_copia_e_cola}');
  });

  it('situação: as três, ou nada (livre)', () => {
    expect(svc.validarSituacao(undefined)).toBeUndefined();
    expect(svc.validarSituacao(null)).toBeNull();
    expect(svc.validarSituacao('')).toBeNull();
    expect(svc.validarSituacao('livre')).toBeNull();
    expect(svc.validarSituacao('em_atraso')).toBe('em_atraso');
    expect(() => svc.validarSituacao('amanha')).toThrow('Situação inválida.');
  });
});

describe('prontos da Aura', () => {
  it('quatro, um padrão por situação e "Vamos combinar" livre', () => {
    const p = svc.prontos();
    expect(p.map((m) => m.name)).toEqual(['Lembrete', 'Vence hoje', 'Passou do dia', 'Vamos combinar']);
    expect(p.filter((m) => m.is_default).map((m) => m.situation)).toEqual(['a_vencer', 'vence_hoje', 'em_atraso']);
    expect(p.every((m) => m.origin === 'aura' && m.id === 'aura:' + m.aura_key)).toBe(true);
  });

  it('passam na própria validação (sem variável desconhecida, sem palavra dura)', () => {
    for (const m of svc.PRONTOS) {
      expect(() => svc.validarTexto(m.body)).not.toThrow();
      expect(m.body).not.toMatch(/regularize|débito|suspenso/i);
    }
  });

  it('"Passou do dia" não diz "vence em" de parcela vencida', () => {
    const atraso = svc.PRONTOS.find((m) => m.situation === 'em_atraso');
    expect(atraso.body).toContain('que venceu dia {vencimento}');
    expect(atraso.body).not.toContain('vence em');
  });
});

describe('textos da régua', () => {
  const padrao = [
    { id: 'lembrete', name: 'Lembrete', days_relative: -3, enabled: true, template: svc.REGUA_PADRAO.lembrete },
    { id: 'vencimento', name: 'No vencimento', days_relative: 0, enabled: true, template: svc.REGUA_PADRAO.vencimento },
    { id: 'atraso_1', name: 'Atraso leve', days_relative: 1, enabled: true, template: svc.REGUA_PADRAO.atraso_1 },
    { id: 'atraso_2', name: 'Atraso 2', days_relative: 7, enabled: false, template: svc.REGUA_PADRAO.atraso_2 },
    { id: 'bloqueio', name: 'Aviso de bloqueio', days_relative: 15, enabled: false, template: svc.REGUA_PADRAO.bloqueio },
  ];

  it('régua de fábrica (ou vazia) não vira modelo', () => {
    expect(svc.modelosDaRegua(padrao)).toEqual([]);
    expect(svc.modelosDaRegua(null)).toEqual([]);
    expect(svc.modelosDaRegua('não é json')).toEqual([]);
    // Só espaço a mais também é o texto de fábrica.
    const comEspaco = padrao.map((r) => ({ ...r, template: '  ' + r.template.replace(' ', '  ') + '\n' }));
    expect(svc.modelosDaRegua(comEspaco)).toEqual([]);
  });

  it('texto próprio vira modelo; nome repetido dos prontos ganha "(régua)"; etapa ligada fica padrão', () => {
    const rules = padrao.map((r) => ({ ...r }));
    rules[0].template = 'Oi {nome}, sua parcela de {valor} vence em {vencimento}. Beijo da Flor!';
    rules[3].template = 'Oi {nome}, já são {dias} dias. Me chama?';
    rules[4].template = '   ';
    const out = svc.modelosDaRegua(JSON.stringify(rules));
    expect(out).toEqual([
      { name: 'Lembrete (régua)', body: 'Oi {nome}, sua parcela de {valor} vence em {vencimento}. Beijo da Flor!', situation: 'a_vencer' },
      // Desligada não toma o padrão de ninguém: entra livre.
      { name: 'Atraso 2', body: 'Oi {nome}, já são {dias} dias. Me chama?', situation: null },
    ]);
  });

  it('duas etapas de atraso com texto próprio: só a primeira ligada é o padrão; texto repetido entra uma vez', () => {
    const A = 'Oi {nome}, passou do dia, tudo bem?';
    const B = 'Oi {nome}, já faz {dias} dias, me chama?';
    const rules = [
      { id: 'atraso_1', name: 'Atraso leve', days_relative: 1, enabled: true, template: A },
      { id: 'atraso_2', name: 'Atraso 2', days_relative: 7, enabled: true, template: B },
      { id: 'x', name: 'Outra', days_relative: 9, enabled: true, template: B },
    ];
    expect(svc.modelosDaRegua(rules)).toEqual([
      { name: 'Atraso leve', body: A, situation: 'em_atraso' },
      { name: 'Atraso 2', body: B, situation: null },
    ]);
  });

  // O formato que as 45 lojas têm em produção (medido em 21/11/2026): o
  // `template` é a CHAVE do texto antigo do backend, não um texto.
  const REGUA_DE_PRODUCAO = [
    { id: 'd-3', name: 'Lembrete', days_relative: -3, channel: 'whatsapp', enabled: true, template: 'lembrete' },
    { id: 'd-1', name: 'Confirmação', days_relative: -1, channel: 'whatsapp', enabled: true, template: 'confirmacao' },
    { id: 'd0', name: 'Vencimento', days_relative: 0, channel: 'whatsapp', enabled: true, template: 'vencimento' },
    { id: 'd+3', name: 'Atraso 1', days_relative: 3, channel: 'whatsapp', enabled: true, template: 'atraso_1' },
    { id: 'd+10', name: 'Atraso 2', days_relative: 10, channel: 'whatsapp', enabled: true, template: 'atraso_2' },
    { id: 'd+30', name: 'Bloqueio', days_relative: 30, channel: 'system', enabled: false, template: 'bloqueio' },
  ];

  it('régua de produção (template = chave do texto antigo) não vira modelo', () => {
    expect(svc.modelosDaRegua(REGUA_DE_PRODUCAO)).toEqual([]);
    expect(svc.modelosDaRegua(JSON.stringify(REGUA_DE_PRODUCAO))).toEqual([]);
    // Chave em caixa diferente, palavra solta ou texto curto também não.
    expect(svc.modelosDaRegua([
      { id: 'd0', days_relative: 0, template: 'ATRASO_1' },
      { id: 'd1', days_relative: 1, template: 'cobranca_personalizada' },
      { id: 'd2', days_relative: 2, template: 'Pague já' },
    ])).toEqual([]);
  });

  it('texto com variável desconhecida ou acima de 1.000 letras fica fora (nada é cortado)', () => {
    expect(svc.modelosDaRegua([
      { id: 'a', days_relative: 1, enabled: true, template: 'Oi {nome}, pague pelo link {link_pix} hoje' },
      { id: 'b', days_relative: 2, enabled: true, template: 'Oi {nome}, ' + 'x'.repeat(1000) },
    ])).toEqual([]);
  });

  it('texto de fábrica de outra etapa também não é da loja', () => {
    expect(svc.modelosDaRegua([
      { id: 'd-3', days_relative: -3, enabled: true, template: svc.REGUA_PADRAO.vencimento },
    ])).toEqual([]);
  });
});
