// ============================================================
// AURA. — Leitor de extrato OFX (13/10/2026)
//
// Saiu de routes/transactionsBatch.js (import-ofx dos lojistas) para ser
// usado também pela conciliação do extrato da própria Aura
// (routes/adminPainelOfx.js). parseOFX() é a MESMA função de antes, linha a
// linha — a rota dos lojistas não muda de comportamento.
//
// OFX 1.x é SGML (tags sem fechamento, exceto STMTTRN); o leitor não faz XML,
// procura cada <STMTTRN>…</STMTTRN> e lê as tags de dentro.
// ============================================================
'use strict';

/**
 * Lê as transações de um OFX.
 * Devolve [{ type: 'income'|'expense', amount (positivo), description,
 *            due_date 'YYYY-MM-DD', status: 'paid', fitid, category: null, notes }].
 * Transação sem valor, data ou FITID é descartada.
 */
function parseOFX(content) {
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

/**
 * OFX em bytes → texto. Banco brasileiro costuma exportar em windows-1252
 * (CHARSET:1252): tenta UTF-8 estrito e, se o arquivo não for UTF-8 válido,
 * lê como windows-1252 para 'Pix recebido de JOSÉ' não virar lixo.
 */
function decodificarOfx(entrada) {
  if (typeof entrada === 'string') return entrada;
  const bytes = Buffer.isBuffer(entrada) ? entrada : Buffer.from(entrada || []);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch (_) {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/**
 * As linhas do extrato no formato da conciliação da Aura:
 * [{ data, valor, tipo: 'credito'|'debito', descricao, fitid }].
 * Mesmo FITID repetido no arquivo com outro valor/data (acontece em alguns
 * bancos) ganha sufixo "#2", "#3"… para não perder a segunda linha; repetido
 * com tudo igual é a mesma linha duas vezes e sai.
 */
function lancamentosDoOfx(conteudo) {
  const vistos = new Map();
  const saida = [];
  for (const t of parseOFX(decodificarOfx(conteudo))) {
    const linha = {
      data: t.due_date,
      valor: t.amount,
      tipo: t.type === 'income' ? 'credito' : 'debito',
      descricao: t.description,
      fitid: t.fitid,
    };
    const assinatura = `${linha.data}|${linha.valor}|${linha.tipo}`;
    const anteriores = vistos.get(t.fitid) || [];
    if (anteriores.includes(assinatura)) continue;
    if (anteriores.length) linha.fitid = `${t.fitid}#${anteriores.length + 1}`;
    anteriores.push(assinatura);
    vistos.set(t.fitid, anteriores);
    saida.push(linha);
  }
  return saida;
}

/** Mês ('YYYY-MM') com mais lançamentos — o mês de referência quando ninguém informa. */
function mesDominante(lancamentos) {
  const contagem = new Map();
  for (const l of lancamentos) {
    const m = l.data.slice(0, 7);
    contagem.set(m, (contagem.get(m) || 0) + 1);
  }
  let melhor = null;
  for (const [m, n] of contagem) {
    if (!melhor || n > melhor.n || (n === melhor.n && m > melhor.m)) melhor = { m, n };
  }
  return melhor ? melhor.m : null;
}

module.exports = { parseOFX, decodificarOfx, lancamentosDoOfx, mesDominante };
