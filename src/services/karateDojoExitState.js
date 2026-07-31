// ============================================================
// AURA DOJÔ — F7.4: "O DOJÔ SAIU?" (leitura ÚNICA, sem ir ao banco)
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
// ── O QUE EU ENCONTREI NO CÓDIGO (auditado em 30/07/2026) ───
// Não presumi nenhum destes estados — cada um saiu de leitura:
//
//  (a) ASSINATURA CANCELADA / INADIMPLENTE — companies.billing_status +
//      companies.trial_ends_at + companies.is_staff + env DOJO_GATE_ENABLED.
//      Fonte: src/routes/billing.js, função karateDojoGate() (o gate de
//      R$140/mês do plano Aura Dojô) e src/services/dojoSaasCheckout.js, que
//      é quem ESCREVE billing_status ('active' | 'pending') + billing_cycle +
//      next_billing_date. O webhook Asaas (src/routes/webhookAsaas.js) mexe
//      no mesmo billing_status. A regra do gate, copiada literalmente:
//        required = gateLigado && !is_staff && (overdue || (!active && !trialAtivo))
//      DECISÃO: a devolução por COBRANÇA usa a MESMA condição, inclusive a
//      flag DOJO_GATE_ENABLED. Motivo (importante): com a flag DESLIGADA — que
//      é o estado de produção hoje — o dojô inadimplente CONTINUA usando o
//      Aura normalmente. Ele não saiu de lugar nenhum; devolver a gestão da
//      ficha nesse caso quebraria o sync (F7.2) de um cliente vivo por causa
//      de um boleto. "Saiu por cobrança" = "a cobrança realmente o expulsou".
//      Se a flag e o billing divergissem, teríamos DOIS conceitos de dojô
//      pagante — a mesma família de bug de vertical × vertical_active.
//
//  (b) VERTICAL DESLIGADA — companies.vertical × companies.vertical_active.
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
//  (c) COMPANY INATIVADA — companies.is_active = false.
//      Fonte: src/routes/karateDojos.js, PATCH /:dojoId → cascadeInactivateDojo()
//      (que já desativa os praticantes do dojô em cascata e registra
//      'inactivate_cascade' em karate_dojo_roster_events). É o "Suspender" da UI.
//      DECISÃO: é saída. O dojô suspenso não escreve mais nada — manter a
//      ficha marcada como gerida por ele é exatamente o buraco da premissa 2.
//      A reativação (PATCH is_active=true) NÃO reata a adoção sozinha: o
//      sensei re-federa o aluno pela conferência da F7.1 (mostrar → perguntar
//      → gravar), que é o caminho seguro. Nada é apagado no meio.
//
//  (d) COMPANY APAGADA — DELETE /federation/:id/dojos/:dojoId
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
//  (e) DESCONECTADO DA FEDERAÇÃO — companies.karate_dojo_linked_at IS NULL.
//      Fonte: src/services/karateDojoLinkStatus.js (modelo da migration 251:
//      "NULL = dojô self-serve AINDA NÃO conectado; NOT NULL = conectado") e
//      src/routes/karateDojoConnection.js (o ACEITE da federação é o que seta
//      linked_at; companies.federation_id é vínculo TÉCNICO, não conexão).
//      DECISÃO: TAMBÉM é saída — e esta foi a decisão mais difícil do PR, então
//      vai com o argumento inteiro:
//        • A adoção é uma AUTORIZAÇÃO FEDERATIVA, não um dado do dojô. Quem a
//          concede é a federação. E a rota que concede
//          (POST /dojo/students/:sid/federate, karateDojoStudents.js) RECUSA
//          com 409 DOJO_NAO_CONECTADO quando linked_at é NULL. Manter em pé uma
//          autorização que HOJE não poderia ser concedida é incoerente.
//        • O dojô desconectado é INVISÍVEL para a federação: todas as listagens
//          (karateDojos.js, karateFederation.js dashboard/search,
//          karateNetworkHealth) filtram `karate_dojo_linked_at IS NOT NULL`.
//          Sem esta regra, a federação ficaria bloqueada de editar a ficha por
//          um dono que ela não consegue nem enxergar para pedir a correção — o
//          oposto exato da premissa 2.
//        • O CONTRA-ARGUMENTO (registrado de propósito): desconectar da
//          federação NÃO é sair do Aura — o dojô desconectado continua com o
//          shell interno 100% funcional (alunos, turmas, presença,
//          mensalidades), como diz o cabeçalho de karateDojoLinkStatus.js. Ele
//          pode continuar editando aquele aluno todo dia.
//        • POR QUE O CONTRA-ARGUMENTO NÃO GANHA: a devolução NÃO toca o aluno
//          do dojô. karate_dojo_students continua intacto, com practitioner_id
//          e tudo mais; o dojô continua editando a ficha DELE. O que para é a
//          escrita por cima do cadastro DA FEDERAÇÃO — que é justamente o que a
//          federação deixou de autorizar ao desconectar. E o caminho de volta
//          existe e é o certo: reconectar + re-federar passa pela conferência
//          campo a campo da F7.1. Nada é apagado, nada some.
//
// ── O QUE **NÃO** É SAÍDA ───────────────────────────────────
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
const EXIT_REASONS = Object.freeze({
  COMPANY_MISSING: 'company_missing',
  COMPANY_INACTIVE: 'company_inactive',
  VERTICAL_OFF: 'vertical_off',
  UNLINKED_FROM_FEDERATION: 'unlinked_from_federation',
  BILLING_BLOCKED: 'billing_blocked',
});

