// ============================================================
// AURA. — DANFE import (07/05/2026)
//
// Dois endpoints:
//
// 1. POST /companies/:id/products/import-danfe-xml   ← determinístico
//    Recebe XML da NF-e como string, parseia com fast-xml-parser.
//    Zero custo, zero quota, ~1-5ms.
//
// 2. POST /companies/:id/products/import-danfe-preview  ← IA (fallback)
//    Recebe PDF em base64, extrai via Claude.
//    Quota: Negocio=50/mes, Expansao=ilimitado.
//    Usar apenas para DANFEs escaneadas/fotografadas sem XML.
//
// Ambos retornam o mesmo shape de resposta.
// Campo stats.source: 'xml' | 'ai' diferencia a origem no frontend.
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { extractFromPdf, parseJsonResponse } = require('../services/claudeClient');
const { parseNFeXML } = require('../utils/nfeParser');

// ── POST /import-danfe-xml ──────────────────────────────────
// Aceita: { xml_content: string }  (conteúdo bruto do .xml)
// Sem quota, sem IA, sem custo.
router.post('/import-danfe-xml', async (req, res) => {
  const { xml_content } = req.body || {};

  if (!xml_content || typeof xml_content !== 'string') {
    return res.status(400).json({
      error: 'xml_content obrigatório (conteúdo do arquivo .xml da NF-e como string)',
    });
  }

  if (xml_content.length > 5 * 1024 * 1024) {
    return res.status(413).json({ error: 'XML muito grande. Máximo 5 MB.' });
  }

  const startedAt = Date.now();
  let parsed;
  try {
    parsed = parseNFeXML(xml_content);
  } catch (err) {
    console.warn('[danfeXML] parse error:', err.message);
    return res.status(422).json({
      error: err.message || 'Não foi possível interpretar o XML. Verifique se é um arquivo NF-e válido.',
    });
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(`[danfeXML] parsed ${parsed.items.length} items in ${elapsedMs}ms (NF ${parsed.invoice_number || '?'})`);

  if (parsed.items.length === 0) {
    return res.json({
      items:          [],
      supplier_name:  parsed.supplier_name,
      supplier_cnpj:  parsed.supplier_cnpj,
      invoice_number: parsed.invoice_number,
      invoice_series: parsed.invoice_series,
      invoice_date:   parsed.invoice_date,
      total_value:    parsed.total_value,
      warning: 'Nenhum item válido encontrado no XML.',
      stats: { extracted_count: 0, elapsed_ms: elapsedMs, source: 'xml' },
    });
  }

  res.json({
    items:          parsed.items,
    supplier_name:  parsed.supplier_name,
    supplier_cnpj:  parsed.supplier_cnpj,
    invoice_number: parsed.invoice_number,
    invoice_series: parsed.invoice_series,
    invoice_date:   parsed.invoice_date,
    total_value:    parsed.total_value,
    stats: {
      extracted_count: parsed.items.length,
      elapsed_ms:      elapsedMs,
      source:          'xml',
    },
  });
});

// ── Quota helper (endpoint PDF/IA abaixo) ───────────────────
const MONTHLY_QUOTA = {
  essencial:     0,
  negocio:       50,
  expansao:      9999,
  personalizado: 9999,
};

async function checkQuota(companyId, plan) {
  const limit = MONTHLY_QUOTA[(plan || '').toLowerCase()] ?? 0;
  if (limit <= 0) return { allowed: false, used: 0, limit: 0 };
  if (limit >= 9999) return { allowed: true, used: -1, limit: -1 };

  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS total
     FROM ai_activity_log
     WHERE company_id = $1
       AND action = 'danfe_extract'
       AND status = 'success'
       AND created_at >= date_trunc('month', NOW())`,
    [companyId]
  );
  const used = rows[0]?.total || 0;
  return { allowed: used < limit, used, limit };
}

async function logActivity(companyId, userId, status, detail, tokens) {
  try {
    await db.query(
      `INSERT INTO ai_activity_log
         (company_id, user_id, agent, action, detail, status, input_tokens, output_tokens)
       VALUES ($1, $2, 'danfe', 'danfe_extract', $3, $4, $5, $6)`,
      [
        companyId,
        userId || null,
        detail || null,
        status,
        tokens?.input || 0,
        tokens?.output || 0,
      ]
    );
  } catch (err) {
    console.error('[danfeImport] log error:', err.message);
  }
}

const EXTRACT_PROMPT = `Analise o PDF da DANFE/Nota Fiscal anexada e extraia TODOS os itens listados na seção de produtos.

Para cada item, retorne os campos:
- description: nome/descrição completa do produto (xProd)
- quantity: quantidade comercial (qCom) — número decimal
- unit_cost: valor unitário em reais (vUnCom) — número decimal, sem "R$"
- unit: unidade comercial (un, kg, cx, pc, m, etc) — string curta, default "un"
- ncm: NCM se visível, exatamente 8 dígitos sem pontos — string ou null
- supplier_code: código interno do fornecedor (cProd) se visível — string ou null

Também extraia, se conseguir identificar:
- supplier_name: razão social ou nome fantasia do emitente
- invoice_number: número da NF-e
- invoice_date: data de emissão (formato AAAA-MM-DD)

Responda APENAS com JSON válido nesse formato (sem markdown, sem comentários):
{
  "supplier_name": "...",
  "invoice_number": "...",
  "invoice_date": "...",
  "items": [
    { "description": "...", "quantity": 0, "unit_cost": 0, "unit": "un", "ncm": null, "supplier_code": null }
  ]
}

Regras importantes:
- Não invente dados. Se um campo não for visível, use null (string) ou 0 (número).
- Quantidade e custo devem ser números — converta vírgula brasileira ("1.234,56") para float (1234.56).
- Se a descrição vier truncada/abreviada no PDF, retorne o que conseguiu ler.
- Ignore linhas de subtotal, ICMS, IPI, frete — apenas itens de produto.`;

const SYSTEM_PROMPT = `Você é um assistente especialista em documentos fiscais brasileiros (NF-e/DANFE).
Extrai dados estruturados de PDFs de notas fiscais com precisão. Sempre responde com JSON válido conforme o schema solicitado.`;

// ── POST /import-danfe-preview (legado — PDF via IA) ────────
router.post('/import-danfe-preview', async (req, res) => {
  const companyId = req.params.id;
  const userId    = req.user?.id;
  const userPlan  = (req.user?.plan || '').toLowerCase();
  const { pdf_base64 } = req.body || {};

  if (!pdf_base64 || typeof pdf_base64 !== 'string') {
    return res.status(400).json({ error: 'pdf_base64 obrigatorio (PDF da DANFE em base64)' });
  }

  const sizeBytes = Math.floor((pdf_base64.length * 3) / 4);
  if (sizeBytes > 4 * 1024 * 1024) {
    return res.status(413).json({
      error: 'PDF muito grande. Maximo 4 MB. Tente comprimir o PDF antes de enviar.',
    });
  }

  const quota = await checkQuota(companyId, userPlan);
  if (!quota.allowed) {
    return res.status(429).json({
      error: quota.limit === 0
        ? 'Importacao via DANFE PDF requer plano Negocio ou superior.'
        : `Cota mensal de importacoes DANFE atingida (${quota.used}/${quota.limit}). Renova no proximo mes.`,
      quota,
    });
  }

  try {
    const startedAt = Date.now();
    const result = await extractFromPdf({
      pdfBase64: pdf_base64,
      system:    SYSTEM_PROMPT,
      prompt:    EXTRACT_PROMPT,
      maxTokens: 6000,
    });

    let parsed;
    try {
      parsed = parseJsonResponse(result.text);
    } catch (parseErr) {
      console.error('[danfeImport] parse error:', parseErr.message);
      await logActivity(companyId, userId, 'parse_error', parseErr.message, {
        input: result.inputTokens, output: result.outputTokens,
      });
      return res.status(502).json({
        error: 'Nao consegui extrair os dados do PDF. Tente um PDF de melhor qualidade ou cadastre manualmente.',
        debug_raw: process.env.NODE_ENV === 'development' ? result.text.slice(0, 200) : undefined,
      });
    }

    const items = Array.isArray(parsed.items) ? parsed.items : [];
    if (items.length === 0) {
      await logActivity(companyId, userId, 'empty', 'no items extracted', {
        input: result.inputTokens, output: result.outputTokens,
      });
      return res.json({
        items: [],
        supplier_name:  parsed.supplier_name || null,
        invoice_number: parsed.invoice_number || null,
        invoice_date:   parsed.invoice_date || null,
        warning: 'Nenhum item encontrado no PDF. Verifique se a DANFE esta legivel.',
        quota:  { used: quota.used + 1, limit: quota.limit },
        stats:  { source: 'ai' },
      });
    }

    const cleanItems = items.map((it, idx) => ({
      idx,
      description:   String(it.description || '').trim().slice(0, 200),
      quantity:      parseFloat(it.quantity) || 0,
      unit_cost:     parseFloat(it.unit_cost) || 0,
      unit:          String(it.unit || 'un').trim().slice(0, 10),
      ncm:           it.ncm && /^\d{8}$/.test(String(it.ncm).replace(/\D/g, ''))
                       ? String(it.ncm).replace(/\D/g, '') : null,
      supplier_code: it.supplier_code ? String(it.supplier_code).trim().slice(0, 50) : null,
      ean:           null,
    })).filter(it => it.description && it.quantity > 0);

    const elapsedMs = Date.now() - startedAt;
    console.log(`[danfeImport] AI extracted ${cleanItems.length} items in ${elapsedMs}ms`);

    await logActivity(
      companyId, userId, 'success',
      `${cleanItems.length} items / ${parsed.invoice_number || 'sem-numero'}`,
      { input: result.inputTokens, output: result.outputTokens }
    );

    res.json({
      items:          cleanItems,
      supplier_name:  parsed.supplier_name  || null,
      invoice_number: parsed.invoice_number || null,
      invoice_date:   parsed.invoice_date   || null,
      stats: {
        extracted_count: cleanItems.length,
        elapsed_ms:      elapsedMs,
        input_tokens:    result.inputTokens,
        output_tokens:   result.outputTokens,
        source:          'ai',
      },
      quota: { used: quota.used + 1, limit: quota.limit },
    });
  } catch (err) {
    console.error('[danfeImport] error:', err.message);
    await logActivity(companyId, userId, 'error', err.message, null);
    if (err.status === 401 || err.status === 403)
      return res.status(500).json({ error: 'Servico de IA temporariamente indisponivel. Tente novamente em alguns minutos.' });
    if (err.status === 413 || err.status === 400)
      return res.status(400).json({ error: 'PDF nao pode ser processado. Verifique se e um arquivo valido.' });
    res.status(500).json({ error: 'Erro ao extrair itens da DANFE. Tente novamente.' });
  }
});

// GET /companies/:id/products/danfe-quota
router.get('/danfe-quota', async (req, res) => {
  const userPlan = (req.user?.plan || '').toLowerCase();
  const quota = await checkQuota(req.params.id, userPlan);
  res.json({ plan: userPlan, used: quota.used, limit: quota.limit, allowed: quota.allowed });
});

module.exports = router;
