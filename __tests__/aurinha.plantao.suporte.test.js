// ============================================================
// AURA — AURINHA DE PLANTÃO: persona de suporte e ferramentas (380)
//
// O modelo é mockado (claudeClient.callClaude): o teste roteiriza o que ele
// "decide" e confere o que o CÓDIGO faz com isso. Banco fake em memória
// (helpers/hubFakeDb + as consultas `-- suporte:*`).
//
//  (1) base de conhecimento por relevância (palavra-chave), não tudo
//  (2) persona de suporte: lista fechada, regras duras, preço do billingPricing
//  (3) cada intenção com a ferramenta certa
//  (4) identificação pelo telefone da conversa (negada quando não bate)
//  (5) estender trial: só uma vez, só teste vencido ou a vencer
//  (6) agendamento grava (2 opções, horário comercial, pendente)
//  (7) pendência grava
//  (8) limite de uso por ferramenta
//  (9) responderNoHub: resposta + assinatura, relógio, fallback em erro,
//      limite por hora, tamanho, histórico de 20
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/services/whatsapp', () => ({ sendTemplate: jest.fn(), sendText: jest.fn() }));
jest.mock('../src/services/claudeClient', () => ({ callClaude: jest.fn() }));
jest.mock('../src/services/clients360', () => ({ listarClients360: jest.fn() }));
jest.mock('../src/services/appNotifications', () => ({ notifyCompany: jest.fn() }));

const db = require('../src/config/database');
const { callClaude } = require('../src/services/claudeClient');
const { listarClients360 } = require('../src/services/clients360');
const { notifyCompany } = require('../src/services/appNotifications');
const { makeWorld, handler: hubHandler } = require('./helpers/hubFakeDb');

const base = require('../src/services/aurinhaBase');
const suporte = require('../src/services/aurinhaSuporte');
const agent = require('../src/services/aurinhaAgent');
const hubWhatsapp = require('../src/services/hubWhatsapp');
const { buildSystemPrompt } = require('../src/services/aurinhaPrompt');
const { PLANS } = require('../src/services/billingPricing');

const AURA = '11111111-1111-4111-8111-111111111111';
const LOJA = '22222222-2222-4222-8222-222222222222';
const LOJA_2 = '33333333-3333-4333-8333-333333333333';
const FONE = '5511988887777';
const TENANT = { companyId: AURA, enabled: true, plantao: null };

// 14/10/2026 é quarta-feira. Horário de Brasília (UTC-3).
const brt = (hh, mm = 0, dia = 14) => new Date(Date.UTC(2026, 9, dia, hh + 3, mm, 0));
const DIA_MS = 86400000;

let world;
let seq;

// Consultas do suporte por cima do banco fake do hub.
function handler(w) {
  const hub = hubHandler(w);
  return (sql, params = []) => {
    const s = String(sql);
    const rows = (r) => { w.queries.push({ sql: s, params }); return Promise.resolve({ rows: r }); };

    if (s.includes('-- suporte:historico')) {
      const lista = w.messages
        .filter((m) => m.conversation_id === params[0])
        .slice().reverse().slice(0, params[1]);
      return rows(lista.map((m) => ({ direction: m.direction, author: m.author, content: m.content })));
    }
    if (s.includes('-- suporte:usos')) {
      const n = {};
      for (const e of w.events) {
        if (e.conversation_id === params[1] && e.type === 'ferramenta_suporte' && e.detail.ok) {
          n[e.detail.ferramenta] = (n[e.detail.ferramenta] || 0) + 1;
        }
      }
      return rows(Object.entries(n).map(([ferramenta, k]) => ({ ferramenta, n: k })));
    }
    if (s.includes('-- suporte:contas-do-telefone')) {
      return rows(w.cadastro.filter((c) => c.telefone.replace(/\D/g, '').slice(-8) === params[0]));
    }
    if (s.includes('-- suporte:caixa-aberto')) return rows(w.caixaAberto.has(params[0]) ? [{ ok: 1 }] : []);
    if (s.includes('-- suporte:trial-ja')) {
      return rows(w.audit.some((a) => a.company_id === params[0] && a.action === params[1]) ? [{ ok: 1 }] : []);
    }
    if (s.includes('-- suporte:trial-audit')) {
      if (w.auditErro) { const e = w.auditErro; w.queries.push({ sql: s, params }); return Promise.reject(e); }
      const a = { id: `aud-${++seq}`, company_id: params[0], action: params[1], detail: params[2], metadata: JSON.parse(params[3]) };
      w.audit.push(a);
      return rows([{ id: a.id }]);
    }
    if (/DELETE FROM audit_log/.test(s)) {
      w.audit = w.audit.filter((a) => a.id !== params[0]);
      return rows([]);
    }
    if (/SELECT trial_ends_at, billing_status FROM companies/.test(s)) {
      const c = w.companies[params[0]];
      return rows(c ? [{ trial_ends_at: c.trial_ends_at, billing_status: c.billing_status }] : []);
    }
    if (/UPDATE companies SET trial_ends_at/.test(s)) {
      if (w.updateErro) { w.queries.push({ sql: s, params }); return Promise.reject(w.updateErro); }
      w.companies[params[1]].trial_ends_at = params[0];
      return rows([]);
    }
    if (s.includes('-- suporte:agendamento-pendente')) {
      return rows(w.agendamentos.filter((a) => a.telefone === params[1] && a.status === 'pendente')
        .map((a) => ({ id: a.id, opcoes: a.opcoes })));
    }
    if (s.includes('-- suporte:agendamento-insert')) {
      if (w.agendaAusente) {
        const e = new Error('relation "hub_agendamentos" does not exist'); e.code = '42P01';
        w.queries.push({ sql: s, params }); return Promise.reject(e);
      }
      const a = {
        id: `ag-${++seq}`, hub_company_id: params[0], conversation_id: params[1], company_id: params[2],
        telefone: params[3], nome: params[4], assunto: params[5], duracao_minutos: params[6],
        opcoes: JSON.parse(params[7]), status: 'pendente',
      };
      w.agendamentos.push(a);
      return rows([{ id: a.id }]);
    }
    if (s.includes('-- hubwa:respostas-na-hora')) {
      const n = w.outbox.filter((o) => o.hub_conversation_id === params[0]
        && o.source_type === 'aurinha' && o.status !== 'skipped').length;
      return rows([{ n }]);
    }
    if (s.includes('-- hubwa:stub-recente')) {
      // a consulta real compara o texto: só o TEXTO FIXO conta
      const hit = w.outbox.some((o) => o.hub_conversation_id === params[0]
        && o.source_type === 'aurinha' && o.status !== 'skipped' && o.text_body === params[2]);
      w.queries.push({ sql: s, params });
      return Promise.resolve({ rows: hit ? [{ ok: 1 }] : [] });
    }
    return hub(sql, params);
  };
}

