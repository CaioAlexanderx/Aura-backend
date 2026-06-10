#!/usr/bin/env node
// ============================================================
// AURA. — Shadow-mode S2.6: replay das últimas N vendas AUTORIZADAS
// do cliente-âncora (Davi) contra o motor próprio.
//
// Modos:
//   (default)    monta+assina localmente e DIFFA o XML próprio contra o
//                XML autorizado do gateway (baixado de xml_url). Nada é
//                transmitido — teste de regressão barato e brutal.
//   --transmit   além do diff, emite de verdade em HOMOLOGAÇÃO própria
//                (tpAmb=2) usando a empresa-alvo (CNPJ/cert de teste) e
//                mede a taxa de autorização (critério: 50/50).
//
// Uso:
//   node scripts/shadow-replay.js --source <uuid Davi> --target <uuid teste> \
//        [--limit 50] [--transmit]
//
// O diff ignora o que DEVE divergir (chave/cNF/dhEmi/número/emitente/QR);
// divergência real aparece como "DIFF" com campo a campo.
// ============================================================
'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const https = require('https');

const sefazSp = require('../src/services/sefazSp');
const { buildInfNfe, composeNfe } = require('../src/services/sefazSp/xmlBuilder');
const { signInfNfe } = require('../src/services/sefazSp/signer');
const { openPfx } = require('../src/services/sefazSp/pfx');
const { loadCertificate } = require('../src/services/sefazSp/certStore');
const { diffNotas } = require('../src/services/sefazSp/shadowDiff');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

// Mesmo mapa da rota (routes/nfce.js paymentCode)
function paymentCode(method) {
  const map = {
    dinheiro: '01', cheque: '02', credito: '03', debito: '04',
    cartao: '03', boleto: '15', pix: '17', crediario: '05', outros: '99',
  };
  return map[method] || '01';
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} em ${url}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

function rebuildPayload(emission, ncmByProductId) {
  const items = (typeof emission.items === 'string' ? JSON.parse(emission.items) : emission.items) || [];
  const nfItems = items.map((i) => ({
    code: String(i.product_id || i.code || ''),
    name: i.product_name || i.name || '',
    ncm: (i.ncm && String(i.ncm).trim() !== '00000000' ? String(i.ncm).trim() : null)
      || ncmByProductId.get(i.product_id) || '00000000',
    cfop: i.cfop || '5102',
    unit: i.unit || 'UN',
    quantity: Number(i.quantity || 1),
    price: Number(i.unit_price || i.price || 0),
    discount: Number(i.discount) || 0,
    barcode: i.barcode || undefined,
  }));

  let payments;
  try {
    const parsed = typeof emission.payment_method === 'string' && emission.payment_method.startsWith('[')
      ? JSON.parse(emission.payment_method) : null;
    if (Array.isArray(parsed)) {
      payments = parsed.map((p) => ({
        method: paymentCode(p.method), value: Number(p.value), change: p.change,
        indPag: p.indPag !== undefined ? p.indPag : ((p.method || '').toLowerCase() === 'crediario' ? 1 : 0),
      }));
    }
  } catch {}
  if (!payments) {
    payments = [{ method: paymentCode(emission.payment_method), value: Number(emission.total_nfce) }];
  }

  return {
    items: nfItems,
    payments,
    total_value: Number(emission.total_nfce),
    serie: emission.serie,
    numero: emission.numero, // no diff local o número não importa; no transmit é re-reservado
    recipient_cpf: emission.customer_cpf || undefined,
    recipient_name: emission.customer_name || undefined,
  };
}

