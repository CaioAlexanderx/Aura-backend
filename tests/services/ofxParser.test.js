// ============================================================
// Leitor de OFX (services/ofxParser.js).
//
// parseOFX saiu de routes/transactionsBatch.js sem mudar de comportamento:
// `parseOFXAntigo` abaixo é a cópia congelada da função original e os dois
// precisam devolver o mesmo para qualquer entrada.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const {
  parseOFX, decodificarOfx, lancamentosDoOfx, mesDominante,
} = require('../../src/services/ofxParser');

// Cópia literal da função como estava em transactionsBatch.js antes da extração.
function parseOFXAntigo(content) {
  const transactions = [];
  const body = content.replace(/[\s\S]*?(?=<OFX>|<ofx>)/i, '');
  const trnRegex = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let match;
  while ((match = trnRegex.exec(body)) !== null) {
    const block = match[1];
    const get = (tag) => { const m = new RegExp(`<${tag}>([^<\\r\\n]+)`, 'i').exec(block); return m ? m[1].trim() : null; };
    const trntype = get('TRNTYPE'), dtposted = get('DTPOSTED'), trnamt = get('TRNAMT'), fitid = get('FITID');
    const memo = get('MEMO') || get('NAME') || '';
    if (!trnamt || !dtposted || !fitid) continue;
    const rawDate = dtposted.replace(/[^0-9]/g, '').substring(0, 8);
    if (rawDate.length !== 8) continue;
    const due_date = `${rawDate.substring(0,4)}-${rawDate.substring(4,6)}-${rawDate.substring(6,8)}`;
    const amount = Math.abs(parseFloat(trnamt.replace(',', '.')));
    if (isNaN(amount) || amount === 0) continue;
    const positiveAmount = parseFloat(trnamt.replace(',', '.')) > 0;
    const creditTypes = ['CREDIT', 'DEP', 'DIRECTDEP', 'INTEREST', 'DIV'];
    const isCredit = creditTypes.includes((trntype || '').toUpperCase()) || positiveAmount;
    transactions.push({ type: isCredit ? 'income' : 'expense', amount, description: memo || `Transacao bancaria - ${fitid}`, due_date, status: 'paid', fitid, category: null, notes: `Importado via OFX - FITID: ${fitid}` });
  }
  return transactions;
}

const EXEMPLO = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'ofx', 'extrato-aura-2026-10.ofx'), 'utf8');

const trn = (campos) => `<STMTTRN>${Object.entries(campos).map(([k, v]) => `<${k}>${v}`).join('\n')}\n</STMTTRN>`;
const ofx = (...blocos) => `OFXHEADER:100\n\n<OFX>\n<BANKTRANLIST>\n${blocos.join('\n')}\n</BANKTRANLIST>\n</OFX>`;

describe('parseOFX', () => {
  test('lê o extrato de exemplo: sinal, tipo, data com fuso e memo', () => {
    const t = parseOFX(EXEMPLO);
    expect(t).toHaveLength(7);
    expect(t[0]).toEqual({
      type: 'income', amount: 140.83, description: 'TRANSF ASAAS', due_date: '2026-10-02', status: 'paid',
      fitid: '202610020001', category: null, notes: 'Importado via OFX - FITID: 202610020001',
    });
    expect(t[4]).toMatchObject({ type: 'expense', amount: 12.9, due_date: '2026-10-14', fitid: '202610140001' });
  });

  test('mesmos resultados da função original, inclusive nos casos de borda', () => {
    const casos = [
      EXEMPLO,
      '',
      'sem nada de ofx aqui',
      ofx(trn({ TRNTYPE: 'CREDIT', DTPOSTED: '20261001', TRNAMT: '10,50', FITID: 'a1', NAME: 'so nome' })),
      ofx(trn({ TRNTYPE: 'DEP', DTPOSTED: '20261001', TRNAMT: '-10.00', FITID: 'a2', MEMO: 'dep com sinal negativo' })),
      ofx(trn({ TRNTYPE: 'OTHER', DTPOSTED: '2026', TRNAMT: '1', FITID: 'a3' })),
      ofx(trn({ TRNTYPE: 'CREDIT', DTPOSTED: '20261001', TRNAMT: '0.00', FITID: 'a4' })),
      ofx(trn({ TRNTYPE: 'CREDIT', DTPOSTED: '20261001', TRNAMT: '5.00' })),
      ofx(trn({ DTPOSTED: '20261001', TRNAMT: '5.00', FITID: 'a5' })),
      ofx(trn({ TRNTYPE: 'debit', DTPOSTED: '20261001', TRNAMT: '-7.77', FITID: 'a6', MEMO: '' })),
      EXEMPLO.replace(/\n/g, '\r\n'),
    ];
    for (const c of casos) expect(parseOFX(c)).toEqual(parseOFXAntigo(c));
  });

  test('a rota dos lojistas usa o mesmo leitor', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes', 'transactionsBatch.js'), 'utf8');
    expect(fonte).toContain("require('../services/ofxParser')");
    expect(fonte).not.toMatch(/function parseOFX\(/);
  });
});

