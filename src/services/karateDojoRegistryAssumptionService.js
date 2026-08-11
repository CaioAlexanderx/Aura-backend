// ============================================================
// AURA DOJÔ — F11: O DOJÔ **ASSUME** O REGISTRO FEDERATIVO
//
// ── O DESENHO, QUE É CONTRAINTUITIVO ────────────────────────
// A FPKT tem 105 dojôs cadastrados como `companies`. Isso NÃO é uma base de
// clientes: é o REGISTRO FEDERATIVO. 104 desses 105 não têm nenhum usuário —
// o owner deles é um user-sistema COMPARTILHADO (password_hash
// '!locked-system-no-login', ver isSystemOwner em karateDojoClaimService).
// Cada um desses registros carrega o que a federação já tem no lugar certo:
// a vertical, o federation_id, o código FPKT, a data de filiação e os
// PRATICANTES (customers.dojo_id — 9.840 no total).
//
// Quando um sensei vira cliente, ele NÃO cai nesse registro: ele cria uma
// conta nova pelo Sign Up (uma company vazia, dele) e só depois pede vínculo
// à federação. No ACEITE, a federação aponta QUAL dos 105 registros é aquele
// dojô — e a conta do sensei PASSA A SER aquela linha.
//
// ── A ECONOMIA DO DESENHO (leia isto antes de "melhorar") ───
// Move-se o **USUÁRIO** para a company do registro. NÃO se movem os 9.840
// praticantes para a conta nova. Uma linha em vez de dez mil, e o resultado
// é melhor: a company do registro já está certa (vertical, federação, número
// FPKT, praticantes). A conta nova é que é a peça descartável.
//
// ⚠️ POR ISSO ESTE ARQUIVO **NUNCA** ESCREVE EM `customers`.
// Não é economia de código, é regra:
//   • os praticantes JÁ apontam para a company do registro — mover seria
//     desfazer o que já está certo;
//   • `customers.dojo_id` está em FEDERATION_OWNED_COLS e existe um
//     assertIdentityFieldsAreSafe() que DERRUBA O BOOT se essa coluna entrar
//     no caminho de sync (karateIdentitySync / karateIdentityWriteGuard).
// Se algum dia alguém precisar mexer em customers.dojo_id, não é aqui.
//
// ── AUSÊNCIA DE DADO NÃO É PERMISSÃO (a assimetria alvo × requester) ──
// O predicado "este owner é o user-sistema?" aparece nos DOIS lados deste
// fluxo, e ele NÃO significa a mesma coisa nos dois:
//
//   • no REQUESTER a pergunta serve para RECUSAR ("a conta que pediu é ela
//     própria um registro? então não há sensei para mover"). Um predicado
//     permissivo aí é FAIL-CLOSED: no máximo recusa um aceite legítimo, e
//     alguém reclama. Inofensivo — e por isso continua usando
//     isSystemOwnerHash, herdado de isSystemOwner (karateDojoClaimService),
//     onde `!hash` (LEFT JOIN sem match) é defensivo e está documentado;
//
//   • no ALVO a MESMA pergunta serve para PERMITIR ("este registro ainda não
//     tem usuário? então pode ser assumido"). Aí o permissivo é FAIL-OPEN:
//     um registro cujo `owner_id` apontasse para um usuário que não existe
//     mais seria lido como "sem dono" e poderia ser assumido por OUTRA
//     PESSOA — levando junto os praticantes e a anuidade daquele dojô.
//
// Por isso o ALVO exige igualdade ESTRITA com LOCKED_SYSTEM_PASSWORD
// (isLockedSystemHash) e trata owner_id nulo, usuário inexistente e hash
// vazio como TARGET_OWNER_INCONSISTENT — bloqueia, sempre.
// ⚠️ Isto NÃO é motivo para "consertar" karateDojoClaimService: lá o
// permissivo é intencional, documentado e serve a outro fluxo (o claim, que
// só fecha quando alguém prova posse do e-mail do convite).
//
// ── O QUE ESTE SERVIÇO FAZ, NA TRANSAÇÃO DE QUEM O CHAMA ────
//   1. o usuário dono da company que PEDIU vira OWNER da company do
//      REGISTRO (companies.owner_id + linha 'owner' ativa em
//      company_members);
//   2. o que o sensei já tiver cadastrado na conta nova (alunos, turmas,
//      tags, cobranças, presenças, exames…) é MIGRADO para o registro —
//      trabalho dele não pode sumir. Migrar aqui é REAPONTAR `dojo_id`:
//      uma linha de UPDATE por tabela, e os filhos ancorados em
//      student_id/class_id vão junto sem tocar em nada;
//   3. a company que pediu é DESCARTADA — e "descartar" aqui é
//      `is_active = false`, NUNCA DELETE (ver DESATIVAR × APAGAR abaixo).
//
// ── DESATIVAR × APAGAR (decisão explícita) ──────────────────
// `karate_annuities.dojo_id` **NÃO TEM FK**. Uma varredura por chave
// estrangeira não encontra essa dependência: apagar uma company deixa as
// anuidades órfãs EM SILÊNCIO, sem erro, sem log, sem nada. Some o registro
// e sobra a cobrança apontando para o vazio. Por isso a escolha aqui é
// DESATIVAR (`companies.is_active = false`) e nunca `DELETE FROM companies`.
// Bônus: `is_active = false` é exatamente o filtro que resolveDefaultContext
// e /auth/me já aplicam (`AND c.is_active = true`), então a conta descartada
// simplesmente para de existir para o sensei no próximo login/refresh — sem
// precisar mexer na linha de company_members dela.
//
// ── O USER-SISTEMA É INTOCÁVEL ──────────────────────────────
// O owner atual dos 105 registros é O MESMO usuário. Este serviço troca o
// `companies.owner_id` da company APONTADA e mais nada: não apaga o
// user-sistema, não altera a senha dele, não mexe em membership dele e não
// encosta nas outras 104 companies. Mesma regra que completeClaim já segue.
//
// ── TRANSAÇÃO / tx-poison ───────────────────────────────────
// Todo passo tolerante a schema roda dentro de SAVEPOINT (safeStep). NUNCA
// um try/catch nu dentro do BEGIN: 42P01/42703 voltam por ROLLBACK TO
// SAVEPOINT e o passo degrada; qualquer outro erro sobe e a transação
// inteira é abortada por quem abriu o BEGIN. 23505 numa migração de dados
// (CPF de aluno repetido, nome de tag repetido) vira um 409 legível — nunca
// um "número de filiação em uso" enganoso.
// ============================================================
'use strict';