// ── roteiro do modelo ───────────────────────────────────────
const usa = (name, input = {}) => {
  const tu = { type: 'tool_use', id: `tu-${++seq}`, name, input };
  return { stopReason: 'tool_use', text: '', content: [tu], toolUses: [tu], inputTokens: 10, outputTokens: 5, model: 'mock' };
};
const diz = (text) => ({
  stopReason: 'end_turn', text, content: [{ type: 'text', text }], toolUses: [], inputTokens: 10, outputTokens: 5, model: 'mock',
});
function roteiro(...passos) {
  callClaude.mockReset();
  passos.forEach((p) => callClaude.mockResolvedValueOnce(p));
}
// O que as ferramentas devolveram ao modelo, na ordem.
function resultadosDasFerramentas() {
  const out = [];
  for (const call of callClaude.mock.calls) {
    for (const m of call[0].messages) {
      if (m.role === 'user' && Array.isArray(m.content)) {
        for (const b of m.content) if (b.type === 'tool_result' && !out.some((x) => x.id === b.tool_use_id)) {
          out.push({ id: b.tool_use_id, ...JSON.parse(b.content) });
        }
      }
    }
  }
  return out;
}

// ── cenário ─────────────────────────────────────────────────
function conversaCom(falas = ['Oi'], over = {}) {
  const conv = {
    id: 'conv-1', company_id: AURA, channel: 'whatsapp', external_id: FONE, customer_name: 'Marina Souza',
    status: 'ia', last_inbound_at: brt(23), aguardando_resposta_desde: brt(23), ultima_mensagem_humana_em: null,
    ...over,
  };
  world.convs.push(conv);
  falas.forEach((f) => {
    const m = typeof f === 'string' ? { author: 'cliente', content: f } : f;
    world.messages.push({
      id: `m-${++seq}`, company_id: AURA, conversation_id: conv.id,
      direction: m.author === 'cliente' ? 'inbound' : 'outbound', author: m.author, content: m.content,
    });
  });
  return conv;
}
function cadastrar({ id = LOJA, nome = 'Loja da Marina', telefone = '(11) 98888-7777', vinculo = 'dono', conta = {} } = {}) {
  world.cadastro.push({ company_id: id, nome, telefone, vinculo });
  world.contas[id] = {
    id, plan: 'negocio', stage: 'vencido', archive_reason: null, trial_days_left: null, days_since_expiry: 2,
    trial_ends_at: new Date(brt(23).getTime() - 2 * DIA_MS), prod_count: 42, sale_count: 7, caixa_sessions: 3,
    ...conta,
  };
  world.companies[id] = { trial_ends_at: world.contas[id].trial_ends_at, billing_status: 'trial' };
}
const responder = (conv, agora = brt(23)) => agent.responderSuporte({ companyId: AURA, conversa: conv, agora });
const ctxDe = (conv, agora = brt(23)) => suporte.criarContexto({ hubCompanyId: AURA, conversa: conv, agora });
const eventos = (tipo) => world.events.filter((e) => e.type === tipo);

beforeEach(() => {
  seq = 0;
  world = makeWorld({ cadastro: [], contas: {}, companies: {}, audit: [], agendamentos: [], caixaAberto: new Set() });
  process.env.AURA_COMPANY_ID = AURA;
  delete process.env.APP_URL;
  db.query.mockReset();
  db.query.mockImplementation(handler(world));
  callClaude.mockReset();
  notifyCompany.mockReset();
  listarClients360.mockReset();
  listarClients360.mockImplementation(async ({ companyId }) => (world.contas[companyId] ? [world.contas[companyId]] : []));
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.AURA_COMPANY_ID;
});

// ── (1) base de conhecimento ────────────────────────────────
describe('base de conhecimento — carregada por relevância', () => {
  it('tem um arquivo por tema, todos com palavras e conteúdo', () => {
    expect(base.TEMAS.map((t) => t.id)).toEqual([
      'caixa-e-bipe', 'crediario', 'estoque-e-importacao', 'etiquetas',
      'nfce', 'planos-e-trial', 'pwa-celular-e-mac', 'whatsapp-da-loja',
    ]);
    for (const t of base.TEMAS) {
      expect(t.palavras.length).toBeGreaterThan(5);
      expect(t.conteudo.length).toBeGreaterThan(300);
    }
  });

  it.each([
    ['Meu leitor não está bipando no caixa', 'caixa-e-bipe'],
    ['a ETIQUETA saiu cortada na impressora', 'etiquetas'],
    ['como importo minha planilha de produtos?', 'estoque-e-importacao'],
    ['quero receber uma parcela do crediário', 'crediario'],
    ['a nota fiscal foi rejeitada pela sefaz', 'nfce'],
    ['como conecto o whatsapp da loja', 'whatsapp-da-loja'],
    ['quanto custa o plano?', 'planos-e-trial'],
    ['dá pra instalar no iphone?', 'pwa-celular-e-mac'],
  ])('"%s" → %s', (texto, id) => {
    expect(base.selecionarTemas(texto)[0].id).toBe(id);
  });

  it('sem palavra batendo, nenhum tema; e nunca mais que 2', () => {
    expect(base.selecionarTemas('bom dia, tudo bem?')).toEqual([]);
    expect(base.selecionarTemas('')).toEqual([]);
    const muitos = base.selecionarTemas('caixa etiqueta estoque crediário nota fiscal whatsapp plano iphone');
    expect(muitos).toHaveLength(2);
  });

  it('palavra inteira: "notável" não vira "nota"; acento e caixa não importam', () => {
    expect(base.selecionarTemas('que sistema notável')).toEqual([]);
    expect(base.selecionarTemas('CREDIÁRIO')[0].id).toBe('crediario');
  });

  it('o prompt leva só os temas escolhidos — não a base inteira', () => {
    const temas = base.selecionarTemas('o leitor não bipa');
    const prompt = suporte.buildSuportePrompt({ temas, agora: brt(23) });
    expect(prompt).toContain('Caixa e leitor de código de barras');
    expect(prompt).not.toContain('Etiquetas de preço');
    expect(prompt).not.toContain('NFC-e (nota fiscal do consumidor)');

    const vazio = suporte.buildSuportePrompt({ temas: [], agora: brt(23) });
    expect(vazio).toContain('Nenhum tema da base bate');
    for (const t of base.TEMAS) expect(vazio).not.toContain(t.conteudo.slice(0, 60));
  });
});

