// ============================================================
// O rodapé institucional é UM só, para as duas lojas.
//
// Existem duas: a comum (HTML gerado aqui) e a vitrine Studio (React
// Native Web, que lê o payload). Toda opção nova tem quatro lugares para
// chegar, e já perdemos esse espelho antes — ver a memória
// [[divergencia-entre-as-duas-lojas]].
//
// Se as formas de pagamento forem calculadas em dois lugares, um dia a
// loja comum vai dizer "Pix · Cartão" e a vitrine só "Pix" — e ninguém
// vai perceber, porque as duas telas nunca são olhadas juntas.
//
// Estes testes obrigam as duas a saírem da MESMA função.
// ============================================================
const buildPage = require('../src/templates/storefrontPage');
const {
  POLITICA_PADRAO, formasDePagamento, textoDaPolitica, montarRodape,
} = require('../src/services/rodapeInstitucional');

function pagina(settings, extra) {
  return buildPage({
    slug: 'loja',
    site: { name: 'Loja', primary_color: '#7C3AED' },
    settings: settings || {},
    contact: {},
    products: [],
    categories: [],
    ...extra,
  }, 'loja');
}

describe('as formas saem do que a lojista LIGOU', () => {
  test('nada ligado, nenhuma forma', () => {
    expect(formasDePagamento({})).toEqual([]);
    expect(formasDePagamento(null)).toEqual([]);
    expect(formasDePagamento(undefined)).toEqual([]);
  });

  test('só o booleano true liga — string "true" não', () => {
    // O payload atravessa JSON e já chegou string em outros campos.
    // Anunciar cartão que a loja não aceita é pior que não anunciar.
    expect(formasDePagamento({ has_pix: 'true' })).toEqual([]);
    expect(formasDePagamento({ has_pix: 1 })).toEqual([]);
    expect(formasDePagamento({ has_pix: true })).toEqual(['Pix']);
  });

  test('a ordem é estável: Pix, cartão, na entrega', () => {
    expect(formasDePagamento({
      has_pix: true, has_card: true, pay_on_delivery_enabled: true,
    })).toEqual(['Pix', 'Cartão de crédito e débito', 'Pagamento na entrega']);
  });
});

describe('a política nunca sai vazia', () => {
  test('sem texto da lojista, cai no padrão', () => {
    for (const vazio of [null, undefined, '', '   ']) {
      expect(textoDaPolitica(vazio)).toBe(POLITICA_PADRAO);
    }
  });

  test('o padrão espelha o art. 49 do CDC e não promete mais que a lei', () => {
    expect(POLITICA_PADRAO).toContain('7 dias corridos');
    expect(POLITICA_PADRAO).toContain('Código de Defesa do Consumidor');
  });

  test('texto da lojista vence, aparado', () => {
    expect(textoDaPolitica('  Troca em 30 dias.  ')).toBe('Troca em 30 dias.');
  });
});

describe('as duas lojas dizem a MESMA coisa', () => {
  const casos = [
    { nome: 'só Pix', settings: { has_pix: true } },
    { nome: 'Pix e cartão', settings: { has_pix: true, has_card: true } },
    { nome: 'tudo ligado', settings: { has_pix: true, has_card: true, pay_on_delivery_enabled: true } },
    { nome: 'nada ligado', settings: {} },
  ];

  for (const caso of casos) {
    test(`${caso.nome}: o HTML contém exatamente o que o módulo produz`, () => {
      const html = pagina(caso.settings);
      const rodape = montarRodape(caso.settings, null);

      if (rodape.formas.length) {
        // A loja comum junta com ' · '. O que importa é que as FORMAS
        // sejam as mesmas — se o módulo devolver uma a mais, esta linha
        // cai antes de a vitrine e a loja comum divergirem.
        expect(html).toContain(rodape.formas.join(' · '));
      } else {
        expect(html).not.toContain('Formas de pagamento');
      }
    });
  }

  test('a política que a página imprime é a que o módulo resolve', () => {
    const html = pagina({ has_pix: true }, { politica_troca: 'Troca em 30 dias.' });
    expect(html).toContain('Troca em 30 dias.');
    expect(html).toContain(montarRodape({ has_pix: true }, 'Troca em 30 dias.').politica);
  });

  test('sem política própria, a página imprime o padrão do módulo', () => {
    const html = pagina({ has_pix: true });
    expect(html).toContain(POLITICA_PADRAO.slice(0, 60));
  });
});

describe('o payload da loja carrega o rodapé pronto', () => {
  const fs = require('fs');
  const path = require('path');
  const builder = fs.readFileSync(
    path.join(__dirname, '..', 'src/services/storefrontBuilder.js'), 'utf8');

  test('o campo existe e vem de montarRodape, não de um cálculo local', () => {
    // A vitrine não pode remontar a lista: se remontasse, uma correção no
    // texto valeria numa loja e não na outra.
    expect(builder).toContain('rodape_institucional: montarRodape({');
    expect(builder).toContain("require('./rodapeInstitucional')");
  });

  test('usa as mesmas três chaves que o módulo entende', () => {
    const trecho = builder.slice(builder.indexOf('rodape_institucional:'));
    const bloco = trecho.slice(0, trecho.indexOf('}, config.politica_troca)'));
    for (const chave of ['has_pix', 'has_card', 'pay_on_delivery_enabled']) {
      expect(bloco).toContain(chave);
    }
  });
});

describe('quem importava POLITICA_PADRAO do template continua funcionando', () => {
  test('o template ainda reexporta', () => {
    // digitalChannel.js importa de storefrontHtml pra devolver o padrão
    // no GET da config. Mover o texto não pode quebrar esse caminho.
    const tpl = require('../src/templates/storefrontHtml');
    expect(tpl.POLITICA_PADRAO).toBe(POLITICA_PADRAO);
  });
});