const { LOCKED_SYSTEM_PASSWORD } = require('./karateDojoClaimService');

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function httpError(status, code, message, extra) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.isServiceError = true;
  if (extra) Object.assign(err, extra);
  return err;
}

// ── AS TABELAS QUE MIGRAM ───────────────────────────────────
// Só o TRABALHO DO SENSEI na conta nova. Todas escopadas por `dojo_id`
// apontando para uma company — migrar é reapontar essa coluna.
//
// Os FILHOS não aparecem aqui de propósito: karate_dojo_student_tags é
// ancorado em student_id, não em dojo_id, então vai junto com o aluno sem
// UPDATE nenhum. Mesma coisa para tudo que pendura em class_id/exam_id/
// event_id dentro das tabelas abaixo.
const MOVE_TABLES = Object.freeze([
  'karate_dojo_guardians',             // responsáveis (família)
  'karate_dojo_students',              // alunos do dojô (F2)
  'karate_dojo_classes',               // turmas (F4)
  'karate_dojo_class_enrollments',     // matrículas turma↔aluno
  'karate_dojo_attendance',            // presenças
  'karate_dojo_tags',                  // tags configuráveis (migration 274)
  'karate_dojo_billing_plans',         // planos de mensalidade (F3)
  'karate_dojo_subscriptions',         // assinaturas do aluno
  'karate_dojo_charges',               // cobranças
  'karate_dojo_reminder_log',          // régua de lembretes já disparada
  'karate_dojo_belt_exams',            // exames de faixa do dojô (F9)
  'karate_dojo_belt_exam_results',     // resultados dos exames
  'karate_dojo_events',                // eventos do dojô (F10)
  'karate_dojo_event_enrollments',     // inscrições nos eventos
  'karate_dojo_certificate_templates', // modelos de certificado do dojô
  'karate_dojo_issued_certificates',   // certificados já emitidos
]);