describe('decodificarOfx', () => {
  test('UTF-8 válido passa como está (e a BOM sai)', () => {
    expect(decodificarOfx(Buffer.from('﻿<MEMO>JOSÉ', 'utf8'))).toBe('<MEMO>JOSÉ');
  });
  test('windows-1252 (o que o banco exporta) é lido com acento', () => {
    expect(decodificarOfx(Buffer.from('<MEMO>PIX JOSÉ DA CONCEIÇÃO', 'latin1'))).toBe('<MEMO>PIX JOSÉ DA CONCEIÇÃO');
  });
  test('texto já decodificado volta igual', () => {
    expect(decodificarOfx('abc')).toBe('abc');
  });
});

describe('lancamentosDoOfx', () => {
  test('formato da conciliação: crédito/débito, data, valor positivo e FITID', () => {
    const l = lancamentosDoOfx(EXEMPLO);
    expect(l).toHaveLength(7);
    expect(l[0]).toEqual({ data: '2026-10-02', valor: 140.83, tipo: 'credito', descricao: 'TRANSF ASAAS', fitid: '202610020001' });
    expect(l.filter((x) => x.tipo === 'debito')).toEqual([
      { data: '2026-10-14', valor: 12.9, tipo: 'debito', descricao: 'TARIFA PACOTE SERVICOS', fitid: '202610140001' },
    ]);
  });

  test('aceita bytes em windows-1252', () => {
    const l = lancamentosDoOfx(Buffer.from(EXEMPLO.replace('PIX RECEBIDO LOJA EXEMPLO', 'PIX RECEBIDO JOSÉ'), 'latin1'));
    expect(l[2].descricao).toBe('PIX RECEBIDO JOSÉ');
  });

  test('mesmo FITID com outro valor ganha sufixo; linha repetida igual sai', () => {
    const l = lancamentosDoOfx(ofx(
      trn({ TRNTYPE: 'CREDIT', DTPOSTED: '20261001', TRNAMT: '10.00', FITID: 'x', MEMO: 'a' }),
      trn({ TRNTYPE: 'CREDIT', DTPOSTED: '20261001', TRNAMT: '20.00', FITID: 'x', MEMO: 'b' }),
      trn({ TRNTYPE: 'CREDIT', DTPOSTED: '20261001', TRNAMT: '10.00', FITID: 'x', MEMO: 'a de novo' }),
      trn({ TRNTYPE: 'CREDIT', DTPOSTED: '20261002', TRNAMT: '30.00', FITID: 'x', MEMO: 'c' }),
    ));
    expect(l.map((x) => [x.fitid, x.valor])).toEqual([['x', 10], ['x#2', 20], ['x#3', 30]]);
  });
});

describe('mesDominante', () => {
  test('o mês com mais lançamentos; empate fica com o mais novo', () => {
    const l = (data) => ({ data });
    expect(mesDominante([l('2026-09-28'), l('2026-10-02'), l('2026-10-09')])).toBe('2026-10');
    expect(mesDominante([l('2026-09-28'), l('2026-10-02')])).toBe('2026-10');
    expect(mesDominante([])).toBeNull();
  });
});
