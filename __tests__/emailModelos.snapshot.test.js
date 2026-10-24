// ============================================================
// AURA. — Modelo único dos e-mails: snapshot de cada modelo (tq-75, 24/10/2026)
//
// Um snapshot por e-mail que sai: os sete que já saíam (verificação, portal
// do Karatê, senha, convite, status do pedido ao cliente final, pedido novo
// à lojista, relatório semanal) e os de cobrança novos (2.1 a 2.10, recibo,
// estorno, contestação, cartão recusado). Mais as regras que valem para
// todos: modo claro com escuro por prefers-color-scheme, logo por URL fixa,
// WhatsApp da Aura onde o card manda (e nunca no e-mail ao cliente final
// nem no portal), letra só nas cartas, frases proibidas fora.
// ============================================================
'use strict';

const ENV = { ...process.env };

function carregar() {
  jest.resetModules();
  process.env = { ...ENV, RESEND_API_KEY: 'k', API_URL: 'https://api.exemplo.test/api/v1' };
  delete process.env.AURA_WHATSAPP;
  delete process.env.EMAIL_LINK_SECRET;
  delete process.env.MAIL_FROM;
  delete process.env.SMTP_FROM;
  const corpos = [];
  global.fetch = jest.fn(async (url, init) => {
    corpos.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ id: 're_' + corpos.length }) };
  });
  return { mailer: require('../src/services/mailer'), corpos };
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...ENV };
});

const WA_AURA = 'https://wa.me/5511956305269';
const LETRA = 'assinatura-caio-alexander-v1.png';
const PROIBIDAS = [/nada se perde/i, /tudo volta na hora/i];

function regrasComuns(html) {
  expect(html).toContain('<meta name="color-scheme" content="light dark">');
  expect(html).toContain('@media (prefers-color-scheme: dark)');
  expect(html).toContain('background:#f4f1fb'); // claro é o padrão (inline)
  expect(html).not.toContain('cid:');
  for (const f of PROIBIDAS) expect(html).not.toMatch(f);
}

