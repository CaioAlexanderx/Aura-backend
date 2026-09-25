// ============================================================
// Vitrine Studio · Fase 2 (B5) — o e-mail de confirmacao da cliente
//
// Verificado em 25/09/2026: o pedido do Studio JA dispara o mesmo e-mail
// "Pedido confirmado" da loja comum — notifyPaymentConfirmed e chamado pelo
// webhook do MP, pelo approve-payment e pelo pagamento na entrega, sem
// filtrar vertical, e ja respeita a loja de teste. O que faltava era o
// LINK: a cliente recebia "confirmado" e nao tinha como voltar ao pedido.
//
// O que trava aqui:
//   - Studio com a vitrine nova: botao para <loja>/pedido/<token>;
//   - Studio na vitrine de hoje: botao para o acompanhamento, que ja existe;
//   - loja comum: e-mail como sempre, sem consulta a mais;
//   - loja de teste: nada sai;
//   - o botao so aceita https e sai escapado.
// ============================================================
'use strict';

jest.mock('../src/config/database');

const db = require('../src/config/database');
const { limparCache } = require('../src/services/lojaDeTeste');

const TOKEN = 'a3f1c2d4e5b6978812ab34cd56ef7890';
const PEDIDO = {
  id: 'o1', company_id: 'c1', order_number: '00123', customer_name: 'Helena Souza',
  customer_email: 'helena@exemplo.com', customer_phone: '12999990000', total: '57.90',
  delivery_type: 'pickup', payment_method: 'pix', vertical: 'studio',
};

let linha;
let sandbox;
let appUrl;

function mockDb() {
  db.query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (/is_sandbox/.test(s)) return { rows: [{ is_sandbox: sandbox }] };
    if (/public_token/.test(s)) {
      if (linha instanceof Error) throw linha;
      return { rows: linha ? [linha] : [] };
    }
    if (/FROM\s+digital_channel_config/i.test(s)) return { rows: [{ site_name: 'Sheid Mania' }] };
    return { rows: [] };
  });
}

beforeEach(() => {
  jest.resetModules();
  limparCache();
  db.query.mockReset();
  sandbox = false;
  appUrl = process.env.APP_PUBLIC_URL;
  process.env.APP_PUBLIC_URL = 'https://app.getaura.com.br';
  linha = {
    public_token: TOKEN, vertical: 'studio', slug: 'sheid-mania',
    custom_domain: null, custom_domain_status: null, studio_settings: { vitrine_v2: true },
  };
  mockDb();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  process.env.APP_PUBLIC_URL = appUrl;
  jest.restoreAllMocks();
});

