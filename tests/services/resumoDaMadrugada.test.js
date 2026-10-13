// ============================================================
// Resumo das 8h do WhatsApp da Aura: texto, janela 21h–8h, idempotência
// por dia e o job que dispara (jobs/resumoDaMadrugadaJob.js).
//
// Os contatos vêm de fakePainelDb (hub*): Renata chegou 23h40 e a Aurinha
// respondeu; o número sem cadastro chegou 05h30 e a Aurinha respondeu; o das
// 08h50 chegou depois das 8h e fica de fora.
// ============================================================
'use strict';

const fake = require('../helpers/fakePainelDb');
const resumo = require('../../src/services/resumoDaMadrugada');
const job = require('../../src/jobs/resumoDaMadrugadaJob');

const HOJE = '2026-10-13';

// Banco com o hub do fakePainelDb + as consultas do resumo. `eventos` guarda
// as linhas de hub_agent_events que o resumo gravou (a trava do dia).
function resumoDb({ existente = null, dados = fake.dadosPadrao() } = {}) {
  const gravados = [];
  if (existente) gravados.push(existente);
  const escritas = [];
  const db = {
    gravados,
    escritas,
    query: jest.fn(async (sql, params = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.includes('-- resumo:existe')) {
        return { rows: gravados.filter((g) => g.detail.dia === params[1]).map((g) => ({ id: g.id, detail: g.detail })) };
      }
      if (s.includes('-- resumo:trava')) {
        const detail = JSON.parse(params[1]);
        if (gravados.some((g) => g.detail.dia === detail.dia)) return { rows: [] };
        const linha = { id: `ev${gravados.length + 1}`, company_id: params[0], detail };
        gravados.push(linha);
        escritas.push({ tipo: 'insert', linha });
        return { rows: [{ id: linha.id }] };
      }
      if (s.startsWith('UPDATE hub_agent_events')) {
        const linha = gravados.find((g) => g.id === params[0]);
        if (linha) linha.detail.entrega.enviado = true;
        escritas.push({ tipo: 'update', id: params[0] });
        return { rows: [] };
      }
      if (s.startsWith('DELETE FROM hub_agent_events')) {
        const i = gravados.findIndex((g) => g.id === params[0]);
        if (i >= 0) gravados.splice(i, 1);
        escritas.push({ tipo: 'delete', id: params[0] });
        return { rows: [] };
      }
      return { rows: fake.responder(dados, [], sql, params) };
    }),
  };
  return db;
}

const mailerOk = () => ({ sendMail: jest.fn(async () => ({ id: 'm1' })) });

beforeEach(() => { process.env.AURA_COMPANY_ID = fake.AURA_COMPANY; });
afterEach(() => { delete process.env.AURA_COMPANY_ID; delete process.env.RESUMO_MADRUGADA_EMAIL; jest.restoreAllMocks(); });

describe('montarResumo', () => {
  test('só o que chegou entre 21h e 8h, do mais antigo para o mais novo', async () => {
    const r = await resumo.montarResumo({ hoje: HOJE, db: resumoDb() });
    expect(r.total).toBe(2);
    expect(r.itens.map((i) => [i.hora, i.situacao])).toEqual([['23:40', 'humano'], ['05:30', 'aurinha']]);
  });

  test('texto: quem, quando, o que disse em uma linha e o que a Aurinha respondeu', async () => {
    const { texto } = await resumo.montarResumo({ hoje: HOJE, db: resumoDb() });
    expect(texto).toBe([
      'Madrugada no WhatsApp da Aura — 13/10 (das 21h de 12/10 às 8h)',
      '',
      '2 contatos: 1 respondido pela Aurinha, 1 pelo Caio, 0 sem resposta.',
      '',
      '1. 23:40 — Renata Lima (+55 11 99990-0002) · Mercado Bela Vista',
      // a mensagem do cliente tinha quebra de linha: sai numa linha só
      '   Disse: "Oi, vocês fazem integração com iFood?"',
      '   Aurinha: "Oi! Aqui é a Aurinha, da Aura. Anotei sua mensagem e o Caio te responde às 8h." · Caio já respondeu',
      '   https://wa.me/5511999900002',
      '',
      '2. 05:30 — +55 12 98888-0077',
      '   Disse: "Preciso de ajuda com a nota fiscal"',
      '   Aurinha: "Oi! Aqui é a Aurinha, da Aura. Anotei sua mensagem e o Caio te responde às 8h."',
      '   https://wa.me/5512988880077',
    ].join('\n'));
  });

  test('o que o cliente disse é cortado em uma linha curta', async () => {
    const dados = fake.dadosPadrao();
    dados.hubMensagens.find((m) => m.id === 'm07').content = `Preciso de ajuda ${'com a nota fiscal '.repeat(30)}`;
    const r = await resumo.montarResumo({ hoje: HOJE, db: resumoDb({ dados }) });
    const disse = r.itens.find((i) => i.hora === '05:30').disse;
    expect(disse.length).toBeLessThanOrEqual(140);
    expect(disse.endsWith('…')).toBe(true);
    expect(disse).not.toContain('\n');
  });

  test('sem contatos na noite', async () => {
    const dados = fake.dadosPadrao();
    dados.hubMensagens = [];
    const r = await resumo.montarResumo({ hoje: HOJE, db: resumoDb({ dados }) });
    expect(r.total).toBe(0);
    expect(r.texto).toBe('Nenhum contato entre 21h e 8h (13/10).');
  });

  test('a noite é de 21h do dia anterior (00:00Z) a 8h (11:00Z)', () => {
    const j = resumo.janelaDaNoite(HOJE);
    expect([j.desde.toISOString(), j.ate.toISOString()]).toEqual(['2026-10-13T00:00:00.000Z', '2026-10-13T11:00:00.000Z']);
  });
});

