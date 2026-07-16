// ============================================================
// AURA KARATÊ — NFS-e para Anuidades de Dojô (Track P)
// Montado em: /federation/:id/financial (via index.js)
//
// Reusa EXATAMENTE o padrão de src/routes/nfe.js:
//   - src/services/nuvemfiscal.js (fiscal.emitNfse / fiscal.queryNfse)
//   - tabela nfe_documents (a mesma de NFS-e de outras verticais)
//   - guard: adminOnly() de karateRoles
//   - opt-in: karate_auto_nfse feature flag; endpoints disponíveis mesmo
//     sem a flag (para disparo manual); a flag só protege o auto-emit
//     no /confirm.
//
// Endpoints:
//   POST /annuities/dojos/:dojoId/nfse
//     Body: { annuity_history_id, iss_rate?, service_code?, description? }
//     Emite NFS-e para a anuidade paga do dojô. Idempotente (409 se já existe).
//
//   GET  /annuities/dojos/:dojoId/nfse
//     Lista NFS-e emitidas para as anuidades do dojô.
//
// Sem migration: usa nfe_documents que já existe.
// ============================================================
'use strict';

const router  = require('express').Router({ mergeParams: true });
const db      = require('../config/database');
const fiscal  = require('../services/nuvemfiscal');
const { guards } = require('../config/karateRoles');

// ── Helpers ────────────────────────────────────────────────

// Busca dados fiscais da federação (prestador do serviço)
async function getFederationFiscal(federationId) {
  const result = await db.query(
    `SELECT id, legal_name, trade_name, name, cnpj, email, phone,
            inscricao_municipal, focus_company_id, certificate_uploaded, tax_regime,
            address_street, address_number, address_neighborhood,
            address_city, address_state, address_zip, ibge_code, inscricao_estadual
     FROM companies WHERE id = $1 AND vertical = 'karate_federation' LIMIT 1`,
    [federationId]
  );
  if (!result.rows.length) throw Object.assign(new Error('Federação não encontrada'), { status: 404 });
  return result.rows[0];
}

// Busca dados do dojô (tomador do serviço)
async function getDojoForNfse(dojoId, federationId) {
  const result = await db.query(
    `SELECT id, name, trade_name, legal_name, cnpj
     FROM companies WHERE id = $1 AND federation_id = $2 AND vertical = 'karate_dojo' LIMIT 1`,
    [dojoId, federationId]
  );
  if (!result.rows.length) throw Object.assign(new Error('Dojô não encontrado'), { status: 404 });
  return result.rows[0];
}

