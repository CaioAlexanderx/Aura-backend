// ============================================================
// AURA VENDAS — numero sequencial da venda (migration 310)
//
// O RELATO (QA de usabilidade, 29/08/2026): a tela de sucesso do PDV
// mostrava "#6c66d000-5e95-4af8-887e-2d793eab8260". O numero da venda e o
// unico dado que a operadora LE EM VOZ ALTA pro cliente e que o cliente
// anota; 36 caracteres de chave interna nao cumprem esse papel.
//
// A DECISAO QUE ESTE ARQUIVO GUARDA: o numero e POR EMPRESA e nasce de um
// CONTADOR TRAVADO, nao de MAX()+1. Duas vendas simultaneas na mesma loja
// leriam o mesmo MAX (o SELECT nao bloqueia nada) e gravariam o mesmo
// numero — e numero de venda repetido e pior que UUID: manda a operadora
// procurar a venda errada.
//
// Cobre a alocacao (SQL da migration), o contrato de API (nenhum campo
// renomeado, sale_number ao lado do id) e o guarda-corpo de deploy parcial
// (backend sobe antes da migration -> nada de 42703 na tela de Vendas).
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

function fonte(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const migration = fonte('migrations/310_sales_numero_sequencial.sql');

describe('a alocacao do numero — o que impede duas vendas com o mesmo numero', () => {
  it('o contador e por empresa, nao global', () => {
    // Um sequencial global faria a venda #1 da filial nova sair como
    // #48.291 e vazaria o volume de uma loja pra outra.
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS company_sale_counters/);
    expect(migration).toMatch(/company_id\s+UUID PRIMARY KEY/);
  });

  it('aloca com UPSERT ... RETURNING, nunca com MAX()+1', () => {
    // O UPSERT trava a LINHA do contador daquela empresa ate o COMMIT.
    // MAX(sale_number)+1 nao trava nada: duas vendas simultaneas leem o
    // mesmo valor.
    const fn = migration.slice(migration.indexOf('FUNCTION next_sale_number'));
    expect(fn).toMatch(/INSERT INTO company_sale_counters/);
    expect(fn).toMatch(/ON CONFLICT \(company_id\) DO UPDATE/);
    expect(fn).toMatch(/last_number = c\.last_number \+ 1/);
    expect(fn).toMatch(/RETURNING c\.last_number/);
    expect(fn).not.toMatch(/MAX\s*\(\s*sale_number/i);
  });

  it('o banco recusa numero repetido na mesma empresa', () => {
    // Cinto e suspensorio: se algum caminho futuro gravar sale_number na
    // mao, o indice barra em vez de deixar passar silenciosamente.
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_company_sale_number[\s\S]{0,120}\(company_id, sale_number\)/
    );
  });

  it('todo INSERT em sales e coberto por trigger, nao por lembrete', () => {
    // Existem 5 caminhos que gravam em `sales` (pdv, food, troca x2,
    // refund). Numerar em cada rota deixaria o sexto de fora.
    expect(migration).toMatch(/BEFORE INSERT ON sales/);
    expect(migration).toMatch(/EXECUTE FUNCTION assign_sale_number\(\)/);
  });

  it('respeita numero explicito (import/migracao de dados)', () => {
    expect(migration).toMatch(/IF NEW\.sale_number IS NULL/);
  });

  it('numero explicito EMPURRA o contador -- a bomba-relogio do import', () => {
    // Respeitar o numero do import sem mexer no contador plantava uma
    // falha com meses de atraso: importa a venda #500 numa empresa com
    // contador em 10, o contador fica em 10, e la na frente a numeracao
    // automatica chega em 500, colide com o indice unico e a venda do
    // BALCAO falha -- longe do import, sem pista nenhuma da causa.
    //
    // O GREATEST do seed so roda na hora da migration: nao protege
    // runtime. Tem que ser no ramo explicito da trigger.
    const fn = migration.slice(migration.indexOf('FUNCTION assign_sale_number'));
    expect(fn).toMatch(/ELSE[\s\S]{0,900}INSERT INTO company_sale_counters/);
    expect(fn).toMatch(/GREATEST\(c\.last_number, EXCLUDED\.last_number\)/);
  });

  it('numero explicito ABAIXO do contador nao faz o contador retroceder', () => {
    // GREATEST nos dois sentidos: importar a venda #7 numa empresa com
    // contador em 500 nao pode devolver o contador pra 7 -- a proxima
    // venda automatica sairia #8 e colidiria com a #8 que ja existe.
    const fn = migration.slice(migration.indexOf('FUNCTION assign_sale_number'));
    expect(fn).toMatch(/GREATEST\(/);
    expect(fn).not.toMatch(/SET last_number = EXCLUDED\.last_number\s*,/);
  });

  it('o ramo explicito nao chama next_sale_number (nao queima numero)', () => {
    // Chamar os dois gastaria um numero do contador a cada linha
    // importada -- o import de 1.000 vendas antigas empurraria a
    // numeracao do balcao 1.000 pra frente sem motivo.
    const fn = migration.slice(
      migration.indexOf('FUNCTION assign_sale_number'),
      migration.indexOf('DROP TRIGGER IF EXISTS trg_sales_assign_number')
    );
    expect((fn.match(/next_sale_number\(/g) || []).length).toBe(1);
  });

  it('company_id nulo sai da trigger sem tocar o contador', () => {
    const fn = migration.slice(migration.indexOf('FUNCTION assign_sale_number'));
    expect(fn).toMatch(/IF NEW\.company_id IS NULL THEN[\s]*RETURN NEW;/);
  });

  it('o custo de lock do contador esta documentado', () => {
    // Os dois ramos travam a linha do contador ate o COMMIT. Duas
    // empresas na mesma transacao podem deadlockar com outra transacao
    // na ordem inversa (reproduzido em PG18). Hoje e inalcancavel --
    // todo caminho grava UMA venda de UMA empresa por transacao -- mas
    // quem escrever import em lote multi-empresa precisa saber.
    expect(migration).toMatch(/deadlock/i);
    expect(migration).toMatch(/commit por empresa, ou[\s\S]{0,20}ordene os company_id/);
  });

  it('o backfill numera o historico em ordem cronologica, por empresa', () => {
    // Numerar por ordem de insercao fisica embaralharia a linha do tempo
    // que a lojista ja conhece.
    expect(migration).toMatch(
      /row_number\(\) OVER \(PARTITION BY company_id ORDER BY created_at ASC/
    );
    // Idempotente: rodar duas vezes nao renumera o que ja tem numero.
    expect(migration).toMatch(/WHERE sale_number IS NULL/);
  });

  it('semear o contador nunca anda pra tras', () => {
    // Rodar a migration de novo depois de vendas novas nao pode reduzir o
    // contador — seria numero duplicado na proxima venda.
    expect(migration).toMatch(/GREATEST\(company_sale_counters\.last_number, EXCLUDED\.last_number\)/);
  });
});

describe('o contrato de API — o app tem que achar o numero', () => {
  const listagens = ['src/routes/sales.js', 'src/routes/meAggregates.js', 'src/routes/pdv.js'];

  it.each(listagens)('%s seleciona sale_number na listagem', (rel) => {
    expect(fonte(rel)).toContain('saleNumberSelect(');
  });

  it.each(['src/routes/sales.js', 'src/routes/meAggregates.js'])(
    '%s devolve sale_number no JSON',
    (rel) => {
      expect(fonte(rel)).toMatch(/sale_number:\s*r?\.?/);
    }
  );

  it('o detalhe da venda devolve sale_number', () => {
    const src = fonte('src/routes/sales.js');
    expect(src).toMatch(/sale_number: sale\.sale_number/);
  });

  it('o id continua sendo o id — nada foi renomeado nem removido', () => {
    // Nao-negociavel: o app usa o uuid nas rotas (/vendas/:id, cancelar,
    // imprimir). sale_number ENTRA ao lado, nunca no lugar.
    for (const rel of ['src/routes/sales.js', 'src/routes/meAggregates.js']) {
      const src = fonte(rel);
      expect(src).toMatch(/\n\s*id: (r|sale)\.id,/);
    }
  });

  it('o cupom impresso mostra o mesmo numero que a tela', () => {
    // Se o papel e a tela discordam, o numero deixa de servir pra
    // localizar a venda — que e a unica razao dele existir.
    const src = fonte('src/routes/print.js');
    expect(src).toContain('saleLabel(sale)');
    expect(src).toMatch(/sale\.sale_number != null/);
  });
});

describe('deploy parcial — backend novo, banco velho', () => {
  const { saleNumberSelect, hasSaleNumberColumn, _resetCache } = require('../src/utils/saleNumber');

  beforeEach(() => _resetCache());

  it('sem a coluna, a query pede NULL com o mesmo alias', () => {
    // A forma do JSON nao pode mudar entre o deploy e a migration: o app
    // le sale_number nos dois momentos, so que null no primeiro.
    expect(saleNumberSelect(false)).toBe('NULL::int AS sale_number');
  });

  it('com a coluna, pede a coluna com o alias da tabela', () => {
    expect(saleNumberSelect(true)).toBe('s.sale_number');
    expect(saleNumberSelect(true, 'v')).toBe('v.sale_number');
  });

  it('a probe consulta o information_schema uma vez e cacheia', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ n: '1' }] }) };
    expect(await hasSaleNumberColumn(db)).toBe(true);
    expect(await hasSaleNumberColumn(db)).toBe(true);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0]).toContain('information_schema.columns');
  });

  it('probe que explode nao derruba a listagem — cai pro modo sem coluna', async () => {
    // Uma tela de Vendas em branco por causa de um campo cosmetico seria
    // pior que a tela sem o campo.
    const db = { query: jest.fn().mockRejectedValue(new Error('boom')) };
    expect(await hasSaleNumberColumn(db)).toBe(false);
  });
});
