// ============================================================
// AURA. — NFC-e / NF-e PDV
// Emissão de cupom fiscal eletrônico (NFC-e, modelo 65) ou
// nota fiscal eletrônica (NF-e, modelo 55) a partir do PDV.
// Mounted at: /companies/:id/nfce
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAuditAction }           = require('../middleware/auditLog');
const nuvemfiscal                  = require('../services/nuvemfiscal');

const INSTRUCOES_NOTA = {
  nfce: 'NFC-e (Nota Fiscal do Consumidor): ideal para vendas a pessoas físicas. O CPF do comprador é opcional. Use na maioria das vendas do balcão.',
  nfe:  'NF-e (Nota Fiscal Eletrônica): use quando o cliente informar CNPJ ou exigir nota de empresa. CPF ou CNPJ do destinatário é obrigatório.',
  dica: 'Na dúvida, use NFC-e. Mude para NF-e somente quando o cliente pedir nota com CNPJ.',
};

function paymentCode(method) {
  const map = {
    dinheiro: '01', cheque: '02', credito: '03', debito: '04',
    cartao: '03', boleto: '15', pix: '17', outros: '99',
  };
  return map[method] || '01';
}

// Extrai campos da resposta Nuvem Fiscal, tolerando variações de layout.
// qrCode e urlConsulta vêm em infNFeSupl (só NFC-e tem). Persistidos pra
// o PDV renderizar o QR direto sem reconsultar a API.
function extractProvFields(resp) {
  if (!resp) return {};
  const aut = resp.autorizacao || resp.protocolo_autorizacao || {};
  const proto = aut.protocolo || aut;
  const supl = resp.infNFeSupl || resp.inf_nfe_supl || {};
  return {
    nuvemfiscalId: resp.id || null,
    chaveAcesso:   resp.chave_acesso || resp.chNFe || proto.chNFe || null,
    protocolo:     resp.protocolo || proto.nProt || aut.nProt || null,
    xmlUrl:        resp.link_xml || resp.url_xml || resp.xml_url || null,
    pdfUrl:        resp.link_pdf || resp.url_pdf || resp.pdf_url || resp.danfe_url || null,
    qrCode:        resp.qr_code  || resp.qrCode  || supl.qrCode  || supl.qr_code || null,
    urlConsulta:   resp.url_consulta || resp.urlChave || supl.urlChave || supl.url_chave || null,
    status:        resp.status || aut.status || null,
    motivo:        resp.motivo || proto.xMotivo || null,
  };
}