// ── (2) persona ─────────────────────────────────────────────
describe('persona de suporte', () => {
  const prompt = () => suporte.buildSuportePrompt({ temas: [], agora: brt(23), nome: 'Marina Souza' });

  it('lista fechada de 7 intenções, cada ferramenta existe', () => {
    expect(suporte.INTENCOES.map((i) => i.id)).toEqual([
      'duvida_de_uso', 'problema_tecnico', 'plano_e_preco', 'trial', 'checkout', 'agendar', 'nao_sei',
    ]);
    const nomes = suporte.TOOLS.map((t) => t.name);
    expect(nomes).toEqual([
      'consultar_conta_pelo_telefone', 'estender_trial', 'link_do_checkout', 'agendar_conversa', 'registrar_pendencia',
    ]);
    for (const i of suporte.INTENCOES) if (i.ferramenta) expect(nomes).toContain(i.ferramenta);
    for (const n of nomes) expect(suporte.LIMITES[n]).toBeGreaterThan(0);
  });

  it('regras duras estão no prompt', () => {
    const p = prompt();
    expect(p).toMatch(/Nunca invente/);
    expect(p).toMatch(/Não prometa funcionalidade nova nem data/);
    expect(p).toMatch(/Não dê desconto/);
    expect(p).toMatch(/Não fale de cobrança em atraso/);
    expect(p).toMatch(/Não mostre nem confirme dado de conta/);
    expect(p).toMatch(/lista FECHADA/);
  });

  it('preço vem do billingPricing (mensal e anual), sem outro valor', () => {
    const p = prompt();
    expect(p).toContain(`${PLANS.essencial.name}: R$ 89,00 por mês no mensal; R$ 74,17 por mês no anual`);
    expect(p).toContain(`${PLANS.negocio.name}: R$ 169,00 por mês no mensal; R$ 140,83 por mês no anual`);
    expect(p).toContain(`${PLANS.expansao.name}: R$ 269,00 por mês no mensal`);
    expect(p).toContain('paga 10 meses e usa 12');
    expect(p).toContain('R$ 19,00 por mês');
  });

  it('é outra persona: não é a vendedora da loja, e nenhuma ferramenta de loja', () => {
    const p = prompt();
    const loja = buildSystemPrompt({ company: { trade_name: 'Finesse' }, channelConfig: null, settings: null });
    expect(p).not.toContain('vendedora atenciosa');
    expect(p).not.toContain('link_do_produto');
    expect(loja).not.toContain('estender_trial');
    expect(agent.TOOLS.map((t) => t.name)).not.toEqual(expect.arrayContaining(['estender_trial']));
  });

  it('sabe a hora e o prazo de retorno: de madrugada "hoje às 8h", à noite "amanhã às 8h", de dia "ainda hoje"', () => {
    expect(suporte.retornoPrevisto(brt(2))).toBe('hoje às 8h');
    expect(suporte.retornoPrevisto(brt(23))).toBe('amanhã às 8h');
    expect(suporte.retornoPrevisto(brt(11))).toBe('ainda hoje, em horário comercial');
    expect(prompt()).toContain('quarta, 14/10/2026, 23h00');
  });
});

// ── (3) cada intenção com a ferramenta certa ────────────────
describe('intenções — a ferramenta certa, com efeito de verdade', () => {
  it('dúvida de uso: responde com a base, sem ferramenta, e assina', async () => {
    const conv = conversaCom(['Oi', 'meu leitor não bipa no caixa']);
    roteiro(diz('O leitor funciona como um teclado: é só bipar com o Caixa aberto.'));

    const r = await responder(conv);

    expect(callClaude).toHaveBeenCalledTimes(1);
    const req = callClaude.mock.calls[0][0];
    expect(req.system).toContain('Caixa e leitor de código de barras');
    expect(req.tools).toBe(suporte.TOOLS);
    expect(r.temas).toEqual(['caixa-e-bipe']);
    expect(r.texto).toBe(`O leitor funciona como um teclado: é só bipar com o Caixa aberto.\n\n${suporte.ASSINATURA}`);
    expect(suporte.ASSINATURA).toMatch(/mesma Aurinha que pode atender os clientes da sua loja/);
    expect(eventos('ferramenta_suporte')).toHaveLength(0);
  });

  it('problema técnico: abre pendência para o Caio com o essencial', async () => {
    const conv = conversaCom(['a etiqueta sai toda cortada na Elgin L42, já calibrei']);
    roteiro(
      usa('registrar_pendencia', { tipo: 'problema_tecnico', resumo: 'Etiqueta cortada na Elgin L42', detalhes: 'Já calibrou. Etiqueta 99x21.' }),
      diz('Anotei tudo e o Caio retorna amanhã às 8h.'),
    );

    await responder(conv);

    const [p] = eventos('pendencia_suporte');
    expect(p).toMatchObject({ company_id: AURA, conversation_id: 'conv-1' });
    expect(p.detail).toMatchObject({
      tipo: 'problema_tecnico', resumo: 'Etiqueta cortada na Elgin L42',
      detalhes: 'Já calibrou. Etiqueta 99x21.', telefone: FONE, nome: 'Marina Souza', retorno_prometido: 'amanhã às 8h',
    });
    expect(resultadosDasFerramentas()[0]).toMatchObject({ registrada: true, retorno_previsto: 'amanhã às 8h' });
    expect(notifyCompany).toHaveBeenCalledWith(AURA, expect.objectContaining({ title: 'Pendência de suporte' }));
  });

  it('plano e preço: responde com a tabela do prompt, sem ferramenta', async () => {
    const conv = conversaCom(['quanto custa o plano?']);
    roteiro(diz('O Aura Essencial sai por R$ 89,00 por mês.'));

    const r = await responder(conv);

    expect(callClaude.mock.calls[0][0].system).toContain('R$ 89,00 por mês no mensal');
    expect(r.temas).toContain('planos-e-trial');
    expect(world.events).toHaveLength(0);
  });

  it('trial: identifica pelo telefone e estende 7 dias', async () => {
    cadastrar();
    const conv = conversaCom(['meu teste acabou, consegue mais uns dias?']);
    roteiro(usa('consultar_conta_pelo_telefone'), usa('estender_trial'), diz('Pronto, liberei mais 7 dias.'));

    await responder(conv);

    const [consulta, ext] = resultadosDasFerramentas();
    expect(consulta).toMatchObject({ identificado: true });
    expect(consulta.contas[0]).toMatchObject({ situacao: 'teste_vencido', pode_pedir_mais_dias_de_teste: true });
    expect(ext).toMatchObject({ estendido: true, dias: 7, teste_vai_ate: '21/10/2026' });
    expect(world.companies[LOJA].trial_ends_at).toEqual(new Date(brt(23).getTime() + 7 * DIA_MS));
    expect(eventos('ferramenta_suporte').map((e) => e.detail.ferramenta)).toEqual(['consultar_conta_pelo_telefone', 'estender_trial']);
  });

  it('link do checkout: URL do app + mensagem + tabela + promoção vigente', async () => {
    const conv = conversaCom(['quero assinar, me manda o link']);
    roteiro(usa('link_do_checkout'), diz('É por aqui: https://app.getaura.com.br/checkout'));

    await responder(conv);

    const [r] = resultadosDasFerramentas();
    expect(r.link).toBe('https://app.getaura.com.br/checkout');
    expect(r.mensagem).toContain('https://app.getaura.com.br/checkout');
    expect(r.planos).toHaveLength(3);
    expect(r.planos[0]).toMatchObject({ mensal: 'R$ 89,00', anual_por_mes: 'R$ 74,17' });
    expect(r.promocao_vigente.titulo).toBe('Assine até 31/10 e não pague novembro');
  });

  it('link do checkout: promoção some depois do prazo; APP_URL do ambiente vale', async () => {
    process.env.APP_URL = 'https://staging.getaura.com.br/';
    const conv = conversaCom(['link pra assinar']);
    const ctx = await ctxDe(conv, new Date('2026-11-02T15:00:00Z'));
    const r = await suporte.executarFerramenta(ctx, 'link_do_checkout', {});
    expect(r.link).toBe('https://staging.getaura.com.br/checkout');
    expect(r.promocao_vigente).toBeNull();
  });

  it('agendar: grava o pedido com 2 opções e avisa que o Caio confirma', async () => {
    cadastrar();
    const conv = conversaCom(['queria conversar com o Caio sobre migrar meu estoque']);
    roteiro(usa('agendar_conversa', { assunto: 'Migrar o estoque do sistema antigo' }), diz('Anotei: quinta às 10h ou às 15h. O Caio confirma.'));

    await responder(conv);

    expect(world.agendamentos).toHaveLength(1);
    expect(world.agendamentos[0]).toMatchObject({
      hub_company_id: AURA, conversation_id: 'conv-1', company_id: LOJA, telefone: FONE, nome: 'Marina Souza',
      assunto: 'Migrar o estoque do sistema antigo', duracao_minutos: 20, status: 'pendente',
      opcoes: ['2026-10-15T10:00:00-03:00', '2026-10-15T15:00:00-03:00'],
    });
    const [r] = resultadosDasFerramentas();
    expect(r).toMatchObject({ pedido_gravado: true, status: 'pendente', opcoes: ['quinta, 15/10 às 10h', 'quinta, 15/10 às 15h'] });
    expect(r.aviso).toMatch(/NÃO está marcado/);
  });

  it('não sei: anota e promete o retorno do relógio', async () => {
    const conv = conversaCom(['vocês integram com a maquininha da Stone?']);
    roteiro(usa('registrar_pendencia', { tipo: 'nao_sei', resumo: 'Pergunta se integra com maquininha Stone' }), diz('Não sei te dizer; anotei e o Caio retorna hoje às 8h.'));

    await responder(conv, brt(3));

    expect(callClaude.mock.calls[0][0].system).toContain('Nenhum tema da base bate');
    expect(eventos('pendencia_suporte')[0].detail).toMatchObject({ tipo: 'nao_sei', retorno_prometido: 'hoje às 8h' });
  });
});

