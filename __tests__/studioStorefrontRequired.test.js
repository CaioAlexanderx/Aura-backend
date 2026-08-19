// ============================================================
// AURA Studio — S0: campos de arte deixam de ser cumulativos
//
// O bug que estes testes fecham: a Sheid Mania (loja PUBLICADA) marcou
// "Obrigatorio" em Texto, Foto do cliente, Template da galeria e Cor ao
// mesmo tempo. Como `image` e `template` preenchem o mesmo slot de arte,
// exigir os dois juntos e impossivel de satisfazer — nenhum cliente
// conseguia fechar pedido.
//
// A regra nova (validateCustomizationValues em studioStorefront.js) e
// espelhada no app em useStorefront.ts/commitConfigure. Se um dos lados
// mudar sem o outro, o app aceita o item no carrinho e o backend recusa
// no fechamento; por isso os dois casos-chave aqui existem tambem la.
// ============================================================
'use strict';

const validate = require('../src/routes/studioStorefront').__validateCustomizationValues;

// Config real da Sheid: os 4 campos required ao mesmo tempo.
function sheidConfig() {
  return {
    print_area: { width_cm: 9, height_cm: 9 },
    has_back: true,
    fields: [
      { id: 'f_1', type: 'text',     label: 'Texto',                        required: true, config: {} },
      { id: 'f_2', type: 'image',    label: 'Foto do cliente',              required: true, config: {} },
      { id: 'f_3', type: 'template', label: 'Escolher template da galeria', required: true, config: {} },
      { id: 'f_4', type: 'color',    label: 'Cor',                          required: true, config: {} },
    ],
  };
}

describe('S0 — grupo de origem da arte', () => {
  test('config da Sheid: upload preenchido basta, sem exigir tambem a galeria', () => {
    expect(validate(sheidConfig(), {
      f_1: 'Feliz aniversario', f_2: 'https://cdn/arte.png', f_4: '#FFFFFF',
    })).toBeNull();
  });

  test('config da Sheid: galeria preenchida basta, sem exigir tambem o upload', () => {
    expect(validate(sheidConfig(), {
      f_1: 'Feliz aniversario', f_3: 'tpl-42', f_4: '#FFFFFF',
    })).toBeNull();
  });

  test('nenhuma das duas origens preenchida ainda e erro, citando as duas opcoes', () => {
    const err = validate(sheidConfig(), { f_1: 'Texto', f_4: '#FFFFFF' });
    expect(err).toMatch(/informe a arte/);
    expect(err).toContain('Foto do cliente');
    expect(err).toContain('Escolher template da galeria');
  });

  test('campo required fora do grupo (texto, cor) segue exigido isoladamente', () => {
    expect(validate(sheidConfig(), { f_2: 'https://cdn/arte.png', f_4: '#FFF' }))
      .toBe('campo "Texto" obrigatorio');
    expect(validate(sheidConfig(), { f_1: 'Texto', f_2: 'https://cdn/arte.png' }))
      .toBe('campo "Cor" obrigatorio');
  });

  test('string em branco nao conta como preenchida', () => {
    const err = validate(sheidConfig(), { f_1: 'Texto', f_2: '   ', f_4: '#FFF' });
    expect(err).toMatch(/informe a arte/);
  });

  // Sem relaxamento onde a lojista pediu UM campo so: com uma unica origem
  // de arte no config, o comportamento e identico ao de antes do S0.
  test('origem unica required continua obrigatoria', () => {
    const cfg = {
      fields: [{ id: 'image', type: 'image', label: 'Sua arte', required: true, config: {} }],
    };
    expect(validate(cfg, {})).toBe('informe a arte em "Sua arte"');
    expect(validate(cfg, { image: 'https://cdn/a.png' })).toBeNull();
  });

  test('origem de arte NAO required nao passa a ser exigida pelo grupo', () => {
    const cfg = {
      fields: [
        { id: 'image',    type: 'image',    label: 'Sua arte',  required: false, config: {} },
        { id: 'template', type: 'template', label: 'Galeria',   required: false, config: {} },
      ],
    };
    expect(validate(cfg, {})).toBeNull();
  });
});

