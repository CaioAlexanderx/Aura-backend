// ============================================================================
// Ordem de Servico — documento A4
//
// O pedido (31/08/2026) foi explicito sobre a marca: "logo e marca do cliente
// no topo, Aura apenas discreta no rodape". Metade destes testes existe pra
// segurar isso, porque e o tipo de coisa que um refactor de template desfaz
// sem ninguem perceber ate um lojista reclamar.
//
// A outra metade e a licao da DANFE termica: largura declarada, e igual na
// tela e no print.
// ============================================================================

const {
  buildServiceOrderHtml, formatBRL, formatCnpj, formatDateBR,
  getInitials, garantiaAte, STATUS_LABEL,
} = require('../../src/utils/buildServiceOrderHtml');

const company = {
  trade_name: 'Davi Assistência Técnica',
  legal_name: 'Davi Calcados Ltda',
  cnpj: '47123119000204',
  inscricao_estadual: '392593673119',
  phone: '(12) 3456-7890',
  address_street: 'Rua das Letras',
  address_number: '1082',
  address_district: 'Loteamento Villa Branca',
  address_city: 'Jacareí',
  address_state: 'SP',
  logo_url: 'https://r2.exemplo/logo-davi.png',
};

function os(over = {}) {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    os_number: 42,
    status: 'pronta',
    customer_name: 'Marina Alves',
    customer_phone: '(12) 98888-1234',
    created_at: '2026-08-25T09:15:00Z',
    reported_issue: 'Não liga depois de uma queda de energia.',
    warranty_days: 90,
    estimated_amount: 480,
    ...over,
  };
}

const items = [
  { kind: 'servico', description: 'Reparo de trilha oxidada', quantity: 1, unit_price: 280, total_price: 280 },
  { kind: 'peca', description: 'Fonte Dell 65W', quantity: 1, unit_price: 200, total_price: 200 },
];

// Extrai o <style> pra poder afirmar geometria em vez de string solta.
function css(html) {
  const m = html.match(/<style>([\s\S]*?)<\/style>/);
  return m ? m[1] : '';
}

function mediaPrint(cssText) {
  const start = cssText.indexOf('@media print{');
  if (start === -1) return '';
  let depth = 0;
  const from = start + '@media print'.length;
  for (let i = from; i < cssText.length; i++) {
    if (cssText[i] === '{') depth++;
    else if (cssText[i] === '}') {
      depth--;
      if (depth === 0) return cssText.slice(from + 1, i);
    }
  }
  return '';
}

function decl(cssText, selector, prop) {
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}', 'g');
  let value = null;
  let m;
  while ((m = re.exec(cssText)) !== null) {
    const p = new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)', 'g');
    let pm;
    while ((pm = p.exec(m[1])) !== null) value = pm[1].trim();
  }
  return value;
}

describe('Ordem de Serviço — marca do cliente, Aura no rodapé', () => {
  test('a logo do cliente vai no topo', () => {
    const html = buildServiceOrderHtml({ os: os(), items, company });
    expect(html).toContain('https://r2.exemplo/logo-davi.png');
    expect(html).toContain('Davi Assistência Técnica');
  });

  test('a marca da vitrine tem precedência sobre o logo da empresa', () => {
    // digital_channel_config é a fonte mais rica (mesma da loja pública).
    const html = buildServiceOrderHtml({
      os: os(), items, company,
      brand: { logo_url: 'https://r2.exemplo/logo-vitrine.png', primary_color: '#7c3aed' },
    });
    expect(html).toContain('logo-vitrine.png');
    expect(html).not.toContain('logo-davi.png');
    expect(html).toContain('#7c3aed');
  });

  test('sem logo nenhum, cai nas iniciais do nome da empresa', () => {
    const semLogo = { ...company, logo_url: null };
    const html = buildServiceOrderHtml({ os: os(), items, company: semLogo });
    expect(html).toContain('logo-fb');
    expect(html).toContain('>DA<'); // "Davi Assistência" -> DA
  });

  test('Aura aparece SÓ no rodapé — nunca no topo', () => {
    const html = buildServiceOrderHtml({ os: os(), items, company });
    const rodape = html.indexOf('class="rodape"');
    const primeiraAura = html.indexOf('Aura', html.indexOf('<body>'));
    expect(rodape).toBeGreaterThan(-1);
    // A única menção a Aura no corpo do documento vem depois do rodapé abrir.
    expect(primeiraAura).toBeGreaterThan(rodape);
    expect(html).toContain('gerado por Aura · getaura.com.br');
  });

  test('a cor da marca do lojista é aplicada, e uma cor inválida não vaza pro CSS', () => {
    const html = buildServiceOrderHtml({
      os: os(), items, company,
      brand: { primary_color: 'red;}body{display:none' }, // tentativa de injeção
    });
    expect(html).not.toContain('body{display:none');
    expect(css(html)).toContain('#1f2937'); // cai no neutro
  });
});

