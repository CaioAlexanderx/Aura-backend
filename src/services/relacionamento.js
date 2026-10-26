// ============================================================
// AURA. — Envio dos e-mails de relacionamento (24/10/2026)
//
// tq-80  boas-vindas (4.1): na confirmação do e-mail (routes/verification),
//        uma vez por usuário DONO de empresa.
// tq-81  ciclo do teste, numa volta diária às 10h BRT
//        (jobs/relacionamentoJob.js):
//          4.2 primeira venda que não saiu: 2 dias depois do cadastro (3 na
//              recuperação), sem nenhuma venda;
//          4.3 teste terminando: 2 dias antes do fim (1 na recuperação);
//          4.4 teste encerrado: no dia em que acabou (ou no seguinte);
//          4.5 conta guardada (tq-111): no lugar do 4.4, na mesma janela,
//              uma vez só, para a conta cuja nota mais recente é "Não quer"
//              com motivo 'motivo_externo'.
// tq-82b "faz uns dias que você não aparece": 7 dias sem acesso (8 na
//        recuperação), uma vez por período de ausência.
//
// Regra de fim de teste: a mesma do app e do backend — trial_ends_at, que
// services/trialRegra escreve (teste que começa na primeira venda: teto de
// 15 dias do cadastro, encurtado para 7 dias a partir da venda; código: 7
// dias fixos). Nada aqui recalcula a data.
//
// Segurança dos envios (regras comuns):
//   - idempotência pelo email_log, chave por etapa (e, no teste, pela data
//     de fim: se o teste for estendido, a nova data tem o seu aviso);
//   - nada retroativo: cada etapa só no dia exato, com no máximo 1 dia de
//     recuperação; a boas-vindas só sai na transição para e-mail confirmado;
//   - fora: conta interna (is_staff, @getaura.com.br), sandbox, inativa,
//     Karatê/dojô, filial de grupo (o e-mail vai à empresa que paga) e
//     e-mail do dono não confirmado. Não existe mais conta demo no schema
//     (o app removeu o login demo; isDemo é sempre false);
//   - 4.2, 4.3 e 4.4: só teste (billing_status 'trial' e sem assinatura na
//     Asaas); quem já assinou fica fora;
//   - 4.3 e 4.4 dizem que o Caixa continua: só é verdade no shell Negócio
//     (utils/muroDeAssinatura do app: Odonto, Food, Studio e Karatê vão ao
//     checkout). Para as outras verticais esses dois não saem. O 4.2 também
//     fica só no varejo: o texto fala em achar o Caixa e imprimir etiqueta;
//   - preferências: tipo "ajuda" (4.1 a 4.5) e "acompanhamento" (sumiu),
//     lidas na hora do envio (emailPreferencias.tipoLigado); o rodapé leva
//     "Ajustar meus e-mails" e o descadastro de um clique do tipo;
//   - conta marcada "Não quer" (tq-110): tipoLigado devolve false para os
//     tipos comerciais, então ela não recebe boas-vindas, 4.2, 4.3, 4.4 nem
//     "sumiu". Só o 4.5 passa (aceitaNaoQuer), e só com motivo_externo.
//
// Kill switches: EMAILS_CICLO_ENABLED (geral), EMAIL_BOAS_VINDAS_ENABLED e
// EMAILS_TESTE_ENABLED (padrão ligados), EMAIL_SUMIU_ENABLED (padrão
// DESLIGADO: texto a aprovar).
// ============================================================
'use strict';

const conteudos = require('./emailsRelacionamento');
const { enviarEmailRegistrado } = require('./emailLog');
const { tipoLigado, descadastroDoTipo, sqlMarcaNaoQuer, ultimaNotaComResultado } = require('./emailPreferencias');
const { appUrl } = require('./emailLinks');
const { montarTrial } = require('./trialRegra');
const L = require('./emailLayout');
// tq-113 (26/10/2026): a definição única de conta pendente. O ciclo já exigia
// u.email_verified; o fragmento entra para a regra ser a mesma de todo lugar.
const { semPendente } = require('../utils/contaPendente');

const TZ = 'America/Sao_Paulo';

// A boas-vindas é para quem acabou de criar a conta: usuário criado há mais
// tempo que isto e que só agora confirmou o e-mail não recebe "vi que você
// criou a conta".
const DIAS_MAX_BOAS_VINDAS = 15;

