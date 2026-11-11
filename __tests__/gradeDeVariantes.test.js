// ============================================================
// AURA. — Plano da grade: editar cor/tamanho não deixa estoque preso
// (10/11/2026). Função pura de services/gradeDeVariantes.js.
// ============================================================
'use strict';

const { planejarGrade, mensagemDaRemocao } = require('../src/services/gradeDeVariantes');

const preto = (size, stock, id) => ({ id: id || 'preto-' + size, colorHex: '#000000', colorName: 'Preto', sizeValue: size, stock });
const azul = (size, stock, id) => ({ id: id || 'azul-' + size, colorHex: '#3B82F6', colorName: 'Azul', sizeValue: size, stock });
const pedido = (hex, size, stock) => ({ colorHex: hex, colorName: null, sizeValue: size, stock });

describe('combinação que continua na grade', () => {
  test('é atualizada na mesma linha, com o número que veio', () => {
    const p = planejarGrade({
      existentes: [preto('P', 3), preto('M', 2)],
      combinacoes: [pedido('#000000', 'P', 3), pedido('#000000', 'M', 5)],
    });
    expect(p.criar).toEqual([]);
    expect(p.remover).toEqual([]);
    expect(p.atualizar.map((a) => [a.id, a.stock])).toEqual([['preto-P', 3], ['preto-M', 5]]);
    expect(p.bloqueio).toBeNull();
  });

  test('hex em caixa diferente é a mesma cor (não recria nem zera)', () => {
    const p = planejarGrade({
      existentes: [{ id: 'v1', colorHex: '#ff0000', sizeValue: 'G', stock: 4 }],
      combinacoes: [pedido('#FF0000', 'G', 4)],
    });
    expect(p.atualizar).toHaveLength(1);
    expect(p.atualizar[0].id).toBe('v1');
    expect(p.criar).toEqual([]);
    expect(p.remover).toEqual([]);
  });

  test('adicionar um tamanho não mexe no estoque das outras combinações', () => {
    const p = planejarGrade({
      existentes: [preto('P', 3), azul('P', 1)],
      combinacoes: [
        pedido('#000000', 'P', 3), pedido('#000000', 'M', 0),
        pedido('#3B82F6', 'P', 1), pedido('#3B82F6', 'M', 0),
      ],
    });
    expect(p.atualizar.map((a) => a.id).sort()).toEqual(['azul-P', 'preto-P']);
    expect(p.criar.map((c) => c.colorHex + '|' + c.sizeValue).sort()).toEqual(['#000000|M', '#3B82F6|M']);
    expect(p.remover).toEqual([]);
  });

  test('só cor (sem tamanho) e só tamanho também casam', () => {
    const soCor = planejarGrade({
      existentes: [{ id: 'c', colorHex: '#000000', sizeValue: null, stock: 2 }],
      combinacoes: [pedido('#000000', null, 2)],
    });
    expect(soCor.atualizar[0].id).toBe('c');
    const soTam = planejarGrade({
      existentes: [{ id: 't', colorHex: null, sizeValue: '38', stock: 7 }],
      combinacoes: [pedido(null, '38', 7)],
    });
    expect(soTam.atualizar[0].id).toBe('t');
  });
});