// Tabelas de UMA LINHA POR DOJÔ (dojo_id é PK ou UNIQUE). Reapontar sem
// olhar estouraria 23505 quando o registro já tem a linha dele. Regra: a
// configuração que JÁ EXISTE no registro federativo VENCE — ela é do dojô
// "de verdade"; a da conta nova é de dias de uso. O que não migra é
// declarado na trilha como `kept_at_source`, não sumido em silêncio.
const SINGLE_ROW_TABLES = Object.freeze([
  'karate_dojo_class_settings',  // toggle de check-in por QR (PK dojo_id)
  'karate_dojo_reminder_config', // config da régua (PK dojo_id)
  'karate_dojo_baas_accounts',   // subconta de recebimento (UNIQUE dojo_id)
]);

// O QUE **NÃO** MIGRA, e por quê — declarado para ninguém "esquecer" de
// incluir depois sem ler o motivo:
//   customers ................ PROIBIDO. É a federação, os praticantes já
//                              estão no registro e dojo_id é FEDERATION_OWNED.
//   karate_annuities / karate_dojo_annuity_history
//                              anuidade é da federação sobre o REGISTRO; a
//                              conta nova nunca teve uma.
//   karate_membership_cards, karate_practitioner_requests, karate_sync_*,
//   karate_identity_audit, karate_certificate_orders, karate_attendance,
//   karate_event_enrollments, karate_competition_entries,
//   karate_finance_audit_log, karate_dojo_roster_events/validation
//                              tudo federativo: só existe para dojô filiado,
//                              e a conta nova nunca foi filiada.
//   karate_dojo_portal_links / karate_dojo_portal_otps /
//   karate_dojo_owner_invites
//                              são CREDENCIAIS emitidas pela federação para o
//                              registro (link de portal, OTP, convite de
//                              claim). Não são trabalho do sensei e não se
//                              carregam de uma conta para outra — expiram.
//   karate_dojo_connections .. trilho antigo (Track F), sem uso no self-serve.

// Nome de tabela entra em template string (não dá para parametrizar
// identificador em pg). A lista é constante do módulo, mas a checagem é de
// graça e trava um typo/injeção futura logo no boot.
(function assertTableNamesAreSafe() {
  const bad = MOVE_TABLES.concat(SINGLE_ROW_TABLES).filter((t) => !/^[a-z][a-z0-9_]*$/.test(t));
  if (bad.length) {
    throw new Error(
      `[karateDojoRegistryAssumptionService] nome de tabela inválido na lista de migração: ${bad.join(', ')}`
    );
  }
})();

// Espelha safeRosterWrite/safeStep de karateAffiliationRequestService: passo
// tolerante a SCHEMA (42P01/42703) dentro de SAVEPOINT. Qualquer outro erro
// volta ao savepoint e SOBE — quem chamou decide (e a transação inteira cai).
// Nunca um try/catch nu dentro do BEGIN (armadilha tx-poison).
async function safeStep(client, label, fn) {
  await client.query('SAVEPOINT sp_registry_assumption');
  try {
    const out = await fn();
    await client.query('RELEASE SAVEPOINT sp_registry_assumption');
    return out;
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT sp_registry_assumption');
    if (e && (e.code === '42P01' || e.code === '42703')) {
      console.warn(`[karateDojoRegistryAssumption] passo ignorado (schema pendente): ${label}`);
      return null;
    }
    throw e;
  }
}

function asUuid(v) {
  return v && UUID_RE.test(String(v)) ? String(v) : null;
}

