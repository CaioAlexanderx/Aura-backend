// ============================================================================
// DANFE NFC-e — contrato de largura da bobina de 80mm
//
// 31/08/2026: o cupom do Davi saía cortado na direita. "R$ 289,99" imprimia
// "R$ 289,", "conforme NCM" imprimia "conforme N", e o valor de "Qtd. itens"
// não saía. Medindo o scan do cupom impresso (calibrado pelo QR, que é 28mm
// por especificação), a cabeça térmica marca até ~74,5mm da borda esquerda do
// papel — e o layout entregava uma coluna que terminava em 77mm.
//
// O teste NÃO afirma a string do CSS: afirma a GEOMETRIA. Ele extrai as
// medidas do <style> gerado e calcula onde a coluna termina no papel. Assim
// continua valendo se alguém reescrever o CSS, e quebra de verdade se alguém
// alargar a coluna de novo.
// ============================================================================

const { buildDanfeNfceHtml } = require('../../src/utils/buildDanfeNfceHtml');

// 2a rodada (31/08/2026, foto da nota 67 reimpressa): a coluna de 72mm ainda
// cortava ~1 caractere, porque o DRIVER desloca a impressao ~5,6mm pra
// direita antes do CSS entrar em cena. Cabeca imprime ate ~74,5mm; o limite
// da COLUNA declarada portanto e 74,5 - 5,6 = ~69mm. Este teste afirma a
// geometria que o CSS controla; o offset do driver entra como constante.
const OFFSET_DRIVER_MM = 5.6;
const LIMITE_IMPRIMIVEL_MM = 74.5 - OFFSET_DRIVER_MM; // ~68.9

const company = {
  cnpj: '11222333000181',
  legal_name: 'Davi Calcados Ltda',
  trade_name: 'Davi Calçados Villa Branca',
  inscricao_estadual: '392593673119',
  address_street: 'Rua das Letras',
  address_number: '1082',
  address_district: 'Loteamento Villa Branca',
  address_city: 'Jacareí',
  address_state: 'SP',
  address_zip: '12301-330',
};

const emission = {
  numero: 66,
  serie: 30,
  chave_acesso: '35260847123119000204650300000000069437584521',
  protocolo: '135265943692868',
  status: 'autorizada',
  items: [{ product_name: 'Nike Tênis Air Force Premium Branco/Cere', quantity: 1, unit_price: 289.99 }],
  total_products: 289.99,
  total_discount: 0,
  total_nfce: 289.99,
  payment_method: 'cartao',
  authorized_at: '2026-08-31T13:38:47Z',
  tp_emis: 1,
};

// ---------------------------------------------------------------------------
// Extração das medidas do <style>
// ---------------------------------------------------------------------------

function styleBlock(html) {
  const m = html.match(/<style>([\s\S]*?)<\/style>/);
  if (!m) throw new Error('sem bloco <style> no HTML gerado');
  return m[1];
}

// Corpo de um @media print{...} — precisa contar chaves porque o bloco tem
// regras aninhadas e um match preguiçoso pararia na primeira "}".
function mediaPrintBody(css) {
  const start = css.indexOf('@media print{');
  if (start === -1) return '';
  let depth = 0;
  const from = start + '@media print'.length;
  for (let i = from; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(from + 1, i);
    }
  }
  return '';
}

// Última declaração de uma propriedade dentro de um seletor (a que vence).
function decl(css, selector, prop) {
  const re = new RegExp(escapeRe(selector) + '\\{([^}]*)\\}', 'g');
  let value = null;
  let m;
  while ((m = re.exec(css)) !== null) {
    const inner = m[1];
    const p = new RegExp('(?:^|;)\\s*' + escapeRe(prop) + '\\s*:\\s*([^;]+)', 'g');
    let pm;
    while ((pm = p.exec(inner)) !== null) value = pm[1].trim();
  }
  return value;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mm(value) {
  if (value === null || value === undefined) return null;
  const m = String(value).match(/(-?[\d.]+)mm/);
  return m ? parseFloat(m[1]) : null;
}

// "0 2.5mm 8mm" → { left: 2.5, right: 2.5 }
function paddingLR(value) {
  if (!value) return { left: 0, right: 0 };
  const parts = String(value).trim().split(/\s+/);
  const num = (v) => (mm(v) === null ? 0 : mm(v));
  if (parts.length === 1) return { left: num(parts[0]), right: num(parts[0]) };
  if (parts.length === 2) return { left: num(parts[1]), right: num(parts[1]) };
  if (parts.length === 3) return { left: num(parts[1]), right: num(parts[1]) };
  return { left: num(parts[3]), right: num(parts[1]) };
}

// @page{...margin:A B} → margem esquerda em mm
function pageMarginLeftMm(css) {
  const m = css.match(/@page\{([^}]*)\}/);
  if (!m) return null;
  const decls = m[1];
  const mg = decls.match(/(?:^|;)\s*margin\s*:\s*([^;]+)/);
  if (!mg) return null;
  const parts = mg[1].trim().split(/\s+/);
  const num = (v) => (v === '0' ? 0 : mm(v));
  if (parts.length === 1) return num(parts[0]);
  if (parts.length >= 4) return num(parts[3]);
  return num(parts[1]);
}

