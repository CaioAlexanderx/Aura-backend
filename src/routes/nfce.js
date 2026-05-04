// ============================================================
// AURA. — NFC-e / NF-e PDV
// Emissão de cupom fiscal eletrônico (NFC-e, modelo 65) ou
// nota fiscal eletrônica (NF-e, modelo 55) a partir do PDV.
// Mounted at: /companies/:id/nfce
//
// Escolha de documento no campo `tipo` do body:
//   'nfce' (padrão) — venda ao consumidor, CPF opcional
//   'nfe'           — venda a empresa/B2B, CPF ou CNPJ obrigatório
//
// Ambientes:
//   homologacao — autoriza localmente sem transmissão real
//   producao    — transmite à Nuvem Fiscal (SEFAZ)
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAuditAction }           = require('../middleware/auditLog');
const nuvemfiscal                  = require('../services/nuvemfiscal');

// ── Instruções exibidas ao usuário pelo frontend ────────────
const INSTRUCOES_NOTA = {
  nfce: 'NFC-e (Nota Fiscal do Consumidor): ideal para vendas a pessoas físicas. O CPF do comprador é opcional. Use na maioria das vendas do balcão.',
  nfe:  'NF-e (Nota Fiscal Eletrônica): use quando o cliente informar CNPJ ou exigir nota de empresa. CPF ou CNPJ do destinatário é obrigatório.',
  dica: 'Na dúvida, use NFC-e. Mude para NF-e somente quando o cliente pedir nota com CNPJ.',
};

// Mapeamento forma de pagamento → código Nuvem Fiscal
function paymentCode(method) {
  const map = { pix: '17', credito: '03', debito: '04', dinheiro: '01', outros: '99' };
  return map[method] || '01';
}

// GET /config — Retorna configuração + instruções para o frontend
router.get('/config', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT id, company_id, serie_nfce, next_number, ambiente, uf, inscricao_estadual, is_active, csc_id FROM nfce_config WHERE company_id=$1',
      [req.params.id]
    );
    res.json({ config: rows[0] || null, instrucoes: INSTRUCOES_NOTA });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar config NFC-e' });
  }
});

