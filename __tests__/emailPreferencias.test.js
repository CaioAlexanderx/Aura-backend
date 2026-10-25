// ============================================================
// AURA. — Preferências de e-mail e assinatura do webhook do Resend, sem
// banco (tq-87, tq-88, tq-90, 24/10/2026)
//
// O SQL de verdade está em companyEmails.banco.test.js. Aqui:
//   - padrões do Caio (21/10) e linha ausente = padrão
//   - kill switch RELATORIO_PADRAO_LIGADO / EMAILS_CICLO_ENABLED
//   - validação do PUT, destinatários, blocos, rodapé, links
//   - assinatura svix: vetor da doc da Svix, assinatura inválida,
//     timestamp velho, corpo alterado, sem segredo
// ============================================================
'use strict';

const crypto = require('crypto');
const P = require('../src/services/emailPreferencias');
const { verificarAssinatura } = require('../src/services/resendWebhook');
const { situacao, categoria } = require('../src/services/emailUltimos');
const { naJanela } = require('../src/jobs/reportScheduler');

const EMP = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('padrões e linha ausente', () => {
  test('relatório ligado, segunda 8h, completo; ajuda, acompanhamento e novidades ligados; pedido para a equipe', () => {
    const p = P.preferenciaEfetiva('relatorio', null, {});
    expect(p).toMatchObject({ ligado: true, explicito: false });
    expect(p.config).toMatchObject({ dia: 1, hora: 8, versao: 'completa', destinatarios: null });
    expect(p.config.blocos).toEqual([...P.BLOCOS]);
    for (const t of ['ajuda', 'acompanhamento', 'novidades']) expect(P.preferenciaEfetiva(t, null, {}).ligado).toBe(true);
    const ped = P.preferenciaEfetiva('pedido_loja', null, {});
    expect(ped).toMatchObject({ ligado: true, pedido_destino_escolhido: false });
    expect(ped.config.pedido_destino).toBe('equipe'); // o comportamento de hoje
  });

  test('linha explícita manda; config guardada só substitui o que foi escolhido', () => {
    const p = P.preferenciaEfetiva('relatorio', { ligado: false, config: { hora: 18 } }, {});
    expect(p).toMatchObject({ ligado: false, explicito: true });
    expect(p.config).toMatchObject({ dia: 1, hora: 18, versao: 'completa' });
  });

  test('kill switch: RELATORIO_PADRAO_LIGADO=false ou EMAILS_CICLO_ENABLED=false desligam só o padrão do relatório', () => {
    expect(P.preferenciaEfetiva('relatorio', null, { RELATORIO_PADRAO_LIGADO: 'false' }).ligado).toBe(false);
    expect(P.preferenciaEfetiva('relatorio', null, { EMAILS_CICLO_ENABLED: '0' }).ligado).toBe(false);
    expect(P.preferenciaEfetiva('relatorio', { ligado: true }, { RELATORIO_PADRAO_LIGADO: 'false' }).ligado).toBe(true);
    expect(P.preferenciaEfetiva('novidades', null, { EMAILS_CICLO_ENABLED: '0' }).ligado).toBe(true);
  });

  test('tipoLigado: cobrança e segurança sempre; tipo desconhecido nunca; sem cache', async () => {
    const db = { query: jest.fn() };
    expect(await P.tipoLigado(db, EMP, 'cobranca')).toBe(true);
    expect(await P.tipoLigado(db, EMP, 'seguranca')).toBe(true);
    expect(await P.tipoLigado(db, EMP, 'marketing')).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
    // prefs (sem linha) + nota do tq-110 (sem nota); depois prefs desligada.
    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ ligado: false, config: {} }] });
    expect(await P.tipoLigado(db, EMP, 'novidades')).toBe(true);
    expect(await P.tipoLigado(db, EMP, 'novidades')).toBe(false); // lê de novo a cada envio
  });

  test('tipoLigado sem a tabela (42P01): relatório cai em weekly_report_enabled, o resto no padrão', async () => {
    const semTabela = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    const db = { query: jest.fn(async (sql) => {
      if (/company_email_prefs/.test(sql)) throw semTabela;
      return { rows: [{ weekly_report_enabled: false }] };
    }) };
    expect(await P.tipoLigado(db, EMP, 'relatorio')).toBe(false);
    expect(await P.tipoLigado(db, EMP, 'ajuda')).toBe(true);
  });
});

