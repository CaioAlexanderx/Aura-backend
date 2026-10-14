// ============================================================
// AURA. — Banner "Indique um lojista" durante o teste (14/10/2026)
//
// Pedido do board (Teo, frente Tecnologia): a empresa que está testando a
// Aura, já vendeu e ainda não foi abordada por ninguém recebe, no sininho,
// o convite para indicar um lojista e ganhar o mês grátis.
//
// O banner nasce INATIVO. A Cassie aprova na leitura das 07h30 e o Teo
// ativa por UPDATE (ver o SQL no PR). Só com BANNER_INDICACAO_TRIAL_PUBLICAR
// =true ele nasce ativo. Sem migration: usa app_notifications (285) e o
// dedupe_key para nunca criar dois banners para a mesma empresa.
//
// A regra mora numa função pura (avaliarEmpresa) que recebe os fatos de uma
// empresa; a consulta (buscarFatos) só junta esses fatos. Assim cada critério
// é testável sozinho e o SQL não duplica a regra.
//
// Chaves de ambiente (lidas a cada volta, nada fica congelado no boot):
//   BANNER_INDICACAO_TRIAL_ENABLED  = true  liga o job (padrão: desligado)
//   BANNER_INDICACAO_TRIAL_DRY_RUN  = true  só loga quem seria criado
//   BANNER_INDICACAO_TRIAL_PUBLICAR = true  banner nasce ativo (padrão: inativo)
//
// Notificar nunca derruba nada: quem chama (job) só loga a falha.
// ============================================================
'use strict';

const PREFIXO_DEDUPE = 'indicacao-trial:';

// Dias de teste que ainda precisam sobrar: perto do fim do teste o assunto
// é a assinatura, não a indicação.
const DIAS_MINIMOS_DE_TESTE = 3;
// Janela da "conversa recente" (company_admin_notes com canal).
const DIAS_SEM_CONVERSA = 3;
// Quanto tempo o banner fica no ar depois de criado.
const DIAS_NO_AR = 7;

const SHELL_VAREJO = 'negocio';

const BANNER = Object.freeze({
  type: 'banner',
  title: 'Indique um lojista e ganhe seu mês grátis',
  body: 'Gere seu código em Configurações. Quando o lojista que você indicar pagar a primeira mensalidade, '
    + 'seu mês grátis fica reservado por 60 dias a partir desse pagamento: assine a Aura nesse prazo e a '
    + 'sua segunda mensalidade sai por nossa conta.',
  ctaLabel: 'Gerar meu código',
  ctaRoute: '/configuracoes',
});

const DIA_MS = 24 * 3600 * 1000;

const ehVerdadeiro = (v) => String(v == null ? '' : v).trim().toLowerCase() === 'true';

