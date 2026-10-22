// ============================================================
// AURA. — Status da entrega do relatório semanal (tq-72, 21/10/2026)
//
// O CASO REAL: em 19/10 o relatório saiu (sent=3 errors=0), mas cada envio
// logou "updateDelivery error: inconsistent types deduced for parameter $2"
// e as 78 linhas de report_deliveries ficaram 'pending'. O UPDATE usava $2
// em `status=$2` (VARCHAR -> character varying) e em `$2='sent'` (text);
// o Postgres recusava a query (42P08) e o .catch só fazia console.error.
//
// Este arquivo usa o db mockado do jest.setup. A prova contra o Postgres de
// verdade (o 42P08 do SQL antigo e o UPDATE novo gravando) está em
// reportDelivery.banco.test.js, que roda no CI.
//
// Cobre:
//   1. todo parâmetro usado mais de uma vez no UPDATE tem o MESMO cast
//      explícito (a regra que o SQL antigo quebrava)
//   2. 'sent' grava resend_id; 'failed' grava last_error curto e sem e-mail
//   3. erro do UPDATE vai para o log com o código e devolve false
//   4. reportScheduler + mailer em modo dev (sem RESEND_API_KEY): a linha
//      vira 'sent' com o id do envio, e 'failed' quando o envio lança
// ============================================================
'use strict';

const db = require('../src/config/database');

// O scheduler chama generateReport (pesado: vendas, narrativas, HTML). Aqui
// ele devolve uma entrega pronta; updateDelivery é o de verdade.
jest.mock('../src/services/reportGenerator', () => {
  const real = jest.requireActual('../src/services/reportGenerator');
  return { ...real, generateReport: jest.fn(), generateConsolidatedReport: jest.fn() };
});

const reportGenerator = require('../src/services/reportGenerator');
const { updateDelivery } = reportGenerator;

/**
 * Para cada $n que aparece mais de uma vez no SQL, devolve os casts de cada
 * ocorrência. O SQL antigo dava { 2: ['', ''] } — sem cast, e o Postgres
 * deduzia tipos diferentes para cada posição.
 */
function castsPorParametro(sql) {
  const out = {};
  for (const m of sql.matchAll(/\$(\d+)(::[a-z ]+)?/gi)) {
    const n = m[1];
    (out[n] = out[n] || []).push((m[2] || '').trim().toLowerCase());
  }
  return out;
}

function parametrosRepetidosSemCastIgual(sql) {
  return Object.entries(castsPorParametro(sql))
    .filter(([, casts]) => casts.length > 1)
    .filter(([, casts]) => !casts[0] || casts.some((c) => c !== casts[0]))
    .map(([n]) => `$${n}`);
}

describe('regra dos casts', () => {
  test('o SQL antigo é pego pela regra', () => {
    const antigo = `UPDATE report_deliveries SET status=$2, last_error=$3, sent_at=CASE WHEN $2='sent' THEN NOW() ELSE NULL END, attempts=attempts+1 WHERE id=$1`;
    expect(parametrosRepetidosSemCastIgual(antigo)).toEqual(['$2']);
  });
});

