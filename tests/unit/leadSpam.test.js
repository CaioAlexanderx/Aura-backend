// ============================================================
// AURA. -- Filtro anti-robo do formulario do site (t2-12): regras puras
//
// Os "robos" abaixo reproduzem as familias reais vistas em sales_leads em
// 14/10/2026 (40 de 46 contatos). Os "reais" sao o que NAO pode cair: nomes
// brasileiros comuns, mensagens em portugues, lead parcial so com telefone.
// ============================================================
'use strict';

const { avaliarLead, validarTurnstile, tokenDoTurnstile, nomeDeRobo, majoritariamenteIngles } = require('../../src/services/leadSpam');

const motivo = (b, opts) => {
  const v = avaliarLead(b, opts);
  return v.spam ? v.motivo : null;
};

describe('avaliarLead -- robos reais de 14/10/2026', () => {
  test.each([
    ['Harryseeno', 'A 2026 ROLLS-ROYCE PHANTOM FOR $15,000 https://telegra.ph/How-to-get-a-new-2026-Rolls-Royce-Phantom'],
    ['Harryseeno', 'The $30,000,000 Jackpot Is a Triumph in the Making https://1.g9.yt/z4cyo'],
    ['Harryseeno', 'YOUR $25,000 PROMO CODE FOR A BASH https://gnosis.link/oKKYmm'],
    ['Roberthaupt', 'Hola, volia saber el seu preu.'],
    ['Roberthaupt', 'Szia, meg akartam tudni az árát.'],
    ['Robinscawl', 'Egjnjmfnefjwdifj fkmdkdwdwkdwjj fkmfkengjkfmsdnfejfk mkfmkdmwjefnejfem getaura.com.br'],
  ])('nome conhecido: %s', (nome, mensagem) => {
    expect(motivo({ nome, mensagem, elapsed_ms: 9000 })).toBe('nome_conhecido');
  });

  test.each([
    'Gostaria de mais informações. Por favor, contacte-me por e-mail — erp e sistema de gestão para loja.',
    'Gostaria de mais informações. Por favor, contacte-me por e-mail — sistema de gestão para loja.',
    'gostaria de mais informacoes. por favor, contacte me por email',
  ])('mensagem-modelo traduzida, com nome comum em ingles: %s', (mensagem) => {
    for (const nome of ['Andrew', 'Donald', 'Sarah', 'Grace', 'Hannah', 'Melissa', 'Emma']) {
      expect(motivo({ nome, mensagem, elapsed_ms: 12000 })).toBe('mensagem_modelo');
    }
  });

  test.each([
    ['Desmond', 'Welcome from Bonusbacklinks,\r\n\r\nBest seo services to skyrocket your website backlinks! BonusBacklinks.com'],
    ['Juhi', 'Hello http://getaura.com.br,\r\n\r\nI recently analyzed your website and found several improvements that can boost organic traffic'],
    ['Henry', 'Hi,\r\n\r\nI was looking over your website and noticed a few specific areas where optimization could boost your rankings'],
    ['France', 'Boost up your backlinks with professional seo backlinks and google visibility Dailyseolinks.com - we deliver daily backlinks'],
    ['Tom', 'Win a free PlayStation 5 today, enter now https://example.xyz/win'],
  ])('ingles com link ou golpe/SEO: %s', (nome, mensagem) => {
    expect(motivo({ nome, mensagem, elapsed_ms: 15000 })).toBe('mensagem_em_ingles');
  });

  test('link e nenhuma palavra em portugues', () => {
    expect(motivo({ nome: 'Zed', mensagem: 'asdkj qweoi zxcmn bbb.top/abc', elapsed_ms: 9000 })).toBe('link_em_outra_lingua');
  });

  test('nome que e um link', () => {
    expect(motivo({ nome: 'https://promo.example.top', mensagem: 'oi', elapsed_ms: 9000 })).toBe('nome_com_link');
  });
});

