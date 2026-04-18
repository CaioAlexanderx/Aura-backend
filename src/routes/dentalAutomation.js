// ============================================================
// AURA. — ODT-09/10/12: Automações Odonto
// GET  /dental/automation/config — config
// PUT  /dental/automation/config — salvar config
// POST /dental/automation/trigger — trigger manual
// GET  /dental/automation/log — histórico
// POST /dental/automation/recall — trigger recall manual
// POST /dental/automation/satisfaction/:aid — trigger pesquisa
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

// GET config
router.get('/automation/config', requireAuth, async (req, res) => {
  const cid = req.params.id;
  try {
    let { rows } = await db.query('SELECT * FROM dental_automation_config WHERE company_id=$1', [cid]);
    if (!rows.length) {
      const { rows: created } = await db.query(
        `INSERT INTO dental_automation_config (company_id) VALUES ($1) RETURNING *`, [cid]);
      rows = created;
    }
    res.json({ config: rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro config' }); }
});

// PUT config
router.put('/automation/config', requireAuth, requireRole('client','admin'), async (req, res) => {
  const cid = req.params.id;
  const { confirm_enabled, confirm_hours_before, remind_enabled, remind_hours_before,
          recall_enabled, recall_days, satisfaction_enabled, satisfaction_hours_after } = req.body;
  try {
    const { rows } = await db.query(
      `INSERT INTO dental_automation_config (company_id, confirm_enabled, confirm_hours_before, remind_enabled, remind_hours_before, recall_enabled, recall_days, satisfaction_enabled, satisfaction_hours_after)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (company_id) DO UPDATE SET
         confirm_enabled=COALESCE($2, dental_automation_config.confirm_enabled),
         confirm_hours_before=COALESCE($3, dental_automation_config.confirm_hours_before),
         remind_enabled=COALESCE($4, dental_automation_config.remind_enabled),
         remind_hours_before=COALESCE($5, dental_automation_config.remind_hours_before),
         recall_enabled=COALESCE($6, dental_automation_config.recall_enabled),
         recall_days=COALESCE($7, dental_automation_config.recall_days),
         satisfaction_enabled=COALESCE($8, dental_automation_config.satisfaction_enabled),
         satisfaction_hours_after=COALESCE($9, dental_automation_config.satisfaction_hours_after),
         updated_at=NOW()
       RETURNING *`,
      [cid, confirm_enabled, confirm_hours_before, remind_enabled, remind_hours_before,
       recall_enabled, recall_days, satisfaction_enabled, satisfaction_hours_after]);
    res.json({ config: rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro ao salvar' }); }
});

// POST trigger — processa confirmações pendentes
router.post('/automation/trigger', requireAuth, requireRole('client','admin'), async (req, res) => {
  const cid = req.params.id;
  const { type = 'confirm_24h' } = req.body;
  try {
    let appointments = [];
    if (type === 'confirm_24h') {
      // Consultas nas próximas 24h sem confirmação
      const { rows } = await db.query(
        `SELECT a.id, a.scheduled_at, a.status, p.full_name, p.phone
         FROM dental_appointments a
         JOIN dental_patients p ON p.id = a.patient_id
         WHERE a.company_id=$1 AND a.status IN ('scheduled','pending')
           AND a.scheduled_at BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
           AND NOT EXISTS (
             SELECT 1 FROM dental_automation_log l
             WHERE l.appointment_id = a.id AND l.type = 'confirm_24h'
               AND l.sent_at > NOW() - INTERVAL '20 hours'
           )
         ORDER BY a.scheduled_at`, [cid]);
      appointments = rows;
    } else if (type === 'remind_2h') {
      const { rows } = await db.query(
        `SELECT a.id, a.scheduled_at, p.full_name, p.phone
         FROM dental_appointments a
         JOIN dental_patients p ON p.id = a.patient_id
         WHERE a.company_id=$1 AND a.status IN ('scheduled','confirmed')
           AND a.scheduled_at BETWEEN NOW() AND NOW() + INTERVAL '3 hours'
           AND NOT EXISTS (
             SELECT 1 FROM dental_automation_log l
             WHERE l.appointment_id = a.id AND l.type = 'remind_2h'
               AND l.sent_at > NOW() - INTERVAL '2 hours'
           )`, [cid]);
      appointments = rows;
    }

    // Log each as pending (real WhatsApp send would happen via integration)
    const results = [];
    for (const a of appointments) {
      const msg = type === 'confirm_24h'
        ? `Ola ${a.full_name}! Confirmamos sua consulta amanha as ${new Date(a.scheduled_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}. Responda 1 para confirmar, 2 para reagendar.`
        : `Lembrete: sua consulta e daqui a 2 horas. Estamos te esperando!`;

      await db.query(
        `INSERT INTO dental_automation_log (company_id, patient_id, appointment_id, type, channel, message, status)
         VALUES ($1, (SELECT patient_id FROM dental_appointments WHERE id=$2), $2, $3, 'whatsapp', $4, 'pending')`,
        [cid, a.id, type, msg]);
      results.push({ appointment_id: a.id, patient: a.full_name, phone: a.phone, message: msg });
    }

    res.json({ type, triggered: results.length, results });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro trigger' }); }
});

// POST recall — pacientes sem consulta há X dias
router.post('/automation/recall', requireAuth, async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows: config } = await db.query(
      'SELECT recall_days FROM dental_automation_config WHERE company_id=$1', [cid]);
    const days = config[0]?.recall_days || 180;

    const { rows: patients } = await db.query(
      `SELECT p.id, p.full_name, p.phone,
              MAX(a.scheduled_at) AS last_visit,
              CURRENT_DATE - MAX(a.scheduled_at)::date AS days_since
       FROM dental_patients p
       LEFT JOIN dental_appointments a ON a.patient_id = p.id AND a.status = 'completed'
       WHERE p.company_id = $1
       GROUP BY p.id, p.full_name, p.phone
       HAVING MAX(a.scheduled_at) < NOW() - ($2 || ' days')::interval
          AND NOT EXISTS (
            SELECT 1 FROM dental_automation_log l
            WHERE l.patient_id = p.id AND l.type = 'recall'
              AND l.sent_at > NOW() - INTERVAL '30 days'
          )
       ORDER BY days_since DESC LIMIT 50`, [cid, days]);

    const results = [];
    for (const p of patients) {
      const msg = `Ola ${p.full_name}! Faz ${p.days_since} dias desde sua ultima consulta. Que tal agendar sua revisao? Estamos com horarios disponiveis.`;
      await db.query(
        `INSERT INTO dental_automation_log (company_id, patient_id, type, channel, message, status)
         VALUES ($1,$2,'recall','whatsapp',$3,'pending')`, [cid, p.id, msg]);
      results.push({ patient_id: p.id, name: p.full_name, phone: p.phone, days_since: parseInt(p.days_since), message: msg });
    }
    res.json({ recall_days: days, patients_found: results.length, results });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro recall' }); }
});

// POST satisfaction — pesquisa pós-consulta
router.post('/automation/satisfaction/:aid', requireAuth, async (req, res) => {
  const cid = req.params.id;
  try {
    const { rows } = await db.query(
      `SELECT a.id, a.patient_id, p.full_name, p.phone
       FROM dental_appointments a JOIN dental_patients p ON p.id = a.patient_id
       WHERE a.id = $1 AND a.company_id = $2`, [req.params.aid, cid]);
    if (!rows.length) return res.status(404).json({ error: 'Consulta nao encontrada' });
    const a = rows[0];
    const msg = `Ola ${a.full_name}! Como foi seu atendimento? Avalie de 1 a 5 estrelas. Sua opiniao nos ajuda a melhorar!`;
    await db.query(
      `INSERT INTO dental_automation_log (company_id, patient_id, appointment_id, type, channel, message, status)
       VALUES ($1,$2,$3,'satisfaction','whatsapp',$4,'pending')`,
      [cid, a.patient_id, a.id, msg]);
    res.json({ sent: true, patient: a.full_name, message: msg });
  } catch (err) { res.status(500).json({ error: 'Erro' }); }
});

// GET log
router.get('/automation/log', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const type = req.query.type;
  try {
    let where = 'WHERE l.company_id = $1';
    const params = [cid];
    if (type) { where += ` AND l.type = $2`; params.push(type); }
    params.push(limit);
    const { rows } = await db.query(
      `SELECT l.*, p.full_name AS patient_name FROM dental_automation_log l
       LEFT JOIN dental_patients p ON p.id = l.patient_id
       ${where} ORDER BY l.sent_at DESC LIMIT $${params.length}`, params);
    res.json({ log: rows, total: rows.length });
  } catch (err) { res.status(500).json({ error: 'Erro log' }); }
});

module.exports = router;
