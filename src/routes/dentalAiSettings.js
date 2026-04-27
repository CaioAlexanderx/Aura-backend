// ============================================================
// AURA. — IA Modo Consulta · settings da empresa
// PR18 (2026-04-27)
//
// Endpoints da tela "Configuracoes > IA Aura":
//
//   GET   /companies/:cid/dental/ai/settings
//     → estado atual (ai_enabled, consent, quota, plano)
//
//   PATCH /companies/:cid/dental/ai/settings
//     → atualiza ai_enabled (true/false)
//     → ao ativar pela 1a vez, exige body.accept_consent=true
//
//   POST  /companies/:cid/dental/ai/settings/consent
//     → registra aceite do termo LGPD (ai_consent_at + version)
//
// Gate: plano=expansao + vertical=odonto. NAO exige ai_enabled
// (precisa ser reachable pra ATIVAR). Sem opt-in implicito —
// dentista precisa clicar "ativar" + aceitar termo explicitamente.
// ============================================================

const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const { requireRole } = require('../middleware/auth');

const CONSENT_VERSION = 'v1.0';

const CONSENT_TEXT = `Ao ativar a IA Aura no Modo Consulta, voce concorda em enviar dados clinicos do paciente (anamnese, transcricoes da consulta, queixa e procedimento) ao servico LLM Anthropic Claude para gerar sugestoes de apoio clinico.

Os dados nao sao usados para treino de modelo. Anthropic retem o conteudo apenas pelo periodo necessario ao processamento da requisicao (vide DPA Anthropic).

A IA e ferramenta de APOIO. Diagnostico e conduta clinica sao decisao exclusiva do(a) cirurgiao-dentista responsavel.

Consentimento individual do paciente para uso de IA no atendimento e responsabilidade da clinica conforme LGPD Art. 11.

Para mais detalhes, leia a Politica de Privacidade da Aura.`;

// ─────────────────────────────────────────────────────────
// Gate: plan=expansao + vertical=odonto (sem ai_enabled)
// ─────────────────────────────────────────────────────────
async function requirePlanExpansaoOdonto(req, res, next) {
  const cid = req.params.id;
  try {
    const { rows } = await db.query(
      `SELECT plan, vertical_active FROM companies WHERE id = $1`,
      [cid]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Empresa nao encontrada' });
    if (rows[0].plan !== 'expansao') {
      return res.status(403).json({
        error: 'IA Aura disponivel apenas no plano Expansao',
        required_plan: 'expansao',
        current_plan: rows[0].plan,
      });
    }
    if (rows[0].vertical_active !== 'odonto') {
      return res.status(403).json({
        error: 'Configuracoes de IA Odonto requerem vertical Odonto ativa',
      });
    }
    next();
  } catch (err) {
    console.error('[dentalAiSettings] gate error:', err);
    res.status(500).json({ error: 'Erro ao verificar acesso' });
  }
}

// Apenas client (dono) ou admin podem mexer em settings de IA
router.use(requireRole('client', 'admin'), requirePlanExpansaoOdonto);

// ─────────────────────────────────────────────────────────
// GET / — estado atual
// ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows } = await db.query(
      `SELECT plan, vertical_active,
              ai_enabled, ai_consent_at, ai_consent_version, ai_monthly_quota
         FROM companies WHERE id = $1`,
      [cid]
    );
    const c = rows[0] || {};

    // Uso do mes corrente
    const { rows: usage } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'ok')::int AS used,
         COALESCE(SUM(cost_usd), 0)::numeric(10,4) AS cost_usd
       FROM ai_usage_log
      WHERE company_id = $1 AND feature = 'consulta'
        AND created_at >= date_trunc('month', NOW())`,
      [cid]
    );

    res.json({
      plan: c.plan,
      vertical_active: c.vertical_active,
      ai_enabled: !!c.ai_enabled,
      ai_consent_at: c.ai_consent_at,
      ai_consent_version: c.ai_consent_version,
      ai_consent_current_version: CONSENT_VERSION,
      ai_consent_outdated: c.ai_consent_at && c.ai_consent_version !== CONSENT_VERSION,
      quota_total:     c.ai_monthly_quota,
      quota_used:      usage[0]?.used || 0,
      quota_remaining: c.ai_monthly_quota == null ? null : Math.max(0, c.ai_monthly_quota - (usage[0]?.used || 0)),
      cost_usd_month: parseFloat(usage[0]?.cost_usd || 0),
      consent_text: CONSENT_TEXT,
    });
  } catch (err) {
    console.error('[dentalAiSettings] GET error:', err);
    res.status(500).json({ error: 'Erro ao buscar configuracoes' });
  }
});

// ─────────────────────────────────────────────────────────
// PATCH / — toggle ai_enabled.
// Ao ativar pela 1a vez (sem consent previo), exige
// accept_consent=true no body.
// ─────────────────────────────────────────────────────────
router.patch('/', async (req, res) => {
  const cid = req.params.id;
  const { ai_enabled, accept_consent } = req.body || {};

  if (typeof ai_enabled !== 'boolean') {
    return res.status(400).json({ error: 'ai_enabled (boolean) e obrigatorio' });
  }

  try {
    if (ai_enabled) {
      // Ativando — verifica se ja tem consent valido
      const { rows } = await db.query(
        `SELECT ai_consent_at, ai_consent_version FROM companies WHERE id = $1`,
        [cid]
      );
      const hasConsent = rows[0]?.ai_consent_at && rows[0]?.ai_consent_version === CONSENT_VERSION;
      if (!hasConsent && !accept_consent) {
        return res.status(400).json({
          error: 'Para ativar a IA, aceite o termo de uso (accept_consent=true)',
          consent_required: true,
          consent_version: CONSENT_VERSION,
        });
      }
      // Aceita consent + ativa em uma operacao atomica
      const fields = ['ai_enabled = true'];
      const params = [cid];
      if (!hasConsent) {
        fields.push(`ai_consent_at = NOW(), ai_consent_version = '${CONSENT_VERSION}'`);
      }
      await db.query(`UPDATE companies SET ${fields.join(', ')} WHERE id = $${params.length}`, params);
    } else {
      await db.query(`UPDATE companies SET ai_enabled = false WHERE id = $1`, [cid]);
    }

    res.json({ ok: true, ai_enabled });
  } catch (err) {
    console.error('[dentalAiSettings] PATCH error:', err);
    res.status(500).json({ error: 'Erro ao atualizar configuracoes' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /consent — registra aceite explicito do termo
// (separado pra UX onde a empresa quer aceitar SEM ativar agora)
// ─────────────────────────────────────────────────────────
router.post('/consent', async (req, res) => {
  const cid = req.params.id;
  try {
    await db.query(
      `UPDATE companies
          SET ai_consent_at = NOW(),
              ai_consent_version = $2
        WHERE id = $1`,
      [cid, CONSENT_VERSION]
    );
    res.json({ ok: true, consent_version: CONSENT_VERSION, consent_at: new Date().toISOString() });
  } catch (err) {
    console.error('[dentalAiSettings] consent error:', err);
    res.status(500).json({ error: 'Erro ao registrar aceite' });
  }
});

module.exports = router;