// ── (4) identificação pelo telefone ─────────────────────────
describe('consultar_conta_pelo_telefone — só para dono, empresa ou membro', () => {
  it('telefone fora do cadastro: negado, nenhum dado de conta é lido', async () => {
    world.contas[LOJA] = { id: LOJA, plan: 'negocio', stage: 'cliente' };
    const conv = conversaCom(['qual o meu plano?']);
    const r = await suporte.executarFerramenta(await ctxDe(conv), 'consultar_conta_pelo_telefone', {});
    expect(r.identificado).toBe(false);
    expect(r.contas).toBeUndefined();
    expect(r.orientacao).toMatch(/Não mostre nem confirme dado de conta/);
    expect(listarClients360).not.toHaveBeenCalled();
  });

  it('mesmos 8 dígitos finais, DDD diferente: negado', async () => {
    cadastrar({ telefone: '(21) 98888-7777' });
    const conv = conversaCom(['qual o meu plano?']);
    const r = await suporte.executarFerramenta(await ctxDe(conv), 'consultar_conta_pelo_telefone', {});
    expect(r.identificado).toBe(false);
    expect(listarClients360).not.toHaveBeenCalled();
  });

  it.each([
    ['dono (users.phone)', 'dono', '11988887777'],
    ['empresa (companies.phone)', 'empresa', '+55 (11) 98888-7777'],
    ['membro ativo', 'membro', '(11) 8888-7777'], // cadastro antigo, sem o nono dígito
  ])('telefone bate com %s: devolve plano, teste, produtos, vendas e Caixa', async (_n, vinculo, telefone) => {
    cadastrar({ vinculo, telefone, conta: { stage: 'trial', trial_days_left: 2, days_since_expiry: null, trial_ends_at: new Date('2026-10-16T15:00:00Z') } });
    world.caixaAberto.add(LOJA);
    const conv = conversaCom(['como está minha conta?']);
    const r = await suporte.executarFerramenta(await ctxDe(conv), 'consultar_conta_pelo_telefone', {});
    expect(r.identificado).toBe(true);
    expect(r.contas).toEqual([{
      company_id: LOJA, nome: 'Loja da Marina', vinculo_do_telefone: vinculo,
      plano: 'Aura Negocio', situacao: 'em_teste', teste_termina_em: '16/10/2026',
      dias_de_teste_restantes: 2, dias_desde_o_fim_do_teste: null,
      produtos_cadastrados: 42, vendas_registradas: 7, ja_abriu_o_caixa: true, caixa_aberto_agora: true,
      pode_pedir_mais_dias_de_teste: true,
    }]);
  });

  it('o telefone é o DA CONVERSA: o que o modelo mandar no input é ignorado', async () => {
    cadastrar({ telefone: '(11) 97777-0000' });
    const conv = conversaCom(['meu número é outro, 11 97777-0000']);
    const r = await suporte.executarFerramenta(await ctxDe(conv), 'consultar_conta_pelo_telefone', { telefone: '11977770000' });
    expect(r.identificado).toBe(false);
    const q = world.queries.find((x) => x.sql.includes('-- suporte:contas-do-telefone'));
    expect(q.params).toEqual(['88887777']);
  });

  it('assinante em atraso aparece só como "assinante" — a Aurinha não fala de cobrança', async () => {
    cadastrar({ conta: { stage: 'cliente', billing_status: 'overdue', days_since_expiry: null } });
    const conv = conversaCom(['minha conta']);
    const r = await suporte.executarFerramenta(await ctxDe(conv), 'consultar_conta_pelo_telefone', {});
    expect(r.contas[0].situacao).toBe('assinante');
    expect(JSON.stringify(r)).not.toMatch(/overdue|atras/i);
  });
});

