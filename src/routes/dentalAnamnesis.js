// ============================================================
// AURA. — Dental Anamnesis CRUD (W1-01)
//
// Gerencia anamnese odontologica de pacientes. JSONB armazenado
// em customers.anamnesis_data (D-UNIFY: sem tabela separada).
// LGPD Art.11: dados sensiveis de saude. PUT exige lgpd_consent=true.
//
// Rotas:
//   GET /patients/:pid/anamnesis   carrega anamnese atual (nulla se vazia)
//   PUT /patients/:pid/anamnesis   salva/substitui anamnese completa
//
// Shape do body PUT:
//   { data: { doencas, alergias, medicacoes, gravidez, tabagismo,
//             bruxismo, sangramento_gengival, cirurgia_recente,
//             cirurgia_detalhe, observacoes, lgpd_consent } }
//
// Ao salvar, customers.lgpd_consent e lgpd_consent_at tambem sao
// atualizados pra espelhar a conformidade geral do paciente.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

// ── GET /patients/:pid/anamnesis ──
router.get('/patients/:pid/anamnesis', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, anamnesis_data, anamnesis_updated_at
       FROM customers
       WHERE id = $1 AND company_id = $2 AND is_patient = true`,
      [req.params.pid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Paciente nao encontrado' });
    res.json({
      patient_id: rows[0].id,
      anamnesis: rows[0].anamnesis_data || null,
      updated_at: rows[0].anamnesis_updated_at,
    });
  } catch (err) {
    console.error('[dentalAnamnesis GET]', err.message);
    res.status(500).json({ error: 'Erro ao buscar anamnese' });
  }
});

// ── PUT /patients/:pid/anamnesis ──
router.put('/patients/:pid/anamnesis', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { data } = req.body;

  // Validacoes
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return res.status(400).json({ error: 'data (objeto) e obrigatorio' });
  }
  if (!data.lgpd_consent) {
    return res.status(400).json({
      error: 'Consentimento LGPD Art.11 e obrigatorio para salvar anamnese',
    });
  }

  // Sanitizacao defensiva: so persiste campos conhecidos do wizard.
  // Evita injecao de chaves arbitrarias no JSONB.
  const clean = {
    doencas:              Array.isArray(data.doencas) ? data.doencas.filter(v => typeof v === 'string') : [],
    alergias:             Array.isArray(data.alergias) ? data.alergias.filter(v => typeof v === 'string') : [],
    medicacoes:           Array.isArray(data.medicacoes) ? data.medicacoes.filter(v => typeof v === 'string') : [],
    gravidez:             typeof data.gravidez === 'string' ? data.gravidez : 'Nao',
    tabagismo:            !!data.tabagismo,
    bruxismo:             !!data.bruxismo,
    sangramento_gengival: !!data.sangramento_gengival,
    cirurgia_recente:     !!data.cirurgia_recente,
    cirurgia_detalhe:     typeof data.cirurgia_detalhe === 'string' ? data.cirurgia_detalhe.slice(0, 500) : '',
    observacoes:          typeof data.observacoes === 'string' ? data.observacoes.slice(0, 2000) : '',
    lgpd_consent:         true,
  };

  try {
    const { rows } = await db.query(
      `UPDATE customers
       SET anamnesis_data       = $1::jsonb,
           anamnesis_updated_at = NOW(),
           lgpd_consent         = true,
           lgpd_consent_at      = COALESCE(lgpd_consent_at, NOW()),
           updated_at           = NOW()
       WHERE id = $2 AND company_id = $3 AND is_patient = true
       RETURNING id, anamnesis_data, anamnesis_updated_at`,
      [JSON.stringify(clean), req.params.pid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Paciente nao encontrado' });
    res.json({
      patient_id: rows[0].id,
      anamnesis:  rows[0].anamnesis_data,
      updated_at: rows[0].anamnesis_updated_at,
    });
  } catch (err) {
    console.error('[dentalAnamnesis PUT]', err.message);
    res.status(500).json({ error: 'Erro ao salvar anamnese' });
  }
});

module.exports = router;
