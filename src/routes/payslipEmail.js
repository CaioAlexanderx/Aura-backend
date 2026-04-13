// ============================================================
// AURA. — Payslip Email Route (with PDF attachment)
// POST /companies/:id/employees/:eid/payslip/email
// Generates PDF via PDFKit + sends via Resend with attachment
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { generatePayslipPdf } = require('../services/payslipPdf');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.SMTP_FROM || 'Aura. <noreply@getaura.com.br>';
const ICON_URL = 'https://cdn.jsdelivr.net/gh/CaioAlexanderx/aura-app@main/assets/Icon.png';

// INSS calculation (same as frontend)
function calcINSS(salary) {
  const s = parseFloat(salary);
  if (s <= 1412.00) return s * 0.075;
  if (s <= 2666.68) return 105.90 + (s - 1412.00) * 0.09;
  if (s <= 4000.03) return 218.82 + (s - 2666.68) * 0.12;
  if (s <= 7786.02) return 378.82 + (s - 4000.03) * 0.14;
  return 908.85;
}
function calcIRRF(salary, inss) {
  const base = salary - inss;
  if (base <= 2259.20) return 0;
  if (base <= 2826.65) return base * 0.075 - 169.44;
  if (base <= 3751.05) return base * 0.15 - 381.44;
  if (base <= 4664.68) return base * 0.225 - 662.77;
  return base * 0.275 - 896.00;
}

