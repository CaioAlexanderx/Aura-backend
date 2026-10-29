// ============================================================
// AURA. — Banner "Indique um lojista" durante o teste (14/10/2026)
//
// Pedido do Caio: toda empresa de varejo que está testando a Aura recebe, no
// sininho, o convite para indicar um lojista e ganhar o mês grátis. Um banner
// por empresa.
//
// 24/10/2026 (item 15, aprovado pelo Caio): o convite só sai depois da
// primeira venda. A empresa precisa ter pelo menos 1 venda NÃO cancelada
// (sales.status <> 'cancelled', o mesmo critério do resto do backend); sem
// venda, ou só com venda cancelada, não recebe. Texto novo, curto; quem já
// recebeu o banner antigo não recebe outro (mesma dedupe_key).
//
// A regra mora numa função pura (avaliarEmpresa) que recebe os fatos de uma
// empresa; a consulta (buscarFatos) só junta esses fatos. Assim cada critério
// é testável sozinho e o SQL não duplica a regra.
//
// Idempotência: dedupe_key 'indicacao-trial:<company_id>' (índice único
// parcial da 285). Banner criado à mão com a mesma chave conta como "já tem
// banner" e o job não cria outro por cima.
//
// Chaves de ambiente (lidas a cada volta, nada fica congelado no boot):
//   BANNER_INDICACAO_TRIAL_ENABLED  = false  DESLIGA o job (kill switch;
//                                            padrão: ligado)
//   BANNER_INDICACAO_TRIAL_DRY_RUN  = true   só loga quem seria criado
//   BANNER_INDICACAO_TRIAL_PUBLICAR = false  cria o banner INATIVO
//                                            (padrão: nasce ativo)
//
// Notificar nunca derruba nada: quem chama (job) só loga a falha.
// ============================================================
'use strict';

const PREFIXO_DEDUPE = 'indicacao-trial:';

// Quanto tempo o banner fica no ar depois de criado.
const DIAS_NO_AR = 7;

const SHELL_VAREJO = 'negocio';

const BANNER = Object.freeze({
  type: 'banner',
  title: 'Conhece outro lojista que ia gostar da Aura?',
  body: 'Indique e ganhe um mês grátis quando ele assinar.',
  ctaLabel: 'Gerar meu código',
  // Configurações já focada no cartão "Indique e ganhe". O app só reescreve a
  // rota pelo título antigo ("Indique um lojista"), que o título novo não tem:
  // por isso o foco vai explícito na rota.
  ctaRoute: '/configuracoes?foco=indicacao',
});

// 28/10/2026 (Black Friday, aprovado pelo Caio e pelo Marketing): até o fim
// de 30/11/2026 no horário de Brasília o banner leva o texto da campanha
// BLACK50; depois desse instante volta sozinho ao BANNER acima, sem deploy.
// Só o texto muda: público, rota, validade, dedupe e regras de desconto,
// cupom e crédito continuam os mesmos.
// Fim inclusivo: 30/11/2026 23:59:59 em Brasília (UTC-3).
const FIM_BLACK_FRIDAY_INDICACAO = new Date('2026-12-01T02:59:59Z');

const BANNER_BLACK_FRIDAY = Object.freeze({
  ...BANNER,
  title: 'Black Friday: você indica, vocês dois ganham.',
  body: 'Seu indicado tem 50% na primeira mensalidade com o código BLACK50, até 30/11 ou enquanto houver cupons. '
    + 'Quando ele pagar, você ganha 1 mensalidade grátis.',
});

/** Pura: true até FIM_BLACK_FRIDAY_INDICACAO, inclusive. Sem data de início. */
function emBlackFridayDaIndicacao(agora) {
  return new Date(agora).getTime() <= FIM_BLACK_FRIDAY_INDICACAO.getTime();
}

/** Pura: o texto do banner que vale no instante `agora`. */
function bannerVigente(agora) {
  return emBlackFridayDaIndicacao(agora) ? BANNER_BLACK_FRIDAY : BANNER;
}

const DIA_MS = 24 * 3600 * 1000;

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

/**
 * Lê as chaves de ambiente. `env` é injetável para teste.
 * ENABLED e PUBLICAR são ligados por padrão: só o texto "false" desliga.
 * DRY_RUN é desligado por padrão: só o texto "true" liga.
 */
