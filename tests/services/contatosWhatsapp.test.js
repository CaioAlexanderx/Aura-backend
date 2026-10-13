// ============================================================
// Contatos do WhatsApp da Aura no painel: janelas de contato, bloco,
// série por hora, mediana e alerta de contato sem resposta.
//
// Banco de mentira só do hub (hubDb): responde pelo marcador `-- contatos:`
// que as consultas de services/contatosWhatsapp.js carregam.
// ============================================================
'use strict';

const cw = require('../../src/services/contatosWhatsapp');
const contatos = require('../../src/services/painelBlocos/contatos');
const { alertasDeContatos } = require('../../src/services/painelAlertas');

const AURA = 'eeeeeeee-0000-4000-8000-000000000001';
const EMPRESA = 'aaaaaaaa-0000-4000-8000-000000000002';
const conv = (n) => `dddddddd-0000-4000-8000-00000000000${n}`;
const HOJE = '2026-10-13';

const hubDb = ({ mensagens = [], conversas = [], eventos = [], empresas = [], leads = [] } = {}) => ({
  query: jest.fn(async (sql) => {
    const s = sql.replace(/\s+/g, ' ');
    if (s.includes('FROM sales_leads')) return { rows: leads };
    if (s.includes('-- contatos:mensagens ')) return { rows: mensagens };
    if (s.includes('-- contatos:conversas ')) return { rows: conversas };
    if (s.includes('-- contatos:eventos ')) return { rows: eventos };
    if (s.includes('-- contatos:empresas ')) return { rows: empresas };
    throw new Error('SQL inesperado: ' + s.slice(0, 120));
  }),
});

const msg = (c, direction, author, iso, content = 'oi') => ({ conversation_id: conv(c), direction, author, content, created_at: iso });
const entra = (c, iso, content) => msg(c, 'inbound', 'cliente', iso, content);
const humano = (c, iso) => msg(c, 'outbound', 'humano', iso, 'resposta');
const aurinha = (c, iso) => msg(c, 'outbound', 'aurinha', iso, 'Oi! Aqui é a Aurinha');
const conversa = (n, extra = {}) => ({
  id: conv(n), external_id: `551199990000${n}`, customer_name: null, status: 'ia',
  last_inbound_at: null, ultima_mensagem_humana_em: null, ...extra,
});

beforeEach(() => { process.env.AURA_COMPANY_ID = AURA; });
afterEach(() => { delete process.env.AURA_COMPANY_ID; jest.restoreAllMocks(); });

describe('telefone', () => {
  test('chave ignora 55, o 9 extra e a pontuação', () => {
    const k = cw.chaveTelefone('5511999900002');
    expect(cw.chaveTelefone('(11) 99990-0002')).toBe(k);
    expect(cw.chaveTelefone('+55 11 99990-0002')).toBe(k);
    expect(cw.chaveTelefone('11 9990-0002')).toBe(k);
    expect(cw.chaveTelefone('119')).toBeNull();
  });

  test('formato e máscara: só o fim aparece na lista', () => {
    expect(cw.formatarTelefone('5511999900002')).toBe('+55 11 99990-0002');
    expect(cw.mascararTelefone('5511999900002')).toBe('+55 11 *****-0002');
    expect(cw.mascararTelefone('551133334444')).toBe('+55 11 ****-4444'); // fixo
    expect(cw.mascararTelefone('15556309005')).toBe('+15*****9005'); // internacional
    expect(cw.mascararTelefone(null)).toBeNull();
    expect(cw.linkWhatsapp('+55 11 99990-0002')).toBe('https://wa.me/5511999900002');
  });

  test('duração em português', () => {
    expect([0.4, 5, 59.6, 90, 120, 261].map(cw.duracao)).toEqual(['menos de 1 min', '5 min', '1 h', '1 h 30 min', '2 h', '4 h 21 min']);
  });
});