describe('linkDoPedidoDaVitrine', () => {
  const { linkDoPedidoDaVitrine } = require('../src/services/digitalOrderNotifications');

  test('vitrine nova: a confirmacao no endereco da loja', async () => {
    expect(await linkDoPedidoDaVitrine(PEDIDO)).toEqual({
      url: `https://loja.getaura.com.br/sheid-mania/pedido/${TOKEN}`, rotulo: 'Ver meu pedido',
    });
  });

  test('vitrine nova com dominio proprio', async () => {
    linha.custom_domain = 'www.sheidmania.com.br';
    linha.custom_domain_status = 'active';
    expect((await linkDoPedidoDaVitrine(PEDIDO)).url).toBe(`https://www.sheidmania.com.br/pedido/${TOKEN}`);
  });

  test('vitrine de hoje: o acompanhamento, que ja existe', async () => {
    linha.studio_settings = {};
    expect(await linkDoPedidoDaVitrine(PEDIDO)).toEqual({
      url: `https://app.getaura.com.br/acompanhar/${TOKEN}`, rotulo: 'Acompanhar meu pedido',
    });
  });

  test('sem endereco absoluto do app, sem link (nunca um link relativo no e-mail)', async () => {
    linha.studio_settings = {};
    process.env.APP_PUBLIC_URL = '';
    expect(await linkDoPedidoDaVitrine(PEDIDO)).toBeNull();
  });

  test('loja comum: sem link e sem consulta', async () => {
    expect(await linkDoPedidoDaVitrine({ ...PEDIDO, vertical: 'retail' })).toBeNull();
    expect(await linkDoPedidoDaVitrine({ ...PEDIDO, vertical: undefined })).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('sem token ou com erro no banco: e-mail sem botao, nunca excecao', async () => {
    linha.public_token = null;
    expect(await linkDoPedidoDaVitrine(PEDIDO)).toBeNull();
    linha = Object.assign(new Error('column "public_token" does not exist'), { code: '42703' });
    expect(await linkDoPedidoDaVitrine(PEDIDO)).toBeNull();
  });
});

describe('notifyPaymentConfirmed no Studio', () => {
  function comMailerMockado() {
    jest.doMock('../src/services/mailer', () => ({
      sendOrderStatusEmail: jest.fn().mockResolvedValue(undefined),
      sendOwnerNewOrderEmail: jest.fn().mockResolvedValue(undefined),
    }));
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    const mailer = require('../src/services/mailer');
    const notify = require('../src/services/digitalOrderNotifications');
    // resetModules cria um mock NOVO do banco: o notificador usa este.
    const dbNovo = require('../src/config/database');
    dbNovo.query.mockImplementation(db.query.getMockImplementation());
    return { mailer, notify };
  }

  test('o e-mail da cliente leva o link do pedido', async () => {
    const { mailer, notify } = comMailerMockado();
    await notify.notifyPaymentConfirmed({ order: PEDIDO });
    const [to, dados] = mailer.sendOrderStatusEmail.mock.calls[0];
    expect(to).toBe('helena@exemplo.com');
    expect(dados).toMatchObject({ status: 'confirmed', order_number: '00123' });
    expect(dados.link).toEqual({ url: `https://loja.getaura.com.br/sheid-mania/pedido/${TOKEN}`, rotulo: 'Ver meu pedido' });
  });

  test('loja comum: o mesmo e-mail de sempre, sem link', async () => {
    const { mailer, notify } = comMailerMockado();
    await notify.notifyPaymentConfirmed({ order: { ...PEDIDO, vertical: 'retail' } });
    expect(mailer.sendOrderStatusEmail.mock.calls[0][1]).not.toHaveProperty('link');
  });

  test('loja de teste: nenhum e-mail sai', async () => {
    sandbox = true;
    const { mailer, notify } = comMailerMockado();
    await notify.notifyPaymentConfirmed({ order: PEDIDO });
    expect(mailer.sendOrderStatusEmail).not.toHaveBeenCalled();
    expect(mailer.sendOwnerNewOrderEmail).not.toHaveBeenCalled();
  });
});

describe('sendOrderStatusEmail com link', () => {
  let chave;
  beforeEach(() => {
    // O describe de cima trocou o mailer por um mock (doMock sobrevive ao
    // resetModules); aqui o que se testa e o de verdade.
    jest.dontMock('../src/services/mailer');
    chave = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = 're_teste';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'm1' }) });
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    if (chave == null) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = chave;
  });
  const enviado = () => JSON.parse(global.fetch.mock.calls[0][1].body);

  test('botao no HTML e o link no texto', async () => {
    const { sendOrderStatusEmail } = require('../src/services/mailer');
    await sendOrderStatusEmail('helena@exemplo.com', {
      order_number: '00123', customer_name: 'Helena', status: 'confirmed', store_name: 'Sheid Mania',
      link: { url: `https://loja.getaura.com.br/sheid-mania/pedido/${TOKEN}`, rotulo: 'Ver meu pedido' },
    });
    const m = enviado();
    expect(m.html).toContain(`href="https://loja.getaura.com.br/sheid-mania/pedido/${TOKEN}"`);
    expect(m.html).toContain('>Ver meu pedido</a>');
    expect(m.text).toContain(`Ver meu pedido: https://loja.getaura.com.br/sheid-mania/pedido/${TOKEN}`);
  });

  test('sem link, ou com link que nao e https: o e-mail de sempre', async () => {
    const { sendOrderStatusEmail } = require('../src/services/mailer');
    await sendOrderStatusEmail('a@b.com', { order_number: '1', customer_name: 'A', status: 'confirmed', store_name: 'L' });
    await sendOrderStatusEmail('a@b.com', {
      order_number: '1', customer_name: 'A', status: 'confirmed', store_name: 'L',
      link: { url: 'javascript:alert(1)', rotulo: 'x' },
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    for (const call of global.fetch.mock.calls) {
      const m = JSON.parse(call[1].body);
      // O rodape do layout ja tem um link (getaura.com.br); o botao nao.
      expect(m.html).not.toContain('javascript:');
      expect(m.html).not.toContain('padding:12px 22px;border-radius:12px');
      expect(m.text).not.toContain('Ver meu pedido');
    }
  });

  test('url e rotulo saem escapados', async () => {
    const { sendOrderStatusEmail } = require('../src/services/mailer');
    await sendOrderStatusEmail('a@b.com', {
      order_number: '1', customer_name: 'A', status: 'confirmed', store_name: 'L',
      link: { url: 'https://x.com/"><script>', rotulo: '<b>oi</b>' },
    });
    const m = enviado();
    expect(m.html).not.toContain('"><script>');
    expect(m.html).toContain('&quot;>&lt;script>');
    expect(m.html).toContain('&lt;b>oi&lt;/b>');
  });
});
