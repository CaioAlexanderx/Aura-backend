// ============================================================
// AURA. — NFC-e / NF-e PDV
// Mounted at: /companies/:id/nfce
//
// Mai/2026 features:
// - /config GET/POST inclui auto_emit_nfce (toggle de emissao automatica)
// - /emit aceita body.payments[] (multi-pagamento, soma deve bater com total)
// - /:nfceId/danfe-termica retorna HTML 80mm pra impressao termica
// - paymentCode mapeia 'crediario' → '05' (Credito Loja, tPag 05).
//   Correcao 29/05/2026: era '01' (Dinheiro), incorreto fiscalmente.
//   indPag=1 (a prazo) propagado automaticamente para crediario nos payments[].
//
// 02/06/2026 (#3 corrida de numeracao): /emit reserva o numero de forma
//   ATOMICA (UPDATE nfce_config ... RETURNING) antes de transmitir, em vez de
//   ler next_number e so incrementar pos-SEFAZ. Sem isso, duas emissoes
//   concorrentes pegavam o MESMO numero e a SEFAZ rejeitava por duplicidade.
//   Retransmissao da MESMA venda (apos corrigir rejeicao) reusa o numero ja
//   reservado — so nota autorizada/denegada consome numero. (Consequencia
//   aceita: nota abandonada apos rejeicao vira gap de numeracao, resolvivel
//   por inutilizacao na SEFAZ.)
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db      = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAuditAction }           = require('../middleware/auditLog');
const nuvemfiscal                  = require('../services/nuvemfiscal');
const sefazSp                      = require('../services/sefazSp');
const engineBreaker                = require('../services/sefazSp/engineBreaker');
const rejectionCatalog             = require('../services/sefazSp/rejectionCatalog');
const taxEngine                    = require('../services/sefazSp/taxEngine');
const { buildDanfeNfceHtml }       = require('../utils/buildDanfeNfceHtml');

const INSTRUCOES_NOTA = {
  nfce: 'NFC-e (Nota Fiscal do Consumidor): ideal para vendas a pessoas fisicas. O CPF do comprador e opcional. Use na maioria das vendas do balcao.',
  nfe:  'NF-e (Nota Fiscal Eletronica): use quando o cliente informar CNPJ ou exigir nota de empresa. CPF ou CNPJ do destinatario e obrigatorio.',
  dica: 'Na duvida, use NFC-e. Mude para NF-e somente quando o cliente pedir nota com CNPJ.',
};

const CONSULTA_NFCE_URL = {
  SP: 'https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica',
  RJ: 'https://www4.fazenda.rj.gov.br/consultaNFCe/',
  MG: 'https://nfce.fazenda.mg.gov.br/portalnfce',
  RS: 'https://www.sefaz.rs.gov.br/NFCE/NFCE-COM.aspx',
  PR: 'http://www.fazenda.pr.gov.br/nfce',
  SC: 'https://sat.sef.sc.gov.br/nfce/consulta',
  _:  'https://www.nfe.fazenda.gov.br/portal/consulta.aspx',
};
function consultaUrlByUf(uf) {
  return CONSULTA_NFCE_URL[(uf || '').toUpperCase()] || CONSULTA_NFCE_URL._;
}

// Mapeia metodo PDV → tPag SEFAZ.
// crediario → '05' (Credito Loja): correcao de 29/05/2026.
// Anteriormente era '01' (Dinheiro) — incorreto fiscalmente pois
// credito de loja tem tPag proprio definido pela tabela B17 NT 2015.002.
function paymentCode(method) {
  const map = {
    dinheiro: '01', cheque: '02', credito: '03', debito: '04',
    cartao: '03', boleto: '15', pix: '17',
    crediario: '05', // Credito Loja (tPag 05, a prazo -- indPag=1)
    outros: '99',
  };
  return map[method] || '01';
}

function extractProvFields(resp) {
  if (!resp) return {};
  const aut   = resp.autorizacao || resp.protocolo_autorizacao || {};
  const proto = aut.protocolo || aut;
  const supl  = resp.infNFeSupl || resp.inf_nfe_supl || {};
  const cStat = resp.codigo_status || resp.c_stat || resp.cStat
    || aut.codigo_status || aut.c_stat || aut.cStat || proto.cStat || null;
  const xMotivo = resp.motivo_status || aut.motivo_status || proto.xMotivo || aut.xMotivo
    || resp.x_motivo || resp.xMotivo || null;
  const motivoTop = (resp.motivo && resp.motivo !== '-') ? resp.motivo : null;
  const motivo = motivoTop || xMotivo || resp.mensagem_sefaz || resp.mensagem || null;
  return {
    nuvemfiscalId: resp.id || null,
    chaveAcesso:   resp.chave_acesso || resp.chave || aut.chave_acesso || resp.chNFe || proto.chNFe || null,
    protocolo:     resp.protocolo || resp.numero_protocolo || aut.numero_protocolo
                   || aut.protocolo || proto.nProt || aut.nProt || null,
    xmlUrl:        resp.link_xml || resp.url_xml || resp.xml_url || null,
    pdfUrl:        resp.link_pdf || resp.url_pdf || resp.pdf_url || resp.danfe_url || null,
    qrCode:        resp.qr_code  || resp.qrCode  || supl.qrCode  || supl.qr_code || null,
    urlConsulta:   resp.url_consulta || resp.urlChave || supl.urlChave || supl.url_chave || null,
    status:        resp.status || aut.status || null,
    cStat, motivo,
  };
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) return { error: 'items obrigatorio (array de produtos)' };
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const qty = Number(it.quantity);
    const price = Number(it.unit_price !== undefined ? it.unit_price : it.price);
    if (!isFinite(qty) || qty <= 0) return { error: `Item ${i+1}: quantidade deve ser > 0` };
    if (!isFinite(price) || price < 0) return { error: `Item ${i+1}: preco unitario invalido` };
    if (!String(it.product_name || it.name || '').trim()) return { error: `Item ${i+1}: nome do produto obrigatorio` };
  }
  return null;
}

function validatePayments(payments, totalNfce) {
  if (!Array.isArray(payments)) return null;
  if (payments.length === 0) return { error: 'payments[] vazio' };
  let sum = 0;
  for (let i = 0; i < payments.length; i++) {
    const p = payments[i] || {};
    if (!p.method) return { error: `payments[${i}]: method obrigatorio` };
    const v = Number(p.value);
    if (!isFinite(v) || v <= 0) return { error: `payments[${i}]: value invalido (${p.value})` };
    sum += v;
  }
  const diff = Math.abs(Math.round((sum - totalNfce) * 100));
  if (diff > 1) return { error: `Soma dos pagamentos (R$ ${sum.toFixed(2)}) nao bate com total (R$ ${totalNfce.toFixed(2)})` };
  return null;
}