// ── Interruptores ───────────────────────────────────────────────
function ligado(valor, padrao) {
  if (valor == null || String(valor).trim() === '') return padrao;
  return !/^(0|false|off|no|nao|não)$/i.test(String(valor).trim());
}

function cicloLigado(env) {
  return ligado(env.EMAILS_CICLO_ENABLED, true);
}

function boasVindasLigada(env = process.env) {
  return cicloLigado(env) && ligado(env.EMAIL_BOAS_VINDAS_ENABLED, true);
}

function emailsDoTesteLigados(env = process.env) {
  return cicloLigado(env) && ligado(env.EMAILS_TESTE_ENABLED, true);
}

function sumiuLigado(env = process.env) {
  return cicloLigado(env) && ligado(env.EMAIL_SUMIU_ENABLED, false);
}

// ── Datas ───────────────────────────────────────────────────────
function hojeBrt(now = Date.now()) {
  return new Date(now - 3 * 3600000).toISOString().slice(0, 10);
}

// ── Quem fica fora (SQL comum) ──────────────────────────────────
// `c` = companies, `u` = users do dono. Shell Negócio = o caixaVivo do app
// (app/_layout.tsx): vertical_active fora de odonto/food/studio e
// (vertical_active ?? vertical) fora do Karatê.
const SQL_ELEGIVEL_BASE = `
      c.is_active IS NOT FALSE
  AND c.is_sandbox IS NOT TRUE
  AND COALESCE(c.vertical_active, c.vertical, '') NOT IN ('karate_dojo', 'karate_federation')
  AND COALESCE(c.vertical, '') NOT IN ('karate_dojo', 'karate_federation')
  AND u.is_staff IS NOT TRUE
  AND lower(COALESCE(u.email, '')) NOT LIKE '%@getaura.com.br'
  AND lower(COALESCE(c.email, '')) NOT LIKE '%@getaura.com.br'
  AND u.email_verified IS TRUE
  AND ${semPendente('c')}`;

// Filial de grupo (multi-CNPJ) herda o status da matriz e não recebe cópia.
const SQL_ELEGIVEL = `${SQL_ELEGIVEL_BASE}
  AND (c.billing_owner_company_id IS NULL OR c.billing_owner_company_id = c.id)`;

const SQL_VAREJO = `
  COALESCE(c.vertical_active, '') NOT IN ('odonto', 'food', 'studio')`;

// Em teste e sem ter assinado: o cupom de dias grátis no cartão deixa
// billing_status='trial' COM assinatura — essa loja já assinou.
const SQL_EM_TESTE = `
  COALESCE(c.billing_status, 'trial') = 'trial'
  AND c.asaas_subscription_id IS NULL
  AND c.trial_ends_at IS NOT NULL`;

const VERTICAIS_FORA_DO_VAREJO = ['odonto', 'food', 'studio'];
const VERTICAIS_KARATE = ['karate_dojo', 'karate_federation'];

/** O shell Negócio do app (Caixa vivo). */
function ehVarejo(c) {
  if (!c) return false;
  if (VERTICAIS_FORA_DO_VAREJO.includes(c.vertical_active)) return false;
  const v = c.vertical_active != null ? c.vertical_active : c.vertical;
  return !VERTICAIS_KARATE.includes(v);
}

function linkDoApp(caminho, companyId, env = process.env) {
  const base = `${appUrl(env)}${caminho}`;
  if (!companyId) return base;
  return `${base}${base.includes('?') ? '&' : '?'}empresa=${encodeURIComponent(String(companyId))}`;
}

function primeiroNome(full, loja) {
  return L.primeiroNome(full) || loja || 'tudo bem';
}

/**
 * Envia um e-mail de relacionamento (tipo de preferência `tipoPref`),
 * lendo a preferência na hora. Devolve o status do enviarEmailRegistrado,
 * ou 'desligado' quando a loja desligou o tipo.
 */
async function enviarRelacionamento({ db, enviar, env, tipoPref, tipo, chave, alvo, montar, metadata, aceitaNaoQuer = false }) {
  if (!(await tipoLigado(db, alvo.companyId, tipoPref, { env, aceitaNaoQuer }))) return 'desligado';
  const d = descadastroDoTipo(alvo.companyId, tipoPref, { env });
  const conteudo = montar({ descadastro: d.link, ajustar: d.ajustar });
  const r = await enviarEmailRegistrado({
    db, enviar, chave, tipo,
    companyId: alvo.companyId, userId: alvo.userId, metadata,
    to: alvo.email,
    subject: conteudo.assunto,
    html: conteudo.html,
    text: conteudo.text,
    headers: d.headers || undefined,
  });
  return r.status;
}