// ⚠️ USO EXCLUSIVO DO **REQUESTER**. Copiado de isSystemOwner
// (karateDojoClaimService): `!hash` trata "usuário inexistente" como
// user-sistema. Do lado do requester isso é FAIL-CLOSED (o predicado RECUSA
// o aceite), e portanto inofensivo. Do lado do ALVO seria FAIL-OPEN — ver o
// bloco "AUSÊNCIA DE DADO NÃO É PERMISSÃO" no cabeçalho e use
// isLockedSystemHash.
function isSystemOwnerHash(hash) {
  return !hash || hash === LOCKED_SYSTEM_PASSWORD;
}

// ⚠️ USO DO **ALVO**: igualdade ESTRITA, sem nenhuma tolerância a ausência.
// É este predicado — e só ele — que autoriza uma company com praticantes e
// anuidade a mudar de dono. Ausência de dado aqui é estado inesperado, não
// permissão.
function isLockedSystemHash(hash) {
  return hash === LOCKED_SYSTEM_PASSWORD;
}

// ── LEITURA + VALIDAÇÃO DO REGISTRO APONTADO ────────────────
// As três perguntas do aceite, nesta ordem:
//   1. esse registro é DESTA federação?      (senão 404 — não vaza existência)
//   2. é um dojô mesmo?                      (vertical = 'karate_dojo')
//   3. ele AINDA NÃO TEM USUÁRIO?            (senão seria roubar a conta de
//                                             alguém — 409, sempre)
// A 3 é a que protege gente, e "ainda não tem usuário" tem definição
// ESTRITA: o owner é O USER-SISTEMA (password_hash exatamente
// '!locked-system-no-login') E não há nenhum membro ativo que seja usuário
// real. Qualquer outro estado do owner BLOQUEIA:
//   • owner_id nulo ............... 409 TARGET_OWNER_INCONSISTENT
//   • owner_id → usuário que não existe mais (LEFT JOIN sem match)
//                                   409 TARGET_OWNER_INCONSISTENT
//   • usuário existe mas sem senha  409 TARGET_OWNER_INCONSISTENT
//   • usuário REAL ................ 409 TARGET_ALREADY_CLAIMED
// Os dois códigos são diferentes de propósito, porque a ação humana é
// diferente: "já reclamado" = aponte OUTRO registro; "inconsistente" =
// ninguém reclamou nada, ESTE registro está quebrado e precisa ser corrigido
// na federação antes de qualquer aprovação.
async function loadAndValidateTarget(client, { federationId, targetCompanyId }) {
  const t = await client.query(
    `/* assumption:target-lock */
     SELECT id, owner_id, vertical, federation_id, is_active,
            COALESCE(trade_name, legal_name) AS company_name,
            karate_dojo_linked_at, fpkt_affiliation_id
       FROM companies
      WHERE id = $1
      FOR UPDATE`,
    [targetCompanyId]
  );
  const target = (t && t.rows && t.rows[0]) || null;

  // Fora da federação = inexistente. Um 403 aqui contaria para o staff de
  // uma federação que o registro de outra existe.
  if (!target || String(target.federation_id || '') !== String(federationId)) {
    throw httpError(
      404,
      'TARGET_NOT_FOUND',
      'Registro federativo não encontrado nesta federação. Aponte um dojô já cadastrado por ela.'
    );
  }
  if (target.vertical !== 'karate_dojo') {
    throw httpError(
      422,
      'TARGET_NOT_DOJO',
      'A empresa apontada não é um registro de dojô (vertical karate_dojo).'
    );
  }
  if (target.is_active === false) {
    throw httpError(
      409,
      'TARGET_INACTIVE',
      'O registro apontado está desativado. Reative-o na federação antes de vinculá-lo a um sensei.'
    );
  }

  // "ainda não tem usuário", parte 1: o owner é O USER-SISTEMA compartilhado?
  // `companies.owner_id` é NOT NULL na base — um nulo aqui não é "registro
  // livre", é estado inesperado, e estado inesperado NÃO abre porta.
  if (!target.owner_id) {
    throw httpError(
      409,
      'TARGET_OWNER_INCONSISTENT',
      'O registro apontado está sem dono (owner_id nulo) — isso não é o usuário de sistema, é um estado ' +
      'inesperado. Corrija o registro na federação antes de vinculá-lo a um sensei.'
    );
  }

  const ow = await client.query(
    `/* assumption:target-owner */
     SELECT id, password_hash FROM users WHERE id = $1 LIMIT 1`,
    [target.owner_id]
  );
  const ownerRow = (ow && ow.rows && ow.rows[0]) || null;

  // ⚠️ AQUI ESTAVA A BRECHA: com o predicado permissivo (`!hash`), um owner
  // que não existe mais na tabela users passava por "sem dono" e o registro
  // podia ser assumido por outra pessoa — com os praticantes e a anuidade
  // dele junto. Ausência de linha é INCONSISTÊNCIA, nunca permissão.
  if (!ownerRow) {
    throw httpError(
      409,
      'TARGET_OWNER_INCONSISTENT',
      'O registro apontado tem um dono que não existe mais (o usuário foi removido). Corrija o registro na ' +
      'federação antes de vinculá-lo a um sensei.'
    );
  }
  if (!ownerRow.password_hash) {
    throw httpError(
      409,
      'TARGET_OWNER_INCONSISTENT',
      'O dono do registro apontado não é o usuário de sistema e está sem senha definida. Corrija o registro ' +
      'na federação antes de vinculá-lo a um sensei.'
    );
  }
  if (!isLockedSystemHash(ownerRow.password_hash)) {
    throw httpError(
      409,
      'TARGET_ALREADY_CLAIMED',
      'Este registro já tem um responsável com conta própria. Aponte outro registro ou trate a duplicidade antes de aprovar.'
    );
  }

  // "ainda não tem usuário", parte 2: ninguém REAL como membro ativo. O
  // user-sistema não conta (senha travada) — ele é dos 105 e fica onde está.
  const m = await client.query(
    `/* assumption:target-members */
     SELECT COUNT(*)::int AS real_members
       FROM company_members cm
       JOIN users u ON u.id = cm.user_id
      WHERE cm.company_id = $1
        AND COALESCE(cm.is_active, true) = true
        AND COALESCE(u.password_hash, '') <> $2`,
    [target.id, LOCKED_SYSTEM_PASSWORD]
  );
  const realMembers = m && m.rows && m.rows[0] ? Number(m.rows[0].real_members) : 0;
  if (realMembers > 0) {
    throw httpError(
      409,
      'TARGET_ALREADY_CLAIMED',
      'Este registro já tem usuário com acesso. Aponte outro registro ou trate a duplicidade antes de aprovar.'
    );
  }

  return target;
}

