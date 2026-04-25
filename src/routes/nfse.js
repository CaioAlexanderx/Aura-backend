// ============================================================
// AURA. — W2-03 F3: Rotas NFS-e cross-vertical
//
// Endpoints (todos sob /companies/:cid/nfse):
//
//   Config:
//     GET    /config           ler config (sem decifrar api_key!)
//     PUT    /config           atualizar config (cifra api_key)
//
//   Notas:
//     POST   /                 emitir NFS-e
//     GET    /                 listar (filtros: status, customer_id, date_from, date_to)
//     GET    /:id              detalhe + provider_response
//     POST   /:id/cancel       cancelar (motivo obrigatorio min 15 chars)
//     POST   /:id/refresh      reconsulta status no provider (util pra status=processando)
//     GET    /:id/pdf          redirect/proxy pro PDF
//     GET    /:id/xml          redirect/proxy pro XML
//
// Mountada em private.js como /nfse — disponivel pra qualquer
// plano (todos os planos podem emitir NFS-e). Nao acoplada
// a vertical especifica.
// ============================================================

const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const crypto = require('crypto');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  getProvider,
  validateInvoiceData,
  NfseProviderError,
} = require('../services/nfseProvider');

const requireWrite = requireRole('client', 'analyst', 'admin');

// ─────────────────────────────────────────────────────────
// Helpers de cifragem das credentials
// ─────────────────────────────────────────────────────────
//
// Estrategia AES-256-GCM com chave em env AURA_ENCRYPTION_KEY (32 bytes).
// Em prod a chave fica em Railway env var. Em dev, fallback pra string fixa
// pra nao quebrar mas deve ser trocada antes de prod.
//
// Formato: base64(iv || authTag || ciphertext)
// IV 12 bytes (96 bits) — padrao GCM
// AuthTag 16 bytes (128 bits)
// ─────────────────────────────────────────────────────────

const ENCRYPTION_KEY_HEX = process.env.AURA_ENCRYPTION_KEY ||
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // dev fallback
const KEY = Buffer.from(ENCRYPTION_KEY_HEX, 'hex');