// ── tq-80: boas-vindas ──────────────────────────────────────────

/**
 * Chamado pela confirmação do e-mail (link ou código), só quando
 * email_verified acabou de virar true. Nunca lança.
 */
async function aoConfirmarEmail(userId, { db = require('../config/database'), enviar, env = process.env, now = Date.now() } = {}) {
  try {
    if (!userId || !boasVindasLigada(env)) return 'desligado';
    const { rows } = await db.query(
      `SELECT u.id AS user_id, u.email, u.full_name, u.is_staff, u.email_verified, u.created_at AS user_created_at,
              c.id AS company_id, COALESCE(c.trade_name, c.legal_name) AS loja, c.email AS company_email,
              c.is_active, c.is_sandbox, c.vertical, c.vertical_active, c.billing_status,
              c.asaas_subscription_id, c.billing_owner_company_id,
              c.trial_ends_at, c.trial_mode, c.trial_started_by_sale_at, c.created_at
         FROM users u
         JOIN companies c ON c.owner_id = u.id
        WHERE u.id = $1
        ORDER BY c.is_primary DESC NULLS LAST, c.created_at ASC
        LIMIT 1`,
      [userId]
    );
    const r = rows && rows[0];
    // Sem empresa própria: convidado ou funcionário. Não recebe.
    if (!r) return 'nao_e_dono';
    if (r.email_verified !== true) return 'nao_confirmado';
    if (r.is_staff === true || r.is_active === false || r.is_sandbox === true) return 'fora';
    if (VERTICAIS_KARATE.includes(r.vertical) || VERTICAIS_KARATE.includes(r.vertical_active)) return 'fora';
    const emails = [r.email, r.company_email].filter(Boolean).map((e) => String(e).trim().toLowerCase());
    if (emails.some((e) => e.endsWith('@getaura.com.br'))) return 'fora';
    if (r.billing_owner_company_id && r.billing_owner_company_id !== r.company_id) return 'fora';
    const criado = r.user_created_at ? new Date(r.user_created_at).getTime() : NaN;
    if (!Number.isFinite(criado) || now - criado > DIAS_MAX_BOAS_VINDAS * 86400000) return 'antigo';
    const email = String(r.email || '').trim();
    if (!email.includes('@')) return 'sem_email';

    const assinou = r.billing_status === 'active' || !!r.asaas_subscription_id;
    const linha = assinou ? null : conteudos.linhaDoTeste(montarTrial(r, new Date(now)), { agora: now });
    const nome = primeiroNome(r.full_name, r.loja);
    const loja = r.loja || 'sua loja';
    return await enviarRelacionamento({
      db, enviar, env,
      tipoPref: 'ajuda',
      tipo: 'ajuda_boas_vindas',
      chave: `boas-vindas:${r.user_id}`,
      alvo: { companyId: r.company_id, userId: r.user_id, email },
      metadata: { trial_mode: r.trial_mode || null, trial_ends_at: r.trial_ends_at || null },
      montar: (links) => conteudos.boasVindas({
        nome, loja, linhaDoTeste: linha, varejo: ehVarejo(r),
        link: linkDoApp('/', r.company_id, env), ...links,
      }),
    });
  } catch (err) {
    console.error('[relacionamento] boas-vindas falhou: ' + (err && err.message));
    return 'erro';
  }
}

// ── tq-81: ciclo do teste ───────────────────────────────────────

const COLUNAS_DA_LOJA = `
  c.id AS company_id, COALESCE(c.trade_name, c.legal_name) AS loja,
  c.vertical, c.vertical_active, c.created_at, c.trial_ends_at, c.trial_mode, c.trial_started_by_sale_at,
  to_char((c.trial_ends_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS fim,
  u.id AS user_id, u.email, u.full_name`;

const SQL_SEM_VENDA = `
SELECT ${COLUNAS_DA_LOJA},
       (SELECT COUNT(*)::int FROM products p WHERE p.company_id = c.id AND p.is_active IS NOT FALSE) AS n_produtos
  FROM companies c
  JOIN users u ON u.id = c.owner_id
 WHERE ${SQL_ELEGIVEL}
   AND ${SQL_VAREJO}
   AND ${SQL_EM_TESTE}
   AND c.trial_ends_at > $2::timestamptz
   AND ($1::date - (c.created_at AT TIME ZONE '${TZ}')::date) BETWEEN 2 AND 3
   AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.company_id = c.id)
 ORDER BY c.created_at
 LIMIT 500`;