// ── LEITURA + VALIDAÇÃO DA CONTA QUE PEDIU ──────────────────
// Ela precisa ter um usuário REAL — é ele que vai ser movido. Uma conta
// cujo owner é o user-sistema não é conta de sensei nenhum: é outro
// registro, e mover um registro para dentro de outro não é este fluxo.
//
// Aqui o predicado permissivo (isSystemOwnerHash) FICA: do lado do
// requester, "não achei o usuário" leva a RECUSAR o aceite — fail-closed.
// É exatamente o oposto do que acontece no alvo (ver o cabeçalho).
async function loadAndValidateRequester(client, { requesterCompanyId }) {
  const r = await client.query(
    `/* assumption:requester-lock */
     SELECT id, owner_id, vertical, federation_id, is_active,
            COALESCE(trade_name, legal_name) AS company_name
       FROM companies
      WHERE id = $1
      FOR UPDATE`,
    [requesterCompanyId]
  );
  const requester = (r && r.rows && r.rows[0]) || null;
  if (!requester) {
    throw httpError(404, 'DOJO_NOT_FOUND', 'A empresa que solicitou a filiação não existe mais.');
  }
  if (!requester.owner_id) {
    throw httpError(
      422,
      'REQUESTER_WITHOUT_OWNER',
      'A conta que pediu a filiação não tem dono — não há usuário para assumir o registro.'
    );
  }

  const ow = await client.query(
    `/* assumption:requester-owner */
     SELECT id, password_hash FROM users WHERE id = $1 LIMIT 1`,
    [requester.owner_id]
  );
  const ownerRow = (ow && ow.rows && ow.rows[0]) || null;
  if (isSystemOwnerHash(ownerRow && ownerRow.password_hash)) {
    throw httpError(
      422,
      'REQUESTER_IS_SYSTEM_OWNED',
      'A conta que pediu a filiação pertence ao usuário de sistema (é ela própria um registro). Não há sensei para assumir o registro apontado.'
    );
  }

  return requester;
}