// ── (5) estender trial ──────────────────────────────────────
describe('estender_trial — uma vez por conta, só teste vencido ou a vencer', () => {
  it('estende 7 dias a partir de agora (vencido) e grava audit_log', async () => {
    cadastrar();
    const conv = conversaCom(['mais dias']);
    const r = await suporte.executarFerramenta(await ctxDe(conv), 'estender_trial', {});
    expect(r).toMatchObject({ estendido: true, dias: 7, conta: 'Loja da Marina' });
    expect(r._auditoria).toBeUndefined(); // não vai para o modelo
    expect(world.audit).toHaveLength(1);
    expect(world.audit[0]).toMatchObject({ company_id: LOJA, action: 'aurinha.trial_estendido' });
    expect(world.audit[0].metadata).toMatchObject({ dias: 7, telefone: FONE, vinculo: 'dono', conversa_id: 'conv-1' });
    expect(eventos('ferramenta_suporte')[0].detail).toMatchObject({ ferramenta: 'estender_trial', ok: true, company_id: LOJA });
  });

  it('teste a vencer (2 dias): soma 7 ao fim atual', async () => {
    const fim = new Date(brt(23).getTime() + 2 * DIA_MS);
    cadastrar({ conta: { stage: 'trial', trial_days_left: 2, trial_ends_at: fim } });
    const conv = conversaCom(['mais dias']);
    await suporte.executarFerramenta(await ctxDe(conv), 'estender_trial', {});
    expect(world.companies[LOJA].trial_ends_at).toEqual(new Date(fim.getTime() + 7 * DIA_MS));
  });

  it('SÓ UMA VEZ: a segunda tentativa é negada, em outra conversa e em outro dia', async () => {
    cadastrar();
    const conv = conversaCom(['mais dias']);
    await suporte.executarFerramenta(await ctxDe(conv), 'estender_trial', {});
    const depois = world.companies[LOJA].trial_ends_at;

    // semanas depois, teste vencido de novo, conversa nova (limite por conversa zerado)
    world.events.length = 0;
    world.contas[LOJA] = { ...world.contas[LOJA], stage: 'vencido' };
    const r = await suporte.executarFerramenta(await ctxDe({ ...conv, id: 'conv-2' }, brt(23, 0, 30)), 'estender_trial', {});

    expect(r).toMatchObject({ estendido: false, motivo: 'ja_estendido_uma_vez' });
    expect(world.companies[LOJA].trial_ends_at).toEqual(depois);
    expect(world.audit).toHaveLength(1);
  });

  it('duas conversas ao mesmo tempo: o índice único (23505) segura a segunda', async () => {
    cadastrar();
    world.auditErro = Object.assign(new Error('duplicate key'), { code: '23505' });
    const antes = world.companies[LOJA].trial_ends_at;
    const conv = conversaCom(['mais dias']);
    const r = await suporte.executarFerramenta(await ctxDe(conv), 'estender_trial', {});
    expect(r).toMatchObject({ estendido: false, motivo: 'ja_estendido_uma_vez' });
    expect(world.companies[LOJA].trial_ends_at).toEqual(antes);
  });

  it('UPDATE falhou: a auditoria é desfeita — a conta não perde a única vez dela', async () => {
    cadastrar();
    world.updateErro = new Error('connection reset');
    const conv = conversaCom(['mais dias']);
    await expect(suporte.executarFerramenta(await ctxDe(conv), 'estender_trial', {})).rejects.toThrow('connection reset');
    expect(world.audit).toHaveLength(0);
  });

  it.each([
    ['assinante', { stage: 'cliente' }, 'conta_ja_assinante'],
    ['teste com 6 dias pela frente', { stage: 'trial', trial_days_left: 6 }, 'teste_ainda_longe_do_fim'],
    ['conta cancelada', { stage: 'arquivo', archive_reason: 'cancelado' }, 'conta_fora_do_teste'],
    ['conta interna', { stage: 'interno' }, 'conta_fora_do_teste'],
  ])('negado para %s', async (_n, conta, motivo) => {
    cadastrar({ conta });
    const antes = world.companies[LOJA].trial_ends_at;
    const conv = conversaCom(['mais dias']);
    const r = await suporte.executarFerramenta(await ctxDe(conv), 'estender_trial', {});
    expect(r).toMatchObject({ estendido: false, motivo });
    expect(world.companies[LOJA].trial_ends_at).toEqual(antes);
    expect(world.audit).toHaveLength(0);
  });

  it('teste vencido há meses (nunca aderiu) também pode — uma vez', async () => {
    cadastrar({ conta: { stage: 'arquivo', archive_reason: 'nao_aderiu', days_since_expiry: 90 } });
    const conv = conversaCom(['quero voltar a testar']);
    const r = await suporte.executarFerramenta(await ctxDe(conv), 'estender_trial', {});
    expect(r.estendido).toBe(true);
  });

  it('telefone não identificado: negado; company_id de outra conta: negado', async () => {
    const conv = conversaCom(['mais dias']);
    world.contas[LOJA_2] = { id: LOJA_2, stage: 'vencido' };
    world.companies[LOJA_2] = { trial_ends_at: null, billing_status: 'trial' };

    let r = await suporte.executarFerramenta(await ctxDe(conv), 'estender_trial', { company_id: LOJA_2 });
    expect(r).toMatchObject({ estendido: false, motivo: 'telefone_nao_identificado' });

    cadastrar();
    r = await suporte.executarFerramenta(await ctxDe(conv), 'estender_trial', { company_id: LOJA_2 });
    expect(r).toMatchObject({ estendido: false, motivo: 'conta_nao_pertence_a_este_telefone' });
    expect(world.companies[LOJA_2].trial_ends_at).toBeNull();
    expect(world.audit).toHaveLength(0);
  });

  it('telefone com duas contas: pede qual, e estende só a escolhida', async () => {
    cadastrar();
    cadastrar({ id: LOJA_2, nome: 'Filial', vinculo: 'membro' });
    const conv = conversaCom(['mais dias']);
    const ctx = await ctxDe(conv);
    let r = await suporte.executarFerramenta(ctx, 'estender_trial', {});
    expect(r).toMatchObject({ estendido: false, motivo: 'mais_de_uma_conta' });
    expect(r.contas).toHaveLength(2);

    r = await suporte.executarFerramenta(ctx, 'estender_trial', { company_id: LOJA_2 });
    expect(r).toMatchObject({ estendido: true, conta: 'Filial' });
    expect(world.audit.map((a) => a.company_id)).toEqual([LOJA_2]);
  });
});