const SQL_TERMINANDO = `
SELECT ${COLUNAS_DA_LOJA}
  FROM companies c
  JOIN users u ON u.id = c.owner_id
 WHERE ${SQL_ELEGIVEL}
   AND ${SQL_VAREJO}
   AND ${SQL_EM_TESTE}
   AND c.trial_ends_at > $2::timestamptz
   AND ((c.trial_ends_at AT TIME ZONE '${TZ}')::date - $1::date) BETWEEN 1 AND 2
 ORDER BY c.trial_ends_at
 LIMIT 500`;

const SQL_ENCERRADO = `
SELECT ${COLUNAS_DA_LOJA},
       (SELECT COUNT(*)::int FROM products p WHERE p.company_id = c.id AND p.is_active IS NOT FALSE) AS n_produtos,
       (SELECT COUNT(*)::int FROM customers k WHERE k.company_id = c.id AND k.is_active IS NOT FALSE) AS n_clientes
  FROM companies c
  JOIN users u ON u.id = c.owner_id
 WHERE ${SQL_ELEGIVEL}
   AND ${SQL_VAREJO}
   AND ${SQL_EM_TESTE}
   AND c.trial_ends_at <= $2::timestamptz
   AND ($1::date - (c.trial_ends_at AT TIME ZONE '${TZ}')::date) BETWEEN 0 AND 1
 ORDER BY c.trial_ends_at
 LIMIT 500`;

// 4.5 (tq-111): a mesma janela e os mesmos filtros do 4.4, só para a conta
// cuja nota mais recente é "Não quer" com motivo_externo. Para ela o 4.4 não
// sai (tipoLigado barra a conta marcada), e este sai uma vez só.
const MOTIVO_CONTA_GUARDADA = 'motivo_externo';
const SQL_CONTA_GUARDADA = `
SELECT ${COLUNAS_DA_LOJA},
       (SELECT COUNT(*)::int FROM products p WHERE p.company_id = c.id AND p.is_active IS NOT FALSE) AS n_produtos,
       (SELECT COUNT(*)::int FROM customers k WHERE k.company_id = c.id AND k.is_active IS NOT FALSE) AS n_clientes
  FROM companies c
  JOIN users u ON u.id = c.owner_id
 WHERE ${SQL_ELEGIVEL}
   AND ${SQL_VAREJO}
   AND ${SQL_EM_TESTE}
   AND c.trial_ends_at <= $2::timestamptz
   AND ($1::date - (c.trial_ends_at AT TIME ZONE '${TZ}')::date) BETWEEN 0 AND 1
   AND ${sqlMarcaNaoQuer('c.id', { motivo: MOTIVO_CONTA_GUARDADA })}
 ORDER BY c.trial_ends_at
 LIMIT 500`;

function alvoDaLinha(r) {
  const email = String(r.email || '').trim();
  return email.includes('@') ? { companyId: r.company_id, userId: r.user_id, email } : null;
}

/**
 * A volta diária do ciclo do teste. Devolve a contagem por etapa e
 * situação. Nunca lança por uma loja: a falha de uma não para as outras.
 */