describe('montarContatos — a janela de 24h', () => {
  const conversas = new Map([[conv(1), conversa(1)]]);

  test('quem volta depois de 24h de silêncio é um contato novo; dentro de 24h é o mesmo', () => {
    const r = cw.montarContatos({
      conversas,
      mensagens: [
        entra(1, '2026-10-10T13:00:00.000Z'),
        humano(1, '2026-10-10T13:10:00.000Z'),
        entra(1, '2026-10-11T08:00:00.000Z'), // 18h50 depois: mesma janela
        entra(1, '2026-10-12T14:00:00.000Z'), // 30h depois: contato novo
      ],
    });
    expect(r.map((c) => c.chegou_em.toISOString())).toEqual(['2026-10-12T14:00:00.000Z', '2026-10-10T13:00:00.000Z']);
    expect(r[1].mensagens_do_cliente).toBe(2);
    expect(r[1].espera_min).toBe(10);
    expect(r[0].situacao).toBe('sem_resposta');
  });

  test('fala nossa sem o cliente ter chamado não abre contato (nem a resposta dele logo depois)', () => {
    const r = cw.montarContatos({
      conversas,
      mensagens: [
        humano(1, '2026-10-10T13:00:00.000Z'),
        entra(1, '2026-10-10T15:00:00.000Z'),
      ],
    });
    expect(r).toEqual([]);
  });

  test('cliente e resposta no mesmo segundo: o cliente vem primeiro', () => {
    const [c] = cw.montarContatos({
      conversas,
      mensagens: [aurinha(1, '2026-10-13T02:40:00.000Z'), entra(1, '2026-10-13T02:40:00.000Z')],
    });
    expect(c.situacao).toBe('aurinha');
  });

  test('situação: humano > Aurinha > ninguém; resposta parada ou pulada não conta', () => {
    const base = '2026-10-13T08:00:00.000Z';
    const ev = (c, type, detail, iso) => ({ conversation_id: conv(c), type, detail, created_at: iso });
    const cs = new Map([1, 2, 3, 4].map((n) => [conv(n), conversa(n)]));
    const r = cw.montarContatos({
      conversas: cs,
      mensagens: [1, 2, 3, 4].map((n) => entra(n, base)),
      eventos: [
        ev(1, 'resposta_enfileirada', { status: 'pending', parada: false }, '2026-10-13T08:00:05.000Z'),
        ev(1, 'mensagem_humana', {}, '2026-10-13T08:30:00.000Z'),
        ev(2, 'resposta_enfileirada', { status: 'pending', parada: false }, '2026-10-13T08:00:05.000Z'),
        ev(3, 'resposta_enfileirada', { status: 'pending', parada: true, motivo: 'JANELA_FECHADA_SEM_TEMPLATE' }, '2026-10-13T08:00:05.000Z'),
        ev(4, 'resposta_enfileirada', { status: 'skipped', parada: false }, '2026-10-13T08:00:05.000Z'),
      ],
    });
    const por = Object.fromEntries(r.map((c) => [c.conversa_id, c.situacao]));
    expect(por).toEqual({ [conv(1)]: 'humano', [conv(2)]: 'aurinha', [conv(3)]: 'sem_resposta', [conv(4)]: 'sem_resposta' });
  });

  test('resposta humana pelo painel (só ultima_mensagem_humana_em) conta na janela mais recente', () => {
    const cs = new Map([[conv(1), conversa(1, { ultima_mensagem_humana_em: '2026-10-13T09:00:00.000Z' })]]);
    const [c] = cw.montarContatos({ conversas: cs, mensagens: [entra(1, '2026-10-13T08:00:00.000Z')] });
    expect(c.situacao).toBe('humano');
    expect(c.espera_min).toBe(60);
    expect(c.pendente_desde).toBeNull();
  });

  test('cliente fala de novo depois da resposta humana: situação segue "Caio", mas volta a esperar', () => {
    const [c] = cw.montarContatos({
      conversas,
      mensagens: [
        entra(1, '2026-10-13T08:00:00.000Z'),
        humano(1, '2026-10-13T08:10:00.000Z'),
        entra(1, '2026-10-13T09:00:00.000Z'),
      ],
    });
    expect(c.situacao).toBe('humano');
    expect(c.pendente_desde.toISOString()).toBe('2026-10-13T09:00:00.000Z');
  });
});

