// ============================================================
// AURA. — Obligation Report Generator route (PR38, 2026-04-28)
// POST /companies/:id/obligations/:code/report
//
// Aciona obligationReportGenerator pra gerar relatorio formatado
// pra obrigacao especifica. Frontend usa pra mostrar conteudo
// pronto + instrucoes de envio + link do portal externo.
//
// PR41 Sprint C: handlers Pessoa Fisica (Carne-Leao, GPS, ISS, Livro
// Caixa, IRPF PF anual) ficam em arquivo separado pra evitar arquivo
// gigante. Este route file faz o dispatch entre os dois modulos.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { generateReport, HANDLERS } = require('../services/obligationReportGenerator');
const PF_HANDLERS = require('../services/obligationReportHandlersPF');

const PF_ENDPOINTS = ['carne_leao', 'gps_inss_pf', 'iss_rps_pf', 'livro_caixa_pf', 'irpf_pf_anual'];

router.post('/obligations/:code/report', async (req, res) => {
  try {
    const companyId = req.params.id;
    const code = req.params.code;

    const { rows } = await db.query(
      'SELECT * FROM obligations_templates WHERE code = $1 LIMIT 1', [code]
    );
    if (!rows.length) return res.status(404).json({ error: `Obrigacao ${code} nao encontrada` });

    const template = rows[0];
    const endpoint = template.report_endpoint;

    let report;
    // Dispatch: handlers PF estao em modulo separado
    if (PF_ENDPOINTS.includes(endpoint) && PF_HANDLERS[endpoint]) {
      const r = await PF_HANDLERS[endpoint](companyId, template);
      report = {
        code,
        name: template.name_display,
        description: template.description,
        generated_at: new Date().toISOString(),
        ...r,
      };
    } else {
      // Demais endpoints: usa generator principal
      report = await generateReport(companyId, code);
    }

    res.json({ report });
  } catch (err) {
    console.error('[obligationsReport]', err.message, err.stack);
    if (err.message?.includes('nao encontrada')) {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: 'Erro ao gerar relatorio: ' + err.message });
  }
});

module.exports = router;
