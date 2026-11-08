// ============================================================
// AURA. — Banner "Indique um lojista" no sininho
//
// Histórico:
//   14/10/2026  um banner por empresa em teste de varejo (chave
//               indicacao-trial:<id>, 7 dias no ar).
//   24/10/2026  item 15: só depois da primeira venda não cancelada.
//   29/10/2026  Black Friday (backend#924): toda empresa com login, fora as
//               exclusões técnicas e os shells Karatê/Odonto/Food; chave
//               indicacao-bf-2026:<id>, no ar até 30/11.
//
// 08/11/2026 (card b-mk-30, decisão do Caio via Marketing): o banner REPETE a
// cada 14 dias para toda conta real, sem data final. Medido em 08/11: 67
// banners da campanha, 4 lidos, 0 indicações, BLACK50 com 0 de 10 usos.
//
//   Público: o da campanha (avaliarEmpresa): toda empresa com login, fora
//     conta interna (@getaura.com.br), de teste (is_sandbox), o canário,
//     filial paga por outra empresa, empresa desativada e os shells Karatê
//     (dojô e federação), Odonto e Food.
//   Ciclo: nasce um banner novo quando o último banner de indicação da
//     empresa (qualquer uma das três chaves) foi criado há 14 dias ou mais,
//     contados em dias de Brasília (o job roda 06h30; comparar instantes
//     faria o ciclo escorregar um dia). LIDO OU DISPENSADO NÃO BLOQUEIA: o
//     dispensar (notification_reads) esconde só o banner atual. Ao criar o
//     novo, o anterior ainda ativo é desativado (nunca dois no sininho).
//   Chave: indicacao:<company_id>:<aaaa-mm-dd do ciclo, BRT>. Uma volta
//     repetida no mesmo dia (reinício, duas instâncias) cai no ON CONFLICT do
//     dedupe_key e não duplica.
//   Validade: 14 dias (até o próximo ciclo).
//
// Texto (faseDoTexto), decidido NA LEITURA do sininho e também gravado na
// criação, para que um banner criado na Black Friday não fique com BLACK50
// depois que o cupom acaba:
//   'black'        até 30/11/2026 23:59:59 BRT, com BLACK50 disponível.
//   'sem_black50'  ainda na Black Friday, mas o BLACK50 esgotou: texto fixo
//                  de indicação (sem BLACK50).
//   'fixo'         de 01/12/2026 em diante: texto fixo de indicação.
// Fonte do limite do BLACK50: access_codes (uses x max_uses, is_active). É o
// mesmo contador que o checkout reserva (checkoutCoupon.reserveCoupon, UPDATE
// uses + 1 WHERE uses < max_uses) e o cadastro confere; coupon_redemptions é
// só a auditoria do resgate. Código ausente ou desativado conta como esgotado.
//
// Contadores (sem tabela nova): audit_log
//   action 'indicacao.banner_visto'   o app mostrou o banner (1 por usuário
//                                     por banner)
//   action 'indicacao.banner_clique'  clique em "Gerar meu código" no banner
//                                     (1 por usuário por banner)
//   metadata { notification_id, ciclo (dedupe_key), fase }.
// Indicações atribuídas ao banner: linhas de referrals (cadastro por
// /r/CODIGO) cujo indicador clicou (ou viu) o banner ANTES do cadastro.
// Leitura: GET /admin/notifications/indicacao/contadores (staff).
//
// Chaves de ambiente (lidas a cada volta):
//   BANNER_INDICACAO_TRIAL_ENABLED  = false  DESLIGA o job (kill switch)
//   BANNER_INDICACAO_TRIAL_DRY_RUN  = true   só loga quem seria criado
//   BANNER_INDICACAO_TRIAL_PUBLICAR = false  cria o banner INATIVO
//
// Notificar nunca derruba nada: quem chama (job, rota) só loga a falha.
// ============================================================
'use strict';

