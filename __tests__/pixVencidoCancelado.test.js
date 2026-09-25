// ============================================================
// Pix vencido: marcar como expirado e cancelar sozinho (10/09/2026)
//
// Decisao do Caio: Pix sem pagamento em 48 h vira "Expirado" e o pedido e
// cancelado. Os tres da Finesse ficaram 112 dias em "Precisa agir" porque
// Pix manual nao tem data de expiracao e nada os tirava da fila.
//
// O que trava aqui e o FILTRO — um filtro frouxo cancela pedido pago:
//   - so pending_payment ("ja paguei" = awaiting_approval, nao toca)
//   - comprovante anexado tambem nao (o upload nao muda o status)
//   - so Pix, e nunca os dois jeitos de "pago" dos gateways
//   - Studio (Fase 2, 25/09/2026): entra com 72 h, e so enquanto a
//     producao nao andou
//   - trava de linha, para dois processos nao cancelarem o mesmo pedido
// E o AVISO: so para pedido recente (7 dias). Pedido de maio cancela calado.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const {
  tickCancelarPixVencido, PRAZO_HORAS, PRAZO_HORAS_STUDIO, JANELA_DIAS, BATCH,
} = require('../src/jobs/lojaPixExpiradoJob');

const CID = 'c0000000-0000-0000-0000-000000000001';
const HORA = 3600 * 1000;

function linha(i, idadeHoras) {
  return {
    id: `bb2ffcea-0000-0000-0000-00000000010${i}`, company_id: CID, order_number: `0010${i}`,
    customer_name: 'Eryca', total: '129.90', vertical: null,
    created_at: new Date(Date.now() - idadeHoras * HORA).toISOString(),
  };
}

function mkDeps(rows = []) {
  return {
    db: { query: jest.fn().mockResolvedValue({ rows }) },
    lojaEvents: { emitLojaEvent: jest.fn().mockResolvedValue({ id: 'n1' }) },
  };
}

describe('filtro do cancelamento', () => {
  let sql;
  let params;
  beforeAll(async () => {
    const deps = mkDeps();
    await tickCancelarPixVencido(deps);
    [sql, params] = deps.db.query.mock.calls[0];
  });

  test('prazo de 48 h', () => {
    expect(PRAZO_HORAS).toBe(48);
    expect(sql).toMatch(new RegExp(`created_at < NOW\\(\\) - INTERVAL '${PRAZO_HORAS} hours'`));
  });

  test('so Pix pendente, nunca comprovante enviado nem pago', () => {
    expect(sql).toMatch(/status = 'pending_payment'/);
    expect(sql).not.toMatch(/awaiting_approval/);
    expect(sql).toMatch(/payment_method = 'pix'/);
    expect(sql).toMatch(/NOT IN \('confirmed', 'paid', 'received'\)/);
  });

  test('comprovante anexado fica de fora', () => {
    expect(sql).toMatch(/AND payment_proof_url IS NULL/);
  });

  test('loja comum: 48 h, como sempre', () => {
    expect(sql).toMatch(/COALESCE\(vertical, 'retail'\) <> 'studio'\s+AND created_at < NOW\(\) - INTERVAL '48 hours'/);
  });

  test('Studio: 72 h, e so enquanto a producao nao andou', () => {
    expect(PRAZO_HORAS_STUDIO).toBe(72);
    expect(sql).toMatch(/vertical = 'studio'\s+AND created_at < NOW\(\) - INTERVAL '72 hours'\s+AND COALESCE\(studio_production_status, 'pending_art'\) IN \('pending_art', 'awaiting_customization'\)/);
    // A nota diz o prazo certo de cada um.
    expect(sql).toMatch(/CASE WHEN vertical = 'studio' THEN \$3 ELSE \$2 END/);
    expect(params[1]).toContain('48 h');
    expect(params[2]).toContain('72 h');
  });

  test('marca expirado, cancela e deixa nota; com trava de linha e lote', () => {
    expect(sql).toMatch(/status\s+= 'cancelled'/);
    expect(sql).toMatch(/payment_status = 'expired'/);
    expect(sql).toMatch(/cancelled_at\s+= NOW\(\)/);
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(sql).toMatch(/RETURNING/);
    expect(params[0]).toBe(BATCH);
    expect(params[1]).toMatch(/EXPIRADO/);
  });
});

