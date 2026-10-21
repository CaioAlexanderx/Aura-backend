// ============================================================
// WhatsApp da loja na vitrine (21/10/2026, loja Felic)
//
//   1. Titulo e texto do bloco do WhatsApp por loja (migration 401). Sem
//      nada escrito, o bloco de hoje, byte a byte.
//   2. "fale com a loja pelo WhatsApp" na politica da lojista vira link
//      para o WhatsApp da loja — e so a palavra; o resto e escapado.
//   3. tq-61: o wa.me saia sem o 55 (wa.me/12981365134) porque o painel
//      grava "(12) 98136-5134". Uma regra so, no servidor e no navegador.
// ============================================================
'use strict';

jest.mock('../src/services/cacheDaPaginaDaLoja', () => ({
  esquecerPagina: jest.fn(), paginaLembrada: jest.fn(() => null), lembrarPagina: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const {
  FONTE, numeroDoWhatsapp, linkDoWhatsapp, BLOCO_PADRAO, LIMITES_DO_BLOCO,
  sanearTextoDoBloco, politicaComLinkDoWhatsapp,
} = require('../src/services/whatsappDaLoja');
const { POLITICA_PADRAO } = require('../src/services/rodapeInstitucional');
const buildPage = require('../src/templates/storefrontPage');
const buildScript = require('../src/templates/storefrontScript');

const FELIC = 'Você pode desistir da compra em até 7 dias após receber o pedido, conforme o '
  + 'Código de Defesa do Consumidor. Para trocas, fale com a loja pelo WhatsApp.';

function pagina(extra) {
  return buildPage({
    slug: 'loja',
    site: { name: 'Loja', primary_color: '#7C3AED' },
    settings: {},
    contact: { whatsapp: '(12) 98136-5134' },
    products: [],
    categories: [],
    ...extra,
  }, 'loja');
}

const recorte = (html, de, ate) => {
  const i = html.indexOf(de);
  if (i < 0) return '';
  return html.slice(i, html.indexOf(ate, i) + ate.length);
};
const blocoDoWhats = (html) => recorte(html, '<section class="whats-block">', '</section>');
const blocoDaPolitica = (html) => {
  const i = html.indexOf('Trocas e devoluções');
  if (i < 0) return '';
  const j = html.indexOf('<div class="footer-inst-txt">', i);
  return html.slice(j, html.indexOf('</div>', j) + 6);
};

// ── 3. O numero do wa.me ─────────────────────────────────────────
describe('numeroDoWhatsapp (tq-61)', () => {
  test.each([
    ['10 digitos (fixo com DDD)', '1239213456', '551239213456'],
    ['11 digitos (celular com DDD)', '12981365134', '5512981365134'],
    ['12 digitos ja com 55', '551239213456', '551239213456'],
    ['13 digitos ja com 55', '5512981365134', '5512981365134'],
    ['a mascara do painel', '(12) 98136-5134', '5512981365134'],
    ['+55 digitado', '+55 (12) 98136-5134', '5512981365134'],
    ['DDD 55 (RS) com 11 digitos ganha o 55', '55991234567', '5555991234567'],
    ['12 digitos sem 55 ficam so com os digitos', '011981365134', '011981365134'],
  ])('%s', (_, entrada, esperado) => {
    expect(numeroDoWhatsapp(entrada)).toBe(esperado);
  });

  test.each([[''], [null], [undefined], ['   '], ['(  ) -']])('vazio (%p) devolve string vazia', (v) => {
    expect(numeroDoWhatsapp(v)).toBe('');
    expect(linkDoWhatsapp(v)).toBe('');
  });

  test('linkDoWhatsapp monta o wa.me com o 55', () => {
    expect(linkDoWhatsapp('(12) 98136-5134')).toBe('https://wa.me/5512981365134');
  });

  test('o navegador roda o MESMO codigo do servidor', () => {
    // eslint-disable-next-line no-new-func
    const doNavegador = new Function(FONTE + '\nreturn numeroDoWhatsapp;')();
    for (const v of ['1239213456', '(12) 98136-5134', '5512981365134', '551239213456', '', null]) {
      expect(doNavegador(v)).toBe(numeroDoWhatsapp(v));
    }
  });
});

describe('todo wa.me da vitrine passa pela regra unica', () => {
  const script = buildScript(JSON.stringify({ slug: 'loja', site: {}, contact: {}, settings: {}, products: [] }), 'loja', '');

  test('o <script> da loja traz a regra e a usa no pedido confirmado e na pagina do produto', () => {
    expect(script).toContain(FONTE);
    expect(script).toContain("var wnum=numeroDoWhatsapp(CONTACT.whatsapp);");
    expect(script).toContain("var whatsNum=numeroDoWhatsapp(CONTACT.whatsapp);");
  });

  test('nenhum wa.me nos templates monta o numero so tirando os nao digitos', () => {
    const raiz = path.join(__dirname, '..', 'src', 'templates');
    const arquivos = [];
    (function andar(d) {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) andar(p); else if (f.endsWith('.js')) arquivos.push(p);
      }
    })(raiz);
    const achados = [];
    for (const p of arquivos) {
      const linhas = fs.readFileSync(p, 'utf8').split('\n');
      linhas.forEach((l, i) => {
        if (/wa\.me|api\.whatsapp/.test(l) && !/^\s*\/\//.test(l)) achados.push(`${path.basename(p)}:${i + 1}`);
        if (/whatsapp[^\n]*\.replace\(\/\\+D\/g/i.test(l)) achados.push(`SEM REGRA ${path.basename(p)}:${i + 1}`);
      });
    }
    expect(achados.filter((a) => a.startsWith('SEM REGRA'))).toEqual([]);
    // Os tres lugares que montam wa.me na loja comum (bloco da home,
    // pedido confirmado, pagina do produto) — se aparecer um quarto, ele
    // tem de usar numeroDoWhatsapp e entrar aqui.
    expect(achados.map((a) => a.split(':')[0]).sort()).toEqual(['pix.js', 'product_detail.js', 'storefrontHtml.js', 'storefrontHtml.js']);
  });

  test('a pagina da loja sai com wa.me/55', () => {
    const html = pagina();
    expect(html).toContain('href="https://wa.me/5512981365134"');
    expect(html).not.toContain('wa.me/12981365134');
  });

  test('o e-mail do pedido para a lojista usa a regra (sem 5555)', async () => {
    jest.resetModules();
    jest.dontMock('../src/services/mailer');
    const chave = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = 're_teste';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'm1' }) });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { sendOwnerNewOrderEmail } = require('../src/services/mailer');
      const enviar = async (customer_phone) => {
        global.fetch.mockClear();
        await sendOwnerNewOrderEmail('loja@exemplo.com', {
          order_number: '7', customer_name: 'Ana', customer_phone, total: 10,
          delivery_type: 'pickup', store_name: 'Loja', payment_method: 'pix',
        });
        return JSON.parse(global.fetch.mock.calls[0][1].body).html;
      };
      expect(await enviar('(12) 98136-5134')).toContain('https://wa.me/5512981365134"');
      const comMais55 = await enviar('+55 12 98136-5134');
      expect(comMais55).toContain('https://wa.me/5512981365134"');
      expect(comMais55).not.toContain('wa.me/5555');
    } finally {
      if (chave == null) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = chave;
      jest.restoreAllMocks();
    }
  });
});

