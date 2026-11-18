// ============================================================
// AURA. — E-mail que volta (18/11/2026), sem banco
//
//   (a) sendMail e enviarEmailRegistrado não mandam para endereço com
//       devolução permanente nos tipos de verificação, relatório, ajuda,
//       acompanhamento e novidades; a redefinição de senha segue;
//   (b) alerta verificacao_devolvida no Painel com os textos aprovados e o
//       link do WhatsApp da loja (o gravado é trocado pelo de agora);
//   (c) /auth/me e POST /auth/send-verification levam o sinal da devolução;
//       a linha da verificação ganha user_id e company_id.
// As consultas SQL de verdade estão em emailDevolvido.banco.test.js.
// ============================================================
'use strict';

const ENV = { ...process.env };

function fetchFalso() {
  const corpos = [];
  global.fetch = jest.fn(async (url, init) => {
    corpos.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ id: 're_' + corpos.length }) };
  });
  return corpos;
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...ENV };
  delete global.fetch;
});

describe('quais tipos respeitam a devolução', () => {
  const dev = require('../src/services/emailDevolvido');
  test('verificação, relatório, fechamento, ajuda, acompanhamento e novidades', () => {
    for (const t of ['verificacao_email', 'relatorio_semanal', 'fechamento_mes', 'ajuda_boas_vindas',
      'ajuda_teste_terminando', 'acompanhamento_sumiu', 'novidades_bf_2026_email1']) {
      expect([t, dev.respeitaDevolucao(t)]).toEqual([t, true]);
    }
  });
  test('segurança, cobrança, convite, pedido e avisos internos seguem', () => {
    for (const t of ['redefinicao_senha', 'convite_equipe', 'cobranca_vence_hoje', 'pagamento_recusado',
      'pedido_status_cliente', 'pedido_novo_lojista', 'verificacao_portal', 'confirmacao_endereco', 'outro', undefined]) {
      expect([t, dev.respeitaDevolucao(t)]).toEqual([t, false]);
    }
    expect(dev.TIPOS_DE_SEGURANCA).toEqual(['redefinicao_senha']);
  });
});

