// ============================================================
// AURA. — E-mails de relacionamento: snapshot de cada modelo (24/10/2026)
//
// 4.1 boas-vindas (teste que espera a primeira venda, teste em curso, outra
// vertical), 4.2, 4.3 (no dia e na recuperação), 4.4 (com e sem cadastro),
// assinatura cancelada (com e sem o Caixa), "faz uns dias que você não
// aparece" e o 2.6 (nova data). Mais as regras que valem para todos: carta
// com a letra, WhatsApp da Aura, rodapé de descadastro do tipo, frases
// proibidas fora, {linha_do_teste} com a data certa de cada modo.
// ============================================================
'use strict';

const C = require('../src/services/emailsRelacionamento');
const { novaDataCombinada } = require('../src/services/emailsCobranca');
const { montarTrial } = require('../src/services/trialRegra');

const LETRA = 'assinatura-caio-alexander-v1.png';
const WA_AURA = 'https://wa.me/5511956305269';
const PROIBIDAS = [/nada se perde/i, /tudo volta na hora/i];
const LINKS = {
  descadastro: 'https://api.exemplo.test/api/v1/emails/descadastro/TOKEN',
  ajustar: 'https://app.getaura.com.br/configuracoes?foco=emails&empresa=emp-1',
};

function regras(c) {
  expect(c.html).toContain(LETRA);
  expect(c.html).toContain('Caio Alexander, fundador da Aura');
  expect(c.html).toContain(WA_AURA);
  expect(c.html).not.toContain('cid:');
  for (const f of PROIBIDAS) {
    expect(c.html).not.toMatch(f);
    expect(c.text).not.toMatch(f);
  }
}

function comDescadastro(c) {
  expect(c.html).toContain(LINKS.descadastro);
  expect(c.html).toContain('Parar de receber');
  expect(c.html).toContain('Ajustar meus e-mails');
  expect(c.text).toContain(`Parar de receber: ${LINKS.descadastro}`);
}

// 24/10/2026 13h BRT.
const AGORA = Date.parse('2026-10-24T16:00:00Z');

describe('{linha_do_teste} (4.1) diz a verdade do modo da conta', () => {
  test('começa na primeira venda e ainda não vendeu: 7 dias da venda, teto na data', () => {
    const trial = montarTrial({
      trial_mode: 'primeira_venda', created_at: '2026-10-24T15:00:00Z',
      trial_ends_at: '2026-11-08T15:00:00Z', trial_started_by_sale_at: null,
    }, new Date(AGORA));
    expect(C.linhaDoTeste(trial, { agora: AGORA })).toBe(
      'O seu teste grátis começa a contar na primeira venda e, a partir dela, dura 7 dias. ' +
      'Se a primeira venda demorar, ele termina no máximo em 08/11.'
    );
  });

  test('já vendeu: a data em que termina', () => {
    const trial = montarTrial({
      trial_mode: 'primeira_venda', created_at: '2026-10-20T15:00:00Z',
      trial_ends_at: '2026-10-29T18:00:00Z', trial_started_by_sale_at: '2026-10-22T18:00:00Z',
    }, new Date(AGORA));
    expect(C.linhaDoTeste(trial, { agora: AGORA })).toBe('O seu teste grátis vai até 29/10.');
  });

  test('código (7 dias fixos): a data, nunca "7 dias" para todos', () => {
    const trial = montarTrial({ trial_mode: 'fixo', created_at: '2026-10-24T15:00:00Z', trial_ends_at: '2026-10-31T15:00:00Z' }, new Date(AGORA));
    expect(C.linhaDoTeste(trial, { agora: AGORA })).toBe('O seu teste grátis vai até 31/10.');
  });

  test('a data é a de São Paulo (fim às 01h UTC ainda é o dia anterior)', () => {
    const trial = montarTrial({ trial_mode: 'fixo', trial_ends_at: '2026-11-01T01:30:00Z' }, new Date(AGORA));
    expect(C.linhaDoTeste(trial, { agora: AGORA })).toBe('O seu teste grátis vai até 31/10.');
  });

  test('sem data ou já vencido: sem frase', () => {
    expect(C.linhaDoTeste(montarTrial({ trial_mode: 'fixo', trial_ends_at: null }), { agora: AGORA })).toBeNull();
    expect(C.linhaDoTeste(montarTrial({ trial_mode: 'fixo', trial_ends_at: '2026-10-20T00:00:00Z' }, new Date(AGORA)), { agora: AGORA })).toBeNull();
  });
});

describe('4.1 boas-vindas', () => {
  test('varejo, teste esperando a primeira venda', () => {
    const c = C.boasVindas({
      nome: 'Maria', loja: 'Modas da Maria', varejo: true,
      linhaDoTeste: 'O seu teste grátis começa a contar na primeira venda e, a partir dela, dura 7 dias. Se a primeira venda demorar, ele termina no máximo em 08/11.',
      link: 'https://app.getaura.com.br/?empresa=emp-1', ...LINKS,
    });
    regras(c);
    comDescadastro(c);
    expect(c.assunto).toBe('Oi, Maria, bem-vindo à Aura');
    expect(c.text).toContain('A Aura reúne caixa, estoque, clientes e fiado num lugar só. O seu teste grátis começa a contar na primeira venda');
    expect(c.html).toContain('Abrir minha conta');
    expect(c.html).toContain('https://app.getaura.com.br/?empresa=emp-1');
    expect(c.html).toMatchSnapshot();
  });

  test('outra vertical: sem "caixa, estoque, clientes e fiado"', () => {
    const c = C.boasVindas({ nome: 'Ana', loja: 'Clínica Sorriso', varejo: false, linhaDoTeste: 'O seu teste grátis vai até 31/10.', link: 'https://app.getaura.com.br/?empresa=e', ...LINKS });
    expect(c.text).not.toContain('fiado');
    expect(c.text).toContain('O seu teste grátis vai até 31/10.');
  });

  test('sem teste valendo: o parágrafo sai só com a frase da Aura', () => {
    const c = C.boasVindas({ nome: 'Ana', loja: 'Loja', varejo: true, linhaDoTeste: null, link: 'https://app.getaura.com.br/', ...LINKS });
    expect(c.text).toContain('A Aura reúne caixa, estoque, clientes e fiado num lugar só.\n\nSe quiser ajuda');
  });
});