function lerConfig(env = process.env) {
  return {
    enabled: norm(env.BANNER_INDICACAO_TRIAL_ENABLED) !== 'false',
    dryRun: norm(env.BANNER_INDICACAO_TRIAL_DRY_RUN) === 'true',
    publicar: norm(env.BANNER_INDICACAO_TRIAL_PUBLICAR) !== 'false',
    canaryId: norm(env.CANARY_COMPANY_ID) || null,
  };
}

const dedupeKeyDe = (companyId) => PREFIXO_DEDUPE + companyId;

const ehInterna = (email) => /@getaura\.com\.br\s*$/i.test(String(email || '').trim());

/**
 * A regra. Pura: recebe os fatos de UMA empresa e devolve
 * { elegivel, motivo } — `motivo` é o primeiro critério que falhou.
 *
 * fatos: { company_id, shell, company_email, owner_email, is_sandbox,
 *          paga_por_outra, trial_ends_at, tem_assinatura, billing_status,
 *          email_verificado, tem_venda, ja_tem_banner }
 */
function avaliarEmpresa(fatos, { agora = new Date(), canaryId = null } = {}) {
  const f = fatos || {};
  const nao = (motivo) => ({ elegivel: false, motivo });

  // Varejo (shell Negócio), fora conta interna, de teste e o canário.
  if ((f.shell || SHELL_VAREJO) !== SHELL_VAREJO) return nao('fora_do_shell_negocio');
  if (ehInterna(f.company_email) || ehInterna(f.owner_email)) return nao('conta_interna');
  if (f.is_sandbox === true) return nao('conta_de_teste');
  if (canaryId && String(f.company_id || '').toLowerCase() === canaryId) return nao('canario');
  // Filial paga por outra empresa: o teste e a assinatura são da matriz.
  if (f.paga_por_outra === true) return nao('paga_por_outra');

  // Em teste (trial vigente) e sem assinatura.
  const fim = f.trial_ends_at ? new Date(f.trial_ends_at).getTime() : NaN;
  if (!Number.isFinite(fim)) return nao('sem_fim_de_teste');
  if (!(fim > agora.getTime())) return nao('teste_vencido');
  if (f.tem_assinatura === true) return nao('com_assinatura');
  if ((f.billing_status == null ? 'trial' : String(f.billing_status)) === 'active') return nao('com_assinatura');

  // Dono com e-mail verificado.
  if (f.email_verificado !== true) return nao('email_nao_verificado');

  // Pelo menos 1 venda não cancelada (item 15, 24/10/2026).
  if (f.tem_venda !== true) return nao('sem_venda');

  // Um banner por empresa (inclui os criados à mão com a mesma chave).
  if (f.ja_tem_banner === true) return nao('ja_tem_banner');

  return { elegivel: true, motivo: null };
}

/**
 * Fatos das empresas que ainda podem ser candidatas. O corte barato fica no
 * SQL (teste vigente e sem assinatura: dezenas de linhas); o resto da regra
 * é avaliarEmpresa. `agora` entra como parâmetro: o resultado de uma volta
 * não depende do relógio do banco.
 */
async function buscarFatos(db, agora = new Date()) {
  const { rows } = await db.query(
    `SELECT c.id AS company_id,
            COALESCE(c.vertical_active, c.vertical, 'negocio') AS shell,
            c.email AS company_email,
            u.email AS owner_email,
            (u.email_verified IS TRUE) AS email_verificado,
            (c.is_sandbox IS TRUE) AS is_sandbox,
            (c.billing_owner_company_id IS NOT NULL
               AND c.billing_owner_company_id <> c.id) AS paga_por_outra,
            c.trial_ends_at,
            c.billing_status,
            (c.asaas_subscription_id IS NOT NULL) AS tem_assinatura,
            EXISTS (SELECT 1 FROM sales s
                     WHERE s.company_id = c.id
                       AND COALESCE(s.status, 'completed') <> 'cancelled'
            ) AS tem_venda,
            EXISTS (SELECT 1 FROM app_notifications b
                     WHERE b.dedupe_key = $2::text || c.id::text
            ) AS ja_tem_banner
       FROM companies c
       LEFT JOIN users u ON u.id = c.owner_id
      WHERE c.trial_ends_at > $1::timestamptz
        AND c.asaas_subscription_id IS NULL
      ORDER BY c.trial_ends_at, c.id`,
    [agora.toISOString(), PREFIXO_DEDUPE]
  );
  return rows || [];
}

