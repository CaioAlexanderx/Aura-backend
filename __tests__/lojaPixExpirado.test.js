// ============================================================
// AURA. — Job: Pix da loja online vencido sem pagamento
//
// É o único evento da taxonomia sem gancho de fluxo: ninguém "faz" um Pix
// expirar. Sem varredura o pedido morre em silêncio, e é justamente o
// pedido morto que ainda dá para recuperar com uma mensagem.
//
// O que este arquivo trava é o FILTRO. Um filtro frouxo aqui não dá erro:
// dá enxurrada de sino (pedido pago avisado como expirado, ou meses de
// arqueologia despejados no primeiro deploy). E a idempotência NÃO é do
// job — é da dedupe_key —, então o job pode e deve reprocessar.
// ============================================================
'use strict';

const { tickPixExpirado, JANELA_DIAS, BATCH } = require('../src/jobs/lojaPixExpiradoJob');

const CID = 'c0000000-0000-0000-0000-000000000001';
const pedido = (i) => ({
  id: `bb2ffcea-0000-0000-0000-00000000000${i}`,
  company_id: CID, order_number: `0000${i}`,
  customer_name: 'Davi', total: '99.90', vertical: null,
});

function mkDeps({ rows = [], emitido = true } = {}) {
  const db = { query: jest.fn().mockResolvedValue({ rows }) };
  const lojaEvents = {
    emitLojaEvent: jest.fn().mockResolvedValue(emitido ? { id: 'n1' } : null),
  };
  return { db, lojaEvents };
}

describe('filtro da varredura', () => {
  test('so pedido pendente, com Pix vencido, dentro da janela', async () => {
    const deps = mkDeps();
    await tickPixExpirado(deps);
    const [sql, params] = deps.db.query.mock.calls[0];
    expect(sql).toMatch(/status = 'pending_payment'/);
    expect(sql).toMatch(/asaas_pix_expires_at IS NOT NULL/);
    expect(sql).toMatch(/asaas_pix_expires_at < NOW\(\)/);
    expect(sql).toMatch(new RegExp(`INTERVAL '${JANELA_DIAS} days'`));
    expect(params).toEqual([BATCH]);
  });

  // 'confirmed' (Asaas) e 'paid' (MP) sao o MESMO fato escrito diferente
  // pelos dois gateways. Deixar um de fora avisaria "Pix expirado" num
  // pedido pago — o pior tipo de aviso errado.
  test('exclui os dois jeitos de dizer "pago" que os gateways usam', async () => {
    const deps = mkDeps();
    await tickPixExpirado(deps);
    const [sql] = deps.db.query.mock.calls[0];
    expect(sql).toMatch(/NOT IN \('confirmed', 'paid', 'received'\)/);
  });

  test('a janela existe para o primeiro deploy nao despejar meses de pedido velho', () => {
    expect(JANELA_DIAS).toBeLessThanOrEqual(15);
  });
});

describe('disparo', () => {
  test('emite um evento por pedido encontrado', async () => {
    const deps = mkDeps({ rows: [pedido(1), pedido(2)] });
    const r = await tickPixExpirado(deps);
    expect(r).toEqual({ scanned: 2, notified: 2 });
    expect(deps.lojaEvents.emitLojaEvent).toHaveBeenCalledTimes(2);
    expect(deps.lojaEvents.emitLojaEvent.mock.calls[0][0]).toBe('loja_pix_expirado');
    expect(deps.lojaEvents.emitLojaEvent.mock.calls[0][1]).toMatchObject({ id: pedido(1).id, company_id: CID });
  });

  // A idempotencia e da dedupe_key (indice unico parcial, 285), nao do job:
  // por isso ele NAO tem coluna de "ja notificado" e pode varrer o mesmo
  // pedido a cada 10min pelos 7 dias sem duplicar nada.
  test('re-tick nao conta como avisado quando o dedupe ja pegou', async () => {
    const deps = mkDeps({ rows: [pedido(1)], emitido: false });
    const r = await tickPixExpirado(deps);
    expect(r).toEqual({ scanned: 1, notified: 0 });
  });

  test('nada vencido: nao chama o notificador', async () => {
    const deps = mkDeps({ rows: [] });
    const r = await tickPixExpirado(deps);
    expect(r).toEqual({ scanned: 0, notified: 0 });
    expect(deps.lojaEvents.emitLojaEvent).not.toHaveBeenCalled();
  });
});
