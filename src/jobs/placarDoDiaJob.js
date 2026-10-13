// ============================================================
// AURA. — Placar do dia: job das 21h BRT (13/10/2026)
//
// Cobre a loja que NAO fecha caixa. Quem fecha e atendido na hora pelo gancho
// de services/caixaService.fechar; o job passa depois e nao repete: o
// enfileiramento tem dedupe_key por loja e dia (services/placarDoDia).
//
// Duas passadas por dia, por processo:
//   21h  loja com caixa ABERTO e esperada: o fechamento dispara o placar com
//        o dia completo. Todas as outras recebem agora.
//   23h  quem ainda nao recebeu recebe, caixa aberto ou nao — um caixa
//        esquecido aberto nao pode apagar o placar do dia.
//
// So considera lojas com o placar ligado; a regra de temporada (e do campo
// `sempre`) e de services/placarDoDia.ativoNoDia. Padrao dos outros jobs:
// tick por minuto, marca em memoria antes de disparar. Kill switch:
// PLACAR_DO_DIA_ENABLED=false.
// ============================================================
'use strict';

const db = require('../config/database');
const placar = require('../services/placarDoDia');

const HORA_NOITE_BRT = 21;
const HORA_TARDE_BRT = 23;

function nowBRT() {
  return new Date(Date.now() - 3 * 3600000);
}

function schemaAusente(e) {
  return !!e && (e.code === '42P01' || e.code === '42703');
}

// Lojas com o placar ligado. 42703 (377 pendente) → nenhuma.
async function lojasLigadas(banco = db) {
  try {
    const { rows } = await banco.query(
      `-- placar:lojas-ligadas
       SELECT id FROM companies
        WHERE placar_do_dia_enabled = true AND COALESCE(is_active, true) = true
        ORDER BY id`
    );
    return rows.map((r) => r.id);
  } catch (e) {
    if (schemaAusente(e)) return [];
    throw e;
  }
}

async function caixaAberto(companyId, banco = db) {
  try {
    const { rows } = await banco.query(
      `-- placar:caixa-aberto
       SELECT 1 FROM caixa_sessoes WHERE company_id = $1 AND status = 'aberta' LIMIT 1`,
      [companyId]
    );
    return rows.length > 0;
  } catch (e) {
    if (schemaAusente(e)) return false;
    throw e;
  }
}

// Uma passada. `esperarFechamento`: pula a loja com caixa aberto.
async function rodarDoDia(dia, { esperarFechamento = true } = {}, deps = {}) {
  const banco = deps.db || db;
  const enviar = deps.enviarPlacar || placar.enviarPlacar;
  const out = { dia, lojas: 0, enviados: 0, aguardando: 0, pulados: 0, erros: 0 };

  for (const id of await lojasLigadas(banco)) {
    out.lojas++;
    try {
      if (esperarFechamento && await caixaAberto(id, banco)) { out.aguardando++; continue; }
      const r = await enviar(id, { dia, origem: 'job' }, deps);
      if (r && r.sent) out.enviados++; else out.pulados++;
    } catch (e) {
      out.erros++;
      console.error('[placarDoDia] job', id, e && e.message);
    }
  }
  return out;
}

const _feitas = new Set();

function tick(deps = {}) {
  if (process.env.PLACAR_DO_DIA_ENABLED === 'false') return null;
  const now = deps.now || nowBRT();
  const dia = now.toISOString().slice(0, 10);
  const hora = now.getUTCHours();
  const fase = hora >= HORA_TARDE_BRT ? 'tarde' : hora >= HORA_NOITE_BRT ? 'noite' : null;
  if (!fase) return null;

  const marca = `${dia}:${fase}`;
  if (_feitas.has(marca)) return null;
  // Guarda so o que importa: o dia corrente.
  for (const m of [..._feitas]) if (!m.startsWith(dia)) _feitas.delete(m);
  _feitas.add(marca);

  return rodarDoDia(dia, { esperarFechamento: fase === 'noite' }, deps)
    .then((r) => {
      console.log(`[placarDoDia] ${dia} (${fase}): ${r.enviados} enviados, ${r.aguardando} aguardando caixa, ${r.pulados} sem envio, ${r.erros} erros em ${r.lojas} lojas`);
      return r;
    })
    .catch((e) => {
      // Falha antes de varrer as lojas: libera a passada para o proximo tick.
      _feitas.delete(marca);
      console.error('[placarDoDia] job crash:', e && e.message);
      return null;
    });
}

let _interval = null;

function initPlacarDoDiaJob() {
  if (_interval) return;
  _interval = setInterval(tick, 60 * 1000);
  console.log('[placarDoDia] agendador iniciado — placar do dia no WhatsApp do dono, 21h BRT (23h para caixa esquecido aberto)');
}

function stopPlacarDoDiaJob() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

function _resetForTests() { _feitas.clear(); }

module.exports = {
  HORA_NOITE_BRT,
  HORA_TARDE_BRT,
  lojasLigadas,
  caixaAberto,
  rodarDoDia,
  tick,
  initPlacarDoDiaJob,
  stopPlacarDoDiaJob,
  _resetForTests,
};