function encrypt(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decrypt(encoded) {
  if (!encoded) return null;
  try {
    const buf = Buffer.from(encoded, 'base64');
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    console.error('[nfse decrypt] failed:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────
// Helpers de DB
// ─────────────────────────────────────────────────────────

async function getCompany(cid) {
  const { rows } = await db.query(
    `SELECT id, legal_name, trade_name, cnpj, address_street AS logradouro,
            address_number AS numero, address_complement AS complemento,
            address_neighborhood AS bairro, address_city AS municipio,
            address_state AS uf, address_zip AS cep, address_city_code AS codigo_municipio
       FROM companies WHERE id = $1`,
    [cid]
  );
  return rows[0] || null;
}

async function getNfseConfig(cid) {
  const { rows } = await db.query(
    `SELECT * FROM nfse_config WHERE company_id = $1`,
    [cid]
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────

// GET /config — leitura. NUNCA retorna api_key/cert_pwd descifrados.
router.get('/config', requireAuth, async (req, res) => {
  try {
    const config = await getNfseConfig(req.params.id);
    if (!config) {
      return res.json({ config: null, has_config: false });
    }

    // Mascara campos sensiveis
    const safe = { ...config };
    safe.api_key_encrypted = config.api_key_encrypted ? '***configured***' : null;
    safe.api_secret = config.api_secret ? '***configured***' : null;
    safe.certificate_pwd = config.certificate_pwd ? '***configured***' : null;
    delete safe.api_key_encrypted;
    safe.has_api_key = !!config.api_key_encrypted;
    safe.has_certificate = !!config.certificate_url;

    res.json({ config: safe, has_config: true });
  } catch (err) {
    console.error('[nfse get config]', err.message);
    res.status(500).json({ error: 'Erro ao buscar config' });
  }
});

// PUT /config — upsert
router.put('/config', requireAuth, requireWrite, async (req, res) => {
  const ALLOWED = [
    'provider', 'ambiente',
    'inscricao_municipal', 'regime_tributario', 'regime_especial',
    'optante_simples_nacional', 'incentivador_cultural',
    'default_service_code', 'default_cnae', 'default_iss_rate',
    'serie', 'is_active',
  ];

  const body = req.body || {};
  const data = {};
  for (const k of ALLOWED) {
    if (body[k] !== undefined) data[k] = body[k];
  }

  // api_key e secret sao tratados separadamente — cifrados antes de salvar
  if (body.api_key) data.api_key_encrypted = encrypt(body.api_key);
  if (body.api_secret) data.api_secret = body.api_secret; // alguns providers nao cifram secret
  if (body.certificate_url) data.certificate_url = body.certificate_url;
  if (body.certificate_pwd) data.certificate_pwd = encrypt(body.certificate_pwd);

  try {
    // Upsert
    const existing = await getNfseConfig(req.params.id);

    if (existing) {
      const fields = [];
      const values = [];
      let idx = 1;
      for (const [k, v] of Object.entries(data)) {
        fields.push(`${k} = $${idx++}`);
        values.push(v);
      }
      if (fields.length === 0) return res.status(400).json({ error: 'Nada pra atualizar' });
      values.push(req.params.id);

      const { rows } = await db.query(
        `UPDATE nfse_config SET ${fields.join(', ')} WHERE company_id = $${idx} RETURNING id`,
        values
      );
      return res.json({ ok: true, config_id: rows[0].id });
    } else {
      // Insert
      data.company_id = req.params.id;
      const cols = Object.keys(data);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await db.query(
        `INSERT INTO nfse_config (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
        Object.values(data)
      );
      return res.status(201).json({ ok: true, config_id: rows[0].id });
    }
  } catch (err) {
    console.error('[nfse put config]', err.message);
    res.status(500).json({ error: 'Erro ao salvar config' });
  }
});

// ─────────────────────────────────────────────────────────
// NOTAS
// ─────────────────────────────────────────────────────────

// POST / — emitir NFS-e
router.post('/', requireAuth, requireWrite, async (req, res) => {
  const cid = req.params.id;
  const {
    customer_id, appointment_id, treatment_plan_id, payment_id, source_type,
    service_code, service_description, service_amount,
    iss_rate, iss_retained, deductions,
    inss_value, ir_value, csll_value, cofins_value, pis_value,
    competence_date,
    recipient_name, recipient_doc, recipient_email, recipient_phone, recipient_address,
    recipient_type,
  } = req.body || {};

  if (!service_description) return res.status(400).json({ error: 'service_description obrigatorio' });
  if (!service_amount || service_amount <= 0) {
    return res.status(400).json({ error: 'service_amount deve ser > 0' });
  }
  if (!recipient_name) return res.status(400).json({ error: 'recipient_name obrigatorio' });
  if (!recipient_doc) return res.status(400).json({ error: 'recipient_doc (CPF/CNPJ) obrigatorio' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Carrega config + decifra api_key
    const config = await getNfseConfig(cid);
    if (!config) {
      throw new NfseProviderError('NFS-e nao configurada nesta empresa', 'CONFIG_MISSING');
    }
    if (!config.is_active) {
      throw new NfseProviderError('NFS-e desativada. Ative no painel de config.', 'CONFIG_INACTIVE');
    }

    config._decrypted_api_key = decrypt(config.api_key_encrypted);
    if (!config._decrypted_api_key && config.provider !== 'mock') {
      throw new NfseProviderError(
        'API key nao configurada. Configure em /nfse/config.',
        'CONFIG_MISSING'
      );
    }

    // Carrega empresa
    const company = await getCompany(cid);
    if (!company) throw new NfseProviderError('Empresa nao encontrada', 'CONFIG_MISSING');
    if (!company.cnpj) {
      throw new NfseProviderError('CNPJ da empresa nao cadastrado', 'CONFIG_MISSING');
    }

    // Defaults da config
    const finalServiceCode = service_code || config.default_service_code;
    const finalIssRate = iss_rate !== undefined ? iss_rate : config.default_iss_rate;
    const finalIssValue = parseFloat((service_amount * (finalIssRate / 100)).toFixed(2));

    if (!finalServiceCode) {
      throw new NfseProviderError(
        'service_code obrigatorio. Configure default_service_code ou passe explicito.',
        'INVALID_INPUT'
      );
    }

    // RPS atomico (chama funcao SQL)
    const { rows: rpsRows } = await client.query(
      `SELECT nfse_next_rps($1) AS rps_number`,
      [cid]
    );
    const rpsNumber = rpsRows[0].rps_number;

    // Monta invoiceData
    const invoiceData = {
      company,
      config,
      rps_number: rpsNumber,
      rps_serie:  config.serie || '1',
      service_code:        finalServiceCode,
      service_description,
      service_amount:      parseFloat(service_amount),
      iss_rate:            parseFloat(finalIssRate),
      iss_value:           finalIssValue,
      iss_retained:        !!iss_retained,
      competence_date:     competence_date || null,
      recipient: {
        type:    recipient_type || 'pf',
        name:    recipient_name,
        doc:     recipient_doc,
        email:   recipient_email,
        phone:   recipient_phone,
        address: recipient_address,
      },
    };

    // Valida
    const validationErrors = validateInvoiceData(invoiceData);
    if (validationErrors.length > 0) {
      throw new NfseProviderError(
        'Dados invalidos: ' + validationErrors.join('; '),
        'INVALID_INPUT',
        validationErrors
      );
    }

    // Insere registro com status pendente ANTES de chamar provider
    // (assim se a chamada falhar, ainda temos rastro)
    const { rows: nfseRows } = await client.query(
      `INSERT INTO nfse (
        company_id, customer_id, appointment_id, treatment_plan_id, payment_id, source_type,
        rps_number, rps_serie, status,
        recipient_type, recipient_name, recipient_doc, recipient_email, recipient_phone, recipient_address,
        service_code, service_description, service_amount,
        iss_rate, iss_value, iss_retained,
        deductions, inss_value, ir_value, csll_value, cofins_value, pis_value,
        net_amount, competence_date, provider
      ) VALUES (
        $1,$2,$3,$4,$5,$6, $7,$8,'pendente',
        $9,$10,$11,$12,$13,$14,
        $15,$16,$17, $18,$19,$20,
        $21,$22,$23,$24,$25,$26, $27,$28,$29
      ) RETURNING id`,
      [
        cid, customer_id || null, appointment_id || null, treatment_plan_id || null,
        payment_id || null, source_type || 'manual',
        rpsNumber, config.serie || '1',
        recipient_type || 'pf', recipient_name, recipient_doc,
        recipient_email || null, recipient_phone || null,
        recipient_address ? JSON.stringify(recipient_address) : null,
        finalServiceCode, service_description, service_amount,
        finalIssRate, finalIssValue, !!iss_retained,
        deductions || 0, inss_value || 0, ir_value || 0,
        csll_value || 0, cofins_value || 0, pis_value || 0,
        // net_amount = service_amount - deductions - iss(se retido) - inss - ir - csll - cofins - pis
        parseFloat(service_amount) - parseFloat(deductions || 0)
          - (iss_retained ? finalIssValue : 0)
          - parseFloat(inss_value || 0) - parseFloat(ir_value || 0)
          - parseFloat(csll_value || 0) - parseFloat(cofins_value || 0)
          - parseFloat(pis_value || 0),
        competence_date || null,
        config.provider,
      ]
    );
    const nfseId = nfseRows[0].id;

    await client.query('COMMIT');

    // Chama provider FORA da transacao (rede pode demorar)
    let result;
    try {
      const provider = getProvider(config);
      result = await provider.emit(invoiceData);
    } catch (err) {
      // Marca como rejeitada e retorna erro
      await db.query(
        `UPDATE nfse SET status = 'rejeitada', rejection_reason = $1 WHERE id = $2`,
        [err.message || 'Erro desconhecido', nfseId]
      );
      throw err;
    }

    // Atualiza com response do provider
    await db.query(
      `UPDATE nfse SET
        status = $1,
        provider_id = $2,
        nfse_number = $3,
        verification_code = $4,
        pdf_url = $5,
        xml_url = $6,
        issued_at = $7,
        provider_response = $8
       WHERE id = $9`,
      [
        result.status,
        result.provider_id,
        result.nfse_number,
        result.verification_code,
        result.pdf_url,
        result.xml_url,
        result.issued_at,
        JSON.stringify(result.raw_response),
        nfseId,
      ]
    );

    res.status(201).json({
      nfse_id: nfseId,
      status: result.status,
      nfse_number: result.nfse_number,
      verification_code: result.verification_code,
      pdf_url: result.pdf_url,
      xml_url: result.xml_url,
      rps_number: rpsNumber,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}

    if (err instanceof NfseProviderError) {
      console.error('[nfse emit]', err.code, err.message);
      const status = err.code === 'CONFIG_MISSING' || err.code === 'CONFIG_INACTIVE' ? 400
                  : err.code === 'INVALID_INPUT' ? 400
                  : err.code === 'PROVIDER_NOT_IMPLEMENTED' ? 501
                  : err.code === 'TIMEOUT' ? 504
                  : 502;
      return res.status(status).json({ error: err.message, code: err.code });
    }

    console.error('[nfse emit] unexpected:', err.message);
    res.status(500).json({ error: 'Erro ao emitir NFS-e' });
  } finally {
    client.release();
  }
});

// GET / — listar
router.get('/', requireAuth, async (req, res) => {
  const cid = req.params.id;
  const { status, customer_id, date_from, date_to, limit = 50 } = req.query;

  const params = [cid];
  let where = 'WHERE n.company_id = $1';

  if (status) { params.push(status); where += ` AND n.status = $${params.length}`; }
  if (customer_id) { params.push(customer_id); where += ` AND n.customer_id = $${params.length}`; }
  if (date_from) {
    params.push(date_from);
    where += ` AND n.created_at >= $${params.length}`;
  }
  if (date_to) {
    params.push(date_to);
    where += ` AND n.created_at <= $${params.length}`;
  }
  params.push(Math.min(parseInt(limit) || 50, 200));

  try {
    const { rows } = await db.query(
      `SELECT n.id, n.rps_number, n.rps_serie, n.nfse_number, n.verification_code,
              n.status, n.rejection_reason,
              n.recipient_name, n.recipient_doc, n.recipient_type,
              n.service_description, n.service_amount, n.iss_value, n.iss_rate,
              n.net_amount, n.issued_at, n.competence_date, n.cancelled_at,
              n.pdf_url, n.xml_url, n.provider, n.source_type,
              n.created_at, n.updated_at,
              c.full_name AS customer_full_name, c.name AS customer_name
         FROM nfse n
         LEFT JOIN customers c ON c.id = n.customer_id
         ${where}
        ORDER BY n.created_at DESC
        LIMIT $${params.length}`,
      params
    );

    // Stats agregadas
    const { rows: stats } = await db.query(
      `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(service_amount), 0)::numeric AS total
         FROM nfse WHERE company_id = $1
         GROUP BY status`,
      [cid]
    );

    res.json({ nfse: rows, stats });
  } catch (err) {
    console.error('[nfse list]', err.message);
    res.status(500).json({ error: 'Erro ao listar' });
  }
});

// GET /:id — detalhe
router.get('/:nid', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT n.*,
              c.full_name AS customer_full_name, c.name AS customer_name
         FROM nfse n
         LEFT JOIN customers c ON c.id = n.customer_id
        WHERE n.id = $1 AND n.company_id = $2`,
      [req.params.nid, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'NFS-e nao encontrada' });
    res.json({ nfse: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar NFS-e' });
  }
});

// POST /:id/cancel — cancelar
router.post('/:nid/cancel', requireAuth, requireWrite, async (req, res) => {
  const { reason } = req.body || {};
  if (!reason || reason.trim().length < 15) {
    return res.status(400).json({ error: 'reason obrigatorio (min 15 caracteres)' });
  }

  try {
    const { rows } = await db.query(
      `SELECT n.*, c.api_key_encrypted, c.provider, c.is_active, c.ambiente,
              c.inscricao_municipal, c.regime_tributario, c.regime_especial,
              c.optante_simples_nacional
         FROM nfse n
         JOIN nfse_config c ON c.company_id = n.company_id
        WHERE n.id = $1 AND n.company_id = $2`,
      [req.params.nid, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'NFS-e nao encontrada' });

    const nfse = rows[0];
    if (nfse.status === 'cancelada') {
      return res.status(409).json({ error: 'NFS-e ja foi cancelada' });
    }
    if (nfse.status !== 'autorizada') {
      return res.status(409).json({ error: `Nao e possivel cancelar NFS-e com status "${nfse.status}"` });
    }
    if (!nfse.provider_id) {
      return res.status(409).json({ error: 'NFS-e sem provider_id (nao foi processada)' });
    }

    const config = {
      provider:                 nfse.provider,
      is_active:                nfse.is_active,
      ambiente:                 nfse.ambiente,
      inscricao_municipal:      nfse.inscricao_municipal,
      regime_tributario:        nfse.regime_tributario,
      regime_especial:          nfse.regime_especial,
      optante_simples_nacional: nfse.optante_simples_nacional,
      _decrypted_api_key:       decrypt(nfse.api_key_encrypted),
    };

    const provider = getProvider(config);
    await provider.cancel(nfse.provider_id, reason);

    await db.query(
      `UPDATE nfse SET status = 'cancelada', cancelled_at = NOW(), cancel_reason = $1
        WHERE id = $2`,
      [reason, req.params.nid]
    );

    res.json({ ok: true });
  } catch (err) {
    if (err instanceof NfseProviderError) {
      return res.status(502).json({ error: err.message, code: err.code });
    }
    console.error('[nfse cancel]', err.message);
    res.status(500).json({ error: 'Erro ao cancelar NFS-e' });
  }
});

// POST /:id/refresh — reconsulta status no provider
router.post('/:nid/refresh', requireAuth, requireWrite, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT n.id, n.provider_id, n.status,
              c.api_key_encrypted, c.provider AS config_provider, c.is_active,
              c.ambiente, c.inscricao_municipal, c.regime_tributario,
              c.regime_especial, c.optante_simples_nacional
         FROM nfse n
         JOIN nfse_config c ON c.company_id = n.company_id
        WHERE n.id = $1 AND n.company_id = $2`,
      [req.params.nid, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'NFS-e nao encontrada' });

    const nfse = rows[0];
    if (!nfse.provider_id) {
      return res.status(409).json({ error: 'NFS-e sem provider_id' });
    }

    const config = {
      provider: nfse.config_provider,
      is_active: nfse.is_active,
      ambiente: nfse.ambiente,
      inscricao_municipal: nfse.inscricao_municipal,
      regime_tributario: nfse.regime_tributario,
      regime_especial: nfse.regime_especial,
      optante_simples_nacional: nfse.optante_simples_nacional,
      _decrypted_api_key: decrypt(nfse.api_key_encrypted),
    };

    const provider = getProvider(config);
    const result = await provider.consult(nfse.provider_id);

    await db.query(
      `UPDATE nfse SET
        status = $1,
        nfse_number = COALESCE($2, nfse_number),
        verification_code = COALESCE($3, verification_code),
        pdf_url = COALESCE($4, pdf_url),
        xml_url = COALESCE($5, xml_url),
        issued_at = COALESCE($6::timestamptz, issued_at),
        rejection_reason = $7,
        provider_response = $8
       WHERE id = $9`,
      [
        result.status,
        result.nfse_number,
        result.verification_code,
        result.pdf_url,
        result.xml_url,
        result.issued_at,
        result.rejection_reason || null,
        JSON.stringify(result.raw_response),
        req.params.nid,
      ]
    );

    res.json({ status: result.status, nfse_number: result.nfse_number });
  } catch (err) {
    if (err instanceof NfseProviderError) {
      return res.status(502).json({ error: err.message, code: err.code });
    }
    console.error('[nfse refresh]', err.message);
    res.status(500).json({ error: 'Erro ao consultar NFS-e' });
  }
});

// GET /:id/pdf e /:id/xml — redirect pro URL salvo
router.get('/:nid/pdf', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT pdf_url FROM nfse WHERE id = $1 AND company_id = $2`,
    [req.params.nid, req.params.id]
  );
  if (!rows[0]?.pdf_url) return res.status(404).json({ error: 'PDF nao disponivel' });
  res.redirect(rows[0].pdf_url);
});

router.get('/:nid/xml', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    `SELECT xml_url FROM nfse WHERE id = $1 AND company_id = $2`,
    [req.params.nid, req.params.id]
  );
  if (!rows[0]?.xml_url) return res.status(404).json({ error: 'XML nao disponivel' });
  res.redirect(rows[0].xml_url);
});

module.exports = router;