async function voltaDoTeste({ db, enviar, env = process.env, now = Date.now() } = {}) {
  const resumo = { sem_venda: {}, terminando: {}, encerrado: {}, conta_guardada: {} };
  if (!emailsDoTesteLigados(env)) return { desligado: true, ...resumo };
  const hoje = hojeBrt(now);
  const agora = new Date(now).toISOString();
  const conta = (etapa, st) => { resumo[etapa][st] = (resumo[etapa][st] || 0) + 1; };

  const etapas = [
    {
      nome: 'sem_venda', sql: SQL_SEM_VENDA, tipo: 'ajuda_primeira_venda',
      chave: (r) => `primeira-venda:${r.company_id}`,
      montar: (r, nome, links) => conteudos.primeiraVendaNaoSaiu({
        nome, loja: r.loja || 'sua loja', nProdutos: r.n_produtos, link: linkDoApp('/pdv', r.company_id, env), ...links,
      }),
    },
    {
      nome: 'terminando', sql: SQL_TERMINANDO, tipo: 'ajuda_teste_terminando',
      chave: (r) => `teste-terminando:${r.company_id}:${r.fim}`,
      montar: (r, nome, links) => conteudos.testeTerminando({
        nome, loja: r.loja || 'sua loja', fim: r.fim, hoje, link: linkDoApp('/checkout', r.company_id, env), ...links,
      }),
    },
    {
      nome: 'encerrado', sql: SQL_ENCERRADO, tipo: 'ajuda_teste_encerrado',
      chave: (r) => `teste-encerrado:${r.company_id}:${r.fim}`,
      montar: (r, nome, links) => conteudos.testeEncerrado({
        nome, loja: r.loja || 'sua loja', nProdutos: r.n_produtos, nClientes: r.n_clientes,
        link: linkDoApp('/checkout', r.company_id, env), ...links,
      }),
    },
    {
      // 4.5: uma vez por empresa (a chave não leva o fim), atrás do mesmo
      // EMAILS_TESTE_ENABLED. aceitaNaoQuer: é o e-mail da conta marcada.
      nome: 'conta_guardada', sql: SQL_CONTA_GUARDADA, tipo: 'ajuda_conta_guardada',
      chave: (r) => `conta-guardada:${r.company_id}`,
      aceitaNaoQuer: true,
      montar: (r, nome, links) => conteudos.contaGuardada({
        nome, loja: r.loja || 'sua loja', nProdutos: r.n_produtos, nClientes: r.n_clientes,
        link: linkDoApp('/', r.company_id, env), ...links,
      }),
    },
  ];

  for (const e of etapas) {
    let rows = [];
    try {
      ({ rows } = await db.query(e.sql, [hoje, agora]));
    } catch (err) {
      console.error(`[relacionamento] seleção ${e.nome} falhou: ${err.message}`);
      conta(e.nome, 'erro_consulta');
      continue;
    }
    for (const r of rows || []) {
      try {
        // 4.3 e 4.4 dizem que o Caixa continua, e o 4.2 fala do Caixa e da
        // etiqueta: só o shell Negócio (o SQL já filtra; aqui é a segunda
        // trava).
        if (!ehVarejo(r)) { conta(e.nome, 'fora_do_varejo'); continue; }
        const alvo = alvoDaLinha(r);
        if (!alvo) { conta(e.nome, 'sem_email'); continue; }
        if (e.aceitaNaoQuer) {
          // Segunda trava do 4.5: a nota relida agora ainda é "Não quer"
          // por motivo externo (uma nota mais nova derruba a marca).
          const nota = await ultimaNotaComResultado(db, r.company_id);
          if (!nota || nota.resultado !== 'nao_quer' || nota.motivo !== MOTIVO_CONTA_GUARDADA) {
            conta(e.nome, 'sem_marca'); continue;
          }
        }
        const nome = primeiroNome(r.full_name, r.loja);
        const st = await enviarRelacionamento({
          db, enviar, env, tipoPref: 'ajuda', tipo: e.tipo, chave: e.chave(r), alvo,
          aceitaNaoQuer: !!e.aceitaNaoQuer,
          metadata: { trial_ends_at: r.trial_ends_at || null, fim: r.fim || null },
          montar: (links) => e.montar(r, nome, links),
        });
        conta(e.nome, st);
      } catch (err) {
        console.error(`[relacionamento] ${e.nome} da company ${r.company_id} falhou: ${err.message}`);
        conta(e.nome, 'erro');
      }
    }
  }
  return resumo;
}

// ── tq-82b: faz uns dias que você não aparece ───────────────────
//
// Último acesso: companies.last_active_at, gravado por requireCompanyAccess
// em todo request autenticado em /companies/:id/* (no máximo 1 UPDATE a
// cada 15 min por empresa; staff em modo admin não conta), desde 12/10/2026.
// Conta o uso de qualquer pessoa da loja (dono ou funcionário no Caixa), e
// é o que a Gestão Aura já usa. Por dono: o acesso mais recente entre as
// empresas dele (multi-CNPJ). Sem acesso registrado (NULL), nada sai: não
// dá para saber há quanto tempo a loja sumiu.
//
// Só pagantes (active) e testes vigentes. Uma vez por período de ausência:
// a chave leva o dia do último acesso; se a pessoa volta e some de novo, é
// outro período.
const DIAS_SEM_ACESSO = 7;