describe('e-mails que já saíam, no modelo único', () => {
  test('verificação de e-mail (aura-transacional, sem letra)', async () => {
    const { mailer, corpos } = carregar();
    await mailer.sendVerificationLinkEmail('ana@exemplo.com', 'https://api.exemplo.test/api/v1/auth/confirm-email/tok', 'Ana Souza', '123456');
    const { html } = corpos[0];
    regrasComuns(html);
    expect(html).toContain('https://app.getaura.com.br/email/aura-logo-v1.png');
    expect(html).toContain('alt="Aura"');
    expect(html).toContain(WA_AURA);
    expect(html).not.toContain(LETRA);
    expect(html).toContain('href="https://api.exemplo.test/api/v1/auth/confirm-email/tok"');
    expect(html).toMatchSnapshot();
  });

  test('portal do Karatê (portal: sem WhatsApp da Aura, sem letra, sem logo da Aura)', async () => {
    const { mailer, corpos } = carregar();
    await mailer.sendVerificationEmail('atleta@exemplo.com', '654321', 'Atleta Teste');
    const { html } = corpos[0];
    regrasComuns(html);
    expect(html).not.toContain('wa.me');
    expect(html).not.toContain(LETRA);
    expect(html).not.toContain('aura-logo-v1.png');
    expect(html).toMatchSnapshot();
  });

  test('redefinição de senha', async () => {
    const { mailer, corpos } = carregar();
    await mailer.sendPasswordResetEmail('ana@exemplo.com', 'https://app.getaura.com.br/reset-password?token=t', 'Ana');
    const { html } = corpos[0];
    regrasComuns(html);
    expect(html).toContain(WA_AURA);
    expect(html).not.toContain(LETRA);
    expect(html).toMatchSnapshot();
  });

  test('convite de equipe (nomes escapados)', async () => {
    const { mailer, corpos } = carregar();
    await mailer.sendInviteEmail('novo@exemplo.com', 'https://app.getaura.com.br/convite/abc', 'Loja <b>X</b>', 'Vendedor', 'Ana');
    const { html } = corpos[0];
    regrasComuns(html);
    expect(html).not.toContain('<b>X</b>');
    expect(html).toContain('Loja &lt;b&gt;X&lt;/b&gt;');
    expect(html).not.toContain(LETRA);
    expect(html).toMatchSnapshot();
  });

  test('status do pedido ao cliente final (loja: marca e WhatsApp da loja)', async () => {
    const { mailer, corpos } = carregar();
    await mailer.sendOrderStatusEmail('cliente@exemplo.com', {
      order_number: '0042', customer_name: 'Helena Lima', status: 'ready', store_name: 'Sheid Mania',
      store_email: 'loja@sheid.com.br', store_whatsapp: '(12) 98136-5134',
      store_logo_url: 'https://r2.getaura.com.br/logos/sheid.png',
      link: { url: 'https://loja.getaura.com.br/sheid-mania/pedido/tok', rotulo: 'Ver meu pedido' },
    });
    const { html } = corpos[0];
    regrasComuns(html);
    expect(html).not.toContain(WA_AURA);
    expect(html).toContain('https://wa.me/5512981365134?text=');
    expect(html).not.toContain(LETRA);
    expect(html).not.toContain('aura-logo-v1.png');
    expect(html).toContain('Enviado pela Aura para Sheid Mania.');
    expect(html).toMatchSnapshot();
  });

  test('status do pedido sem WhatsApp da loja: sem botão de WhatsApp', async () => {
    const { mailer, corpos } = carregar();
    await mailer.sendOrderStatusEmail('cliente@exemplo.com', { order_number: '1', customer_name: 'A', status: 'confirmed', store_name: 'L' });
    expect(corpos[0].html).not.toContain('wa.me');
  });

  test('pedido novo à lojista (aura-transacional)', async () => {
    const { mailer, corpos } = carregar();
    await mailer.sendOwnerNewOrderEmail('lojista@exemplo.com', {
      order_number: '0042', customer_name: 'Helena', customer_phone: '(12) 98136-5134', total: 129.9,
      delivery_type: 'delivery', store_name: 'Sheid Mania', payment_method: 'pix',
    });
    const { html } = corpos[0];
    regrasComuns(html);
    expect(html).toContain(WA_AURA);
    expect(html).toContain('href="https://wa.me/5512981365134"');
    expect(html).toMatchSnapshot();
  });

  test('relatório semanal: link de descadastro no rodapé + List-Unsubscribe', async () => {
    const { mailer, corpos } = carregar();
    await mailer.sendWeeklyReport(
      { id: '11111111-1111-4111-8111-111111111111', name: 'Finesse', email: 'dona@exemplo.com' },
      { revenue: 4820, sales: 31, avg_ticket: 155.48, health_score: 72 },
      'https://app.getaura.com.br/relatorios/semanal/tok'
    );
    const c = corpos[0];
    regrasComuns(c.html);
    expect(c.html).toContain(WA_AURA);
    expect(c.html).not.toContain(LETRA); // o relatório não leva a letra
    expect(c.html).toContain('Parar de receber</a>');
    expect(c.headers['List-Unsubscribe']).toMatch(/^<https:\/\/api\.exemplo\.test\/api\/v1\/emails\/descadastro\/[^>]+>$/);
    expect(c.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const link = c.headers['List-Unsubscribe'].slice(1, -1);
    expect(c.html).toContain(`href="${link}"`);
    expect(c.text).toContain(`Parar de receber: ${link}`);
    // tq-88: "Ajustar meus e-mails" abre Configurações > E-mails da empresa.
    const ajustar = 'https://app.getaura.com.br/configuracoes?foco=emails&amp;empresa=11111111-1111-4111-8111-111111111111';
    expect(c.html).toContain(`href="${ajustar}"`);
    expect(c.html).toContain('Ajustar meus e-mails</a>');
    expect(c.html).toContain('Você recebe este resumo toda segunda, às 8h.');
    expect(c.html).toMatchSnapshot();
  });

  test('relatório semanal (tq-88): dia e hora escolhidos, vários destinatários, sem registro duplo', async () => {
    const { mailer, corpos } = carregar();
    const registros = [];
    mailer.definirRegistroDeEnvio((i) => registros.push(i));
    await mailer.sendWeeklyReport(
      { id: '11111111-1111-4111-8111-111111111111', name: 'Finesse', email: 'dona@exemplo.com' },
      { revenue: 4820, sales: 31, avg_ticket: 155.48, health_score: 72 },
      'https://app.getaura.com.br/relatorios/semanal/tok',
      { destinatarios: ['dona@exemplo.com', 'financeiro@exemplo.com'], config: { dia: 0, hora: 18 }, registrado: true }
    );
    expect(corpos[0].to).toEqual(['dona@exemplo.com', 'financeiro@exemplo.com']);
    expect(corpos[0].html).toContain('Você recebe este resumo todo domingo, às 18h.');
    expect(registros).toHaveLength(0); // o scheduler já reservou a linha no email_log
  });

  test('confirmação de endereço extra (tq-87, aura-transacional, sem letra)', async () => {
    carregar();
    const { montarConfirmacao } = require('../src/services/emailEnderecos');
    const c = montarConfirmacao({ loja: 'Finesse', email: 'financeiro@exemplo.com', link: 'https://api.exemplo.test/api/v1/emails/confirmar/tok' });
    regrasComuns(c.html);
    expect(c.assunto).toBe('Confirme este e-mail para receber os avisos da Finesse');
    expect(c.html).toContain('href="https://api.exemplo.test/api/v1/emails/confirmar/tok"');
    expect(c.html).not.toContain(LETRA);
    expect(c.text).toContain('https://api.exemplo.test/api/v1/emails/confirmar/tok');
    expect(c.html).toMatchSnapshot();
  });
});

describe('cobrança (aura-carta, com a letra)', () => {
  const PIX = { copiaECola: '00020126580014br.gov.bcb.pix0136a1b2c3d4-0000-1111-2222-3333444455556304ABCD', qrUrl: 'https://api.exemplo.test/api/v1/emails/pix-qr/x.png' };
  const BASE = {
    nome: 'Maria', loja: 'Modas da Maria', valor: 169, vencimento: '2026-11-20',
    pix: PIX, linkFatura: 'https://www.asaas.com/i/abc',
    pausaTelas: '2026-11-27', pausaCaixa: '2026-12-04', diasParaPausaDoCaixa: 3,
  };
  let C;
  beforeEach(() => {
    jest.resetModules();
    delete process.env.AURA_WHATSAPP;
    C = require('../src/services/emailsCobranca');
  });

  const casos = [
    ['2.1 lembrete 2 dias antes', () => C.lembreteDoisDias(BASE), 'Sua mensalidade da Aura vence sexta-feira'],
    ['2.2 vence hoje', () => C.venceHoje(BASE), 'Hoje vence a mensalidade da Aura'],
    ['2.3 atraso de 1 dia', () => C.atrasoUmDia(BASE), 'A mensalidade da Aura de 20/11 ainda está em aberto'],
    ['2.4 atraso de 3 dias', () => C.atrasoTresDias(BASE), 'Sobre a mensalidade da Aura: posso ajudar?'],
    ['2.5 atraso de 7 dias', () => C.atrasoSeteDias(BASE), 'Preciso falar com você sobre a mensalidade da Aura'],
    ['2.9 Caixa pausa em 3 dias', () => C.caixaPausaEmDias(BASE), 'Seu Caixa da Aura pausa em 3 dias'],
    ['2.10 Caixa pausado', () => C.caixaPausado(BASE), 'O Caixa da Aura está pausado'],
    ['2.7 recibo', () => C.pagamentoConfirmado({ ...BASE, billingType: 'PIX', dataPagamento: '2026-11-20', proximoVencimento: '2026-12-20', linkComprovante: 'https://www.asaas.com/comprovantes/1' }), 'Recebi seu pagamento, obrigado!'],
    ['estorno', () => C.pagamentoEstornado(BASE), 'Estorno da mensalidade da Aura'],
    ['contestação', () => C.pagamentoContestado(BASE), 'Recebi um aviso de contestação da mensalidade da Aura'],
    ['2.8 cartão recusado (nova tentativa desligada)', () => C.cartaoRecusado({ ...BASE, cartaoFinal: '4821', comNovaTentativa: false }), 'O cartão não passou na mensalidade da Aura'],
    ['2.8 cartão recusado (nova tentativa ligada)', () => C.cartaoRecusado({ ...BASE, cartaoFinal: '4821', comNovaTentativa: true }), 'O cartão não passou na mensalidade da Aura'],
    ['2.8b segunda recusa', () => C.cartaoRecusadoDeNovo({ ...BASE, cartaoFinal: '4821', hoje: '2026-11-21' }), 'O cartão não passou de novo na mensalidade da Aura'],
  ];

  test.each(casos)('%s', (_nome, montar, assunto) => {
    const e = montar();
    expect(e.assunto).toBe(assunto);
    regrasComuns(e.html);
    expect(e.html).toContain(LETRA);
    expect(e.html).toContain('alt="Caio Alexander"');
    expect(e.html).toContain('Caio Alexander, fundador da Aura');
    expect(e.html).toContain(WA_AURA + '?text=');
    for (const f of PROIBIDAS) expect(e.text).not.toMatch(f);
    expect(e.html).toMatchSnapshot();
    expect(e.text).toMatchSnapshot();
  });

  test('valores em reais e datas dd/mm', () => {
    const e = C.atrasoTresDias({ ...BASE, valor: 1234.5 });
    expect(e.text).toContain('R$ 1.234,50');
    expect(e.text).toContain('a partir de 27/11 o acesso às outras telas fica pausado');
  });

  test('2.5 diz a pausa das telas e a data do Caixa (+14)', () => {
    expect(C.atrasoSeteDias(BASE).text).toContain('o Caixa segue funcionando para você vender até 04/12');
  });

  test('sem Pix: sai com o link da fatura, sem bloco de Pix', () => {
    const e = C.lembreteDoisDias({ ...BASE, pix: null });
    expect(e.html).not.toContain('Pix copia e cola');
    expect(e.previa).toBe('R$ 169,00. O link da fatura está aqui');
    expect(e.html).toContain('href="https://www.asaas.com/i/abc"');
  });

  test('2.8 só promete a nova tentativa quando ela está ligada', () => {
    expect(C.cartaoRecusado({ ...BASE, comNovaTentativa: false }).text).not.toMatch(/tentar de novo amanhã/);
    expect(C.cartaoRecusado({ ...BASE, comNovaTentativa: true }).text).toMatch(/Vou tentar de novo amanhã, uma única vez/);
  });

  test('2.8b não fala da pausa se ela já passou', () => {
    expect(C.cartaoRecusadoDeNovo({ ...BASE, hoje: '2026-11-28' }).text).not.toMatch(/pausa no dia/);
  });

  test('recibo não tem botão principal, só o comprovante no rodapé', () => {
    const e = C.pagamentoConfirmado({ ...BASE, billingType: 'CREDIT_CARD', dataPagamento: '2026-11-20', linkComprovante: 'https://www.asaas.com/comprovantes/1' });
    expect(e.html).not.toContain('class="a-btn"');
    expect(e.html).toContain('>Ver o comprovante</a>');
    expect(e.previa).toBe('R$ 169,00 · Cartão de crédito · 20/11/2026');
  });
});