// Onde a coluna impressa termina, contado da borda esquerda do papel.
function bordaDireitaImpressaMm(html) {
  const css = styleBlock(html);
  const print = mediaPrintBody(css);

  const marginLeft = pageMarginLeftMm(css);
  expect(marginLeft).not.toBeNull();

  // O @media print pode reescrever width/padding da .page — se reescrever, é
  // o valor dele que vale. Foi exatamente esse override (width:100%) que
  // causou o bug: a tela mostrava 68mm e o papel recebia 74mm.
  const widthTela = mm(decl(css, '.page', 'width'));
  const widthPrint = mm(decl(print, '.page', 'width'));
  const larguraPagina = widthPrint !== null ? widthPrint : widthTela;
  expect(larguraPagina).not.toBeNull();

  // .page centralizada (margin:0 auto) dentro de um @page maior joga metade
  // da sobra pra cada lado — e a metade da direita cai fora da cabeça.
  const marginPrint = decl(print, '.page', 'margin') || decl(css, '.page', 'margin') || '0';
  const centralizada = /auto/.test(marginPrint);
  const pageSize = mm((css.match(/@page\{[^}]*size\s*:\s*([\d.]+mm)/) || [])[1]) || 80;
  const sobra = Math.max(0, pageSize - marginLeft * 2 - larguraPagina);
  const deslocamento = centralizada ? sobra / 2 : 0;

  return marginLeft + deslocamento + larguraPagina;
}

// Largura útil de texto: a coluna menos o recuo interno dos dois lados.
function colunaDeTextoMm(html) {
  const css = styleBlock(html);
  const print = mediaPrintBody(css);
  const widthPrint = mm(decl(print, '.page', 'width'));
  const largura = widthPrint !== null ? widthPrint : mm(decl(css, '.page', 'width'));
  const padPrint = decl(print, '.page', 'padding');
  const pad = paddingLR(padPrint !== null ? padPrint : decl(css, '.page', 'padding'));
  return largura - pad.left - pad.right;
}

// ---------------------------------------------------------------------------

describe('DANFE NFC-e — largura na térmica 80mm', () => {
  const html = buildDanfeNfceHtml({ emission, company });

  test('a coluna impressa termina dentro da área imprimível de 72mm', () => {
    const borda = bordaDireitaImpressaMm(html);
    expect(borda).toBeLessThanOrEqual(LIMITE_IMPRIMIVEL_MM);
  });

  test('@media print não realarga a .page — tela e papel têm a mesma coluna', () => {
    const css = styleBlock(html);
    const print = mediaPrintBody(css);
    expect(print).toContain('.page');           // o bloco existe e mexe na .page
    expect(mm(decl(print, '.page', 'width'))).toBeNull();
    expect(decl(print, '.page', 'width')).not.toBe('100%');
    expect(decl(print, '.page', 'padding')).toBeNull();
  });

  test('a .page não fica centralizada no print (jogaria a direita pra fora)', () => {
    const print = mediaPrintBody(styleBlock(html));
    expect(decl(print, '.page', 'margin')).toBe('0');
  });

  test('sobra coluna de texto pra caber o cupom (>= 60mm)', () => {
    // Piso, não teto: estreitar demais quebraria as linhas de total em duas.
    expect(colunaDeTextoMm(html)).toBeGreaterThanOrEqual(60);
  });

  test('a linha mais longa do cupom cabe na coluna com folga', () => {
    // Courier: avanco fixo de 0.6em. A linha de tributos era a mais longa
    // (37 chars) e ficou a 2,2mm do corte; sem os parenteses do label
    // sobram ~5,5mm. Se alguem realargar o texto, este teste avisa antes
    // da termica do Davi avisar.
    const PT_MM = 0.352778;
    const coluna = colunaDeTextoMm(html);
    const m = html.match(/<span>(Trib\.[^<]*)<\/span><span>([^<]*)<\/span>/);
    expect(m).toBeTruthy();
    const chars = m[1].length + m[2].length;
    const larguraMm = chars * 7.5 * 0.6 * PT_MM + 1; // 7.5pt + ~1mm de gap
    expect(larguraMm).toBeLessThanOrEqual(coluna - 3); // 3mm de folga minima
  });

  test('a chave de acesso quebra em 6+5 grupos, sempre no mesmo lugar', () => {
    // 44 dígitos = 11 grupos de 4. Sem quebra declarada o browser corta no
    // meio de um grupo, em posição que muda com a fonte.
    expect(html).toContain('3526 0847 1231 1900 0204 6503<br>0000 0000 0694 3758 4521');
  });

  test('há avanço de papel no fim — a marca do rodapé não nasce no serrilhado', () => {
    const pad = decl(styleBlock(html), '.page', 'padding');
    const bottom = String(pad).trim().split(/\s+/)[2];
    expect(mm(bottom)).toBeGreaterThanOrEqual(5);
  });

  test('o valor de uma row não pode ser empurrado pra fora pelo label', () => {
    const css = styleBlock(html);
    // min-width:0 no label é o que permite ele encolher; sem isso o flex item
    // trava no próprio conteúdo e empurra o valor pra fora da coluna.
    expect(decl(css, '.row span:first-child', 'min-width')).toBe('0');
    expect(decl(css, '.row span:last-child', 'white-space')).toBe('nowrap');
  });
});