describe('4.2 a 4.4', () => {
  test('4.2 com produtos cadastrados', () => {
    const c = C.primeiraVendaNaoSaiu({ nome: 'Maria', loja: 'Modas da Maria', nProdutos: 12, link: 'https://app.getaura.com.br/pdv?empresa=emp-1', ...LINKS });
    regras(c);
    comDescadastro(c);
    expect(c.text).toContain('Vi que você já cadastrou 12 produtos, mas a primeira venda ainda não saiu.');
    expect(c.html).toContain('Fazer minha primeira venda');
    expect(c.html).toMatchSnapshot();
  });

  test('4.2 sem produto: "entrou e olhou o sistema"; 1 produto no singular', () => {
    expect(C.oQueJaFez(0)).toBe('você já entrou e olhou o sistema');
    expect(C.oQueJaFez(1)).toBe('você já cadastrou 1 produto');
  });

  test('4.3 dois dias antes (dia da semana) e na recuperação (amanhã)', () => {
    const c = C.testeTerminando({ nome: 'Maria', loja: 'Modas da Maria', fim: '2026-10-29', hoje: '2026-10-27', link: 'https://app.getaura.com.br/checkout?empresa=emp-1', ...LINKS });
    regras(c);
    comDescadastro(c);
    expect(c.assunto).toBe('Seu teste da Aura termina quinta-feira, dia 29/10');
    expect(c.text).toContain('Depois disso o Caixa continua funcionando normalmente');
    expect(c.html).toMatchSnapshot();
    expect(C.quandoTermina('2026-10-29', '2026-10-28')).toBe('amanhã, dia 29/10');
  });

  test('4.4 com a contagem real', () => {
    const c = C.testeEncerrado({ nome: 'Maria', loja: 'Modas da Maria', nProdutos: 320, nClientes: 41, link: 'https://app.getaura.com.br/checkout?empresa=emp-1', ...LINKS });
    regras(c);
    comDescadastro(c);
    expect(c.text).toContain('O Caixa segue liberado para você vender, e o que você cadastrou continua guardado: 320 produtos e 41 clientes.');
    expect(c.html).toMatchSnapshot();
  });

  test('4.4: o que é zero sai da frase; sem nada cadastrado, sem "continua guardado"', () => {
    expect(C.oQueFicouGuardado(5, 0)).toBe('5 produtos');
    expect(C.oQueFicouGuardado(0, 1)).toBe('1 cliente');
    const c = C.testeEncerrado({ nome: 'Ana', loja: 'Loja', nProdutos: 0, nClientes: 0, link: 'https://app.getaura.com.br/checkout', ...LINKS });
    expect(c.text).toContain('O Caixa segue liberado para você vender. As outras telas voltam');
    expect(c.text).not.toContain('continua guardado');
  });
});

describe('textos novos (a aprovar pelo Caio)', () => {
  test('assinatura cancelada: dados guardados e, no varejo fora do atraso, o Caixa', () => {
    const c = C.assinaturaCancelada({ nome: 'Maria', loja: 'Modas da Maria', caixaSegue: true });
    regras(c);
    expect(c.assunto).toBe('A assinatura da Aura foi cancelada');
    expect(c.text).toContain('Seus dados continuam guardados, e o Caixa segue funcionando para você vender.');
    expect(c.text).not.toMatch(/desconto|prazo|volta/i);
    expect(c.html).toMatchSnapshot();
    const semCaixa = C.assinaturaCancelada({ nome: 'Ana', loja: 'Clínica', caixaSegue: false });
    expect(semCaixa.text).toContain('Seus dados continuam guardados.');
    expect(semCaixa.text).not.toContain('Caixa');
  });

  test('faz uns dias que você não aparece: carta curta, pergunta aberta, sem lista de funções', () => {
    const c = C.sumiu({ nome: 'Maria', loja: 'Modas da Maria', ...LINKS });
    regras(c);
    comDescadastro(c);
    expect(c.assunto).toBe('Faz uns dias que você não aparece');
    expect(c.text).toMatch(/\?/);
    expect(c.text).not.toMatch(/estoque|crediário|relatório|etiqueta/i);
    expect(c.html).toMatchSnapshot();
  });
});

describe('2.6 nova data combinada', () => {
  test('valor exato da cobrança e o Pix novo', () => {
    const c = novaDataCombinada({
      nome: 'Maria', loja: 'Modas da Maria', valor: 119, novaData: '2026-10-27',
      pix: { copiaECola: '00020126PIXNOVO', qrUrl: 'https://api.exemplo.test/api/v1/emails/pix-qr/T.png' },
      linkFatura: 'https://www.asaas.com/i/abc',
    });
    regras(c);
    expect(c.assunto).toBe('Combinado: nova data para a mensalidade da Aura');
    expect(c.text).toContain('Movi o vencimento da mensalidade da Modas da Maria para 27/10. O valor continua R$ 119,00, sem custo a mais.');
    expect(c.text).toContain('Pix copia e cola: 00020126PIXNOVO');
    expect(c.text).toContain('uma vez a cada seis meses');
    expect(c.html).toMatchSnapshot();
  });
});
