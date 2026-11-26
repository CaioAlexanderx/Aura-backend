// ============================================================
// AURA — WhatsApp: as 4 AUTOMÁTICAS (config, divisão das novidades, prévia)
// Tela nova do WhatsApp, 26/11/2026. Contrato: contrato-automaticas.md.
//
//   aniversario       novidades (parte "aniversario")
//   venda_mais        novidades (parte "venda_mais"): substitui a Reativação
//   crediario_vender  novidades (parte "crediario"): oferta p/ quem tem limite
//   crediario_cobrar  AVISOS: parcelas (antes, no dia, atraso)
//
// As novidades do mês vêm divididas 4/4/2. O servidor recusa salvar uma
// divisão cuja soma passe do saldo de novidades do mês. O saldo em si
// (franquia, pacotes, reserva) é do waSaldo: aqui só se LÊ o total.
// ============================================================
'use strict';

const db = require('../../config/database');
const mkt = require('../marketing/marketingCommon');
const modelosStore = require('./modelosStore');
const publico = require('./publico');

const KEYS = Object.freeze(['aniversario', 'venda_mais', 'crediario_cobrar', 'crediario_vender']);
const USA = Object.freeze({ aniversario: 'novidades', venda_mais: 'novidades', crediario_vender: 'novidades', crediario_cobrar: 'avisos' });
const PARTE = Object.freeze({ aniversario: 'aniversario', venda_mais: 'venda_mais', crediario_vender: 'crediario' });
const PARTES = Object.freeze(['aniversario', 'venda_mais', 'crediario']);
const DIVISAO_PADRAO = Object.freeze({ aniversario: 4, venda_mais: 4, crediario: 2 });
// Origem gravada na wa_outbox por parte (é daí que sai o "usadas" do mês).
const ORIGEM_DA_PARTE = Object.freeze({ aniversario: 'aniversario', venda_mais: 'venda_mais', crediario: 'crediario_oferta' });
// Aniversário: quantos dias do aniversário cada passo cai. "Antes" são 8
// dias (não 7) para clarear a janela de 7 dias entre novidades do mesmo cliente.
const DESLOCAMENTO_PASSO = Object.freeze({ antes: 8, dia: 0, depois: -3 });
const DESLOCAMENTO_COBRANCA = Object.freeze({ antes3: 3, dia: 0, depois1: -1, depois7: -7, depois15: -15 });

class ErroAuto extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status; this.code = code; this.extra = extra;
  }
}

function schemaMissing(e) { return !!e && (e.code === '42P01' || e.code === '42703'); }

// ── Configuração ─────────────────────────────────────────────
function configPadrao(key) {
  switch (key) {
    case 'aniversario':
      return { tom: 'carinhoso', presente: { tipo: 'percent', valor: 10 }, passos: { antes: false, dia: true, depois: false } };
    case 'venda_mais':
      return { segmento: 'sumindo', presente: { tipo: 'fixed', valor: 20 }, automatico: false };
    case 'crediario_cobrar':
      return { pontos: { antes3: true, dia: true, depois1: true, depois7: false, depois15: false } };
    case 'crediario_vender':
      return { dia_do_mes: 10, presente: null };
    default: return {};
  }
}

function invalida(campo, msg) {
  return new ErroAuto(422, 'CONFIG_INVALIDA', msg, { campo });
}

function normalizarPresente(p, campo) {
  if (p === null) return null;
  if (!p || typeof p !== 'object') throw invalida(campo, 'Escolha o presente ou "sem presente".');
  if (!['percent', 'fixed'].includes(p.tipo)) throw invalida(campo, 'O presente é em % ou em reais.');
  const valor = Number(p.valor);
  if (!Number.isFinite(valor) || valor <= 0) throw invalida(campo, 'O valor do presente precisa ser maior que zero.');
  if (p.tipo === 'percent' && valor > 100) throw invalida(campo, 'O desconto não pode passar de 100%.');
  if (valor > 100000) throw invalida(campo, 'O valor do presente está alto demais.');
  return { tipo: p.tipo, valor };
}

