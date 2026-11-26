// ============================================================
// AURA — Crediário: botão "Quero o Pix" (26/11/2026)
// Prova: o toque gera a mensagem certa com o Pix da parcela; loja sem Pix;
// payload desconhecido segue o fluxo normal; aviso antigo; parcela paga;
// toque de quem não é o dono da parcela; os 3 modelos levam o botão.
// ============================================================
'use strict';

jest.mock('../src/config/database');
jest.mock('../src/services/waOutbox', () => ({
  normalizePhone: (raw) => {
    const d = String(raw || '').replace(/\D/g, '');
    if (!d) return null;
    return d.startsWith('55') ? d : `55${d}`;
  },
  enqueue: jest.fn(),
}));
jest.mock('../src/services/credit/collectionNotice', () => ({
  loadInstallment: jest.fn(),
  composeNotice: jest.fn(),
}));

const db = require('../src/config/database');
const waOutbox = require('../src/services/waOutbox');
const notice = require('../src/services/credit/collectionNotice');
const quero = require('../src/services/credit/queroPix');
const catalogo = require('../src/services/waAutomaticas/modelos');

const COMPANY = '33333333-3333-3333-3333-333333333333';
const PARCELA = '44444444-4444-4444-4444-444444444444';
const AGORA = new Date('2026-11-26T15:00:00Z').getTime();
const BRCODE = '00020126580014BR.GOV.BCB.PIX0136pix@lumemoda.com.br5204000053039865406120.005802BR5909Lume Moda6009SAO PAULO62070503***6304ABCD';

const toque = (extra = {}) => ({
  id: 'wamid.TAP1', from: '5511999990001', type: 'button',
  button: { payload: `QUERO_PIX:${PARCELA}`, text: 'Quero o Pix' },
  context: { id: 'wamid.AVISO1' },
  ...extra,
});

function inst(extra = {}) {
  return {
    id: PARCELA, company_id: COMPANY, customer_id: 'c1', installment_number: 2, total_installments: 4,
    amount_due: '120.00', covered_amount: '0', status: 'pending', phone: '11999990001', store_name: 'Lume Moda', pix_link: null, ...extra,
  };
}

function simular({ parcela = inst(), composto = { pix_copia_cola: BRCODE, total_due: 120, remaining: 120 }, aviso = null } = {}) {
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => (/cred:quero-pix-aviso/.test(sql) ? { rows: aviso ? [aviso] : [] } : { rows: [] }));
  notice.loadInstallment.mockReset().mockResolvedValue(parcela);
  notice.composeNotice.mockReset().mockResolvedValue(composto);
  waOutbox.enqueue.mockReset().mockResolvedValue({ queued: true, id: 'o1' });
}
const textos = () => waOutbox.enqueue.mock.calls.map((c) => c[0].textBody);

describe('toque em "Quero o Pix"', () => {
  test('manda o valor e o Pix copia e cola, como texto de sessão (sem saldo, sem Aurinha)', async () => {
    simular();
    const r = await quero.tratarToque({ companyId: COMPANY, msg: toque(), agora: AGORA });
    expect(r).toEqual({ handled: true, resultado: 'ENVIADO' });
    expect(textos()).toHaveLength(2);
    expect(textos()[0]).toMatch(/parcela 2 de 4, R\$ 120,00/);
    expect(textos()[0]).toMatch(/Pix copia e cola/);
    expect(textos()[1]).toBe(BRCODE);
    for (const [args] of waOutbox.enqueue.mock.calls) {
      expect(args).toMatchObject({ companyId: COMPANY, toPhone: '5511999990001', kind: 'text', sourceType: 'pix_sessao', sourceId: PARCELA });
    }
    expect(waOutbox.enqueue.mock.calls.map((c) => c[0].dedupeKey)).toEqual(['quero-pix-wamid.TAP1-a', 'quero-pix-wamid.TAP1-b']);
  });

  test('valor com encargos de atraso: usa o total devido, o mesmo do código', async () => {
    simular({ composto: { pix_copia_cola: BRCODE, total_due: 131.4, remaining: 120 } });
    await quero.tratarToque({ companyId: COMPANY, msg: toque(), agora: AGORA });
    expect(textos()[0]).toMatch(/R\$ 131,40/);
  });

  test('sem payload: acha a parcela pelo aviso (context.id -> dedupe_key da fila)', async () => {
    simular({ aviso: { to_phone: '5511999990001', source_type: 'crediario', source_id: 'c1', dedupe_key: `credaviso-${PARCELA}-antes3`, created_at: new Date(AGORA - 86400000) } });
    const r = await quero.tratarToque({ companyId: COMPANY, msg: toque({ button: { payload: 'Quero o Pix', text: 'Quero o Pix' } }), agora: AGORA });
    expect(r.resultado).toBe('ENVIADO');
    expect(notice.loadInstallment).toHaveBeenCalledWith(db, COMPANY, PARCELA);
  });

  test('régua antiga: acha pelo source_id da parcela', () => {
    expect(quero.parcelaDoAviso({ source_type: 'crediario', source_id: PARCELA, dedupe_key: 'x' })).toBe(PARCELA);
    expect(quero.parcelaDoAviso({ dedupe_key: `cred-${PARCELA}-parcela_lembrete` })).toBe(PARCELA);
    expect(quero.parcelaDoAviso(null)).toBeNull();
  });

  test('botão interativo (interactive.button_reply) também vale', async () => {
    simular();
    const msg = { id: 'wamid.T2', from: '5511999990001', type: 'interactive', interactive: { button_reply: { id: `QUERO_PIX:${PARCELA}`, title: 'Quero o Pix' } } };
    expect((await quero.tratarToque({ companyId: COMPANY, msg, agora: AGORA })).resultado).toBe('ENVIADO');
  });
});