// ── 1. O bloco do WhatsApp ───────────────────────────────────────
describe('bloco do WhatsApp configuravel', () => {
  // O bloco de hoje, copiado do template de antes desta mudanca. So o
  // numero ganhou o 55 (item 3).
  const GLYPH = require('../src/templates/storefrontHtml').WHATSAPP_GLYPH;
  const BLOCO_DE_HOJE = `<section class="whats-block">
  <div class="whats-block-inner">
    <div>
      <div class="whats-block-tit serif">Dúvida sobre tamanho ou modelo?</div>
      <div class="whats-block-txt">Fale direto com a gente no WhatsApp.</div>
    </div>
    <a class="whatsapp-cta" href="https://wa.me/5512981365134" target="_blank" rel="noopener">${GLYPH}Chamar no WhatsApp</a>
  </div>
</section>`;

  test.each([
    ['sem a chave', {}],
    ['whats_bloco nulo', { whats_bloco: null }],
    ['as duas colunas nulas', { whats_bloco: { titulo: null, texto: null } }],
    ['as duas vazias', { whats_bloco: { titulo: '', texto: '' } }],
  ])('loja que nao escreveu nada (%s): o bloco de hoje, byte a byte', (_, extra) => {
    const html = pagina(extra);
    expect(blocoDoWhats(html)).toBe(BLOCO_DE_HOJE);
    // E a pagina inteira e a mesma de quem nunca teve a chave.
    expect(html).toBe(pagina({}));
  });

  test('o padrao exportado e o texto do bloco de hoje', () => {
    expect(BLOCO_PADRAO).toEqual({
      titulo: 'Dúvida sobre tamanho ou modelo?',
      texto: 'Fale direto com a gente no WhatsApp.',
    });
  });

  test('com titulo e texto, o cartao inteiro vira o link do WhatsApp', () => {
    const bloco = blocoDoWhats(pagina({ whats_bloco: { titulo: 'Dúvida sobre algum rótulo?', texto: 'Chame a gente no WhatsApp.' } }));
    expect(bloco).toContain('<a class="whats-block-inner" href="https://wa.me/5512981365134" target="_blank" rel="noopener"');
    expect(bloco).toContain('<div class="whats-block-tit serif">Dúvida sobre algum rótulo?</div>');
    expect(bloco).toContain('<div class="whats-block-txt">Chame a gente no WhatsApp.</div>');
    expect(bloco).not.toContain('tamanho ou modelo');
    // Sem <a> dentro de <a>: o botao vira <span> dentro do link.
    expect(bloco.match(/<a /g)).toHaveLength(1);
    expect(bloco).toContain('<span class="whatsapp-cta">');
  });

  test('so o titulo escrito: o texto continua o padrao', () => {
    const bloco = blocoDoWhats(pagina({ whats_bloco: { titulo: 'Quer uma indicação?', texto: null } }));
    expect(bloco).toContain('>Quer uma indicação?<');
    expect(bloco).toContain('>Fale direto com a gente no WhatsApp.<');
  });

  test('o texto da lojista sai escapado', () => {
    const bloco = blocoDoWhats(pagina({ whats_bloco: { titulo: '<img src=x onerror=alert(1)>', texto: '"a" & b' } }));
    expect(bloco).not.toContain('<img');
    expect(bloco).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(bloco).toContain('&quot;a&quot; &amp; b');
  });

  test('loja sem WhatsApp nao desenha o bloco, mesmo com texto escrito', () => {
    const html = pagina({ contact: {}, whats_bloco: { titulo: 'Oi', texto: 'Oi' } });
    expect(blocoDoWhats(html)).toBe('');
    expect(html).toBe(pagina({ contact: {} }));
  });
});