/** Junta o que a lojista mandou com o que já estava e valida. */
function normalizarConfig(key, atual, parcial) {
  const base = { ...configPadrao(key), ...(atual || {}) };
  const novo = { ...base, ...(parcial || {}) };
  if (key === 'aniversario') {
    if (!['carinhoso', 'direto', 'animado'].includes(novo.tom)) throw invalida('tom', 'Escolha um jeito de falar: carinhoso, direto ou animado.');
    novo.presente = normalizarPresente(novo.presente === undefined ? null : novo.presente, 'presente');
    const passos = { ...base.passos, ...((parcial && parcial.passos) || {}) };
    for (const k of ['antes', 'dia', 'depois']) passos[k] = passos[k] === true;
    if (!passos.antes && !passos.dia && !passos.depois) throw invalida('passos', 'Escolha pelo menos um momento para mandar.');
    // Antes e depois levam o presente; sem presente só há o parabéns do dia.
    if (!novo.presente && (passos.antes || passos.depois)) throw invalida('passos', 'Sem presente, só o parabéns do dia faz sentido.');
    novo.passos = passos;
  } else if (key === 'venda_mais') {
    if (!Object.prototype.hasOwnProperty.call(publico.SEGMENTOS_VENDA_MAIS, novo.segmento)) throw invalida('segmento', 'Escolha "sumindo" ou "sumiu".');
    novo.presente = normalizarPresente(novo.presente === undefined ? null : novo.presente, 'presente');
    novo.automatico = novo.automatico === true;
  } else if (key === 'crediario_cobrar') {
    const pontos = { ...base.pontos, ...((parcial && parcial.pontos) || {}) };
    for (const k of Object.keys(DESLOCAMENTO_COBRANCA)) pontos[k] = pontos[k] === true;
    if (!Object.values(pontos).some(Boolean)) throw invalida('pontos', 'Escolha pelo menos um momento para avisar.');
    novo.pontos = pontos;
  } else if (key === 'crediario_vender') {
    const d = Number(novo.dia_do_mes);
    if (!Number.isInteger(d) || d < 1 || d > 28) throw invalida('dia_do_mes', 'Escolha um dia do mês entre 1 e 28.');
    novo.dia_do_mes = d;
    novo.presente = normalizarPresente(novo.presente === undefined ? null : novo.presente, 'presente');
  }
  return novo;
}

// Quais modelos a configuração usa (para conferir se estão aprovados).
function modelosDaConfig(key, config) {
  const c = config || configPadrao(key);
  if (key === 'aniversario') {
    const sufixo = c.presente ? 'com' : 'sem';
    const out = [];
    if (c.passos.dia) out.push(`aniv_${c.tom}_${sufixo}`);
    if (c.presente && c.passos.antes) out.push('aniv_antes');
    if (c.presente && c.passos.depois) out.push('aniv_depois');
    return out;
  }
  if (key === 'venda_mais') return [`venda_${c.segmento}_${c.presente ? 'com' : 'sem'}`];
  if (key === 'crediario_vender') return ['cred_oferta'];
  const p = c.pontos || {};
  const out = [];
  if (p.antes3) out.push('cred_antes');
  if (p.dia) out.push('cred_dia');
  if (p.depois1 || p.depois7 || p.depois15) out.push('cred_atraso');
  return out;
}

// ── Banco ────────────────────────────────────────────────────
async function lerLinhas(companyId) {
  try {
    const { rows } = await db.query(
      `-- wa:auto-linhas
       SELECT automatica, ligada, config, ligada_em, ultima_rodada_em
         FROM wa_automaticas WHERE company_id = $1`,
      [companyId]
    );
    return new Map(rows.map((r) => [r.automatica, r]));
  } catch (e) { if (schemaMissing(e)) return new Map(); throw e; }
}

async function lerDivisao(companyId) {
  try {
    const { rows } = await db.query(
      `-- wa:auto-divisao
       SELECT aniversario, venda_mais, crediario FROM wa_novidades_divisao WHERE company_id = $1`,
      [companyId]
    );
    return rows[0] ? { aniversario: rows[0].aniversario, venda_mais: rows[0].venda_mais, crediario: rows[0].crediario } : { ...DIVISAO_PADRAO };
  } catch (e) { if (schemaMissing(e)) return { ...DIVISAO_PADRAO }; throw e; }
}