const PREFIXO_DEDUPE = 'indicacao-trial:';
const PREFIXO_DEDUPE_BF = 'indicacao-bf-2026:';
const PREFIXO_CICLO = 'indicacao:';
// As três chaves que este serviço cria. Os banners de indicação feitos à mão
// na Gestão (indicacao-pagantes-..., indicacao-2026-10-15) ficam de fora de
// propósito: não entram no ciclo, no texto por fase nem nos contadores.
const PREFIXOS_INDICACAO = Object.freeze([PREFIXO_DEDUPE, PREFIXO_DEDUPE_BF, PREFIXO_CICLO]);
const LIKES_INDICACAO = Object.freeze(PREFIXOS_INDICACAO.map((p) => p + '%'));

const SHELLS_FORA_DA_CAMPANHA = Object.freeze(['karate_dojo', 'karate_federation', 'odonto', 'food']);
const SHELL_VAREJO = 'negocio';

const DIAS_DO_CICLO = 14;
const CODIGO_BLACK = 'BLACK50';

const ACAO_VISTO = 'indicacao.banner_visto';
const ACAO_CLIQUE = 'indicacao.banner_clique';
const EVENTOS = Object.freeze({ vista: ACAO_VISTO, clique: ACAO_CLIQUE });

const BANNER = Object.freeze({
  type: 'banner',
  title: 'Conhece outro lojista que ia gostar da Aura?',
  body: 'Indique e ganhe um mês grátis quando ele assinar.',
  ctaLabel: 'Gerar meu código',
  ctaRoute: '/configuracoes?foco=indicacao',
});

// Fim inclusivo da Black Friday: 30/11/2026 23:59:59 em Brasília (UTC-3).
const FIM_BLACK_FRIDAY_INDICACAO = new Date('2026-12-01T02:59:59Z');

const BANNER_BLACK_FRIDAY = Object.freeze({
  ...BANNER,
  title: 'Black Friday: você indica, vocês dois ganham.',
  body: 'Seu indicado tem 50% na primeira mensalidade com o código BLACK50, até 30/11 ou enquanto houver cupons. '
    + 'Quando ele pagar, você ganha 1 mensalidade grátis.',
});

const DIA_MS = 24 * 3600 * 1000;

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

/** Pura: true até FIM_BLACK_FRIDAY_INDICACAO, inclusive. */
function emBlackFridayDaIndicacao(agora) {
  return new Date(agora).getTime() <= FIM_BLACK_FRIDAY_INDICACAO.getTime();
}

/** Pura: 'black' | 'sem_black50' | 'fixo'. */
function faseDoTexto(agora, { black50Esgotado = false } = {}) {
  if (!emBlackFridayDaIndicacao(agora)) return 'fixo';
  return black50Esgotado ? 'sem_black50' : 'black';
}

/** Pura: o texto do banner que vale no instante `agora`. */
function bannerVigente(agora, opts = {}) {
  return faseDoTexto(agora, opts) === 'black' ? BANNER_BLACK_FRIDAY : BANNER;
}

/** Pura: o BLACK50 não pode mais ser usado (linha de access_codes ou null). */
function black50EstaEsgotado(codigo) {
  if (!codigo) return true;
  if (codigo.is_active === false) return true;
  const usos = Number(codigo.uses) || 0;
  const max = Number(codigo.max_uses);
  return Number.isFinite(max) && usos >= max;
}

// Cache curto: o sininho é lido a cada 30 s por empresa; o estado do cupom
// muda no máximo 10 vezes na campanha. Até 5 min de atraso na queda.
const CACHE_BLACK50_MS = 5 * 60 * 1000;
let _cacheBlack50 = null; // { em, esgotado }

/**
 * Lê o estado do BLACK50 em access_codes. Nunca lança: na falha de leitura
 * vale o último estado conhecido; sem histórico, esgotado (na dúvida, não
 * prometer o desconto).
 */
