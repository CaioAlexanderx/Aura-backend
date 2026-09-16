// ============================================================
// Fila de pedidos do painel (10/09/2026)
//
// Travado aqui: a busca (numero, telefone, texto com curinga escapado), a
// foto e o nome do primeiro item, o nome da cor no lugar do hex, e a
// contagem de parametros — o Postgres conta pelo maior $n, e parametro
// sobrando ja derrubou o catalogo das lojas com curadoria.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const {
  nomeLegivelDoItem, escaparLike, montarConsultaDaFila, apresentarLinhaDaFila,
} = require('../src/services/filaDePedidos');

const CID = 'c0000000-0000-0000-0000-000000000001';

/** Todo $n citado existe e todo parametro e citado. */
function conferirParametros({ sql, params }) {
  const citados = new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  const maior = Math.max(...citados);
  expect(maior).toBe(params.length);
  for (let i = 1; i <= params.length; i++) expect(citados.has(i)).toBe(true);
}

describe('nome legivel do item', () => {
  test('hex vira o nome da cor da vitrine', () => {
    expect(nomeLegivelDoItem('Conjunto de short luka (Cor: #92400E / Tamanho: G)'))
      .toBe('Conjunto de short luka (Cor: Ferrugem / Tamanho: G)');
    expect(nomeLegivelDoItem('Boddy Livia (Cor: #FFFFFF)')).toBe('Boddy Livia (Cor: Branco)');
  });
  test('nome sem hex e nulo passam intactos', () => {
    expect(nomeLegivelDoItem('CANECA BRANCA')).toBe('CANECA BRANCA');
    expect(nomeLegivelDoItem(null)).toBeNull();
    expect(nomeLegivelDoItem(undefined)).toBeUndefined();
  });
});

describe('consulta da fila', () => {
  test('sem busca: empresa, limite e deslocamento', () => {
    const c = montarConsultaDaFila({ cid: CID, limit: 20, offset: 40 });
    expect(c.params).toEqual([CID, 20, 40]);
    expect(c.sql).toMatch(/LIMIT \$2 OFFSET \$3/);
    conferirParametros(c);
  });

  test('traz foto e nome do primeiro item, contagem e total filtrado', () => {
    const { sql } = montarConsultaDaFila({ cid: CID, limit: 20, offset: 0 });
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain('COALESCE(p.image_thumb_url, i1.product_image, p.image_url) AS imagem');
    expect(sql).toContain('ORDER BY i1.id');
    expect(sql).toContain('AS item_count');
    expect(sql).toContain('COUNT(*) OVER() AS total_filtrado');
  });

  test('status entra como parametro', () => {
    const c = montarConsultaDaFila({ cid: CID, status: 'pending_payment', limit: 20, offset: 0 });
    expect(c.params).toEqual([CID, 'pending_payment', 20, 0]);
    expect(c.sql).toContain('o.status = $2');
    conferirParametros(c);
  });

  test.each(['3', '#3', '#00003', ' 00003 '])('"%s" busca pelo numero do pedido sem zeros', (q) => {
    const c = montarConsultaDaFila({ cid: CID, q, limit: 20, offset: 0 });
    expect(c.params[1].replace(/^0+/, '')).toBe('3');
    expect(c.sql).toContain("ltrim(o.order_number::text, '0') = ltrim($2, '0')");
    conferirParametros(c);
  });

  test('telefone com mascara busca pelos digitos', () => {
    const c = montarConsultaDaFila({ cid: CID, q: '(91) 98888-7777', limit: 20, offset: 0 });
    expect(c.params[1]).toBe('91988887777');
    expect(c.sql).toContain("regexp_replace(COALESCE(o.customer_phone, ''), '[^0-9]', '', 'g') LIKE '%' || $2 || '%'");
    expect(c.sql).toContain('length($2) >= 4');
    conferirParametros(c);
  });

  test('texto busca em cliente, e-mail e nome do produto', () => {
    const c = montarConsultaDaFila({ cid: CID, q: 'eryca', limit: 20, offset: 0 });
    expect(c.params[1]).toBe('%eryca%');
    expect(c.sql).toContain("o.customer_name ILIKE $2 ESCAPE '!'");
    expect(c.sql).toContain("o.customer_email ILIKE $2 ESCAPE '!'");
    expect(c.sql).toContain("bi.product_name ILIKE $2 ESCAPE '!'");
    conferirParametros(c);
  });

  test('curinga digitado vira texto', () => {
    expect(escaparLike('50%_off!')).toBe('50!%!_off!!');
    const c = montarConsultaDaFila({ cid: CID, q: 'luka 100%', limit: 20, offset: 0 });
    expect(c.params[1]).toBe('%luka 100!%%');
  });

  test('status e busca juntos', () => {
    const c = montarConsultaDaFila({ cid: CID, status: 'cancelled', q: 'luka', limit: 10, offset: 0 });
    expect(c.params).toEqual([CID, 'cancelled', '%luka%', 10, 0]);
    conferirParametros(c);
  });

  test('busca longa e cortada em 80 caracteres', () => {
    const c = montarConsultaDaFila({ cid: CID, q: 'a'.repeat(300), limit: 20, offset: 0 });
    expect(c.params[1]).toBe('%' + 'a'.repeat(80) + '%');
  });
});

describe('apresentacao da linha', () => {
  test('tira a coluna tecnica e deixa o nome do item legivel', () => {
    const linha = apresentarLinhaDaFila({ id: 'o1', total_filtrado: '7', first_item_name: 'Body (Cor: #000000)', first_item_image: 'https://x/t.jpg' });
    expect(linha).toEqual({ id: 'o1', first_item_name: 'Body (Cor: Preto)', first_item_image: 'https://x/t.jpg' });
  });
});

describe('a rota usa o servico', () => {
  const rota = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'digitalOrders.js'), 'utf8');
  test('lista, total filtrado e contagem de expirados', () => {
    expect(rota).toContain('montarConsultaDaFila({ cid, status, q, limit: porPagina, offset })');
    expect(rota).toContain('rows.map(apresentarLinhaDaFila)');
    expect(rota).toContain("COUNT(*) FILTER (WHERE status = 'cancelled' AND payment_status = 'expired')::int AS expired");
  });
  test('detalhe devolve o nome legivel e a miniatura do produto', () => {
    expect(rota).toContain('product_name_display: nomeLegivelDoItem(it.product_name)');
    expect(rota).toContain('COALESCE(p.image_thumb_url, i.product_image, p.image_url) AS product_image');
  });
});
