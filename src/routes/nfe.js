// ============================================================
// AURA. — Sprint 4: NF-e Routes (Focus NFe)
// Fase 1: NFS-e (servicos) | Fase 2: NFC-e (varejo)
// Mounted at: /companies/:id/nfe
// ============================================================

const router = require('express').Router({ mergeParams: true });
const db = require('../config/database');
const focusnfe = require('../services/focusnfe');
const { v4: uuid } = require('uuid');

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

// ── POST /nfe/setup — Register company with Focus NFe ────
router.post('/setup', async (req, res) => {
  const cid = req.params.id;
  try {
    const company = await getCompanyNfe(cid);
    if (company.focus_company_id) {
      return res.json({ message: 'Empresa ja registrada na Focus NFe', focus_id: company.focus_company_id });
    }
    const result = await focusnfe.registerCompany(company);
    const focusId = result.data?.id || company.cnpj?.replace(/\D/g, '');
    await db.query(
      'UPDATE companies SET focus_company_id = $1, updated_at = NOW() WHERE id = $2',
      [focusId, cid]
    );
    res.status(201).json({ message: 'Empresa registrada na Focus NFe', focus_id: focusId });
  } catch (err) {
    console.error('[NFE] Setup error:', err.message);
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

    // Save to DB first
    const { rows } = await db.query(
      `INSERT INTO nfe_documents (company_id, ref, type, status, recipient_cnpj, recipient_name, description, service_code, value, iss_rate, payload)
       VALUES ($1,$2,'nfse','pending',$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [cid, ref, recipient_cnpj || recipient_cpf || '', recipient_name || '', description, service_code || '', value, iss_rate || 2, JSON.stringify(req.body)]
    );

    // Emit via Focus NFe
    const result = await focusnfe.emitNfse(ref, company, req.body);

    // Update with Focus response
    const status = result.data?.status || (result.status === 422 ? 'error' : 'processing');
    await db.query(
      `UPDATE nfe_documents SET status=$1, focus_id=$2, error_message=$3, updated_at=NOW() WHERE ref=$4 AND company_id=$5`,
      [status === 'autorizado' ? 'authorized' : status === 'erro_autorizacao' ? 'error' : 'processing',
       result.data?.id || null, result.data?.mensagem_sefaz || result.data?.erros?.[0]?.mensagem || null, ref, cid]
    );

    res.status(201).json({
      ref,
      status: result.data?.status || 'processing',
      focus_response: result.data,
      message: result.status === 422 ? 'Erro de validacao' : 'NFS-e em processamento',
    });
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

    const result = await focusnfe.emitNfce(ref, company, req.body);
    const status = result.data?.status || 'processing';

    await db.query(
      `UPDATE nfe_documents SET status=$1, focus_id=$2, number=$3, access_key=$4, xml_url=$5, pdf_url=$6, error_message=$7, issued_at=CASE WHEN $1='authorized' THEN NOW() ELSE NULL END, updated_at=NOW()
       WHERE ref=$8 AND company_id=$9`,
      [status === 'autorizado' ? 'authorized' : status === 'erro_autorizacao' ? 'error' : 'processing',
       result.data?.id || null, result.data?.numero || null, result.data?.chave_nfe || null,
       result.data?.caminho_xml_nota_fiscal || null, result.data?.caminho_danfe || null,
       result.data?.mensagem_sefaz || null, ref, cid]
    );

    res.status(201).json({ ref, status, focus_response: result.data });
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
    // Check local DB first
    const { rows } = await db.query('SELECT * FROM nfe_documents WHERE ref=$1 AND company_id=$2', [ref, cid]);
    if (!rows.length) return res.status(404).json({ error: 'Documento nao encontrado' });

    const doc = rows[0];
    // If still processing, check Focus NFe for updates
    if (doc.status === 'processing' || doc.status === 'pending') {
      try {
        const result = await focusnfe.query(doc.type, ref);
        if (result.data?.status === 'autorizado') {
          await db.query(
            `UPDATE nfe_documents SET status='authorized', number=$1, access_key=$2, xml_url=$3, pdf_url=$4, issued_at=NOW(), updated_at=NOW() WHERE ref=$5`,
            [result.data.numero || null, result.data.chave_nfe || result.data.codigo_verificacao || null,
             result.data.caminho_xml_nota_fiscal || result.data.url || null,
             result.data.caminho_danfe || result.data.url || null, ref]
          );
          doc.status = 'authorized';
          doc.number = result.data.numero;
          doc.pdf_url = result.data.caminho_danfe || result.data.url;
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

    const cancelFn = doc.type === 'nfse' ? focusnfe.cancelNfse : focusnfe.cancelNfce;
    const result = await cancelFn(ref, justificativa || 'Cancelamento solicitado');

    await db.query(
      `UPDATE nfe_documents SET status='cancelled', cancelled_at=NOW(), cancel_xml_url=$1, updated_at=NOW() WHERE ref=$2`,
      [result.data?.caminho_xml_cancelamento || null, ref]
    );
    res.json({ ref, status: 'cancelled', focus_response: result.data });
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