async function lerBlack50Esgotado(db, { now = Date.now(), semCache = false } = {}) {
  if (!semCache && _cacheBlack50 && now - _cacheBlack50.em >= 0 && now - _cacheBlack50.em < CACHE_BLACK50_MS) {
    return _cacheBlack50.esgotado;
  }
  try {
    const { rows } = await db.query(
      'SELECT uses, max_uses, is_active FROM access_codes WHERE code = $1 LIMIT 1',
      [CODIGO_BLACK]
    );
    const esgotado = black50EstaEsgotado((rows || [])[0] || null);
    _cacheBlack50 = { em: now, esgotado };
    return esgotado;
  } catch (err) {
    console.error('[bannerIndicacao] BLACK50 ilegível:', err.message);
    return _cacheBlack50 ? _cacheBlack50.esgotado : true;
  }
}

/** Fase do texto agora, lendo o BLACK50 só quando ainda é Black Friday. */
async function faseAtual(db, { now = Date.now() } = {}) {
  if (!emBlackFridayDaIndicacao(now)) return 'fixo';
  return faseDoTexto(now, { black50Esgotado: await lerBlack50Esgotado(db, { now }) });
}

function lerConfig(env = process.env) {
  return {
    enabled: norm(env.BANNER_INDICACAO_TRIAL_ENABLED) !== 'false',
    dryRun: norm(env.BANNER_INDICACAO_TRIAL_DRY_RUN) === 'true',
    publicar: norm(env.BANNER_INDICACAO_TRIAL_PUBLICAR) !== 'false',
    canaryId: norm(env.CANARY_COMPANY_ID) || null,
  };
}

/** Dia civil de Brasília (UTC-3, sem horário de verão), 'aaaa-mm-dd'. */
function diaBrt(instante) {
  return new Date(new Date(instante).getTime() - 3 * 3600000).toISOString().slice(0, 10);
}

/** Dias de calendário de Brasília entre dois instantes (b - a). */
function diasEntre(a, b) {
  return Math.round((Date.parse(diaBrt(b)) - Date.parse(diaBrt(a))) / DIA_MS);
}

const dedupeKeyDoCiclo = (companyId, agora) => `${PREFIXO_CICLO}${companyId}:${diaBrt(agora)}`;

/** true para as três chaves que este serviço cria. */
function ehChaveDeIndicacao(chave) {
  return typeof chave === 'string' && PREFIXOS_INDICACAO.some((p) => chave.startsWith(p));
}

const ehInterna = (email) => /@getaura\.com\.br\s*$/i.test(String(email || '').trim());

/**
 * A regra. Pura: fatos de UMA empresa → { elegivel, motivo }.
 * fatos: { company_id, shell, company_email, owner_email, is_sandbox,
 *          paga_por_outra, empresa_inativa, ultimo_banner_em }
 */
function avaliarEmpresa(fatos, { agora = new Date(), canaryId = null } = {}) {
  const f = fatos || {};
  const nao = (motivo) => ({ elegivel: false, motivo });

  const shell = f.shell || SHELL_VAREJO;
  if (SHELLS_FORA_DA_CAMPANHA.includes(shell)) return nao('shell_fora_da_campanha');
  if (ehInterna(f.company_email) || ehInterna(f.owner_email)) return nao('conta_interna');
  if (f.is_sandbox === true) return nao('conta_de_teste');
  if (canaryId && String(f.company_id || '').toLowerCase() === canaryId) return nao('canario');
  if (f.paga_por_outra === true) return nao('paga_por_outra');
  if (f.empresa_inativa === true) return nao('empresa_inativa');

  // O ciclo: lido ou dispensado não importa, só a data do último banner.
  if (f.ultimo_banner_em && diasEntre(f.ultimo_banner_em, agora) < DIAS_DO_CICLO) {
    return nao('ciclo_em_andamento');
  }
  return { elegivel: true, motivo: null };
}

/**
 * Fatos de todas as empresas. O corte de shell, conta interna etc. é da
 * função pura; aqui só se junta o último banner de indicação (qualquer das
 * três chaves) de cada empresa.
 */
