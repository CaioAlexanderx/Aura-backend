// ============================================================
// AURA. — Payslip Email Route
// POST /companies/:id/employees/:eid/payslip/email
// Sends payslip HTML via Resend to employee's email
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.SMTP_FROM || 'Aura. <noreply@getaura.com.br>';
const ICON_URL = 'https://cdn.jsdelivr.net/gh/CaioAlexanderx/aura-app@main/assets/Icon.png';

// POST /:eid/payslip/email
router.post('/:eid/payslip/email', async (req, res) => {
  const { id: cid, eid } = req.params;
  const { payslip_html, type = 'mensal', period } = req.body;

  if (!payslip_html) return res.status(400).json({ error: 'payslip_html obrigatorio' });

  try {
    // Get employee + company
    const { rows: emps } = await db.query(
      'SELECT name, email FROM employees WHERE id=$1 AND company_id=$2', [eid, cid]);
    if (!emps.length) return res.status(404).json({ error: 'Funcionario nao encontrado' });
    const emp = emps[0];

    if (!emp.email) return res.status(400).json({ error: 'Funcionario sem e-mail cadastrado' });

    const { rows: companies } = await db.query(
      'SELECT trade_name, legal_name FROM companies WHERE id=$1', [cid]);
    const company = companies[0] || {};
    const companyName = company.trade_name || company.legal_name || 'Empresa';

    const typeLabels = { mensal: 'Mensal', ferias: 'Ferias', decimo_terceiro: '13o Salario' };
    const typeLabel = typeLabels[type] || 'Mensal';
    const periodLabel = period || new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

    // Wrap payslip HTML in email template
    const emailHtml = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#08090f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#08090f;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#0f1019;border:1px solid #1e1b4b;border-radius:20px;overflow:hidden;">
        <tr><td style="height:4px;background:linear-gradient(90deg,#7c3aed,#a78bfa,#7c3aed);"></td></tr>
        <tr><td align="center" style="padding:32px 32px 0 32px;">
          <img src="${ICON_URL}" width="48" height="48" alt="Aura." style="display:block;border-radius:12px;" />
          <p style="margin:10px 0 0;font-size:20px;font-weight:800;color:#e2e8f0;">Aura<span style="color:#7c3aed;">.</span></p>
        </td></tr>
        <tr><td style="padding:24px 32px;">
          <p style="font-size:15px;color:#e2e8f0;margin:0 0 6px;">Ola, ${emp.name.split(' ')[0]}!</p>
          <p style="font-size:13px;color:#94a3b8;line-height:22px;margin:0 0 24px;">
            Segue seu holerite <strong style="color:#e2e8f0;">${typeLabel}</strong> referente a <strong style="color:#e2e8f0;">${periodLabel}</strong>.
          </p>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#1a1a2e;border:1px solid #1e1b4b;border-radius:14px;overflow:hidden;">
            <tr><td style="padding:0;">
              ${payslip_html}
            </td></tr>
          </table>
          <p style="font-size:11px;color:#64748b;margin:20px 0 0;text-align:center;">Este holerite e uma estimativa gerada pela Aura para apoio contabil.</p>
        </td></tr>
        <tr><td style="padding:0 32px 28px 32px;border-top:1px solid #1e293b;">
          <p style="margin:20px 0 0;font-size:11px;color:#475569;text-align:center;line-height:18px;">
            ${companyName} &middot; Enviado via <a href="https://getaura.com.br" style="color:#7c3aed;text-decoration:none;">Aura.</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    // Send via Resend
    if (!RESEND_API_KEY) {
      console.log(`[payslip-email] DEV: would send to ${emp.email}`);
      return res.json({ sent: true, to: emp.email, mode: 'dev' });
    }

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [emp.email],
        subject: `Holerite ${typeLabel} - ${periodLabel} | ${companyName}`,
        html: emailHtml,
      }),
    });

    if (!resendRes.ok) {
      const err = await resendRes.json().catch(() => ({}));
      console.error('[payslip-email] Resend error:', err);
      return res.status(502).json({ error: 'Erro ao enviar e-mail: ' + (err.message || resendRes.status) });
    }

    const data = await resendRes.json();
    console.log(`[payslip-email] Sent to ${emp.email}: ${data.id}`);
    res.json({ sent: true, to: emp.email, resend_id: data.id });
  } catch (err) {
    console.error('[payslip-email] error:', err.message);
    res.status(500).json({ error: 'Erro ao enviar holerite' });
  }
});

module.exports = router;