// ── (6) agendamento ─────────────────────────────────────────
describe('agendar_conversa — 2 opções em horário comercial, pendente', () => {
  const agendar = async (conv, input, agora = brt(23)) => suporte.executarFerramenta(await ctxDe(conv, agora), 'agendar_conversa', input);

  it('sem conta identificada grava com company_id null', async () => {
    const conv = conversaCom(['quero conhecer a Aura']);
    const r = await agendar(conv, { assunto: 'Conhecer a Aura' });
    expect(r.pedido_gravado).toBe(true);
    expect(world.agendamentos[0]).toMatchObject({ company_id: null, telefone: FONE, status: 'pendente' });
    expect(notifyCompany).toHaveBeenCalledWith(AURA, expect.objectContaining({ title: 'Pedido de conversa de 20 minutos' }));
  });

  it('sexta à noite: as opções pulam o fim de semana', async () => {
    const conv = conversaCom(['quero falar com o Caio']);
    await agendar(conv, { assunto: 'Dúvidas' }, brt(22, 0, 16));
    expect(world.agendamentos[0].opcoes).toEqual(['2026-10-19T10:00:00-03:00', '2026-10-19T15:00:00-03:00']);
  });

  it('preferência "tarde": mesmo período em dois dias úteis', async () => {
    const conv = conversaCom(['só posso à tarde']);
    await agendar(conv, { assunto: 'Dúvidas', preferencia: 'tarde' }, brt(22, 0, 15));
    expect(world.agendamentos[0].opcoes).toEqual(['2026-10-16T15:00:00-03:00', '2026-10-19T15:00:00-03:00']);
  });

  it('horários que a pessoa propôs, válidos: grava os dela', async () => {
    const conv = conversaCom(['quinta 9h ou sexta 17h30']);
    const r = await agendar(conv, { assunto: 'Dúvidas', opcoes: ['2026-10-16T17:30', '2026-10-15T09:00'] });
    expect(r.opcoes).toEqual(['quinta, 15/10 às 9h', 'sexta, 16/10 às 17h30']);
    expect(world.agendamentos[0].opcoes).toEqual(['2026-10-15T09:00:00-03:00', '2026-10-16T17:30:00-03:00']);
  });

  it.each([
    ['sábado', ['2026-10-17T10:00', '2026-10-15T10:00'], 'fim_de_semana'],
    ['20h', ['2026-10-15T20:00', '2026-10-15T10:00'], 'fora_do_horario_comercial'],
    ['17h50 (terminaria depois das 18h)', ['2026-10-15T17:50', '2026-10-15T10:00'], 'fora_do_horario_comercial'],
    ['8h', ['2026-10-15T08:00', '2026-10-15T10:00'], 'fora_do_horario_comercial'],
    ['no passado', ['2026-10-13T10:00', '2026-10-15T10:00'], 'muito_em_cima_da_hora'],
    ['daqui a 2 meses', ['2026-12-15T10:00', '2026-10-15T10:00'], 'longe_demais'],
  ])('recusa %s e não grava nada', async (_n, opcoes, erro) => {
    const conv = conversaCom(['pode ser?']);
    const r = await agendar(conv, { assunto: 'Dúvidas', opcoes });
    expect(r.erro).toBe(erro);
    expect(r.sugestao).toHaveLength(2);
    expect(world.agendamentos).toHaveLength(0);
  });

  it('valida forma: sem assunto, 1 opção só, opções iguais, formato torto', async () => {
    const conv = conversaCom(['oi']);
    expect((await agendar(conv, {})).erro).toBe('assunto_obrigatorio');
    expect((await agendar(conv, { assunto: 'x', opcoes: ['2026-10-15T10:00'] })).erro).toBe('informe_exatamente_2_opcoes');
    expect((await agendar(conv, { assunto: 'x', opcoes: ['2026-10-15T10:00', '2026-10-15T10:00'] })).erro).toBe('opcoes_iguais');
    expect((await agendar(conv, { assunto: 'x', opcoes: ['amanhã cedo', '2026-10-15T10:00'] })).erro).toBe('formato_invalido');
    expect(world.agendamentos).toHaveLength(0);
  });

  it('já existe pedido pendente deste telefone: não cria outro', async () => {
    const conv = conversaCom(['quero falar com o Caio']);
    await agendar(conv, { assunto: 'Dúvidas' });
    world.events.length = 0; // outra conversa/dia: o limite por conversa não é o que segura
    const r = await agendar(conv, { assunto: 'De novo' });
    expect(r).toMatchObject({ ja_existe_pedido_pendente: true, opcoes: ['quinta, 15/10 às 10h', 'quinta, 15/10 às 15h'] });
    expect(world.agendamentos).toHaveLength(1);
  });

  it('migration 380 pendente (42P01): orienta a registrar pendência, sem lançar', async () => {
    world.agendaAusente = true;
    const conv = conversaCom(['quero falar com o Caio']);
    const r = await agendar(conv, { assunto: 'Dúvidas' });
    expect(r.erro).toBe('agenda_indisponivel');
  });
});

// ── (7) pendência ───────────────────────────────────────────
describe('registrar_pendencia', () => {
  it('grava com a conta identificada e corta textos longos', async () => {
    cadastrar();
    const conv = conversaCom(['deu erro']);
    const r = await suporte.executarFerramenta(await ctxDe(conv, brt(11)), 'registrar_pendencia', {
      tipo: 'cobranca', resumo: 'x'.repeat(900), detalhes: 'y'.repeat(3000),
    });
    expect(r).toMatchObject({ registrada: true, retorno_previsto: 'ainda hoje, em horário comercial' });
    const d = eventos('pendencia_suporte')[0].detail;
    expect(d.tipo).toBe('cobranca');
    expect(d.resumo).toHaveLength(500);
    expect(d.detalhes).toHaveLength(1500);
    expect(d.contas).toEqual([{ company_id: LOJA, nome: 'Loja da Marina' }]);
  });

  it('sem resumo não grava; tipo desconhecido vira "outro"', async () => {
    const conv = conversaCom(['oi']);
    const ctx = await ctxDe(conv);
    expect((await suporte.executarFerramenta(ctx, 'registrar_pendencia', { tipo: 'nao_sei', resumo: '  ' })).erro).toBe('resumo_obrigatorio');
    expect(eventos('pendencia_suporte')).toHaveLength(0);
    await suporte.executarFerramenta(ctx, 'registrar_pendencia', { tipo: 'inventado', resumo: 'algo' });
    expect(eventos('pendencia_suporte')[0].detail.tipo).toBe('outro');
  });

  it('migration 380 pendente (CHECK do tipo, 23514): não lança e mantém o prazo', async () => {
    const conv = conversaCom(['oi']);
    db.query.mockImplementation((sql, params) => {
      if (/INSERT INTO hub_agent_events/.test(String(sql))) {
        return Promise.reject(Object.assign(new Error('violates check constraint'), { code: '23514' }));
      }
      return handler(world)(sql, params);
    });
    const r = await suporte.executarFerramenta(await ctxDe(conv), 'registrar_pendencia', { tipo: 'nao_sei', resumo: 'algo' });
    expect(r).toMatchObject({ registrada: false, retorno_previsto: 'amanhã às 8h' });
  });
});

