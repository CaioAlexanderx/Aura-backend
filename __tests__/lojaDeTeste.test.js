// ============================================================
// A loja de teste (04/09/2026)
//
// Na rodada de QA de 03/09 NENHUM checkout foi concluido: na loja de um
// cliente real e proibido, e a conta de demonstracao nao espelha uma loja
// Studio de verdade. A tela de confirmacao — a ultima que a cliente ve —
// foi avaliada lendo codigo.
//
// O que estes testes guardam e o que torna a loja de teste SEGURA: que a
// trava esta antes dos envios, que ela falha para o lado de notificar, e
// que o script que apaga catalogo se recusa a rodar fora dela.
// ============================================================
const fs = require('fs');
const path = require('path');

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
const db = require('../src/config/database');
const { ehLojaDeTeste, pixDeTeste, limparCache } = require('../src/services/lojaDeTeste');

const EMPRESA = '11111111-1111-1111-1111-111111111111';

beforeEach(() => { limparCache(); db.query.mockReset(); });

describe('quem e loja de teste', () => {
  test('a empresa com a trava ligada', async () => {
    db.query.mockResolvedValue({ rows: [{ is_sandbox: true }] });
    expect(await ehLojaDeTeste(EMPRESA)).toBe(true);
  });

  test('empresa real, com a trava desligada', async () => {
    db.query.mockResolvedValue({ rows: [{ is_sandbox: false }] });
    expect(await ehLojaDeTeste(EMPRESA)).toBe(false);
  });

  test('sem empresa, nem consulta o banco', async () => {
    expect(await ehLojaDeTeste(null)).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('a segunda pergunta nao vai ao banco', async () => {
    // E caminho quente: roda em toda notificacao de toda loja real.
    db.query.mockResolvedValue({ rows: [{ is_sandbox: true }] });
    await ehLojaDeTeste(EMPRESA);
    await ehLojaDeTeste(EMPRESA);
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

describe('na duvida, a loja e real', () => {
  test('migration ainda nao aplicada nao silencia loja de verdade', async () => {
    // O backend sobe antes da migration. Se o erro virasse `true`, toda
    // loja no ar pararia de notificar ate a migration chegar.
    const e = new Error('column "is_sandbox" does not exist'); e.code = '42703';
    db.query.mockRejectedValue(e);
    expect(await ehLojaDeTeste(EMPRESA)).toBe(false);
  });

  test('banco fora do ar tambem responde "real"', async () => {
    db.query.mockRejectedValue(new Error('connection terminated'));
    expect(await ehLojaDeTeste(EMPRESA)).toBe(false);
  });

  test('empresa que nao existe nao vira loja de teste', async () => {
    db.query.mockResolvedValue({ rows: [] });
    expect(await ehLojaDeTeste(EMPRESA)).toBe(false);
  });
});

describe('o Pix de mentira', () => {
  const pedido = { id: 'abc', order_number: 42 };

  test('tem a forma do de verdade, para a tela renderizar inteira', () => {
    const p = pixDeTeste(pedido, 89.9);
    expect(p).toHaveProperty('payment_id');
    expect(p).toHaveProperty('payload');
    expect(p).toHaveProperty('expires_at');
  });

  test('o payload NAO e um codigo Pix valido', () => {
    // Um payload bem-formado seria uma cobranca de teste esperando
    // alguem pagar por engano.
    const p = pixDeTeste(pedido, 89.9);
    expect(p.payload).toMatch(/LOJA DE TESTE/);
    expect(p.payload).not.toMatch(/^000201/); // preambulo do BR Code
    expect(p.teste).toBe(true);
  });

  test('mostra o valor do pedido, que e o que se confere na tela', () => {
    expect(pixDeTeste(pedido, 89.9).payload).toContain('R$ 89.90');
  });
});

describe('a trava fica ANTES dos envios', () => {
  const notif = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'digitalOrderNotifications.js'), 'utf8');

  /**
   * O corpo de uma funcao, para comparar posicoes DENTRO dela.
   *
   * Comparar contra o arquivo inteiro daria falso negativo: as funcoes
   * auxiliares sao declaradas no topo e `indexOf` acha a primeira
   * ocorrencia, nao a que esta no fluxo.
   */
  function corpoDe(nome) {
    const inicio = notif.indexOf(`async function ${nome}(`);
    expect(inicio).toBeGreaterThan(-1);
    const fim = notif.indexOf('\nasync function ', inicio + 1);
    return notif.slice(inicio, fim === -1 ? undefined : fim);
  }

  test('no pagamento confirmado, antes do push e dos e-mails', () => {
    const corpo = corpoDe('notifyPaymentConfirmed');
    const trava = corpo.indexOf('ehLojaDeTeste(company_id)');
    const push = corpo.indexOf('await getOwnerPushTokens(company_id)');
    expect(trava).toBeGreaterThan(0);
    expect(push).toBeGreaterThan(0);
    expect(trava).toBeLessThan(push);
  });

  test('na mudanca de status, antes do e-mail ao cliente', () => {
    const corpo = corpoDe('notifyStatusChange');
    const trava = corpo.indexOf('ehLojaDeTeste(order.company_id)');
    const email = corpo.indexOf('sendOrderStatusEmail(');
    expect(trava).toBeGreaterThan(0);
    expect(email).toBeGreaterThan(0);
    expect(trava).toBeLessThan(email);
  });

  test('o bloqueio fica no log — senao vira achado falso', () => {
    // Um teste que nao recebe o WhatsApp esperado e indistinguivel de um
    // defeito de integracao.
    expect(notif).toContain('anotarBloqueio(');
  });
});

describe('a cobranca tambem para na trava', () => {
  const rota = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'studioStorefront.js'), 'utf8');

  test('loja de teste nao chama gateway nenhum', () => {
    const trava = rota.indexOf("pmethod === 'pix' && lojaDeTeste");
    const mp = rota.indexOf('createMpPixPayment({');
    expect(trava).toBeGreaterThan(0);
    expect(trava).toBeLessThan(mp);
  });

  test('mas ainda devolve Pix, para a confirmacao ser testavel', () => {
    expect(rota).toContain('pixData = pixDeTeste(order, total)');
  });
});

describe('o script que apaga catalogo se recusa fora da loja de teste', () => {
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'clonar-loja.js'), 'utf8');

  test('a recusa e por is_sandbox, e vem antes de qualquer DELETE', () => {
    const guarda = script.indexOf('destino.is_sandbox !== true');
    const apaga = script.indexOf('await apagarLojaDeTeste(');
    expect(guarda).toBeGreaterThan(0);
    expect(guarda).toBeLessThan(apaga);
  });

  test('nao copia chave de pagamento do cliente', () => {
    // Levar a chave Pix de uma lojista para a loja de teste criaria um
    // caminho para alguem pagar na conta errada.
    expect(script).not.toMatch(/'pix_key'|"pix_key"/);
    expect(script).not.toMatch(/access_token/);
  });

  test('nao copia pedido nem cliente da loja de origem', () => {
    const campos = script.slice(script.indexOf('CAMPOS_DO_CANAL'), script.indexOf('async function lojaPorSlug'));
    expect(campos).not.toContain('customer');
    expect(campos).not.toContain('order');
  });
});