describe('avaliarLead -- tempo de preenchimento', () => {
  const real = { nome: 'Marina Prado', mensagem: 'Quero conhecer o sistema para a minha loja.' };

  test('menos de 3 s no envio completo = robo', () => {
    expect(motivo({ ...real, elapsed_ms: 1200 })).toBe('rapido_demais');
    expect(motivo({ ...real, elapsed_ms: 2999 })).toBe('rapido_demais');
    expect(motivo({ ...real, elapsed_ms: '800' })).toBe('rapido_demais');
    expect(motivo({ ...real, elapsed_ms: 0 })).toBe('rapido_demais');
  });
  test('3 s ou mais passa', () => {
    expect(motivo({ ...real, elapsed_ms: 3000 })).toBeNull();
    expect(motivo({ ...real, elapsed_ms: 45000 })).toBeNull();
  });
  test('sem elapsed_ms (site antigo) ou valor invalido: a regra nao se aplica', () => {
    expect(motivo({ ...real })).toBeNull();
    expect(motivo({ ...real, elapsed_ms: null })).toBeNull();
    expect(motivo({ ...real, elapsed_ms: '' })).toBeNull();
    expect(motivo({ ...real, elapsed_ms: 'abc' })).toBeNull();
    expect(motivo({ ...real, elapsed_ms: -5 })).toBeNull();
  });
  test('vale tambem para o lead parcial (o Worker do site ja descarta < 3 s)', () => {
    expect(motivo({ nome: '', whatsapp: '12 99999-0000', elapsed_ms: 900, partial: true })).toBe('rapido_demais');
    expect(motivo({ nome: '', whatsapp: '12 99999-0000', elapsed_ms: 5000, partial: true })).toBeNull();
  });
});

describe('avaliarLead -- quem NAO pode cair no filtro', () => {
  test.each([
    ['Marina Prado', 'Quero conhecer o sistema para a minha loja de roupas.'],
    ['Otávio Reis', 'Boa tarde! Vocês emitem nota fiscal? Qual o valor do plano Negócio?'],
    ['João da Silva', 'Preciso de um sistema de estoque e caixa para a minha padaria.'],
    ['Maria Aparecida', 'oi'],
    ['Ana Beatriz Souza', ''],
    ['Carlos', 'Tenho uma ótica em Jacareí e queria ver uma demonstração. Meu site é www.oticacarlos.com.br'],
    ['Luciana Ferreira', 'Gostaria de saber o preço. Podem me chamar no WhatsApp?'],
    ['Robson Hauptmann', 'Quero um orçamento para a minha loja.'],
    ['Roberta Seno', 'Quero saber o valor do plano anual.'],
    ['Andrew Silva', 'Preciso de ajuda para migrar o estoque da minha loja para o Aura.'],
    ['Hannah Costa', 'Gostaria de mais informações sobre o plano para a minha loja.'],
    ['Pedro', 'Contate-me por favor no WhatsApp.'],
    ['Fernanda', 'Meu e-mail é fernanda@lojadafe.com.br, me chama la.'],
    ['Studio Dani', 'Vi o instagram de vocês: instagram.com/aura. Quero testar o sistema.'],
  ])('%s: %s', (nome, mensagem) => {
    expect(motivo({ nome, mensagem, elapsed_ms: 20000 })).toBeNull();
  });

  test('lead parcial com telefone no lugar do nome e pedido de ligacao (os 3 reais de hoje)', () => {
    expect(motivo({ nome: '(96) 99188-9193', whatsapp: '(96) 99188-9193', mensagem: 'Pediu para ser chamado no WhatsApp (site: /)', partial: true })).toBeNull();
    expect(motivo({ nome: '75992384611', whatsapp: '75992384611' })).toBeNull();
  });

  test('mensagem curta em ingles sem link nem golpe nao e barrada (estrangeiro de verdade)', () => {
    expect(motivo({ nome: 'John Smith', mensagem: 'Hello, I would like to know the price of your plan.', elapsed_ms: 20000 })).toBeNull();
  });
});

