#!/usr/bin/env node
// ============================================================
// AURA. — Smoke S1.6: emite UMA NFC-e real em HOMOLOGAÇÃO (tpAmb=2)
// 100% pela emissão própria (sefazSp), por CLI.
//
// Pré-requisitos (Fase 0):
//   - CERT_MASTER_KEY no env (64 hex)
//   - SUPABASE_DB_URL no env
//   - Certificado A1 salvo (company_certificates) — use --save-cert
//   - nfce_config da empresa: csc_id + csc_token(_enc), ambiente=homologacao
//
// Uso:
//   node scripts/emit-homolog-smoke.js --company <uuid> --status-only
//   node scripts/emit-homolog-smoke.js --company <uuid> --save-cert /caminho/cert.pfx
//       (senha solicitada via prompt oculto; o .pfx NÃO fica em disco do servidor)
//   node scripts/emit-homolog-smoke.js --company <uuid> [--cpf 39053344705]
//
// Critério de aceite S1: cStat 100, QR válido no validador do portal,
// numeração não vaza em erro (número só é consumido se autorizada).
// ============================================================
'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const readline = require('readline');

const sefazSp = require('../src/services/sefazSp');
const { saveCertificate } = require('../src/services/sefazSp/certStore');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] || true) : null;
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (char) => {
      if (!['\n', '\r', ''].includes(String(char))) {
        readline.moveCursor(process.stdout, -1, 0);
        process.stdout.write('*');
      }
    };
    process.stdin.on('data', onData);
    rl.question(question, (answer) => {
      process.stdin.removeListener('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const companyId = arg('company');
  if (!companyId) {
    console.error('Uso: node scripts/emit-homolog-smoke.js --company <uuid> [--status-only|--save-cert <pfx>] [--cpf <cpf>]');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 1 });
  const db = { query: (...a) => pool.query(...a) };

  try {
    // --save-cert: valida e armazena o A1 cifrado (senha via prompt oculto)
    const pfxPath = arg('save-cert');
    if (pfxPath && pfxPath !== true) {
      const fs = require('fs');
      const pfxBuffer = fs.readFileSync(pfxPath); // máquina do operador, não do servidor
      const password = await askHidden('Senha do .pfx: ');
      const meta = await saveCertificate(db, companyId, pfxBuffer, password);
      console.log('Certificado salvo (cifrado).');
      console.log(`  CN: ${meta.subject_cn}`);
      console.log(`  Validade: ${meta.not_before?.toISOString().slice(0,10)} → ${meta.not_after?.toISOString().slice(0,10)}`);
      return;
    }

    const { rows: configs } = await db.query('SELECT * FROM nfce_config WHERE company_id=$1', [companyId]);
    if (!configs.length) throw new Error('nfce_config não encontrada pra empresa');
    const config = configs[0];
    if (config.ambiente !== 'homologacao') {
      throw new Error(`SMOKE só roda em homologação (ambiente atual: ${config.ambiente}). Abortando.`);
    }

    // 1) Status do serviço
    const st = await sefazSp.statusServico({ config, db, companyId });
    console.log(`StatusServico4: cStat=${st.cStat} (${st.xMotivo}) online=${st.online} tMed=${st.tMed}s`);
    if (arg('status-only')) return;
    if (!st.online) throw new Error('SEFAZ-SP homologação fora de operação — smoke abortado.');

    // 2) Empresa + produto real (mesmo SELECT da rota)
    const { rows: companies } = await db.query(
      `SELECT id, cnpj, legal_name, trade_name,
              address_street, address_number, address_district AS address_neighborhood,
              address_city, address_state, address_zip,
              inscricao_estadual, inscricao_municipal, ibge_code, email, phone, tax_regime
         FROM companies WHERE id=$1`, [companyId]);
    if (!companies.length) throw new Error('Empresa não encontrada');
    const company = companies[0];
    if (!company.inscricao_estadual && config.inscricao_estadual) {
      company.inscricao_estadual = config.inscricao_estadual;
    }

    const { rows: prods } = await db.query(
      `SELECT id, name, ncm, price FROM products
        WHERE company_id=$1 AND ncm IS NOT NULL AND ncm <> '00000000' AND price > 0
        ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [companyId]);
    if (!prods.length) throw new Error('Nenhum produto com NCM válido pra usar no smoke');
    const prod = prods[0];

    // 3) Reserva ATÔMICA do número (mesma regra da rota — não vaza em erro
    //    porque retransmissão reusa; gap só se abandonarmos a nota)
    const { rows: rsv } = await db.query(
      `UPDATE nfce_config SET next_number = next_number + 1, updated_at=NOW()
        WHERE company_id=$1 RETURNING (next_number - 1) AS numero`, [companyId]);
    const numero = parseInt(rsv[0].numero, 10);
    const price = Number(prod.price);

    console.log(`Emitindo NFC-e homolog: nº ${numero} série ${config.serie_nfce} — "${prod.name}" R$ ${price.toFixed(2)}`);

    const nfceData = {
      items: [{ product_id: prod.id, code: prod.id, name: prod.name, ncm: prod.ncm,
                cfop: '5102', unit: 'UN', quantity: 1, price }],
      payments: [{ method: '01', value: price }],
      total_value: price,
      serie: config.serie_nfce, numero,
      recipient_cpf: arg('cpf') || undefined,
      observacoes: 'SMOKE TEST S1.6 - emissao propria Aura',
    };

    const t0 = Date.now();
    const result = await sefazSp.emitNfce(company, nfceData, { db, config });
    const ms = Date.now() - t0;

    console.log('—'.repeat(60));
    console.log(`status:    ${result.status} (cStat ${result.codigo_status} — ${result.motivo_status})`);
    console.log(`chave:     ${result.chave_acesso}`);
    console.log(`protocolo: ${result.protocolo}`);
    console.log(`latência:  ${ms}ms`);
    console.log(`QR (validar no portal de homolog SP):`);
    console.log(`  ${result.qr_code}`);
    console.log('—'.repeat(60));
    if (result.status !== 'autorizado') process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('SMOKE FALHOU:', err.message);
  process.exit(1);
});