// ── (8) limite por ferramenta ───────────────────────────────
describe('limite de uso por conversa', () => {
  it('registrar_pendencia: a 4ª na mesma conversa é barrada (inclusive em outra rodada)', async () => {
    const conv = conversaCom(['oi']);
    const ctx = await ctxDe(conv);
    for (let i = 0; i < 3; i++) {
      expect((await suporte.executarFerramenta(ctx, 'registrar_pendencia', { tipo: 'outro', resumo: `p${i}` })).registrada).toBe(true);
    }
    expect((await suporte.executarFerramenta(ctx, 'registrar_pendencia', { tipo: 'outro', resumo: 'p4' })).erro).toBe('limite_de_uso_atingido');

    // rodada seguinte: o limite vem dos eventos gravados
    const novo = await ctxDe(conv);
    expect(novo.usos.registrar_pendencia).toBe(3);
    expect((await suporte.executarFerramenta(novo, 'registrar_pendencia', { tipo: 'outro', resumo: 'p5' })).erro).toBe('limite_de_uso_atingido');
    expect(eventos('pendencia_suporte')).toHaveLength(3);
  });

  it('uso que falhou na validação não gasta o limite', async () => {
    const conv = conversaCom(['oi']);
    const ctx = await ctxDe(conv);
    await suporte.executarFerramenta(ctx, 'agendar_conversa', { assunto: 'x', opcoes: ['2026-10-17T10:00', '2026-10-15T10:00'] });
    const r = await suporte.executarFerramenta(ctx, 'agendar_conversa', { assunto: 'x' });
    expect(r.pedido_gravado).toBe(true);
    expect((await suporte.executarFerramenta(ctx, 'agendar_conversa', { assunto: 'y' })).erro).toBe('limite_de_uso_atingido');
  });

  it('ferramenta desconhecida (ou de outra persona) não executa', async () => {
    const conv = conversaCom(['oi']);
    const ctx = await ctxDe(conv);
    expect((await suporte.executarFerramenta(ctx, 'buscar_produtos', { termo: 'x' })).erro).toMatch(/desconhecida/);
    expect((await suporte.executarFerramenta(ctx, 'constructor', {})).erro).toMatch(/desconhecida/);
  });

  it('ferramenta que lança vira { erro } para o modelo — a rodada continua', async () => {
    cadastrar();
    world.updateErro = new Error('connection reset');
    const conv = conversaCom(['mais dias']);
    roteiro(usa('estender_trial'), diz('Não consegui agora; o Caio continua daqui.'));
    const r = await responder(conv);
    expect(resultadosDasFerramentas()[0].erro).toBe('connection reset');
    expect(r.texto).toContain('o Caio continua daqui');
  });
});

