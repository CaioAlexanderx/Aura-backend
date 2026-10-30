// ============================================================
// AURA. — Chave geral do Pix Automático (tq-104, 29/10/2026)
//
// PIX_AUTOMATIC_ENABLED=true liga o Pix Automático. Qualquer outro valor (ou
// a variável ausente, que é o padrão) deixa tudo dormente:
//
//   - rota de staff: autorizar e trocar a assinatura respondem 409
//     (pix_automatico_desligado) sem chamar a Asaas. As leituras seguem.
//   - webhook: evento de autorização e de instrução só é registrado
//     (pix_automatico_eventos + webhook_logs), sem mudar companies, sem aviso
//     e sem chamada à Asaas. A elegibilidade da conta continua sendo gravada:
//     ela é da conta da Aura (não de uma loja) e só chega por evento — se a
//     chave a descartasse, a Aura perderia o único aviso de elegibilidade.
//
// Lida a cada chamada (não no boot): ligar ou desligar na Railway vale no
// próximo deploy/restart, e os testes trocam a variável sem recarregar módulo.
// ============================================================
'use strict';

const VARIAVEL = 'PIX_AUTOMATIC_ENABLED';

function ligado() {
  return String(process.env[VARIAVEL] || '').trim().toLowerCase() === 'true';
}

function erroDesligado() {
  const e = new Error('O Pix Automático está desligado (' + VARIAVEL + '). Nada foi feito na Asaas.');
  e.status = 409;
  e.code = 'pix_automatico_desligado';
  return e;
}

module.exports = { ligado, erroDesligado, VARIAVEL };