// ── S4.2: cache module-level do check "colunas do fallback existem?" ──
// Migration 176 (serie_sefaz_sp/next_number_sefaz_sp/provider_used/
// fallback_reason) pode não estar aplicada quando o backend sobe (padrão do
// CLAUDE.md). Sem as colunas, caímos no comportamento LEGADO: sem fallback,
// série única do gateway, sem gravar provider_used. Cache pra não repetir o
// probe a cada request (só reprobiamos se o primeiro probe deu erro).
let _fallbackColsAvailable = null; // true | false | null(=ainda não checado)
async function fallbackColsAvailable() {
  if (_fallbackColsAvailable !== null) return _fallbackColsAvailable;
  try {
    await db.query(
      `SELECT serie_sefaz_sp, next_number_sefaz_sp FROM nfce_config LIMIT 0`
    );
    await db.query(
      `SELECT provider_used, fallback_reason FROM nfce_emissions LIMIT 0`
    );
    _fallbackColsAvailable = true;
  } catch (e) {
    if (e.code === '42703' || e.code === '42P01') {
      _fallbackColsAvailable = false;
    } else {
      // erro transitório (conexão etc): não cacheia, tenta de novo na próxima
      return false;
    }
  }
  return _fallbackColsAvailable;
}

// S4.2: grava provider_used/fallback_reason na emissão (defensivo p/ 42703).
async function persistProviderUsed(emissionId, providerUsed, fallbackReason) {
  if (!(await fallbackColsAvailable())) return; // migration 176 ausente: no-op
  try {
    await db.query(
      `UPDATE nfce_emissions SET provider_used=$1, fallback_reason=$2 WHERE id=$3`,
      [providerUsed || null, fallbackReason || null, emissionId]
    );
  } catch (e) {
    if (e.code !== '42703') throw e;
    _fallbackColsAvailable = false; // corrige cache se o probe mentiu
  }
}

router.get('/config', requireAuth, async (req, res) => {
  try {
    // S4.4: provider + série/contador próprios (defensivo p/ migration 176 ausente)
    let rows;
    try {
      ({ rows } = await db.query(
        `SELECT id, company_id, serie_nfce, next_number, ambiente, uf,
                inscricao_estadual, is_active, csc_id, auto_emit_nfce,
                provider, serie_sefaz_sp, next_number_sefaz_sp
           FROM nfce_config WHERE company_id=$1`,
        [req.params.id]
      ));
    } catch (e) {
      if (e.code !== '42703') throw e;
      ({ rows } = await db.query(
        `SELECT id, company_id, serie_nfce, next_number, ambiente, uf,
                inscricao_estadual, is_active, csc_id, auto_emit_nfce, provider
           FROM nfce_config WHERE company_id=$1`,
        [req.params.id]
      ));
    }
    res.json({ config: rows[0] || null, instrucoes: INSTRUCOES_NOTA });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar config NFC-e' }); }
});

router.post('/config', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { serie_nfce, ambiente, uf, inscricao_estadual, csc_id, csc_token, auto_emit_nfce,
          provider, serie_sefaz_sp } = req.body;

  // S4.4: seletor de provider por empresa. Whitelist restrita (focusnfe não
  // é ofertável ainda). undefined = não mexe no provider (compat).
  if (provider !== undefined && provider !== null &&
      !['nuvemfiscal', 'sefaz_sp'].includes(provider)) {
    return res.status(400).json({ error: 'provider inválido (use "nuvemfiscal" ou "sefaz_sp")' });
  }
  let serieSefazSp = null;
  if (serie_sefaz_sp !== undefined && serie_sefaz_sp !== null) {
    const s = parseInt(serie_sefaz_sp, 10);
    if (!Number.isInteger(s) || s < 1 || s > 999) {
      return res.status(400).json({ error: 'serie_sefaz_sp inválida (inteiro 1–999)' });
    }
    serieSefazSp = s;
  }

  try {
    const providerVal = (provider === undefined) ? null : provider;
    try {
      // S4.4: caminho com colunas da migration 176
      const { rows } = await db.query(
        `INSERT INTO nfce_config (company_id, serie_nfce, ambiente, uf, inscricao_estadual, csc_id, csc_token, auto_emit_nfce, provider, serie_sefaz_sp)
         VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,false),COALESCE($9,'nuvemfiscal'),COALESCE($10,2))
         ON CONFLICT (company_id) DO UPDATE SET
           serie_nfce=$2, ambiente=$3, uf=$4, inscricao_estadual=$5,
           csc_id=$6, csc_token=$7, auto_emit_nfce=COALESCE($8,nfce_config.auto_emit_nfce),
           provider=COALESCE($9,nfce_config.provider),
           serie_sefaz_sp=COALESCE($10,nfce_config.serie_sefaz_sp), updated_at=NOW()
         RETURNING *`,
        [req.params.id, serie_nfce||1, ambiente||'homologacao', uf||'SP',
         inscricao_estadual||null, csc_id||null, csc_token||null,
         typeof auto_emit_nfce==='boolean' ? auto_emit_nfce : null,
         providerVal, serieSefazSp]
      );
      return res.json({ config: rows[0] });
    } catch (e) {
      if (e.code !== '42703') throw e;
      // Fallback legado (migration 176 não aplicada): sem provider/serie própria
      const { rows } = await db.query(
        `INSERT INTO nfce_config (company_id, serie_nfce, ambiente, uf, inscricao_estadual, csc_id, csc_token, auto_emit_nfce)
         VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,false))
         ON CONFLICT (company_id) DO UPDATE SET
           serie_nfce=$2, ambiente=$3, uf=$4, inscricao_estadual=$5,
           csc_id=$6, csc_token=$7, auto_emit_nfce=COALESCE($8,nfce_config.auto_emit_nfce), updated_at=NOW()
         RETURNING *`,
        [req.params.id, serie_nfce||1, ambiente||'homologacao', uf||'SP',
         inscricao_estadual||null, csc_id||null, csc_token||null,
         typeof auto_emit_nfce==='boolean' ? auto_emit_nfce : null]
      );
      return res.json({ config: rows[0] });
    }
  } catch (err) { res.status(500).json({ error: 'Erro ao salvar config' }); }
});