describe('casos de borda', () => {
  test('loja sem Pix: pede para falar com a loja e registra o motivo na fila', async () => {
    simular({ composto: { pix_copia_cola: null, total_due: 120, remaining: 120 } });
    const r = await quero.tratarToque({ companyId: COMPANY, msg: toque(), agora: AGORA });
    expect(r.resultado).toBe('SEM_PIX');
    expect(waOutbox.enqueue).toHaveBeenCalledTimes(1);
    const args = waOutbox.enqueue.mock.calls[0][0];
    expect(args.textBody).toMatch(/Fale com a loja/);
    expect(args.sourceType).toBe('pix_sessao_sem_pix');
    expect(args.textBody).not.toMatch(/000201/);
  });

  test('payload desconhecido não é nosso: o webhook segue o fluxo normal', async () => {
    simular();
    const outro = toque({ button: { payload: 'OUTRA_COISA', text: 'Falar com atendente' } });
    expect(await quero.tratarToque({ companyId: COMPANY, msg: outro, agora: AGORA })).toEqual({ handled: false });
    expect(await quero.tratarToque({ companyId: COMPANY, msg: { id: 'x', from: '1', type: 'text', text: { body: 'oi' } }, agora: AGORA })).toEqual({ handled: false });
    expect(waOutbox.enqueue).not.toHaveBeenCalled();
  });

  test('nosso botão sem parcela identificável: responde pedindo a loja, sem Pix', async () => {
    simular();
    const r = await quero.tratarToque({ companyId: COMPANY, msg: toque({ button: { payload: 'QUERO_PIX:lixo', text: 'Quero o Pix' }, context: undefined }), agora: AGORA });
    expect(r.resultado).toBe('PARCELA_NAO_ACHADA');
    expect(textos()[0]).toMatch(/Fale com a loja/);
    expect(notice.composeNotice).not.toHaveBeenCalled();
  });

  test('toque em aviso com mais de 30 dias: não manda Pix velho', async () => {
    simular({ aviso: { dedupe_key: `credaviso-${PARCELA}-dia`, created_at: new Date(AGORA - 31 * 86400000) } });
    const r = await quero.tratarToque({ companyId: COMPANY, msg: toque(), agora: AGORA });
    expect(r.resultado).toBe('FORA_DO_PRAZO');
    expect(notice.composeNotice).not.toHaveBeenCalled();
    expect(textos()[0]).toMatch(/aviso já é antigo/);
  });

  test('parcela já paga: avisa e não manda Pix', async () => {
    simular({ parcela: inst({ status: 'paid' }) });
    expect((await quero.tratarToque({ companyId: COMPANY, msg: toque(), agora: AGORA })).resultado).toBe('JA_PAGA');
    expect(textos()[0]).toMatch(/já consta como paga/);
    expect(notice.composeNotice).not.toHaveBeenCalled();
  });

  test('só o dono do número recebe o Pix: outro telefone não recebe', async () => {
    simular({ parcela: inst({ phone: '11888880000' }) });
    const r = await quero.tratarToque({ companyId: COMPANY, msg: toque(), agora: AGORA });
    expect(r.resultado).toBe('NAO_E_DO_CLIENTE');
    expect(textos().join(' ')).not.toContain(BRCODE);
  });
});

describe('modelos do Crediário com o botão', () => {
  test('cred_antes, cred_dia e cred_atraso levam o botão e citam "Quero o Pix" no texto', () => {
    for (const k of ['cred_antes', 'cred_dia', 'cred_atraso']) {
      const m = catalogo.obter(k);
      expect(m.botoes).toEqual([{ tipo: 'QUICK_REPLY', texto: 'Quero o Pix' }]);
      expect(m.texto_padrao).toContain("'Quero o Pix'");
      expect(m.texto_padrao).not.toMatch(/vai logo abaixo|está abaixo/);
      expect(catalogo.validar(m, m.texto_padrao).ok).toBe(true);
      expect(catalogo.componenteBotoes(m)).toEqual({ type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Quero o Pix' }] });
    }
    expect(catalogo.componenteBotoes(catalogo.obter('cred_oferta'))).toBeNull();
  });

  test('a lojista não pode editar tirando a frase do botão', () => {
    const m = catalogo.obter('cred_dia');
    const r = catalogo.validar(m, 'Oi, {Nome}. Hoje vence a parcela {Parcela}, {Valor}. Obrigada.');
    expect(r.checks.find((c) => c.id === 'botao')).toMatchObject({ ok: false });
    expect(r.ok).toBe(false);
  });
});