router.get('/config', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, company_id, serie_nfce, next_number, ambiente, uf,
              inscricao_estadual, is_active, csc_id
         FROM nfce_config WHERE company_id=$1`,
      [req.params.id]
    );
    res.json({ config: rows[0] || null, instrucoes: INSTRUCOES_NOTA });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar config NFC-e' });
  }
});

router.post('/config', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { serie_nfce, ambiente, uf, inscricao_estadual, csc_id, csc_token } = req.body;
  try {
    const { rows } = await db.query(
      `INSERT INTO nfce_config (company_id, serie_nfce, ambiente, uf, inscricao_estadual, csc_id, csc_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (company_id) DO UPDATE SET
         serie_nfce         = COALESCE($2, nfce_config.serie_nfce),
         ambiente           = COALESCE($3, nfce_config.ambiente),
         uf                 = COALESCE($4, nfce_config.uf),
         inscricao_estadual = COALESCE($5, nfce_config.inscricao_estadual),
         csc_id             = COALESCE($6, nfce_config.csc_id),
         csc_token          = COALESCE($7, nfce_config.csc_token),
         updated_at         = NOW()
       RETURNING *`,
      [req.params.id, serie_nfce || 1, ambiente || 'homologacao', uf || 'SP',
       inscricao_estadual || null, csc_id || null, csc_token || null]
    );
    res.json({ config: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar config' });
  }
});

router.post('/emit', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const {
    items, customer_cpf, customer_name, customer_email, recipient_cnpj,
    payment_method, payment_change, sale_id, transaction_id, observacoes,
    tipo = 'nfce',
  } = req.body;

  if (!items || !items.length) {
    return res.status(400).json({ error: 'items obrigatorio (array de produtos)' });
  }
  if (tipo === 'nfe' && !customer_cpf && !recipient_cnpj) {
    return res.status(400).json({ error: 'NF-e (modelo 55) exige CPF ou CNPJ do destinatário.', instrucao: INSTRUCOES_NOTA.nfe });
  }

  try {
    const { rows: configs } = await db.query('SELECT * FROM nfce_config WHERE company_id=$1', [req.params.id]);
    if (!configs.length || !configs[0].is_active) {
      return res.status(400).json({
        error: 'Emissão de nota fiscal não configurada. Acesse Configurações > Nota Fiscal.',
        instrucao: INSTRUCOES_NOTA.dica,
      });
    }
    const config = configs[0];

    // SELECT com alias address_district AS address_neighborhood (real column).
    // ibge_code e inscricao_estadual existem desde a migration 095.
    const { rows: companies } = await db.query(
      `SELECT id, cnpj, legal_name, trade_name, name,
              address_street, address_number,
              address_district AS address_neighborhood,
              address_city, address_state, address_zip,
              inscricao_estadual, inscricao_municipal,
              ibge_code, email, phone, tax_regime
         FROM companies WHERE id=$1`,
      [req.params.id]
    );
    if (!companies.length) return res.status(404).json({ error: 'Empresa não encontrada' });
    const company = companies[0];
    if (!company.cnpj) return res.status(400).json({ error: 'CNPJ da empresa não cadastrado. Atualize em Configurações.' });
    if (!company.ibge_code) {
      return res.status(400).json({
        error: 'Código IBGE da empresa não cadastrado (campo cMun obrigatório). Atualize em Configurações > Empresa.',
      });
    }

    if (!company.inscricao_estadual && config.inscricao_estadual) {
      company.inscricao_estadual = config.inscricao_estadual;
    }
    if (!company.inscricao_estadual) {
      return res.status(400).json({
        error: 'Inscrição Estadual da empresa não cadastrada. Atualize em Configurações > Empresa ou na configuração NFC-e.',
      });
    }

    let totalProducts = 0, totalDiscount = 0;
    for (const item of items) {
      totalProducts += (Number(item.quantity) || 1) * (Number(item.unit_price || item.price) || 0);
      totalDiscount += Number(item.discount) || 0;
    }
    const totalNfce = Math.round((totalProducts - totalDiscount) * 100) / 100;

    const numeroNF = config.next_number;
    const serieNF  = config.serie_nfce;

    const now = new Date();
    const yy = String(now.getFullYear()).slice(2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const modelo = tipo === 'nfe' ? '55' : '65';
    const chaveAcessoTmp =
      `${config.uf}${yy}${mm}${'0'.repeat(14)}${modelo}${String(serieNF).padStart(3, '0')}` +
      `${String(numeroNF).padStart(9, '0')}1${'0'.repeat(8)}1`;

    const { rows: created } = await db.query(
      `INSERT INTO nfce_emissions
         (company_id, sale_id, transaction_id, numero, serie, chave_acesso, status,
          customer_cpf, customer_name, items, total_products, total_discount, total_nfce,
          payment_method, payment_change, emitted_by, tipo)
       VALUES ($1,$2,$3,$4,$5,$6,'processando',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [req.params.id, sale_id || null, transaction_id || null, numeroNF, serieNF, chaveAcessoTmp,
       customer_cpf || null, customer_name || null, JSON.stringify(items),
       totalProducts, totalDiscount, totalNfce,
       payment_method || 'dinheiro', payment_change || 0, req.user.id, tipo]
    );
    const emission = created[0];

    await db.query(
      'UPDATE nfce_config SET next_number = next_number + 1, updated_at = NOW() WHERE company_id=$1',
      [req.params.id]
    );

    let finalStatus = 'processando';
    let prov = {};

    if (config.ambiente === 'homologacao' && process.env.NUVEM_FISCAL_FORCE !== 'true') {
      prov.protocolo = 'HOMOLOG-' + String(numeroNF).padStart(6, '0');
      finalStatus = 'autorizada';
      await db.query(
        `UPDATE nfce_emissions SET status = 'autorizada', protocolo = $1, authorized_at = NOW() WHERE id = $2`,
        [prov.protocolo, emission.id]
      );
    } else {
      try {
        const nfItems = items.map(i => ({
          code:        String(i.product_id || i.code || ''),
          name:        i.product_name || i.name || '',
          description: i.description || i.product_name || i.name || '',
          ncm:         i.ncm     || '00000000',
          cfop:        i.cfop    || '5102',
          unit:        i.unit    || 'UN',
          quantity:    Number(i.quantity   || 1),
          price:       Number(i.unit_price || i.price || 0),
          barcode:     i.barcode || undefined,
        }));

        const emitFn = tipo === 'nfe' ? nuvemfiscal.emitNfe : nuvemfiscal.emitNfce;
        const provResult = await emitFn(company, {
          items:           nfItems,
          total_value:     totalNfce,
          payment_method:  paymentCode(payment_method),
          payment_change:  payment_change,
          recipient_cpf:   customer_cpf,
          recipient_cnpj:  recipient_cnpj,
          recipient_name:  customer_name,
          recipient_email: customer_email,
          serie:           serieNF,
          numero:          numeroNF,
          observacoes,
          reference:       `${tipo}-${emission.id}`,
        });

        prov = extractProvFields(provResult);
        finalStatus = (prov.status === 'autorizado' || prov.status === 'autorizada') ? 'autorizada'
                    : (prov.status === 'rejeitado'  || prov.status === 'rejeitada')  ? 'rejeitada'
                    : 'processando';

        await db.query(
          `UPDATE nfce_emissions
              SET status         = $1,
                  nuvemfiscal_id = $2,
                  chave_acesso   = COALESCE($3, chave_acesso),
                  protocolo      = $4,
                  xml_url        = COALESCE(xml_url, $5),
                  pdf_url        = COALESCE(pdf_url, $6),
                  qr_code        = COALESCE(qr_code, $7),
                  url_consulta   = COALESCE(url_consulta, $8),
                  authorized_at  = CASE WHEN $1 = 'autorizada' THEN NOW() ELSE NULL END
            WHERE id = $9`,
          [finalStatus, prov.nuvemfiscalId, prov.chaveAcesso, prov.protocolo,
           prov.xmlUrl, prov.pdfUrl, prov.qrCode, prov.urlConsulta, emission.id]
        );

      } catch (apiErr) {
        console.error('[nfce] Nuvem Fiscal emit error:', apiErr.message, apiErr.payload || '');
        await db.query(
          `UPDATE nfce_emissions SET status = 'erro', error_message = $1 WHERE id = $2`,
          [apiErr.message, emission.id]
        );
        return res.status(502).json({
          error:    'Erro ao transmitir nota para Nuvem Fiscal: ' + apiErr.message,
          payload:  apiErr.payload || null,
          nfce_id:  emission.id,
        });
      }
    }

    const { rows: final } = await db.query('SELECT * FROM nfce_emissions WHERE id=$1', [emission.id]);

    logAuditAction(req.user.id, req.params.id, 'nfce_emitted',
      `${tipo.toUpperCase()} nº ${numeroNF} emitida — R$ ${totalNfce}`);

    res.status(201).json({
      nfce: final[0],
      tipo,
      pdf_url:      prov.pdfUrl      || final[0].pdf_url,
      xml_url:      prov.xmlUrl      || final[0].xml_url,
      qr_code:      prov.qrCode      || final[0].qr_code,
      url_consulta: prov.urlConsulta || final[0].url_consulta,
    });

  } catch (err) {
    console.error('nfce emit error:', err);
    res.status(500).json({ error: 'Erro ao emitir nota fiscal' });
  }
});

