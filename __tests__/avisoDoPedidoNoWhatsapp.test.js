// ============================================================
// AURA. — Aviso a cliente pelo wa.me da lojista (tq-47, 29/10/2026)
//
// Ate o numero da Aura entrar na API do WhatsApp, a lojista avisa com um
// toque: o painel abre o wa.me para a cliente com o texto pronto. Aqui o
// texto de cada passo (tom humano, voz da loja) e o link.
// ============================================================
'use strict';

const a = require('../src/services/avisoDoPedidoNoWhatsapp');

const base = {
  order_number: '0412', customer_name: 'cliente teste', customer_phone: '(11) 90000-0000',
  delivery_type: 'delivery', total: '78.00', payment_method: 'on_delivery',
  pay_on_delivery_method: 'cash', change_for: '100.00',
};

describe('o texto de cada passo', () => {
  test('aceito, com o tempo de preparo', () => {
    expect(a.mensagemDoPasso('aceito', { ...base, prep_minutes: 45 }, { loja: 'Adega Exemplo' }))
      .toBe('Oi, Cliente! Aqui é da Adega Exemplo. Recebemos o seu pedido #0412 e já estamos preparando. A previsão é de uns 45 minutos para chegar aí. Obrigado pela preferência!');
    expect(a.mensagemDoPasso('aceito', { ...base, delivery_type: 'pickup', prep_minutes: 20 }))
      .toContain('Fica pronto para retirar em uns 20 minutos.');
  });
  test('recusado, com o motivo; pago online promete devolver', () => {
    const recusado = { ...base, status: 'cancelled', cancel_kind: 'recusado_pela_loja', cancel_reason: 'acabou o gelo' };
    expect(a.mensagemDoPasso('recusado', recusado, { loja: 'Adega Exemplo' }))
      .toBe('Oi, Cliente! Aqui é da Adega Exemplo. Infelizmente não vamos conseguir atender o seu pedido #0412 agora (acabou o gelo). Desculpe pelo transtorno, esperamos te atender numa próxima.');
    const pago = { ...recusado, payment_method: 'pix', payment_status: 'confirmed' };
    expect(a.avisoDoPedido(pago).texto).toContain('Vamos devolver o valor que você pagou.');
  });
  test('saiu para entrega, com a forma de pagar e o troco', () => {
    expect(a.mensagemDoPasso('saiu', base, { loja: 'Adega Exemplo' }))
      .toBe('Oi, Cliente! O seu pedido #0412 da Adega Exemplo saiu para entrega e já está a caminho. O pagamento é em dinheiro: R$ 78,00. O entregador leva troco para R$ 100,00.');
    expect(a.mensagemDoPasso('saiu', { ...base, pay_on_delivery_method: 'card' })).toContain('O entregador leva a maquininha. O total é R$ 78,00.');
    expect(a.mensagemDoPasso('saiu', { ...base, pay_on_delivery_method: 'pix' })).toContain('Você paga com Pix quando ele chegar.');
    expect(a.mensagemDoPasso('saiu', { ...base, payment_method: 'pix' })).toBe('Oi, Cliente! O seu pedido #0412 saiu para entrega e já está a caminho.');
  });
  test('entregue', () => {
    expect(a.mensagemDoPasso('entregue', base, { loja: 'Adega Exemplo' }))
      .toBe('Oi, Cliente! Obrigado pela compra na Adega Exemplo. Qualquer coisa sobre o pedido #0412, é só chamar aqui.');
  });
  test('sem nome: "Oi!"', () => {
    expect(a.mensagemDoPasso('entregue', { ...base, customer_name: '' })).toMatch(/^Oi! Obrigado/);
  });
});

describe('qual passo e o link', () => {
  test('o passo sai do status', () => {
    expect(a.passoDoPedido({ status: 'preparing', accepted_at: 'x' })).toBe('aceito');
    expect(a.passoDoPedido({ status: 'preparing' })).toBeNull();
    expect(a.passoDoPedido({ status: 'out_for_delivery' })).toBe('saiu');
    expect(a.passoDoPedido({ status: 'delivered' })).toBe('entregue');
    expect(a.passoDoPedido({ status: 'cancelled', cancel_kind: 'recusado_pela_loja' })).toBe('recusado');
    expect(a.passoDoPedido({ status: 'cancelled', cancel_kind: 'pix_expirado' })).toBeNull();
    expect(a.passoDoPedido({ status: 'aguardando_aceite' })).toBeNull();
  });
  test('link para o numero da cliente, com o 55 e o texto', () => {
    const av = a.avisoDoPedido({ ...base, status: 'out_for_delivery' }, { loja: 'Adega Exemplo' });
    expect(av.passo).toBe('saiu');
    expect(av.link.startsWith('https://wa.me/5511900000000?text=')).toBe(true);
    expect(decodeURIComponent(av.link.split('?text=')[1])).toBe(av.texto);
  });
  test('sem telefone: texto sem link', () => {
    const av = a.avisoDoPedido({ ...base, status: 'delivered', customer_phone: '' });
    expect(av.link).toBeNull();
    expect(av.texto).toBeTruthy();
  });
  test('devolver por fora so no pago online e cancelado', () => {
    expect(a.precisaDevolver({ status: 'cancelled', payment_method: 'pix', payment_status: 'confirmed' })).toBe(true);
    expect(a.precisaDevolver({ status: 'cancelled', payment_method: 'card', payment_status: 'paid' })).toBe(true);
    expect(a.precisaDevolver({ status: 'cancelled', payment_method: 'pix', payment_status: 'pending' })).toBe(false);
    expect(a.precisaDevolver({ status: 'cancelled', payment_method: 'on_delivery', payment_status: 'confirmed' })).toBe(false);
    expect(a.precisaDevolver({ status: 'preparing', payment_method: 'pix', payment_status: 'confirmed' })).toBe(false);
  });
});
