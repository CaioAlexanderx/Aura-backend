// ============================================================
// AURA. — Sprint 4 v2: NF-e Routes (Nuvem Fiscal)
// Fase 1: NFS-e (servicos) | Fase 2: NFC-e (varejo)
// FREE tier: 1,000 ops/month, unlimited CNPJs
// Mounted at: /companies/:id/nfe
// ============================================================

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const nuvem = require('../services/nuvemfiscal');

// ── Helper: get company with NFe config ──────────────────
async function getCompanyNfe(companyId) {
  const { rows } = await db.query(
    `SELECT id, legal_name, trade_name, name, cnpj, email, phone,
            address, inscricao_municipal, focus_company_id,
            certificate_uploaded, tax_regime,
            address_street, address_number, address_neighborhood,
            address_city, address_state, address_zip, ibge_code,
            inscricao_estadual
     FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!rows.length) throw new Error('Empresa nao encontrada');
  return rows[0];
}

// ── POST /nfe/setup — Register company with Nuvem Fiscal ──
router.post('/setup', async (req, res) => {
  const cid = req.params.id;
  try {
    const company = await getCompanyNfe(cid);
    if (company.focus_company_id) {
      return res.json({ message: 'Empresa ja registrada', provider_id: company.focus_company_id });
    }
    const result = await nuvem.registerCompany(company);
    const providerId = result.cpf_cnpj || company.cnpj?.replace(/\D/g, '');
    await db.query(
      'UPDATE companies SET focus_company_id = $1, updated_at = NOW() WHERE id = $2',
      [providerId, cid]
    );
    res.status(201).json({ message: 'Empresa registrada na Nuvem Fiscal', provider_id: providerId });
  } catch (err) {
    console.error('[NFE] Setup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /nfe/certificate — Upload certificate A1 ────────
router.post('/certificate', async (req, res) => {
  const cid = req.params.id;
  const { certificate, password } = req.body;
  if (!certificate || !password) return res.status(400).json({ error: 'certificate (base64) e password obrigatorios' });
  try {
    const company = await getCompanyNfe(cid);
    if (!company.cnpj) return res.status(400).json({ error: 'Empresa sem CNPJ cadastrado' });
    await nuvem.uploadCertificate(company.cnpj, certificate, password);
    await db.query('UPDATE companies SET certificate_uploaded = true, updated_at = NOW() WHERE id = $1', [cid]);
    res.json({ message: 'Certificado A1 enviado com sucesso' });
  } catch (err) {
    console.error('[NFE] Certificate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /nfe/emit/nfse — Emit NFS-e ────────────────────
router.post('/emit/nfse', async (req, res) => {
  const cid = req.params.id;
  const { recipient_cnpj, recipient_cpf, recipient_name, recipient_email,
          description, service_code, value, iss_rate } = req.body;

  if (!value || value <= 0) return res.status(400).json({ error: 'value obrigatorio e > 0' });
  if (!description) return res.status(400).json({ error: 'description obrigatoria' });

  const ref = `nfse-${cid.slice(0,8)}-${Date.now()}`;

  try {
    const company = await getCompanyNfe(cid);
    if (!company.cnpj) return res.status(400).json({ error: 'Empresa sem CNPJ cadastrado' });
    if (!company.inscricao_municipal) return res.status(400).json({ error: 'Inscricao municipal nao cadastrada. Atualize em Configuracoes.' });

    // Save to DB
    await db.query(
      `INSERT INTO nfe_documents (company_id, ref, type, status, recipient_cnpj, recipient_name, description, service_code, value, iss_rate, payload)
       VALUES ($1,$2,'nfse','pending',$3,$4,$5,$6,$7,$8,$9)`,
      [cid, ref, recipient_cnpj || recipient_cpf || '', recipient_name || '', description, service_code || '', value, iss_rate || 2, JSON.stringify(req.body)]
    );

    // Emit via Nuvem Fiscal
    const result = await nuvem.emitNfse(company, req.body);
    const nuvemId = result.id || null;
    const status = result.status === 'autorizado' ? 'authorized'
                 : result.status === 'rejeitado' ? 'error'
                 : 'processing';

    await db.query(
      `UPDATE nfe_documents SET status=$1, focus_id=$2, number=$3, xml_url=$4, pdf_url=$5,
       error_message=$6, issued_at=CASE WHEN $1='authorized' THEN NOW() ELSE NULL END, updated_at=NOW()
       WHERE ref=$7 AND company_id=$8`,
      [status, nuvemId, result.numero || null, result.link_xml || null, result.link_pdf || null,
       result.mensagem || null, ref, cid]
    );

    res.status(201).json({ ref, nuvem_id: nuvemId, status, response: result });
  } catch (err) {
    console.error('[NFE] Emit NFSe error:', err.message);
    await db.query('UPDATE nfe_documents SET status=$1, error_message=$2 WHERE ref=$3', ['error', err.message, ref]).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// ── POST /nfe/emit/nfce — Emit NFC-e ────────────────────
router.post('/emit/nfce', async (req, res) => {
  const cid = req.params.id;
  const { items, total_value, payment_method, recipient_cpf, recipient_name } = req.body;

  if (!items?.length) return res.status(400).json({ error: 'items obrigatorio (array de produtos)' });
  if (!total_value || total_value <= 0) return res.status(400).json({ error: 'total_value obrigatorio' });

  const ref = `nfce-${cid.slice(0,8)}-${Date.now()}`;

  try {
    const company = await getCompanyNfe(cid);
    if (!company.cnpj) return res.status(400).json({ error: 'Empresa sem CNPJ cadastrado' });

    await db.query(
      `INSERT INTO nfe_documents (company_id, ref, type, status, recipient_cnpj, recipient_name, value, payload)
       VALUES ($1,$2,'nfce','pending',$3,$4,$5,$6)`,
      [cid, ref, recipient_cpf || '', recipient_name || 'Consumidor', total_value, JSON.stringify(req.body)]
    );

    const result = await nuvem.emitNfce(company, req.body);
    const nuvemId = result.id || null;
    const status = result.status === 'autorizado' ? 'authorized'
                 : result.status === 'rejeitado' ? 'error'
                 : 'processing';

    await db.query(
      `UPDATE nfe_documents SET status=$1, focus_id=$2, number=$3, access_key=$4, xml_url=$5, pdf_url=$6,
       error_message=$7, issued_at=CASE WHEN $1='authorized' THEN NOW() ELSE NULL END, updated_at=NOW()
       WHERE ref=$8 AND company_id=$9`,
      [status, nuvemId, result.numero || null, result.chave_acesso || null,
       result.link_xml || null, result.link_pdf || null, result.mensagem || null, ref, cid]
    );

    res.status(201).json({ ref, nuvem_id: nuvemId, status, response: result });
  } catch (err) {
    console.error('[NFE] Emit NFCe error:', err.message);
    await db.query('UPDATE nfe_documents SET status=$1, error_message=$2 WHERE ref=$3', ['error', err.message, ref]).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// ── GET /nfe/:ref — Query document status ────────────────
router.get('/:ref', async (req, res) => {
  const { id: cid, ref } = req.params;
  try {
    const { rows } = await db.query('SELECT * FROM nfe_documents WHERE ref=$1 AND company_id=$2', [ref, cid]);
    if (!rows.length) return res.status(404).json({ error: 'Documento nao encontrado' });
    const doc = rows[0];

    // If still processing, poll Nuvem Fiscal
    if ((doc.status === 'processing' || doc.status === 'pending') && doc.focus_id) {
      try {
        const queryFn = doc.type === 'nfse' ? nuvem.queryNfse : nuvem.queryNfce;
        const result = await queryFn(doc.focus_id);
        if (result.status === 'autorizado') {
          await db.query(
            `UPDATE nfe_documents SET status='authorized', number=$1, access_key=$2, xml_url=$3, pdf_url=$4, issued_at=NOW(), updated_at=NOW() WHERE ref=$5`,
            [result.numero || null, result.chave_acesso || result.codigo_verificacao || null,
             result.link_xml || null, result.link_pdf || null, ref]
          );
          doc.status = 'authorized';
          doc.number = result.numero;
          doc.pdf_url = result.link_pdf;
        }
      } catch {}
    }
    res.json(doc);
  } catch (err) { res.status(500).json({ error: 'Erro ao consultar documento' }); }
});

// ── POST /nfe/:ref/cancel — Cancel document ──────────────
router.post('/:ref/cancel', async (req, res) => {
  const { id: cid, ref } = req.params;
  const { justificativa } = req.body;
  try {
    const { rows } = await db.query('SELECT * FROM nfe_documents WHERE ref=$1 AND company_id=$2', [ref, cid]);
    if (!rows.length) return res.status(404).json({ error: 'Documento nao encontrado' });
    const doc = rows[0];
    if (doc.status === 'cancelled') return res.status(400).json({ error: 'Documento ja cancelado' });
    if (!doc.focus_id) return res.status(400).json({ error: 'Documento sem ID do provedor' });

    const cancelFn = doc.type === 'nfse' ? nuvem.cancelNfse : nuvem.cancelNfce;
    const result = await cancelFn(doc.focus_id, justificativa || 'Cancelamento solicitado');

    await db.query(
      `UPDATE nfe_documents SET status='cancelled', cancelled_at=NOW(), updated_at=NOW() WHERE ref=$1`,
      [ref]
    );
    res.json({ ref, status: 'cancelled', response: result });
  } catch (err) {
    console.error('[NFE] Cancel error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /nfe — List documents ────────────────────────────
router.get('/', async (req, res) => {
  const cid = req.params.id;
  const { type, status, limit = 50, offset = 0 } = req.query;
  try {
    let where = 'WHERE company_id = $1';
    const params = [cid];
    if (type) { params.push(type); where += ` AND type = $${params.length}`; }
    if (status) { params.push(status); where += ` AND status = $${params.length}`; }
    params.push(parseInt(limit), parseInt(offset));
    const { rows } = await db.query(
      `SELECT id, ref, type, status, number, recipient_name, description, value, issued_at, cancelled_at, created_at
       FROM nfe_documents ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const { rows: countRows } = await db.query(`SELECT COUNT(*) FROM nfe_documents ${where}`, params.slice(0, -2));
    res.json({ total: parseInt(countRows[0].count), documents: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao listar documentos' }); }
});

module.exports = router;