describe('bloco contatos', () => {
  test('sem AURA_COMPANY_ID: zero WhatsApp, só o site, nenhuma consulta ao hub', async () => {
    delete process.env.AURA_COMPANY_ID;
    const db = hubDb({
      leads: [{ id: 'l1', name: 'Marina', phone: '11988880001', city: 'Jacareí', source: 'site', status: 'new', created_at: '2026-10-11T17:20:00.000Z', converted_company_id: null }],
    });
    const b = await contatos.calcular({ hoje: HOJE, periodo: 30, db });
    expect(b.valor).toBe(1);
    expect(b.lista).toHaveLength(1);
    expect(b.lista[0].canal).toBe('site');
    expect(db.query.mock.calls.every((c) => !c[0].includes('-- contatos:'))).toBe(true);
  });

  test('sem nenhum dado (número ligado, nada chegou): tudo zero, lista vazia, sem erro', async () => {
    const b = await contatos.calcular({ hoje: HOJE, periodo: 30, db: hubDb() });
    expect(b.valor).toBe(0);
    expect(b.lista).toEqual([]);
    expect(b.resumo).toBe('Nenhum contato no período');
    expect(b.serie).toHaveLength(14);
    expect(b.serie.every((p) => p.valor === 0)).toBe(true);
    expect(b.detalhe.series[1].pontos).toHaveLength(24);
    expect(b.detalhe.series[1].pontos.every((p) => p.valor === 0)).toBe(true);
    const ind = Object.fromEntries(b.detalhe.indicadores.map((i) => [i.rotulo, i.valor]));
    expect(ind['Sem resposta agora']).toBe(0);
    expect(ind['Primeira resposta (mediana)']).toBeNull();
    expect(ind['Respondidos pela Aurinha']).toBe(0);
    expect(ind['De madrugada (21h às 8h)']).toBe(0);
    expect(b.detalhe.insight).toBeNull();
  });

  test('hub sem a migration 375 (42P01): o bloco segue com o site', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const db = {
      query: jest.fn(async (sql) => {
        if (sql.includes('-- contatos:')) {
          const e = new Error('relation "hub_messages" does not exist');
          e.code = '42P01';
          throw e;
        }
        return { rows: [] };
      }),
    };
    const b = await contatos.calcular({ hoje: HOJE, periodo: 30, db });
    expect(b.valor).toBe(0);
    expect(b.lista).toEqual([]);
  });

  describe('com contatos', () => {
    // chegadas (BRT): 23h40 de 12/10, 05h30 de 13/10, 14h00 e 14h30 de 11/10
    const dados = () => ({
      conversas: [1, 2, 3, 4].map((n) => conversa(n, { customer_name: n === 1 ? 'Renata' : null })),
      mensagens: [
        entra(1, '2026-10-13T02:40:00.000Z', 'Oi, vocês fazem integração\ncom iFood?'),
        aurinha(1, '2026-10-13T02:40:20.000Z'),
        humano(1, '2026-10-13T03:40:00.000Z'), // 60 min
        entra(2, '2026-10-13T08:30:00.000Z'),
        aurinha(2, '2026-10-13T08:30:20.000Z'),
        entra(3, '2026-10-11T17:00:00.000Z'),
        humano(3, '2026-10-11T17:10:00.000Z'), // 10 min
        entra(4, '2026-10-11T17:30:00.000Z'),
        humano(4, '2026-10-11T17:50:00.000Z'), // 20 min
      ],
      eventos: [
        { conversation_id: conv(1), type: 'resposta_enfileirada', detail: { status: 'pending', parada: false }, created_at: '2026-10-13T02:40:19.000Z' },
        { conversation_id: conv(2), type: 'resposta_enfileirada', detail: { status: 'pending', parada: false }, created_at: '2026-10-13T08:30:19.000Z' },
      ],
      empresas: [{ company_id: EMPRESA, nome: 'Mercado Bela Vista', telefone: '(11) 99990-0001' }],
    });

    test('valor, indicadores, lista e mediana da primeira resposta', async () => {
      const b = await contatos.calcular({ hoje: HOJE, periodo: 30, db: hubDb(dados()) });
      expect(b.valor).toBe(4);
      const ind = Object.fromEntries(b.detalhe.indicadores.map((i) => [i.rotulo, i]));
      expect(ind['Sem resposta agora']).toMatchObject({ valor: 1, nota: '1 só com a Aurinha' });
      expect(ind['Respondidos pela Aurinha'].valor).toBe(2);
      expect(ind['De madrugada (21h às 8h)'].valor).toBe(2);
      // esperas: 60, 10 e 20 min → mediana 20 min
      expect(ind['Primeira resposta (mediana)']).toMatchObject({ valor: '20 min', nota: '3 respondidos' });

      expect(b.lista.map((l) => l.situacao)).toEqual(['Aurinha', 'Caio', 'Caio', 'Caio']);
      const renata = b.lista.find((l) => l.nome === 'Renata');
      expect(renata).toMatchObject({
        telefone: '+55 11 *****-0001', canal: 'whatsapp', tempo_ate_resposta: '1 h',
        empresa: 'Mercado Bela Vista', company_id: EMPRESA, conversa_id: conv(1),
      });
      // o telefone inteiro nunca sai na lista
      expect(JSON.stringify(b.lista)).not.toContain('5511999900001');
    });

    test('mediana com número par de contatos é a média dos dois do meio', async () => {
      const d = dados();
      d.mensagens = d.mensagens.filter((m) => m.conversation_id !== conv(1));
      d.eventos = [];
      const b = await contatos.calcular({ hoje: HOJE, periodo: 30, db: hubDb(d) });
      const ind = Object.fromEntries(b.detalhe.indicadores.map((i) => [i.rotulo, i]));
      // 10 e 20 min → 15 min
      expect(ind['Primeira resposta (mediana)'].valor).toBe('15 min');
    });

    test('série por dia (14) e por hora do dia (24, horário de Brasília)', async () => {
      const b = await contatos.calcular({ hoje: HOJE, periodo: 30, db: hubDb(dados()) });
      expect(b.serie).toHaveLength(14);
      expect(b.serie[13]).toEqual({ rotulo: '13/10', dia: '2026-10-13', valor: 1 }); // o das 05h30
      expect(b.serie[12]).toEqual({ rotulo: '12/10', dia: '2026-10-12', valor: 1 }); // o das 23h40
      expect(b.serie[11].valor).toBe(2); // 11/10: dois contatos

      const horas = b.detalhe.series[1].pontos;
      expect(horas).toHaveLength(24);
      expect(horas.map((p) => p.hora)).toEqual([...Array(24).keys()]);
      const emUso = horas.filter((p) => p.valor).map((p) => [p.hora, p.valor]);
      // 02:40Z = 23h40 BRT; 08:30Z = 5h30; 17:00Z e 17:30Z = 14h00 e 14h30
      expect(emUso).toEqual([[5, 1], [14, 2], [23, 1]]);
    });
  });
});