describe('sanearTextoDoBloco', () => {
  test('tira espaco das pontas e colapsa quebras de linha', () => {
    expect(sanearTextoDoBloco('  Dúvida   sobre\n\nvinho?  ', 80)).toBe('Dúvida sobre vinho?');
  });
  test('sem HTML', () => {
    expect(sanearTextoDoBloco('<b>Oi</b> <script>alert(1)</script>tudo bem?', 80)).toBe('Oi alert(1) tudo bem?');
    expect(sanearTextoDoBloco('a < b > c', 80)).toBe('a c');
    expect(sanearTextoDoBloco('5 > 3', 80)).toBe('5 3');
  });
  test('corta no limite', () => {
    expect(sanearTextoDoBloco('x'.repeat(500), LIMITES_DO_BLOCO.titulo)).toHaveLength(80);
    expect(sanearTextoDoBloco('x'.repeat(500), LIMITES_DO_BLOCO.texto)).toHaveLength(200);
  });
  test.each([[null], [undefined], [''], ['   '], ['<br>']])('vazio (%p) vira null = texto padrao', (v) => {
    expect(sanearTextoDoBloco(v, 80)).toBeNull();
  });
});

describe('PUT /digital-channel com o bloco do WhatsApp', () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { role: 'client' }; next(); });
  app.use('/companies/:id/digital-channel', require('../src/routes/digitalChannel'));

  let linha;
  let semColuna;
  beforeEach(() => {
    semColuna = false;
    linha = { company_id: 'cid-1', slug: 'felic-adega', pedidos_ate: null };
    db.query.mockReset();
    db.query.mockImplementation(async (sql, params = []) => {
      const s = String(sql);
      if (s.includes('information_schema')) return { rows: [] };
      if (s.includes('INSERT INTO digital_channel_config')) return { rows: [{ ...linha }] };
      const m = /UPDATE digital_channel_config SET (\w+) = \$1/.exec(s);
      if (m) {
        if (semColuna && m[1].startsWith('whats_bloco')) {
          throw Object.assign(new Error(`column "${m[1]}" does not exist`), { code: '42703' });
        }
        linha[m[1]] = params[0];
        return { rows: [{ ...linha }] };
      }
      return { rows: [] };
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  const updates = () => db.query.mock.calls
    .map(([s, p]) => [/UPDATE digital_channel_config SET (\w+) = \$1/.exec(String(s)), p])
    .filter(([m]) => m).map(([m, p]) => [m[1], p[0]]);

  test('grava os dois campos ja limpos', async () => {
    const r = await request(app).put('/companies/cid-1/digital-channel').send({
      whats_bloco_titulo: '  <b>Dúvida sobre algum rótulo?</b> ',
      whats_bloco_texto: 'Chame a gente\nno WhatsApp. ' + 'x'.repeat(400),
    });
    expect(r.status).toBe(200);
    const u = Object.fromEntries(updates());
    expect(u.whats_bloco_titulo).toBe('Dúvida sobre algum rótulo?');
    expect(u.whats_bloco_texto.startsWith('Chame a gente no WhatsApp. x')).toBe(true);
    expect(u.whats_bloco_texto).toHaveLength(200);
  });

  test('string vazia limpa (volta ao texto padrao)', async () => {
    await request(app).put('/companies/cid-1/digital-channel').send({ whats_bloco_titulo: '' });
    expect(updates()).toEqual(expect.arrayContaining([['whats_bloco_titulo', null]]));
  });

  test('campo ausente nao vira UPDATE', async () => {
    await request(app).put('/companies/cid-1/digital-channel').send({ site_name: 'Felic' });
    expect(updates().map(([c]) => c)).not.toEqual(expect.arrayContaining(['whats_bloco_titulo']));
    expect(updates().map(([c]) => c)).not.toEqual(expect.arrayContaining(['whats_bloco_texto']));
  });

  test('base sem a migration 401: pula e salva o resto', async () => {
    semColuna = true;
    const r = await request(app).put('/companies/cid-1/digital-channel')
      .send({ whats_bloco_titulo: 'Oi', pedidos_pausados: true });
    expect(r.status).toBe(200);
    expect(r.body.config.pedidos_pausados).toBe(true);
  });
});

// ── 2. A politica de troca com link ──────────────────────────────
describe('politica de troca com link para o WhatsApp', () => {
  test('a politica da lojista com a palavra: so "WhatsApp" vira link', () => {
    const txt = blocoDaPolitica(pagina({ politica_troca: FELIC }));
    expect(txt).toBe('<div class="footer-inst-txt">Você pode desistir da compra em até 7 dias após receber o pedido, conforme o '
      + 'Código de Defesa do Consumidor. Para trocas, fale com a loja pelo '
      + '<a href="https://wa.me/5512981365134" target="_blank" rel="noopener" style="color:var(--sf-pix);font-weight:600;text-decoration:underline;">WhatsApp</a>.</div>');
  });

  test('loja sem WhatsApp: a politica identica a de hoje', () => {
    const html = pagina({ contact: {}, politica_troca: FELIC });
    expect(blocoDaPolitica(html)).toBe(`<div class="footer-inst-txt">${FELIC}</div>`);
  });

  test('politica sem a palavra: nada e acrescentado', () => {
    const p = 'Trocas em até 30 dias na loja física.';
    expect(blocoDaPolitica(pagina({ politica_troca: p }))).toBe(`<div class="footer-inst-txt">${p}</div>`);
  });

  test('texto padrao (lojista nao escreveu): fica como hoje, sem link', () => {
    const html = pagina({ politica_troca: null });
    expect(blocoDaPolitica(html)).toBe(`<div class="footer-inst-txt">${POLITICA_PADRAO}</div>`);
  });

  test('escape: o texto da lojista e escapado e so a palavra exata vira <a>', () => {
    const malicioso = '<script>alert(1)</script> "x" & <a href="javascript:alert(2)">WhatsApp</a> WhatsAppzinho whatsapp';
    const html = politicaComLinkDoWhatsapp(malicioso, '(12) 98136-5134');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:alert(2)">');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &quot;x&quot; &amp; &lt;a href=&quot;javascript:alert(2)&quot;&gt;');
    // Dois links: o "WhatsApp" de dentro da tag escapada e o "whatsapp"
    // final. "WhatsAppzinho" nao e a palavra.
    expect(html.match(/<a /g)).toHaveLength(2);
    expect(html).toContain('WhatsAppzinho');
    expect(html).not.toContain('>WhatsAppzinho<');
    expect(html).toContain('>whatsapp</a>');
    // Tirando os <a> que a gente pos, sobra o texto escapado inteiro.
    const semLinks = html.replace(/<a href="https:\/\/wa\.me\/5512981365134"[^>]*>(\w+)<\/a>/g, '$1');
    expect(semLinks).not.toMatch(/<|>/);
  });

  test('sem numero devolve exatamente o texto escapado', () => {
    expect(politicaComLinkDoWhatsapp('a <b> WhatsApp', '')).toBe('a &lt;b&gt; WhatsApp');
  });
});