// ── (9) responderNoHub ──────────────────────────────────────
describe('responderNoHub — o stub virou a persona', () => {
  const msg = (id, texto, quando) => ({
    id, from: FONE, type: 'text', text: { body: texto }, timestamp: String(Math.floor(quando.getTime() / 1000)),
  });

  it('de noite: a resposta do modelo entra na fila com a assinatura', async () => {
    roteiro(diz('Oi, Marina! Como posso te ajudar?'));
    const r = await hubWhatsapp.registrarInbound(TENANT, msg('wamid.1', 'Oi, preciso de ajuda', brt(23)), { nome: 'Marina', agora: brt(23) });

    expect(r).toMatchObject({ ok: true, avaliado: true, respondeu: true });
    expect(world.outbox).toHaveLength(1);
    expect(world.outbox[0]).toMatchObject({
      company_id: AURA, to_phone: FONE, kind: 'text', status: 'pending', source_type: 'aurinha',
      text_body: `Oi, Marina! Como posso te ajudar?\n\n${suporte.ASSINATURA}`,
    });
    expect(callClaude.mock.calls[0][0].messages[0]).toEqual({ role: 'user', content: 'Oi, preciso de ajuda' });
    expect(world.convs[0].aguardando_resposta_desde).toBeNull();
  });

  it('de dia: respeita o relógio — o modelo só é chamado depois dos 15 minutos', async () => {
    roteiro(diz('Oi! Em que posso ajudar?'));
    await hubWhatsapp.registrarInbound(TENANT, msg('wamid.d', 'Oi', brt(10)), { agora: brt(10) });
    expect(callClaude).not.toHaveBeenCalled();
    expect(world.outbox).toHaveLength(0);

    await hubWhatsapp.processarPendentes({ agora: brt(10, 14) });
    expect(callClaude).not.toHaveBeenCalled();

    const r = await hubWhatsapp.processarPendentes({ agora: brt(10, 15) });
    expect(r.respondidas).toBe(1);
    expect(callClaude).toHaveBeenCalledTimes(1);
    expect(world.outbox[0].text_body).toContain(suporte.ASSINATURA);
  });

  it('humano já respondeu depois do cliente: o modelo nem é chamado', async () => {
    const conv = conversaCom(['Oi'], { last_inbound_at: brt(22), ultima_mensagem_humana_em: brt(22, 5) });
    const texto = await hubWhatsapp.responderNoHub(conv, { agora: brt(23) });
    expect(texto).toBeNull();
    expect(callClaude).not.toHaveBeenCalled();
  });

  it('erro do modelo: cai no texto fixo e registra o erro', async () => {
    callClaude.mockRejectedValue(new Error('Claude API error 529: overloaded'));
    await hubWhatsapp.registrarInbound(TENANT, msg('wamid.e', 'Oi', brt(23)), { agora: brt(23) });

    expect(world.outbox).toHaveLength(1);
    expect(world.outbox[0].text_body).toBe(hubWhatsapp.TEXTO_FIXO);
    expect(hubWhatsapp.TEXTO_FIXO).toBe('Oi! Aqui é a Aurinha, da Aura. Anotei sua mensagem e o Caio te responde às 8h.');
    const erro = eventos('erro')[0];
    expect(erro.detail).toMatchObject({ origem: 'persona_suporte' });
    expect(erro.detail.message).toContain('529');
  });

  it('modelo devolveu vazio, ou ficou pedindo ferramenta sem parar: texto fixo', async () => {
    roteiro(diz('   '));
    await hubWhatsapp.registrarInbound(TENANT, msg('wamid.v', 'Oi', brt(23)), { agora: brt(23) });
    expect(world.outbox[0].text_body).toBe(hubWhatsapp.TEXTO_FIXO);

    world.outbox.length = 0;
    callClaude.mockReset();
    callClaude.mockImplementation(async () => usa('link_do_checkout'));
    await hubWhatsapp.registrarInbound(TENANT, msg('wamid.loop', 'Oi de novo', brt(23, 1)), { agora: brt(23, 1) });
    expect(callClaude.mock.calls.length).toBeLessThanOrEqual(7);
    expect(world.outbox.filter((o) => o.text_body !== hubWhatsapp.TEXTO_FIXO)).toHaveLength(0);
  });

  it('texto fixo não se repete na rajada; resposta normal anterior não o bloqueia', async () => {
    roteiro(diz('Oi! Como posso ajudar?'));
    await hubWhatsapp.registrarInbound(TENANT, msg('wamid.a', 'Oi', brt(23)), { agora: brt(23) });
    callClaude.mockReset();
    callClaude.mockRejectedValue(new Error('fora do ar'));
    await hubWhatsapp.registrarInbound(TENANT, msg('wamid.b', 'alô', brt(23, 1)), { agora: brt(23, 1) });
    await hubWhatsapp.registrarInbound(TENANT, msg('wamid.c', '???', brt(23, 2)), { agora: brt(23, 2) });

    expect(world.outbox.map((o) => o.text_body === hubWhatsapp.TEXTO_FIXO)).toEqual([false, true]);
  });

  it('limite por hora: na 9ª resposta da hora a Aurinha se cala e o modelo não é chamado', async () => {
    const conv = conversaCom(['mais uma']);
    for (let i = 0; i < hubWhatsapp.MAX_RESPOSTAS_POR_HORA; i++) {
      world.outbox.push({ id: `o${i}`, hub_conversation_id: conv.id, source_type: 'aurinha', status: 'sent', text_body: 'x' });
    }
    roteiro(diz('não deveria sair'));

    const r = await hubWhatsapp.avaliarConversa(conv, TENANT, { agora: brt(23) });

    expect(r).toMatchObject({ respondeu: false, motivo: 'SEM_RESPOSTA' });
    expect(callClaude).not.toHaveBeenCalled();
    expect(world.outbox).toHaveLength(hubWhatsapp.MAX_RESPOSTAS_POR_HORA);
    expect(hubWhatsapp.MAX_RESPOSTAS_POR_HORA).toBe(8);
  });

  it('abaixo do limite (7 na hora) ainda responde; respostas puladas não contam', async () => {
    const conv = conversaCom(['mais uma']);
    for (let i = 0; i < 7; i++) world.outbox.push({ id: `o${i}`, hub_conversation_id: conv.id, source_type: 'aurinha', status: 'sent', text_body: 'x' });
    for (let i = 0; i < 5; i++) world.outbox.push({ id: `s${i}`, hub_conversation_id: conv.id, source_type: 'aurinha', status: 'skipped', text_body: 'x' });
    roteiro(diz('Claro!'));
    const r = await hubWhatsapp.avaliarConversa(conv, TENANT, { agora: brt(23) });
    expect(r.respondeu).toBe(true);
  });

  it('tamanho: resposta longa é cortada em frase inteira, e a assinatura continua lá', async () => {
    const longa = Array.from({ length: 60 }, (_, i) => `Esta é a frase número ${i + 1} da resposta.`).join(' ');
    const out = suporte.finalizarResposta(longa);
    const corpo = out.replace(`\n\n${suporte.ASSINATURA}`, '');
    expect(corpo.length).toBeLessThanOrEqual(suporte.MAX_CARACTERES);
    expect(corpo.endsWith('.')).toBe(true);
    expect(out.endsWith(suporte.ASSINATURA)).toBe(true);
  });

  it('acabamento: tira negrito e assinatura que o modelo colocou por conta; vazio lança', () => {
    expect(suporte.finalizarResposta('Oi **Marina**!\n\n— Aurinha')).toBe(`Oi Marina!\n\n${suporte.ASSINATURA}`);
    expect(() => suporte.finalizarResposta('')).toThrow();
  });

  it('histórico: últimas 20 mensagens, falas seguidas unidas, assinatura antiga fora', async () => {
    const falas = [];
    for (let i = 1; i <= 12; i++) {
      falas.push({ author: 'cliente', content: `pergunta ${i}` });
      falas.push({ author: 'aurinha', content: `resposta ${i}\n\n${suporte.ASSINATURA}` });
    }
    falas.push({ author: 'humano', content: 'Oi, aqui é o Caio.' });
    falas.push({ author: 'cliente', content: 'obrigada' });
    falas.push({ author: 'cliente', content: 'e as etiquetas?' });
    const conv = conversaCom(falas);
    roteiro(diz('Sobre etiquetas: …'));

    await responder(conv);

    const q = world.queries.find((x) => x.sql.includes('-- suporte:historico'));
    expect(q.params).toEqual(['conv-1', 20]);
    const { messages, system } = callClaude.mock.calls[0][0];
    expect(messages[0]).toEqual({ role: 'user', content: 'pergunta 5' });
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'obrigada\ne as etiquetas?' });
    expect(messages[messages.length - 2]).toEqual({ role: 'assistant', content: 'resposta 12\nOi, aqui é o Caio.' });
    expect(JSON.stringify(messages)).not.toContain('mesma Aurinha');
    for (let i = 1; i < messages.length; i++) expect(messages[i].role).not.toBe(messages[i - 1].role);
    expect(system).toContain('Etiquetas de preço');
  });

  it('última fala não é do cliente: nada a responder, modelo não é chamado', async () => {
    const conv = conversaCom(['Oi', { author: 'aurinha', content: 'Oi! Como posso ajudar?' }]);
    const r = await responder(conv);
    expect(r).toMatchObject({ texto: null, motivo: 'SEM_FALA_DO_CLIENTE' });
    expect(callClaude).not.toHaveBeenCalled();
  });

  it('duas avaliações da mesma fala (webhook + job): o modelo roda uma vez só', async () => {
    const conv = conversaCom(['Oi']);
    let soltar;
    callClaude.mockImplementationOnce(() => new Promise((res) => { soltar = () => res(diz('Oi!')); }));
    const a = hubWhatsapp.avaliarConversa(conv, TENANT, { agora: brt(23) });
    const b = await hubWhatsapp.avaliarConversa(conv, TENANT, { agora: brt(23) });
    expect(b).toMatchObject({ respondeu: false, motivo: 'JA_RESPONDIDA' });
    await new Promise((r) => setImmediate(r));
    soltar();
    expect((await a).respondeu).toBe(true);
    expect(callClaude).toHaveBeenCalledTimes(1);
    expect(world.outbox).toHaveLength(1);
  });
});

// ── extensão de trial: a regra é a mesma do admin ───────────
describe('trialExtension — regra compartilhada com o admin', () => {
  const { novoFimDoTrial } = require('../src/services/trialExtension');
  const agora = brt(12);

  it('vencido ou sem data conta de agora; ativo soma ao fim atual', () => {
    expect(novoFimDoTrial(null, 7, agora)).toEqual(new Date(agora.getTime() + 7 * DIA_MS));
    expect(novoFimDoTrial(new Date(agora.getTime() - DIA_MS), 7, agora)).toEqual(new Date(agora.getTime() + 7 * DIA_MS));
    const fim = new Date(agora.getTime() + 3 * DIA_MS);
    expect(novoFimDoTrial(fim, 7, agora)).toEqual(new Date(fim.getTime() + 7 * DIA_MS));
  });
});
