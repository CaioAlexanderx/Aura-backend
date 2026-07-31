// ============================================================
// AURA DOJÔ — F7.4: "O DOJÔ SAIU DO AURA?" (leitura ÚNICA, sem ir ao banco)
//
// AS PREMISSAS (Caio, 30/07/2026)
//   1. "A federação não faz gestão de informação. O trabalho dela é apenas
//      receber a sincronização dos dados gerenciados pelos dojôs."
//   2. "Para os dojôs NÃO VINCULADOS, ou que NÃO TÊM AURA, a federação deve
//      ter TOTAL LIBERDADE e acesso para criação, edição e remoção de dados."
//   3. "Quando o dojô sai, os dados permanecem visíveis para a federação, mas
//      sem o acesso e gestão do dojô. Ou seja, a gestão volta para a federação."
//
// A F7.1/F7.2/F7.3 entregaram 1. Este módulo é a peça que faltava para 2 e 3:
// hoje uma ficha adotada fica karate_identity_managed_by='dojo' PARA SEMPRE, e
// a federação fica impedida de editar a identidade de um praticante cujo dojô
// não usa mais o sistema. Este arquivo define, em UM lugar só, o que conta como
// "o dojô saiu".
//
// ⚠️ "SAIU" = SAIU DO AURA. NÃO É "SAIU DA FEDERAÇÃO".
// Duas correções do dono do produto (30/07/2026) recortaram este módulo:
//
//   (i)  "Sobre desconectar da federação, a única ação seria INATIVAR OS
//        PRATICANTES do dojô desfiliado na visão da federação, o resto
//        permanece igual — e somente a federação pode cancelar esse vínculo."
//        → desfiliação NÃO devolve a gestão da ficha. O dojô desfiliado
//        continua usando o Aura e continua sendo o dono da identidade dos
//        alunos DELE (premissa 1: o fluxo SOBE, e ele continua lá em cima).
//        O efeito da revogação é outro e mora em outro lugar:
//        karateAffiliationRequestService.revokeAffiliation() inativa os
//        praticantes daquele dojô (customers.is_active = false) — os dados
//        permanecem, some só a condição de filiado ativo.
//
//   (ii) "Não vamos criar gate por inadimplência. Teoricamente, se a federação
//        aceitar o vínculo, entendemos que o dojô está autorizado a se filiar."
//        → inadimplência com a Aura NÃO afeta a gestão da ficha. Não há
//        predicado de cobrança neste arquivo, nem espelho de karateDojoGate(),
//        nem leitura de DOJO_GATE_ENABLED. billing.js e este módulo não se
//        conhecem.
//
// ── O QUE EU ENCONTREI NO CÓDIGO (auditado em 30/07/2026) ───
// Não presumi nenhum destes estados — cada um saiu de leitura:
//
//  (a) VERTICAL DESLIGADA — companies.vertical × companies.vertical_active.
//      Fonte: src/routes/karateDojos.js (todas as listagens filtram
//      `c.vertical_active = 'karate_dojo'`), src/routes/karateFederation.js
//      (dashboard: "`vertical` é o marcador de identidade permanente;
//      `vertical_active` reflete se o módulo karatê segue ativo para aquele
//      dojô — é esse último que define a contagem") e src/routes/adminVertical.js.
//      DECISÃO: vertical_active <> 'karate_dojo' é saída. `vertical` sozinho
//      NÃO é: ele é a identidade permanente e nunca é desligado.
//      Defensivo: vertical_active NULL num company cujo `vertical` é
//      'karate_dojo' NÃO conta como saída — é dado faltante, não desligamento
//      ("dado faltante ≠ pendência"). Só conta quando vertical_active tem
//      valor E o valor não é 'karate_dojo'.
//
//  (b) COMPANY INATIVADA — companies.is_active = false.
//      Fonte: src/routes/karateDojos.js, PATCH /:dojoId → cascadeInactivateDojo()
//      (que já desativa os praticantes do dojô em cascata e registra
//      'inactivate_cascade' em karate_dojo_roster_events). É o "Suspender" da UI.
//      DECISÃO: é saída. O dojô suspenso não escreve mais nada — manter a
//      ficha marcada como gerida por ele é exatamente o buraco da premissa 2.
//      A reativação (PATCH is_active=true) NÃO reata a adoção sozinha: o
//      sensei re-federa o aluno pela conferência da F7.1 (mostrar → perguntar
//      → gravar), que é o caminho seguro. Nada é apagado no meio.
//
//  (c) COMPANY APAGADA — DELETE /federation/:id/dojos/:dojoId
//      (src/routes/karateDojos.js). Aqui há uma BOMBA que este PR desarma:
//      customers.karate_identity_dojo_id tem FK ON DELETE SET NULL (migration
//      262) e a mesma migration criou o CHECK customers_karate_identity_coherent
//      (`managed_by <> 'dojo' OR karate_identity_dojo_id IS NOT NULL`).
//      Apagar a company de um dojô que ainda mantém alguma ficha faz o SET NULL
//      violar o CHECK → 23514 → 500 no DELETE do dojô. A cascata de lá só apaga
//      `customers WHERE dojo_id = $1` (onde a pessoa TREINA), que é uma coluna
//      DIFERENTE de karate_identity_dojo_id (quem é DONO DA FICHA) — então
//      basta um praticante adotado que treine em outro dojô (ou em nenhum) para
//      o DELETE estourar. Por isso a devolução acontece ANTES, no interceptador
//      de src/routes/karateIdentityGovernance.js.
//
// ── O QUE **NÃO** É SAÍDA ───────────────────────────────────
//   • DESFILIAÇÃO (companies.karate_dojo_linked_at IS NULL). Correção (i)
//     acima. Sair da federação não é sair do Aura: o dojô desfiliado continua
//     com o shell interno 100% funcional (alunos, turmas, presença,
//     mensalidades — ver o cabeçalho de karateDojoLinkStatus.js) e continua
//     mantendo a identidade dos alunos dele. Quem trata a revogação é
//     services/karateAffiliationRequestService.revokeAffiliation(), e o que
//     ela faz é inativar os praticantes na visão da federação — nunca mexer
//     em karate_identity_managed_by. Por isso karate_dojo_linked_at nem entra
//     em DOJO_STATE_FIELDS: coluna que ninguém avalia não vira 42703 de
//     ninguém.
//   • INADIMPLÊNCIA / assinatura vencida. Correção (ii) acima. Não há
//     predicado de cobrança aqui. Boleto em atraso é conversa entre a Aura e
//     o dojô; não muda quem é dono da ficha do praticante.
//   • companies.federation_id apontando para outra federação — é roteamento
//     técnico e não tem nada a ver com quem mantém a ficha.
//   • Dojô sem chave PIX, sem BaaS, sem alunos, sem cobrança gerada: ausência
//     de uso não é ausência de contrato.
//   • Estado DESCONHECIDO (a linha de companies não foi lida, ou veio sem as
//     colunas). "Dado faltante ≠ pendência": sem informação, o dojô continua
//     dentro e a ficha continua dele. Ver `state.loaded` abaixo — é o que
//     impede que uma leitura parcial libere a escrita da federação por engano.
//
// ── POR QUE ESTE MÓDULO NÃO TOCA O BANCO ────────────────────
// Ele recebe a linha de `companies` que o chamador JÁ leu. Na guarda de
// escrita (karateIdentityWriteGuard) isso significa CUSTO ZERO: o OWNER_SQL de
// lá já fazia LEFT JOIN companies para dizer o NOME do dojô na recusa — agora
// o mesmo JOIN traz também o estado. Nenhuma query nova entra no caminho de
// nenhuma escrita, e o caminho das 15.488 fichas geridas pela federação
// continua exatamente como sempre foi.
// ============================================================
'use strict';