describe('aviso no sino', () => {
  test('pedido recente avisa com texto de cancelamento automatico', async () => {
    const deps = mkDeps([linha(1, 49)]);
    const r = await tickCancelarPixVencido(deps);
    expect(r).toEqual({ cancelados: 1, avisados: 1 });
    const [tipo, pedido, opts] = deps.lojaEvents.emitLojaEvent.mock.calls[0];
    expect(tipo).toBe('loja_pix_expirado');
    expect(pedido).toMatchObject({ id: linha(1, 49).id, company_id: CID });
    expect(opts.body).toContain('R$ 129,90');
    expect(opts.body).toContain('cancelado automaticamente');
  });

  test('pedido do Studio avisa com o prazo dele', async () => {
    const deps = mkDeps([{ ...linha(3, 73), vertical: 'studio' }]);
    const r = await tickCancelarPixVencido(deps);
    expect(r).toEqual({ cancelados: 1, avisados: 1 });
    expect(deps.lojaEvents.emitLojaEvent.mock.calls[0][2].body).toContain('não foi pago em 72 h');
  });

  test('loja comum avisa com 48 h', async () => {
    const deps = mkDeps([linha(4, 49)]);
    await tickCancelarPixVencido(deps);
    expect(deps.lojaEvents.emitLojaEvent.mock.calls[0][2].body).toContain('não foi pago em 48 h');
  });

  test('pedido antigo cancela calado', async () => {
    const deps = mkDeps([linha(2, 24 * (JANELA_DIAS + 100))]);
    const r = await tickCancelarPixVencido(deps);
    expect(r).toEqual({ cancelados: 1, avisados: 0 });
    expect(deps.lojaEvents.emitLojaEvent).not.toHaveBeenCalled();
  });

  test('nada vencido: nao chama o sino', async () => {
    const deps = mkDeps([]);
    expect(await tickCancelarPixVencido(deps)).toEqual({ cancelados: 0, avisados: 0 });
    expect(deps.lojaEvents.emitLojaEvent).not.toHaveBeenCalled();
  });
});

describe('base sem a coluna do comprovante', () => {
  test('42703: cai para a consulta sem o filtro, uma vez, e continua cancelando', async () => {
    await jest.isolateModulesAsync(async () => {
      const job = require('../src/jobs/lojaPixExpiradoJob');
      const erro = Object.assign(new Error('column "payment_proof_url" does not exist'), { code: '42703' });
      const query = jest.fn()
        .mockRejectedValueOnce(erro)
        .mockResolvedValue({ rows: [linha(5, 49)] });
      const deps = { db: { query }, lojaEvents: { emitLojaEvent: jest.fn().mockResolvedValue(null) } };
      expect((await job.tickCancelarPixVencido(deps)).cancelados).toBe(1);
      expect(query.mock.calls[1][0]).not.toMatch(/payment_proof_url/);
      await job.tickCancelarPixVencido(deps);
      expect(query).toHaveBeenCalledTimes(3);
      expect(query.mock.calls[2][0]).not.toMatch(/payment_proof_url/);
    });
  });

  test('outro erro sobe', async () => {
    await jest.isolateModulesAsync(async () => {
      const job = require('../src/jobs/lojaPixExpiradoJob');
      const deps = { db: { query: jest.fn().mockRejectedValue(new Error('boom')) }, lojaEvents: {} };
      await expect(job.tickCancelarPixVencido(deps)).rejects.toThrow('boom');
    });
  });
});

test('o job roda o cancelamento junto com o aviso de expiracao', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'jobs', 'lojaPixExpiradoJob.js'), 'utf8');
  expect(src).toContain('tickCancelarPixVencido({ db, lojaEvents })');
});
