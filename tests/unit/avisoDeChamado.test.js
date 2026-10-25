// ============================================================
// services/avisoDeChamado -- idempotencia por chamado + mensagem
//
// Usa o enviarEmailRegistrado REAL (services/emailLog) sobre um banco
// simulado que se comporta como o ON CONFLICT da chave de idempotencia: a
// segunda chamada para a MESMA mensagem nao manda e-mail nem cria sino de
// novo; outra mensagem do mesmo chamado manda.
// ============================================================
const { avisarChamado, chaveDaMensagem, linkDoChamado } = require('../../src/services/avisoDeChamado');
const { enviarEmailRegistrado } = require('../../src/services/emailLog');

const TICKET = {
  id: 'eeeeeeee-0000-0000-0000-000000000001', company_id: '08c05f0e-b75b-4c12-870e-d7fb65f1dca0',
  subject: 'Duvida', category: 'suporte', priority: 'normal',
};

function bancoComChaves() {
  const chaves = new Set();
  return {
    chaves,
    query: jest.fn(async (sql, params) => {
      const s = String(sql);
      if (/INSERT INTO email_log/.test(s)) {
        if (chaves.has(params[0])) return { rows: [] };
        chaves.add(params[0]);
        return { rows: [{ id: chaves.size }] };
      }
      if (/FROM companies c/.test(s)) return { rows: [{ loja: 'Loja', quem: 'Ana', email: 'ana@example.com' }] };
      return { rows: [] };
    }),
  };
}

function montar() {
  const db = bancoComChaves();
  const enviar = jest.fn(async () => ({ id: 're_1' }));
  const dedupe = new Set();
  const notifications = {
    notifyCompany: jest.fn(async (_c, p) => {
      if (dedupe.has(p.dedupeKey)) return null;
      dedupe.add(p.dedupeKey);
      return { id: 'n' + dedupe.size };
    }),
  };
  const aviso = (mensagemId, novo = true) => avisarChamado({
    ticket: TICKET, mensagem: 'Oi', mensagemId, userId: 'u1', novo,
    deps: { db, notifications, enviar, enviarEmailRegistrado, env: {} },
  });
  return { db, enviar, notifications, aviso };
}

describe('avisarChamado', () => {
  test('a mesma mensagem avisada duas vezes manda 1 e-mail e 1 sino', async () => {
    const { enviar, notifications, aviso } = montar();
    const a = await aviso('m1');
    const b = await aviso('m1');
    expect(a).toEqual({ email: 'sent', sino: 'criado' });
    expect(b).toEqual({ email: 'duplicate', sino: 'nao_criado' });
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(notifications.notifyCompany).toHaveBeenCalledTimes(2);
    expect(enviar.mock.calls[0][0].to).toBe('contato@getaura.com.br');
  });

  test('outra mensagem do mesmo chamado avisa de novo', async () => {
    const { enviar, aviso } = montar();
    await aviso('m1');
    await aviso('m2', false);
    expect(enviar).toHaveBeenCalledTimes(2);
  });

  test('envio falhando (Resend fora) nao lanca e deixa o sino sair', async () => {
    const { enviar, aviso } = montar();
    enviar.mockRejectedValue(new Error('Resend fora'));
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await aviso('m1');
    expect(r).toEqual({ email: 'failed', sino: 'criado' });
    log.mockRestore();
  });

  test('chave e link', () => {
    expect(chaveDaMensagem('t', 'm')).toBe('chamado:t:m');
    expect(chaveDaMensagem('t')).toBe('chamado:t:abertura');
    expect(linkDoChamado('t', { APP_URL: 'https://x.test/' })).toBe('https://x.test/gestao-aura?chamado=t');
  });
});