async function main() {
  const sourceId = arg('source');
  const targetId = arg('target');
  const limit = parseInt(arg('limit', '50'), 10);
  const transmit = !!arg('transmit', false);
  if (!sourceId || sourceId === true || !targetId || targetId === true) {
    console.error('Uso: node scripts/shadow-replay.js --source <uuid> --target <uuid> [--limit 50] [--transmit]');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 1 });
  const db = { query: (...a) => pool.query(...a) };

  try {
    // empresa-alvo (teste) — emitente do shadow
    const { rows: targets } = await db.query(
      `SELECT id, cnpj, legal_name, trade_name,
              address_street, address_number, address_district AS address_neighborhood,
              address_city, address_state, address_zip,
              inscricao_estadual, ibge_code, email, phone, tax_regime
         FROM companies WHERE id=$1`, [targetId]);
    if (!targets.length) throw new Error('Empresa-alvo não encontrada');
    const target = targets[0];

    const { rows: cfgs } = await db.query('SELECT * FROM nfce_config WHERE company_id=$1', [targetId]);
    if (!cfgs.length) throw new Error('nfce_config da empresa-alvo não encontrada');
    const config = cfgs[0];
    if (transmit && config.ambiente !== 'homologacao') {
      throw new Error('--transmit exige empresa-alvo em ambiente=homologacao. Abortando.');
    }
    if (!target.inscricao_estadual && config.inscricao_estadual) {
      target.inscricao_estadual = config.inscricao_estadual;
    }

    // certificado da alvo (pro sign local e/ou transmissão)
    const { pfx, password } = await loadCertificate(db, targetId);
    const cert = openPfx(pfx, password);

    // últimas N autorizadas da fonte (com XML do gateway)
    const { rows: emissions } = await db.query(
      `SELECT * FROM nfce_emissions
        WHERE company_id=$1 AND status='autorizada' AND tipo='nfce' AND xml_url IS NOT NULL
        ORDER BY authorized_at DESC NULLS LAST LIMIT $2`,
      [sourceId, limit]);
    console.log(`Shadow-mode: ${emissions.length} notas autorizadas da fonte (pedido: ${limit})`);
    if (!emissions.length) return;

    // NCM real dos produtos da fonte
    const productIds = [...new Set(emissions.flatMap((e) => {
      const its = (typeof e.items === 'string' ? JSON.parse(e.items) : e.items) || [];
      return its.map((i) => i.product_id).filter((id) => typeof id === 'string' && id.length > 0);
    }))];
    const ncmByProductId = new Map();
    if (productIds.length) {
      const { rows: prods } = await db.query(
        `SELECT id, ncm FROM products WHERE id=ANY($1::uuid[]) AND company_id=$2`, [productIds, sourceId]);
      for (const p of prods) {
        const n = (p.ncm || '').trim();
        if (n && n !== '00000000') ncmByProductId.set(p.id, n);
      }
    }

    let ok = 0, comDiff = 0, falhas = 0, autorizadas = 0;
    const relatorio = [];

    for (const em of emissions) {
      const label = `#${em.numero} (${em.id.slice(0, 8)})`;
      try {
        const payload = rebuildPayload(em, ncmByProductId);

        // 1) monta + assina localmente (tpAmb=2, emitente = alvo)
        const built = buildInfNfe(target, payload, { tpAmb: 2, tpEmis: 1 });
        const { signatureXml } = signInfNfe(built.infNfeXml, {
          keyPem: cert.keyPem, certDerBase64: cert.certDerBase64,
        });
        const ownXml = composeNfe({ signedInfNfeXml: built.infNfeXml, signatureXml });

        // 2) diff contra o XML do gateway
        const gatewayXml = await fetchUrl(em.xml_url);
        const { igual, diffs } = diffNotas(ownXml, gatewayXml);
        if (igual) { ok++; console.log(`  OK    ${label}`); }
        else {
          comDiff++;
          console.log(`  DIFF  ${label}`);
          diffs.forEach((d) => console.log(`        · ${d}`));
          relatorio.push({ nota: label, diffs });
        }

        // 3) transmissão real em homolog (opcional)
        if (transmit) {
          const { rows: rsv } = await db.query(
            `UPDATE nfce_config SET next_number = next_number + 1, updated_at=NOW()
              WHERE company_id=$1 RETURNING (next_number - 1) AS numero`, [targetId]);
          const r = await sefazSp.emitNfce(target,
            { ...payload, serie: config.serie_nfce, numero: parseInt(rsv[0].numero, 10) },
            { db, config });
          if (r.status === 'autorizado') autorizadas++;
          else console.log(`        transmit: ${r.status} [${r.codigo_status}] ${r.motivo_status}`);
        }
      } catch (err) {
        falhas++;
        console.log(`  ERRO  ${label}: ${err.message}`);
      }
    }

    console.log('—'.repeat(60));
    console.log(`Diff estrutural: ${ok} idênticas · ${comDiff} com diff · ${falhas} erros`);
    if (transmit) console.log(`Transmissão homolog: ${autorizadas}/${emissions.length} autorizadas (critério: 50/50)`);
    if (relatorio.length) {
      console.log('\nDiffs a explicar (critério: todos explicados ou corrigidos):');
      for (const r of relatorio) console.log(`  ${r.nota}: ${r.diffs.length} divergência(s)`);
    }
    process.exitCode = falhas > 0 ? 2 : 0;
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error('SHADOW FALHOU:', err.message); process.exit(1); });