// POST /config — Salva ou atualiza configuração fiscal
router.post('/config', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { serie_nfce, ambiente, uf, inscricao_estadual, csc_id, csc_token } = req.body;
  try {
    const { rows } = await db.query(
      `INSERT INTO nfce_config (company_id, serie_nfce, ambiente, uf, inscricao_estadual, csc_id, csc_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (company_id) DO UPDATE SET
         serie_nfce        = COALESCE($2, nfce_config.serie_nfce),
         ambiente          = COALESCE($3, nfce_config.ambiente),
         uf                = COALESCE($4, nfce_config.uf),
         inscricao_estadual = COALESCE($5, nfce_config.inscricao_estadual),
         csc_id            = COALESCE($6, nfce_config.csc_id),
         csc_token         = COALESCE($7, nfce_config.csc_token),
         updated_at        = NOW()
       RETURNING *`,
      [req.params.id, serie_nfce || 1, ambiente || 'homologacao', uf || 'SP',
       inscricao_estadual || null, csc_id || null, csc_token || null]
    );
    res.json({ config: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar config' });
  }
});

// POST /emit — Emite NFC-e ou NF-e a partir do PDV
// Body:
//   items[]          — produtos da venda
//   tipo             — 'nfce' (padrão) | 'nfe'
//   customer_cpf     — CPF do comprador (opcional na NFC-e, obrigatório na NF-e se sem CNPJ)
//   recipient_cnpj   — CNPJ do destinatário (NF-e B2B)
//   customer_name    — Nome do destinatário
//   payment_method   — 'dinheiro' | 'pix' | 'credito' | 'debito' | 'outros'
//   payment_change   — Troco (opcional)
//   sale_id          — ID da venda no sistema (opcional)
//   transaction_id   — ID da transação (opcional, para idempotência)
router.post('/emit', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const {
    items,
    customer_cpf,
    customer_name,
    payment_method,
    payment_change,
    sale_id,
    transaction_id,
    tipo = 'nfce',
    recipient_cnpj,
  } = req.body;

  if (!items || !items.length) {
    return res.status(400).json({ error: 'items obrigatorio' });
  }

  // NF-e exige identificação do destinatário
  if (tipo === 'nfe' && !customer_cpf && !recipient_cnpj) {
    return res.status(400).json({
      error: 'NF-e (modelo 55) exige CPF ou CNPJ do destinatário.',
      instrucao: INSTRUCOES_NOTA.nfe,
    });
  }

  try {
    // Configuração fiscal da empresa
    const { rows: configs } = await db.query(
      'SELECT * FROM nfce_config WHERE company_id=$1', [req.params.id]
    );
    if (!configs.length || !configs[0].is_active) {
      return res.status(400).json({
        error: 'Emissão de nota fiscal não configurada. Acesse Configurações > Nota Fiscal.',
        instrucao: INSTRUCOES_NOTA.dica,
      });
    }
    const config = configs[0];

    // Dados da empresa para chamada à Nuvem Fiscal
    const { rows: companies } = await db.query(
      `SELECT cnpj, legal_name, trade_name,
              address_street, address_number, address_neighborhood,
              address_city, address_state, address_zip,
              inscricao_estadual, inscricao_municipal,
              ibge_code, email, phone, tax_regime
       FROM companies WHERE id=$1`,
      [req.params.id]
    );
    if (!companies.length) return res.status(404).json({ error: 'Empresa não encontrada' });
    const company = companies[0];

    if (!company.cnpj) {
      return res.status(400).json({ error: 'CNPJ da empresa não cadastrado. Atualize em Configurações.' });
    }

    // Calcula totais
    let totalProducts = 0;
    let totalDiscount = 0;
    for (const item of items) {
      totalProducts += (item.quantity || 1) * (item.unit_price || 0);
      totalDiscount += item.discount || 0;
    }
    const totalNfce = Math.round((totalProducts - totalDiscount) * 100) / 100;

    // Chave de acesso placeholder — substituída pelo retorno da Nuvem Fiscal em produção
    const now    = new Date();
    const yy     = String(now.getFullYear()).slice(2);
    const mm     = String(now.getMonth() + 1).padStart(2, '0');
    const modelo = tipo === 'nfe' ? '55' : '65';
    const chaveAcesso = `${config.uf}${yy}${mm}${'0'.repeat(14)}${modelo}${String(config.serie_nfce).padStart(3, '0')}${String(config.next_number).padStart(9, '0')}1${'0'.repeat(8)}1`;

    // Insere registro inicial com status 'processando'
    const { rows } = await db.query(
      `INSERT INTO nfce_emissions
         (company_id, sale_id, transaction_id, numero, serie, chave_acesso, status,
          customer_cpf, customer_name, items, total_products, total_discount, total_nfce,
          payment_method, payment_change, emitted_by, tipo)
       VALUES ($1,$2,$3,$4,$5,$6,'processando',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [req.params.id, sale_id || null, transaction_id || null, config.next_number,
       config.serie_nfce, chaveAcesso,
       customer_cpf || null, customer_name || null, JSON.stringify(items),
       totalProducts, totalDiscount, totalNfce,
       payment_method || 'dinheiro', payment_change || 0, req.user.id, tipo]
    );
    const emission = rows[0];

    // Incrementa numeração da série
    await db.query(
      'UPDATE nfce_config SET next_number = next_number + 1 WHERE company_id=$1',
      [req.params.id]
    );

    let finalStatus      = 'processando';
    let nuvemfiscalId    = null;
    let chaveAcessoFinal = chaveAcesso;
    let protocolo        = null;
    let xmlUrl           = null;
    let pdfUrl           = null;

    if (config.ambiente === 'homologacao') {
      // ── Homologação: autoriza localmente sem transmissão real ──
      protocolo   = 'HOMOLOG-' + String(config.next_number - 1).padStart(6, '0');
      finalStatus = 'autorizada';
      await db.query(
        `UPDATE nfce_emissions
            SET status = 'autorizada', protocolo = $1, authorized_at = NOW()
          WHERE id = $2`,
        [protocolo, emission.id]
      );
    } else {
      // ── Produção: transmite à Nuvem Fiscal (SEFAZ) ─────────────
      try {
        const nfItems = items.map(i => ({
          code:        String(i.product_id || i.product_name || ''),
          name:        i.product_name || i.name || '',
          description: i.product_name || i.name || '',
          cfop:        i.cfop  || '5102',
          unit:        i.unit  || 'UN',
          quantity:    parseFloat(i.quantity   || 1),
          price:       parseFloat(i.unit_price || i.price || 0),
          ncm:         i.ncm   || '00000000',
        }));

        const pmCode = paymentCode(payment_method);
        let provResult;

        if (tipo === 'nfe') {
          provResult = await nuvemfiscal.emitNfe(company, {
            items:          nfItems,
            total_value:    totalNfce,
            payment_method: pmCode,
            recipient_cpf:  customer_cpf,
            recipient_cnpj: recipient_cnpj,
            recipient_name: customer_name,
          });
        } else {
          provResult = await nuvemfiscal.emitNfce(company, {
            items:          nfItems,
            total_value:    totalNfce,
            payment_method: pmCode,
            recipient_cpf:  customer_cpf,
            recipient_name: customer_name,
          });
        }

        nuvemfiscalId    = provResult.id            || null;
        chaveAcessoFinal = provResult.chave_acesso  || chaveAcesso;
        protocolo        = provResult.protocolo     || null;
        xmlUrl           = provResult.link_xml      || null;
        pdfUrl           = provResult.link_pdf      || null;

        finalStatus = provResult.status === 'autorizado' ? 'autorizada'
                    : provResult.status === 'rejeitado'  ? 'rejeitada'
                    : 'processando';

        await db.query(
          `UPDATE nfce_emissions
              SET status         = $1,
                  nuvemfiscal_id = $2,
                  chave_acesso   = $3,
                  protocolo      = $4,
                  authorized_at  = CASE WHEN $1 = 'autorizada' THEN NOW() ELSE NULL END
            WHERE id = $5`,
          [finalStatus, nuvemfiscalId, chaveAcessoFinal, protocolo, emission.id]
        );

      } catch (apiErr) {
        console.error('[nfce] Nuvem Fiscal emit error:', apiErr.message);
        await db.query(
          `UPDATE nfce_emissions SET status = 'erro', error_message = $1 WHERE id = $2`,
          [apiErr.message, emission.id]
        );
        return res.status(502).json({
          error:   'Erro ao transmitir nota para Nuvem Fiscal: ' + apiErr.message,
          nfce_id: emission.id,
        });
      }
    }

    // Retorna registro final atualizado
    const { rows: final } = await db.query(
      'SELECT * FROM nfce_emissions WHERE id=$1', [emission.id]
    );

    logAuditAction(req.user.id, req.params.id, 'nfce_emitted',
      `${tipo.toUpperCase()} nº ${config.next_number - 1} emitida — R$ ${totalNfce}`);

    res.status(201).json({
      nfce:    final[0],
      tipo,
      pdf_url: pdfUrl,
      xml_url: xmlUrl,
    });

  } catch (err) {
    console.error('nfce emit error:', err);
    res.status(500).json({ error: 'Erro ao emitir nota fiscal' });
  }
});

// GET / — Lista emissões com filtros opcionais
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
              authorized_at, cancelled_at, created_at, error_message
       FROM nfce_emissions ${where}
       ORDER BY numero DESC LIMIT 100`,
      params
    );

    const { rows: stats } = await db.query(
      `SELECT COUNT(*)::int                                             AS total,
              COUNT(*) FILTER (WHERE status = 'autorizada')::int       AS authorized,
              COUNT(*) FILTER (WHERE status = 'cancelada')::int        AS cancelled,
              COUNT(*) FILTER (WHERE tipo   = 'nfe')::int              AS total_nfe,
              COUNT(*) FILTER (WHERE tipo   = 'nfce')::int             AS total_nfce,
              COALESCE(SUM(total_nfce) FILTER (WHERE status = 'autorizada'), 0)::numeric AS total_value
       FROM nfce_emissions WHERE company_id = $1`,
      [req.params.id]
    );

    res.json({ emissions: rows, stats: stats[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar emissões' });
  }
});

// POST /:nfceId/cancel — Cancela nota (local + Nuvem Fiscal em produção)
router.post('/:nfceId/cancel', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'Motivo do cancelamento obrigatório' });

  try {
    const { rows } = await db.query(
      `UPDATE nfce_emissions
          SET status = 'cancelada', cancel_reason = $1, cancelled_at = NOW()
        WHERE id = $2 AND company_id = $3 AND status = 'autorizada'
       RETURNING *`,
      [reason, req.params.nfceId, req.params.id]
    );
    if (!rows.length) {
      return res.status(400).json({ error: 'Nota não encontrada ou não pode ser cancelada' });
    }
    const emission = rows[0];

    // Cancela na Nuvem Fiscal se tiver ID do provedor (produção)
    if (emission.nuvemfiscal_id) {
      try {
        const cancelFn = emission.tipo === 'nfe'
          ? nuvemfiscal.cancelNfe
          : nuvemfiscal.cancelNfce;
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