router.post('/emit', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const {
    items, customer_cpf, customer_name, customer_email, recipient_cnpj,
    payment_method, payment_change, payments,
    sale_id, transaction_id, observacoes,
    tipo = 'nfce',
  } = req.body;

  const itemsErr = validateItems(items);
  if (itemsErr) return res.status(400).json(itemsErr);
  if (tipo === 'nfe' && !customer_cpf && !recipient_cnpj) {
    return res.status(400).json({ error: 'NF-e (modelo 55) exige CPF ou CNPJ do destinatario.', instrucao: INSTRUCOES_NOTA.nfe });
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
        return res.status(200).json({ nfce: e, tipo, pdf_url: e.pdf_url, xml_url: e.xml_url, qr_code: e.qr_code, url_consulta: e.url_consulta, idempotent: true });
      }
    }

    const { rows: configs } = await db.query('SELECT * FROM nfce_config WHERE company_id=$1', [req.params.id]);
    if (!configs.length || !configs[0].is_active) {
      return res.status(400).json({ error: 'Emissao de nota fiscal nao configurada. Acesse Configuracoes > Nota Fiscal.', instrucao: INSTRUCOES_NOTA.dica });
    }
    const config = configs[0];

    const { rows: companies } = await db.query(
      `SELECT id, cnpj, legal_name, trade_name,
              address_street, address_number, address_district AS address_neighborhood,
              address_city, address_state, address_zip,
              inscricao_estadual, inscricao_municipal, ibge_code, email, phone, tax_regime
         FROM companies WHERE id=$1`,
      [req.params.id]
    );
    if (!companies.length) return res.status(404).json({ error: 'Empresa nao encontrada' });
    const company = companies[0];
    if (!company.cnpj) return res.status(400).json({ error: 'CNPJ da empresa nao cadastrado.' });
    if (!company.ibge_code) return res.status(400).json({ error: 'Codigo IBGE da empresa nao cadastrado (campo cMun obrigatorio). Atualize em Configuracoes > Empresa.' });
    if (!company.inscricao_estadual && config.inscricao_estadual) company.inscricao_estadual = config.inscricao_estadual;
    if (!company.inscricao_estadual) return res.status(400).json({ error: 'Inscricao Estadual da empresa nao cadastrada.' });

    let totalProducts = 0, totalDiscount = 0;
    for (const item of items) {
      totalProducts += (Number(item.quantity)||1) * (Number(item.unit_price||item.price)||0);
      totalDiscount += Number(item.discount)||0;
    }
    const totalNfce = Math.round((totalProducts - totalDiscount) * 100) / 100;

    const paymentsErr = validatePayments(payments, totalNfce);
    if (paymentsErr) return res.status(400).json(paymentsErr);

    // ── S4.2: seletor de provider + fallback engine→gateway ──────────────
    // CLASSIFICAÇÃO DE ERROS (regra de ouro):
    //   • THROW de sefazSp.emitNfce = defeito da NOSSA engine (cert não
    //     carrega/decripta, CSC ausente, falha de assinatura, bug de XML) →
    //     registra no breaker e FALLBACK pro gateway na MESMA request.
    //   • Resultado 'contingencia' = SEFAZ fora do ar → NÃO faz fallback
    //     (o gateway fala com a MESMA SEFAZ e falharia igual; a contingência
    //     offline já resolve). Segue o fluxo S3.
    //   • Resultado 'rejeitado' = SEFAZ respondeu → NÃO faz fallback (é
    //     problema de dado, o gateway rejeitaria igual) e conta como SUCESSO
    //     pro breaker (a engine funcionou).
    //
    // Numeração: a emissão própria usa SÉRIE/CONTADOR dedicados
    // (serie_sefaz_sp / next_number_sefaz_sp) pra nunca colidir com o gateway
    // no fallback. Se as colunas da migration 176 não existirem (42703),
    // caímos no comportamento LEGADO: sem fallback, série única do gateway.
    const wantSefazSp = config.provider === 'sefaz_sp' && tipo === 'nfce';
    const hasFallbackCols = await fallbackColsAvailable();
    const breakerOpen = wantSefazSp && hasFallbackCols && engineBreaker.isOpen(req.params.id);
    // useSefazSp = de fato vamos tentar a engine (provider próprio, colunas
    // presentes E breaker fechado). Breaker aberto → direto ao gateway.
    let useSefazSp = wantSefazSp && hasFallbackCols && !breakerOpen;
    let providerUsed = useSefazSp ? 'sefaz_sp' : 'nuvemfiscal';
    let fallbackReason = breakerOpen ? 'breaker_open' : null;

    // ── #3 (02/06/2026): reserva ATOMICA do numero ANTES de transmitir ──
    // Retransmissao da MESMA venda+tipo apos rejeicao reusa o numero ja
    // reservado (so nota autorizada/denegada consome numero na SEFAZ).
    // S4.2: a coluna de contador depende do provider efetivo.
    const numCol   = useSefazSp ? 'next_number_sefaz_sp' : 'next_number';
    let   serieNF  = useSefazSp ? config.serie_sefaz_sp : config.serie_nfce;
    let numeroNF = null;
    if (sale_id) {
      const { rows: prevRej } = await db.query(
        `SELECT numero FROM nfce_emissions
          WHERE company_id=$1 AND sale_id=$2 AND tipo=$3 AND numero IS NOT NULL
            AND status IN ('rejeitada','erro')
          ORDER BY created_at DESC LIMIT 1`,
        [req.params.id, sale_id, tipo]
      );
      if (prevRej.length && prevRej[0].numero != null) numeroNF = parseInt(prevRej[0].numero, 10);
    }
    if (numeroNF == null) {
      // Incremento atomico: o row-lock de nfce_config serializa concorrentes,
      // entao cada emissao concorrente recebe um numero distinto.
      const { rows: rsv } = await db.query(
        `UPDATE nfce_config SET ${numCol} = ${numCol} + 1, updated_at=NOW()
          WHERE company_id=$1 RETURNING (${numCol} - 1) AS numero`,
        [req.params.id]
      );
      numeroNF = (rsv[0] && rsv[0].numero != null) ? parseInt(rsv[0].numero, 10)
        : (useSefazSp ? (config.next_number_sefaz_sp || 1) : config.next_number);
    }

    const now = new Date();
    const yy = String(now.getFullYear()).slice(2);
    const mm = String(now.getMonth()+1).padStart(2,'0');
    const modelo = tipo==='nfe' ? '55' : '65';
    const cUF = String(nuvemfiscal.ufToCodigo(config.uf||company.address_state)).padStart(2,'0');
    const buildChaveTmp = (serie, numero) =>
      `${cUF}${yy}${mm}${'0'.repeat(14)}${modelo}${String(serie).padStart(3,'0')}` +
      `${String(numero).padStart(9,'0')}1${'0'.repeat(8)}1`;
    let chaveAcessoTmp = buildChaveTmp(serieNF, numeroNF);

    const { rows: created } = await db.query(
      `INSERT INTO nfce_emissions
         (company_id, sale_id, transaction_id, numero, serie, chave_acesso, status,
          customer_cpf, customer_name, items, total_products, total_discount, total_nfce,
          payment_method, payment_change, emitted_by, tipo)
       VALUES ($1,$2,$3,$4,$5,$6,'processando',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [req.params.id, sale_id||null, transaction_id||null, numeroNF, serieNF, chaveAcessoTmp,
       customer_cpf||null, customer_name||null, JSON.stringify(items),
       totalProducts, totalDiscount, totalNfce,
       Array.isArray(payments) ? JSON.stringify(payments) : (payment_method||'dinheiro'),
       payment_change||0, req.user.id, tipo]
    );
    const emission = created[0];

    let finalStatus = 'processando';
    let prov = {};

    // useSefazSp já foi decidido acima (provider próprio + colunas + breaker
    // fechado). S1.6: emissão própria só NFC-e (65); NF-e (55) segue no gateway.

    if (config.ambiente === 'homologacao' && !useSefazSp && process.env.NUVEM_FISCAL_FORCE !== 'true') {
      prov.protocolo = 'HOMOLOG-' + String(numeroNF).padStart(6,'0');
      finalStatus = 'autorizada';
      await db.query(`UPDATE nfce_emissions SET status='autorizada', protocolo=$1, authorized_at=NOW() WHERE id=$2`, [prov.protocolo, emission.id]);
      await persistProviderUsed(emission.id, providerUsed, fallbackReason);
    } else {
      try {
        const productIds = items.map(i => i.product_id).filter(id => typeof id==='string' && id.length>0);
        const ncmByProductId = new Map();
        const taxProfileByProductId = new Map(); // S3.2
        if (productIds.length > 0) {
          const { rows: prodRows } = await db.query(
            `SELECT id, ncm, tax_profile FROM products WHERE id=ANY($1::uuid[]) AND company_id=$2`,
            [productIds, req.params.id]
          );
          for (const p of prodRows) {
            const n = (p.ncm||'').trim();
            if (n && n !== '00000000') ncmByProductId.set(p.id, n);
            if (p.tax_profile) taxProfileByProductId.set(p.id, p.tax_profile);
          }
        }

        const crtCompany = company.tax_regime === 'mei' ? 4
          : (company.tax_regime === 'lucro_presumido' || company.tax_regime === 'lucro_real') ? 3 : 1;
        const nfItems = items.map(i => {
          const ncmFromItem = (i.ncm && String(i.ncm).trim()!=='00000000') ? String(i.ncm).trim() : null;
          const ncmFromDb   = ncmByProductId.get(i.product_id);
          const base = {
            code: String(i.product_id||i.code||''), name: i.product_name||i.name||'',
            description: i.description||i.product_name||i.name||'',
            ncm: ncmFromItem||ncmFromDb||'00000000', cfop: i.cfop||'5102', unit: i.unit||'UN',
            quantity: Number(i.quantity||1), price: Number(i.unit_price||i.price||0),
            discount: Number(i.discount)||0,
            barcode: i.barcode||undefined,
          };
          // S3.2: motor tributário só no caminho próprio (gateway intocado)
          if (useSefazSp) {
            const tax = taxEngine.resolveItemTax({
              taxProfile: taxProfileByProductId.get(i.product_id), crt: crtCompany,
            });
            base.csosn = tax.csosn; base.orig = tax.orig;
            base.pisCst = tax.pisCst; base.cofinsCst = tax.cofinsCst;
          }
          return base;
        });

        // F4 (29/05/2026): crediario = indPag 1 (a prazo) automaticamente.
        const nfPayments = Array.isArray(payments)
          ? payments.map(p => ({
              method: paymentCode(p.method),
              value:  Number(p.value),
              change: p.change,
              // crediario: a prazo (indPag=1); outros: a vista (indPag=0) salvo se caller definiu
              indPag: p.indPag !== undefined
                ? p.indPag
                : ((p.method||'').toLowerCase() === 'crediario' ? 1 : 0),
            }))
          : undefined;

        const buildEmitPayload = (serie, numero) => ({
          items: nfItems, total_value: totalNfce, payments: nfPayments,
          payment_method: paymentCode(payment_method), payment_change,
          recipient_cpf: customer_cpf, recipient_cnpj, recipient_name: customer_name,
          recipient_email: customer_email,
          serie, numero, observacoes,
          reference: `${tipo}-${emission.id}`,
        });

        let provResult;
        if (useSefazSp) {
          // ── S4.2: tenta a engine própria. THROW = defeito NOSSO → fallback.
          try {
            provResult = await sefazSp.emitNfce(
              company, buildEmitPayload(serieNF, numeroNF),
              { db, config, allowContingency: true }
            );
            // Chegou aqui: engine devolveu resultado (autorizado/rejeitado/
            // contingencia). Rejeição/autorização = SUCESSO pro breaker; a
            // contingência NÃO é falha da engine (é SEFAZ fora), então também
            // NÃO conta como falha — só não conta como sucesso.
            if (provResult && provResult.status !== 'contingencia') {
              engineBreaker.recordSuccess(req.params.id);
            }
          } catch (engineErr) {
            // Defeito de infra da nossa engine → registra no breaker e FALLBACK
            // pro gateway na MESMA request. O número da série própria já
            // reservado fica QUEIMADO (gap aceitável, resolúvel por inutilização
            // S2.1). Reservamos um número NOVO da série do GATEWAY.
            engineBreaker.recordFailure(req.params.id);
            console.error('[nfce] engine SEFAZ-SP falhou (fallback→gateway):',
              engineErr.message, engineErr.payload || '');

            useSefazSp = false;
            providerUsed = 'nuvemfiscal';
            fallbackReason = ('engine_error: ' + (engineErr.message || 'erro desconhecido')).slice(0, 500);

            // reserva atômica do número do GATEWAY + recalcula série/chave temp
            const { rows: gRsv } = await db.query(
              `UPDATE nfce_config SET next_number = next_number + 1, updated_at=NOW()
                WHERE company_id=$1 RETURNING (next_number - 1) AS numero`,
              [req.params.id]
            );
            numeroNF = (gRsv[0] && gRsv[0].numero != null) ? parseInt(gRsv[0].numero, 10) : config.next_number;
            serieNF = config.serie_nfce;
            chaveAcessoTmp = buildChaveTmp(serieNF, numeroNF);
            await db.query(
              `UPDATE nfce_emissions SET numero=$1, serie=$2, chave_acesso=$3 WHERE id=$4`,
              [numeroNF, serieNF, chaveAcessoTmp, emission.id]
            );

            const emitFn = tipo === 'nfe' ? nuvemfiscal.emitNfe : nuvemfiscal.emitNfce;
            provResult = await emitFn(company, buildEmitPayload(serieNF, numeroNF));
          }
        } else {
          const emitFn = tipo==='nfe' ? nuvemfiscal.emitNfe : nuvemfiscal.emitNfce;
          provResult = await emitFn(company, buildEmitPayload(serieNF, numeroNF));
        }

        console.log('[nfce] provResult (POST):', JSON.stringify(provResult, null, 2));
        prov = extractProvFields(provResult);
        finalStatus = (prov.status==='autorizado'||prov.status==='autorizada') ? 'autorizada'
                    : (prov.status==='rejeitado' ||prov.status==='rejeitada')  ? 'rejeitada'
                    : 'processando';

        if (finalStatus==='rejeitada' && prov.nuvemfiscalId && !prov.motivo) {
          try {
            const queryFn = tipo==='nfe' ? nuvemfiscal.queryNfe : nuvemfiscal.queryNfce;
            const fullResult = await queryFn(prov.nuvemfiscalId);
            const fullProv = extractProvFields(fullResult);
            if (fullProv.motivo) prov.motivo = fullProv.motivo;
            if (fullProv.cStat)  prov.cStat  = fullProv.cStat;
          } catch (e) { console.warn('[nfce] GET detalhe rejeicao falhou:', e.message); }
        }

        if (finalStatus==='autorizada' && !prov.urlConsulta && prov.chaveAcesso) {
          prov.urlConsulta = consultaUrlByUf(company.address_state||config.uf);
        }

        console.log(`[nfce] nfce #${numeroNF} status=${finalStatus} cStat=${prov.cStat} motivo=${prov.motivo}`);

        const authorizedAt = finalStatus==='autorizada' ? new Date() : null;
        const errorMessage = finalStatus==='rejeitada'
          ? (prov.motivo ? (prov.cStat ? `[${prov.cStat}] ${prov.motivo}` : prov.motivo) : JSON.stringify(provResult).slice(0,5000))
          : null;

        await db.query(
          `UPDATE nfce_emissions SET status=$1, nuvemfiscal_id=$2,
              chave_acesso=COALESCE($3,chave_acesso), protocolo=$4,
              xml_url=COALESCE(xml_url,$5), pdf_url=COALESCE(pdf_url,$6),
              qr_code=COALESCE(qr_code,$7), url_consulta=COALESCE(url_consulta,$8),
              authorized_at=$10, error_message=$11
            WHERE id=$9`,
          [finalStatus, prov.nuvemfiscalId, prov.chaveAcesso, prov.protocolo,
           prov.xmlUrl, prov.pdfUrl, prov.qrCode, prov.urlConsulta, emission.id,
           authorizedAt, errorMessage]
        );

        // S2.2: rejection_code é provider-agnóstico (catálogo amigável)
        if (finalStatus === 'rejeitada' && prov.cStat) {
          await db.query(`UPDATE nfce_emissions SET rejection_code=$1 WHERE id=$2`, [String(prov.cStat).slice(0,8), emission.id]);
        }

        // S1.6/S3.1: extras da emissão própria (migrations 173/175)
        if (useSefazSp) {
          await db.query(
            `UPDATE nfce_emissions SET xml_signed=$1, tp_emis=$2,
                rejection_code=$3, transmitted_at=CASE WHEN $4 THEN NOW() ELSE transmitted_at END,
                contingency_at=COALESCE($6, contingency_at)
              WHERE id=$5`,
            [provResult.xml_signed || null, provResult.tp_emis || 1,
             finalStatus==='rejeitada' ? (prov.cStat || null) : null,
             finalStatus==='autorizada', emission.id,
             provResult.contingency_at || null]
          );
          // S3.1: contingência entra na fila de retransmissão (prazo legal)
          if (provResult.status === 'contingencia') {
            const deadlineH = parseInt(process.env.NFCE_CONTINGENCY_DEADLINE_H || '24', 10);
            await db.query(
              `INSERT INTO nfce_pending_transmission (company_id, emission_id, deadline_at)
               VALUES ($1, $2, NOW() + ($3 || ' hours')::interval)
               ON CONFLICT (emission_id) DO NOTHING`,
              [req.params.id, emission.id, deadlineH]
            );
            console.log(`[nfce] contingência: nota ${numeroNF} enfileirada (prazo ${deadlineH}h)`);
          }
        }

        // S4.2: rastro do provider efetivamente usado + motivo do fallback.
        // Defensivo p/ migration 176 ausente (comportamento legado).
        await persistProviderUsed(emission.id, providerUsed, fallbackReason);

      } catch (apiErr) {
        // Chega aqui quando: gateway puro falhou, OU o PRÓPRIO fallback falhou.
        // Em ambos, providerUsed/fallbackReason já refletem o caminho tomado.
        const providerLabel = useSefazSp ? 'SEFAZ-SP' : 'Nuvem Fiscal';
        console.error(`[nfce] ${providerLabel} emit error:`, apiErr.message, apiErr.payload||'');
        await db.query(`UPDATE nfce_emissions SET status='erro', error_message=$1 WHERE id=$2`, [apiErr.message, emission.id]);
        await persistProviderUsed(emission.id, providerUsed, fallbackReason);
        return res.status(502).json({
          error: `Erro ao transmitir nota para ${providerLabel}: `+apiErr.message,
          payload: apiErr.payload||null, nfce_id: emission.id,
          provider_used: providerUsed, fallback: fallbackReason != null,
        });
      }
    }

    const { rows: final } = await db.query('SELECT * FROM nfce_emissions WHERE id=$1', [emission.id]);
    logAuditAction(req.user.id, req.params.id, 'nfce_emitted', `${tipo.toUpperCase()} no ${numeroNF} emitida -- R$ ${totalNfce}`);

    const amigavel = finalStatus === 'rejeitada'
      ? rejectionCatalog.lookup(prov.cStat, prov.motivo)
      : null;
    res.status(201).json({ nfce: final[0], tipo,
      pdf_url: prov.pdfUrl||final[0].pdf_url, xml_url: prov.xmlUrl||final[0].xml_url,
      qr_code: prov.qrCode||final[0].qr_code, url_consulta: prov.urlConsulta||final[0].url_consulta,
      motivo: prov.motivo||null, cStat: prov.cStat||null,
      rejeicao_amigavel: amigavel,
      contingencia: prov.status === 'contingencia',
      // S4.2: transparência do fallback pro frontend
      provider_used: providerUsed, fallback: fallbackReason != null });

  } catch (err) {
    console.error('nfce emit error:', err);
    res.status(500).json({ error: 'Erro ao emitir nota fiscal' });
  }
});