// ── POST /annuities/dojos/:dojoId/nfse ────────────────────
// Emite NFS-e para uma anuidade de dojô que já foi paga.
// Idempotente: se transaction_id já tem um nfe_document, retorna 409.
router.post('/annuities/dojos/:dojoId/nfse', ...guards.adminOnly(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;
  const { annuity_history_id, iss_rate, service_code, description } = req.body;

  if (!annuity_history_id) {
    return res.status(422).json({ error: 'annuity_history_id obrigatorio', code: 'VALIDATION_ERROR' });
  }

  try {
    // 1. Busca a anuidade
    const annuityRes = await db.query(
      `SELECT h.id, h.dojo_id, h.federation_id, h.reference_period, h.amount,
              h.status AS annuity_status, h.paid_at, h.transaction_id,
              c.name AS dojo_name, c.cnpj AS dojo_cnpj
       FROM karate_dojo_annuity_history h
       JOIN companies c ON c.id = h.dojo_id
       WHERE h.id = $1 AND h.dojo_id = $2 AND h.federation_id = $3
       LIMIT 1`,
      [annuity_history_id, dojoId, federationId]
    );

    if (!annuityRes.rows.length) {
      return res.status(404).json({ error: 'Cobrança de anuidade não encontrada', code: 'NOT_FOUND' });
    }

    const annuity = annuityRes.rows[0];

    if (annuity.annuity_status !== 'paid') {
      return res.status(409).json({
        error: 'Só é possível emitir NFS-e para anuidade paga',
        code: 'ANNUITY_NOT_PAID',
        annuity_status: annuity.annuity_status,
      });
    }

    // 2. Idempotência: verifica se já existe NFS-e para este transaction_id
    if (annuity.transaction_id) {
      const existingDoc = await db.query(
        `SELECT id, ref, status, number, pdf_url FROM nfe_documents
         WHERE type = 'nfse'
           AND payload::text LIKE '%' || $1::text || '%'
           AND company_id = $2
         ORDER BY created_at DESC LIMIT 1`,
        [annuity.transaction_id, federationId]
      );
      // Idempotência mais robusta: busca pelo campo de referência no payload
      if (!existingDoc.rows.length) {
        // Tenta por ref direto
        const refPattern = `nfse-karate-${annuity_history_id.slice(0, 8)}`;
        const byRef = await db.query(
          `SELECT id, ref, status, number, pdf_url FROM nfe_documents
           WHERE ref LIKE $1 AND company_id = $2
           ORDER BY created_at DESC LIMIT 1`,
          [`${refPattern}%`, federationId]
        );
        if (byRef.rows.length) {
          return res.status(409).json({
            error: 'NFS-e já emitida para esta anuidade',
            code: 'NFSE_ALREADY_ISSUED',
            document: byRef.rows[0],
          });
        }
      } else {
        return res.status(409).json({
          error: 'NFS-e já emitida para esta anuidade',
          code: 'NFSE_ALREADY_ISSUED',
          document: existingDoc.rows[0],
        });
      }
    }

    // 3. Busca dados fiscais da federação (prestador)
    const federation = await getFederationFiscal(federationId);

    if (!federation.cnpj) {
      return res.status(400).json({ error: 'Federação sem CNPJ cadastrado', code: 'MISSING_CNPJ' });
    }
    if (!federation.inscricao_municipal) {
      return res.status(400).json({
        error: 'Inscrição municipal da federação não cadastrada. Configure em Dados Fiscais.',
        code: 'MISSING_IM',
      });
    }

    // 4. Monta payload NFS-e (same pattern as nfe.js /emit/nfse)
    const refCode = `nfse-karate-${annuity_history_id.slice(0, 8)}-${Date.now()}`;
    const serviceDesc = description
      || `Anuidade Dojô ${annuity.dojo_name} — ${annuity.reference_period}`;
    const serviceValue = parseFloat(annuity.amount);
    const issRateValue = iss_rate != null ? Number(iss_rate) : 2;
    const serviceCodeValue = service_code || '';

    // 5. Insere nfe_document em pending (mesmo padrão de nfe.js)
    await db.query(
      `INSERT INTO nfe_documents
         (company_id, ref, type, status, recipient_cnpj, recipient_name,
          description, service_code, value, iss_rate, payload)
       VALUES ($1, $2, 'nfse', 'pending', $3, $4, $5, $6, $7, $8, $9)`,
      [
        federationId,
        refCode,
        (annuity.dojo_cnpj || '').replace(/\D/g, '') || '',
        annuity.dojo_name,
        serviceDesc,
        serviceCodeValue,
        serviceValue,
        issRateValue,
        JSON.stringify({
          source: 'karate_annuity',
          annuity_history_id,
          dojo_id: dojoId,
          federation_id: federationId,
          transaction_id: annuity.transaction_id,
          reference_period: annuity.reference_period,
        }),
      ]
    );

    // 6. Chama fiscal.emitNfse (mesma chamada de nfe.js)
    let result, status, docId;
    try {
      result = await fiscal.emitNfse(federation, {
        recipient_cnpj: (annuity.dojo_cnpj || '').replace(/\D/g, '') || undefined,
        recipient_name: annuity.dojo_name,
        description: serviceDesc,
        service_code: serviceCodeValue,
        value: serviceValue,
        iss_rate: issRateValue,
      });
      docId  = result.id || null;
      status = result.status === 'autorizado' ? 'authorized'
             : result.status === 'rejeitado'  ? 'error'
             : 'processing';
    } catch (fiscalErr) {
      // Atualiza status para error e re-lança para o cliente
      await db.query(
        `UPDATE nfe_documents SET status='error', error_message=$1 WHERE ref=$2`,
        [fiscalErr.message, refCode]
      ).catch(() => {});
      throw fiscalErr;
    }

    // 7. Atualiza nfe_document com o resultado do provider
    await db.query(
      `UPDATE nfe_documents
          SET status = $1, focus_id = $2, number = $3, xml_url = $4, pdf_url = $5,
              error_message = $6,
              issued_at = CASE WHEN $1 = 'authorized' THEN NOW() ELSE NULL END,
              updated_at = NOW()
        WHERE ref = $7 AND company_id = $8`,
      [
        status,
        docId,
        result.numero || null,
        result.link_xml || null,
        result.link_pdf || null,
        result.mensagem || null,
        refCode,
        federationId,
      ]
    );

    // 8. Se tem transaction_id, vincula nfe_document via payload (sem coluna nova)
    // Registra o ref no log para rastreabilidade (best-effort)
    if (annuity.transaction_id) {
      await db.query(
        `UPDATE transactions SET updated_at = NOW() WHERE id = $1`,
        [annuity.transaction_id]
      ).catch(() => {});
    }

    res.status(201).json({
      ref: refCode,
      doc_id: docId,
      status,
      annuity_history_id,
      dojo_id: dojoId,
      reference_period: annuity.reference_period,
      pdf_url: result.link_pdf || null,
      response: result,
    });
  } catch (err) {
    const errStatus = err.status || 500;
    if (errStatus === 404 || errStatus === 400 || errStatus === 409) {
      return res.status(errStatus).json({ error: err.message, code: err.code || 'ERROR' });
    }
    console.error('[karateNfse] emit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /annuities/dojos/:dojoId/nfse ─────────────────────
// Lista NFS-e emitidas para as anuidades do dojô (padrão nfe.js GET /).
router.get('/annuities/dojos/:dojoId/nfse', ...guards.read(), async (req, res) => {
  const { id: federationId, dojoId } = req.params;
  const limit  = Math.min(parseInt(req.query.limit, 10)  || 50, 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  try {
    // Busca NFS-e pelo payload que contém o dojo_id
    // (não precisamos de coluna nova — filtramos pelo JSON embutido)
    const result = await db.query(
      `SELECT id, ref, type, status, number, recipient_name, description, value,
              issued_at, cancelled_at, created_at, pdf_url, error_message
       FROM nfe_documents
       WHERE company_id = $1
         AND type = 'nfse'
         AND payload::jsonb ->> 'dojo_id' = $2
       ORDER BY created_at DESC
       LIMIT $3 OFFSET $4`,
      [federationId, dojoId, limit, offset]
    );

    const countRes = await db.query(
      `SELECT COUNT(*) AS total
       FROM nfe_documents
       WHERE company_id = $1
         AND type = 'nfse'
         AND payload::jsonb ->> 'dojo_id' = $2`,
      [federationId, dojoId]
    );

    res.json({
      total: parseInt(countRes.rows[0].total, 10),
      documents: result.rows,
    });
  } catch (err) {
    console.error('[karateNfse] list error:', err.message);
    res.status(500).json({ error: 'Erro ao listar NFS-e da anuidade' });
  }
});

// ── GET /annuities/dojos/:dojoId/nfse/:ref ────────────────
// Consulta status de uma NFS-e (mesmo polling de nfe.js GET /:ref).
router.get('/annuities/dojos/:dojoId/nfse/:ref', ...guards.read(), async (req, res) => {
  const { id: federationId, ref } = req.params;

  try {
    const result = await db.query(
      `SELECT * FROM nfe_documents WHERE ref = $1 AND company_id = $2`,
      [ref, federationId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Documento não encontrado' });
    }
    let doc = result.rows[0];

    // Polling: se ainda em processamento, consulta o provedor
    if ((doc.status === 'processing' || doc.status === 'pending') && doc.focus_id) {
      try {
        const provResult = await fiscal.queryNfse(doc.focus_id);
        if (provResult.status === 'autorizado') {
          await db.query(
            `UPDATE nfe_documents
                SET status = 'authorized', number = $1,
                    xml_url = $2, pdf_url = $3, issued_at = NOW(), updated_at = NOW()
              WHERE ref = $4`,
            [provResult.numero || null, provResult.link_xml || null,
             provResult.link_pdf || null, ref]
          );
          doc.status  = 'authorized';
          doc.number  = provResult.numero;
          doc.pdf_url = provResult.link_pdf;
        }
      } catch (_) {
        // falha silenciosa no polling
      }
    }

    res.json(doc);
  } catch (err) {
    console.error('[karateNfse] get error:', err.message);
    res.status(500).json({ error: 'Erro ao consultar NFS-e' });
  }
});

module.exports = router;