async function buscarFatos(db) {
  const { rows } = await db.query(
    `SELECT c.id AS company_id,
            COALESCE(c.vertical_active, c.vertical, 'negocio') AS shell,
            c.email AS company_email,
            u.email AS owner_email,
            (c.is_sandbox IS TRUE) AS is_sandbox,
            (c.billing_owner_company_id IS NOT NULL
               AND c.billing_owner_company_id <> c.id) AS paga_por_outra,
            (c.is_active IS FALSE) AS empresa_inativa,
            (SELECT MAX(n.created_at) FROM app_notifications n
              WHERE n.target_company_id = c.id
                AND n.dedupe_key LIKE ANY ($1::text[])
            ) AS ultimo_banner_em
       FROM companies c
       LEFT JOIN users u ON u.id = c.owner_id
      ORDER BY c.created_at, c.id`,
    [LIKES_INDICACAO]
  );
  return rows || [];
}

/** Payload de createAppNotification para a empresa. Puro. */
function montarBanner(companyId, { agora = new Date(), publicar = true, black50Esgotado = false } = {}) {
  const t = bannerVigente(agora, { black50Esgotado });
  return {
    type: t.type,
    title: t.title,
    body: t.body,
    ctaLabel: t.ctaLabel,
    ctaRoute: t.ctaRoute,
    targetCompanyId: companyId,
    expiresAt: new Date(new Date(agora).getTime() + DIAS_DO_CICLO * DIA_MS).toISOString(),
    dedupeKey: dedupeKeyDoCiclo(companyId, agora),
    isActive: publicar !== false,
  };
}

/** Desliga os banners de indicação anteriores ainda ativos da empresa. */
async function desativarAnteriores(db, companyId, chaveAtual) {
  const { rows } = await db.query(
    `UPDATE app_notifications SET is_active = false, updated_at = NOW()
      WHERE target_company_id = $1
        AND dedupe_key LIKE ANY ($2::text[])
        AND dedupe_key <> $3
        AND is_active = true
      RETURNING id`,
    [companyId, LIKES_INDICACAO, chaveAtual]
  );
  return (rows || []).length;
}

/**
 * Uma volta do job. Injetável: { db, notifications, now?, env? }.
 * Nunca grava nada com dryRun.
 */
async function tickBannerIndicacaoTrial({ db, notifications, now = Date.now(), env = process.env } = {}) {
  const cfg = lerConfig(env);
  const resumo = {
    ligado: cfg.enabled, dryRun: cfg.dryRun, publicar: cfg.publicar,
    fase: null, avaliadas: 0, candidatas: 0, criadas: 0, jaExistiam: 0, anterioresDesligados: 0, falhas: 0,
  };
  if (!cfg.enabled) return resumo;

  const agora = new Date(now);
  const black50Esgotado = emBlackFridayDaIndicacao(agora)
    ? await lerBlack50Esgotado(db, { now: agora.getTime(), semCache: true })
    : true;
  resumo.fase = faseDoTexto(agora, { black50Esgotado });

  const fatos = await buscarFatos(db);
  resumo.avaliadas = fatos.length;
  const candidatas = fatos.filter((f) => avaliarEmpresa(f, { agora, canaryId: cfg.canaryId }).elegivel);
  resumo.candidatas = candidatas.length;

  for (const f of candidatas) {
    if (cfg.dryRun) {
      console.log(`[bannerIndicacaoTrial] dry-run: criaria banner para company=${f.company_id}`);
      continue;
    }
    try {
      const payload = montarBanner(f.company_id, { agora, publicar: cfg.publicar, black50Esgotado });
      const banner = await notifications.createAppNotification(payload);
      // null = a chave do ciclo já existe (volta repetida no dia) ou falha de
      // escrita, que o appNotifications já logou.
      if (banner) {
        resumo.criadas++;
        resumo.anterioresDesligados += await desativarAnteriores(db, f.company_id, payload.dedupeKey);
        console.log(`[bannerIndicacaoTrial] banner criado (${cfg.publicar ? 'ativo' : 'inativo'}): `
          + `company=${f.company_id} banner=${banner.id}`);
      } else {
        resumo.jaExistiam++;
      }
    } catch (err) {
      resumo.falhas++;
      console.error(`[bannerIndicacaoTrial] company=${f.company_id}: ${err.message}`);
    }
  }
  return resumo;
}

