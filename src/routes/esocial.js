// ============================================================
// AURA. — eSocial ME — Endpoints de Geração de XML e Status
// Feature: BE-29b
// ============================================================
// Endpoints:
//   GET  /companies/:id/esocial/status?period=YYYY-MM
//     → Status do ciclo mensal (o que está pendente)
//
//   GET  /companies/:id/esocial/xml/admissao/:employee_id
//     → Download XML S-2200 pronto para transmitir
//
//   GET  /companies/:id/esocial/xml/remuneracao?period=YYYY-MM
//     → Download XML S-1200 com todos os funcionários do mês
//
//   GET  /companies/:id/esocial/xml/fechamento?period=YYYY-MM
//     → Download XML S-1299 de fechamento da folha
//
//   GET  /companies/:id/esocial/xml/desligamento/:employee_id
//     → Download XML S-2299 (body: { dt_deslig, mot_deslig })
//
//   GET  /companies/:id/esocial/motivos-desligamento
//     → Tabela de motivos de desligamento (referência)
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const esocial = require('../services/esocial');

// ─── Helpers ─────────────────────────────────────────────────

// Verifica se a empresa está no plano que habilita eSocial ME
async function getCompanyInfo(companyId) {
  const res = await db.query(
    `SELECT c.cnpj, c.name AS razao_social, c.tax_regime, c.plan,
            COUNT(e.id) AS employee_count
     FROM companies c
     LEFT JOIN employees e ON e.company_id = c.id AND e.status = 'active'
     WHERE c.id = $1
     GROUP BY c.id`,
    [companyId]
  );
  return res.rows[0] || null;
}

// Busca completions do guia para verificar o que já foi enviado
async function getGuideCompletions(companyId, period) {
  const res = await db.query(
    `SELECT guide_slug, completed_at FROM guide_completions
     WHERE company_id = $1 AND period = $2`,
    [companyId, period]
  );
  return new Set(res.rows.map(r => r.guide_slug));
}

// ─── GET /esocial/status ─────────────────────────────────────
// Retorna o status completo do ciclo eSocial do mês

router.get('/status', requireAuth, async (req, res) => {
  try {
    const companyId = req.params.id;
    const period    = req.query.period || (() => {
      const n = new Date();
      return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
    })();

    const [year, month] = period.split('-');
    const dueDay15  = `${year}-${month}-15`;
    const dueDay20  = `${year}-${month}-20`;

    const company  = await getCompanyInfo(companyId);
    if (!company) return res.status(404).json({ error: 'Empresa não encontrada' });

    const numFunc  = parseInt(company.employee_count || 0);
    const regime   = company.tax_regime;
    const isMe2plus = regime !== 'mei' && numFunc >= 2;

    // Verifica se há folha processada no período
    const folhaRes = await db.query(
      `SELECT COUNT(DISTINCT employee_id) AS cnt,
              COALESCE(SUM(gross_salary), 0) AS total_bruto,
              COALESCE(SUM(inss_employee), 0) AS total_inss_func,
              COALESCE(SUM(irrf), 0) AS total_irrf,
              COALESCE(SUM(gross_salary * 0.08), 0) AS total_fgts
       FROM payroll_records
       WHERE company_id = $1 AND period = $2`,
      [companyId, period]
    );
    const folha    = folhaRes.rows[0];
    const temFolha = parseInt(folha?.cnt || 0) > 0;

    // Verifica completions dos guias
    const completions = await getGuideCompletions(companyId, period);

    // Verifica funcionários sem admissão registrada no eSocial
    const funcSemEsocialRes = await db.query(
      `SELECT id, name, cpf, admission_date FROM employees
       WHERE company_id = $1 AND status = 'active'
         AND esocial_admissao_sent = false`,
      [companyId]
    );
    const funcSemEsocial = funcSemEsocialRes.rows;

    // Monta ciclo de status
    const ciclo = [
      {
        id:       'folha_calculada',
        label:    'Folha de pagamento calculada',
        done:     temFolha,
        guide:    null,
        due:      dueDay15,
        values:   temFolha ? {
          funcionarios: parseInt(folha.cnt),
          total_bruto:  parseFloat(folha.total_bruto).toFixed(2),
          total_inss:   parseFloat(folha.total_inss_func).toFixed(2),
          total_irrf:   parseFloat(folha.total_irrf).toFixed(2),
          total_fgts:   parseFloat(folha.total_fgts).toFixed(2),
        } : null,
      },
      {
        id:    's1200_enviado',
        label: 'Remunerações enviadas ao eSocial (S-1200)',
        done:  completions.has('esocial_folha_mensal'),
        guide: 'esocial_folha_mensal',
        due:   dueDay15,
        xml_endpoint: `/companies/${companyId}/esocial/xml/remuneracao?period=${period}`,
      },
      {
        id:    's1299_enviado',
        label: 'Folha fechada no eSocial (S-1299)',
        done:  completions.has('esocial_folha_mensal'), // completar o guia marca ambos
        guide: 'esocial_folha_mensal',
        due:   dueDay15,
        xml_endpoint: `/companies/${companyId}/esocial/xml/fechamento?period=${period}`,
        warning: 'Obrigatório — sem o fechamento a guia do FGTS Digital não é gerada',
      },
      {
        id:    'dctfweb_paga',
        label: 'INSS pago (DCTFWeb)',
        done:  completions.has('dctfweb'),
        guide: 'dctfweb',
        due:   dueDay20,
        values: temFolha ? {
          estimativa: parseFloat(
            (parseFloat(folha.total_bruto) * 0.258 + parseFloat(folha.total_inss_func) + parseFloat(folha.total_irrf))
            .toFixed(2)
          ),
        } : null,
      },
      {
        id:    'fgts_pago',
        label: 'FGTS pago (FGTS Digital)',
        done:  completions.has('fgts_digital'),
        guide: 'fgts_digital',
        due:   dueDay20,
        values: temFolha ? {
          estimativa: parseFloat(folha.total_fgts).toFixed(2),
        } : null,
      },
    ];

    const pendentes = ciclo.filter(c => !c.done).length;
    const proximo   = ciclo.find(c => !c.done);

    res.json({
      period,
      company: {
        regime,
        employee_count: numFunc,
        is_me_2plus:    isMe2plus,
      },
      ciclo,
      resumo: {
        total: ciclo.length,
        concluidos: ciclo.length - pendentes,
        pendentes,
        proximo_passo: proximo?.label || null,
        proximo_guia:  proximo?.guide || null,
      },
      funcionarios_sem_admissao: funcSemEsocial,
      requer_certificado: isMe2plus,
    });
  } catch (err) {
    console.error('[esocial] status error:', err.message);
    res.status(500).json({ error: 'Erro ao buscar status do eSocial' });
  }
});