describe('nomeDeRobo -- variacoes', () => {
  test.each(['Harryseeno', 'harryseeno', 'HARRYSEENO', 'Harry Seeno', 'harry.seeno', 'Harryseeno123', 'Harryseno', 'Robert Haupt', 'Roberthaupt!', 'Robinscawl', 'Robin Scawl'])('%s', (n) => {
    expect(nomeDeRobo(n)).toBe(true);
  });
  test.each(['Marina', 'Roberto', 'Robson', 'Harry', 'Roberta Silva', 'Haupt', '', null, undefined, 42, '(11) 99999-0000'])('%p nao', (n) => {
    expect(nomeDeRobo(n)).toBe(false);
  });
});

describe('majoritariamenteIngles', () => {
  test('ingles sim, portugues nao, curto nao', () => {
    expect(majoritariamenteIngles('Best seo services to boost your website and rankings with our team')).toBe(true);
    expect(majoritariamenteIngles('Quero um sistema para a minha loja com nota fiscal e estoque')).toBe(false);
    expect(majoritariamenteIngles('Hello there')).toBe(false);
  });
});

describe('tokenDoTurnstile', () => {
  test('aceita os tres nomes de campo e ignora o que nao e texto', () => {
    expect(tokenDoTurnstile({ turnstile_token: 'abc' })).toBe('abc');
    expect(tokenDoTurnstile({ 'cf-turnstile-response': 'def' })).toBe('def');
    expect(tokenDoTurnstile({ cf_turnstile_response: 'ghi' })).toBe('ghi');
    expect(tokenDoTurnstile({ turnstile_token: 123 })).toBeNull();
    expect(tokenDoTurnstile({ turnstile_token: 'x'.repeat(5000) })).toBeNull();
    expect(tokenDoTurnstile({})).toBeNull();
  });
});

describe('validarTurnstile', () => {
  const resposta = (status, json) => async () => ({ status, json: async () => json });

  test('success true = ok; envia segredo e token por formulario para o siteverify da Cloudflare', async () => {
    const fetchImpl = jest.fn(resposta(200, { success: true }));
    expect(await validarTurnstile('tok', { secret: 's3', fetchImpl })).toBe('ok');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toBe('secret=s3&response=tok');
  });
  test('success false = invalido', async () => {
    expect(await validarTurnstile('tok', { secret: 's', fetchImpl: resposta(200, { success: false, 'error-codes': ['invalid-input-response'] }) })).toBe('invalido');
    expect(await validarTurnstile('tok', { secret: 's', fetchImpl: resposta(200, { success: false, 'error-codes': ['timeout-or-duplicate'] }) })).toBe('invalido');
  });
  test('falha nossa (segredo errado) nao marca o visitante', async () => {
    expect(await validarTurnstile('tok', { secret: 's', fetchImpl: resposta(200, { success: false, 'error-codes': ['invalid-input-secret'] }) })).toBe('indisponivel');
  });
  test('Cloudflare fora do ar, erro de rede ou timeout: indisponivel (falha aberta)', async () => {
    expect(await validarTurnstile('tok', { secret: 's', fetchImpl: resposta(503, {}) })).toBe('indisponivel');
    expect(await validarTurnstile('tok', { secret: 's', fetchImpl: async () => { throw new Error('ECONNRESET'); } })).toBe('indisponivel');
    expect(await validarTurnstile('tok', { secret: 's', fetchImpl: async () => ({ status: 200, json: async () => { throw new Error('nao e json'); } }) })).toBe('indisponivel');
  });
  test('sem segredo ou sem token: nada a validar', async () => {
    const fetchImpl = jest.fn();
    expect(await validarTurnstile('tok', { secret: '', fetchImpl })).toBe('indisponivel');
    expect(await validarTurnstile('', { secret: 's', fetchImpl })).toBe('indisponivel');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