describe('(a) sendMail com o filtro ligado no boot', () => {
  function carregar(devolvidos) {
    jest.resetModules();
    process.env = { ...ENV, RESEND_API_KEY: 're_test' };
    const db = require('../src/config/database');
    db.query.mockReset();
    db.query.mockImplementation(async (sql) => {
      if (String(sql).includes('email:devolvidos')) return { rows: devolvidos.map((email) => ({ email })) };
      return { rows: [] };
    });
    const mailer = require('../src/services/mailer');
    require('../src/services/emailLog').ligarRegistroNoMailer();
    return { mailer, db };
  }

  test('verificação para endereço devolvido: nada sai, linha failed com o motivo', async () => {
    const { mailer, db } = carregar(['ana@exemplo.com']);
    const corpos = fetchFalso();
    const r = await mailer.sendVerificationLinkEmail('Ana@Exemplo.com', 'https://x/c/1', 'Ana', '123456', { userId: 'u1', companyId: 'c1' });
    expect(r).toEqual({ id: null, suprimido: true });
    expect(corpos).toHaveLength(0);
    await new Promise((res) => setImmediate(res));
    const ins = db.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO email_log'));
    expect(ins[1].slice(0, 3)).toEqual(['verificacao_email', 'c1', 'u1']);
    expect(ins[1][5]).toBe('failed');
    expect(ins[1][7]).toMatch(/devolução permanente/);
  });

  test('verificação para endereço bom: sai e a linha leva user_id e company_id', async () => {
    const { mailer, db } = carregar([]);
    const corpos = fetchFalso();
    const r = await mailer.sendVerificationLinkEmail('bia@exemplo.com', 'https://x/c/1', 'Bia', '123456', { userId: 'u2', companyId: 'c2' });
    expect(r.id).toBe('re_1');
    expect(corpos[0].to).toEqual(['bia@exemplo.com']);
    await new Promise((res) => setImmediate(res));
    const ins = db.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO email_log'));
    expect(ins[1].slice(0, 3)).toEqual(['verificacao_email', 'c2', 'u2']);
    expect(ins[1][5]).toBe('sent');
  });

  test('relatório com dois destinatários: o devolvido sai da lista, o outro recebe', async () => {
    const { mailer } = carregar(['ana@exemplo.com']);
    const corpos = fetchFalso();
    await mailer.sendMail({ to: ['ana@exemplo.com', 'bia@exemplo.com'], subject: 's', html: 'h', tipo: 'relatorio_semanal' });
    expect(corpos[0].to).toEqual(['bia@exemplo.com']);
  });

  test('redefinição de senha segue para o endereço devolvido (sem nem consultar)', async () => {
    const { mailer, db } = carregar(['ana@exemplo.com']);
    const corpos = fetchFalso();
    await mailer.sendPasswordResetEmail('ana@exemplo.com', 'https://x/r/1', 'Ana');
    expect(corpos[0].to).toEqual(['ana@exemplo.com']);
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes('email:devolvidos'))).toBe(false);
  });

  test('leitura da devolução falhou: o e-mail sai', async () => {
    const { mailer, db } = carregar([]);
    db.query.mockImplementation(async (sql) => {
      if (String(sql).includes('email:devolvidos')) throw new Error('caiu');
      return { rows: [] };
    });
    const corpos = fetchFalso();
    await mailer.sendMail({ to: 'ana@exemplo.com', subject: 's', html: 'h', tipo: 'ajuda_boas_vindas' });
    expect(corpos).toHaveLength(1);
  });

  test('sem o filtro ligado (testes, scripts): nada muda', async () => {
    jest.resetModules();
    process.env = { ...ENV, RESEND_API_KEY: 're_test' };
    const mailer = require('../src/services/mailer');
    const corpos = fetchFalso();
    await mailer.sendMail({ to: 'ana@exemplo.com', subject: 's', html: 'h', tipo: 'verificacao_email' });
    expect(corpos).toHaveLength(1);
  });
});

describe('(a) enviarEmailRegistrado', () => {
  const { enviarEmailRegistrado, MAX_TENTATIVAS } = require('../src/services/emailLog');

  function dbFalso() {
    const calls = [];
    return {
      calls,
      query: jest.fn(async (sql, params) => {
        calls.push([String(sql), params]);
        if (String(sql).includes('INSERT INTO email_log')) return { rows: [{ id: 'log-1' }] };
        return { rows: [] };
      }),
    };
  }

  test('suprimido: status suprimido, linha failed com as tentativas esgotadas, sem tentar de novo', async () => {
    const db = dbFalso();
    const enviar = jest.fn(async () => ({ id: null, suprimido: true }));
    const r = await enviarEmailRegistrado({
      db, enviar, chave: 'k1', tipo: 'ajuda_primeira_venda', to: 'ana@exemplo.com', subject: 's', html: 'h',
    });
    expect(r).toEqual({ status: 'suprimido', id: 'log-1' });
    expect(enviar.mock.calls[0][0]).toMatchObject({ tipo: 'ajuda_primeira_venda', _registrado: true });
    const up = db.calls.find(([sql]) => sql.includes("SET status = 'failed'"));
    expect(up[1]).toEqual(['log-1', expect.stringMatching(/devolução permanente/), MAX_TENTATIVAS]);
    expect(db.calls.some(([sql]) => sql.includes("SET status = 'sent'"))).toBe(false);
  });

  test('enviado: como antes', async () => {
    const db = dbFalso();
    const r = await enviarEmailRegistrado({
      db, enviar: async () => ({ id: 're_9' }), chave: 'k2', tipo: 'cobranca_vence_hoje', to: 'a@b.com', subject: 's', html: 'h',
    });
    expect(r).toEqual({ status: 'sent', id: 'log-1', resendId: 're_9' });
  });
});

