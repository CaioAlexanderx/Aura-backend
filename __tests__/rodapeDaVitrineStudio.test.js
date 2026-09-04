// ============================================================
// O rodape da vitrine Studio (04/09/2026)
//
// A loja comum ganhou em 09/2026 um rodape de tres colunas: quem e a
// loja (logo, endereco, horario, redes), como ela atende (formas de
// pagamento e politica de troca) e por onde navegar. A vitrine Studio
// terminava a pagina no ultimo produto.
//
// O que este teste guarda nao e o desenho — e a REGRA de onde o texto
// nasce. As formas de pagamento e a politica de troca sao decididas em
// services/rodapeInstitucional.js, um modulo so para as duas lojas. Se
// alguem remontar a lista dentro da rota do Studio, uma correcao no
// texto passa a valer numa vitrine e nao na outra: foi exatamente esse
// o bug que criou o modulo.
// ============================================================
const fs = require('fs');
const path = require('path');

const ROTA = path.join(__dirname, '..', 'src', 'routes', 'studioStorefront.js');
const fonte = fs.readFileSync(ROTA, 'utf8');

const { montarRodape, POLITICA_PADRAO } = require('../src/services/rodapeInstitucional');

describe('o texto do rodape vem do modulo compartilhado', () => {
  test('a rota chama montarRodape em vez de montar a lista', () => {
    expect(fonte).toContain("require('../services/rodapeInstitucional')");
    expect(fonte).toContain('const rodape_institucional = montarRodape(');
  });

  test('a rota nao escreve nome de forma de pagamento na mao', () => {
    // 'Pix' aparece legitimamente em payment_method e em pixService; o
    // que nao pode voltar e a lista de rotulos do rodape.
    expect(fonte).not.toContain("'Cartão de crédito e débito'");
    expect(fonte).not.toContain("'Trocas e devoluções'");
  });

  test('o texto padrao de troca continua saindo de um lugar so', () => {
    expect(montarRodape({}, null).politica).toBe(POLITICA_PADRAO);
    expect(fonte).not.toContain('Código de Defesa do Consumidor');
  });
});

describe('os dois retornos da rota mandam o rodape', () => {
  test('o de loja sem produto e o normal', () => {
    // Campo que existe num caminho e nao no outro e a loja mudando de
    // cara conforme o estoque — o mesmo motivo que criou montarSite().
    const ocorrencias = fonte.match(/^\s+rodape_institucional,$/gm) || [];
    expect(ocorrencias.length).toBe(2);
  });

  test('as formas de pagamento sao calculadas antes do retorno vazio', () => {
    // Se o gateway fosse consultado so no caminho com produto, a loja
    // recem-aberta anunciaria formas diferentes da mesma loja com
    // produto cadastrado.
    const gateway = fonte.indexOf("gateway = 'mercadopago'");
    const retornoVazio = fonte.indexOf('if (!products.length)');
    expect(gateway).toBeGreaterThan(0);
    expect(gateway).toBeLessThan(retornoVazio);
  });
});

describe('a coluna de identidade tem o que a loja comum tem', () => {
  test('endereco, horario e CNPJ entram no bloco site', () => {
    expect(fonte).toContain('endereco: config.address');
    expect(fonte).toContain('horario_resumo: resumoDeHorario(');
    expect(fonte).toContain('cnpj_formatado: formatarCnpj(');
  });

  test('o horario e o CNPJ usam as funcoes da loja comum', () => {
    // Reimplementar "Seg a sab, 9h as 18h" daria duas frases diferentes
    // para o mesmo horario.
    expect(fonte).toContain("resumoDeHorario, formatarCnpj,");
    expect(fonte).toContain("require('../services/storefrontBuilder')");
  });

  test('o CNPJ vem de companies, que a consulta agora traz', () => {
    expect(fonte).toContain('c.cnpj AS company_cnpj');
  });
});

describe('montarRodape, na pratica', () => {
  test('loja da Sheid: Pix ligado, cartao nao configurado', () => {
    const r = montarRodape(
      { has_pix: true, has_card: false, pay_on_delivery_enabled: false },
      null
    );
    expect(r.formas).toEqual(['Pix']);
    expect(r.politica).toBe(POLITICA_PADRAO);
  });

  test('loja sem pagamento configurado nao anuncia forma nenhuma', () => {
    expect(montarRodape({}, null).formas).toEqual([]);
  });

  test('a politica da lojista vence o texto padrao', () => {
    const r = montarRodape({ has_pix: true }, '  Troca em 30 dias, sem perguntas.  ');
    expect(r.politica).toBe('Troca em 30 dias, sem perguntas.');
  });
});
