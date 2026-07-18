// ============================================================
// AURA KARATÊ — F0 Aura Dojô: convite de claim da conta do dojô (federação)
//
// Montado em /federation/:id/dojos (mergeParams, junto às rotas de dojôs):
//   POST   /federation/:id/dojos/:dojoId/claim-invite   (staffWrite) {email}
//   GET    /federation/:id/dojos/:dojoId/claim-invite   (read) — status
//   DELETE /federation/:id/dojos/:dojoId/claim-invite   (staffWrite) — revoga
//
// POST valida que o owner atual do dojô ainda é o user-sistema
// ('!locked-system-no-login', ver karateDojos.js). Dojô já reclamado →
// 409 DOJO_JA_RECLAMADO. Cria o convite (TTL 7 dias, invalida pendentes
// anteriores) e envia e-mail via karateMailer com o link público
//   https://app.getaura.com.br/karate/claim?t={token}
// O token NUNCA sai na resposta da API — só no e-mail do sensei.
//
// GET devolve apenas status (pending/used/expired/none) — nunca o token.
//
// Migration 240 NÃO aplicada: 42P01 tratado de forma defensiva
// (armadilha_schema_pre_migration do CLAUDE.md).
// ============================================================
'use strict';

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { guards } = require('../config/karateRoles');
const claimService = require('../services/karateDojoClaimService');

const CLAIM_BASE_URL = process.env.KARATE_CLAIM_BASE_URL || 'https://app.getaura.com.br/karate/claim';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let karateMailer = null;
try { karateMailer = require('../services/karateMailer'); } catch (_) {}

// Escapa HTML nos valores interpolados no corpo do e-mail (nome do dojô/
// federação vêm do banco — editáveis pela federação).
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// POST /federation/:id/dojos/:dojoId/claim-invite  {email}
router.post('/:dojoId/claim-invite', ...guards.staffWrite(), async (req, res) => {
  const federationId = req.params.id;
  const dojoId = req.params.dojoId;
  const email = String((req.body && req.body.email) || '').toLowerCase().trim();
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(422).json({ error: 'E-mail inválido', code: 'VALIDATION_ERROR' });
  }

  try {
    const result = await claimService.createInvite({
      federationId,
      dojoId,
      email,
      createdBy: (req.user && req.user.id) || null,
    });
    if (!result.ok) {
      return res.status(result.http).json({ error: result.error, code: result.code });
    }

    const link = `${CLAIM_BASE_URL}?t=${result.token}`;
    let emailSent = false;
    // Envio best-effort FORA de transação (não há BEGIN aqui): se o e-mail
    // falhar, o convite existe e a federação pode revogar/reenviar.
    try {
      if (karateMailer && karateMailer.sendKarateEmail) {
        await karateMailer.sendKarateEmail(email, {
          subject: `Convite: assuma a conta do ${result.dojo_name} no Aura Karatê`,
          heading: 'Convite para assumir a conta do dojô',
          bodyHtml:
            `<p style="font-size:14px;color:#44403c;line-height:22px;margin:0 0 14px;">` +
            `A ${esc(result.federation_name)} convidou você a assumir a conta do ` +
            `<strong>${esc(result.dojo_name)}</strong> no Aura Karatê.</p>` +
            `<p style="font-size:13px;color:#78716c;line-height:21px;margin:0;">` +
            `O link vale por ${claimService.INVITE_TTL_DAYS} dias. Ao abrir, você define sua senha ` +
            `e passa a ser o responsável pela conta do dojô.</p>`,
          text:
            `A ${result.federation_name} convidou você a assumir a conta do ${result.dojo_name} no Aura Karatê. ` +
            `Defina sua senha em: ${link} (válido por ${claimService.INVITE_TTL_DAYS} dias).`,
          ctaUrl: link,
          ctaLabel: 'Definir minha senha',
          federationName: result.federation_name,
          federationSlug: result.federation_slug,
        });
        emailSent = true;
      }
    } catch (e) {
      console.error('[karateDojoClaim] falha ao enviar e-mail de convite:', e.message);
    }

    return res.status(201).json({ ok: true, expires_at: result.expires_at, email_sent: emailSent });
  } catch (e) {
    if (e.code === '42P01') {
      return res.status(503).json({ error: 'Convites indisponíveis (migration 240 pendente)', code: 'MIGRATION_PENDING' });
    }
    console.error('[karateDojoClaim] create error:', e);
    return res.status(500).json({ error: 'Erro ao criar convite' });
  }
});

// GET /federation/:id/dojos/:dojoId/claim-invite — status do convite
// (pending/used/expired/none). NUNCA devolve o token (nem existe em claro).
router.get('/:dojoId/claim-invite', ...guards.read(), async (req, res) => {
  try {
    const d = await db.query(
      `SELECT id FROM companies WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo' LIMIT 1`,
      [req.params.dojoId, req.params.id]
    );
    if (!d.rows.length) {
      return res.status(404).json({ error: 'Dojô não encontrado', code: 'NOT_FOUND' });
    }
    const r = await db.query(
      `SELECT email, expires_at, used_at, created_at
         FROM karate_dojo_owner_invites
        WHERE dojo_id = $1 AND federation_id = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [req.params.dojoId, req.params.id]
    );
    if (!r.rows.length) return res.json({ status: 'none' });
    const inv = r.rows[0];
    const status = inv.used_at
      ? 'used'
      : (new Date(inv.expires_at) <= new Date() ? 'expired' : 'pending');
    return res.json({ status, email: inv.email, expires_at: inv.expires_at, used_at: inv.used_at });
  } catch (e) {
    if (e.code === '42P01') return res.json({ status: 'none', migration_pending: true });
    console.error('[karateDojoClaim] status error:', e);
    return res.status(500).json({ error: 'Erro ao consultar convite' });
  }
});

// DELETE /federation/:id/dojos/:dojoId/claim-invite — revoga pendentes
router.delete('/:dojoId/claim-invite', ...guards.staffWrite(), async (req, res) => {
  try {
    const r = await db.query(
      `UPDATE karate_dojo_owner_invites
          SET expires_at = NOW()
        WHERE dojo_id = $1 AND federation_id = $2 AND used_at IS NULL AND expires_at > NOW()`,
      [req.params.dojoId, req.params.id]
    );
    return res.json({ ok: true, revoked: r.rowCount || 0 });
  } catch (e) {
    if (e.code === '42P01') return res.json({ ok: true, revoked: 0, migration_pending: true });
    console.error('[karateDojoClaim] revoke error:', e);
    return res.status(500).json({ error: 'Erro ao revogar convite' });
  }
});

module.exports = router;