// ── MIGRAÇÃO DO TRABALHO DO SENSEI ──────────────────────────
// "Vazia" tem definição operacional, não filosófica: ZERO linha em TODAS as
// tabelas de MOVE_TABLES + SINGLE_ROW_TABLES escopadas naquela company. Se
// alguma tem linha, a conta não estava vazia e o que havia foi migrado.
// Tabela ausente (migração pendente) conta como 0 e vira `schema_pending` na
// trilha — ausência de tabela não é ausência de dado, e essa diferença fica
// escrita.
async function moveDojoWorkload(client, { fromCompanyId, toCompanyId }) {
  const moved = {};
  const keptAtSource = {};
  const schemaPending = [];
  let total = 0;

  for (const table of MOVE_TABLES) {
    let res;
    try {
      res = await safeStep(client, `mover ${table}`, () => client.query(
        `/* assumption:move ${table} */
         UPDATE ${table} SET dojo_id = $2 WHERE dojo_id = $1`,
        [fromCompanyId, toCompanyId]
      ));
    } catch (e) {
      // Colisão de unicidade dentro do ESCOPO do dojô (CPF de aluno repetido,
      // nome de tag repetido…). Precisa de um erro próprio: cair no 23505
      // genérico de approveRequest devolveria "número de filiação em uso",
      // que não tem nada a ver e mandaria a federação procurar no lugar errado.
      if (e && e.code === '23505') {
        throw httpError(
          409,
          'MIGRACAO_COLIDIU',
          `Não foi possível migrar os dados de ${table}: já existe registro equivalente no registro federativo apontado. ` +
          'Nada foi alterado. Resolva a duplicidade e aprove novamente.',
          { table, constraint: e.constraint || null }
        );
      }
      throw e;
    }
    if (res === null) {
      schemaPending.push(table);
      moved[table] = 0;
    } else {
      moved[table] = res.rowCount || 0;
      total += moved[table];
    }
  }

  for (const table of SINGLE_ROW_TABLES) {
    const had = await safeStep(client, `contar ${table}`, () => client.query(
      `/* assumption:single-count ${table} */
       SELECT COUNT(*)::int AS n FROM ${table} WHERE dojo_id = $1`,
      [fromCompanyId]
    ));
    if (had === null) {
      schemaPending.push(table);
      moved[table] = 0;
      continue;
    }
    const hadN = had.rows && had.rows[0] ? Number(had.rows[0].n) : 0;

    // NOT EXISTS contra a MESMA tabela: a subconsulta enxerga o estado antes
    // do UPDATE, então "o registro já tem a linha dele" é avaliado uma vez e
    // sem corrida (a company alvo está travada por FOR UPDATE mais acima).
    // Alias `x` obrigatório — sem qualificar, `dojo_id` no RHS é ambíguo
    // (42702, armadilha UPDATE…FROM deste repo).
    const upd = await safeStep(client, `mover ${table}`, () => client.query(
      `/* assumption:single ${table} */
       UPDATE ${table} SET dojo_id = $2
        WHERE dojo_id = $1
          AND NOT EXISTS (SELECT 1 FROM ${table} x WHERE x.dojo_id = $2)`,
      [fromCompanyId, toCompanyId]
    ));
    const movedN = upd ? (upd.rowCount || 0) : 0;
    moved[table] = movedN;
    total += hadN; // teve linha = a conta NÃO estava vazia, migrando ou não
    if (hadN > movedN) keptAtSource[table] = hadN - movedN;
  }

  return {
    moved,
    kept_at_source: keptAtSource,
    schema_pending: schemaPending,
    total_rows: total,
    was_empty: total === 0,
  };
}