/** Lê as três chaves de ambiente. `env` é injetável para teste. */
function lerConfig(env = process.env) {
  return {
    enabled: ehVerdadeiro(env.BANNER_INDICACAO_TRIAL_ENABLED),
    dryRun: ehVerdadeiro(env.BANNER_INDICACAO_TRIAL_DRY_RUN),
    publicar: ehVerdadeiro(env.BANNER_INDICACAO_TRIAL_PUBLICAR),
    canaryId: String(env.CANARY_COMPANY_ID || '').trim().toLowerCase() || null,
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
 *          tem_venda, conversa_recente, avisou_checkout, email_verificado,
 *          ja_tem_banner }
 */
function avaliarEmpresa(fatos, { agora = new Date(), canaryId = null } = {}) {
  const f = fatos || {};
  const nao = (motivo) => ({ elegivel: false, motivo });

  // 1. Varejo (shell Negócio), fora conta interna, de teste e o canário.
  if ((f.shell || SHELL_VAREJO) !== SHELL_VAREJO) return nao('fora_do_shell_negocio');
  if (ehInterna(f.company_email) || ehInterna(f.owner_email)) return nao('conta_interna');
  if (f.is_sandbox === true) return nao('conta_de_teste');
  if (canaryId && String(f.company_id || '').toLowerCase() === canaryId) return nao('canario');
  // Filial paga por outra empresa: o teste e a assinatura são da matriz.
  if (f.paga_por_outra === true) return nao('paga_por_outra');

  // 2. Em teste, com mais de 3 dias restantes, sem assinatura.
  const fim = f.trial_ends_at ? new Date(f.trial_ends_at).getTime() : NaN;
  if (!Number.isFinite(fim)) return nao('sem_fim_de_teste');
  if (!(fim > agora.getTime() + DIAS_MINIMOS_DE_TESTE * DIA_MS)) return nao('teste_perto_do_fim_ou_vencido');
  if (f.tem_assinatura === true) return nao('com_assinatura');
  if ((f.billing_status == null ? 'trial' : String(f.billing_status)) === 'active') return nao('com_assinatura');

  // 3. Pelo menos uma venda (cancelada não conta; a consulta já filtra).
  if (f.tem_venda !== true) return nao('sem_venda');

  // 4. Sem conversa registrada nos últimos 3 dias.
  if (f.conversa_recente === true) return nao('conversa_recente');

  // 5. Sem aviso de fim de teste.
  if (f.avisou_checkout === true) return nao('aviso_de_fim_de_teste');

  // 6. Dono com e-mail verificado.
  if (f.email_verificado !== true) return nao('email_nao_verificado');

  // 7. Sem banner de indicação anterior.
  if (f.ja_tem_banner === true) return nao('ja_tem_banner');

  return { elegivel: true, motivo: null };
}

/**
 * Fatos das empresas que ainda podem ser candidatas. O corte barato fica no
 * SQL (teste no futuro e sem assinatura: dezenas de linhas); o resto da
 * regra é avaliarEmpresa. `agora` entra como parâmetro: o resultado de uma
 * volta não depende do relógio do banco.
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
                       AND COALESCE(s.status, 'completed') NOT IN ('cancelled', 'canceled', 'refunded', 'estornada')
            ) AS tem_venda,
            EXISTS (SELECT 1 FROM company_admin_notes n
                     WHERE n.company_id = c.id
                       AND n.canal IS NOT NULL
                       AND n.created_at > $1::timestamptz - make_interval(days => $2::int)
            ) AS conversa_recente,
            EXISTS (SELECT 1 FROM admin_audit_log a
                     WHERE a.company_id = c.id AND a.action = 'notify_checkout'
            ) AS avisou_checkout,
            EXISTS (SELECT 1 FROM app_notifications b
                     WHERE b.dedupe_key = $3::text || c.id::text
            ) AS ja_tem_banner
       FROM companies c
       LEFT JOIN users u ON u.id = c.owner_id
      WHERE c.trial_ends_at > $1::timestamptz
        AND c.asaas_subscription_id IS NULL
      ORDER BY c.trial_ends_at, c.id`,
    [agora.toISOString(), DIAS_SEM_CONVERSA, PREFIXO_DEDUPE]
  );
  return rows || [];
}

/** Payload de createAppNotification para a empresa. Puro. */
function montarBanner(companyId, { agora = new Date(), publicar = false } = {}) {
  return {
    type: BANNER.type,
    title: BANNER.title,
    body: BANNER.body,
    ctaLabel: BANNER.ctaLabel,
    ctaRoute: BANNER.ctaRoute,
    targetCompanyId: companyId,
    expiresAt: new Date(agora.getTime() + DIAS_NO_AR * DIA_MS).toISOString(),
    dedupeKey: dedupeKeyDe(companyId),
    isActive: publicar === true,
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
      // null = a chave já existe (outra instância, ou volta anterior) ou falha
      // de escrita, que o appNotifications já logou.
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
  DIAS_MINIMOS_DE_TESTE,
  DIAS_SEM_CONVERSA,
  DIAS_NO_AR,
  BANNER,
};