router.get('/', requireAuth, async (req, res) => {
  const { status, start, end, tipo } = req.query;
  try {
    const params = [req.params.id];
    let where = 'WHERE company_id = $1';
    if (status) { params.push(status); where += ` AND status = $${params.length}`; }
    if (tipo)   { params.push(tipo);   where += ` AND tipo = $${params.length}`; }
    if (start)  { params.push(start);  where += ` AND created_at >= $${params.length}`; }
    if (end)    { params.push(end);    where += ` AND created_at <= $${params.length}`; }

    const { rows } = await db.query(
      `SELECT id, numero, serie, tipo, chave_acesso, protocolo, status,
              customer_cpf, customer_name, total_nfce, payment_method,
              xml_url, pdf_url, qr_code, url_consulta,
              authorized_at, cancelled_at, created_at, error_message
         FROM nfce_emissions ${where}
        ORDER BY numero DESC LIMIT 100`,
      params
    );

    const { rows: stats } = await db.query(
      `SELECT COUNT(*)::int                                               AS total,
              COUNT(*) FILTER (WHERE status = 'autorizada')::int         AS authorized,
              COUNT(*) FILTER (WHERE status = 'cancelada')::int          AS cancelled,
              COUNT(*) FILTER (WHERE tipo   = 'nfe')::int                AS total_nfe,
              COUNT(*) FILTER (WHERE tipo   = 'nfce')::int               AS total_nfce,
              COALESCE(SUM(total_nfce) FILTER (WHERE status = 'autorizada'), 0)::numeric AS total_value
         FROM nfce_emissions WHERE company_id = $1`,
      [req.params.id]
    );

    res.json({ emissions: rows, stats: stats[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar emissões' });
  }
});

router.get('/:nfceId', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT * FROM nfce_emissions WHERE id=$1 AND company_id=$2',
      [req.params.nfceId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Nota não encontrada' });
    let emission = rows[0];

    if (emission.status === 'processando' && emission.nuvemfiscal_id) {
      try {
        const queryFn = emission.tipo === 'nfe' ? nuvemfiscal.queryNfe : nuvemfiscal.queryNfce;
        const provResult = await queryFn(emission.nuvemfiscal_id);
        const prov = extractProvFields(provResult);
        if (prov.status === 'autorizado' || prov.status === 'autorizada') {
          await db.query(
            `UPDATE nfce_emissions
                SET status = 'autorizada',
                    chave_acesso = COALESCE($1, chave_acesso),
                    protocolo    = COALESCE($2, protocolo),
                    xml_url      = COALESCE($3, xml_url),
                    pdf_url      = COALESCE($4, pdf_url),
                    qr_code      = COALESCE($5, qr_code),
                    url_consulta = COALESCE($6, url_consulta),
                    authorized_at = NOW()
              WHERE id = $7`,
            [prov.chaveAcesso, prov.protocolo, prov.xmlUrl, prov.pdfUrl,
             prov.qrCode, prov.urlConsulta, emission.id]
          );
          const refreshed = await db.query('SELECT * FROM nfce_emissions WHERE id=$1', [emission.id]);
          emission = refreshed.rows[0];
        }
      } catch (e) { /* best-effort */ }
    }

    res.json({ emission });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao consultar nota' });
  }
});

router.post('/:nfceId/cancel', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { reason } = req.body;
  if (!reason || reason.length < 15) {
    return res.status(400).json({ error: 'Motivo do cancelamento exige ao menos 15 caracteres (regra SEFAZ)' });
  }
  try {
    const { rows } = await db.query(
      `UPDATE nfce_emissions
          SET status = 'cancelada', cancel_reason = $1, cancelled_at = NOW()
        WHERE id = $2 AND company_id = $3 AND status = 'autorizada'
       RETURNING *`,
      [reason, req.params.nfceId, req.params.id]
    );
    if (!rows.length) return res.status(400).json({ error: 'Nota não encontrada ou não pode ser cancelada' });
    const emission = rows[0];

    if (emission.nuvemfiscal_id) {
      try {
        const cancelFn = emission.tipo === 'nfe' ? nuvemfiscal.cancelNfe : nuvemfiscal.cancelNfce;
        await cancelFn(emission.nuvemfiscal_id, reason);
      } catch (apiErr) {
        console.error('[nfce] Nuvem Fiscal cancel error:', apiErr.message);
        await db.query(
          'UPDATE nfce_emissions SET error_message = $1 WHERE id = $2',
          ['Cancelamento local OK. Erro Nuvem Fiscal: ' + apiErr.message, emission.id]
        );
      }
    }

    logAuditAction(req.user.id, req.params.id, 'nfce_cancelled',
      `${(emission.tipo || 'nfce').toUpperCase()} nº ${emission.numero} cancelada: ${reason}`);
    res.json({ nfce: emission });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao cancelar nota' });
  }
});

module.exports = router;
