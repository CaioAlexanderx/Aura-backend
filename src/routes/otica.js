// ============================================================
// AURA. — Modulo Otica (configuracao, laboratorios, receitas, painel)
//
// Montado em private.js sob /otica. Schema: migration 334. A OS de otica
// em si vive em serviceOrders.js (kind = 'otica'); aqui fica o que a OS
// referencia e o que so a otica tem.
//
// GET    /otica/settings                → {settings}
// PUT    /otica/settings                → {settings}
// GET    /otica/labs                    → {labs}
// POST   /otica/labs                    → 201 {lab}
// PATCH  /otica/labs/:labId             → {lab}
// DELETE /otica/labs/:labId             → {deleted} | {deleted:false, deactivated:true}
// GET    /otica/prescriptions           → {prescriptions}
// POST   /otica/prescriptions           → 201 {prescription}
// GET    /otica/prescriptions/book      → {rows}   (livro de receitas)
// GET    /otica/prescriptions/:rxId     → {prescription}
// PATCH  /otica/prescriptions/:rxId     → {prescription}
// DELETE /otica/prescriptions/:rxId     → {deleted:true}
// GET    /otica/dashboard               → {counts, expiring_prescriptions_30d}
//
// GATE: otica_enabled em companies.pdv_settings. So na ESCRITA — ver
// assertOticaEnabled(). A otica liga sozinha: nao exige os_enabled.
//
// DADO DE SAUDE: a receita e dado sensivel. Ela sai daqui pro app (tela
// autenticada) e pro snapshot da OS; NUNCA vai em WhatsApp nem no tracker
// publico. Quem for reaproveitar estas queries em rota publica deve
// reler o cabecalho do studioTrackPublic.js antes.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');

// ─── Gate do modulo ──────────────────────────────────────────
//
// Mesmas duas razoes do assertOsEnabled: le do BANCO (o JWT nunca
// revalida plano/modulo, armadilha #9) e so na escrita (desligar o toggle
// com 30 oculos no laboratorio nao pode esconder da loja o que ela ainda
// precisa entregar — armadilha #3).
function erroOticaDesligada() {
  const err = new Error('Modulo Otica nao esta habilitado. Ative em Configuracoes > Vendas.');
  err.status = 403;
  err.code = 'OTICA_DISABLED';
  return err;
}

