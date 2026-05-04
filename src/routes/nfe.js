// ============================================================
// AURA. — NF-e Routes (Provedor Fiscal via Nuvem Fiscal)
// NFS-e (serviços) e NFC-e (varejo) via módulo fiscal dedicado
// Mounted at: /companies/:id/nfe
// ============================================================

const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');
const fiscal = require('../services/nuvemfiscal');
const { requireAuth, requireRole } = require('../middleware/auth');

// Helper: busca empresa com dados fiscais
async function getCompanyNfe(companyId) {
  const result = await db.query(
    `SELECT id, legal_name, trade_name, name, cnpj, email, phone, address,
            inscricao_municipal, focus_company_id, certificate_uploaded, tax_regime,
            address_street, address_number, address_neighborhood,
            address_city, address_state, address_zip,
            ibge_code, inscricao_estadual
     FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!result.rows.length) throw new Error('Empresa nao encontrada');
  return result.rows[0];
}

// POST /nfe/setup — Registra empresa no provedor fiscal (Nuvem Fiscal)
router.post('/setup', requireAuth, requireRole('client', 'analyst', 'admin'), async function(req, res) {
  const cid = req.params.id;
  try {
    const company = await getCompanyNfe(cid);
    if (company.focus_company_id) {
      return res.json({ message: 'Empresa ja registrada', provider_id: company.focus_company_id });
    }
    const result     = await fiscal.registerCompany(company);
    const providerId = result.cpf_cnpj || company.cnpj?.replace(/\D/g, '');
    await db.query(
      'UPDATE companies SET focus_company_id = $1, updated_at = NOW() WHERE id = $2',
      [providerId, cid]
    );
    res.status(201).json({ message: 'Empresa registrada no provedor fiscal', provider_id: providerId });
  } catch (err) {
    console.error('[NFE] Setup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /nfe/certificate — Upload de certificado A1
router.post('/certificate', requireAuth, requireRole('client', 'analyst', 'admin'), async function(req, res) {
  const cid         = req.params.id;
  const certificate = req.body.certificate;
  const password    = req.body.password;
  if (!certificate || !password) {
    return res.status(400).json({ error: 'certificate (base64) e password obrigatorios' });
  }
  try {
    const company = await getCompanyNfe(cid);
    if (!company.cnpj) return res.status(400).json({ error: 'Empresa sem CNPJ cadastrado' });
    await fiscal.uploadCertificate(company.cnpj, certificate, password);
    await db.query('UPDATE companies SET certificate_uploaded = true, updated_at = NOW() WHERE id = $1', [cid]);
    res.json({ message: 'Certificado A1 enviado com sucesso' });
  } catch (err) {
    console.error('[NFE] Certificate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /nfe/emit/nfse — Emite NFS-e (Nota Fiscal de Serviço)
router.post('/emit/nfse', requireAuth, requireRole('client', 'analyst', 'admin'), async function(req, res) {
  const cid  = req.params.id;
  const body = req.body;

  if (!body.value || body.value <= 0)  return res.status(400).json({ error: 'value obrigatorio e > 0' });
  if (!body.description)               return res.status(400).json({ error: 'description obrigatoria' });

  const ref = 'nfse-' + cid.slice(0, 8) + '-' + Date.now();

  try {
    const company = await getCompanyNfe(cid);
    if (!company.cnpj)               return res.status(400).json({ error: 'Empresa sem CNPJ cadastrado' });
    if (!company.inscricao_municipal) return res.status(400).json({ error: 'Inscricao municipal nao cadastrada. Atualize em Configuracoes.' });

    await db.query(
      `INSERT INTO nfe_documents
         (company_id, ref, type, status, recipient_cnpj, recipient_name,
          description, service_code, value, iss_rate, payload)
       VALUES ($1,$2,'nfse','pending',$3,$4,$5,$6,$7,$8,$9)`,
      [cid, ref,
       body.recipient_cnpj || body.recipient_cpf || '',
       body.recipient_name || '',
       body.description,
       body.service_code || '',
       body.value,
       body.iss_rate || 2,
       JSON.stringify(body)]
    );

    const result = await fiscal.emitNfse(company, body);
    const docId  = result.id || null;
    const status = result.status === 'autorizado' ? 'authorized'
                 : result.status === 'rejeitado'  ? 'error'
                 : 'processing';

    await db.query(
      `UPDATE nfe_documents
          SET status = $1, focus_id = $2, number = $3, xml_url = $4, pdf_url = $5,
              error_message = $6,
              issued_at = CASE WHEN $1 = 'authorized' THEN NOW() ELSE NULL END,
              updated_at = NOW()
        WHERE ref = $7 AND company_id = $8`,
      [status, docId, result.numero || null, result.link_xml || null,
       result.link_pdf || null, result.mensagem || null, ref, cid]
    );

    res.status(201).json({ ref, doc_id: docId, status, response: result });
  } catch (err) {
    console.error('[NFE] Emit NFSe error:', err.message);
    await db.query(
      'UPDATE nfe_documents SET status=$1, error_message=$2 WHERE ref=$3',
      ['error', err.message, ref]
    ).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// POST /nfe/emit/nfce — Emite NFC-e via módulo fiscal dedicado
router.post('/emit/nfce', requireAuth, requireRole('client', 'analyst', 'admin'), async function(req, res) {
  const cid  = req.params.id;
  const body = req.body;

  if (!body.items?.length) return res.status(400).json({ error: 'items obrigatorio (array de produtos)' });
  if (!body.total_value || body.total_value <= 0) return res.status(400).json({ error: 'total_value obrigatorio' });

  const ref = 'nfce-' + cid.slice(0, 8) + '-' + Date.now();

  try {
    const company = await getCompanyNfe(cid);
    if (!company.cnpj) return res.status(400).json({ error: 'Empresa sem CNPJ cadastrado' });

    await db.query(
      `INSERT INTO nfe_documents
         (company_id, ref, type, status, recipient_cnpj, recipient_name, value, payload)
       VALUES ($1,$2,'nfce','pending',$3,$4,$5,$6)`,
      [cid, ref, body.recipient_cpf || '', body.recipient_name || 'Consumidor',
       body.total_value, JSON.stringify(body)]
    );

    const result = await fiscal.emitNfce(company, body);
    const docId  = result.id || null;
    const status = result.status === 'autorizado' ? 'authorized'
                 : result.status === 'rejeitado'  ? 'error'
                 : 'processing';

    await db.query(
      `UPDATE nfe_documents
          SET status = $1, focus_id = $2, number = $3, access_key = $4,
              xml_url = $5, pdf_url = $6, error_message = $7,
              issued_at = CASE WHEN $1 = 'authorized' THEN NOW() ELSE NULL END,
              updated_at = NOW()
        WHERE ref = $8 AND company_id = $9`,
      [status, docId, result.numero || null, result.chave_acesso || null,
       result.link_xml || null, result.link_pdf || null, result.mensagem || null,
       ref, cid]
    );

    res.status(201).json({ ref, doc_id: docId, status, response: result });
  } catch (err) {
    console.error('[NFE] Emit NFCe error:', err.message);
    await db.query(
      'UPDATE nfe_documents SET status=$1, error_message=$2 WHERE ref=$3',
      ['error', err.message, ref]
    ).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

// GET /nfe/:ref — Consulta status do documento (com polling se ainda processando)
router.get('/:ref', requireAuth, async function(req, res) {
  const cid = req.params.id;
  const ref = req.params.ref;
  try {
    const result = await db.query(
      'SELECT * FROM nfe_documents WHERE ref=$1 AND company_id=$2', [ref, cid]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Documento nao encontrado' });
    let doc = result.rows[0];

    // Se ainda em processamento, consulta o provedor
    if ((doc.status === 'processing' || doc.status === 'pending') && doc.focus_id) {
      try {
        const queryFn    = doc.type === 'nfse' ? fiscal.queryNfse : fiscal.queryNfce;
        const provResult = await queryFn(doc.focus_id);
        if (provResult.status === 'autorizado') {
          await db.query(
            `UPDATE nfe_documents
                SET status = 'authorized', number = $1, access_key = $2,
                    xml_url = $3, pdf_url = $4, issued_at = NOW(), updated_at = NOW()
              WHERE ref = $5`,
            [provResult.numero || null,
             provResult.chave_acesso || provResult.codigo_verificacao || null,
             provResult.link_xml || null, provResult.link_pdf || null, ref]
          );
          doc.status  = 'authorized';
          doc.number  = provResult.numero;
          doc.pdf_url = provResult.link_pdf;
        }
      } catch {}
    }
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao consultar documento' });
  }
});

// POST /nfe/:ref/cancel — Cancela documento
router.post('/:ref/cancel', requireAuth, requireRole('client', 'analyst', 'admin'), async function(req, res) {
  const cid           = req.params.id;
  const ref           = req.params.ref;
  const justificativa = req.body.justificativa;
  try {
    const result = await db.query(
      'SELECT * FROM nfe_documents WHERE ref=$1 AND company_id=$2', [ref, cid]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Documento nao encontrado' });
    const doc = result.rows[0];
    if (doc.status === 'cancelled') return res.status(400).json({ error: 'Documento ja cancelado' });
    if (!doc.focus_id)              return res.status(400).json({ error: 'Documento sem ID do provedor' });

    const cancelFn     = doc.type === 'nfse' ? fiscal.cancelNfse : fiscal.cancelNfce;
    const cancelResult = await cancelFn(doc.focus_id, justificativa || 'Cancelamento solicitado');

    await db.query(
      `UPDATE nfe_documents SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW() WHERE ref = $1`,
      [ref]
    );
    res.json({ ref, status: 'cancelled', response: cancelResult });
  } catch (err) {
    console.error('[NFE] Cancel error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /nfe — Lista documentos fiscais
router.get('/', requireAuth, async function(req, res) {
  const cid    = req.params.id;
  const type   = req.query.type;
  const status = req.query.status;
  const limit  = parseInt(req.query.limit)  || 50;
  const offset = parseInt(req.query.offset) || 0;
  try {
    let where  = 'WHERE company_id = $1';
    const params = [cid];
    if (type)   { params.push(type);   where += ' AND type = $'   + params.length; }
    if (status) { params.push(status); where += ' AND status = $' + params.length; }
    params.push(limit, offset);

    const result = await db.query(
      `SELECT id, ref, type, status, number, recipient_name, description, value,
              issued_at, cancelled_at, created_at
       FROM nfe_documents ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const countResult = await db.query(
      `SELECT COUNT(*) FROM nfe_documents ${where}`,
      params.slice(0, -2)
    );
    res.json({ total: parseInt(countResult.rows[0].count), documents: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar documentos' });
  }
});

module.exports = router;