describe('updateDelivery', () => {
  let erroLog;
  beforeEach(() => {
    db.query.mockReset();
    erroLog = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => erroLog.mockRestore());

  test("'sent': cast explícito no status, resend_id e tipos dos parâmetros", async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const ok = await updateDelivery(42, 'sent', { resendId: 're_abc123' });

    expect(ok).toBe(true);
    const [sql, params] = db.query.mock.calls[0];
    expect(parametrosRepetidosSemCastIgual(sql)).toEqual([]);
    expect(castsPorParametro(sql)['1']).toEqual(['::text', '::text']);
    expect(sql).toMatch(/status\s*=\s*\$1::text/);
    expect(sql).toMatch(/resend_id\s*=\s*COALESCE\(\$2::text/);
    expect(sql).toMatch(/last_error\s*=\s*\$3::text/);
    expect(sql).toMatch(/attempts\s*=\s*attempts \+ 1/);
    expect(sql).toMatch(/WHERE id = \$4/);
    expect(params).toEqual(['sent', 're_abc123', null, 42]);
    expect(params.slice(0, 3).every((p) => p === null || typeof p === 'string')).toBe(true);
  });

  test("'failed': last_error curto, sem e-mail, sem resend_id", async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const msg = 'Resend API 422: Invalid `to` field: dona.loja@exemplo.com.br is not valid. ' + 'x'.repeat(400);
    const ok = await updateDelivery(7, 'failed', { error: msg });

    expect(ok).toBe(true);
    const [, params] = db.query.mock.calls[0];
    expect(params[0]).toBe('failed');
    expect(params[1]).toBeNull();
    expect(params[2]).not.toMatch(/@/);
    expect(params[2]).toContain('[email]');
    expect(params[2].length).toBeLessThanOrEqual(200);
    expect(params[3]).toBe(7);
  });

  test('forma antiga (id, status, mensagem) continua valendo', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await updateDelivery(9, 'failed', 'timeout');
    expect(db.query.mock.calls[0][1]).toEqual(['failed', null, 'timeout', 9]);
  });

  test('erro do UPDATE não é engolido: log com o código e devolve false', async () => {
    const e = new Error('inconsistent types deduced for parameter $2');
    e.code = '42P08';
    db.query.mockRejectedValueOnce(e);

    const ok = await updateDelivery(42, 'sent', { resendId: 're_1' });

    expect(ok).toBe(false);
    const linha = erroLog.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(linha).toContain('code=42P08');
    expect(linha).toContain('delivery=42');
  });

  test('linha inexistente devolve false e loga', async () => {
    db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    expect(await updateDelivery(999, 'sent', { resendId: 're_1' })).toBe(false);
    expect(erroLog).toHaveBeenCalled();
  });

  test('status fora da lista nem chega ao banco', async () => {
    expect(await updateDelivery(1, 'enviado')).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ── reportScheduler + mailer em modo dev ─────────────────────────────────

describe('reportScheduler com o mailer em modo dev', () => {
  const ENV = { ...process.env };
  let linhas;
  let logs;
  let logSpy;
  let erroSpy;

  // report_deliveries em memória: o UPDATE do updateDelivery é aplicado
  // aqui com os mesmos parâmetros que iriam ao Postgres.
  function bancoFalso() {
    db.query.mockImplementation(async (sql, params) => {
      if (/FROM companies/.test(sql) && /weekly_report_enabled = true/.test(sql)) {
        return {
          rows: [{
            id: 'co-1', owner_id: 'own-1', is_primary: true, created_at: new Date(),
            name: 'Loja Fixture', email: 'dona@exemplo.com.br', plan: 'negocio',
            recipient_email: 'dona@exemplo.com.br', has_override: false,
          }],
        };
      }
      if (/^\s*UPDATE report_deliveries/.test(sql)) {
        expect(parametrosRepetidosSemCastIgual(sql)).toEqual([]);
        const [status, resendId, error, id] = params;
        const linha = linhas.get(id);
        if (!linha) return { rowCount: 0, rows: [] };
        linha.status = status;
        if (resendId != null) linha.resend_id = resendId;
        linha.last_error = error;
        linha.sent_at = status === 'sent' ? new Date() : null;
        linha.attempts += 1;
        return { rowCount: 1, rows: [] };
      }
      throw new Error('SQL inesperado no teste: ' + sql.slice(0, 80));
    });
  }

  beforeEach(() => {
    delete process.env.RESEND_API_KEY;
    delete process.env.SMTP_HOST;
    db.query.mockReset();
    linhas = new Map([[101, { id: 101, status: 'pending', resend_id: null, attempts: 0, last_error: null, sent_at: null }]]);
    bancoFalso();
    reportGenerator.generateReport.mockResolvedValue({
      skipped: false,
      deliveryId: 101,
      company: { id: 'co-1', name: 'Loja Fixture', recipient_email: 'dona@exemplo.com.br' },
      kpis: { revenue: 1234.5, sales: 10, avg_ticket: 123.45, health_score: 72 },
      reportUrl: 'https://app.getaura.com.br/relatorios/semanal/tok',
    });
    logs = [];
    logSpy = jest.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' ')));
    erroSpy = jest.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));
  });

  afterEach(() => {
    logSpy.mockRestore();
    erroSpy.mockRestore();
    jest.restoreAllMocks();
    process.env = { ...ENV };
  });

  test("envio ok: a linha vira 'sent' com o id do envio (dev-...)", async () => {
    const { triggerWeeklyReports } = require('../src/jobs/reportScheduler');
    await triggerWeeklyReports();

    const linha = linhas.get(101);
    expect(linha.status).toBe('sent');
    expect(linha.resend_id).toMatch(/^dev-\d+$/);
    expect(linha.sent_at).toBeInstanceOf(Date);
    expect(linha.attempts).toBe(1);
    expect(linha.last_error).toBeNull();

    const tudo = logs.join('\n');
    expect(tudo).toContain('sent=1 skipped=0 errors=0 delivery_update_errors=0');
    expect(tudo).toContain(`id=${linha.resend_id}`);
    // Nem o scheduler nem o mailer logam o e-mail do destinatário.
    expect(tudo).not.toContain('dona@exemplo.com.br');
  });

  test("envio lança: a linha vira 'failed' com attempts+1 e o erro curto", async () => {
    const mailer = require('../src/services/mailer');
    jest.spyOn(mailer, 'sendWeeklyReport').mockRejectedValue(
      new Error('Resend API 500: falha ao entregar para dona@exemplo.com.br')
    );
    const { triggerWeeklyReports } = require('../src/jobs/reportScheduler');
    await triggerWeeklyReports();

    const linha = linhas.get(101);
    expect(linha.status).toBe('failed');
    expect(linha.attempts).toBe(1);
    expect(linha.resend_id).toBeNull();
    expect(linha.sent_at).toBeNull();
    expect(linha.last_error).toBe('Resend API 500: falha ao entregar para [email]');
    expect(logs.join('\n')).toContain('sent=0 skipped=0 errors=1 delivery_update_errors=0');
  });

  test('UPDATE falhando aparece no resumo (delivery_update_errors)', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/weekly_report_enabled = true/.test(sql)) {
        return { rows: [{ id: 'co-1', owner_id: 'own-1', is_primary: true, name: 'Loja Fixture', recipient_email: 'dona@exemplo.com.br' }] };
      }
      const e = new Error('connection terminated');
      e.code = '57P01';
      throw e;
    });
    const { triggerWeeklyReports } = require('../src/jobs/reportScheduler');
    await triggerWeeklyReports();

    const tudo = logs.join('\n');
    expect(tudo).toContain('code=57P01');
    expect(tudo).toContain('delivery_update_errors=1');
  });
});
