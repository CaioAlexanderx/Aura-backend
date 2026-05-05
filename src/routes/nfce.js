// ============================================================
// AURA. — NFC-e / NF-e PDV
// Mounted at: /companies/:id/nfce
//
// Mai/2026 features:
// - /config GET/POST inclui auto_emit_nfce (toggle de emissão automática)
// - /emit aceita body.payments[] (multi-pagamento, soma deve bater com total)
// - /:nfceId/danfe-termica retorna HTML 80mm pra impressão térmica
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAuditAction }           = require('../middleware/auditLog');
const nuvemfiscal                  = require('../services/nuvemfiscal');
const { buildDanfeNfceHtml }       = require('../utils/buildDanfeNfceHtml');

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

// Extrai campos padronizados da resposta bruta da Nuvem Fiscal.
// O POST /nfce retorna campos básicos; o GET /nfce/{id} retorna
// codigo_status + motivo_status com o detalhamento completo da rejeição SEFAZ.
// motivo='-' é placeholder sem info; ignorado aqui.
function extractProvFields(resp) {
  if (!resp) return {};

  const aut   = resp.autorizacao || resp.protocolo_autorizacao || {};
  const proto = aut.protocolo || aut;
  const supl  = resp.infNFeSupl || resp.inf_nfe_supl || {};

  // codigo_status é o campo da Nuvem Fiscal para cStat SEFAZ.
  // Pode vir no nível raiz (GET) ou aninhado em autorizacao (POST/GET).
  const cStat = resp.codigo_status || resp.c_stat || resp.cStat
    || aut.codigo_status || aut.c_stat || aut.cStat || proto.cStat || null;

  // motivo_status é o campo da Nuvem Fiscal para xMotivo SEFAZ.
  // Pode vir no nível raiz (GET) ou aninhado em autorizacao (POST/GET).
  const xMotivo = resp.motivo_status || aut.motivo_status || proto.xMotivo || aut.xMotivo
    || resp.x_motivo || resp.xMotivo || null;

  // motivo: ignora '-' (placeholder Nuvem Fiscal sem info adicional)
  const motivoTop = (resp.motivo && resp.motivo !== '-') ? resp.motivo : null;
  const motivo = motivoTop || xMotivo || resp.mensagem_sefaz || resp.mensagem || null;

  return {
    nuvemfiscalId: resp.id || null,
    chaveAcesso:   resp.chave_acesso || resp.chNFe || proto.chNFe || null,
    protocolo:     resp.protocolo || proto.nProt || aut.nProt || null,
    xmlUrl:        resp.link_xml || resp.url_xml || resp.xml_url || null,
    pdfUrl:        resp.link_pdf || resp.url_pdf || resp.pdf_url || resp.danfe_url || null,
    qrCode:        resp.qr_code  || resp.qrCode  || supl.qrCode  || supl.qr_code || null,
    urlConsulta:   resp.url_consulta || resp.urlChave || supl.urlChave || supl.url_chave || null,
    status:        resp.status || aut.status || null,
    cStat,
    motivo,
  };
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { error: 'items obrigatorio (array de produtos)' };
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const qty = Number(it.quantity);
    const price = Number(it.unit_price !== undefined ? it.unit_price : it.price);
    if (!isFinite(qty) || qty <= 0) {
      return { error: `Item ${i + 1}: quantidade deve ser > 0 (recebido: ${it.quantity})` };
    }
    if (!isFinite(price) || price < 0) {
      return { error: `Item ${i + 1}: preço unitário inválido (recebido: ${it.unit_price ?? it.price})` };
    }
    const name = String(it.product_name || it.name || '').trim();
    if (!name) {
      return { error: `Item ${i + 1}: nome do produto obrigatório` };
    }
  }
  return null;
}

// Valida payments[] do body se foi enviado.
// Aceita array de { method, value, change?, indPag? }.
// Soma de value deve bater com totalNfce (tolerância 1 centavo).
function validatePayments(payments, totalNfce) {
  if (!Array.isArray(payments)) return null; // shape legado, não valida aqui
  if (payments.length === 0) {
    return { error: 'payments[] vazio' };
  }
  let sum = 0;
  for (let i = 0; i < payments.length; i++) {
    const p = payments[i] || {};
    if (!p.method) return { error: `payments[${i}]: method obrigatório` };
    const v = Number(p.value);
    if (!isFinite(v) || v <= 0) {
      return { error: `payments[${i}]: value inválido (${p.value})` };
    }
    sum += v;
  }
  const diff = Math.abs(Math.round((sum - totalNfce) * 100));
  if (diff > 1) {
    return {
      error: `Soma dos pagamentos (R$ ${sum.toFixed(2)}) não bate com total (R$ ${totalNfce.toFixed(2)})`,
    };
  }
  return null;
}

