// ============================================================
// AURA. \u2014 Rota de Obriga\u00e7\u00f5es Fiscais (BE-10 + BE-24)
// Adicionados:
//   POST /das-mei/qr    \u2014 gera QR Code do portal PGMEI com CNPJ pr\u00e9-preenchido
//   GET  /das-mei/check-payment \u2014 detecta pagamento de DAS nas transa\u00e7\u00f5es e
//                               auto-conclui a obriga\u00e7\u00e3o se encontrar
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const {
  calculateMEIDAS, calculateSNDAS, checkMEILimit,
  generateMonthlyObligations, getObligations, updateCheckpoint,
} = require('../services/fiscalObligations');
const { getPersonalizedCalendar } = require('../services/obligationsCalendar');
const db = require('../config/database');

// \u2500\u2500 GET /obligations \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
router.get('/', async (req, res) => {
  try {
    const { status, year } = req.query;
    const data = await getObligations(req.params.id, { status, year });
    res.json({ total: data.length, obligations: data });
  } catch (err) {
    console.error('Erro em GET /obligations:', err.message);
    res.status(500).json({ error: 'Erro ao buscar obriga\u00e7\u00f5es' });
  }
});

// \u2500\u2500 GET /obligations/calendar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
router.get('/calendar', async (req, res) => {
  try {
    const { filter = 'all' } = req.query;
    const validFilters = ['all', 'aura_resolve', 'voce_faz', 'contador'];
    if (!validFilters.includes(filter)) {
      return res.status(400).json({ error: `filter inv\u00e1lido. Use: ${validFilters.join(', ')}` });
    }
    const data = await getPersonalizedCalendar(req.params.id);
    if (!data) return res.status(404).json({ error: 'Empresa n\u00e3o encontrada' });
    const calendar = filter === 'all' ? data.calendar : data.calendar.filter(c => c.filter_label === filter);
    res.json({ ...data, calendar });
  } catch (err) {
    console.error('Erro em GET /obligations/calendar:', err.message);
    res.status(500).json({ error: 'Erro ao montar calend\u00e1rio de obriga\u00e7\u00f5es' });
  }
});

// \u2500\u2500 POST /obligations/generate \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
router.post('/generate', async (req, res) => {
  try {
    const { reference_month } = req.body;
    if (!reference_month) return res.status(400).json({ error: 'reference_month \u00e9 obrigat\u00f3rio (YYYY-MM-DD)' });
    const data = await generateMonthlyObligations(req.params.id, reference_month);
    res.status(201).json({ generated: data.length, obligations: data });
  } catch (err) {
    console.error('Erro em POST /obligations/generate:', err.message);
    res.status(500).json({ error: 'Erro ao gerar obriga\u00e7\u00f5es' });
  }
});

// \u2500\u2500 PATCH /obligations/:obligationId/checkpoint \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
router.patch('/:obligationId/checkpoint', async (req, res) => {
  try {
    const { checkpoint_done } = req.body;
    if (checkpoint_done === undefined) return res.status(400).json({ error: 'checkpoint_done \u00e9 obrigat\u00f3rio' });
    const data = await updateCheckpoint(req.params.id, req.params.obligationId, parseInt(checkpoint_done));
    res.json(data);
  } catch (err) {
    console.error('Erro em PATCH /obligations/checkpoint:', err.message);
    res.status(err.message.includes('n\u00e3o encontrada') ? 404 : 500).json({ error: err.message });
  }
});

// \u2500\u2500 GET /obligations/das/preview \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
router.get('/das/preview', async (req, res) => {
  try {
    const companyId = req.params.id;
    const { activity_type, current_revenue, revenue_12m } = req.query;
    const { rows } = await db.query('SELECT tax_regime, annual_revenue FROM companies WHERE id = $1', [companyId]);
    if (!rows.length) return res.status(404).json({ error: 'Empresa n\u00e3o encontrada' });
    const { tax_regime, annual_revenue } = rows[0];
    if (tax_regime === 'mei') {
      const das = calculateMEIDAS(activity_type || 'services');
      const limitCheck = checkMEILimit(parseFloat(annual_revenue));
      return res.json({ regime: 'mei', das, limit_check: limitCheck });
    }
    if (tax_regime === 'simples_nacional') {
      if (!current_revenue || !revenue_12m) {
        return res.status(400).json({ error: 'Informe current_revenue e revenue_12m' });
      }
      const das = calculateSNDAS(parseFloat(revenue_12m), parseFloat(current_revenue));
      return res.json({ regime: 'simples_nacional', das });
    }
    res.status(400).json({ error: `Regime ${tax_regime} n\u00e3o suportado` });
  } catch (err) {
    console.error('Erro em GET /obligations/das/preview:', err.message);
    res.status(500).json({ error: 'Erro ao calcular estimativa DAS' });
  }
});