describe('devolucaoDaVerificacao (formato)', () => {
  const dev = require('../src/services/emailDevolvido');
  const db = (row) => ({ query: jest.fn(async () => ({ rows: row ? [row] : [] })) });
  test('Permanent → permanente; Transient e Undetermined → temporaria; sem bounce → null', async () => {
    const em = new Date('2026-11-17T10:00:00Z');
    expect(await dev.devolucaoDaVerificacao(db({ bounced_at: em, tipo_bounce: 'Permanent' }), 'A@b.com'))
      .toEqual({ tipo: 'permanente', em: em.toISOString() });
    expect((await dev.devolucaoDaVerificacao(db({ bounced_at: em, tipo_bounce: 'Transient' }), 'a@b.com')).tipo).toBe('temporaria');
    expect((await dev.devolucaoDaVerificacao(db({ bounced_at: em, tipo_bounce: 'Undetermined' }), 'a@b.com')).tipo).toBe('temporaria');
    expect(await dev.devolucaoDaVerificacao(db({ bounced_at: null }), 'a@b.com')).toBeNull();
    expect(await dev.devolucaoDaVerificacao(db(null), 'a@b.com')).toBeNull();
  });
  test('procura pelo endereço em minúsculas, só no e-mail de confirmação que saiu', async () => {
    const d = db(null);
    await dev.devolucaoDaVerificacao(d, ' Ana@Exemplo.COM ');
    const [sql, params] = d.query.mock.calls[0];
    expect(params).toEqual(['ana@exemplo.com']);
    expect(sql).toMatch(/tipo = 'verificacao_email' AND status = 'sent'/);
  });
  test('falha de leitura: null (nunca derruba quem chama)', async () => {
    const d = { query: jest.fn(async () => { throw new Error('caiu'); }) };
    expect(await dev.devolucaoDaVerificacao(d, 'a@b.com')).toBeNull();
  });
});

describe('(b) alerta no Painel (texto aprovado)', () => {
  test('título, detalhe, verbo e link do WhatsApp', async () => {
    const dev = require('../src/services/emailDevolvido');
    const db = { query: jest.fn(async () => ({ rows: [
      { company_id: 'c1', nome: 'Loja da Ana', telefone: '(11) 98765-4321', created_at: new Date('2026-11-16T15:00:00Z') },
      { company_id: 'c2', nome: null, telefone: null, created_at: new Date('2026-11-17T02:00:00Z') },
    ] })) };
    const alertas = await dev.alertasDeVerificacaoDevolvida({ db, hoje: '2026-11-18' });
    expect(alertas[0]).toEqual({
      tipo: 'verificacao_devolvida', chave: 'c1', company_id: 'c1',
      titulo: 'Loja da Ana: e-mail de confirmação voltou',
      detalhe: 'Cadastro de 16/11 · não confirmou · falar no WhatsApp',
      verbo: 'Falar', bloco: 'cadastros', link: 'https://wa.me/5511987654321',
    });
    // 02:00 UTC = 23:00 do dia 16 em Brasília
    expect(alertas[1].detalhe).toBe('Cadastro de 16/11 · não confirmou · falar no WhatsApp');
    expect(alertas[1].link).toBeNull();
    expect(db.query.mock.calls[0][1]).toEqual(['2026-11-18']);
  });

  test('calcularAlertas inclui o alerta; se a fonte falhar, os outros saem', async () => {
    jest.resetModules();
    jest.doMock('../src/services/emailDevolvido', () => ({
      alertasDeVerificacaoDevolvida: jest.fn(async () => { throw new Error('caiu'); }),
    }));
    const db = { query: jest.fn(async () => ({ rows: [] })) };
    const { calcularAlertas } = require('../src/services/painelAlertas');
    const vazio = { pagantes: [], lista: [], porId: new Map() };
    await expect(calcularAlertas({ hoje: '2026-11-18', db, empresas: vazio })).resolves.toEqual(expect.any(Array));
    jest.dontMock('../src/services/emailDevolvido');
  });
});
