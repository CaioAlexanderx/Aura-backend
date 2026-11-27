// O texto do pedido de aprovação: {link} vira o link, e o texto guardado é o que vai à cliente.
const fs = require('fs');
const path = require('path');
const { aplicarLink, textoDaAprovacao } = require('../src/utils/mensagemDaAprovacao');

const URL = 'https://app.getaura.com.br/aprovacao/abc123';

describe('mensagemDaAprovacao', () => {
  test('troca o marcador {link} pelo link', () => {
    expect(aplicarLink('Oi, Ana. Veja: {link}', URL)).toBe('Oi, Ana. Veja: ' + URL);
  });

  test('troca todos os marcadores', () => {
    expect(aplicarLink('{link} e de novo {link}', URL)).toBe(`${URL} e de novo ${URL}`);
  });

  test('sem marcador o texto fica como veio (app antigo)', () => {
    expect(aplicarLink('Texto inteiro já com link https://x', URL)).toBe('Texto inteiro já com link https://x');
  });

  test('sem texto ou só espaços vale o padrão', () => {
    expect(textoDaAprovacao(undefined, URL, 'PADRAO')).toBe('PADRAO');
    expect(textoDaAprovacao('   ', URL, 'PADRAO')).toBe('PADRAO');
  });

  test('o texto da lojista vence o padrão e já sai com o link', () => {
    expect(textoDaAprovacao('Oi!\n{link}', URL, 'PADRAO')).toBe('Oi!\n' + URL);
  });

  test('a rota usa o utilitário para guardar o texto final', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'studioKdsApproval.js'), 'utf8');
    expect(fonte).toContain("require('../utils/mensagemDaAprovacao')");
    expect(fonte).toContain('textoDaAprovacao(custom_message, approvalUrl, defaultMsg)');
  });
});