// Frase curta, em português, para a resposta da API e para a trilha. Quem lê
// isso é o staff da federação — nada de nome de coluna.
const EXIT_LABELS = Object.freeze({
  [EXIT_REASONS.COMPANY_MISSING]: 'o cadastro do dojô não existe mais',
  [EXIT_REASONS.COMPANY_INACTIVE]: 'o dojô está inativado',
  [EXIT_REASONS.VERTICAL_OFF]: 'o dojô está com o módulo Aura Dojô desligado',
  [EXIT_REASONS.UNLINKED_FROM_FEDERATION]: 'o dojô não está conectado à federação',
  [EXIT_REASONS.BILLING_BLOCKED]: 'a assinatura do dojô está cancelada ou vencida',
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
const DOJO_STATE_FIELDS = Object.freeze([
  { col: 'id', key: 'company_id' },
  { col: 'is_active', key: 'is_active' },
  { col: 'vertical', key: 'vertical' },
  { col: 'vertical_active', key: 'vertical_active' },
  { col: 'billing_status', key: 'billing_status' },
  { col: 'trial_ends_at', key: 'trial_ends_at' },
  { col: 'is_staff', key: 'is_staff' },
  { col: 'karate_dojo_linked_at', key: 'linked_at' },
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

// ── Cobrança: a MESMA condição de karateDojoGate (billing.js) ──
// Duplicada aqui de propósito e com o motivo escrito: billing.js tem ~42KB e
// carrega o checkout do VAREJO inteiro; um PR de identidade não tem por que
// reescrever aquele arquivo. O que impede a divergência silenciosa é o teste
// tests/unit/karateDojoExitState.test.js, que fixa a tabela-verdade dos MESMOS
// quatro casos do tests/integration/karateDojoGate.test.js. Unificar as duas
// (extrair o predicado para cá e fazer billing.js importar) é F8 — está no
// corpo do PR.
function dojoGateEnabled() {
  const v = String(process.env.DOJO_GATE_ENABLED || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

function isDojoBillingBlocked(state) {
  if (!state || !state.loaded) return false;
  if (!dojoGateEnabled()) return false;      // gate desligado = ninguém é expulso
  if (state.is_staff === true) return false; // conta interna @getaura nunca é gated
  const now = new Date();
  const trialActive = state.trial_ends_at && new Date(state.trial_ends_at) > now;
  const active = state.billing_status === 'active';
  const overdue = state.billing_status === 'overdue';
  return overdue || (!active && !trialActive);
}

// ── A pergunta ──────────────────────────────────────────────
// evaluateDojoExit(state) → { known, exited, reason, label }
// A ordem das perguntas é a ordem da CONVERSA com o operador: o motivo mais
// definitivo primeiro (não existe > inativado > desligado > desconectado >
// cobrança), para a mensagem dizer a causa raiz e não um sintoma.
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
  if (state.linked_at === null || state.linked_at === undefined) {
    return exit(EXIT_REASONS.UNLINKED_FROM_FEDERATION);
  }
  if (isDojoBillingBlocked(state)) {
    return exit(EXIT_REASONS.BILLING_BLOCKED);
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
  dojoGateEnabled,
  isDojoBillingBlocked,
  evaluateDojoExit,
  evaluateDojoExitFromRow,
  describeExit,
};