describe('gerarEEnviar', () => {
  test('grava o resumo em hub_agent_events e manda por e-mail para contato@getaura.com.br', async () => {
    const db = resumoDb();
    const mailer = mailerOk();
    const r = await resumo.gerarEEnviar({ hoje: HOJE, db, mailer });
    expect(r).toMatchObject({ ok: true, total: 2, enviado: true, para: 'contato@getaura.com.br' });

    expect(db.gravados).toHaveLength(1);
    expect(db.gravados[0].company_id).toBe(fake.AURA_COMPANY);
    expect(db.gravados[0].detail).toMatchObject({ dia: HOJE, total: 2, entrega: { canal: 'email', para: 'contato@getaura.com.br', enviado: true } });
    expect(db.gravados[0].detail.itens).toHaveLength(2);

    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    const mail = mailer.sendMail.mock.calls[0][0];
    expect(mail.to).toBe('contato@getaura.com.br');
    expect(mail.subject).toBe('Madrugada no WhatsApp da Aura: 2 contatos (13/10)');
    expect(mail.text).toContain('Renata Lima');
    expect(mail.html).toContain('Renata Lima');
    expect(mail.html).toContain('https://wa.me/5511999900002');
  });

  test('idempotente por dia: segunda chamada não grava nem envia', async () => {
    const db = resumoDb();
    const mailer = mailerOk();
    await resumo.gerarEEnviar({ hoje: HOJE, db, mailer });
    const segunda = await resumo.gerarEEnviar({ hoje: HOJE, db, mailer });
    expect(segunda).toMatchObject({ ok: true, motivo: 'JA_GERADO', enviado: false });
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    expect(db.gravados).toHaveLength(1);
  });

  test('duas instâncias ao mesmo tempo: quem perde a trava não envia', async () => {
    // As duas passam pela checagem inicial (linha ainda não existe)...
    const db = resumoDb();
    const base = db.query.getMockImplementation();
    let checagens = 0;
    db.query.mockImplementation(async (sql, params) => {
      if (sql.includes('-- resumo:existe') && checagens++ < 2) return { rows: [] };
      return base(sql, params);
    });
    const mailer = mailerOk();
    const [a, b] = await Promise.all([
      resumo.gerarEEnviar({ hoje: HOJE, db, mailer }),
      resumo.gerarEEnviar({ hoje: HOJE, db, mailer }),
    ]);
    // ...mas só uma consegue inserir a linha do dia.
    expect([a.enviado, b.enviado].sort()).toEqual([false, true]);
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    expect(db.gravados).toHaveLength(1);
  });

  test('dia seguinte gera outro resumo', async () => {
    const db = resumoDb({ existente: { id: 'ev0', company_id: fake.AURA_COMPANY, detail: { dia: '2026-10-12' } } });
    const mailer = mailerOk();
    const r = await resumo.gerarEEnviar({ hoje: HOJE, db, mailer });
    expect(r.enviado).toBe(true);
    expect(db.gravados.map((g) => g.detail.dia)).toEqual(['2026-10-12', HOJE]);
  });

  test('sem contatos: grava o dia (fica fechado) e não manda e-mail', async () => {
    const dados = fake.dadosPadrao();
    dados.hubMensagens = [];
    const db = resumoDb({ dados });
    const mailer = mailerOk();
    const r = await resumo.gerarEEnviar({ hoje: HOJE, db, mailer });
    expect(r).toMatchObject({ ok: true, total: 0, enviado: false });
    expect(mailer.sendMail).not.toHaveBeenCalled();
    expect(db.gravados).toHaveLength(1);
    expect(db.gravados[0].detail.entrega.motivo).toBe('SEM_CONTATOS');
  });

  test('e-mail que falha: a linha do dia some para o próximo tick tentar de novo', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const db = resumoDb();
    const mailer = { sendMail: jest.fn().mockRejectedValueOnce(new Error('Resend 500')).mockResolvedValue({ id: 'm2' }) };
    const r = await resumo.gerarEEnviar({ hoje: HOJE, db, mailer });
    expect(r).toMatchObject({ ok: false, motivo: 'ENVIO_FALHOU', erro: 'Resend 500', enviado: false });
    expect(db.gravados).toHaveLength(0);

    const de_novo = await resumo.gerarEEnviar({ hoje: HOJE, db, mailer });
    expect(de_novo.enviado).toBe(true);
    expect(db.gravados).toHaveLength(1);
  });

  test('migration 376 pendente (CHECK do tipo, 23514): não envia, sem trava não há idempotência', async () => {
    const db = resumoDb();
    const base = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (sql.includes('-- resumo:trava')) {
        const e = new Error('violates check constraint "hub_agent_events_type_check"');
        e.code = '23514';
        throw e;
      }
      return base(sql, params);
    });
    const mailer = mailerOk();
    const r = await resumo.gerarEEnviar({ hoje: HOJE, db, mailer });
    expect(r).toMatchObject({ ok: false, motivo: 'MIGRATION_PENDENTE', enviado: false });
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  test('destino configurável por RESUMO_MADRUGADA_EMAIL', async () => {
    process.env.RESUMO_MADRUGADA_EMAIL = 'caio@example.com';
    const mailer = mailerOk();
    await resumo.gerarEEnviar({ hoje: HOJE, db: resumoDb(), mailer });
    expect(mailer.sendMail.mock.calls[0][0].to).toBe('caio@example.com');
  });

  test('sem AURA_COMPANY_ID: dormente, nenhuma consulta', async () => {
    delete process.env.AURA_COMPANY_ID;
    const db = resumoDb();
    const mailer = mailerOk();
    const r = await resumo.gerarEEnviar({ hoje: HOJE, db, mailer });
    expect(r).toMatchObject({ ok: false, motivo: 'DORMENTE' });
    expect(db.query).not.toHaveBeenCalled();
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });
});