describe('validação do PUT', () => {
  const conhecidos = new Set(['dona@loja.test', 'financeiro@loja.test']);
  test('aceita o que a tela manda', () => {
    const v = P.validarMudancas({
      relatorio: { ligado: true, dia: 5, hora: 18, versao: 'completa', blocos: ['clientes', 'vendas'], destinatarios: ['Financeiro@Loja.test'] },
      novidades: { ligado: false },
      pedido_loja: { pedido_destino: 'enderecos' },
    }, conhecidos);
    expect(v.ok).toBe(true);
    expect(v.mudancas.relatorio).toEqual({ ligado: true, config: { dia: 5, hora: 18, versao: 'completa', blocos: ['vendas', 'clientes'], destinatarios: ['financeiro@loja.test'] } });
    expect(v.mudancas.novidades).toEqual({ ligado: false, config: {} });
    expect(v.mudancas.pedido_loja.config).toEqual({ pedido_destino: 'enderecos' });
  });

  test.each([
    [{ cobranca: { ligado: false } }, 'TIPO_SEMPRE_ENVIADO'],
    [{ seguranca: { ligado: false } }, 'TIPO_SEMPRE_ENVIADO'],
    [{ marketing: { ligado: false } }, 'TIPO_DESCONHECIDO'],
    [{ relatorio: { dia: 7 } }, 'DIA_INVALIDO'],
    [{ relatorio: { hora: 24 } }, 'HORA_INVALIDA'],
    [{ relatorio: { hora: '8' } }, 'HORA_INVALIDA'],
    [{ relatorio: { blocos: ['vendas', 'lucro'] } }, 'BLOCOS_INVALIDOS'],
    [{ relatorio: { destinatarios: ['outro@x.test'] } }, 'DESTINATARIO_DESCONHECIDO'],
    [{ relatorio: { ligado: 'sim' } }, 'LIGADO_INVALIDO'],
    [{ ajuda: { dia: 1 } }, 'CAMPO_DESCONHECIDO'],
    [{ pedido_loja: { pedido_destino: 'todos' } }, 'DESTINO_INVALIDO'],
    [null, 'PREFS_INVALIDAS'],
  ])('%j -> %s', (corpo, codigo) => {
    expect(P.validarMudancas(corpo, conhecidos)).toMatchObject({ ok: false, codigo });
  });
});