describe('alerta de contato sem resposta', () => {
  const um = (iso, extra = {}) => hubDb({
    conversas: [conversa(1, { customer_name: 'Marina', ...extra })],
    mensagens: [entra(1, iso)],
  });
  const tipos = async (db, agora) => (await alertasDeContatos({ db, agora: new Date(agora) })).map((a) => a.tipo);

  test('2h: 1h59 não avisa, 2h exatas não avisam, 2h01 avisa', async () => {
    const t = '2026-10-13T13:00:00.000Z'; // 10h00 BRT
    expect(await tipos(um(t), '2026-10-13T14:59:00.000Z')).toEqual([]);
    expect(await tipos(um(t), '2026-10-13T15:00:00.000Z')).toEqual([]);
    expect(await tipos(um(t), '2026-10-13T15:01:00.000Z')).toEqual(['contato_sem_resposta']);
  });

  test('21h: 20h59 avisa, 21h00 e 21h01 não (a Aurinha está de plantão)', async () => {
    const t = '2026-10-13T20:00:00.000Z'; // 17h00 BRT
    expect(await tipos(um(t), '2026-10-13T23:59:00.000Z')).toEqual(['contato_sem_resposta']); // 20h59
    expect(await tipos(um(t), '2026-10-14T00:00:00.000Z')).toEqual([]); // 21h00
    expect(await tipos(um(t), '2026-10-14T00:01:00.000Z')).toEqual([]); // 21h01
  });

  test('8h: 07h59 não avisa, 08h00 avisa o que ficou da noite', async () => {
    const t = '2026-10-13T05:00:00.000Z'; // 02h00 BRT
    expect(await tipos(um(t), '2026-10-13T10:59:00.000Z')).toEqual([]);
    expect(await tipos(um(t), '2026-10-13T11:00:00.000Z')).toEqual(['contato_sem_resposta']);
  });

  test('conteúdo: telefone, link wa.me, verbo, bloco e empresa vinculada', async () => {
    const db = hubDb({
      conversas: [conversa(1, { customer_name: 'Marina' })],
      mensagens: [entra(1, '2026-10-13T13:00:00.000Z')],
      empresas: [{ company_id: EMPRESA, nome: 'Mercado Bela Vista', telefone: '11 99990-0001' }],
    });
    const [a] = await alertasDeContatos({ db, agora: new Date('2026-10-13T16:30:00.000Z') });
    expect(a).toEqual({
      tipo: 'contato_sem_resposta',
      chave: conv(1),
      company_id: EMPRESA,
      titulo: 'Marina sem resposta há 3 h 30 min',
      detalhe: 'WhatsApp +55 11 99990-0001 · https://wa.me/5511999900001',
      verbo: 'Responder',
      bloco: 'contatos',
    });
  });

  test('quem já foi respondido por um humano não aparece; passou de 3 dias também não', async () => {
    const respondido = hubDb({
      conversas: [conversa(1)],
      mensagens: [entra(1, '2026-10-13T13:00:00.000Z'), humano(1, '2026-10-13T13:20:00.000Z')],
    });
    expect(await tipos(respondido, '2026-10-13T16:00:00.000Z')).toEqual([]);
    expect(await tipos(um('2026-10-09T13:00:00.000Z'), '2026-10-13T16:00:00.000Z')).toEqual([]);
  });

  test('sem AURA_COMPANY_ID: nenhuma consulta', async () => {
    delete process.env.AURA_COMPANY_ID;
    const db = um('2026-10-13T13:00:00.000Z');
    expect(await tipos(db, '2026-10-13T16:00:00.000Z')).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('os mais antigos primeiro, no máximo 10', async () => {
    const n = 12;
    const id = (i) => `dddddddd-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`;
    const db = hubDb({
      conversas: Array.from({ length: n }, (_, i) => ({ ...conversa(1), id: id(i), external_id: `5511999901${String(i).padStart(3, '0')}` })),
      mensagens: Array.from({ length: n }, (_, i) => ({
        conversation_id: id(i), direction: 'inbound', author: 'cliente', content: 'oi',
        created_at: new Date(Date.parse('2026-10-13T12:00:00.000Z') + i * 60000).toISOString(),
      })),
    });
    const r = await alertasDeContatos({ db, agora: new Date('2026-10-13T16:00:00.000Z') });
    expect(r).toHaveLength(10);
    expect(r[0].chave).toBe(id(0));
  });
});