describe('combinação que sai da grade', () => {
  test('sem estoque sai sem perguntar', () => {
    const p = planejarGrade({
      existentes: [preto('P', 3), preto('GG', 0)],
      combinacoes: [pedido('#000000', 'P', 3)],
    });
    expect(p.remover.map((r) => r.id)).toEqual(['preto-GG']);
    expect(p.bloqueio).toBeNull();
  });

  test('com estoque é recusada com mensagem gentil e nada sai', () => {
    const p = planejarGrade({
      existentes: [preto('P', 3), preto('M', 2)],
      combinacoes: [pedido('#000000', 'P', 3)],
    });
    expect(p.bloqueio).not.toBeNull();
    expect(p.bloqueio.mensagem).toBe('Preto · M ainda tem 2 peças. Zere o estoque ou transfira antes de remover.');
    expect(p.bloqueio.removidas).toEqual([
      { id: 'preto-M', colorHex: '#000000', colorName: 'Preto', sizeValue: 'M', stock: 2 },
    ]);
  });

  test('com confirmação explícita sai', () => {
    const p = planejarGrade({
      existentes: [preto('P', 3), preto('M', 2)],
      combinacoes: [pedido('#000000', 'P', 3)],
      confirmarRemocao: true,
    });
    expect(p.bloqueio).toBeNull();
    expect(p.remover.map((r) => r.id)).toEqual(['preto-M']);
    expect(p.removidasComEstoque).toHaveLength(1);
  });

  test('trocar o hex de uma cor com estoque conta como remover (pede confirmação)', () => {
    const p = planejarGrade({
      existentes: [azul('P', 4)],
      combinacoes: [pedido('#1E3A8A', 'P', 0)],
    });
    expect(p.bloqueio.mensagem).toBe('Azul · P ainda tem 4 peças. Zere o estoque ou transfira antes de remover.');
  });

  test('esvaziar a grade inteira com estoque também pede confirmação', () => {
    const p = planejarGrade({ existentes: [preto('P', 1)], combinacoes: [] });
    expect(p.bloqueio.mensagem).toBe('Preto · P ainda tem 1 peça. Zere o estoque ou transfira antes de remover.');
  });
});

describe('célula que a lojista não mexeu', () => {
  test('mantém o estoque do banco (venda feita com o editor aberto não volta)', () => {
    // O editor abriu com P=3; vendeu 1 no Caixa (banco: 2); a lojista só
    // mexeu no M e salvou com P=3 ainda na tela.
    const p = planejarGrade({
      existentes: [preto('P', 2), preto('M', 1)],
      combinacoes: [pedido('#000000', 'P', 3), pedido('#000000', 'M', 6)],
      matrizLida: { '#000000|P': 3, '#000000|M': 1 },
    });
    const porId = Object.fromEntries(p.atualizar.map((a) => [a.id, a.stock]));
    expect(porId['preto-P']).toBe(2);
    expect(porId['preto-M']).toBe(6);
  });

  test('a chave lida com hex minúsculo também vale', () => {
    const p = planejarGrade({
      existentes: [preto('P', 5)],
      combinacoes: [pedido('#000000', 'P', 4)],
      matrizLida: { '#000000|P': 4 },
    });
    expect(p.atualizar[0].stock).toBe(5);
  });

  test('sem matriz lida (cliente antigo) vale o número que veio', () => {
    const p = planejarGrade({
      existentes: [preto('P', 2)],
      combinacoes: [pedido('#000000', 'P', 3)],
    });
    expect(p.atualizar[0].stock).toBe(3);
  });

  test('célula mexida vale o que a lojista digitou, mesmo que o banco tenha mudado', () => {
    const p = planejarGrade({
      existentes: [preto('P', 2)],
      combinacoes: [pedido('#000000', 'P', 10)],
      matrizLida: { '#000000|P': 3 },
    });
    expect(p.atualizar[0].stock).toBe(10);
  });
});

describe('duplicadas do legado', () => {
  test('fica a mais nova (a que o GET mostra); a mais velha sai sem bloquear', () => {
    const p = planejarGrade({
      existentes: [preto('P', 9, 'velha'), preto('P', 3, 'nova')],
      combinacoes: [pedido('#000000', 'P', 3)],
    });
    expect(p.atualizar.map((a) => a.id)).toEqual(['nova']);
    expect(p.duplicadas.map((d) => d.id)).toEqual(['velha']);
    expect(p.remover).toEqual([]);
    expect(p.bloqueio).toBeNull();
  });
});

describe('mensagemDaRemocao', () => {
  test('várias combinações somam as peças', () => {
    const m = mensagemDaRemocao([
      { colorHex: '#000000', colorName: 'Preto', sizeValue: 'M', stock: 2 },
      { colorHex: null, colorName: null, sizeValue: 'GG', stock: 1 },
    ]);
    expect(m).toBe('Estas cores/tamanhos ainda têm 3 peças: Preto · M (2 peças), GG (1 peça). Zere o estoque ou transfira antes de remover.');
  });
  test('lista vazia não tem mensagem', () => {
    expect(mensagemDaRemocao([])).toBeNull();
  });
});