// ── Leitura do sininho ───────────────────────────────────────────────────

/**
 * Reescreve, na resposta do GET /notifications, o texto dos banners de
 * indicação para a fase de agora e marca `campanha: 'indicacao'` (o app usa
 * para registrar vista e clique). Tira `dedupe_key` da resposta. Só lê o
 * BLACK50 quando há banner de indicação na lista. Nunca lança.
 */
async function textoDosBannersNaLeitura(db, banners, { now = Date.now() } = {}) {
  const lista = Array.isArray(banners) ? banners : [];
  const semChave = ({ dedupe_key, ...b }) => b;
  if (!lista.some((b) => ehChaveDeIndicacao(b && b.dedupe_key))) return lista.map(semChave);
  let fase = 'fixo';
  try { fase = await faseAtual(db, { now }); } catch (_) { /* fica o fixo */ }
  const t = fase === 'black' ? BANNER_BLACK_FRIDAY : BANNER;
  return lista.map((linha) => {
    const b = semChave(linha);
    if (!ehChaveDeIndicacao(linha.dedupe_key)) return b;
    return { ...b, title: t.title, body: t.body, campanha: 'indicacao', fase };
  });
}

// ── Contadores ───────────────────────────────────────────────────────────

/**
 * Registra vista ou clique do banner em audit_log. Uma linha por usuário por
 * banner e por evento; só para banner de indicação DESTA empresa.
 * @returns {Promise<boolean>} true quando gravou.
 */
async function registrarEvento(db, { companyId, userId = null, notificationId, evento, now = Date.now() }) {
  const acao = EVENTOS[evento];
  if (!acao || !companyId || !notificationId) return false;
  const fase = await faseAtual(db, { now });
  const r = await db.query(
    `INSERT INTO audit_log (user_id, company_id, action, detail, metadata)
     SELECT $1::uuid, $2::uuid, $3::text, $4::text,
            jsonb_build_object('notification_id', n.id::text, 'ciclo', n.dedupe_key, 'fase', $5::text)
       FROM app_notifications n
      WHERE n.id = $6::uuid
        AND n.target_company_id = $2::uuid
        AND n.dedupe_key LIKE ANY ($7::text[])
        AND NOT EXISTS (
          SELECT 1 FROM audit_log a
           WHERE a.company_id = $2::uuid
             AND a.action = $3::text
             AND a.metadata->>'notification_id' = n.id::text
             AND a.user_id IS NOT DISTINCT FROM $1::uuid)`,
    [
      userId, companyId, acao,
      evento === 'vista' ? 'Viu o banner de indicação' : 'Clicou em "Gerar meu código" no banner de indicação',
      fase, notificationId, LIKES_INDICACAO,
    ]
  );
  return !!(r && r.rowCount > 0);
}

/**
 * Contadores para o Marketing, de `desde` (inclusive) a `ate` (exclusive).
 * Contas internas (@getaura.com.br) ficam fora de vistas, cliques e
 * indicações.
 */