// ── A ASSUNÇÃO ──────────────────────────────────────────────
// Roda DENTRO da transação de quem chamou (approveRequest). Não abre BEGIN,
// não dá COMMIT, não dá ROLLBACK: ou o aceite inteiro acontece, ou nada.
//
// IDEMPOTÊNCIA — três camadas, nesta ordem:
//   1. o pedido é travado com FOR UPDATE e só prossegue se status='pending'
//      (approveRequest). Reexecutar devolve 409 JA_RESOLVIDA e não chega aqui;
//   2. company_members entra por ON CONFLICT (company_id, user_id) DO UPDATE —
//      rodar duas vezes não duplica linha, no máximo reafirma 'owner';
//   3. a trilha entra por ON CONFLICT (request_id) DO NOTHING — um pedido,
//      no máximo uma assunção registrada.
async function assumeRegistry(client, {
  federationId,
  requesterCompanyId,
  targetCompanyId,
} = {}) {
  const target = await loadAndValidateTarget(client, { federationId, targetCompanyId });
  const requester = await loadAndValidateRequester(client, { requesterCompanyId });
  const senseiUserId = requester.owner_id;

  // (1) O USUÁRIO SE MOVE — uma linha, não dez mil.
  const own = await client.query(
    `/* assumption:owner-transfer */
     UPDATE companies
        SET owner_id = $1, updated_at = NOW()
      WHERE id = $2 AND federation_id = $3 AND vertical = 'karate_dojo'
    RETURNING id, owner_id`,
    [senseiUserId, target.id, federationId]
  );
  if (!own.rows || !own.rows.length) {
    // Só chega aqui se algo mudou entre o FOR UPDATE e agora — melhor um 404
    // honesto que um COMMIT pela metade.
    throw httpError(404, 'TARGET_NOT_FOUND', 'Registro federativo não encontrado nesta federação.');
  }

  // (2) …e ganha a linha de membro 'owner', igual ao cadastro normal
  // (auth.js/register) e ao claim (completeClaim). resolveDefaultContext usa
  // owner_id OR company_members — a redundância é intencional e antiga.
  await client.query(
    `/* assumption:member-owner */
     INSERT INTO company_members (company_id, user_id, role_label, status, is_active)
     VALUES ($1, $2, 'owner', 'active', true)
     ON CONFLICT (company_id, user_id)
     DO UPDATE SET role_label = 'owner', status = 'active', is_active = true`,
    [target.id, senseiUserId]
  );

  // (3) O TRABALHO DELE VAI JUNTO (se houver).
  const workload = await moveDojoWorkload(client, {
    fromCompanyId: requester.id,
    toCompanyId: target.id,
  });

  // (4) A conta do cadastro é DESCARTADA = desativada. `id <> $2` é paranoia
  // barata: nenhuma circunstância pode desativar o registro federativo.
  const off = await client.query(
    `/* assumption:discard */
     UPDATE companies
        SET is_active = false, updated_at = NOW()
      WHERE id = $1 AND id <> $2
    RETURNING id`,
    [requester.id, target.id]
  );
  const discarded = !!(off.rows && off.rows.length);

  return {
    assumed: true,
    from_company_id: requester.id,
    from_company_name: requester.company_name || null,
    to_company_id: target.id,
    to_company_name: target.company_name || null,
    user_id: senseiUserId,
    from_company_was_empty: workload.was_empty,
    from_company_discarded: discarded,
    migrated: workload.moved,
    kept_at_source: workload.kept_at_source,
    schema_pending: workload.schema_pending,
    migrated_rows: workload.total_rows,
  };
}

