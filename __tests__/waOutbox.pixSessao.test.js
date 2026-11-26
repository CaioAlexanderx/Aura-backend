// ============================================================
// AURA — respostas de sessão do "Quero o Pix" nas guardas REAIS do enqueue
// (waOutbox não é mockado; só o banco). Prova: o teto por contato e o do dia
// não barram o texto de sessão, não contam para os avisos, e a mesma resposta
// como template/outra origem continua barrada; o despacho dá prioridade.
// ============================================================
'use strict';

process.env.DOJO_BAAS_ENC_KEY = process.env.DOJO_BAAS_ENC_KEY || 'a'.repeat(64);

jest.mock('../src/config/database');
jest.mock('../src/services/whatsapp', () => ({ sendTemplate: jest.fn(), sendText: jest.fn() }));

const db = require('../src/config/database');
const outbox = require('../src/services/waOutbox');

const COMPANY = '55555555-5555-5555-5555-555555555555';
const FONE = '5511999990001';

function simular({ contagemDoContato = 2, contagemDoDia = 10 } = {}) {
  db.query.mockReset();
  const contagens = [];
  db.query.mockImplementation(async (sql, params) => {
    if (/wa:contact-get/.test(sql)) {
      return { rows: [{ id: 'k', phone: FONE, opted_in_at: null, opted_out_at: null, last_inbound_at: new Date().toISOString() }] };
    }
    if (/wa:guard-count-today/.test(sql)) {
      contagens.push(params);
      // 3o parâmetro nulo = contagem do dia/contato, que (na SQL real) ignora pix_sessao*
      return { rows: [{ n: params[1] ? contagemDoContato : contagemDoDia }] };
    }
    if (/wa:outbox-enqueue/.test(sql)) return { rows: [{ id: 'o1', status: params[7] }] };
    return { rows: [] };
  });
  return contagens;
}

const inserido = () => db.query.mock.calls.find((c) => /wa:outbox-enqueue/.test(c[0]));

describe('teto por contato (WA_PER_PHONE_DAILY_CAP, padrão 2)', () => {
  test('aviso do dia + pergunta: o código do Pix (texto de sessão) NÃO cai em LIMITE_POR_CONTATO', async () => {
    simular({ contagemDoContato: 2 });
    const r = await outbox.enqueue({ companyId: COMPANY, toPhone: FONE, kind: 'text', textBody: '000201...', sourceType: 'pix_sessao', sourceId: 'p1', dedupeKey: 'quero-pix-x-b' });
    expect(r).toMatchObject({ queued: true, status: 'pending', reason: null });
    expect(inserido()[1][8]).toBeNull(); // skip_reason
  });

  test('o texto de sessão também não esbarra no teto do dia da loja', async () => {
    simular({ contagemDoDia: 100000 });
    const r = await outbox.enqueue({ companyId: COMPANY, toPhone: FONE, kind: 'text', textBody: 'oi', sourceType: 'pix_sessao_sem_pix', dedupeKey: 'quero-pix-x-x' });
    expect(r.queued).toBe(true);
  });

  test('controle: a mesma situação com outra origem de texto continua barrada', async () => {
    simular({ contagemDoContato: 2 });
    const r = await outbox.enqueue({ companyId: COMPANY, toPhone: FONE, kind: 'text', textBody: 'oi', sourceType: 'humano', dedupeKey: 'h1' });
    expect(r).toMatchObject({ queued: false, reason: 'LIMITE_POR_CONTATO' });
  });

  test('pix_sessao como TEMPLATE não ganha a isenção (só texto de sessão)', async () => {
    simular({ contagemDoContato: 2 });
    const r = await outbox.enqueue({ companyId: COMPANY, toPhone: FONE, kind: 'template', templateName: 'x', sourceType: 'pix_sessao', dedupeKey: 'h2', saldoBucket: null });
    expect(r.reason).not.toBeNull();
  });
});

describe('contagem e prioridade', () => {
  test('a contagem do dia/contato exclui pix_sessao* (não consome o teto dos avisos)', async () => {
    simular();
    await outbox.countToday(COMPANY, { phone: FONE });
    const sql = db.query.mock.calls.find((c) => /wa:guard-count-today/.test(c[0]))[0];
    expect(sql).toMatch(/NOT LIKE 'pix\\_sessao%'/);
  });

  test('o despacho escolhe as respostas de sessão antes dos avisos em lote', async () => {
    db.query.mockReset();
    db.query.mockResolvedValue({ rows: [] });
    await outbox.processBatch(20);
    const pick = db.query.mock.calls.find((c) => /wa:outbox-pick/.test(c[0]))[0];
    expect(pick).toMatch(/ORDER BY \(CASE WHEN source_type LIKE 'pix\\_sessao%' THEN 0 ELSE 1 END\), created_at ASC/);
  });
});