async function usadasNoMes(companyId) {
  const out = { aniversario: 0, venda_mais: 0, crediario: 0 };
  try {
    const { rows } = await db.query(
      `-- wa:auto-usadas
       SELECT source_type, COUNT(*)::int AS n FROM wa_outbox
        WHERE company_id = $1 AND source_type = ANY($2::text[])
          AND status NOT IN ('skipped','failed')
          AND date_trunc('month', created_at AT TIME ZONE 'America/Sao_Paulo')
            = date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')
        GROUP BY source_type`,
      [companyId, Object.values(ORIGEM_DA_PARTE)]
    );
    for (const parte of PARTES) {
      const r = rows.find((x) => x.source_type === ORIGEM_DA_PARTE[parte]);
      out[parte] = r ? Number(r.n) : 0;
    }
  } catch (e) { if (!schemaMissing(e)) throw e; }
  return out;
}

// Saldo de novidades do mês (waSaldo, agente A). Na dúvida, bloqueia.
async function saldoDeNovidades(companyId) {
  let waSaldo;
  try { waSaldo = require('../waSaldo'); } catch (_) {
    throw new ErroAuto(503, 'SALDO_INDISPONIVEL', 'Não consegui conferir o saldo de novidades agora. Tente de novo em instantes.');
  }
  try {
    const s = await waSaldo.getSaldos(companyId);
    const n = s.saldos.novidades;
    return { total: Number(n.total), restante: Number(n.restante), mes: s.mes, bloqueado_por: n.bloqueado_por || null };
  } catch (_) {
    throw new ErroAuto(503, 'SALDO_INDISPONIVEL', 'Não consegui conferir o saldo de novidades agora. Tente de novo em instantes.');
  }
}

function blocoNovidades(saldo, divisao, usadas) {
  const soma = PARTES.reduce((s, p) => s + divisao[p], 0);
  return {
    total: saldo.total,
    livres: saldo.restante,
    divisao: { ...divisao },
    usadas: { ...usadas },
    sem_dono: Math.max(0, saldo.total - soma),
  };
}

function livresDaParte(divisao, usadas, parte) {
  return Math.max(0, divisao[parte] - usadas[parte]);
}

// ── Leitura para a tela ──────────────────────────────────────
async function listar(companyId) {
  const [linhas, divisao, usadas, saldo, settings] = await Promise.all([
    lerLinhas(companyId), lerDivisao(companyId), usadasNoMes(companyId),
    saldoDeNovidades(companyId), mkt.loadMarketingSettings(companyId),
  ]);
  const automaticas = KEYS.map((key) => {
    const l = linhas.get(key);
    const item = {
      key,
      ligada: !!(l && l.ligada),
      usa: USA[key],
      config: { ...configPadrao(key), ...((l && l.config) || {}) },
    };
    if (PARTE[key]) {
      item.parte = PARTE[key];
      item.livres = livresDaParte(divisao, usadas, PARTE[key]);
    }
    return item;
  });
  return {
    mes: saldo.mes,
    aceite_novidades_em: settings.wa_marketing_consent_at,
    novidades: blocoNovidades(saldo, divisao, usadas),
    automaticas,
  };
}

// ── Divisão ──────────────────────────────────────────────────
async function definirDivisao(companyId, body) {
  const nova = {};
  for (const p of PARTES) {
    const n = Number(body && body[p]);
    if (!Number.isInteger(n) || n < 0) {
      throw new ErroAuto(422, 'CONFIG_INVALIDA', 'Cada parte precisa ser um número inteiro, zero ou mais.', { campo: p });
    }
    nova[p] = n;
  }
  const [saldo, usadas] = await Promise.all([saldoDeNovidades(companyId), usadasNoMes(companyId)]);
  const soma = PARTES.reduce((s, p) => s + nova[p], 0);
  if (soma > saldo.total) {
    throw new ErroAuto(422, 'DIVISAO_ACIMA_DO_SALDO',
      `A soma (${soma}) passa das ${saldo.total} novidades do mês. Para dar mais a uma, tire de outra.`,
      { total: saldo.total, soma, sobra: saldo.total - soma });
  }
  for (const p of PARTES) {
    if (nova[p] < usadas[p]) {
      throw new ErroAuto(422, 'DIVISAO_ABAIXO_DO_USADO',
        `Essa parte já usou ${usadas[p]} neste mês: não dá para deixar com ${nova[p]}.`, { parte: p, usadas: usadas[p] });
    }
  }
  await db.query(
    `-- wa:auto-divisao-set
     INSERT INTO wa_novidades_divisao (company_id, aniversario, venda_mais, crediario, updated_at)
     VALUES ($1,$2,$3,$4,NOW())
     ON CONFLICT (company_id) DO UPDATE SET
       aniversario = EXCLUDED.aniversario, venda_mais = EXCLUDED.venda_mais,
       crediario = EXCLUDED.crediario, updated_at = NOW()`,
    [companyId, nova.aniversario, nova.venda_mais, nova.crediario]
  );
  return blocoNovidades(saldo, nova, usadas);
}

