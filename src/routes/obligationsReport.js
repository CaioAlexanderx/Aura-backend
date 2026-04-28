// ============================================================
// AURA. — Obligation Report Generator route (PR38, 2026-04-28)
// POST /companies/:id/obligations/:code/report
//
// Aciona obligationReportGenerator pra gerar relatorio formatado
// pra obrigacao especifica. Frontend usa pra mostrar conteudo
// pronto + instrucoes de envio + link do portal externo.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const { generateReport } = require('../services/obligationReportGenerator');

router.post('/obligations/:code/report', async (req, res) => {
  try {
    const report = await generateReport(req.params.id, req.params.code);
    res.json({ report });
  } catch (err) {
    console.error('[obligationsReport]', err.message);
    if (err.message?.includes('nao encontrada')) {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: 'Erro ao gerar relatorio: ' + err.message });
  }
});

module.exports = router;