// ── Vocabulário das saídas ──────────────────────────────────
// Três, e as três são "o dojô não usa mais o Aura". Não existe saída por
// desfiliação nem por cobrança (ver as correções (i) e (ii) no cabeçalho).
const EXIT_REASONS = Object.freeze({
  COMPANY_MISSING: 'company_missing',
  COMPANY_INACTIVE: 'company_inactive',
  VERTICAL_OFF: 'vertical_off',
});

// Frase curta, em português, para a resposta da API e para a trilha. Quem lê
// isso é o staff da federação — nada de nome de coluna.
const EXIT_LABELS = Object.freeze({
  [EXIT_REASONS.COMPANY_MISSING]: 'o cadastro do dojô não existe mais',
  [EXIT_REASONS.COMPANY_INACTIVE]: 'o dojô está inativado',
  [EXIT_REASONS.VERTICAL_OFF]: 'o dojô está com o módulo Aura Dojô desligado',
});

// Estado "não sei" — o único seguro quando a linha de companies não veio.
const UNKNOWN_EXIT = Object.freeze({
  known: false,
  exited: false,
  reason: null,
  label: null,
});

const IN_AURA = Object.freeze({
  known: true,
  exited: false,
  reason: null,
  label: null,
});

// ── Colunas de companies que descrevem o estado ─────────────
// Uma lista só: quem monta SELECT usa dojoStateSelect(); quem lê a linha usa
// readDojoState(). Os identificadores saem DAQUI, nunca do corpo de nenhuma
// requisição — não há concatenação de dado do usuário em SQL neste arquivo.
//
// `vertical` não é avaliado por evaluateDojoExit — ele viaja junto para que
// quem lê o relatório consiga distinguir "dojô que nunca foi karatê" de "dojô
// de karatê com o módulo desligado" sem uma segunda query.
const DOJO_STATE_FIELDS = Object.freeze([
  { col: 'id', key: 'company_id' },
  { col: 'is_active', key: 'is_active' },
  { col: 'vertical', key: 'vertical' },
  { col: 'vertical_active', key: 'vertical_active' },
]);

