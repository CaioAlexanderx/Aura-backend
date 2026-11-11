// ============================================================
// AURA. — scripts/enviarBlackFriday.js com banco falso (11/11/2026)
//
//   - seleção dos públicos: o SQL leva os filtros comuns (SQL_ELEGIVEL,
//     "Não quer", novidades desligado, seguradas) e os de cada e-mail; a
//     variante sai do plano, do Studio e do atraso; 30 + 4 + 2 = 36 no
//     e-mail 2, com o BLACK50 para 34
//   - seguradas: fora mesmo que o banco as devolva
//   - dry-run: não chama o mailer nem grava no email_log; sem nome nem
//     e-mail na saída
//   - trava contra reenvio: quem já recebeu é pulado; duas rodadas mandam
//     uma vez só; falha de uma empresa não para o lote
//   - BLACK50 sem usos: o e-mail 2 para, salvo --sem-codigo
//   - --teste: só as cópias de cada variante, com "[TESTE]", sem banco
// ============================================================
'use strict';

const S = require('../scripts/enviarBlackFriday');

const AGORA = Date.parse('2026-11-11T13:00:00Z');
const ENV = { RESEND_API_KEY: 're_test', EMAIL_LINK_SECRET: 'segredo-teste', APP_URL: 'https://app.getaura.com.br' };
const limpo = (s) => String(s).replace(/\s+/g, ' ').trim();
const [SEG_STUDIO_ASSINANTE, SEG_STUDIO_TESTE, SEG_PEDIDO_CAIO] = S.SEGURADAS;

let seq = 0;
function linha(extra) {
  seq += 1;
  const id = `${String(seq).padStart(8, '0')}-0000-4000-8000-000000000000`;
  return {
    company_id: id, loja: `Loja ${seq}`, plan: 'negocio', billing_status: 'trial', vertical_active: null,
    user_id: `u-${seq}`, email: `dono${seq}@exemplo.com`, full_name: `Dona${seq} Silva`, ...extra,
  };
}

/**
 * Banco falso. `publico`: { 1: linhas, 2: linhas } (o que o SELECT do
 * público devolve); `codigo`: linha de access_codes; `log`: Map chave →
 * { status, tentativas }; `prefs`: { company_id: ligado }; `notas`:
 * { company_id: resultado }.
 */
function banco({ publico = {}, codigo = { max_uses: 10, uses: 1, is_active: true, expires_at: '2026-12-01T02:59:59Z' }, prefs = {}, notas = {} } = {}) {
  const log = new Map();
  const query = jest.fn(async (sql, params) => {
    const s = limpo(sql);
    if (s.startsWith('SELECT c.id AS company_id')) {
      const email = s.includes("OR c.billing_status = 'overdue'") ? 2 : 1;
      return { rows: publico[email] || [] };
    }
    if (s.startsWith('SELECT max_uses, uses')) return { rows: codigo ? [codigo] : [] };
    if (s.startsWith('SELECT chave_idempotencia FROM email_log')) {
      const rows = params[0]
        .filter((k) => log.has(k) && (['sent', 'reserved'].includes(log.get(k).status) || log.get(k).tentativas >= params[1]))
        .map((k) => ({ chave_idempotencia: k }));
      return { rows };
    }
    if (s.includes('FROM company_email_prefs WHERE company_id = $1 AND tipo = $2')) {
      return { rows: params[0] in prefs ? [{ ligado: prefs[params[0]], config: {} }] : [] };
    }
    if (s.startsWith('SELECT resultado, motivo FROM company_admin_notes')) {
      return { rows: notas[params[0]] ? [{ resultado: notas[params[0]], motivo: null }] : [] };
    }
    if (s.startsWith('INSERT INTO email_log')) {
      const k = params[0];
      const atual = log.get(k);
      if (atual && !(atual.status === 'failed' && atual.tentativas < params[7])) return { rows: [] };
      log.set(k, { status: 'reserved', tentativas: atual ? atual.tentativas + 1 : 1, tipo: params[1], companyId: params[2], metadata: params[6] });
      return { rows: [{ id: k }] };
    }
    if (s.startsWith('UPDATE email_log SET status = \'sent\'')) {
      log.get(params[0]).status = 'sent';
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('UPDATE email_log SET status = \'failed\'')) {
      log.get(params[0]).status = 'failed';
      return { rows: [], rowCount: 1 };
    }
    throw new Error('SQL inesperado: ' + s.slice(0, 90));
  });
  return { query, log };
}