describe('S0 — "crie minha arte pra mim" dispensa o envio', () => {
  function comArtService() {
    const cfg = sheidConfig();
    cfg.fields.push({
      id: 'art_service', type: 'option', label: 'Crie minha arte', required: false,
      config: {
        is_art_service: true,
        choices: [
          { value: 'none',     label: 'Vou enviar minha arte',   price_delta: 0 },
          { value: 'designer', label: 'Crie minha arte pra mim', price_delta: 40 },
        ],
      },
    });
    return cfg;
  }

  test('designer satisfaz o grupo sem upload nem galeria', () => {
    expect(validate(comArtService(), {
      f_1: 'Nome', f_4: '#FFF', art_service: 'designer',
    })).toBeNull();
  });

  test('none mantem a exigencia de enviar a arte', () => {
    expect(validate(comArtService(), {
      f_1: 'Nome', f_4: '#FFF', art_service: 'none',
    })).toMatch(/informe a arte/);
  });

  test('designer nao dispensa campos fora do grupo', () => {
    expect(validate(comArtService(), { f_4: '#FFF', art_service: 'designer' }))
      .toBe('campo "Texto" obrigatorio');
  });
});

describe('S0 — campo do verso so e exigido com o verso ativo', () => {
  // Verso COM cobranca: ativo apenas quando o cliente marca.
  const cfgCobrado = {
    has_back: true,
    back_charge_enabled: true,
    fields: [
      { id: 'frente', type: 'text', label: 'Frente', required: true, config: {}, side: 'front' },
      { id: 'verso',  type: 'text', label: 'Verso',  required: true, config: {}, side: 'back'  },
    ],
  };

  test('verso nao marcado: campo do verso nao e cobrado (era 400 do backend)', () => {
    expect(validate(cfgCobrado, { frente: 'A', has_back_selected: false })).toBeNull();
  });

  test('verso marcado: campo do verso volta a ser exigido', () => {
    expect(validate(cfgCobrado, { frente: 'A', has_back_selected: true }))
      .toBe('campo "Verso" obrigatorio');
  });

  test('verso sem cobranca esta sempre ativo', () => {
    const cfg = { ...cfgCobrado, back_charge_enabled: false };
    expect(validate(cfg, { frente: 'A' })).toBe('campo "Verso" obrigatorio');
  });

  test('grupo de arte do verso e independente do grupo da frente', () => {
    const cfg = {
      has_back: true,
      back_charge_enabled: true,
      fields: [
        { id: 'img_f', type: 'image',    label: 'Arte frente', required: true, config: {}, side: 'front' },
        { id: 'tpl_f', type: 'template', label: 'Galeria frente', required: true, config: {}, side: 'front' },
        { id: 'img_v', type: 'image',    label: 'Arte verso',  required: true, config: {}, side: 'back'  },
      ],
    };
    // Frente resolvida pela galeria; verso marcado e vazio → erro no verso.
    expect(validate(cfg, { tpl_f: 'tpl-1', has_back_selected: true }))
      .toBe('informe a arte em "Arte verso"');
    // Mesmo caso com o verso desmarcado → passa.
    expect(validate(cfg, { tpl_f: 'tpl-1', has_back_selected: false })).toBeNull();
  });
});

describe('S0 — casos que nao podem regredir', () => {
  test('produto nao personalizavel (config null) segue livre', () => {
    expect(validate(null, {})).toBeNull();
  });

  test('config sem fields segue livre', () => {
    expect(validate({ print_area: {} }, {})).toBeNull();
  });

  test('customization ausente continua sendo erro', () => {
    expect(validate({ fields: [] }, null)).toBe('customization obrigatoria');
  });
});