describe('destinatários, blocos e rodapé', () => {
  const extras = [
    { email: 'financeiro@loja.test', confirmado_em: new Date() },
    { email: 'socio@loja.test', confirmado_em: null }, // falta confirmar
  ];
  test('sem marcação: principal + extras confirmados; extra sem confirmar nunca recebe', () => {
    expect(P.destinatariosDe({ principal: 'dona@loja.test', extras, config: {} }))
      .toEqual(['dona@loja.test', 'financeiro@loja.test']);
  });
  test('com marcação: só os marcados que estão confirmados', () => {
    expect(P.destinatariosDe({ principal: 'dona@loja.test', extras, config: { destinatarios: ['financeiro@loja.test', 'socio@loja.test'] } }))
      .toEqual(['financeiro@loja.test']);
    expect(P.destinatariosDe({ principal: 'dona@loja.test', extras, config: { destinatarios: [] } })).toEqual([]);
  });
  test('blocos do relatório longo: os ligados que o plano tem', () => {
    expect(P.blocosDoRelatorio({ blocos: ['vendas', 'crediario'] }, 'essencial')).toEqual(['vendas']);
    expect(P.blocosDoRelatorio({ blocos: ['vendas', 'crediario'] }, 'negocio')).toEqual(['vendas', 'crediario']);
    expect(P.blocosDoRelatorio({}, 'expansao')).toEqual([...P.BLOCOS]);
  });
  test('rodapé com dia e hora', () => {
    expect(P.quandoDoRelatorio({ dia: 1, hora: 8 })).toBe('toda segunda, às 8h');
    expect(P.quandoDoRelatorio({ dia: 0, hora: 18 })).toBe('todo domingo, às 18h');
    expect(P.quandoDoRelatorio({ dia: 5, hora: 7 })).toBe('toda sexta, às 7h');
  });
  test('descadastroDoTipo: link do tipo, cabeçalhos RFC 8058 e "Ajustar meus e-mails"', () => {
    const d = P.descadastroDoTipo(EMP, 'novidades', { env: { ...process.env, API_URL: 'https://api.x.test/api/v1' } });
    expect(d.link).toMatch(/^https:\/\/api\.x\.test\/api\/v1\/emails\/descadastro\//);
    expect(d.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(d.ajustar).toBe(`https://app.getaura.com.br/configuracoes?foco=emails&empresa=${EMP}`);
    const { lerTokenDescadastro } = require('../src/services/emailLinks');
    expect(lerTokenDescadastro(d.link.split('/').pop())).toMatchObject({ companyId: EMP, tipo: 'novidades' });
  });
});

describe('janela do relatório (BRT)', () => {
  // 26/10/2026 é segunda. 11:00Z = 8h em São Paulo.
  test('segunda 8h: sai a partir das 8h do dia, nunca em outro dia', () => {
    const cfg = { dia: 1, hora: 8 };
    expect(naJanela(cfg, Date.parse('2026-10-26T10:59:00Z'))).toBe(false); // 7h59
    expect(naJanela(cfg, Date.parse('2026-10-26T11:00:00Z'))).toBe(true);  // 8h
    expect(naJanela(cfg, Date.parse('2026-10-27T02:59:00Z'))).toBe(true);  // 23h59 de segunda (reinício recupera)
    expect(naJanela(cfg, Date.parse('2026-10-27T03:00:00Z'))).toBe(false); // terça 0h: sem retroativo
    expect(naJanela(cfg, Date.parse('2026-10-24T12:00:00Z'))).toBe(false); // sábado
  });
});

describe('"Últimos e-mails": situação', () => {
  test('Entregue só com o webhook ligado; Devolvido e Falhou têm prioridade', () => {
    const com = { RESEND_WEBHOOK_SECRET: 'whsec_x' };
    expect(situacao({ status: 'sent', delivered_at: new Date() }, {})).toBe('enviado');
    expect(situacao({ status: 'sent', delivered_at: new Date() }, com)).toBe('entregue');
    expect(situacao({ status: 'sent', delivered_at: new Date(), bounced_at: new Date() }, com)).toBe('devolvido');
    expect(situacao({ status: 'failed' }, com)).toBe('falhou');
    expect(categoria('cobranca_vence_hoje')).toBe('cobranca');
    expect(categoria('relatorio_semanal')).toBe('relatorio');
    expect(categoria('pedido_novo_lojista')).toBe('pedido_loja');
  });
});

describe('assinatura svix do webhook do Resend', () => {
  // Vetor de exemplo da doc da Svix ("Verifying payloads manually").
  const DOC = {
    segredo: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
    id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
    timestamp: '1614265330',
    corpo: '{"test": 2432232314}',
    assinatura: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
  };
  const AGORA_DOC = 1614265330 * 1000;

  function assinar(segredo, id, ts, corpo) {
    const chave = Buffer.from(segredo.replace(/^whsec_/, ''), 'base64');
    return 'v1,' + crypto.createHmac('sha256', chave).update(`${id}.${ts}.${corpo}`).digest('base64');
  }

  test('vetor da doc da Svix confere', () => {
    expect(verificarAssinatura({ ...DOC, agora: AGORA_DOC })).toEqual({ ok: true });
  });

  test('aceita qualquer uma das assinaturas do cabeçalho (rotação do segredo)', () => {
    const r = verificarAssinatura({ ...DOC, assinatura: `v1,AAAA ${DOC.assinatura}`, agora: AGORA_DOC });
    expect(r.ok).toBe(true);
  });

  test('assinatura inválida, corpo alterado, id trocado: recusa', () => {
    expect(verificarAssinatura({ ...DOC, assinatura: 'v1,' + Buffer.alloc(32).toString('base64'), agora: AGORA_DOC }))
      .toEqual({ ok: false, motivo: 'assinatura_invalida' });
    expect(verificarAssinatura({ ...DOC, corpo: '{"test": 2432232315}', agora: AGORA_DOC }).ok).toBe(false);
    expect(verificarAssinatura({ ...DOC, id: 'msg_outro', agora: AGORA_DOC }).ok).toBe(false);
    expect(verificarAssinatura({ ...DOC, assinatura: 'v2,' + DOC.assinatura.slice(3), agora: AGORA_DOC }).ok).toBe(false);
  });

  test('timestamp a mais de 5 min (velho ou no futuro): recusa', () => {
    expect(verificarAssinatura({ ...DOC, agora: AGORA_DOC + 301 * 1000 })).toEqual({ ok: false, motivo: 'timestamp_fora_da_janela' });
    expect(verificarAssinatura({ ...DOC, agora: AGORA_DOC - 301 * 1000 }).ok).toBe(false);
    expect(verificarAssinatura({ ...DOC, agora: AGORA_DOC + 299 * 1000 }).ok).toBe(true);
  });

  test('sem segredo ou sem cabeçalho: recusa', () => {
    expect(verificarAssinatura({ ...DOC, segredo: '', agora: AGORA_DOC })).toEqual({ ok: false, motivo: 'sem_segredo' });
    expect(verificarAssinatura({ ...DOC, id: undefined, agora: AGORA_DOC })).toEqual({ ok: false, motivo: 'cabecalhos_ausentes' });
  });

  test('corpo como Buffer (req.rawBody) e com acento', () => {
    const corpo = '{"type":"email.delivered","data":{"subject":"Relatório"}}';
    const ts = String(Math.floor(Date.now() / 1000));
    const assinatura = assinar(DOC.segredo, 'msg_1', ts, corpo);
    expect(verificarAssinatura({ segredo: DOC.segredo, id: 'msg_1', timestamp: ts, assinatura, corpo: Buffer.from(corpo, 'utf8') }).ok).toBe(true);
  });
});