/** Payload de createAppNotification para a empresa. Puro. */
function montarBanner(companyId, { agora = new Date(), publicar = true } = {}) {
  const texto = bannerVigente(agora);
  return {
    type: texto.type,
    title: texto.title,
    body: texto.body,
    ctaLabel: texto.ctaLabel,
    ctaRoute: texto.ctaRoute,
    targetCompanyId: companyId,
    expiresAt: new Date(agora.getTime() + DIAS_NO_AR * DIA_MS).toISOString(),
    dedupeKey: dedupeKeyDe(companyId),
    isActive: publicar !== false,
  };
}

// Empresa que assinou: o convite de teste perde o sentido. Desativa os
// banners de indicação ainda ativos dela (o banner some do sininho; a linha
// fica para auditoria).
async function desativarDeQuemAssinou(db, { dryRun = false } = {}) {
  const alvo = `FROM app_notifications n
                 WHERE n.dedupe_key LIKE $1
                   AND n.is_active = true
                   AND n.target_company_id IN (
                     SELECT c.id FROM companies c WHERE c.billing_status = 'active'
                   )`;
  const like = PREFIXO_DEDUPE + '%';
  if (dryRun) {
    const { rows } = await db.query(`SELECT n.id, n.target_company_id ${alvo}`, [like]);
    return (rows || []).map((r) => ({ id: r.id, company_id: r.target_company_id }));
  }
  const { rows } = await db.query(
    `UPDATE app_notifications SET is_active = false, updated_at = NOW()
      WHERE id IN (SELECT n.id ${alvo})
      RETURNING id, target_company_id`,
    [like]
  );
  return (rows || []).map((r) => ({ id: r.id, company_id: r.target_company_id }));
}

/**
 * Uma volta do job. Injetável: { db, notifications, now?, env? }.
 * `notifications` precisa expor createAppNotification (services/appNotifications).
 * Devolve o resumo; nunca grava nada com dryRun.
 */
async function tickBannerIndicacaoTrial({ db, notifications, now = Date.now(), env = process.env } = {}) {
  const cfg = lerConfig(env);
  const resumo = {
    ligado: cfg.enabled, dryRun: cfg.dryRun, publicar: cfg.publicar,
    avaliadas: 0, candidatas: 0, criadas: 0, jaExistiam: 0, desativadas: 0, falhas: 0,
  };
  if (!cfg.enabled) return resumo;

  const agora = new Date(now);

  const desativadas = await desativarDeQuemAssinou(db, { dryRun: cfg.dryRun });
  resumo.desativadas = desativadas.length;
  for (const d of desativadas) {
    console.log(`[bannerIndicacaoTrial] ${cfg.dryRun ? 'desativaria' : 'desativado'}: `
      + `company=${d.company_id} banner=${d.id} (empresa assinou)`);
  }

  const fatos = await buscarFatos(db, agora);
  resumo.avaliadas = fatos.length;
  const candidatas = fatos.filter((f) => avaliarEmpresa(f, { agora, canaryId: cfg.canaryId }).elegivel);
  resumo.candidatas = candidatas.length;

  for (const f of candidatas) {
    if (cfg.dryRun) {
      console.log(`[bannerIndicacaoTrial] dry-run: criaria banner para company=${f.company_id}`);
      continue;
    }
    try {
      const banner = await notifications.createAppNotification(
        montarBanner(f.company_id, { agora, publicar: cfg.publicar })
      );
      // null = a chave já existe (outra instância, volta anterior ou banner
      // criado à mão) ou falha de escrita, que o appNotifications já logou.
      if (banner) {
        resumo.criadas++;
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

module.exports = {
  tickBannerIndicacaoTrial,
  avaliarEmpresa,
  buscarFatos,
  montarBanner,
  desativarDeQuemAssinou,
  lerConfig,
  dedupeKeyDe,
  PREFIXO_DEDUPE,
  DIAS_NO_AR,
  BANNER,
  BANNER_BLACK_FRIDAY,
  FIM_BLACK_FRIDAY_INDICACAO,
  emBlackFridayDaIndicacao,
  bannerVigente,
};
