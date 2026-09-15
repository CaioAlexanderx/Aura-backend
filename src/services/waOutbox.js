// ============================================================
// AURA — ONDA 5b: FILA DE ENVIO WhatsApp (Cloud API)
//
// Regras de produto:
//  - OPT-OUT SEMPRE VENCE: telefone com opted_out_at nunca recebe —
//    o enfileiramento grava 'skipped' (auditável), não envia.
//  - Texto livre SÓ dentro da janela de 24h (last_inbound_at do
//    contato); fora dela, apenas TEMPLATE aprovado. O dispatcher
//    reforça a regra na hora do envio (a janela pode fechar na fila).
//  - Retry com backoff exponencial (2^attempts min, teto 60min),
//    permanente após MAX_ATTEMPTS.
//  - Credenciais por company (companies.wa_phone_number_id/
//    wa_access_token — src/migrations/039): consultadas com guarda
//    42703; ausentes → 'skipped' SEM_CREDENCIAIS.
//  - Todo envio OK também loga em wa_messages (039) best-effort.
// ============================================================
'use strict';

const db = require('../config/database');
const wa = require('./whatsapp');
const quota = require('./marketing/marketingQuota');

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 24 * 3600 * 1000;

// ── Guardas de custo (Fase 2) — CADA MENSAGEM CUSTA DINHEIRO ────────
// Tetos configuráveis por env; default seguro quando ausente/inválida.
function dailyCap() {
  const n = Number(process.env.WA_DAILY_CAP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 300;
}

function perPhoneDailyCap() {
  const n = Number(process.env.WA_PER_PHONE_DAILY_CAP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2;
}

// ── Guardas de MARKETING (Fases 7/8) — mais duras que as de cobrança ──
// Reativação e aniversário são templates de categoria MARKETING na Meta:
// custam mais, têm limite POR USUÁRIO (131049) e derrubam a qualidade do
// número quando a pessoa marca como spam. Nenhuma delas vale para
// cobrança — um lembrete de parcela continua saindo sob YELLOW e sem
// consentimento declarado, porque é utilitário de uma relação que a
// pessoa já tem com a loja.
// A lista mora no marketingQuota (que não pode depender deste módulo —
// ciclo); aqui é só o Set para a guarda. Inclui 'otica_revisao' (334).
const MARKETING_SOURCE_TYPES = new Set(quota.MARKETING_SOURCE_TYPES);

function isMarketingSource(sourceType) {
  return MARKETING_SOURCE_TYPES.has(String(sourceType || ''));
}

// Teto diário SÓ de marketing, separado do geral: 100 promoções e 300
// cobranças no mesmo dia são coisas diferentes para a Meta e para a
// qualidade do número.
function marketingDailyCap() {
  const n = Number(process.env.WA_MARKETING_DAILY_CAP);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 100;
}

// Janela de frequência: no máximo 1 marketing por contato a cada 7 dias,
// somando TODAS as origens (reativação, aniversário, campanha futura).
const MARKETING_WINDOW_DAYS = 7;

// ── Uso justo MENSAL da cobrança (Fase 8b) ──────────────────
// Cobrança e lembrete são "ilimitados" na tabela de preços e continuam
// sendo: este teto é para o caso patológico (régua em loop, importação
// que criou 3000 parcelas no mesmo dia), não para o cliente grande. Por
// isso o motivo é DIFERENTE do de marketing — LIMITE_MENSAL — e a
// reação é avisar o suporte, não vender pacote: quem chega aqui tem um
// problema para alguém olhar.
const UTILITY_SOURCE_TYPES = new Set(quota.UTILITY_SOURCE_TYPES);

function isUtilitySource(sourceType) {
  return UTILITY_SOURCE_TYPES.has(String(sourceType || ''));
}

// Um aviso por empresa por mês POR PROCESSO. Sem isso, cada mensagem
// barrada depois do teto viraria uma linha nova em alert_history — o
// alerta que se repete 400 vezes é o alerta que ninguém lê.
const _usoJustoAvisado = new Set();

async function avisarSuporteUsoJusto(companyId, usadas, teto) {
  const mes = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 7);
  const chave = `${companyId}:${mes}`;
  if (_usoJustoAvisado.has(chave)) return;
  _usoJustoAvisado.add(chave);
  console.warn(
    `[waOutbox] uso justo MENSAL de cobrança estourado — company=${companyId} ` +
    `enviadas=${usadas} teto=${teto} mes=${mes}. Mensagens de cobrança estão sendo puladas ` +
    `com LIMITE_MENSAL até a virada do mês.`
  );
  try {
    await db.query(
      `-- wa:uso-justo-alerta
       INSERT INTO alert_history (company_id, alert_type, severity, title, message, data)
       VALUES ($1, 'wa_uso_justo_mensal', 'warning', $2, $3, $4)`,
      [companyId, 'Uso justo do WhatsApp atingido',
       `A loja já enviou ${usadas} mensagens de cobrança pelo WhatsApp neste mês (teto de uso justo: ${teto}). Novas cobranças automáticas estão pausadas até a virada do mês.`,
       JSON.stringify({ month: mes, sent: usadas, cap: teto })]
    );
  } catch (e) {
    // Mesma regra do appNotifications: NOTIFICAR NUNCA DERRUBA O FLUXO
    // DE ORIGEM. alert_history é tabela legada e pode não existir no
    // ambiente (42P01) — esse caso é esperado e silencioso. Qualquer
    // outro erro é gritado no log em vez de engolido, mas também não
    // vira exceção: não faz sentido a cobrança de quem está DENTRO do
    // teto quebrar porque o alerta de quem estourou falhou.
    if (e.code !== '42P01' && e.code !== '42703') {
      console.error('[waOutbox] alerta de uso justo falhou:', e.code || '', e.message);
    }
  }
}

// Só para teste: o cache do aviso é module-level e sobrevive entre casos.
function _resetUsoJustoAvisos() { _usoJustoAvisado.clear(); }

// Teto FIXO de envio de teste (2f) — não é env: um número fixo baixo é
// o bastante para o sensei testar o template e alto o suficiente para
// não travar QA. Não faz sentido alguém precisar mudar isso por env.
const TEST_DAILY_CAP = 5;

// Template aprovado PARA ESTA COMPANY? 42P01 (307 pendente) ou nenhuma
// linha local contam como NÃO aprovado — sem registro local não há
// garantia nenhuma de que a Meta aceitaria o nome agora.
async function isTemplateApproved(companyId, name, language) {
  try {
    const { rows } = await db.query(
      `-- wa:guard-template
       SELECT status FROM wa_templates
        WHERE company_id = $1 AND name = $2 AND language = $3 LIMIT 1`,
      [companyId, name, language || 'pt_BR']
    );
    return !!(rows[0] && rows[0].status === 'APPROVED');
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return false;
    throw e;
  }
}

// Motivo de pausa da fila (328) — 42703/42P01-safe: migration pendente
// nunca pode travar quem já está enviando sem pausa nenhuma.
async function loadPauseReason(companyId) {
  try {
    const { rows } = await db.query(
      `-- wa:guard-paused
       SELECT wa_paused_reason FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    return (rows[0] && rows[0].wa_paused_reason) || null;
  } catch (e) {
    if (e.code === '42703' || e.code === '42P01') return null;
    throw e;
  }
}

// Contagem de HOJE (America/Sao_Paulo) na wa_outbox — não conta
// 'skipped' nem 'failed' (nem gasto real, nem gasto pendente). Serve os
// dois tetos (4 e 5) e o teto fixo de teste (2f) conforme os filtros
// opcionais: phone (por contato) e sourceType (só itens de teste).
async function countToday(companyId, { phone = null, sourceType = null } = {}) {
  try {
    const { rows } = await db.query(
      `-- wa:guard-count-today
       SELECT COUNT(*)::int AS n FROM wa_outbox
        WHERE company_id = $1
          AND ($2::text IS NULL OR to_phone = $2)
          AND ($3::text IS NULL OR source_type = $3)
          AND status NOT IN ('skipped','failed')
          AND (created_at AT TIME ZONE 'America/Sao_Paulo')::date
            = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date`,
      [companyId, phone, sourceType]
    );
    return Number((rows[0] && rows[0].n) || 0);
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return 0;
    throw e;
  }
}

// ── Consultas das guardas de marketing (331) ────────────────

// A empresa DECLAROU que os clientes autorizaram receber mensagens dela?
// Com a 331 pendente (42703) ou a tabela ausente (42P01) a resposta é
// NÃO: a direção segura aqui é o silêncio — marketing sem consentimento
// declarado é o tipo de envio que gera denúncia, não só custo.
async function loadMarketingConsentAt(companyId) {
  try {
    const { rows } = await db.query(
      `-- wa:guard-marketing-consent
       SELECT wa_marketing_consent_at FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    return (rows[0] && rows[0].wa_marketing_consent_at) || null;
  } catch (e) {
    if (e.code === '42703' || e.code === '42P01') return null;
    throw e;
  }
}

async function hasMarketingConsent(companyId) {
  return !!(await loadMarketingConsentAt(companyId));
}

// Qualidade do número (328). YELLOW já barra MARKETING — esperar chegar
// em RED (que barra tudo) é esperar o número ser punido. 42703/42P01 →
// null: sem informação não se inventa um bloqueio.
async function loadQualityRating(companyId) {
  try {
    const { rows } = await db.query(
      `-- wa:guard-quality
       SELECT wa_quality_rating FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    return (rows[0] && rows[0].wa_quality_rating) || null;
  } catch (e) {
    if (e.code === '42703' || e.code === '42P01') return null;
    throw e;
  }
}

// Contato que estourou o limite de marketing por usuário (131049).
// Diferente do invalid_at: aqui a COBRANÇA continua passando.
async function isMarketingBlocked(companyId, phone) {
  try {
    const { rows } = await db.query(
      `-- wa:guard-marketing-blocked
       SELECT 1 FROM wa_contacts
        WHERE company_id = $1 AND phone = $2 AND marketing_blocked_until > NOW()
        LIMIT 1`,
      [companyId, phone]
    );
    return rows.length > 0;
  } catch (e) {
    if (e.code === '42703' || e.code === '42P01') return false;
    throw e;
  }
}

// Quantas mensagens de marketing este CONTATO recebeu na janela, e
// quantas a EMPRESA mandou hoje. As duas contas saem da mesma consulta
// com filtros opcionais, e nenhuma delas conta 'skipped'/'failed' (o que
// não saiu não incomodou ninguém nem custou nada).
//
// O escopo é sempre (company, …): a promoção de uma loja não pode
// bloquear a promoção de outra para o mesmo telefone — são relações
// diferentes, e o limite de 7 dias é sobre o que ESTA loja mandou.
async function countMarketing(companyId, { phone = null, days = null, todayOnly = false } = {}) {
  try {
    const { rows } = await db.query(
      `-- wa:guard-marketing-count
       SELECT COUNT(*)::int AS n FROM wa_outbox
        WHERE company_id = $1
          AND source_type = ANY($2::text[])
          AND ($3::text IS NULL OR to_phone = $3)
          AND status NOT IN ('skipped','failed')
          AND ($4::int IS NULL OR created_at > NOW() - ($4::int || ' days')::interval)
          AND ($5::boolean IS NOT TRUE OR
               (created_at AT TIME ZONE 'America/Sao_Paulo')::date
                 = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)`,
      [companyId, Array.from(MARKETING_SOURCE_TYPES), phone, days, todayOnly]
    );
    return Number((rows[0] && rows[0].n) || 0);
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return 0;
    throw e;
  }
}

// Carimba o bloqueio de marketing do contato (131049) por N dias. Upsert
// porque o contato pode nem existir ainda em wa_contacts: quem nunca
// respondeu não tem linha, e é exatamente quem recebe promoção.
async function markContactMarketingBlocked(companyId, phone, days = 30) {
  const p = normalizePhone(phone) || phone;
  if (!p) return;
  const dias = Number.isFinite(Number(days)) && Number(days) > 0 ? Math.floor(Number(days)) : 30;
  try {
    await db.query(
      `-- wa:contact-marketing-block
       INSERT INTO wa_contacts (company_id, phone, marketing_blocked_until, opt_source)
       VALUES ($1, $2, NOW() + ($3 || ' days')::interval, 'meta')
       ON CONFLICT (company_id, phone) DO UPDATE SET
         marketing_blocked_until = NOW() + ($3 || ' days')::interval,
         updated_at = NOW()`,
      [companyId, p, String(dias)]
    );
  } catch (e) {
    if (e.code !== '42703' && e.code !== '42P01') throw e;
  }
}

// Todas as guardas de marketing de UM envio, em ordem de "quão
// definitivo é o não". Devolve null quando nada barra. Usada no enqueue,
// no reforço do despacho e na simulação — uma definição só para as três
// superfícies não divergirem.
async function marketingSkipReason(companyId, phone) {
  if (!(await hasMarketingConsent(companyId))) return 'SEM_CONSENTIMENTO';
  // Contato bloqueado pelo 131049 também sai como FREQUENCIA_MARKETING:
  // para quem lê a fila são a mesma frase ("este cliente já recebeu
  // marketing demais"), muda só quem impôs o limite — nós (7 dias) ou a
  // Meta (30 dias). Um código a mais aqui viraria código CRU na tela, que
  // é o que a UI não pode mostrar; o motivo técnico fica no
  // wa_contacts.marketing_blocked_until, que é onde se investiga.
  if (await isMarketingBlocked(companyId, phone)) return 'FREQUENCIA_MARKETING';
  const quality = await loadQualityRating(companyId);
  if (quality === 'YELLOW' || quality === 'RED') return 'QUALIDADE_MARKETING';
  const naJanela = await countMarketing(companyId, { phone, days: MARKETING_WINDOW_DAYS });
  if (naJanela > 0) return 'FREQUENCIA_MARKETING';
  // Cota MENSAL do plano (Fase 8b): 100 inclusas + pacotes ativos. É o
  // limite que o cliente vê na tela e pode resolver comprando pacote —
  // por isso vem antes do teto diário, que é anti-rajada interno e
  // ninguém compra. Os dois devolvem LIMITE_MARKETING porque a UI
  // traduz uma lista fechada de motivos; o número que diferencia os
  // dois está no /whatsapp/status.usage.marketing.
  if ((await quota.remainingThisMonth(companyId)) <= 0) return 'LIMITE_MARKETING';
  const hoje = await countMarketing(companyId, { todayOnly: true });
  if (hoje >= marketingDailyCap()) return 'LIMITE_MARKETING';
  return null;
}

// Contato marcado como inválido pela Meta (wa_contacts.invalid_at, 328)
// — telefone que não é WhatsApp ou estourou limite de marketing por
// usuário nunca mais entra na fila automática.
async function markContactInvalid(companyId, phone, reason) {
  const p = normalizePhone(phone) || phone;
  if (!p) return;
  try {
    await db.query(
      `-- wa:contact-invalid
       UPDATE wa_contacts SET invalid_at = NOW(), invalid_reason = $3
        WHERE company_id = $1 AND phone = $2`,
      [companyId, p, reason ? String(reason).slice(0, 300) : null]
    );
  } catch (e) {
    if (e.code !== '42703' && e.code !== '42P01') throw e;
  }
}

// Pausa a fila da company (328) — QUALIDADE_BAIXA | CONTA_RESTRITA |
// MANUAL. 42703/42P01-safe: migration pendente não pode virar exceção
// no meio do tratamento de um erro que JÁ é ruim.
async function markCompanyPaused(companyId, reason) {
  try {
    await db.query(
      `-- wa:company-pause
       UPDATE companies SET wa_paused_reason = $2, wa_paused_at = NOW() WHERE id = $1`,
      [companyId, reason]
    );
  } catch (e) {
    if (e.code !== '42703' && e.code !== '42P01') throw e;
  }
}

// 133010 ("phone number not registered"): o /register de algum jeito
// deixou de valer — carimbar NULL aqui é o que faz o /status voltar a
// pedir reconexão/registro em vez de mentir "registrado".
async function clearRegisteredFlag(companyId) {
  try {
    await db.query(
      `-- wa:clear-registered
       UPDATE companies SET wa_registered_at = NULL WHERE id = $1`,
      [companyId]
    );
  } catch (e) {
    if (e.code !== '42703' && e.code !== '42P01') throw e;
  }
}

// Erros da Graph que NUNCA vão melhorar com retry (2c) — falha na 1ª
// tentativa em vez de gastar mais 4 chamadas pagas/bloqueadas até
// desistir. Por código (err.meta.code), nunca por regex na mensagem.
const PERMANENT_ERROR_CODES = new Set([
  100, 130472, 131026, 131047, 131051, 132000, 132001, 132005, 132007,
  132012, 132015, 132016, 133010, 470, 131031, 131053,
]);

// Telefone que a Meta disse não ser WhatsApp (131026): marca invalid_at
// para futuros enqueues pularem — continuar tentando o MESMO contato é
// dinheiro jogado fora.
const CONTACT_INVALID_ERROR_CODES = new Set([131026]);

// 131049 é OUTRA coisa: "esta pessoa já recebeu marketing demais neste
// período", e não "este número não presta". Até a Fase 7 ele caía no
// invalid_at junto com o 131026 e cegava o contato também para COBRANÇA
// — uma promoção recusada passava a impedir o lembrete da parcela do
// mesmo cliente. Agora bloqueia só marketing, e por 30 dias.
const MARKETING_BLOCK_ERROR_CODES = new Set([131049]);
const MARKETING_BLOCK_DAYS = 30;

// Conta restrita ou com problema de pagamento: pausa a FILA INTEIRA da
// company (não só esta mensagem) — 131031 também é permanente (lista
// acima); 131042 fica de fora da lista de permanentes porque um
// problema de pagamento pode ser resolvido rápido pelo lojista.
const PAUSE_ERROR_CODES = new Set([131031, 131042]);

function metaErrorCode(err) {
  return err && err.meta ? Number(err.meta.code) : NaN;
}

// E.164 sem '+': só dígitos. BR de 10 dígitos (fixo) ou 11 com '9' na
// 3ª posição (celular DDD+9...) ganha 55. Onze dígitos SEM esse '9'
// (ex.: o número de teste da Meta, 1 555 630 9005) passam como
// internacionais — DDDs 11-19 de SP não colidem porque o celular BR
// sempre tem o 9 ali.
function normalizePhone(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/\D+/g, '');
  if (!d) return null;
  if (d.length === 10) return `55${d}`;
  if (d.length === 11) return d[2] === '9' ? `55${d}` : d;
  if (d.length >= 12 && d.length <= 15) return d;
  return null;
}

const OPT_OUT_WORDS = ['sair', 'parar', 'cancelar', 'stop', 'descadastrar'];
const OPT_IN_WORDS = ['voltar', 'start', 'quero receber'];

async function getContact(companyId, phone) {
  const { rows } = await db.query(
    `-- wa:contact-get
     SELECT id, phone, opted_in_at, opted_out_at, last_inbound_at
       FROM wa_contacts WHERE company_id = $1 AND phone = $2 LIMIT 1`,
    [companyId, phone]
  );
  return rows[0] || null;
}

// Upsert disparado pelo WEBHOOK a cada mensagem recebida: abre a janela
// de 24h e processa palavras de opt-in/opt-out.
async function touchInbound(companyId, phone, textBody) {
  const p = normalizePhone(phone);
  if (!p) return null;
  const txt = String(textBody || '').trim().toLowerCase();
  const optOut = OPT_OUT_WORDS.includes(txt);
  const optIn = !optOut && OPT_IN_WORDS.includes(txt);
  const { rows } = await db.query(
    `-- wa:contact-touch
     INSERT INTO wa_contacts (company_id, phone, last_inbound_at, opted_in_at, opted_out_at, opt_source)
     VALUES ($1, $2, NOW(), CASE WHEN $4 THEN NULL ELSE NOW() END, CASE WHEN $4 THEN NOW() ELSE NULL END, 'inbound')
     ON CONFLICT (company_id, phone) DO UPDATE SET
       last_inbound_at = NOW(),
       opted_out_at = CASE WHEN $4 THEN NOW() WHEN $3 THEN NULL ELSE wa_contacts.opted_out_at END,
       opted_in_at  = CASE WHEN $4 THEN NULL WHEN $3 THEN NOW() ELSE COALESCE(wa_contacts.opted_in_at, NOW()) END,
       updated_at = NOW()
     RETURNING id, opted_out_at`,
    [companyId, p, optIn, optOut]
  );
  return { row: rows[0] || null, opt_out: optOut, opt_in: optIn };
}

// Upsert disparado pelo WEBHOOK a cada echo de mensagem que a PRÓPRIA
// empresa mandou pelo app WhatsApp Business do celular (Coexistence,
// change.field === 'smb_message_echoes'). Só garante que o contato
// existe — CRIA se faltar — e propositalmente NÃO mexe em
// last_inbound_at nem em opted_in_at/opted_out_at: a janela de 24h de
// atendimento e o opt-in/opt-out só podem mudar quando o CLIENTE manda
// mensagem (touchInbound), nunca quando é a loja que manda pelo
// celular. Misturar os dois abriria a janela de graça toda vez que a
// dona da loja mandasse um "oi" pelo próprio WhatsApp.
async function touchOutboundHuman(companyId, toPhone) {
  const p = normalizePhone(toPhone);
  if (!p) return null;
  const { rows } = await db.query(
    `-- wa:contact-touch-outbound-human
     INSERT INTO wa_contacts (company_id, phone)
     VALUES ($1, $2)
     ON CONFLICT (company_id, phone) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [companyId, p]
  );
  return rows[0] || null;
}

function windowOpen(contact) {
  return !!(contact && contact.last_inbound_at
    && Date.now() - new Date(contact.last_inbound_at).getTime() < WINDOW_MS);
}

// Enfileira. kind 'template' (default) ou 'text' (só janela aberta —
// checada aqui E no envio). dedupeKey: idempotência (charge+offset etc.).
async function enqueue({
  companyId, toPhone, kind = 'template',
  templateName = null, templateLanguage = 'pt_BR', components = null,
  textBody = null, sourceType = null, sourceId = null, dedupeKey = null,
}) {
  const phone = normalizePhone(toPhone);
  if (!phone) return { queued: false, reason: 'TELEFONE_INVALIDO' };
  if (kind === 'template' && !templateName) return { queued: false, reason: 'TEMPLATE_OBRIGATORIO' };

  const isTeste = sourceType === 'teste';
  const contact = await getContact(companyId, phone);
  let status = 'pending';
  let skipReason = null;
  if (contact && contact.opted_out_at) { status = 'skipped'; skipReason = 'OPT_OUT'; }
  else if (kind === 'text' && !windowOpen(contact)) { status = 'skipped'; skipReason = 'JANELA_FECHADA'; }

  // ── Guardas de custo (Fase 2) — só valem quando ainda 'pending'
  // (opt-out e janela fechada, acima, sempre vencem primeiro). Item de
  // TESTE pula template (2) e os dois tetos automáticos (4/5), mas
  // continua respeitando telefone inválido (1) e pausa (3) — testar
  // não pode gastar num número que a Meta já recusou nem numa fila
  // pausada. Em vez disso, teste tem o PRÓPRIO teto fixo (2f).
  if (status === 'pending' && contact && contact.invalid_at) {
    status = 'skipped'; skipReason = 'TELEFONE_INVALIDO_META';
  }
  if (status === 'pending' && kind === 'template' && !isTeste) {
    const approved = await isTemplateApproved(companyId, templateName, templateLanguage);
    if (!approved) { status = 'skipped'; skipReason = 'TEMPLATE_NAO_APROVADO'; }
  }
  if (status === 'pending') {
    const pauseReason = await loadPauseReason(companyId);
    if (pauseReason) {
      status = 'skipped';
      skipReason = pauseReason === 'QUALIDADE_BAIXA' ? 'QUALIDADE_BAIXA' : 'PAUSADO';
    }
  }
  // ── Guardas de MARKETING (Fases 7/8) — antes dos tetos gerais porque
  // o motivo específico é o que a tela precisa mostrar (e o teto de
  // marketing é menor que o geral de qualquer forma).
  const isMarketing = isMarketingSource(sourceType);
  if (status === 'pending' && isMarketing) {
    const motivo = await marketingSkipReason(companyId, phone);
    if (motivo) { status = 'skipped'; skipReason = motivo; }
  }
  // ── Uso justo MENSAL da cobrança (Fase 8b) ────────────────
  // Silencioso para o cliente na tabela de preços (cobrança continua
  // "ilimitada"), visível na fila: quem abrir a fila lê LIMITE_MENSAL
  // traduzido. O suporte é avisado uma vez por mês — o teto só é
  // alcançado por acidente, e acidente precisa de gente olhando.
  if (status === 'pending' && isUtilitySource(sourceType)) {
    const teto = quota.utilityMonthlyCap();
    const usadas = await quota.monthUsage(companyId, 'utility');
    if (usadas >= teto) {
      status = 'skipped';
      skipReason = 'LIMITE_MENSAL';
      await avisarSuporteUsoJusto(companyId, usadas, teto);
    }
  }
  if (status === 'pending' && !isTeste) {
    const n = await countToday(companyId, {});
    if (n >= dailyCap()) { status = 'skipped'; skipReason = 'LIMITE_DIARIO'; }
  }
  if (status === 'pending' && !isTeste) {
    const n = await countToday(companyId, { phone });
    if (n >= perPhoneDailyCap()) { status = 'skipped'; skipReason = 'LIMITE_POR_CONTATO'; }
  }
  if (status === 'pending' && isTeste) {
    // Cap fixo de 5/dia (2f) — contado só entre itens de teste, não
    // disputa o teto da fila automática nem é disputado por ela.
    const n = await countToday(companyId, { sourceType: 'teste' });
    if (n >= TEST_DAILY_CAP) { status = 'skipped'; skipReason = 'LIMITE_DIARIO'; }
  }

  const { rows } = await db.query(
    `-- wa:outbox-enqueue
     INSERT INTO wa_outbox
       (company_id, to_phone, kind, template_name, template_language, components,
        text_body, status, skip_reason, source_type, source_id, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id, status`,
    [companyId, phone, kind, templateName, templateLanguage,
     components ? JSON.stringify(components) : null, textBody,
     status, skipReason, sourceType, sourceId, dedupeKey]
  );
  if (!rows.length) return { queued: false, reason: 'DUPLICADO' };
  return { queued: status === 'pending', id: rows[0].id, status, reason: skipReason };
}

// Simula as guardas 1 (telefone inválido), OPT_OUT, 2 (template) e 3
// (pausa) de UM possível envio, SEM GRAVAR NADA — usado pelo
// GET /whatsapp/preview para mostrar quem seria pulado hoje sem gastar
// uma chamada à Meta nem escrever na wa_outbox. Os tetos (4/5) ficam de
// fora de propósito: são sobre ACÚMULO ao longo de vários itens, e o
// preview precisa somar isso na ORDEM em que os itens seriam enviados —
// quem chama mantém esse acumulado (ver GET /whatsapp/preview).
async function simulate({ companyId, toPhone, templateName = null, templateLanguage = 'pt_BR', sourceType = null }) {
  const phone = normalizePhone(toPhone);
  if (!phone) return { ok: false, reason: 'TELEFONE_INVALIDO' };
  const isTeste = sourceType === 'teste';

  const contact = await getContact(companyId, phone);
  if (contact && contact.opted_out_at) return { ok: false, reason: 'OPT_OUT' };
  if (contact && contact.invalid_at) return { ok: false, reason: 'TELEFONE_INVALIDO_META' };

  if (templateName && !isTeste) {
    const approved = await isTemplateApproved(companyId, templateName, templateLanguage);
    if (!approved) return { ok: false, reason: 'TEMPLATE_NAO_APROVADO' };
  }

  const pauseReason = await loadPauseReason(companyId);
  if (pauseReason) {
    return { ok: false, reason: pauseReason === 'QUALIDADE_BAIXA' ? 'QUALIDADE_BAIXA' : 'PAUSADO' };
  }

  // Marketing (Fases 7/8): consentimento, bloqueio por 131049, qualidade
  // e frequência de 7 dias são todos consultas de ESTADO — cabem na
  // simulação. O teto diário de marketing é acúmulo e fica com quem
  // chama, igual aos tetos da cobrança.
  if (isMarketingSource(sourceType)) {
    const motivo = await marketingSkipReason(companyId, phone);
    if (motivo && motivo !== 'LIMITE_MARKETING') return { ok: false, reason: motivo };
  }

  return { ok: true, reason: null };
}

// O token do Graph API é cifrado em repouso (AES-256-GCM, prefixo 'v1:',
// mesmo cofre do dojoBaasCrypto) desde o A9 — é assim que o Embedded
// Signup (/whatsapp/connect) grava. Token legado em texto puro NÃO tem o
// prefixo e passa direto. Sem isso, o dispatcher mandaria o ciphertext
// como Bearer e TODO dojô conectado pelo fluxo oficial falharia no envio.
function decryptToken(stored) {
  if (!stored) return stored;
  if (!/^v1:/.test(String(stored))) return stored;
  const { decrypt } = require('./dojoBaasCrypto');
  return decrypt(stored);
}

// ── Token recusado pela Meta (migration 309) ────────────────
// A Meta recusa credencial com o código 190 ("Error validating access
// token: Session has expired..."). Quem descobre isso primeiro quase
// sempre é a FILA, não a tela: o dispatcher tenta enviar e leva o erro.
// Carimbando aqui, o status do dojô para de mentir "Conectado" mesmo
// que ninguém tenha aberto a tela de templates. (Achado no QA 26/08.)
const TOKEN_ERROR_MARKERS = [
  'error validating access token',
  'session has expired',
  'access token',
  'oauthexception',
];

function isTokenError(err) {
  // Desde o erro estruturado da Graph (whatsapp.graphError) o código vem
  // limpo em err.meta — casar por texto continua valendo para o que já
  // está gravado em last_error e para quem lança Error puro.
  if (err && err.meta && Number(err.meta.code) === 190) return true;
  const msg = String((err && err.message) || err || '').toLowerCase();
  if (/code:?\s*190/.test(msg)) return true;
  return TOKEN_ERROR_MARKERS.some((m) => msg.includes(m));
}

// Silencioso com a 309 pendente: registrar o problema não pode virar
// um segundo problema.
async function markTokenInvalid(companyId, reason) {
  try {
    await db.query(
      `UPDATE companies SET wa_token_invalid_at = NOW(), wa_token_invalid_reason = $2 WHERE id = $1`,
      [companyId, reason ? String(reason).slice(0, 500) : null]
    );
  } catch (e) {
    if (e.code !== '42703') throw e;
  }
}

async function clearTokenInvalid(companyId) {
  try {
    await db.query(
      `UPDATE companies SET wa_token_invalid_at = NULL, wa_token_invalid_reason = NULL WHERE id = $1`,
      [companyId]
    );
  } catch (e) {
    if (e.code !== '42703') throw e;
  }
}

// Credenciais da company — 42703-safe (039 fora do CI).
async function loadCreds(companyId) {
  try {
    const { rows } = await db.query(
      `-- wa:creds
       SELECT wa_phone_number_id, wa_access_token FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    const r = rows[0];
    if (!r || !r.wa_phone_number_id || !r.wa_access_token) return null;
    return { phoneNumberId: r.wa_phone_number_id, accessToken: decryptToken(r.wa_access_token) };
  } catch (e) {
    if (e.code === '42703') return null;
    throw e;
  }
}

// Estado da conexão para quem só precisa responder "este dojô pode
// enviar?" (o gate da régua). O /whatsapp/status carrega mais campos e
// tem o loader dele; aqui basta o veredito — e ele nasce das MESMAS
// três condições: número + token + token não recusado.
// Colunas da 039/309 podem faltar: 42703/42P01 → "não conectado".
async function connectionState(companyId) {
  let row = null;
  try {
    const { rows } = await db.query(
      `-- wa:conn-state
       SELECT wa_phone_number_id, wa_access_token IS NOT NULL AS has_token
         FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    row = rows[0] || null;
  } catch (e) {
    if (e.code === '42703' || e.code === '42P01') return { connected: false, token_expired: false };
    throw e;
  }
  let tokenExpired = false;
  try {
    const { rows } = await db.query(
      `-- wa:conn-state-flag
       SELECT wa_token_invalid_at FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    );
    tokenExpired = !!(rows[0] && rows[0].wa_token_invalid_at);
  } catch (e) {
    if (e.code !== '42703' && e.code !== '42P01') throw e;
  }
  return {
    connected: !!(row && row.wa_phone_number_id && row.has_token && !tokenExpired),
    token_expired: tokenExpired,
  };
}

async function markRow(id, fields) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = $${i++}`); vals.push(v); }
  vals.push(id);
  await db.query(`UPDATE wa_outbox SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i}`, vals);
}

// Processa até `limit` itens pendentes vencidos. Chamado pelo
// waDispatcherJob e pelo POST /whatsapp/test-send (envio imediato).
async function processBatch(limit = 20) {
  const { rows } = await db.query(
    `-- wa:outbox-pick
     SELECT * FROM wa_outbox
      WHERE status = 'pending' AND next_attempt_at <= NOW()
      ORDER BY created_at ASC LIMIT $1`,
    [limit]
  );
  const out = { picked: rows.length, sent: 0, skipped: 0, retried: 0, failed: 0 };

  for (const row of rows) {
    try {
      const creds = await loadCreds(row.company_id);
      if (!creds) {
        await markRow(row.id, { status: 'skipped', skip_reason: 'SEM_CREDENCIAIS' });
        out.skipped++;
        continue;
      }
      // Reforço das regras NO ENVIO (estado pode ter mudado na fila).
      const contact = await getContact(row.company_id, row.to_phone);
      if (contact && contact.opted_out_at) {
        await markRow(row.id, { status: 'skipped', skip_reason: 'OPT_OUT' });
        out.skipped++;
        continue;
      }
      if (row.kind === 'text' && !windowOpen(contact)) {
        await markRow(row.id, { status: 'skipped', skip_reason: 'JANELA_FECHADA' });
        out.skipped++;
        continue;
      }
      // ── Reforço 2b: repete as guardas 1, 2 e 3 do enqueue — o estado
      // pode ter mudado enquanto o item esperava na fila (a Meta marcou
      // o contato inválido, o template caiu, a fila foi pausada). Item
      // de teste pula só o 2 (template), igual no enqueue.
      if (contact && contact.invalid_at) {
        await markRow(row.id, { status: 'skipped', skip_reason: 'TELEFONE_INVALIDO_META' });
        out.skipped++;
        continue;
      }
      if (row.kind === 'template' && row.source_type !== 'teste') {
        const approved = await isTemplateApproved(row.company_id, row.template_name, row.template_language);
        if (!approved) {
          await markRow(row.id, { status: 'skipped', skip_reason: 'TEMPLATE_NAO_APROVADO' });
          out.skipped++;
          continue;
        }
      }
      const pauseReasonNow = await loadPauseReason(row.company_id);
      if (pauseReasonNow) {
        await markRow(row.id, {
          status: 'skipped',
          skip_reason: pauseReasonNow === 'QUALIDADE_BAIXA' ? 'QUALIDADE_BAIXA' : 'PAUSADO',
        });
        out.skipped++;
        continue;
      }
      // Reforço das guardas de MARKETING no despacho: entre enfileirar e
      // enviar, o lojista pode ter retirado o consentimento, a qualidade
      // pode ter caído para YELLOW e a Meta pode ter bloqueado o contato
      // com 131049. Item de marketing que esperou na fila é justamente o
      // que mais tempo teve para essas coisas acontecerem.
      if (isMarketingSource(row.source_type)) {
        const motivoAgora = await marketingSkipReason(row.company_id, row.to_phone);
        // FREQUENCIA_MARKETING e LIMITE_MARKETING não valem aqui: as
        // duas contas incluem o PRÓPRIO item (ele já está na wa_outbox
        // como 'pending', que não é 'skipped' nem 'failed'), então
        // barrá-lo agora cancelaria toda mensagem que passou pelo
        // enqueue — e no caso da cota mensal cancelaria o lote inteiro
        // assim que ele enchesse a cota. Quem decide sobre acúmulo é o
        // enfileiramento, uma vez só, na entrada.
        if (motivoAgora && motivoAgora !== 'FREQUENCIA_MARKETING' && motivoAgora !== 'LIMITE_MARKETING') {
          await markRow(row.id, { status: 'skipped', skip_reason: motivoAgora });
          out.skipped++;
          continue;
        }
      }

      let resp;
      if (row.kind === 'template') {
        resp = await wa.sendTemplate(
          creds.phoneNumberId, creds.accessToken, row.to_phone,
          row.template_name, row.template_language || 'pt_BR',
          row.components || undefined
        );
      } else {
        resp = await wa.sendText(creds.phoneNumberId, creds.accessToken, row.to_phone, row.text_body || '');
      }
      const wamid = resp && resp.messages && resp.messages[0] && resp.messages[0].id || null;
      await markRow(row.id, { status: 'sent', wa_message_id: wamid, last_error: null });
      out.sent++;

      // Log espelho em wa_messages (039) — best-effort.
      db.query(
        `INSERT INTO wa_messages (company_id, direction, wa_message_id, to_phone, template_name, content, status, metadata)
         VALUES ($1,'outbound',$2,$3,$4,$5,'sent',$6)`,
        [row.company_id, wamid, row.to_phone, row.template_name,
         row.text_body || `[template ${row.template_name}]`,
         JSON.stringify({ outbox_id: row.id, source_type: row.source_type, source_id: row.source_id })]
      ).catch(() => {});
    } catch (e) {
      const attempts = (row.attempts || 0) + 1;
      const msg = String(e && e.message || e).slice(0, 500);
      // Credencial recusada não é falha transitória: carimba a company
      // para o status parar de dizer "Conectado" (o retry continua —
      // reconectar limpa a marca e a mensagem sai na próxima tentativa).
      if (isTokenError(e)) await markTokenInvalid(row.company_id, msg);

      // ── Erros permanentes da Meta (2c) — por CÓDIGO (err.meta.code),
      // nunca por regex na frase em inglês. Erro de REDE (fetch rejeita
      // antes de ter resposta da Meta, sem err.meta) não é permanente:
      // continua no retry/backoff de sempre.
      const code = metaErrorCode(e);
      if (CONTACT_INVALID_ERROR_CODES.has(code)) {
        await markContactInvalid(row.company_id, row.to_phone, msg);
      }
      if (MARKETING_BLOCK_ERROR_CODES.has(code)) {
        await markContactMarketingBlocked(row.company_id, row.to_phone, MARKETING_BLOCK_DAYS);
      }
      if (code === 133010) {
        await clearRegisteredFlag(row.company_id);
      }
      if (PAUSE_ERROR_CODES.has(code)) {
        await markCompanyPaused(row.company_id, 'CONTA_RESTRITA');
      }
      const permanent = PERMANENT_ERROR_CODES.has(code);

      if (permanent || attempts >= MAX_ATTEMPTS) {
        await markRow(row.id, { status: 'failed', attempts, last_error: msg });
        out.failed++;
      } else {
        const backoffMin = Math.min(Math.pow(2, attempts), 60);
        await db.query(
          `UPDATE wa_outbox SET attempts = $1, last_error = $2,
                  next_attempt_at = NOW() + ($3 || ' minutes')::interval, updated_at = NOW()
            WHERE id = $4`,
          [attempts, msg, String(backoffMin), row.id]
        );
        out.retried++;
      }
    }
  }
  return out;
}

// Webhook: status da Meta (sent→delivered→read / failed) casa por wamid.
async function applyStatusUpdate(companyId, wamid, status, errorText) {
  if (!wamid) return;
  const allowed = ['sent', 'delivered', 'read', 'failed'];
  if (!allowed.includes(status)) return;
  await db.query(
    `-- wa:outbox-status
     UPDATE wa_outbox SET status = $1, last_error = COALESCE($2, last_error), updated_at = NOW()
      WHERE wa_message_id = $3 AND company_id = $4
        AND status IN ('sent','delivered')`,
    [status, errorText || null, wamid, companyId]
  );
}

// Webhook: aprovação/rejeição de template (message_template_status_update).
async function applyTemplateStatus(companyId, { name, language, status, metaTemplateId }) {
  if (!name || !status) return;
  await db.query(
    `-- wa:template-status
     INSERT INTO wa_templates (company_id, name, language, status, meta_template_id, last_status_at)
     VALUES ($1,$2,COALESCE($3,'pt_BR'),$4,$5,NOW())
     ON CONFLICT (company_id, name, language) DO UPDATE SET
       status = EXCLUDED.status,
       meta_template_id = COALESCE(EXCLUDED.meta_template_id, wa_templates.meta_template_id),
       last_status_at = NOW(), updated_at = NOW()`,
    [companyId, name, language || 'pt_BR', status, metaTemplateId || null]
  );
}

module.exports = {
  normalizePhone, touchInbound, touchOutboundHuman, windowOpen, getContact, decryptToken,
  isTokenError, markTokenInvalid, clearTokenInvalid, connectionState,
  enqueue, processBatch, simulate, applyStatusUpdate, applyTemplateStatus,
  // Guardas de custo (Fase 2) — expostas para o GET /whatsapp/preview e
  // para os testes de guarda.
  dailyCap, perPhoneDailyCap, countToday, isTemplateApproved, loadPauseReason,
  markContactInvalid, markCompanyPaused, clearRegisteredFlag,
  TEST_DAILY_CAP,
  MAX_ATTEMPTS,
  // Guardas de MARKETING (Fases 7/8) — expostas para os serviços de
  // reativação/aniversário, para as prévias e para os testes.
  MARKETING_SOURCE_TYPES, MARKETING_WINDOW_DAYS, MARKETING_BLOCK_DAYS,
  isMarketingSource, marketingDailyCap, marketingSkipReason,
  // Uso justo mensal da cobrança (Fase 8b).
  UTILITY_SOURCE_TYPES, isUtilitySource, _resetUsoJustoAvisos,
  hasMarketingConsent, loadMarketingConsentAt, loadQualityRating, isMarketingBlocked,
  countMarketing, markContactMarketingBlocked,
};