const SQL_SUMIU = `
WITH elegiveis AS (
  SELECT c.id AS company_id, c.owner_id, COALESCE(c.trade_name, c.legal_name) AS loja, c.last_active_at,
         u.id AS user_id, u.email, u.full_name
    FROM companies c
    JOIN users u ON u.id = c.owner_id
   WHERE ${SQL_ELEGIVEL_BASE}
     AND (c.billing_status = 'active'
          OR (COALESCE(c.billing_status, 'trial') = 'trial' AND c.trial_ends_at > $2::timestamptz))
), por_dono AS (
  SELECT c.owner_id, MAX(c.last_active_at) AS ultimo
    FROM companies c
   WHERE c.owner_id IN (SELECT owner_id FROM elegiveis)
     AND c.is_active IS NOT FALSE
   GROUP BY c.owner_id
)
SELECT DISTINCT ON (e.owner_id)
       e.company_id, e.loja, e.user_id, e.email, e.full_name, e.owner_id,
       to_char((p.ultimo::timestamptz AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS ultimo_dia
  FROM elegiveis e
  JOIN por_dono p ON p.owner_id = e.owner_id
 WHERE p.ultimo IS NOT NULL
   AND ($1::date - (p.ultimo::timestamptz AT TIME ZONE '${TZ}')::date) BETWEEN $3::int AND $3::int + 1
 ORDER BY e.owner_id, e.last_active_at DESC NULLS LAST, e.company_id
 LIMIT 500`;

// Outro e-mail de relacionamento (tipos ajuda_* e acompanhamento_*, que a
// lista "Últimos e-mails" já agrupa pela preferência) nos últimos 2 dias
// para a mesma loja: o
// "sumiu" espera (o dia de recuperação ainda pega; se não pegar, fica para
// o próximo período). Evita duas cartas do Caio em seguida.
const SQL_CARTA_RECENTE = `
SELECT 1 FROM email_log
 WHERE company_id = $1 AND (tipo LIKE 'ajuda\\_%' OR tipo LIKE 'acompanhamento\\_%') AND status = 'sent'
   AND created_at > $2::timestamptz - INTERVAL '2 days'
 LIMIT 1`;

async function voltaDoSumiu({ db, enviar, env = process.env, now = Date.now() } = {}) {
  const resumo = {};
  if (!sumiuLigado(env)) return { desligado: true };
  const conta = (st) => { resumo[st] = (resumo[st] || 0) + 1; };
  const agora = new Date(now).toISOString();
  let rows = [];
  try {
    ({ rows } = await db.query(SQL_SUMIU, [hojeBrt(now), agora, DIAS_SEM_ACESSO]));
  } catch (err) {
    // 42703: last_active_at ausente — nada a fazer.
    console.error('[relacionamento] seleção do sumiu falhou: ' + err.message);
    return { erro_consulta: 1 };
  }
  for (const r of rows || []) {
    try {
      const alvo = alvoDaLinha(r);
      if (!alvo) { conta('sem_email'); continue; }
      const recente = await db.query(SQL_CARTA_RECENTE, [r.company_id, agora]);
      if (recente && recente.rows && recente.rows.length) { conta('carta_recente'); continue; }
      const nome = primeiroNome(r.full_name, r.loja);
      const st = await enviarRelacionamento({
        db, enviar, env, tipoPref: 'acompanhamento', tipo: 'acompanhamento_sumiu',
        chave: `sumiu:${r.owner_id}:${r.ultimo_dia}`, alvo,
        metadata: { ultimo_acesso: r.ultimo_dia },
        montar: (links) => conteudos.sumiu({ nome, loja: r.loja || 'sua loja', ...links }),
      });
      conta(st);
    } catch (err) {
      console.error(`[relacionamento] sumiu da company ${r.company_id} falhou: ${err.message}`);
      conta('erro');
    }
  }
  return resumo;
}

module.exports = {
  DIAS_MAX_BOAS_VINDAS,
  DIAS_SEM_ACESSO,
  SQL_SEM_VENDA,
  SQL_TERMINANDO,
  SQL_ENCERRADO,
  SQL_CONTA_GUARDADA,
  MOTIVO_CONTA_GUARDADA,
  SQL_SUMIU,
  boasVindasLigada,
  emailsDoTesteLigados,
  sumiuLigado,
  ehVarejo,
  linkDoApp,
  hojeBrt,
  aoConfirmarEmail,
  voltaDoTeste,
  voltaDoSumiu,
};