describe('Ordem de Serviço — geometria A4 (lição da DANFE)', () => {
  const html = buildServiceOrderHtml({ os: os(), items, company });

  test('a página é A4 com margem declarada', () => {
    expect(css(html)).toContain('@page{size:A4;margin:14mm}');
  });

  test('a coluna cabe na folha: 182mm + 2×14mm = 210mm', () => {
    const largura = parseFloat(decl(css(html), '.page', 'width'));
    expect(largura).toBe(182);
    expect(largura + 14 * 2).toBe(210);
  });

  test('@media print NÃO redefine a largura — tela e papel são a mesma coluna', () => {
    // Era exatamente essa divergência que escondeu o corte da DANFE térmica:
    // a pré-visualização mostrava um documento que cabia e saía outro.
    const print = mediaPrint(css(html));
    expect(print).toContain('.page');
    expect(decl(print, '.page', 'width')).toBeNull();
  });

  test('as cores da marca sobrevivem à impressora', () => {
    expect(mediaPrint(css(html))).toContain('print-color-adjust:exact');
  });

  test('blocos e assinaturas não podem ser partidos entre páginas', () => {
    expect(decl(css(html), '.bl', 'break-inside')).toBe('avoid');
    expect(decl(css(html), '.assins', 'break-inside')).toBe('avoid');
  });
});