describe('job das 8h', () => {
  const em = (iso) => new Date(iso);
  const gerar = () => jest.fn(async () => ({ ok: true, total: 2, enviado: true, para: 'contato@getaura.com.br' }));

  beforeEach(() => {
    job._resetForTests();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  test('antes das 8h BRT e depois das 12h não dispara', async () => {
    const g = gerar();
    expect(await job.tick({ agora: em('2026-10-13T10:59:00.000Z'), gerar: g })).toBeNull(); // 07h59
    expect(await job.tick({ agora: em('2026-10-13T15:00:00.000Z'), gerar: g })).toBeNull(); // 12h00
    expect(g).not.toHaveBeenCalled();
  });

  test('às 8h BRT dispara com o dia de Brasília e não repete no resto do dia', async () => {
    const g = gerar();
    expect(await job.tick({ agora: em('2026-10-13T11:00:00.000Z'), gerar: g })).toMatchObject({ ok: true });
    expect(g).toHaveBeenCalledWith({ hoje: '2026-10-13' });
    await job.tick({ agora: em('2026-10-13T11:01:00.000Z'), gerar: g });
    await job.tick({ agora: em('2026-10-13T13:00:00.000Z'), gerar: g });
    expect(g).toHaveBeenCalledTimes(1);
    // dia seguinte, de novo
    await job.tick({ agora: em('2026-10-14T11:00:00.000Z'), gerar: g });
    expect(g).toHaveBeenCalledTimes(2);
    expect(g).toHaveBeenLastCalledWith({ hoje: '2026-10-14' });
  });

  test('8h é o piso: processo que sobe às 9h30 ainda manda o resumo', async () => {
    const g = gerar();
    await job.tick({ agora: em('2026-10-13T12:30:00.000Z'), gerar: g });
    expect(g).toHaveBeenCalledTimes(1);
  });

  test('envio que falha: tenta de novo só depois de 10 minutos', async () => {
    const g = jest.fn()
      .mockResolvedValueOnce({ ok: false, motivo: 'ENVIO_FALHOU', erro: 'Resend 500' })
      .mockResolvedValue({ ok: true, total: 2, enviado: true, para: 'x' });
    await job.tick({ agora: em('2026-10-13T11:00:00.000Z'), gerar: g });
    await job.tick({ agora: em('2026-10-13T11:05:00.000Z'), gerar: g });
    expect(g).toHaveBeenCalledTimes(1);
    await job.tick({ agora: em('2026-10-13T11:10:00.000Z'), gerar: g });
    expect(g).toHaveBeenCalledTimes(2);
    await job.tick({ agora: em('2026-10-13T11:11:00.000Z'), gerar: g });
    expect(g).toHaveBeenCalledTimes(2); // concluído
  });

  test('sem AURA_COMPANY_ID ou com kill switch: não faz nada', async () => {
    const g = gerar();
    delete process.env.AURA_COMPANY_ID;
    expect(await job.tick({ agora: em('2026-10-13T11:00:00.000Z'), gerar: g })).toBeNull();
    process.env.AURA_COMPANY_ID = fake.AURA_COMPANY;
    process.env.RESUMO_MADRUGADA_ENABLED = 'false';
    try {
      expect(await job.tick({ agora: em('2026-10-13T11:00:00.000Z'), gerar: g })).toBeNull();
    } finally {
      delete process.env.RESUMO_MADRUGADA_ENABLED;
    }
    expect(g).not.toHaveBeenCalled();
  });
});