// ─── GET /esocial/xml/admissao/:employee_id ──────────────────

router.get('/xml/admissao/:employee_id', requireAuth, async (req, res) => {
  try {
    const { id: companyId, employee_id } = req.params;

    const empRes = await db.query(
      `SELECT e.*, c.cnpj, c.name AS razao_social
       FROM employees e
       JOIN companies c ON c.id = e.company_id
       WHERE e.id = $1 AND e.company_id = $2`,
      [employee_id, companyId]
    );

    if (!empRes.rows[0]) {
      return res.status(404).json({ error: 'Funcionário não encontrado' });
    }

    const emp     = empRes.rows[0];
    const company = { id: companyId, cnpj: emp.cnpj, razao_social: emp.razao_social };
    const result  = esocial.gerarS2200(emp, company);

    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="S-2200_${emp.name.replace(/\s+/g, '_')}_${Date.now()}.xml"`);
    res.send(result.xml);
  } catch (err) {
    console.error('[esocial] xml/admissao error:', err.message);
    res.status(500).json({ error: 'Erro ao gerar XML de admissão' });
  }
});

// ─── GET /esocial/xml/remuneracao ────────────────────────────

router.get('/xml/remuneracao', requireAuth, async (req, res) => {
  try {
    const companyId = req.params.id;
    const period    = req.query.period;
    if (!period) return res.status(400).json({ error: 'Parâmetro period é obrigatório (YYYY-MM)' });

    const compRes = await db.query(
      `SELECT cnpj, name AS razao_social FROM companies WHERE id = $1`,
      [companyId]
    );
    if (!compRes.rows[0]) return res.status(404).json({ error: 'Empresa não encontrada' });
    const company = { id: companyId, ...compRes.rows[0] };

    // Buscar folha do período — com dados do funcionário (CPF)
    const folhaRes = await db.query(
      `SELECT pr.*, e.cpf, e.pis, e.name
       FROM payroll_records pr
       JOIN employees e ON e.id = pr.employee_id
       WHERE pr.company_id = $1 AND pr.period = $2
       ORDER BY e.name`,
      [companyId, period]
    );

    if (folhaRes.rows.length === 0) {
      return res.status(422).json({
        error: `Nenhuma folha processada para ${period}. Processe a folha antes de gerar o XML.`
      });
    }

    const result = esocial.gerarS1200(folhaRes.rows, period, company);

    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="S-1200_${period}_${Date.now()}.xml"`);
    res.send(result.xml);
  } catch (err) {
    console.error('[esocial] xml/remuneracao error:', err.message);
    res.status(500).json({ error: 'Erro ao gerar XML de remuneração' });
  }
});