/** O e-mail 2 de hoje: 30 do Negócio/Essencial, 4 do Studio, 2 em atraso. */
function publicoEmail2() {
  return [
    ...Array.from({ length: 28 }, () => linha({ plan: 'negocio' })),
    ...Array.from({ length: 2 }, () => linha({ plan: 'essencial' })),
    ...Array.from({ length: 4 }, () => linha({ vertical_active: 'studio' })),
    ...Array.from({ length: 2 }, () => linha({ billing_status: 'overdue' })),
  ];
}

function rodar(db, argv, extra = {}) {
  const saida = [];
  const enviar = extra.enviar || jest.fn(async () => ({ id: 're_1' }));
  const dormir = jest.fn(async () => {});
  return S.executar({
    args: S.lerArgs(argv), db, enviar, env: ENV, now: AGORA, log: (l) => saida.push(l), dormir, ...extra,
  }).then((r) => ({ r, saida: saida.join('\n'), enviar, dormir }));
}

beforeEach(() => {
  seq = 0;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('seleção dos públicos', () => {
  test('o SQL leva os filtros comuns e os de cada e-mail', () => {
    for (const n of [1, 2]) {
      const s = limpo(S.sqlPublico(n));
      expect(s).toContain('u.email_verified IS TRUE');
      expect(s).toContain('c.is_sandbox IS NOT TRUE');
      expect(s).toContain('u.is_staff IS NOT TRUE');
      expect(s).toContain('c.billing_owner_company_id IS NULL OR c.billing_owner_company_id = c.id');
      expect(s).toContain('c.is_active IS NOT FALSE');
      expect(s).toContain("ultima_nota.resultado = 'nao_quer'");
      expect(s).toContain("pref.tipo = 'novidades' AND pref.ligado IS FALSE");
      expect(s).toContain('c.id <> ALL($1::uuid[])');
    }
    const s1 = limpo(S.sqlPublico(1));
    expect(s1).toContain("COALESCE(c.vertical_active, '') <> 'studio'");
    expect(s1).toContain("c.billing_status = 'active'");
    expect(s1).toContain('c.trial_ends_at > $2::timestamptz');
    const s2 = limpo(S.sqlPublico(2));
    expect(s2).toContain('c.asaas_subscription_id IS NULL');
    expect(s2).toContain('c.trial_ends_at <= $2::timestamptz');
    expect(s2).toContain("OR c.billing_status = 'overdue'");
  });

  test('passa as seguradas e a hora ao banco', async () => {
    const db = banco();
    await S.selecionar(db, 1, { now: AGORA });
    const [, params] = db.query.mock.calls[0];
    expect(params[0]).toEqual([SEG_STUDIO_ASSINANTE, SEG_STUDIO_TESTE, SEG_PEDIDO_CAIO]);
    expect(params[1]).toBe(new Date(AGORA).toISOString());
  });

  test('e-mail 1: variante pelo plano (Negócio, Essencial, Expansão)', async () => {
    const db = banco({ publico: { 1: [linha({ plan: 'negocio' }), linha({ plan: 'essencial', billing_status: 'active' }), linha({ plan: 'expansao' })] } });
    const { alvos } = await S.selecionar(db, 1, { now: AGORA });
    expect(alvos.map((a) => a.variante)).toEqual(['negocio', 'essencial', 'expansao']);
  });

  test('e-mail 2: 30 + 4 Studio + 2 em atraso = 36, BLACK50 para 34', async () => {
    const db = banco({ publico: { 2: publicoEmail2() } });
    const { r } = await rodar(db, ['--email=2']);
    expect(r.total).toBe(36);
    expect(r.porVariante).toEqual({ negocio: 28, essencial: 2, studio: 4, atraso: 2 });
    expect(r.recebemCodigo).toBe(34);
    expect(r.usosRestantes).toBe(9);
  });

  test('e-mail 2: plano sem preço (Expansão) e conta sem e-mail ficam fora', async () => {
    const db = banco({ publico: { 2: [linha({ plan: 'expansao' }), linha({ email: '' }), linha()] } });
    const { alvos, fora } = await S.selecionar(db, 2, { now: AGORA });
    expect(alvos).toHaveLength(1);
    expect(fora).toEqual({ plano_sem_texto: 1, sem_email: 1 });
  });

  test('seguradas ficam fora mesmo que o banco as devolva', async () => {
    const db = banco({
      publico: {
        1: [linha({ company_id: SEG_STUDIO_TESTE }), linha()],
        2: [linha({ company_id: SEG_STUDIO_ASSINANTE, billing_status: 'overdue' }), linha()],
      },
    });
    const um = await S.selecionar(db, 1, { now: AGORA });
    const dois = await S.selecionar(db, 2, { now: AGORA });
    expect(um.alvos.map((a) => a.companyId)).not.toContain(SEG_STUDIO_TESTE);
    expect(dois.alvos.map((a) => a.companyId)).not.toContain(SEG_STUDIO_ASSINANTE);
    expect(um.fora.segurada).toBe(1);
    expect(dois.fora.segurada).toBe(1);
  });

  test('a conta tirada pelo Caio em 11/11 fica fora do e-mail 2', async () => {
    const tirada = 'bd2b009e-4c17-4deb-907d-14815f1c4e97';
    expect(S.SEGURADAS).toContain(tirada);
    const db = banco({ publico: { 2: [linha({ company_id: tirada }), linha()] } });
    const dois = await S.selecionar(db, 2, { now: AGORA });
    expect(dois.alvos.map((a) => a.companyId)).not.toContain(tirada);
    expect(dois.fora.segurada).toBe(1);
  });
});

describe('dry-run', () => {
  test('não chama o mailer nem grava; a saída não tem nome nem e-mail', async () => {
    const db = banco({ publico: { 2: publicoEmail2() } });
    const { r, saida, enviar } = await rodar(db, ['--email=2']);
    expect(r.modo).toBe('dry-run');
    expect(enviar).not.toHaveBeenCalled();
    expect(db.log.size).toBe(0);
    expect(db.query.mock.calls.some(([sql]) => /INSERT|UPDATE/.test(sql))).toBe(false);
    expect(saida).not.toMatch(/@/);
    expect(saida).not.toMatch(/Dona\d|Loja \d/);
    expect(saida).toContain('Público: 36 contas');
    expect(saida).toContain('por variante: atraso 2 · essencial 2 · negocio 28 · studio 4');
    expect(saida).toContain('BLACK50: 9 usos restantes · 34 contas recebem o código');
    expect(saida).toContain('00000001 · negocio · negocio · a enviar');
  });
});

describe('envio e trava contra reenvio', () => {
  test('envia uma vez por empresa; a segunda rodada pula todas', async () => {
    const db = banco({ publico: { 1: [linha(), linha({ plan: 'essencial', billing_status: 'active' })] } });
    const a = await rodar(db, ['--email=1', '--enviar']);
    expect(a.r.enviados).toBe(2);
    expect(a.enviar).toHaveBeenCalledTimes(2);
    expect(a.dormir).toHaveBeenCalledTimes(1);
    expect(a.dormir).toHaveBeenCalledWith(S.INTERVALO_PADRAO_S * 1000);
    const chave = S.chaveDe(1, '00000001-0000-4000-8000-000000000000');
    expect(chave).toBe('bf-2026-email1:00000001-0000-4000-8000-000000000000');
    expect(db.log.get(chave)).toMatchObject({ status: 'sent', tipo: 'novidades_bf_2026_email1' });
    expect(JSON.parse(db.log.get(chave).metadata)).toMatchObject({ campanha: 'bf-2026-email1', variante: 'negocio' });

    // Essencial sem a frase do carnê; o botão vai para a página.
    const [envNeg, envEss] = a.enviar.mock.calls.map((c) => c[0]);
    expect(envNeg.text).toContain('carnê');
    expect(envEss.text).not.toContain('carnê');
    expect(envNeg.html).toContain('https://app.getaura.com.br/black-friday');
    expect(envNeg.headers['List-Unsubscribe']).toMatch(/emails\/descadastro\//);
    expect(envNeg.text).toContain('Parar de receber: ');
    // Remetente escolhido pelo Caio (11/11) e rodapé com o nome da loja.
    expect(envNeg.from).toBe('Caio, da Aura <contato@getaura.com.br>');
    expect(envEss.from).toBe(S.REMETENTE);
    expect(envNeg.html).toContain('porque usa a Aura com a Loja 1.');

    const b = await rodar(db, ['--email=1', '--enviar']);
    expect(b.r.pulados).toBe(2);
    expect(b.r.enviados).toBe(0);
    expect(b.enviar).not.toHaveBeenCalled();
    expect(b.saida).toContain('Já receberam (pulados): 2 · a enviar: 0');
  });

  test('e-mail 2: atraso sem código, Studio com as funções do Studio, link do checkout da conta', async () => {
    const db = banco({ publico: { 2: [linha(), linha({ vertical_active: 'studio' }), linha({ billing_status: 'overdue' })] } });
    const { r, enviar } = await rodar(db, ['--email=2', '--enviar', '--intervalo=0']);
    expect(r.enviados).toBe(3);
    const [neg, studio, atraso] = enviar.mock.calls.map((c) => c[0]);
    expect(neg.text).toContain('BLACK50: R$ 84,50');
    expect(neg.text).toContain('checkout?empresa=00000001-0000-4000-8000-000000000000');
    expect(studio.text).toContain('fila de produção');
    expect(atraso.text).not.toContain('BLACK50');
    expect(atraso.text).toContain('Assim que o pagamento for confirmado, o acesso volta.');
  });

  test('falha de uma empresa não para o lote; o relatório lista o id', async () => {
    const db = banco({ publico: { 1: [linha(), linha(), linha()] } });
    let n = 0;
    const enviar = jest.fn(async () => { n += 1; if (n === 2) throw new Error('Resend 500'); return { id: 're_' + n }; });
    const { r, saida } = await rodar(db, ['--email=1', '--enviar'], { enviar });
    expect(enviar).toHaveBeenCalledTimes(3);
    expect(r.enviados).toBe(2);
    expect(r.falhas).toEqual(['00000002-0000-4000-8000-000000000000']);
    expect(r.codigo).toBe(1);
    expect(saida).toContain('Falhas (company_id): 00000002-0000-4000-8000-000000000000');
  });

  test('preferência desligada ou "Não quer" relidos na hora: não envia', async () => {
    const um = linha();
    const dois = linha();
    const db = banco({ publico: { 1: [um, dois, linha()] }, prefs: { [um.company_id]: false }, notas: { [dois.company_id]: 'nao_quer' } });
    const { r, enviar } = await rodar(db, ['--email=1', '--enviar']);
    expect(r.desligados).toBe(2);
    expect(r.enviados).toBe(1);
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  test('sem canal de envio (sem RESEND_API_KEY nem SMTP_HOST): nada sai', async () => {
    const db = banco({ publico: { 1: [linha()] } });
    const { r, enviar } = await rodar(db, ['--email=1', '--enviar'], { env: {} });
    expect(r.codigo).toBe(1);
    expect(enviar).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('BLACK50 sem usos', () => {
  const esgotado = { max_uses: 10, uses: 10, is_active: true, expires_at: '2026-12-01T02:59:59Z' };

  test('o e-mail 2 para sem --sem-codigo', async () => {
    const db = banco({ publico: { 2: publicoEmail2() }, codigo: esgotado });
    const { r, enviar, saida } = await rodar(db, ['--email=2', '--enviar']);
    expect(r.codigo).toBe(2);
    expect(enviar).not.toHaveBeenCalled();
    expect(saida).toContain('rode de novo com --sem-codigo');
  });

  test('com --sem-codigo sai sem o código', async () => {
    const db = banco({ publico: { 2: [linha(), linha({ billing_status: 'overdue' })] }, codigo: esgotado });
    const { r, enviar } = await rodar(db, ['--email=2', '--enviar', '--sem-codigo']);
    expect(r.enviados).toBe(2);
    for (const [m] of enviar.mock.calls) expect(m.text).not.toContain('BLACK50');
  });

  test('código vencido ou inativo conta como zero', async () => {
    expect(await S.usosRestantes(banco({ codigo: { max_uses: 10, uses: 1, is_active: false } }), { now: AGORA })).toBe(0);
    expect(await S.usosRestantes(banco({ codigo: { max_uses: 10, uses: 1, is_active: true, expires_at: '2026-11-01T00:00:00Z' } }), { now: AGORA })).toBe(0);
    expect(await S.usosRestantes(banco({ codigo: null }), { now: AGORA })).toBe(0);
  });
});

describe('--teste', () => {
  test('e-mail 2: só os 4 envios (Negócio, Essencial, Studio, atraso), com [TESTE], sem banco', async () => {
    const { r, enviar } = await rodar(null, ['--email=2', '--teste=caio@exemplo.com']);
    expect(r.modo).toBe('teste');
    expect(enviar).toHaveBeenCalledTimes(4);
    const msgs = enviar.mock.calls.map((c) => c[0]);
    for (const m of msgs) {
      expect(m.to).toBe('caio@exemplo.com');
      expect(m.subject.startsWith('[TESTE] ')).toBe(true);
      expect(m.from).toBe('Caio, da Aura <contato@getaura.com.br>');
    }
    expect(msgs[0].text).toContain('R$ 84,50');
    expect(msgs[1].text).toContain('R$ 44,50');
    expect(msgs[2].text).toContain('fila de produção');
    expect(msgs[3].text).not.toContain('BLACK50');
  });

  test('e-mail 1: Negócio e Essencial', async () => {
    const { enviar } = await rodar(null, ['--email=1', '--teste=caio@exemplo.com']);
    expect(enviar).toHaveBeenCalledTimes(2);
    expect(enviar.mock.calls[0][0].text).toContain('carnê');
    expect(enviar.mock.calls[1][0].text).not.toContain('carnê');
  });
});

describe('argumentos', () => {
  test('--email é obrigatório; --teste com --enviar e opção desconhecida recusados', () => {
    expect(() => S.lerArgs([])).toThrow('--email');
    expect(() => S.lerArgs(['--email=3'])).toThrow('--email');
    expect(() => S.lerArgs(['--email=1', '--teste=x'])).toThrow('endereço');
    expect(() => S.lerArgs(['--email=1', '--teste=a@b.com', '--enviar'])).toThrow('--enviar');
    expect(() => S.lerArgs(['--email=1', '--forca'])).toThrow('desconhecida');
    expect(() => S.lerArgs(['--email=1', '--intervalo=-1'])).toThrow('--intervalo');
    expect(S.lerArgs(['--email=1'])).toMatchObject({ email: 1, enviar: false, teste: null, intervaloS: 2 });
  });
});