// \u2500\u2500 POST /obligations/das-mei/qr \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Gera QR Code do portal PGMEI com o CNPJ da empresa pr\u00e9-preenchido.
// O cliente escaneia \u2192 abre o portal \u2192 gera o boleto/Pix \u2192 paga.
// O QR Code gerado aqui \u00e9 um atalho ao portal governamental, n\u00e3o um
// c\u00f3digo de pagamento Pix direto (isso exigiria integra\u00e7\u00e3o com a Receita).
router.post('/das-mei/qr', async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT cnpj, tax_regime, legal_name FROM companies WHERE id=$1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Empresa n\u00e3o encontrada' });
    const { cnpj, tax_regime } = rows[0];
    if (tax_regime !== 'mei') {
      return res.status(400).json({ error: 'Endpoint exclusivo para empresas MEI' });
    }

    const cleanCnpj = (cnpj || '').replace(/\D/g, '');
    // PGMEI: portal oficial de gera\u00e7\u00e3o do DAS-MEI
    const pgmeiBase = 'https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/Identificacao';
    const qrContent = cleanCnpj ? `${pgmeiBase}?cnpj=${cleanCnpj}` : pgmeiBase;

    const QRCode = require('qrcode');
    const qrDataUrl = await QRCode.toDataURL(qrContent, {
      width: 240,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });
    const qrBase64 = qrDataUrl.replace('data:image/png;base64,', '');

    // Persiste no registro de obriga\u00e7\u00e3o do m\u00eas, se existir
    const refMonth = new Date().toISOString().substring(0, 7); // "2026-04"
    await db.query(
      `UPDATE fiscal_obligations
         SET das_qrcode=$1, updated_at=NOW()
       WHERE company_id=$2
         AND code='das_mei'
         AND reference_period LIKE $3`,
      [qrBase64, req.params.id, refMonth + '%']
    ).catch(() => {}); // silencio se nao houver registro do mes

    res.json({
      qr_base64:  qrBase64,
      pgmei_url:  pgmeiBase,
      cnpj:       cleanCnpj,
    });
  } catch (err) {
    console.error('[das-mei-qr] error:', err.message);
    res.status(500).json({ error: 'Erro ao gerar QR Code do DAS' });
  }
});

// \u2500\u2500 GET /obligations/das-mei/check-payment \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Detecta se o DAS foi pago consultando a tabela transactions.
// Heur\u00edstica: despesa do m\u00eas com descri\u00e7\u00e3o/categoria relacionada a DAS/MEI/Simples.
// Se detectar, marca a obriga\u00e7\u00e3o como done automaticamente.
router.get('/das-mei/check-payment', async (req, res) => {
  try {
    const now       = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const nextMonth  = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const monthEnd   = nextMonth.toISOString().substring(0, 10);
    const refMonth   = now.toISOString().substring(0, 7);

    // Busca qualquer lan\u00e7amento de despesa com keywords de DAS no m\u00eas
    const { rows } = await db.query(`
      SELECT id, amount, description, category, created_at
      FROM transactions
      WHERE company_id = $1
        AND type = 'expense'
        AND status NOT IN ('cancelled')
        AND (
          description ILIKE '%DAS%'
          OR description ILIKE '%DAS-MEI%'
          OR description ILIKE '%PGMEI%'
          OR description ILIKE '%Simples Nacional%'
          OR category    ILIKE '%DAS%'
          OR category    ILIKE '%imposto%'
          OR category    ILIKE '%Simples%'
        )
        AND (created_at AT TIME ZONE 'America/Sao_Paulo') >= $2::timestamp
        AND (created_at AT TIME ZONE 'America/Sao_Paulo') <  $3::timestamp
      ORDER BY created_at DESC
      LIMIT 1
    `, [req.params.id, monthStart, monthEnd]);

    const paid = rows.length > 0;

    if (paid) {
      // Auto-conclui a obriga\u00e7\u00e3o do m\u00eas
      await db.query(`
        UPDATE fiscal_obligations
          SET status       = 'done',
              completed_at = NOW(),
              checkpoint_done = checkpoint_total,
              updated_at   = NOW()
        WHERE company_id = $1
          AND code       = 'das_mei'
          AND reference_period LIKE $2
          AND status    != 'done'
      `, [req.params.id, refMonth + '%']).catch(() => {});
    }

    res.json({
      paid,
      transaction: paid
        ? { id: rows[0].id, amount: parseFloat(rows[0].amount), description: rows[0].description }
        : null,
      month: refMonth,
    });
  } catch (err) {
    console.error('[das-mei-check] error:', err.message);
    res.status(500).json({ error: 'Erro ao verificar pagamento do DAS' });
  }
});

module.exports = router;
