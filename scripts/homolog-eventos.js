#!/usr/bin/env node
// ============================================================
// AURA. — S5: homologação dirigida de EVENTOS da NFC-e própria.
// CLI para exercitar cancelamento (110111), inutilização de faixa e
// consulta por chave contra a SEFAZ-SP de HOMOLOGAÇÃO (tpAmb=2).
//
// Mesmo padrão do emit-homolog-smoke: carrega company/config do banco e
// chama a engine (src/services/sefazSp). Só roda em ambiente=homologacao.
//
// Uso:
//   node scripts/homolog-eventos.js --action cancel --company <uuid> \
//        --chave <44díg> --protocolo <nProt> --justificativa "texto >=15 chars"
//   node scripts/homolog-eventos.js --action inutilizar --company <uuid> \
//        --serie 1 --ini 1 --fin 6 --ano 2026 --justificativa "texto >=15 chars"
//   node scripts/homolog-eventos.js --action consulta --company <uuid> --chave <44díg>
//
// Critérios de aceite: cancel→cStat 135; inutilizar→cStat 102;
// consulta de nota cancelada→cStat 101/135.
// ============================================================
'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const sefazSp = require('../src/services/sefazSp');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] || true) : null;
}

const SEP = '—'.repeat(60);

async function main() {
  const action = arg('action');
  const companyId = arg('company');
  if (!action || !companyId) {
    console.error('Uso: node scripts/homolog-eventos.js --action <cancel|inutilizar|consulta> --company <uuid> [...]');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 1 });
  const db = { query: (...a) => pool.query(...a) };

  try {
    const { rows: configs } = await db.query('SELECT * FROM nfce_config WHERE company_id=$1', [companyId]);
    if (!configs.length) throw new Error('nfce_config não encontrada pra empresa');
    const config = configs[0];
    if (config.ambiente !== 'homologacao') {
      throw new Error(`S5 só roda em homologação (ambiente atual: ${config.ambiente}). Abortando.`);
    }

    if (action === 'cancel') {
      const chave = arg('chave');
      const protocolo = arg('protocolo');
      const justificativa = arg('justificativa');
      if (!chave || !protocolo || !justificativa) {
        throw new Error('cancel exige --chave, --protocolo e --justificativa');
      }
      console.log(`Cancelando NFC-e (evento 110111) chave ${chave} prot ${protocolo}`);
      const t0 = Date.now();
      const ev = await sefazSp.cancelNfce({ db, config, companyId, chave, protocolo, justificativa });
      const ms = Date.now() - t0;
      console.log(SEP);
      console.log(`sucesso:        ${ev.sucesso}`);
      console.log(`cStat:          ${ev.cStat} (${ev.xMotivo || ''})`);
      console.log(`protocoloEvento:${ev.protocoloEvento || '—'}`);
      console.log(`dhRegEvento:    ${ev.dhRegEvento || '—'}`);
      console.log(`jaCancelada:    ${ev.jaCancelada}`);
      console.log(`latência:       ${ms}ms`);
      console.log(SEP);
      // Espelha a rota: se houver row da emissão, marca cancelada.
      const { rows: own } = await db.query(
        `SELECT id, status FROM nfce_emissions WHERE company_id=$1 AND chave_acesso=$2`, [companyId, chave]);
      if (own.length && ev.sucesso) {
        await db.query(
          `UPDATE nfce_emissions SET status='cancelada', cancel_reason=$1, cancelled_at=NOW() WHERE id=$2`,
          [justificativa, own[0].id]);
        console.log(`Persistido: emission ${own[0].id.slice(0, 8)} → status='cancelada'`);
      } else if (!own.length) {
        console.log('Sem row de emissão pra essa chave (smoke não persiste) — só reporte do evento.');
      }
      process.exitCode = ev.sucesso ? 0 : 2;

    } else if (action === 'inutilizar') {
      const justificativa = arg('justificativa');
      const nIni = parseInt(arg('ini'), 10);
      const nFin = parseInt(arg('fin'), 10);
      const serie = arg('serie') ? parseInt(arg('serie'), 10) : config.serie_nfce;
      const ano2 = arg('ano') ? String(arg('ano')).slice(-2) : undefined;
      if (!justificativa || !Number.isInteger(nIni) || !Number.isInteger(nFin)) {
        throw new Error('inutilizar exige --ini, --fin e --justificativa');
      }
      const { rows: comp } = await db.query('SELECT cnpj FROM companies WHERE id=$1', [companyId]);
      if (!comp.length || !comp[0].cnpj) throw new Error('CNPJ da empresa não cadastrado');
      console.log(`Inutilizando série ${serie} faixa ${nIni}-${nFin} (ano ${ano2 || '(atual)'})`);
      const t0 = Date.now();
      const r = await sefazSp.inutilizarFaixa({
        db, config, companyId, cnpj: comp[0].cnpj, serie, nIni, nFin, justificativa, ano2,
      });
      const ms = Date.now() - t0;
      console.log(SEP);
      console.log(`sucesso:   ${r.sucesso}`);
      console.log(`cStat:     ${r.cStat} (${r.xMotivo || ''})`);
      console.log(`protocolo: ${r.protocolo || '—'}`);
      console.log(`latência:  ${ms}ms`);
      console.log(SEP);
      process.exitCode = r.sucesso ? 0 : 2;

    } else if (action === 'consulta') {
      const chave = arg('chave');
      if (!chave) throw new Error('consulta exige --chave');
      console.log(`Consultando situação da chave ${chave}`);
      const t0 = Date.now();
      const r = await sefazSp.queryNfce({ chave, config, db, companyId });
      const ms = Date.now() - t0;
      console.log(SEP);
      console.log(`status:    ${r.status}`);
      console.log(`cStat:     ${r.codigo_status} (${r.motivo_status || ''})`);
      console.log(`protocolo: ${r.protocolo || '—'}`);
      console.log(`latência:  ${ms}ms`);
      console.log(SEP);

    } else {
      throw new Error(`ação desconhecida: ${action}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error('S5 FALHOU:', err.message); process.exit(1); });