// ─── GET /esocial/xml/fechamento ─────────────────────────────

router.get('/xml/fechamento', requireAuth, async (req, res) => {
  try {
    const companyId = req.params.id;
    const period    = req.query.period;
    if (!period) return res.status(400).json({ error: 'Parâmetro period é obrigatório (YYYY-MM)' });

    const compRes = await db.query(
      `SELECT cnpj, name AS razao_social FROM companies WHERE id = $1`,
      [companyId]
    );
    if (!compRes.rows[0]) return res.status(404).json({ error: 'Empresa não encontrada' });
    const company = { id: companyId, ...compRes.rows[0] };

    // Calcular totais da folha para preencher o S-1299
    const totaisRes = await db.query(
      `SELECT COALESCE(SUM(gross_salary), 0)         AS total_salarios,
              COALESCE(SUM(gross_salary * 0.258), 0) AS total_inss_empresa,
              COALESCE(SUM(gross_salary * 0.08), 0)  AS total_fgts
       FROM payroll_records
       WHERE company_id = $1 AND period = $2`,
      [companyId, period]
    );
    const totais = totaisRes.rows[0] || {};

    if (parseFloat(totais.total_salarios || 0) === 0) {
      return res.status(422).json({
        error: `Nenhuma folha processada para ${period}. Envie o S-1200 primeiro.`
      });
    }

    const result = esocial.gerarS1299(period, company, {
      total_salarios:    parseFloat(totais.total_salarios),
      total_inss_empresa: parseFloat(totais.total_inss_empresa),
      total_fgts:        parseFloat(totais.total_fgts),
    });

    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="S-1299_${period}_${Date.now()}.xml"`);
    res.send(result.xml);
  } catch (err) {
    console.error('[esocial] xml/fechamento error:', err.message);
    res.status(500).json({ error: 'Erro ao gerar XML de fechamento' });
  }
});

// ─── GET /esocial/xml/desligamento/:employee_id ──────────────

router.get('/xml/desligamento/:employee_id', requireAuth, async (req, res) => {
  try {
    const { id: companyId, employee_id } = req.params;
    const { dt_deslig, mot_deslig, dt_pagto } = req.query;

    if (!dt_deslig) {
      return res.status(400).json({ error: 'Parâmetro dt_deslig é obrigatório (YYYY-MM-DD)' });
    }

    const empRes = await db.query(
      `SELECT e.*, c.cnpj, c.name AS razao_social
       FROM employees e
       JOIN companies c ON c.id = e.company_id
       WHERE e.id = $1 AND e.company_id = $2`,
      [employee_id, companyId]
    );
    if (!empRes.rows[0]) return res.status(404).json({ error: 'Funcionário não encontrado' });

    const emp     = empRes.rows[0];
    const company = { id: companyId, cnpj: emp.cnpj, razao_social: emp.razao_social };

    const result = esocial.gerarS2299(
      emp,
      { dt_deslig, mot_deslig: mot_deslig || '01', dt_pagto },
      company
    );

    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="S-2299_${emp.name.replace(/\s+/g, '_')}_${dt_deslig}.xml"`);
    res.send(result.xml);
  } catch (err) {
    console.error('[esocial] xml/desligamento error:', err.message);
    res.status(500).json({ error: 'Erro ao gerar XML de desligamento' });
  }
});

// ─── GET /esocial/motivos-desligamento ───────────────────────
// Tabela de referência para o frontend

router.get('/motivos-desligamento', requireAuth, (req, res) => {
  res.json({
    motivos: [
      { cod: '01', desc: 'Dispensa sem justa causa' },
      { cod: '02', desc: 'Dispensa por justa causa' },
      { cod: '03', desc: 'Pedido de demissão pelo funcionário' },
      { cod: '04', desc: 'Término de contrato por prazo determinado' },
      { cod: '05', desc: 'Culpa recíproca (acordo entre as partes)' },
      { cod: '06', desc: 'Extinção do estabelecimento' },
      { cod: '07', desc: 'Falecimento do empregado' },
      { cod: '08', desc: 'Aposentadoria por invalidez' },
      { cod: '09', desc: 'Aposentadoria compulsória (por idade)' },
      { cod: '11', desc: 'Aposentadoria espontânea' },
      { cod: '12', desc: 'Fim de obra' },
      { cod: '19', desc: 'Término de contrato a prazo com justa causa' },
      { cod: '25', desc: 'Transferência para empresa do mesmo grupo' },
    ],
  });
});

module.exports = router;