router.get('/config', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, company_id, serie_nfce, next_number, ambiente, uf,
              inscricao_estadual, is_active, csc_id, auto_emit_nfce
         FROM nfce_config WHERE company_id=$1`,
      [req.params.id]
    );
    res.json({ config: rows[0] || null, instrucoes: INSTRUCOES_NOTA });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar config NFC-e' });
  }
});

router.post('/config', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const { serie_nfce, ambiente, uf, inscricao_estadual, csc_id, csc_token, auto_emit_nfce } = req.body;
  try {
    const { rows } = await db.query(
      `INSERT INTO nfce_config (company_id, serie_nfce, ambiente, uf, inscricao_estadual, csc_id, csc_token, auto_emit_nfce)
       VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8, false))
       ON CONFLICT (company_id) DO UPDATE SET
         serie_nfce         = COALESCE($2, nfce_config.serie_nfce),
         ambiente           = COALESCE($3, nfce_config.ambiente),
         uf                 = COALESCE($4, nfce_config.uf),
         inscricao_estadual = COALESCE($5, nfce_config.inscricao_estadual),
         csc_id             = COALESCE($6, nfce_config.csc_id),
         csc_token          = COALESCE($7, nfce_config.csc_token),
         auto_emit_nfce     = COALESCE($8, nfce_config.auto_emit_nfce),
         updated_at         = NOW()
       RETURNING *`,
      [req.params.id, serie_nfce || 1, ambiente || 'homologacao', uf || 'SP',
       inscricao_estadual || null, csc_id || null, csc_token || null,
       typeof auto_emit_nfce === 'boolean' ? auto_emit_nfce : null]
    );
    res.json({ config: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar config' });
  }
});

router.post('/emit', requireAuth, requireRole('client', 'analyst', 'admin'), async (req, res) => {
  const {
    items, customer_cpf, customer_name, customer_email, recipient_cnpj,
    payment_method, payment_change, payments, // payments[] novo (multi-pag)
    sale_id, transaction_id, observacoes,
    tipo = 'nfce',
  } = req.body;

  // Validação cedo: items, NF-e exige destinatário
  const itemsErr = validateItems(items);
  if (itemsErr) return res.status(400).json(itemsErr);
  if (tipo === 'nfe' && !customer_cpf && !recipient_cnpj) {
    return res.status(400).json({ error: 'NF-e (modelo 55) exige CPF ou CNPJ do destinatário.', instrucao: INSTRUCOES_NOTA.nfe });
  }

  try {
    if (sale_id) {
      const { rows: existing } = await db.query(
        `SELECT * FROM nfce_emissions
          WHERE company_id=$1 AND sale_id=$2 AND tipo=$3
            AND status IN ('autorizada','processando')
          ORDER BY created_at DESC LIMIT 1`,
        [req.params.id, sale_id, tipo]
      );
      if (existing.length) {
        const e = existing[0];
        return res.status(200).json({
          nfce: e, tipo,
          pdf_url: e.pdf_url, xml_url: e.xml_url,
          qr_code: e.qr_code, url_consulta: e.url_consulta,
          idempotent: true,
        });
      }
    }

    const { rows: configs } = await db.query('SELECT * FROM nfce_config WHERE company_id=$1', [req.params.id]);
    if (!configs.length || !configs[0].is_active) {
      return res.status(400).json({
        error: 'Emissão de nota fiscal não configurada. Acesse Configurações > Nota Fiscal.',
        instrucao: INSTRUCOES_NOTA.dica,
      });
    }
    const config = configs[0];

    const { rows: companies } = await db.query(
      `SELECT id, cnpj, legal_name, trade_name,
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

    // Valida payments[] se presente — soma deve bater com totalNfce
    const paymentsErr = validatePayments(payments, totalNfce);
    if (paymentsErr) return res.status(400).json(paymentsErr);

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
       Array.isArray(payments) ? JSON.stringify(payments) : (payment_method || 'dinheiro'),
       payment_change || 0, req.user.id, tipo]
    );
    const emission = created[0];

    let finalStatus = 'processando';
    let prov = {};

    if (config.ambiente === 'homologacao' && process.env.NUVEM_FISCAL_FORCE !== 'true') {
      prov.protocolo = 'HOMOLOG-' + String(numeroNF).padStart(6, '0');
      finalStatus = 'autorizada';
      await db.query(
        `UPDATE nfce_emissions SET status = 'autorizada', protocolo = $1, authorized_at = NOW() WHERE id = $2`,
        [prov.protocolo, emission.id]
      );
      await db.query(
        'UPDATE nfce_config SET next_number = next_number + 1, updated_at = NOW() WHERE company_id=$1',
        [req.params.id]
      );
    } else {
      try {
        // Plan B (05/05/2026): backend é fonte autoritativa de NCM.
        // Frontend hoje não envia ncm/cfop nos itens; produtos têm products.ncm
        // cadastrado. Sem essa resolução, fallback '00000000' é rejeitado pela
        // SEFAZ em produção (NCM inválido).
        const productIds = items
          .map(i => i.product_id)
          .filter(id => typeof id === 'string' && id.length > 0);

        const ncmByProductId = new Map();
        if (productIds.length > 0) {
          const { rows: prodRows } = await db.query(
            `SELECT id, ncm FROM products WHERE id = ANY($1::uuid[]) AND company_id = $2`,
            [productIds, req.params.id]
          );
          for (const p of prodRows) {
            const n = (p.ncm || '').trim();
            if (n && n !== '00000000') ncmByProductId.set(p.id, n);
          }
        }

        const nfItems = items.map(i => {
          const ncmFromItem = (i.ncm && String(i.ncm).trim() !== '00000000') ? String(i.ncm).trim() : null;
          const ncmFromDb   = ncmByProductId.get(i.product_id);
          return {
            code:        String(i.product_id || i.code || ''),
            name:        i.product_name || i.name || '',
            description: i.description || i.product_name || i.name || '',
            ncm:         ncmFromItem || ncmFromDb || '00000000',
            cfop:        i.cfop    || '5102',
            unit:        i.unit    || 'UN',
            quantity:    Number(i.quantity   || 1),
            price:       Number(i.unit_price || i.price || 0),
            barcode:     i.barcode || undefined,
          };
        });

        const semNcm = nfItems.filter(it => it.ncm === '00000000');
        if (semNcm.length > 0) {
          console.warn('[nfce] itens sem NCM resolvido (SEFAZ deve rejeitar):',
            semNcm.map(it => ({ code: it.code, name: it.name })));
        }

        // Constrói payments pra Nuvem Fiscal: prioriza array, fallback pra single
        const nfPayments = Array.isArray(payments)
          ? payments.map(p => ({
              method: paymentCode(p.method),
              value:  Number(p.value),
              change: p.change,
              indPag: p.indPag,
            }))
          : undefined;

        const emitFn = tipo === 'nfe' ? nuvemfiscal.emitNfe : nuvemfiscal.emitNfce;
        const provResult = await emitFn(company, {
          items:           nfItems,
          total_value:     totalNfce,
          payments:        nfPayments,
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

        console.log('[nfce] provResult (POST):', JSON.stringify(provResult, null, 2));

        prov = extractProvFields(provResult);
        finalStatus = (prov.status === 'autorizado' || prov.status === 'autorizada') ? 'autorizada'
                    : (prov.status === 'rejeitado'  || prov.status === 'rejeitada')  ? 'rejeitada'
                    : 'processando';

        // POST /nfce não retorna codigo_status/motivo_status — precisamos do GET para o motivo real
        if (finalStatus === 'rejeitada' && prov.nuvemfiscalId && !prov.motivo) {
          try {
            const queryFn = tipo === 'nfe' ? nuvemfiscal.queryNfe : nuvemfiscal.queryNfce;
            const fullResult = await queryFn(prov.nuvemfiscalId);
            console.log('[nfce] provResult (GET detalhe rejeição):', JSON.stringify(fullResult, null, 2));
            const fullProv = extractProvFields(fullResult);
            if (fullProv.motivo) prov.motivo = fullProv.motivo;
            if (fullProv.cStat)  prov.cStat  = fullProv.cStat;
          } catch (e) {
            console.warn('[nfce] GET detalhe rejeição falhou:', e.message);
          }
        }

        console.log(`[nfce] nfce #${numeroNF} status=${finalStatus} cStat=${prov.cStat} motivo=${prov.motivo}`);

        const authorizedAt = finalStatus === 'autorizada' ? new Date() : null;
        // Persiste motivo SEFAZ completo. cStat fica como prefixo p/ facilitar busca.
        // Se prov.motivo veio (extractProvFields agora lê aut.motivo_status), usa direto;
        // senão guarda JSON bruto truncado em 5000 chars (TEXT defensivo).
        const errorMessage = finalStatus === 'rejeitada'
          ? (prov.motivo
              ? (prov.cStat ? `[${prov.cStat}] ${prov.motivo}` : prov.motivo)
              : JSON.stringify(provResult).slice(0, 5000))
          : null;

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
                  authorized_at  = $10,
                  error_message  = $11
            WHERE id = $9`,
          [finalStatus, prov.nuvemfiscalId, prov.chaveAcesso, prov.protocolo,
           prov.xmlUrl, prov.pdfUrl, prov.qrCode, prov.urlConsulta, emission.id,
           authorizedAt, errorMessage]
        );

        if (finalStatus !== 'rejeitada') {
          await db.query(
            'UPDATE nfce_config SET next_number = next_number + 1, updated_at = NOW() WHERE company_id=$1',
            [req.params.id]
          );
        }

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
      nfce:         final[0],
      tipo,
      pdf_url:      prov.pdfUrl      || final[0].pdf_url,
      xml_url:      prov.xmlUrl      || final[0].xml_url,
      qr_code:      prov.qrCode      || final[0].qr_code,
      url_consulta: prov.urlConsulta || final[0].url_consulta,
      motivo:       prov.motivo      || null,
      cStat:        prov.cStat       || null,
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

// ── Diagnóstico temporário ──────────────────────────────────────────────────
// GET /companies/:id/nfce/diagnostico/:nuvemfiscalId
// Retorna o JSON bruto da Nuvem Fiscal para identificar campos de rejeição SEFAZ.
// IMPORTANTE: esta rota deve ficar ANTES de /:nfceId para não ser capturada por ela.
router.get('/diagnostico/:nuvemfiscalId', requireAuth, async (req, res) => {
  try {
    const { nuvemfiscalId } = req.params;
    const queryFn = nuvemfiscalId.startsWith('nfe_')
      ? nuvemfiscal.queryNfe
      : nuvemfiscal.queryNfce;
    const raw = await queryFn(nuvemfiscalId);
    console.log('[nfce] diagnostico raw:', JSON.stringify(raw, null, 2));
    res.json({ nuvemfiscalId, raw });
  } catch (err) {
    console.error('[nfce] diagnostico error:', err.message, err.payload || '');
    res.status(502).json({ error: err.message, payload: err.payload || null });
  }
});
// ───────────────────────────────────────────────────────────────────────────

// ── DANFE NFC-e térmica (80mm) ───────────────────────────────────────────
// GET /companies/:id/nfce/:nfceId/danfe-termica
// Retorna HTML standalone otimizado pra impressora térmica 80mm.
// Frontend (SaleComplete) faz fetch com auth Bearer, abre popup,
// document.write(html), document.close() — popup auto-imprime.
//
// IMPORTANTE: declarada ANTES de /:nfceId (1 segment) pra clareza,
// embora o Express resolva 2 segments antes pelo parser.
router.get('/:nfceId/danfe-termica', requireAuth, async (req, res) => {
  try {
    const { id: cid, nfceId } = req.params;

    const { rows: emissions } = await db.query(
      'SELECT * FROM nfce_emissions WHERE id=$1 AND company_id=$2',
      [nfceId, cid]
    );
    if (!emissions.length) {
      return res.status(404).type('text/plain').send('Nota não encontrada');
    }
    const emission = emissions[0];

    if (emission.status !== 'autorizada') {
      return res.status(409).type('text/plain').send(
        `DANFE só pode ser impressa quando a nota está autorizada. Status atual: ${emission.status}`
      );
    }

    const { rows: companies } = await db.query(
      `SELECT id, cnpj, legal_name, trade_name, inscricao_estadual,
              address_street, address_number, address_district,
              address_city, address_state, address_zip
         FROM companies WHERE id=$1`,
      [cid]
    );
    if (!companies.length) {
      return res.status(404).type('text/plain').send('Empresa não encontrada');
    }
    const company = companies[0];

    const html = buildDanfeNfceHtml({ emission, company });
    res.type('html').send(html);
  } catch (err) {
    console.error('[nfce] danfe-termica error:', err);
    res.status(500).type('text/plain').send('Erro ao gerar DANFE térmica');
  }
});
// ────────────────────────────────────────────────────────────────────────

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
