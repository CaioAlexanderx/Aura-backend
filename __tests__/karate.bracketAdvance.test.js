// ============================================================
// AURA KARATÊ — motor da chave: avanço NÃO pode cascatear
//
// Regressão do achado do QA de 23/08: propagateWinners tratava lado
// null como bye e auto-avançava — lançar UMA quartas numa chave de 16
// coroava campeão em cascata (semi e final "vencidas" sozinhas). Em
// rodadas >= 1, null significa "alimentadora pendente"; bye real é o
// sentinel 'bye' e só existe na rodada 0 (resolvido no generate).
// Funções puras — sem DB.
// ============================================================
'use strict';

const { generateKumiteBracket, advanceWinner } = require('../src/services/karateBracket');

const ath = (n) => Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}` }));
const champion = (st) => st.rounds[st.rounds.length - 1][0].winnerId;

describe('avanço manual não cascateia por lados pendentes', () => {
  it('16 atletas: uma oitava + uma quartas lançadas NÃO decidem semi nem final', () => {
    let st = generateKumiteBracket(ath(16), { method: 'ranking' });
    st = advanceWinner(st, 'r0-0', st.rounds[0][0].akaId);
    st = advanceWinner(st, 'r0-1', st.rounds[0][1].akaId);
    st = advanceWinner(st, 'r1-0', st.rounds[1][0].akaId);

    expect(st.rounds[1][0].winnerId).not.toBeNull();   // a quartas lançada
    expect(st.rounds[2][0].akaId).not.toBeNull();      // vencedor ENTROU na semi...
    expect(st.rounds[2][0].winnerId).toBeNull();       // ...mas a semi NÃO foi decidida
    expect(champion(st)).toBeNull();                   // e não há campeão fantasma
  });

  it('4 atletas sem bye: uma semi lançada não decide a final', () => {
    let st = generateKumiteBracket(ath(4), { method: 'ranking' });
    st = advanceWinner(st, 'r0-0', st.rounds[0][0].akaId);
    expect(st.rounds[1][0].akaId).toBe(st.rounds[0][0].winnerId);
    expect(champion(st)).toBeNull();
  });

  it('3 atletas: o bye REAL avança na rodada 0, mas quem ganhou o bye não vira campeão sozinho', () => {
    let st = generateKumiteBracket(ath(3), { method: 'ranking' });
    const byeMatch = st.rounds[0].find((m) => m.isBye);
    const realMatch = st.rounds[0].find((m) => !m.isBye);
    expect(byeMatch.winnerId).not.toBeNull();          // bye da rodada 0 segue automático
    expect(champion(st)).toBeNull();                   // final aguarda a luta real

    st = advanceWinner(st, realMatch.id, realMatch.akaId);
    expect(champion(st)).toBeNull();                   // final montada, ainda sem vencedor

    const final = st.rounds[1][0];
    st = advanceWinner(st, final.id, final.akaId);
    expect(champion(st)).toBe(final.akaId);            // só a decisão da final coroa
  });
});