const DEFAULT_PREFIX = 'identity_dojo_';

// Fragmento de SELECT para um alias de `companies`. A coluna literal
// `<prefix>state_loaded` é o que diz ao leitor "esta linha REALMENTE traz o
// estado" — sem ela, readDojoState devolve `loaded:false` e evaluateDojoExit
// devolve UNKNOWN_EXIT (nunca "saiu").
function dojoStateSelect(alias, prefix = DEFAULT_PREFIX) {
  const cols = DOJO_STATE_FIELDS.map((f) => `${alias}.${f.col} AS ${prefix}${f.key}`);
  cols.push(`TRUE AS ${prefix}state_loaded`);
  return cols.join(',\n         ');
}

// Lê a linha (de qualquer SELECT que tenha usado dojoStateSelect) e devolve o
// estado normalizado. Fora disso, loaded:false.
function readDojoState(row, prefix = DEFAULT_PREFIX) {
  const r = row || {};
  const state = { loaded: r[`${prefix}state_loaded`] === true };
  for (const f of DOJO_STATE_FIELDS) {
    state[f.key] = r[`${prefix}${f.key}`];
  }
  return state;
}

// ── A pergunta ──────────────────────────────────────────────
// evaluateDojoExit(state) → { known, exited, reason, label }
// A ordem das perguntas é a ordem da CONVERSA com o operador: o motivo mais
// definitivo primeiro (não existe > inativado > desligado), para a mensagem
// dizer a causa raiz e não um sintoma.
function evaluateDojoExit(state) {
  if (!state || !state.loaded) return UNKNOWN_EXIT;

  const exit = (reason) => ({ known: true, exited: true, reason, label: EXIT_LABELS[reason] });

  // A linha de companies não veio no LEFT JOIN → a company não existe mais.
  if (state.company_id === null || state.company_id === undefined) {
    return exit(EXIT_REASONS.COMPANY_MISSING);
  }
  if (state.is_active === false) {
    return exit(EXIT_REASONS.COMPANY_INACTIVE);
  }
  // vertical_active NULL/ausente é dado faltante, NÃO desligamento.
  if (
    state.vertical_active !== null &&
    state.vertical_active !== undefined &&
    state.vertical_active !== '' &&
    state.vertical_active !== 'karate_dojo'
  ) {
    return exit(EXIT_REASONS.VERTICAL_OFF);
  }
  return IN_AURA;
}

// Açúcar para quem tem a linha crua e não quer as duas chamadas.
function evaluateDojoExitFromRow(row, prefix = DEFAULT_PREFIX) {
  return evaluateDojoExit(readDojoState(row, prefix));
}

// Frase pronta para a resposta da API e para o campo `reason` da trilha.
function describeExit(exit, dojoName) {
  if (!exit || !exit.exited) return null;
  const who = dojoName || 'o dojô que mantinha esta ficha';
  return `A gestão da ficha voltou para a federação porque ${exit.label} (${who}).`;
}

module.exports = {
  EXIT_REASONS,
  EXIT_LABELS,
  UNKNOWN_EXIT,
  IN_AURA,
  DOJO_STATE_FIELDS,
  DEFAULT_PREFIX,
  dojoStateSelect,
  readDojoState,
  evaluateDojoExit,
  evaluateDojoExitFromRow,
  describeExit,
};