router.get('/', requireAuth, async (req, res) => {
  const { status, start, end, tipo } = req.query;
  try {
    const params = [req.params.id];
    let where = 'WHERE company_id=$1';
    if (status) { params.push(status); where += ` AND status=$${params.length}`; }
    if (tipo)   { params.push(tipo);   where += ` AND tipo=$${params.length}`; }
    if (start)  { params.push(start);  where += ` AND created_at>=$${params.length}`; }
    if (end)    { params.push(end);    where += ` AND created_at<=$${params.length}`; }
    // S4.4: provider_used/fallback_reason no SELECT (defensivo p/ migration 176)
    let rawRows;
    try {
      ({ rows: rawRows } = await db.query(
        `SELECT id, numero, serie, tipo, chave_acesso, protocolo, status,
                customer_cpf, customer_name, total_nfce, payment_method,
                xml_url, pdf_url, qr_code, url_consulta,
                authorized_at, cancelled_at, created_at, error_message,
                rejection_code, tp_emis, provider_used, fallback_reason
           FROM nfce_emissions ${where} ORDER BY numero DESC LIMIT 100`,
        params
      ));
    } catch (e) {
      if (e.code !== '42703') throw e;
      ({ rows: rawRows } = await db.query(
        `SELECT id, numero, serie, tipo, chave_acesso, protocolo, status,
                customer_cpf, customer_name, total_nfce, payment_method,
                xml_url, pdf_url, qr_code, url_consulta,
                authorized_at, cancelled_at, created_at, error_message,
                rejection_code, tp_emis
           FROM nfce_emissions ${where} ORDER BY numero DESC LIMIT 100`,
        params
      ));
    }
    // S2.2: motivo amigável (catálogo) pra rejeitadas/erro
    const rows = rawRows.map(r => {
      if (r.status !== 'rejeitada' && r.status !== 'erro') return r;
      const code = r.rejection_code || rejectionCatalog.cStatFromErrorMessage(r.error_message);
      return { ...r, rejeicao_amigavel: rejectionCatalog.lookup(code, r.error_message) };
    });
    const { rows: stats } = await db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status='autorizada')::int AS authorized,
              COUNT(*) FILTER (WHERE status='cancelada')::int  AS cancelled,
              COUNT(*) FILTER (WHERE tipo='nfe')::int          AS total_nfe,
              COUNT(*) FILTER (WHERE tipo='nfce')::int         AS total_nfce,
              COALESCE(SUM(total_nfce) FILTER (WHERE status='autorizada'),0)::numeric AS total_value
         FROM nfce_emissions WHERE company_id=$1`,
      [req.params.id]
    );
    res.json({ emissions: rows, stats: stats[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao listar emissoes' }); }
});

router.get('/diagnostico/:nuvemfiscalId', requireAuth, async (req, res) => {
  try {
    const { nuvemfiscalId } = req.params;
    const queryFn = nuvemfiscalId.startsWith('nfe_') ? nuvemfiscal.queryNfe : nuvemfiscal.queryNfce;
    const raw = await queryFn(nuvemfiscalId);
    console.log('[nfce] diagnostico raw:', JSON.stringify(raw, null, 2));
    res.json({ nuvemfiscalId, raw });
  } catch (err) {
    console.error('[nfce] diagnostico error:', err.message, err.payload||'');
    res.status(502).json({ error: err.message, payload: err.payload||null });
  }
});

router.get('/:nfceId/danfe-termica', requireAuth, async (req, res) => {
  try {
    const { id: cid, nfceId } = req.params;
    const { rows: emissions } = await db.query('SELECT * FROM nfce_emissions WHERE id=$1 AND company_id=$2', [nfceId, cid]);
    if (!emissions.length) return res.status(404).type('text/plain').send('Nota nao encontrada');
    const emission = emissions[0];
    const isContingenciaPendente = Number(emission.tp_emis) === 9 && emission.status === 'processando';
    if (emission.status !== 'autorizada' && !isContingenciaPendente) {
      return res.status(409).type('text/plain').send(`DANFE so pode ser impressa quando autorizada (ou em contingencia pendente). Status: ${emission.status}`);
    }
    const { rows: companies } = await db.query(
      `SELECT id, cnpj, legal_name, trade_name, inscricao_estadual,
              address_street, address_number, address_district,
              address_city, address_state, address_zip, logo_url
         FROM companies WHERE id=$1`, [cid]
    );
    if (!companies.length) return res.status(404).type('text/plain').send('Empresa nao encontrada');
    const html = buildDanfeNfceHtml({ emission, company: companies[0] });
    res.type('html').send(html);
  } catch (err) {
    console.error('[nfce] danfe-termica error:', err);
    res.status(500).type('text/plain').send('Erro ao gerar DANFE termica');
  }
});

router.get('/:nfceId', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM nfce_emissions WHERE id=$1 AND company_id=$2', [req.params.nfceId, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Nota nao encontrada' });
    let emission = rows[0];
    if (emission.status === 'processando' && emission.nuvemfiscal_id) {
      try {
        const queryFn = emission.tipo==='nfe' ? nuvemfiscal.queryNfe : nuvemfiscal.queryNfce;
        const provResult = await queryFn(emission.nuvemfiscal_id);
        const prov = extractProvFields(provResult);
        if (prov.status==='autorizado'||prov.status==='autorizada') {
          if (!prov.urlConsulta && prov.chaveAcesso) {
            const cUF = String(prov.chaveAcesso).slice(0,2);
            const ufFromCuf = {'11':'RO','12':'AC','13':'AM','14':'RR','15':'PA','16':'AP','17':'TO','21':'MA','22':'PI','23':'CE','24':'RN','25':'PB','26':'PE','27':'AL','28':'SE','29':'BA','31':'MG','32':'ES','33':'RJ','35':'SP','41':'PR','42':'SC','43':'RS','50':'MS','51':'MT','52':'GO','53':'DF'}[cUF];
            prov.urlConsulta = consultaUrlByUf(ufFromCuf);
          }
          await db.query(
            `UPDATE nfce_emissions SET status='autorizada',
                chave_acesso=COALESCE($1,chave_acesso), protocolo=COALESCE($2,protocolo),
                xml_url=COALESCE($3,xml_url), pdf_url=COALESCE($4,pdf_url),
                qr_code=COALESCE($5,qr_code), url_consulta=COALESCE($6,url_consulta),
                authorized_at=NOW() WHERE id=$7`,
            [prov.chaveAcesso, prov.protocolo, prov.xmlUrl, prov.pdfUrl, prov.qrCode, prov.urlConsulta, emission.id]
          );
          const refreshed = await db.query('SELECT * FROM nfce_emissions WHERE id=$1', [emission.id]);
          emission = refreshed.rows[0];
        }
      } catch (e) { /* best-effort */ }
    }
    res.json({ emission });
  } catch (err) { res.status(500).json({ error: 'Erro ao consultar nota' }); }
});

router.post('/:nfceId/cancel', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { reason } = req.body;
  if (!reason || reason.length < 15) return res.status(400).json({ error: 'Motivo do cancelamento exige ao menos 15 caracteres (regra SEFAZ)' });
  try {
    // S2.1: nota da emissão própria cancela via evento 110111 na SEFAZ-SP
    // ANTES de marcar local — nada de cancelamento só-local.
    const { rows: ownRows } = await db.query(
      `SELECT * FROM nfce_emissions WHERE id=$1 AND company_id=$2 AND xml_signed IS NOT NULL`,
      [req.params.nfceId, req.params.id]
    );
    if (ownRows.length) {
      const own = ownRows[0];
      if (own.status === 'cancelada') return res.json({ nfce: own, idempotent: true });
      if (own.status !== 'autorizada') {
        return res.status(400).json({ error: `Nota não pode ser cancelada (status: ${own.status})` });
      }
      // Prazo legal de cancelamento da NFC-e em SP (default 30min —
      // ⚠️ confirmar no MOC SP vigente; ajustável via env).
      const deadlineMin = parseInt(process.env.NFCE_CANCEL_DEADLINE_MIN || '30', 10);
      const ageMin = own.authorized_at ? (Date.now() - new Date(own.authorized_at).getTime()) / 60000 : null;
      if (ageMin !== null && ageMin > deadlineMin) {
        return res.status(400).json({ error: `Prazo de cancelamento expirado (${deadlineMin} min após a autorização, regra SEFAZ-SP). Fale com seu contador sobre regularização.` });
      }
      const { rows: cfgRows } = await db.query('SELECT * FROM nfce_config WHERE company_id=$1', [req.params.id]);
      if (!cfgRows.length) return res.status(400).json({ error: 'Config NFC-e não encontrada' });
      try {
        const ev = await sefazSp.cancelNfce({
          db, config: cfgRows[0], companyId: req.params.id,
          chave: own.chave_acesso, protocolo: own.protocolo, justificativa: reason,
        });
        if (!ev.sucesso) {
          return res.status(422).json({ error: `SEFAZ-SP recusou o cancelamento: [${ev.cStat}] ${ev.xMotivo || ''}`, cStat: ev.cStat });
        }
        const { rows: upd } = await db.query(
          `UPDATE nfce_emissions SET status='cancelada', cancel_reason=$1, cancelled_at=NOW() WHERE id=$2 RETURNING *`,
          [reason, own.id]
        );
        logAuditAction(req.user.id, req.params.id, 'nfce_cancelled',
          `NFC-e no ${own.numero} cancelada na SEFAZ-SP (evento ${ev.protocoloEvento || ev.cStat}): ${reason}`);
        return res.json({ nfce: upd[0], evento: { cStat: ev.cStat, protocolo: ev.protocoloEvento, ja_cancelada: ev.jaCancelada || false } });
      } catch (apiErr) {
        console.error('[nfce] SEFAZ-SP cancel error:', apiErr.message);
        return res.status(502).json({ error: 'Erro ao cancelar na SEFAZ-SP: ' + apiErr.message });
      }
    }
    const { rows } = await db.query(
      `UPDATE nfce_emissions SET status='cancelada', cancel_reason=$1, cancelled_at=NOW()
        WHERE id=$2 AND company_id=$3 AND status='autorizada' RETURNING *`,
      [reason, req.params.nfceId, req.params.id]
    );
    if (!rows.length) return res.status(400).json({ error: 'Nota nao encontrada ou nao pode ser cancelada' });
    const emission = rows[0];
    if (emission.nuvemfiscal_id) {
      try {
        const cancelFn = emission.tipo==='nfe' ? nuvemfiscal.cancelNfe : nuvemfiscal.cancelNfce;
        await cancelFn(emission.nuvemfiscal_id, reason);
      } catch (apiErr) {
        console.error('[nfce] Nuvem Fiscal cancel error:', apiErr.message);
        await db.query('UPDATE nfce_emissions SET error_message=$1 WHERE id=$2',
          ['Cancelamento local OK. Erro Nuvem Fiscal: '+apiErr.message, emission.id]);
      }
    }
    logAuditAction(req.user.id, req.params.id, 'nfce_cancelled', `${(emission.tipo||'nfce').toUpperCase()} no ${emission.numero} cancelada: ${reason}`);
    res.json({ nfce: emission });
  } catch (err) { res.status(500).json({ error: 'Erro ao cancelar nota' }); }
});

// ── S2.4: refresh manual (consulta situação na origem) ──
router.post('/:nfceId/refresh', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM nfce_emissions WHERE id=$1 AND company_id=$2', [req.params.nfceId, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Nota não encontrada' });
    let emission = rows[0];

    if (emission.xml_signed) {
      // Emissão própria: consulta por chave na SEFAZ-SP
      const { rows: cfgs } = await db.query('SELECT * FROM nfce_config WHERE company_id=$1', [req.params.id]);
      if (!cfgs.length) return res.status(400).json({ error: 'Config NFC-e não encontrada' });
      try {
        const r = await sefazSp.queryNfce({
          chave: emission.chave_acesso, config: cfgs[0], db, companyId: req.params.id,
        });
        if (r.status === 'autorizado' && emission.status !== 'autorizada') {
          await db.query(
            `UPDATE nfce_emissions SET status='autorizada', protocolo=COALESCE($1, protocolo),
                authorized_at=COALESCE(authorized_at, NOW()), transmitted_at=COALESCE(transmitted_at, NOW()),
                refresh_attempts=refresh_attempts+1, last_refresh_at=NOW() WHERE id=$2`,
            [r.protocolo, emission.id]
          );
        } else {
          await db.query(`UPDATE nfce_emissions SET refresh_attempts=refresh_attempts+1, last_refresh_at=NOW() WHERE id=$1`, [emission.id]);
        }
        const refreshed = await db.query('SELECT * FROM nfce_emissions WHERE id=$1', [emission.id]);
        return res.json({ emission: refreshed.rows[0], consulta: { cStat: r.codigo_status, motivo: r.motivo_status } });
      } catch (apiErr) {
        return res.status(502).json({ error: 'SEFAZ-SP indisponível pra consulta: ' + apiErr.message, emission });
      }
    }

    // Gateway: mesma lógica best-effort do GET /:nfceId
    if (emission.status === 'processando' && emission.nuvemfiscal_id) {
      try {
        const queryFn = emission.tipo==='nfe' ? nuvemfiscal.queryNfe : nuvemfiscal.queryNfce;
        const provResult = await queryFn(emission.nuvemfiscal_id);
        const prov = extractProvFields(provResult);
        if (prov.status==='autorizado'||prov.status==='autorizada') {
          await db.query(
            `UPDATE nfce_emissions SET status='autorizada',
                chave_acesso=COALESCE($1,chave_acesso), protocolo=COALESCE($2,protocolo),
                xml_url=COALESCE($3,xml_url), pdf_url=COALESCE($4,pdf_url),
                qr_code=COALESCE($5,qr_code), authorized_at=COALESCE(authorized_at, NOW()) WHERE id=$6`,
            [prov.chaveAcesso, prov.protocolo, prov.xmlUrl, prov.pdfUrl, prov.qrCode, emission.id]
          );
          const refreshed = await db.query('SELECT * FROM nfce_emissions WHERE id=$1', [emission.id]);
          emission = refreshed.rows[0];
        }
      } catch (e) { /* best-effort */ }
    }
    res.json({ emission });
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar nota' }); }
});

// ── S2.1: inutilização de faixa (emissão própria) ──
// Pros números reservados e abandonados (gap após rejeição não retransmitida).
router.post('/inutilizar', requireAuth, requireRole('client','analyst','admin'), async (req, res) => {
  const { serie, numero_inicial, numero_final, justificativa, ano } = req.body;
  if (!justificativa || String(justificativa).trim().length < 15) {
    return res.status(400).json({ error: 'Justificativa exige ao menos 15 caracteres (regra SEFAZ)' });
  }
  try {
    const { rows: configs } = await db.query('SELECT * FROM nfce_config WHERE company_id=$1', [req.params.id]);
    if (!configs.length) return res.status(400).json({ error: 'Config NFC-e não encontrada' });
    const config = configs[0];
    if (config.provider !== 'sefaz_sp') {
      return res.status(400).json({ error: 'Inutilização direta disponível apenas na emissão própria (provider sefaz_sp).' });
    }
    const { rows: companies } = await db.query('SELECT cnpj FROM companies WHERE id=$1', [req.params.id]);
    if (!companies.length || !companies[0].cnpj) return res.status(400).json({ error: 'CNPJ da empresa não cadastrado' });

    const r = await sefazSp.inutilizarFaixa({
      db, config, companyId: req.params.id,
      cnpj: companies[0].cnpj,
      serie: serie || config.serie_nfce,
      nIni: numero_inicial, nFin: numero_final,
      justificativa, ano2: ano ? String(ano).slice(-2) : undefined,
    });
    if (!r.sucesso) {
      return res.status(422).json({ error: `SEFAZ-SP recusou a inutilização: [${r.cStat}] ${r.xMotivo || ''}`, cStat: r.cStat });
    }
    logAuditAction(req.user.id, req.params.id, 'nfce_inutilizada',
      `Faixa ${numero_inicial}-${numero_final} série ${serie || config.serie_nfce} inutilizada (protocolo ${r.protocolo || r.cStat})`);
    res.json({ inutilizacao: { cStat: r.cStat, protocolo: r.protocolo, faixa: [numero_inicial, numero_final] } });
  } catch (err) {
    console.error('[nfce] inutilizar error:', err.message);
    res.status(502).json({ error: 'Erro ao inutilizar faixa: ' + err.message });
  }
});

// ── S3.3: telemetria da emissão (página NFe / S4.1) ──
router.get('/telemetry/resumo', requireAuth, async (req, res) => {
  try {
    const cid = req.params.id;
    const { rows: [m] } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at >= NOW()-INTERVAL '30 days')::int AS emitidas_30d,
         COUNT(*) FILTER (WHERE status='autorizada' AND created_at >= NOW()-INTERVAL '30 days')::int AS autorizadas_30d,
         COUNT(*) FILTER (WHERE status='rejeitada' AND created_at >= NOW()-INTERVAL '30 days')::int AS rejeitadas_30d,
         COUNT(*) FILTER (WHERE tp_emis=9 AND created_at >= NOW()-INTERVAL '1 day')::int AS contingencias_24h,
         COUNT(*) FILTER (WHERE tp_emis=9 AND created_at >= NOW()-INTERVAL '30 days')::int AS contingencias_30d,
         COALESCE(AVG(EXTRACT(EPOCH FROM (authorized_at - created_at)) * 1000)
           FILTER (WHERE status='autorizada' AND tp_emis=1 AND authorized_at IS NOT NULL
                   AND created_at >= NOW()-INTERVAL '7 days'), 0)::int AS latencia_media_ms_7d
       FROM nfce_emissions WHERE company_id=$1`, [cid]);

    const { rows: [fila] } = await db.query(
      `SELECT COUNT(*) FILTER (WHERE status='pending')::int AS pendentes,
              COUNT(*) FILTER (WHERE status='rejected')::int AS rejeitadas_tardias,
              COUNT(*) FILTER (WHERE status='expired')::int AS expiradas,
              MIN(deadline_at) FILTER (WHERE status='pending') AS proximo_prazo
         FROM nfce_pending_transmission WHERE company_id=$1`, [cid]);

    const { rows: certs } = await db.query(
      `SELECT subject_cn, not_after,
              EXTRACT(DAY FROM (not_after - NOW()))::int AS dias_pra_vencer
         FROM company_certificates WHERE company_id=$1`, [cid]);

    const taxa = m.emitidas_30d > 0 ? Math.round((m.autorizadas_30d / m.emitidas_30d) * 1000) / 10 : null;
    res.json({
      emissao: { ...m, taxa_autorizacao_30d_pct: taxa, baseline_gateway_pct: 88 },
      fila_contingencia: fila,
      certificado: certs[0] ? {
        subject_cn: certs[0].subject_cn, not_after: certs[0].not_after,
        dias_pra_vencer: certs[0].dias_pra_vencer,
        alerta: certs[0].dias_pra_vencer <= 7 ? 'critical'
          : certs[0].dias_pra_vencer <= 15 ? 'warning'
          : certs[0].dias_pra_vencer <= 30 ? 'info' : null,
      } : null,
    });
  } catch (err) {
    console.error('[nfce] telemetry error:', err.message);
    res.status(500).json({ error: 'Erro ao calcular telemetria' });
  }
});

module.exports = router;