router.post('/:eid/payslip/email', async (req, res) => {
  const { id: cid, eid } = req.params;
  const { type = 'mensal' } = req.body;

  try {
    // Get employee
    const { rows: emps } = await db.query(
      `SELECT name, email, cpf, role, role_title, salary, base_salary, admission_date
       FROM employees WHERE id=$1 AND company_id=$2`, [eid, cid]);
    if (!emps.length) return res.status(404).json({ error: 'Funcionario nao encontrado' });
    const emp = emps[0];
    if (!emp.email) return res.status(400).json({ error: 'Funcionario sem e-mail cadastrado' });

    // Get company
    const { rows: companies } = await db.query(
      'SELECT trade_name, legal_name, cnpj FROM companies WHERE id=$1', [cid]);
    const company = companies[0] || {};
    const companyName = company.trade_name || company.legal_name || 'Empresa';
    const salary = parseFloat(emp.salary || emp.base_salary) || 0;
    const role = emp.role || emp.role_title || 'Colaborador';
    const admDate = emp.admission_date ? new Date(emp.admission_date).toLocaleDateString('pt-BR') : '';
    const period = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

    // Calculate payslip data based on type
    let proventos = [], descontos = [], totalProv = 0, totalDesc = 0, liquid = 0, extra = '';
    const inss = calcINSS(salary);
    const irrf = Math.max(0, calcIRRF(salary, inss));

    if (type === 'mensal') {
      totalProv = salary;
      proventos = [{ label: 'Salario base', value: salary }];
      descontos = [
        { label: `INSS (${(inss/salary*100).toFixed(1)}%)`, value: inss },
        { label: 'IRRF', value: irrf },
      ];
      totalDesc = inss + irrf;
      liquid = salary - totalDesc;
    } else if (type === 'ferias') {
      const terco = salary / 3;
      const bruto = salary + terco;
      const fInss = calcINSS(bruto);
      const fIrrf = Math.max(0, calcIRRF(bruto, fInss));
      totalProv = bruto;
      proventos = [
        { label: 'Salario base (30 dias)', value: salary },
        { label: '1/3 constitucional', value: terco },
      ];
      descontos = [{ label: 'INSS', value: fInss }, { label: 'IRRF', value: fIrrf }];
      totalDesc = fInss + fIrrf;
      liquid = bruto - totalDesc;
      extra = `FGTS sobre ferias: ${BRL(bruto * 0.08)}`;
    } else {
      // 13o
      const monthsWorked = emp.admission_date
        ? Math.min(12, Math.max(1, new Date().getMonth() + 1 - new Date(emp.admission_date).getMonth() + (new Date().getFullYear() - new Date(emp.admission_date).getFullYear()) * 12))
        : 12;
      const prop = Math.min(12, monthsWorked);
      const bruto = salary * prop / 12;
      const dInss = calcINSS(bruto);
      const dIrrf = Math.max(0, calcIRRF(bruto, dInss));
      totalProv = bruto;
      proventos = [{ label: `13o salario (${prop}/12 avos)`, value: bruto }];
      descontos = [{ label: 'INSS', value: dInss }, { label: 'IRRF', value: dIrrf }];
      totalDesc = dInss + dIrrf;
      liquid = bruto - totalDesc;
      extra = `FGTS sobre 13o: ${BRL(bruto * 0.08)}`;
    }

    // Generate PDF
    const pdfBuffer = await generatePayslipPdf({
      employeeName: emp.name, employeeRole: role,
      employeeCpf: emp.cpf || '', employeeAdmDate: admDate,
      companyName, companyCnpj: company.cnpj || '',
      type, period, salary,
      proventos, descontos, totalProventos: totalProv, totalDescontos: totalDesc,
      liquid, extra,
    });
    const pdfBase64 = pdfBuffer.toString('base64');

    const typeLabels = { mensal: 'Mensal', ferias: 'Ferias', decimo_terceiro: '13o Salario' };
    const typeLabel = typeLabels[type] || 'Mensal';
    const filename = `Holerite_${typeLabel}_${emp.name.replace(/\s+/g, '_')}_${period.replace(/\s+/g, '_')}.pdf`;

    // Email body (simple, PDF is the star)
    const emailHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#08090f;font-family:-apple-system,sans-serif;">
<table width="100%" style="background:#08090f;padding:40px 20px;"><tr><td align="center">
<table width="480" style="max-width:480px;width:100%;background:#0f1019;border:1px solid #1e1b4b;border-radius:20px;overflow:hidden;">
<tr><td style="height:4px;background:linear-gradient(90deg,#7c3aed,#a78bfa,#7c3aed);"></td></tr>
<tr><td align="center" style="padding:32px 32px 0;">
  <img src="${ICON_URL}" width="48" height="48" style="border-radius:12px;">
  <p style="margin:10px 0 0;font-size:20px;font-weight:800;color:#e2e8f0;">Aura<span style="color:#7c3aed;">.</span></p>
</td></tr>
<tr><td style="padding:24px 32px;">
  <p style="font-size:15px;color:#e2e8f0;margin:0 0 6px;">Ola, ${emp.name.split(' ')[0]}!</p>
  <p style="font-size:13px;color:#94a3b8;line-height:22px;margin:0 0 20px;">Segue em anexo seu holerite <strong style="color:#e2e8f0;">${typeLabel}</strong> referente a <strong style="color:#e2e8f0;">${period}</strong>.</p>
  <table width="100%" style="background:#1e1b4b;border-radius:12px;"><tr><td style="padding:18px;text-align:center;">
    <p style="margin:0;font-size:12px;color:#a78bfa;">Salario liquido</p>
    <p style="margin:6px 0 0;font-size:28px;font-weight:800;color:#fff;">${BRL(liquid)}</p>
  </td></tr></table>
  <p style="font-size:11px;color:#64748b;margin:20px 0 0;text-align:center;">Abra o PDF em anexo para ver o holerite completo.</p>
</td></tr>
<tr><td style="padding:0 32px 28px;border-top:1px solid #1e293b;">
  <p style="margin:20px 0 0;font-size:11px;color:#475569;text-align:center;">${companyName} &middot; Enviado via <a href="https://getaura.com.br" style="color:#7c3aed;text-decoration:none;">Aura.</a></p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

    // Send via Resend with PDF attachment
    if (!RESEND_API_KEY) {
      console.log(`[payslip-email] DEV: would send PDF (${pdfBuffer.length} bytes) to ${emp.email}`);
      return res.json({ sent: true, to: emp.email, mode: 'dev', pdf_size: pdfBuffer.length });
    }

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [emp.email],
        subject: `Holerite ${typeLabel} - ${period} | ${companyName}`,
        html: emailHtml,
        attachments: [{
          filename,
          content: pdfBase64,
        }],
      }),
    });

    if (!resendRes.ok) {
      const err = await resendRes.json().catch(() => ({}));
      console.error('[payslip-email] Resend error:', err);
      return res.status(502).json({ error: 'Erro ao enviar: ' + (err.message || resendRes.status) });
    }

    const data = await resendRes.json();
    console.log(`[payslip-email] PDF sent to ${emp.email}: ${data.id} (${pdfBuffer.length} bytes)`);
    res.json({ sent: true, to: emp.email, resend_id: data.id, pdf_size: pdfBuffer.length });
  } catch (err) {
    console.error('[payslip-email] error:', err.message);
    res.status(500).json({ error: 'Erro ao enviar holerite' });
  }
});

function BRL(v) { return `R$ ${parseFloat(v || 0).toFixed(2).replace('.', ',')}`; }

module.exports = router;