async function assertOticaEnabled(companyId) {
  const { rows } = await db.query(
    `SELECT pdv_settings->>'otica_enabled' AS enabled FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!rows.length) {
    const err = new Error('Empresa nao encontrada');
    err.status = 404;
    throw err;
  }
  if (rows[0].enabled !== 'true') throw erroOticaDesligada();
}

// ─── Configuracao ────────────────────────────────────────────
//
// wa_*_auto desligados por padrao: sao mensagens PAGAS e a loja precisa
// ter template aprovado antes — ligar sozinho so encheria a fila de
// 'skipped'. prescription_validity_months = 12 e a validade usual da
// receita no Brasil; adaptation_warranty_days = 90 e a pratica do setor
// pra lente multifocal.
const OTICA_DEFAULTS = {
  prescription_validity_months: 12,
  adaptation_warranty_days: 90,
  default_lab_id: null,
  rt_name: '',
  rt_registry: '',
  sanitary_license: '',
  wa_ready_auto: false,
  wa_adaptation_auto: false,
  wa_revision_auto: false,
};

const SETTINGS_INT_KEYS  = ['prescription_validity_months', 'adaptation_warranty_days'];
const SETTINGS_STR_KEYS  = ['rt_name', 'rt_registry', 'sanitary_license'];
const SETTINGS_BOOL_KEYS = ['wa_ready_auto', 'wa_adaptation_auto', 'wa_revision_auto'];

// {...DEFAULTS, ...salvo}. 42703 (334 pendente) devolve os defaults: a
// tela abre e a OS de otica nasce com garantia/validade padrao — que e o
// que a empresa teria de qualquer forma.
async function carregarOticaSettings(companyId) {
  try {
    const { rows } = await db.query(
      'SELECT otica_settings FROM companies WHERE id = $1',
      [companyId]
    );
    if (!rows.length) return null;
    const saved = rows[0].otica_settings && typeof rows[0].otica_settings === 'object'
      ? rows[0].otica_settings : {};
    return { ...OTICA_DEFAULTS, ...saved };
  } catch (e) {
    if (e.code === '42703') return { ...OTICA_DEFAULTS };
    throw e;
  }
}

// Parametro de template que a Meta aceita: nunca vazio, sem quebra de
// linha/tab, sem 4+ espacos (erro 132012 queima a tentativa paga).
// Copia local do collectionAuto.waParam pra nao arrastar a regua do
// crediario inteira pra dentro da otica.
function waParam(value, fallback) {
  const txt = String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{3,}/g, '  ')
    .trim();
  return txt || String(fallback);
}

const primeiroNome = (nome) => String(nome || '').trim().split(/\s+/)[0] || 'Cliente';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dataValida(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function falhar(res, err, contexto) {
  if (err && err.status) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error(`[otica:${contexto}]`, err.message);
  return res.status(500).json({ error: 'Erro ao processar modulo otica' });
}

// ─── GET /otica/settings ─────────────────────────────────────
router.get('/settings', async function (req, res) {
  try {
    const settings = await carregarOticaSettings(req.params.id);
    if (!settings) return res.status(404).json({ error: 'Empresa nao encontrada' });
    res.json({ settings });
  } catch (err) {
    falhar(res, err, 'GET:settings');
  }
});

// ─── PUT /otica/settings ─────────────────────────────────────
// Merge sobre o salvo com whitelist tipada. Chave desconhecida e ignorada
// em silencio (mesmo contrato do pdv-settings): o front pode mandar o
// objeto inteiro de volta sem se preocupar em filtrar.
router.put('/settings', async function (req, res) {
  const cid = req.params.id;
  const body = (req.body && req.body.settings) || req.body || {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'settings deve ser objeto' });
  }

  const patch = {};
  for (const k of SETTINGS_INT_KEYS) {
    if (!(k in body)) continue;
    const n = Number(body[k]);
    if (!Number.isInteger(n) || n < 0) {
      return res.status(400).json({ error: `${k} deve ser inteiro >= 0` });
    }
    patch[k] = n;
  }
  for (const k of SETTINGS_STR_KEYS) {
    if (!(k in body)) continue;
    if (body[k] != null && typeof body[k] !== 'string') {
      return res.status(400).json({ error: `${k} deve ser texto` });
    }
    patch[k] = String(body[k] || '').trim();
  }
  for (const k of SETTINGS_BOOL_KEYS) {
    if (!(k in body)) continue;
    if (typeof body[k] !== 'boolean') {
      return res.status(400).json({ error: `${k} deve ser boolean` });
    }
    patch[k] = body[k];
  }
  if ('default_lab_id' in body) {
    if (body.default_lab_id != null && body.default_lab_id !== '' && !UUID_RE.test(String(body.default_lab_id))) {
      return res.status(400).json({ error: 'default_lab_id deve ser uuid ou null' });
    }
    patch.default_lab_id = body.default_lab_id || null;
  }

  try {
    await assertOticaEnabled(cid);

    if (patch.default_lab_id) {
      const lab = await db.query(
        'SELECT id FROM optical_labs WHERE id = $1 AND company_id = $2',
        [patch.default_lab_id, cid]
      );
      if (!lab.rows.length) {
        return res.status(404).json({ error: 'Laboratorio nao encontrado nesta empresa' });
      }
    }

    await db.query(
      `UPDATE companies
          SET otica_settings = COALESCE(otica_settings, '{}'::jsonb) || $1::jsonb,
              updated_at = NOW()
        WHERE id = $2`,
      [JSON.stringify(patch), cid]
    );
    res.json({ settings: await carregarOticaSettings(cid) });
  } catch (err) {
    falhar(res, err, 'PUT:settings');
  }
});

// ─── Laboratorios ────────────────────────────────────────────
const LAB_CAMPOS = ['name', 'contact_name', 'phone', 'email', 'portal_url', 'lead_days', 'notes'];

function validarLab(body, { parcial }) {
  if (!parcial || 'name' in body) {
    if (!String(body.name || '').trim()) return 'name obrigatorio';
  }
  if ('lead_days' in body && body.lead_days != null) {
    const n = Number(body.lead_days);
    if (!Number.isInteger(n) || n < 0) return 'lead_days deve ser inteiro >= 0';
  }
  if ('is_active' in body && typeof body.is_active !== 'boolean') return 'is_active deve ser boolean';
  return null;
}

router.get('/labs', async function (req, res) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM optical_labs WHERE company_id = $1
        ORDER BY is_active DESC, name ASC`,
      [req.params.id]
    );
    res.json({ labs: rows });
  } catch (err) {
    if (err.code === '42P01') return res.json({ labs: [] });
    falhar(res, err, 'GET:labs');
  }
});

