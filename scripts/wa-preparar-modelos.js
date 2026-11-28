#!/usr/bin/env node
// ============================================================
// AURA — prepara os modelos-base do WhatsApp das lojas JÁ conectadas
// (uma vez só; as novas conexões já fazem isso sozinhas).
//
//   node scripts/wa-preparar-modelos.js              ENSAIO (padrão): lista as
//                                                    lojas conectadas e o estado
//                                                    dos modelos. Não chama a Meta.
//   node scripts/wa-preparar-modelos.js --executar   cria na Meta os modelos que
//                                                    faltam (prepararPadroes).
//
// Idempotente: só cria o que ainda não tem linha em wa_templates.
// Criar modelo não gasta saldo e não passa pela wa_outbox.
// Nunca imprime token; telefone só com os 4 últimos dígitos.
// Precisa de SUPABASE_DB_URL (railway run).
// ============================================================
'use strict';

const executar = process.argv.includes('--executar');

function mascarar(tel) {
  const d = String(tel || '').replace(/\D/g, '');
  return d.length >= 4 ? `***${d.slice(-4)}` : '-';
}

async function main() {
  const db = require('../src/config/database');
  const store = require('../src/services/waAutomaticas/modelosStore');

  const { rows } = await db.query(
    `SELECT id, COALESCE(trade_name, legal_name) AS nome, wa_phone_display, wa_connected_at
       FROM companies
      WHERE wa_waba_id IS NOT NULL AND wa_access_token IS NOT NULL
      ORDER BY wa_connected_at NULLS LAST`
  );
  console.log(`Modo: ${executar ? 'EXECUTAR' : 'ENSAIO (nada é enviado à Meta)'}`);
  console.log(`Lojas conectadas: ${rows.length}`);

  for (const c of rows) {
    const lista = await store.listar(c.id);
    const porEstado = {};
    for (const m of lista) porEstado[m.estado] = (porEstado[m.estado] || 0) + 1;
    const faltando = (await store.empresasComPadroesFaltando(1000)).includes(c.id);
    console.log(`- ${c.id} | ${c.nome || '-'} | tel ${mascarar(c.wa_phone_display)} | modelos: ${lista.length} | estados: ${JSON.stringify(porEstado)} | faltam criar na Meta: ${faltando ? 'sim' : 'não'}`);
    if (executar) {
      const r = await store.prepararPadroesSeguro(c.id, { origem: 'script' });
      console.log(r.ok ? `    criados=${r.criados} ja_existiam=${r.ja_existiam}` : `    FALHOU (${r.erro || 'pulado'}) — veja o log acima`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('Erro:', String((e && e.message) || e).slice(0, 200)); process.exit(1); });