describe('Ordem de Serviço — conteúdo', () => {
  test('imprime número, status e o defeito nas palavras do cliente', () => {
    const html = buildServiceOrderHtml({ os: os(), items, company });
    expect(html).toContain('nº 42');
    expect(html).toContain('Pronta para retirada');
    expect(html).toContain('Não liga depois de uma queda de energia.');
  });

  test('defeito relatado e diagnóstico aparecem como blocos separados', () => {
    // São coisas diferentes: o que o cliente reclamou e o que o técnico achou.
    // A divergência entre os dois é o que resolve discussão no balcão.
    const html = buildServiceOrderHtml({
      os: os({ diagnosis: 'Fonte queimada e trilha oxidada.' }), items, company,
    });
    expect(html).toContain('Defeito relatado pelo cliente');
    expect(html).toContain('Diagnóstico técnico');
    expect(html.indexOf('Defeito relatado')).toBeLessThan(html.indexOf('Diagnóstico técnico'));
  });

  test('soma o orçamento e imprime em real', () => {
    const html = buildServiceOrderHtml({ os: os(), items, company });
    expect(html).toContain('R$ 480,00');
  });

  test('sem itens, diz que não há orçamento em vez de mostrar tabela vazia', () => {
    const html = buildServiceOrderHtml({ os: os({ estimated_amount: 0 }), items: [], company });
    expect(html).toContain('Nenhum item orçado');
    expect(html).not.toContain('<table');
  });

  test('as duas assinaturas saem sempre — a de entrada e a de retirada', () => {
    const html = buildServiceOrderHtml({ os: os(), items, company });
    expect(html).toContain('Entrega do equipamento');
    expect(html).toContain('Retirada do equipamento');
    // Sem URL de assinatura, sai a linha pra assinar no balcão.
    expect(html).toContain('assin-linha');
  });

  test('assinatura já coletada vira imagem, não linha em branco', () => {
    const html = buildServiceOrderHtml({
      os: os({ intake_signature_url: 'https://r2.exemplo/assin.png', intake_signed_at: '2026-08-25T12:00:00Z' }),
      items, company,
    });
    expect(html).toContain('assin-img');
    expect(html).toContain('https://r2.exemplo/assin.png');
    expect(html).toContain('Assinado em');
  });

  test('escapa HTML do que o cliente digitou', () => {
    const html = buildServiceOrderHtml({
      os: os({ customer_name: '<script>alert(1)</script>', reported_issue: 'a & b < c' }),
      items, company,
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &amp; b &lt; c');
  });

  test('não dispara impressão sozinho por padrão', () => {
    // O balconista confere o estado do aparelho com o cliente na frente antes
    // de imprimir; abrir o diálogo sozinho atrapalha.
    const html = buildServiceOrderHtml({ os: os(), items, company });
    expect(html).not.toContain('window.print()\n');
    expect(html).toContain('onclick="window.print()"'); // botão manual continua
  });

  test('autoprint:true injeta o script de impressão', () => {
    const html = buildServiceOrderHtml({ os: os(), items, company, autoprint: true });
    expect(html).toContain('<script');
  });
});

describe('Ordem de Serviço — garantia e datas', () => {
  test('garantia sai como DATA, não como "90 dias" solto', () => {
    // O cliente guarda o papel por meses. "90 dias" obriga ele a lembrar de
    // quando contou, e vira a palavra de um contra a do outro.
    const html = buildServiceOrderHtml({ os: os(), items, company });
    expect(html).toContain('Válida até');
    expect(html).toContain('23/11/2026'); // 25/08 + 90
  });

  test('garantia conta a partir da ENTREGA quando ela existe', () => {
    const d = garantiaAte({ warranty_days: 30, created_at: '2026-08-01T12:00:00Z', delivered_at: '2026-09-01T12:00:00Z' });
    expect(formatDateBR(d, false)).toBe('01/10/2026');
  });

  test('sem garantia, o bloco não aparece', () => {
    const html = buildServiceOrderHtml({ os: os({ warranty_days: 0 }), items, company });
    expect(html).not.toContain('Válida até');
  });

  test('a data não muda com o fuso do processo', () => {
    // Railway roda em UTC, a máquina do dev em UTC-3. Sem fuso explícito o
    // documento diria que o aparelho entrou 3h depois do que entrou.
    expect(formatDateBR('2026-08-25T09:15:00Z')).toBe('25/08/2026 06:15');
    expect(formatDateBR('2026-01-01T01:30:00Z')).toBe('31/12/2025 22:30');
  });
});

describe('Ordem de Serviço — helpers', () => {
  test('formatBRL usa separador de milhar brasileiro', () => {
    expect(formatBRL(1234.5)).toBe('1.234,50');
    expect(formatBRL(0)).toBe('0,00');
    expect(formatBRL(1234567.89)).toBe('1.234.567,89');
  });

  test('formatCnpj devolve o valor cru quando não tem 14 dígitos', () => {
    expect(formatCnpj('47123119000204')).toBe('47.123.119/0002-04');
    expect(formatCnpj('123')).toBe('123');
  });

  test('getInitials pega duas letras', () => {
    expect(getInitials('Davi Calçados Matriz')).toBe('DC');
    expect(getInitials('Davi')).toBe('DA');
    expect(getInitials('')).toBe('?');
  });

  test('todo status da máquina tem rótulo em português', () => {
    for (const s of ['aberta', 'em_execucao', 'pronta', 'entregue', 'cancelada']) {
      expect(STATUS_LABEL[s]).toBeTruthy();
    }
  });

  test('exige os e company', () => {
    expect(() => buildServiceOrderHtml({ company })).toThrow(/os obrigat/);
    expect(() => buildServiceOrderHtml({ os: os() })).toThrow(/company obrigat/);
  });
});