// ── TRILHA ──────────────────────────────────────────────────
// DOIS destinos, de propósito:
//   • karate_dojo_roster_events — tabela da migration 220, JÁ APLICADA. É a
//     garantia de que existe rastro mesmo antes de a 275 rodar. `event` não
//     tem CHECK nessa tabela (o cabeçalho da 220/263 registra isso), então
//     'registry_assumed' cabe sem DDL;
//   • karate_dojo_registry_assumptions — a tabela enxuta da migration 275,
//     com UNIQUE(request_id). É ela que responde "de qual company para qual,
//     por quem, quando, e o que foi migrado" numa consulta só.
// As duas escritas são best-effort por SAVEPOINT: enquanto a 275 não for
// aplicada, 42P01 degrada e o aceite acontece do mesmo jeito (o rastro fica
// na 220). O que NÃO degrada é erro de verdade — esse sobe e derruba tudo.
//
// actor_id é coluna uuid: um 'staff1' de teste viraria 22P02 e derrubaria o
// aceite POR CAUSA DO LOG. Vai NULL na coluna e cru em actor_ref/payload
// (mesma decisão de revokeAffiliation e do asUuid de karateStudentIdentityLink).
async function writeAssumptionTrail(client, {
  federationId,
  requestId,
  result,
  actorId,
  fpktNumber,
}) {
  const actorUuid = asUuid(actorId);
  const payload = {
    request_id: requestId || null,
    from_company_id: result.from_company_id,
    from_company_name: result.from_company_name,
    to_company_id: result.to_company_id,
    to_company_name: result.to_company_name,
    user_id: result.user_id,
    actor_id: actorId || null,
    fpkt_affiliation_id: fpktNumber || null,
    from_company_was_empty: result.from_company_was_empty,
    from_company_discarded: result.from_company_discarded,
    migrated: result.migrated,
    kept_at_source: result.kept_at_source,
    schema_pending: result.schema_pending,
    note:
      'O sensei ASSUMIU o registro federativo: o usuário passou a ser owner da company do registro e a ' +
      'company do cadastro foi DESATIVADA (nunca apagada — karate_annuities.dojo_id não tem FK). Nenhum ' +
      'praticante foi movido: customers.dojo_id já apontava para o registro e não é tocado por este fluxo. ' +
      'O usuário de sistema compartilhado pelos registros não foi alterado nem removido.',
  };

  await safeStep(client, 'roster event registry_assumed', () => client.query(
    `/* assumption:roster-event */
     INSERT INTO karate_dojo_roster_events (dojo_id, federation_id, event, affected, actor_id)
     VALUES ($1, $2, 'registry_assumed', $3::jsonb, $4)`,
    [result.to_company_id, federationId, JSON.stringify([payload]), actorUuid]
  ));

  const ins = await safeStep(client, 'karate_dojo_registry_assumptions', () => client.query(
    `/* assumption:trail */
     INSERT INTO karate_dojo_registry_assumptions
       (request_id, federation_id, from_company_id, to_company_id, user_id,
        actor_id, actor_ref, fpkt_affiliation_id, from_company_was_empty, migrated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
     ON CONFLICT (request_id) DO NOTHING
     RETURNING id`,
    [
      requestId || null,
      federationId,
      result.from_company_id,
      result.to_company_id,
      result.user_id,
      actorUuid,
      actorId ? String(actorId) : null,
      fpktNumber || null,
      result.from_company_was_empty,
      JSON.stringify({
        migrated: result.migrated,
        kept_at_source: result.kept_at_source,
        schema_pending: result.schema_pending,
        migrated_rows: result.migrated_rows,
        from_company_discarded: result.from_company_discarded,
      }),
    ]
  ));

  return { trail_persisted: ins !== null };
}

module.exports = {
  assumeRegistry,
  writeAssumptionTrail,
  loadAndValidateTarget,
  loadAndValidateRequester,
  moveDojoWorkload,
  // exportados para teste/documentação
  MOVE_TABLES,
  SINGLE_ROW_TABLES,
  httpError,
  safeStep,
  isSystemOwnerHash,
  isLockedSystemHash,
};