async function contadores(db, { desde, ate, now = Date.now() } = {}) {
  const ini = new Date(desde || '2026-10-30T03:00:00Z').toISOString();
  const fim = new Date(ate || now + DIA_MS).toISOString();
  const periodo = [ini, fim];
  const comAcoes = [ini, fim, ACAO_VISTO, ACAO_CLIQUE];

  const { rows: [banners] } = await db.query(
    `SELECT COUNT(*)::int AS criados,
            COUNT(DISTINCT n.target_company_id)::int AS empresas,
            COUNT(r.notification_id)::int AS dispensados
       FROM app_notifications n
       LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.company_id = n.target_company_id
      WHERE n.dedupe_key LIKE ANY ($3::text[])
        AND n.created_at >= $1::timestamptz AND n.created_at < $2::timestamptz`,
    [...periodo, LIKES_INDICACAO]
  );

  const { rows: eventos } = await db.query(
    `SELECT a.action,
            COUNT(*)::int AS total,
            COUNT(DISTINCT a.company_id)::int AS empresas,
            COUNT(*) FILTER (WHERE a.metadata->>'fase' = 'black')::int AS na_fase_black
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.action IN ($3::text, $4::text)
        AND a.created_at >= $1::timestamptz AND a.created_at < $2::timestamptz
        AND COALESCE(u.email, '') NOT ILIKE '%@getaura.com.br'
      GROUP BY a.action`,
    comAcoes
  );
  const ev = (acao) => (eventos || []).find((e) => e.action === acao) || { total: 0, empresas: 0, na_fase_black: 0 };

  // Indicação por envio: cadastro por /r/CODIGO (linha em referrals) cujo
  // indicador viu / clicou o banner antes do cadastro.
  const { rows: [ind] } = await db.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM audit_log a
               WHERE a.user_id = rf.referrer_id AND a.action = $4::text
                 AND a.created_at < rf.created_at))::int AS depois_do_clique,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM audit_log a
               WHERE a.user_id = rf.referrer_id AND a.action IN ($3::text, $4::text)
                 AND a.created_at < rf.created_at))::int AS depois_da_vista
       FROM referrals rf
       LEFT JOIN users u ON u.id = rf.referrer_id
      WHERE rf.created_at >= $1::timestamptz AND rf.created_at < $2::timestamptz
        AND COALESCE(u.email, '') NOT ILIKE '%@getaura.com.br'`,
    comAcoes
  );

  const { rows: [black] } = await db.query(
    'SELECT uses, max_uses, is_active FROM access_codes WHERE code = $1 LIMIT 1',
    [CODIGO_BLACK]
  );

  const vistas = ev(ACAO_VISTO);
  const cliques = ev(ACAO_CLIQUE);
  return {
    periodo: { desde: ini, ate: fim },
    fase_agora: faseDoTexto(now, { black50Esgotado: black50EstaEsgotado(black || null) }),
    banners: {
      criados: (banners && banners.criados) || 0,
      empresas: (banners && banners.empresas) || 0,
      dispensados: (banners && banners.dispensados) || 0,
    },
    vistas: { total: vistas.total, empresas: vistas.empresas, na_fase_black: vistas.na_fase_black },
    cliques_gerar_codigo: { total: cliques.total, empresas: cliques.empresas, na_fase_black: cliques.na_fase_black },
    indicacoes: {
      cadastros_por_link: (ind && ind.total) || 0,
      depois_do_clique_no_banner: (ind && ind.depois_do_clique) || 0,
      depois_de_ver_o_banner: (ind && ind.depois_da_vista) || 0,
    },
    black50: black
      ? {
        usos: Number(black.uses) || 0,
        limite: Number(black.max_uses) || 0,
        ativo: black.is_active !== false,
        esgotado: black50EstaEsgotado(black),
      }
      : { usos: 0, limite: 0, ativo: false, esgotado: true },
  };
}

// Só para teste.
function _resetCacheForTests() { _cacheBlack50 = null; }

module.exports = {
  tickBannerIndicacaoTrial,
  avaliarEmpresa,
  buscarFatos,
  montarBanner,
  desativarAnteriores,
  lerConfig,
  dedupeKeyDoCiclo,
  ehChaveDeIndicacao,
  diaBrt,
  diasEntre,
  faseDoTexto,
  faseAtual,
  bannerVigente,
  black50EstaEsgotado,
  lerBlack50Esgotado,
  textoDosBannersNaLeitura,
  registrarEvento,
  contadores,
  emBlackFridayDaIndicacao,
  SHELLS_FORA_DA_CAMPANHA,
  PREFIXO_DEDUPE,
  PREFIXO_DEDUPE_BF,
  PREFIXO_CICLO,
  PREFIXOS_INDICACAO,
  DIAS_DO_CICLO,
  CODIGO_BLACK,
  ACAO_VISTO,
  ACAO_CLIQUE,
  BANNER,
  BANNER_BLACK_FRIDAY,
  FIM_BLACK_FRIDAY_INDICACAO,
  _resetCacheForTests,
};