router.post('/labs', async function (req, res) {
  const cid = req.params.id;
  const body = req.body || {};
  const erro = validarLab(body, { parcial: false });
  if (erro) return res.status(400).json({ error: erro });

  try {
    await assertOticaEnabled(cid);
    const { rows } = await db.query(
      `INSERT INTO optical_labs
         (company_id, name, contact_name, phone, email, portal_url, lead_days, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        cid, String(body.name).trim(),
        body.contact_name || null, body.phone || null, body.email || null,
        body.portal_url || null,
        body.lead_days == null ? 7 : Number(body.lead_days),
        body.notes || null,
      ]
    );
    res.status(201).json({ lab: rows[0] });
  } catch (err) {
    falhar(res, err, 'POST:labs');
  }
});

router.patch('/labs/:labId', async function (req, res) {
  const cid = req.params.id;
  const body = req.body || {};
  const erro = validarLab(body, { parcial: true });
  if (erro) return res.status(400).json({ error: erro });

  try {
    await assertOticaEnabled(cid);

    const sets = [];
    const params = [];
    for (const campo of LAB_CAMPOS) {
      if (!(campo in body)) continue;
      let v = body[campo];
      if (campo === 'name') v = String(v).trim();
      else if (campo === 'lead_days') v = v == null ? 7 : Number(v);
      else v = v === '' ? null : v;
      params.push(v);
      sets.push(`${campo} = $${params.length}`);
    }
    if ('is_active' in body) {
      params.push(body.is_active);
      sets.push(`is_active = $${params.length}`);
    }
    if (!sets.length) {
      const atual = await db.query(
        'SELECT * FROM optical_labs WHERE id = $1 AND company_id = $2',
        [req.params.labId, cid]
      );
      if (!atual.rows.length) return res.status(404).json({ error: 'Laboratorio nao encontrado' });
      return res.json({ lab: atual.rows[0] });
    }

    params.push(req.params.labId, cid);
    const { rows } = await db.query(
      `UPDATE optical_labs SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND company_id = $${params.length}
        RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Laboratorio nao encontrado' });
    res.json({ lab: rows[0] });
  } catch (err) {
    falhar(res, err, 'PATCH:labs');
  }
});

// Laboratorio com OS apontando nao some: a OS entregue ha seis meses ainda
// precisa dizer onde a lente foi feita (refacao em garantia). Desativa.
router.delete('/labs/:labId', async function (req, res) {
  const cid = req.params.id;
  try {
    await assertOticaEnabled(cid);

    const lab = await db.query(
      'SELECT id FROM optical_labs WHERE id = $1 AND company_id = $2',
      [req.params.labId, cid]
    );
    if (!lab.rows.length) return res.status(404).json({ error: 'Laboratorio nao encontrado' });

    const emUso = await db.query(
      'SELECT 1 FROM service_orders WHERE lab_id = $1 AND company_id = $2 LIMIT 1',
      [req.params.labId, cid]
    );
    if (emUso.rows.length) {
      await db.query(
        'UPDATE optical_labs SET is_active = false WHERE id = $1 AND company_id = $2',
        [req.params.labId, cid]
      );
      return res.json({ deleted: false, deactivated: true });
    }

    await db.query('DELETE FROM optical_labs WHERE id = $1 AND company_id = $2', [req.params.labId, cid]);
    res.json({ deleted: true });
  } catch (err) {
    falhar(res, err, 'DELETE:labs');
  }
});

// ─── Receitas ────────────────────────────────────────────────
//
// Graus em passos de 0,25 dioptria: e assim que o prescritor escreve e
// assim que o laboratorio fabrica. Valor fora do passo e arredondado pro
// mais proximo (digitacao "-1.7" vira -1.75), mas modulo absurdo e erro de
// digitacao que nao da pra corrigir adivinhando — devolve GRAU_INVALIDO.
const RX_GRAU_FIELDS   = ['od_sph', 'od_cyl', 'od_add', 'oe_sph', 'oe_cyl', 'oe_add'];
const RX_LIMITES       = { sph: 30, cyl: 10, add: 6 };
const RX_PRISM_FIELDS  = ['od_prism', 'oe_prism'];
const RX_MM_FIELDS     = ['od_pd', 'oe_pd', 'od_height', 'oe_height'];
const RX_AXIS_FIELDS   = ['od_axis', 'oe_axis'];
const RX_TEXT_FIELDS   = ['od_base', 'oe_base', 'prescriber_name', 'prescriber_registry', 'photo_url', 'notes'];
const PRESCRIBER_TYPES = ['medico', 'optometrista'];

const RX_COLUNAS = [
  'od_sph', 'od_cyl', 'od_axis', 'od_add', 'od_prism', 'od_base',
  'oe_sph', 'oe_cyl', 'oe_axis', 'oe_add', 'oe_prism', 'oe_base',
  'od_pd', 'oe_pd', 'od_height', 'oe_height',
  'prescriber_type', 'prescriber_name', 'prescriber_registry',
  'issued_at', 'valid_until', 'photo_url', 'measured_by', 'notes',
];

function arredondarQuarto(n) {
  return Math.round(n * 4) / 4;
}

// Normaliza e valida os campos presentes no body. Devolve { erro, code }
// ou { valores } com o que vai pro banco (so as chaves presentes).
function validarReceita(body, { parcial }) {
  const valores = {};

  for (const f of RX_GRAU_FIELDS) {
    if (!(f in body)) continue;
    if (body[f] == null || body[f] === '') { valores[f] = null; continue; }
    const n = Number(body[f]);
    if (!Number.isFinite(n)) return { erro: `${f} deve ser numero`, code: 'GRAU_INVALIDO' };
    const tipo = f.slice(3);
    if (Math.abs(n) > RX_LIMITES[tipo]) {
      return { erro: `${f} fora da faixa (|valor| > ${RX_LIMITES[tipo]})`, code: 'GRAU_INVALIDO' };
    }
    if (tipo === 'add' && n < 0) return { erro: `${f} nao pode ser negativa`, code: 'GRAU_INVALIDO' };
    valores[f] = arredondarQuarto(n);
  }

  for (const f of RX_AXIS_FIELDS) {
    if (!(f in body)) continue;
    if (body[f] == null || body[f] === '') { valores[f] = null; continue; }
    const n = Number(body[f]);
    if (!Number.isInteger(n) || n < 0 || n > 180) {
      return { erro: `${f} deve ser inteiro entre 0 e 180`, code: 'EIXO_INVALIDO' };
    }
    valores[f] = n;
  }

  for (const f of [...RX_PRISM_FIELDS, ...RX_MM_FIELDS]) {
    if (!(f in body)) continue;
    if (body[f] == null || body[f] === '') { valores[f] = null; continue; }
    const n = Number(body[f]);
    if (!Number.isFinite(n) || n < 0 || n > 99) {
      return { erro: `${f} deve ser numero entre 0 e 99`, code: 'MEDIDA_INVALIDA' };
    }
    valores[f] = RX_MM_FIELDS.includes(f) ? Math.round(n * 10) / 10 : Math.round(n * 100) / 100;
  }

  for (const f of RX_TEXT_FIELDS) {
    if (!(f in body)) continue;
    if (body[f] != null && typeof body[f] !== 'string') return { erro: `${f} deve ser texto` };
    valores[f] = body[f] ? String(body[f]).trim() || null : null;
  }

  if ('prescriber_type' in body) {
    if (!PRESCRIBER_TYPES.includes(body.prescriber_type)) {
      return { erro: `prescriber_type deve ser um de: ${PRESCRIBER_TYPES.join(', ')}`, code: 'PRESCRITOR_INVALIDO' };
    }
    valores.prescriber_type = body.prescriber_type;
  }

  if ('measured_by' in body) {
    if (body.measured_by && !UUID_RE.test(String(body.measured_by))) return { erro: 'measured_by deve ser uuid' };
    valores.measured_by = body.measured_by || null;
  }

  if (!parcial || 'issued_at' in body) {
    if (!dataValida(body.issued_at)) return { erro: 'issued_at obrigatorio (YYYY-MM-DD)', code: 'DATA_INVALIDA' };
    valores.issued_at = body.issued_at;
  }
  if ('valid_until' in body && body.valid_until != null && body.valid_until !== '') {
    if (!dataValida(body.valid_until)) return { erro: 'valid_until deve ser YYYY-MM-DD', code: 'DATA_INVALIDA' };
    valores.valid_until = body.valid_until;
  }

  // Nas duas datas presentes, a validade nao pode anteceder a emissao.
  if (valores.issued_at && valores.valid_until && valores.valid_until < valores.issued_at) {
    return { erro: 'valid_until deve ser >= issued_at', code: 'DATA_INVALIDA' };
  }

  return { valores };
}

const SELECT_RX = `
  SELECT p.*,
         c.name  AS customer_name,
         c.phone AS customer_phone,
         e.name  AS measured_by_name
    FROM optical_prescriptions p
    JOIN customers c ON c.id = p.customer_id
    LEFT JOIN employees e ON e.id = p.measured_by
`;

async function carregarReceita(rxId, companyId) {
  const { rows } = await db.query(
    `${SELECT_RX} WHERE p.id = $1 AND p.company_id = $2`,
    [rxId, companyId]
  );
  return rows[0] || null;
}

async function validarClienteEMedidor(cid, { customer_id, measured_by }) {
  if (customer_id) {
    const cust = await db.query(
      'SELECT id FROM customers WHERE id = $1 AND company_id = $2',
      [customer_id, cid]
    );
    if (!cust.rows.length) {
      const err = new Error('Cliente nao encontrado nesta empresa');
      err.status = 404;
      throw err;
    }
  }
  if (measured_by) {
    const emp = await db.query(
      'SELECT id FROM employees WHERE id = $1 AND company_id = $2',
      [measured_by, cid]
    );
    if (!emp.rows.length) {
      const err = new Error('Funcionario nao encontrado nesta empresa');
      err.status = 404;
      throw err;
    }
  }
}

// ─── GET /otica/prescriptions ────────────────────────────────
router.get('/prescriptions', async function (req, res) {
  const cid = req.params.id;
  const { customer_id, q, from, to, expiring_days } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

  const params = [cid];
  let where = 'p.company_id = $1';

  if (customer_id) {
    params.push(customer_id);
    where += ` AND p.customer_id = $${params.length}`;
  }
  if (q && String(q).trim()) {
    params.push(`%${String(q).trim()}%`);
    where += ` AND (c.name ILIKE $${params.length} OR p.prescriber_name ILIKE $${params.length})`;
  }
  if (from) {
    if (!dataValida(from)) return res.status(400).json({ error: 'from deve ser YYYY-MM-DD' });
    params.push(from);
    where += ` AND p.issued_at >= $${params.length}::date`;
  }
  if (to) {
    if (!dataValida(to)) return res.status(400).json({ error: 'to deve ser YYYY-MM-DD' });
    params.push(to);
    where += ` AND p.issued_at <= $${params.length}::date`;
  }
  if (expiring_days != null && expiring_days !== '') {
    const n = parseInt(expiring_days, 10);
    if (!Number.isInteger(n) || n < 0) return res.status(400).json({ error: 'expiring_days deve ser inteiro >= 0' });
    params.push(n);
    // Hoje em Sao Paulo, nao em UTC: as 22h de Brasilia a receita que
    // vence "hoje" ainda esta na lista.
    where += ` AND p.valid_until BETWEEN (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
                                     AND (NOW() AT TIME ZONE 'America/Sao_Paulo')::date + $${params.length}::int`;
  }
  params.push(limit);

  try {
    const { rows } = await db.query(
      `${SELECT_RX} WHERE ${where} ORDER BY p.issued_at DESC, p.created_at DESC LIMIT $${params.length}`,
      params
    );
    res.json({ prescriptions: rows });
  } catch (err) {
    if (err.code === '42P01') return res.json({ prescriptions: [] });
    falhar(res, err, 'GET:prescriptions');
  }
});

// ─── POST /otica/prescriptions ───────────────────────────────
router.post('/prescriptions', async function (req, res) {
  const cid = req.params.id;
  const body = req.body || {};

  if (!body.customer_id) return res.status(400).json({ error: 'customer_id obrigatorio' });
  const v = validarReceita(body, { parcial: false });
  if (v.erro) return res.status(400).json({ error: v.erro, code: v.code });

  try {
    await assertOticaEnabled(cid);
    await validarClienteEMedidor(cid, { customer_id: body.customer_id, measured_by: v.valores.measured_by });

    const settings = await carregarOticaSettings(cid);
    const meses = Number(settings && settings.prescription_validity_months) || OTICA_DEFAULTS.prescription_validity_months;

    const valores = { prescriber_type: 'medico', ...v.valores };
    const colunas = ['company_id', 'customer_id', 'created_by'];
    const params  = [cid, body.customer_id, req.user?.id || null];
    for (const col of RX_COLUNAS) {
      if (col === 'valid_until') continue;
      if (!(col in valores)) continue;
      colunas.push(col);
      params.push(valores[col]);
    }
    // valid_until default no SQL, a partir da emissao + validade padrao da
    // loja: soma de meses e conta do banco (30/01 + 1 mes = 28/02 sem
    // surpresa de fuso nem de mes curto).
    const placeholders = colunas.map((c, i) => `$${i + 1}`);
    const idxIssued = colunas.indexOf('issued_at') + 1;
    params.push(valores.valid_until || null);
    const pValid = params.length;
    params.push(meses);
    const pMeses = params.length;
    colunas.push('valid_until');
    placeholders.push(
      `COALESCE($${pValid}::date, ($${idxIssued}::date + make_interval(months => $${pMeses}::int))::date)`
    );

    const { rows } = await db.query(
      `INSERT INTO optical_prescriptions (${colunas.join(', ')})
       VALUES (${placeholders.join(', ')})
       RETURNING id`,
      params
    );
    res.status(201).json({ prescription: await carregarReceita(rows[0].id, cid) });
  } catch (err) {
    falhar(res, err, 'POST:prescriptions');
  }
});

// ─── GET /otica/prescriptions/book ───────────────────────────
// Livro de receitas: registro cronologico do que a otica aviou, com o
// prescritor e as OS que usaram cada receita. E o que a vigilancia
// sanitaria pede na visita — por isso e uma rota propria e nao um filtro
// da listagem. ANTES de /:rxId: 'book' nao e uuid.
router.get('/prescriptions/book', async function (req, res) {
  const cid = req.params.id;
  const { from, to } = req.query;
  if (from && !dataValida(from)) return res.status(400).json({ error: 'from deve ser YYYY-MM-DD' });
  if (to && !dataValida(to)) return res.status(400).json({ error: 'to deve ser YYYY-MM-DD' });

  try {
    const { rows } = await db.query(
      `SELECT p.id, p.issued_at, p.valid_until,
              c.name AS customer_name,
              p.prescriber_type, p.prescriber_name, p.prescriber_registry,
              COALESCE(
                (SELECT json_agg(so.os_number ORDER BY so.os_number)
                   FROM service_orders so
                  WHERE so.company_id = p.company_id
                    AND so.kind = 'otica'
                    AND so.optical->>'prescription_id' = p.id::text
                    AND so.os_number IS NOT NULL),
                '[]'::json) AS os_numbers
         FROM optical_prescriptions p
         JOIN customers c ON c.id = p.customer_id
        WHERE p.company_id = $1
          AND ($2::date IS NULL OR p.issued_at >= $2::date)
          AND ($3::date IS NULL OR p.issued_at <= $3::date)
        ORDER BY p.issued_at ASC, p.created_at ASC`,
      [cid, from || null, to || null]
    );
    res.json({ rows });
  } catch (err) {
    if (err.code === '42P01') return res.json({ rows: [] });
    falhar(res, err, 'GET:prescriptions/book');
  }
});

// ─── GET /otica/prescriptions/:rxId ──────────────────────────
router.get('/prescriptions/:rxId', async function (req, res) {
  try {
    const rx = await carregarReceita(req.params.rxId, req.params.id);
    if (!rx) return res.status(404).json({ error: 'Receita nao encontrada' });
    res.json({ prescription: rx });
  } catch (err) {
    falhar(res, err, 'GET:prescriptions/id');
  }
});

// ─── PATCH /otica/prescriptions/:rxId ────────────────────────
// customer_id NAO e editavel: receita e do cliente; trocar o dono seria
// mover dado de saude de uma pessoa pra outra. Cadastra outra.
router.patch('/prescriptions/:rxId', async function (req, res) {
  const cid = req.params.id;
  const body = req.body || {};
  const v = validarReceita(body, { parcial: true });
  if (v.erro) return res.status(400).json({ error: v.erro, code: v.code });

  try {
    await assertOticaEnabled(cid);

    const atual = await carregarReceita(req.params.rxId, cid);
    if (!atual) return res.status(404).json({ error: 'Receita nao encontrada' });

    // A regra valid_until >= issued_at vale tambem quando so UMA das duas
    // veio no PATCH — compara com a que ja esta gravada.
    const issued = v.valores.issued_at || String(atual.issued_at instanceof Date
      ? atual.issued_at.toISOString().slice(0, 10) : atual.issued_at || '').slice(0, 10);
    const valid = v.valores.valid_until || String(atual.valid_until instanceof Date
      ? atual.valid_until.toISOString().slice(0, 10) : atual.valid_until || '').slice(0, 10);
    if (issued && valid && valid < issued) {
      return res.status(400).json({ error: 'valid_until deve ser >= issued_at', code: 'DATA_INVALIDA' });
    }

    await validarClienteEMedidor(cid, { measured_by: v.valores.measured_by });

    const sets = [];
    const params = [];
    for (const col of RX_COLUNAS) {
      if (!(col in v.valores)) continue;
      params.push(v.valores[col]);
      sets.push(`${col} = $${params.length}`);
    }
    if (!sets.length) return res.json({ prescription: atual });

    params.push(req.params.rxId, cid);
    await db.query(
      `UPDATE optical_prescriptions SET ${sets.join(', ')}
        WHERE id = $${params.length - 1} AND company_id = $${params.length}`,
      params
    );
    res.json({ prescription: await carregarReceita(req.params.rxId, cid) });
  } catch (err) {
    falhar(res, err, 'PATCH:prescriptions');
  }
});

// ─── DELETE /otica/prescriptions/:rxId ───────────────────────
// Receita que ja virou oculos e documento do que foi montado. A OS guarda
// snapshot, entao apagar nao perde o grau — mas perde o vinculo que o
// livro de receitas precisa mostrar. 409 e o cliente decide.
router.delete('/prescriptions/:rxId', async function (req, res) {
  const cid = req.params.id;
  try {
    await assertOticaEnabled(cid);

    const rx = await carregarReceita(req.params.rxId, cid);
    if (!rx) return res.status(404).json({ error: 'Receita nao encontrada' });

    let emUso = false;
    try {
      const r = await db.query(
        `SELECT 1 FROM service_orders
          WHERE company_id = $1 AND optical->>'prescription_id' = $2 LIMIT 1`,
        [cid, String(rx.id)]
      );
      emUso = r.rows.length > 0;
    } catch (e) {
      if (e.code !== '42703' && e.code !== '42P01') throw e;
    }
    if (emUso) {
      return res.status(409).json({
        error: 'Receita ja usada em ordem de servico. Nao pode ser excluida.',
        code: 'RECEITA_EM_USO',
      });
    }

    await db.query('DELETE FROM optical_prescriptions WHERE id = $1 AND company_id = $2', [rx.id, cid]);
    res.json({ deleted: true });
  } catch (err) {
    falhar(res, err, 'DELETE:prescriptions');
  }
});

// ─── GET /otica/dashboard ────────────────────────────────────
// So kind='otica', fora entregue/cancelada. 'atrasadas' e prazo vencido
// com o oculos ainda nao pronto — OS pronta esperando o cliente buscar
// nao e atraso da loja.
const LAB_STATUSES = ['aguardando_envio', 'no_laboratorio', 'recebida', 'em_montagem', 'refacao'];

router.get('/dashboard', async function (req, res) {
  const cid = req.params.id;
  const counts = {
    aguardando_envio: 0, no_laboratorio: 0, recebida: 0, em_montagem: 0, refacao: 0,
    pronta_aguardando_retirada: 0, atrasadas: 0,
  };
  let expiring = 0;

  try {
    try {
      const { rows } = await db.query(
        // Sem 'pronta': a OS pronta mantem o ultimo lab_status (em_montagem)
        // e sem este filtro apareceria duas vezes na esteira — na estacao de
        // montagem e em "prontas aguardando retirada".
        `SELECT lab_status, COUNT(*)::int AS n
           FROM service_orders
          WHERE company_id = $1 AND kind = 'otica'
            AND status NOT IN ('pronta','entregue','cancelada')
            AND lab_status IS NOT NULL
          GROUP BY lab_status`,
        [cid]
      );
      for (const r of rows) {
        if (LAB_STATUSES.includes(r.lab_status)) counts[r.lab_status] = r.n;
      }
      const extra = await db.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'pronta')::int AS prontas,
           COUNT(*) FILTER (WHERE promised_at < NOW()
                              AND status NOT IN ('pronta','entregue','cancelada'))::int AS atrasadas
           FROM service_orders
          WHERE company_id = $1 AND kind = 'otica'
            AND status NOT IN ('entregue','cancelada')`,
        [cid]
      );
      counts.pronta_aguardando_retirada = (extra.rows[0] && extra.rows[0].prontas) || 0;
      counts.atrasadas = (extra.rows[0] && extra.rows[0].atrasadas) || 0;
    } catch (e) {
      if (e.code !== '42703' && e.code !== '42P01') throw e;
    }

    try {
      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS n FROM optical_prescriptions
          WHERE company_id = $1
            AND valid_until BETWEEN (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
                                AND (NOW() AT TIME ZONE 'America/Sao_Paulo')::date + 30`,
        [cid]
      );
      expiring = (rows[0] && rows[0].n) || 0;
    } catch (e) {
      if (e.code !== '42P01') throw e;
    }

    res.json({ counts, expiring_prescriptions_30d: expiring });
  } catch (err) {
    falhar(res, err, 'GET:dashboard');
  }
});

module.exports = router;
module.exports.assertOticaEnabled = assertOticaEnabled;
module.exports.erroOticaDesligada = erroOticaDesligada;
module.exports.carregarOticaSettings = carregarOticaSettings;
module.exports.OTICA_DEFAULTS = OTICA_DEFAULTS;
module.exports.waParam = waParam;
module.exports.primeiroNome = primeiroNome;
module.exports._validarReceita = validarReceita;