// ── Ligar / desligar ─────────────────────────────────────────
async function ligar(companyId, key, body = {}) {
  if (!KEYS.includes(key)) throw new ErroAuto(404, 'AUTOMATICA_DESCONHECIDA', 'Essa automática não existe.');
  const linhas = await lerLinhas(companyId);
  const atual = linhas.get(key);
  const config = normalizarConfig(key, atual && atual.config, body.config);
  const ligada = body.ligada === undefined ? !!(atual && atual.ligada) : body.ligada === true;

  if (ligada) {
    // Primeira automática de novidade: pergunta o aceite dos clientes uma vez.
    if (USA[key] === 'novidades') {
      const settings = await mkt.loadMarketingSettings(companyId);
      if (!settings.wa_marketing_consent_at) {
        if (body.aceite_novidades !== true) {
          throw new ErroAuto(409, 'SEM_ACEITE_NOVIDADES', 'Seus clientes aceitaram receber novidades da loja pelo WhatsApp?');
        }
        if (!(await mkt.setMarketingConsent(companyId, true))) {
          throw new ErroAuto(503, 'SCHEMA_PENDING', 'Esta função ainda está sendo preparada.');
        }
      }
    }
    const modelos = await modelosStore.listar(companyId);
    const faltam = modelosDaConfig(key, config)
      .map((k) => modelos.find((m) => m.key === k))
      .filter((m) => m && m.estado === 'AGUARDANDO_PADRAO')
      .map((m) => ({ key: m.key, estado: m.estado }));
    if (faltam.length) {
      throw new ErroAuto(409, 'MODELO_NAO_APROVADO',
        'O WhatsApp ainda não aprovou a mensagem desta automática. Ela liga assim que for aprovada.', { modelos: faltam });
    }
    if (USA[key] === 'novidades') await saldoDeNovidades(companyId); // na dúvida, bloqueia
  }

  await db.query(
    `-- wa:auto-set
     INSERT INTO wa_automaticas (company_id, automatica, ligada, config, ligada_em, updated_at)
     VALUES ($1,$2,$3,$4::jsonb, CASE WHEN $3 THEN NOW() END, NOW())
     ON CONFLICT (company_id, automatica) DO UPDATE SET
       ligada = EXCLUDED.ligada, config = EXCLUDED.config, updated_at = NOW(),
       ligada_em = CASE WHEN EXCLUDED.ligada AND NOT wa_automaticas.ligada THEN NOW()
                        WHEN NOT EXCLUDED.ligada THEN NULL ELSE wa_automaticas.ligada_em END`,
    [companyId, key, ligada, JSON.stringify(config)]
  );
  const lista = await listar(companyId);
  return { ...lista.automaticas.find((a) => a.key === key), aceite_novidades_em: lista.aceite_novidades_em };
}

module.exports = {
  KEYS, USA, PARTE, PARTES, DIVISAO_PADRAO, ORIGEM_DA_PARTE, DESLOCAMENTO_PASSO, DESLOCAMENTO_COBRANCA,
  ErroAuto, configPadrao, normalizarConfig, modelosDaConfig,
  lerLinhas, lerDivisao, usadasNoMes, saldoDeNovidades, livresDaParte, blocoNovidades,
  listar, definirDivisao, ligar,
};
