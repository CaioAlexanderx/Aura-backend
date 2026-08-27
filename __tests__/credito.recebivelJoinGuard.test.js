// ============================================================
// AURA CRÉDITO — guarda-corpo do join recebível → venda (24/08/2026)
//
// Teste PURO (sem banco), de propósito: roda em qualquer ambiente, inclusive
// onde não há Postgres. A prova de comportamento em banco real está em
// credito.recebivelSaldoParcial.test.js.
//
// O QUE ESTE ARQUIVO IMPEDE
//   Casar recebível com venda por igualdade exata:
//       ('pdv-credit-receivable-' || s.id::text) = t.idempotency_key
//   Essa forma ignora o saldo de pagamento parcial, cuja chave leva o sufixo
//   '-rest-<timestamp>'. Em produção (21/08/2026) isso deixou 145 recebíveis
//   inalcançáveis: 0% de quitação, contra 63% dos normais.
//
//   O conserto do refund.js (auditoria de 12/06) já tinha adotado o prefixo,
//   mas não foi propagado — cinco consultas ficaram para trás. É exatamente
//   esse tipo de correção pela metade que este arquivo trava.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const JOIN_ANTIGO = "('pdv-credit-receivable-' || s.id::text) = t.idempotency_key";
const JOIN_NOVO   = "t.idempotency_key LIKE 'pdv-credit-receivable-' || s.id::text || '%'";

describe('guarda-corpo: a igualdade exata não pode voltar', () => {
  function arquivosJs(dir, acc = []) {
    for (const nome of fs.readdirSync(dir)) {
      const p = path.join(dir, nome);
      const st = fs.statSync(p);
      if (st.isDirectory()) arquivosJs(p, acc);
      else if (nome.endsWith('.js')) acc.push(p);
    }
    return acc;
  }

  test('nenhum arquivo de src/ casa recebível por igualdade exata', () => {
    const culpados = arquivosJs(path.join(ROOT, 'src'))
      .filter((p) => fs.readFileSync(p, 'utf8').includes(JOIN_ANTIGO))
      .map((p) => path.relative(ROOT, p));

    // Se este teste falhar, alguém reintroduziu o join que ignora o saldo de
    // pagamento parcial. Use o prefixo LIKE (ou reference_id).
    expect(culpados).toEqual([]);
  });

  test('os cinco pontos que liam recebível usam o join novo', () => {
    const esperado = {
      // 27/08/2026: eram 3 (accountId, sem accountId, fallback). O escopo por
      // encomenda (`saleId` do applyPayment) trocou os dois primeiros ramos --
      // que só diferiam no filtro de carnê -- por uma query montada com
      // cláusulas opcionais. Sobraram a query principal e o fallback.
      'src/services/credit/ledger.js': 2,          // FIFO: query montada + fallback
      'src/services/credit/reschedule.js': 1,      // renegociação
      'src/routes/financialReceivables.js': 1,     // card "Crediário — A Receber"
    };
    for (const [rel, n] of Object.entries(esperado)) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const achados = src.split(JOIN_NOVO).length - 1;
      expect({ [rel]: achados }).toEqual({ [rel]: n });
    }
  });

  test('o recebível grava o vínculo com o cliente (reference_type)', () => {
    // Sem isso o único caminho até o nome é decodificar a chave — que foi
    // exatamente o acoplamento que quebrou.
    const src = fs.readFileSync(path.join(ROOT, 'src/services/credit/ledger.js'), 'utf8');
    const inserts = src.split("'Crediario - A Receber'").length - 1;
    expect(inserts).toBe(2); // o da venda e o do saldo parcial
    expect(src).toContain("'customer', $6::uuid");
    expect(src).toContain('_hasReferenceCols');
  });
});
