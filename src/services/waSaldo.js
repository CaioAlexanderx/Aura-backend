// ============================================================
// AURA — SALDO DO WHATSAPP (tela nova, 26/11/2026)
//
// Tres saldos com limite RIGIDO. Cada mensagem que custa dinheiro sai de
// um deles; sem saldo, nada entra na fila:
//
//   novidades  MARKETING  Aniversario, Venda+ e oferta do Crediario
//   avisos     UTILITY    parcelas do crediario e convites de conversa fechada
//   aurinha               cada conversa que a Aurinha atende
//
// O saldo e a soma do livro-razao wa_saldo_lancamentos (migration 472).
// De onde sai cada mensagem, nesta ordem: franquia do mes (renova e
// vence na virada), presente de boas-vindas (Essencial, uma vez so) e
// pacote comprado (nao vence).
//
// `reservar` roda DENTRO da transacao do INSERT na wa_outbox, sob um
// advisory lock por (empresa, saldo): duas reservas ao mesmo tempo nunca
// gastam a mesma mensagem. Sem saldo, ou na duvida (erro ao ler, campo
// ausente), BLOQUEIA — a mesma regra do waGuards.
//
// Este modulo depende SO do banco (o waOutbox depende dele; ciclo nao).
// Trava: sem WA_SALDO_ATIVO ligado, `reservar` nao barra nada e as
// guardas antigas seguem valendo; a LEITURA do saldo funciona sempre.
// ============================================================
'use strict';

const db = require('../config/database');

const BUCKETS = ['novidades', 'avisos', 'aurinha'];
const FUSO = 'America/Sao_Paulo';

// Franquia que RENOVA todo mes: Negocio e Essencial com o add-on.
const FRANQUIA_MENSAL = { novidades: 10, avisos: 100, aurinha: 80 };
// Presente do Essencial sem add-on: uma vez so, nao renova.
const BOAS_VINDAS = { novidades: 10, avisos: 30, aurinha: 50 };
// Pacotes (precos em centavos). Numero fechado no codigo: e PRECO.
const PACOTES = {
  novidades: { qty: 100, preco_centavos: 6900 },
  avisos: { qty: 200, preco_centavos: 1900 },
  aurinha: { qty: 300, preco_centavos: 2900 },
};

// Qual saldo uma origem (wa_outbox.source_type) gasta. O que nao esta aqui
// nao gasta saldo (continua so com as guardas antigas): mensalidade do
// dojo, otica pronta/adaptacao e placar do dia ficam FORA ate decisao.
// O waOutbox tambem aceita `saldoBucket` explicito no enqueue.
const SOURCE_BUCKET = {
  reativacao: 'novidades',
  aniversario: 'novidades',
  campanha: 'novidades',
  otica_revisao: 'novidades',
  venda_mais: 'novidades',
  crediario_oferta: 'novidades',
  crediario: 'avisos',
  crediario_manual: 'avisos',
  convite_conversa: 'avisos',
};

// Templates que, POR DECISAO, ainda nao gastam saldo (so o uso justo de
// 1.500/mes e os tetos do dia valem): mensalidade do dojo, otica pronta e
// adaptacao, placar do dia. Lista FECHADA: template de qualquer outra origem
// que nao esteja no SOURCE_BUCKET gasta saldo mesmo assim (avisos, ou
// novidades se o modelo e MARKETING) — origem nova esquecida nunca sai de
// graca para a loja e paga pela Aura (waOutbox.bucketDoTemplate).
const FORA_DO_SALDO = new Set(['dojo_mensalidade', 'otica_pronta', 'otica_adaptacao', 'placar_dia']);

function foraDoSaldo(sourceType) {
  return FORA_DO_SALDO.has(String(sourceType || ''));
}

const PLANOS_COM_FRANQUIA = new Set(['negocio', 'expansao']);
const VERTICAIS_COM_FRANQUIA = new Set(['karate_dojo', 'karate_federation']);

function ativo() {
  return ['1', 'true', 'sim', 'on'].includes(String(process.env.WA_SALDO_ATIVO || '').trim().toLowerCase());
}

// A propria Aura (suporte da Aura pelo hub) nunca e barrada.
function isento(companyId) {
  const v = String(process.env.AURA_COMPANY_ID || '').trim();
  return !!v && String(companyId) === v;
}

function bucketDaOrigem(sourceType) {
  return SOURCE_BUCKET[String(sourceType || '')] || null;
}

// ── Mes em Sao Paulo (UTC-3, sem horario de verao desde 2019) ─
function periodoDe(agora = new Date()) {
  const d = new Date(agora.getTime() - 3 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}
function renovaEmDe(agora = new Date()) {
  const d = new Date(agora.getTime() - 3 * 3600000);
  const y = d.getUTCMonth() === 11 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
  const m = (d.getUTCMonth() + 1) % 12;
  return `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

function schemaMissing(e) {
  return !!e && (e.code === '42P01' || e.code === '42703');
}

// Empresa: plano/vertical/add-on (quem tem franquia que renova), cota
// excepcional e qualidade do numero — uma consulta so, pelo runner.
async function lerEmpresa(runner, companyId) {
  const { rows } = await runner.query(
    `-- wa:saldo-empresa
     SELECT c.plan, c.vertical_active, c.vertical,
            c.wa_marketing_quota, c.wa_quality_rating, c.wa_paused_reason,
            EXISTS (SELECT 1 FROM company_addons a
                     WHERE a.company_id = c.id AND a.addon_key = 'whatsapp_auto'
                       AND a.status = 'active') AS addon
       FROM companies c WHERE c.id = $1 LIMIT 1`,
    [companyId]
  );
  const r = rows[0];
  if (!r) throw Object.assign(new Error('empresa nao encontrada'), { code: 'EMPRESA_AUSENTE' });
  const plan = r.plan ? String(r.plan).toLowerCase() : null;
  const verticais = [r.vertical_active, r.vertical].map((v) => (v ? String(v).toLowerCase() : null));
  let origem = 'essencial';
  if (r.addon) origem = 'addon';
  else if (plan && PLANOS_COM_FRANQUIA.has(plan)) origem = 'plano';
  else if (verticais.some((v) => v && VERTICAIS_COM_FRANQUIA.has(v))) origem = 'vertical';
  const cota = r.wa_marketing_quota === null || r.wa_marketing_quota === undefined
    ? null : Number(r.wa_marketing_quota);
  const rating = r.wa_quality_rating ? String(r.wa_quality_rating).toUpperCase() : null;
  return {
    renova: origem !== 'essencial',
    origem,
    cotaNovidades: Number.isInteger(cota) && cota >= 0 ? cota : null,
    emAtencao: rating === 'YELLOW' || rating === 'RED' || !!r.wa_paused_reason,
    motivoAtencao: rating === 'YELLOW' || rating === 'RED' ? 'QUALIDADE'
      : (r.wa_paused_reason ? 'PAUSA' : null),
  };
}

function franquiaTotal(bucket, empresa) {
  if (!empresa.renova) return 0;
  if (bucket === 'novidades' && empresa.cotaNovidades !== null) return empresa.cotaNovidades;
  return FRANQUIA_MENSAL[bucket];
}

// Linhas do livro-razao do mes (franquia) + vida toda (presente, pacote).
async function lerLinhas(runner, companyId, periodo) {
  const { rows } = await runner.query(
    `-- wa:saldo-linhas
     SELECT bucket, fonte, kind, COALESCE(SUM(qty), 0)::int AS soma
       FROM wa_saldo_lancamentos
      WHERE company_id = $1
        AND (fonte <> 'franquia' OR periodo = $2::date)
      GROUP BY bucket, fonte, kind`,
    [companyId, periodo]
  );
  return rows;
}

// Monta as tres fontes de UM saldo a partir das linhas.
function montarSaldo(bucket, empresa, linhas, periodo, renovaEm) {
  const soma = (fonte, kind) => {
    const l = linhas.find((x) => x.bucket === bucket && x.fonte === fonte && x.kind === kind);
    return l ? Number(l.soma) : 0;
  };
  const usado = (fonte) => -(soma(fonte, 'consumo') + soma(fonte, 'estorno'));
  const fontes = [];
  const pushFonte = (fonte, total, renova) => {
    const u = Math.min(Math.max(0, usado(fonte)), total);
    fontes.push({ fonte, total, usado: u, restante: Math.max(0, total - u), renova_em: renova });
  };

  const totalFranquia = franquiaTotal(bucket, empresa);
  if (totalFranquia > 0) pushFonte('franquia', totalFranquia, renovaEm);

  const concedido = linhas.some((x) => x.bucket === bucket && x.kind === 'boas_vindas');
  const creditoBV = soma('boas_vindas', 'boas_vindas');
  // Ainda nao gravado no livro-razao: aparece como disponivel (o reservar grava).
  const totalBV = creditoBV || (!empresa.renova && !concedido ? BOAS_VINDAS[bucket] : 0);
  if (totalBV > 0) pushFonte('boas_vindas', totalBV, null);

  const totalPacote = soma('pacote', 'pacote');
  if (totalPacote > 0) pushFonte('pacote', totalPacote, null);

  return { fontes, periodo };
}

function resumir(bucket, empresa, montado, renovaEm) {
  const total = montado.fontes.reduce((s, f) => s + f.total, 0);
  const usado = montado.fontes.reduce((s, f) => s + f.usado, 0);
  const restante = montado.fontes.reduce((s, f) => s + f.restante, 0);
  const bloqueado = bucket === 'novidades' && empresa.emAtencao ? 'NUMERO_EM_ATENCAO' : null;
  return {
    bucket,
    total,
    usado,
    restante,
    // 20% ou menos (e ainda sobra algo): o app avisa UMA vez por aviso_chave.
    baixo: restante > 0 && restante * 5 <= total,
    esgotado: restante <= 0,
    aviso_chave: `${bucket}:${montado.periodo.slice(0, 7)}`,
    renova_em: empresa.renova ? renovaEm : null,
    bloqueado_por: bloqueado,
    fontes: montado.fontes,
    pacote: { ...PACOTES[bucket] },
  };
}

// ── Leitura para o app (e para quem precisa cortar listas) ──
// Nao grava nada. Lanca em erro de banco; a rota traduz.
async function getSaldos(companyId, { agora = new Date(), runner = db } = {}) {
  const periodo = periodoDe(agora);
  const renovaEm = renovaEmDe(agora);
  const empresa = await lerEmpresa(runner, companyId);
  const linhas = await lerLinhas(runner, companyId, periodo);
  const saldos = {};
  for (const b of BUCKETS) {
    saldos[b] = resumir(b, empresa, montarSaldo(b, empresa, linhas, periodo, renovaEm), renovaEm);
  }
  return {
    ativo: ativo(),
    mes: periodo.slice(0, 7),
    renova_em: renovaEm,
    fuso: FUSO,
    plano: { renova: empresa.renova, origem: empresa.origem },
    numero: { em_atencao: empresa.emAtencao, motivo: empresa.motivoAtencao },
    saldos,
  };
}

async function restante(companyId, bucket, opts) {
  const s = await getSaldos(companyId, opts);
  return s.saldos[bucket].restante;
}

function recusa(code, extra = {}) {
  return { ok: false, code, ...extra };
}

// ── RESERVAR ────────────────────────────────────────────────
// Guarda 1 mensagem do saldo `bucket`. `runner` PRECISA ser um client
// dentro de uma transacao (BEGIN ja feito): o advisory lock e de
// transacao e some no COMMIT/ROLLBACK, junto com o INSERT na wa_outbox.
//
//   { companyId, bucket, refKey, outboxId?, conversaId?, agora? }
//
// Nunca lanca. Devolve:
//   { ok:true,  fonte, lancamento_id, restante, baixo }       reservou
//   { ok:true,  modo:'desligado' | isento:true }               trava/Aura
//   { ok:true,  jaReservado:true, fonte }                      refKey repetida
//   { ok:false, code:'SALDO_ESGOTADO', restante:0, renova_em } sem saldo
//   { ok:false, code:'NUMERO_EM_ATENCAO' }                     novidades com numero em atencao
//   { ok:false, code:'SALDO_INDISPONIVEL', motivo }            duvida/erro: bloqueia
// Quem recebe ok:false NAO enfileira e grava `code` como skip_reason.
async function reservar(runner, { companyId, bucket, refKey, outboxId = null, conversaId = null, agora = new Date() } = {}) {
  try {
    if (!companyId || !BUCKETS.includes(bucket) || !refKey) {
      return recusa('SALDO_INDISPONIVEL', { motivo: 'PARAMETROS' });
    }
    if (!ativo()) return { ok: true, modo: 'desligado' };
    if (isento(companyId)) return { ok: true, isento: true };
    if (!runner || runner === db || typeof runner.query !== 'function') {
      return recusa('SALDO_INDISPONIVEL', { motivo: 'SEM_TRANSACAO' });
    }

    // Serializa quem gasta o MESMO saldo da MESMA empresa.
    await runner.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`wa_saldo:${companyId}:${bucket}`]);

    const ja = await runner.query(
      'SELECT fonte FROM wa_saldo_lancamentos WHERE company_id = $1 AND ref_key = $2 AND kind = \'consumo\'',
      [companyId, refKey]
    );
    if (ja.rows.length) return { ok: true, jaReservado: true, fonte: ja.rows[0].fonte };

    const periodo = periodoDe(agora);
    const renovaEm = renovaEmDe(agora);
    const empresa = await lerEmpresa(runner, companyId);

    // Numero em atencao pausa as novidades; avisos e aurinha seguem.
    if (bucket === 'novidades' && empresa.emAtencao) {
      return recusa('NUMERO_EM_ATENCAO', { motivo: empresa.motivoAtencao });
    }

    // Presente do Essencial: grava uma vez (ref_key unico por saldo).
    if (!empresa.renova) {
      await runner.query(
        `INSERT INTO wa_saldo_lancamentos (company_id, bucket, kind, fonte, qty, ref_key, meta)
         VALUES ($1, $2, 'boas_vindas', 'boas_vindas', $3, $4, $5)
         ON CONFLICT (company_id, ref_key) DO NOTHING`,
        [companyId, bucket, BOAS_VINDAS[bucket], `boas_vindas:${bucket}`, JSON.stringify({ origem: 'primeira_reserva' })]
      );
    }

    const linhas = await lerLinhas(runner, companyId, periodo);
    const montado = montarSaldo(bucket, empresa, linhas, periodo, renovaEm);
    const alvo = montado.fontes.find((f) => f.restante > 0);
    if (!alvo) return recusa('SALDO_ESGOTADO', { restante: 0, renova_em: empresa.renova ? renovaEm : null });

    const ins = await runner.query(
      `INSERT INTO wa_saldo_lancamentos
         (company_id, bucket, kind, fonte, qty, periodo, ref_key, outbox_id, conversa_id)
       VALUES ($1, $2, 'consumo', $3, -1, $4, $5, $6, $7)
       ON CONFLICT (company_id, ref_key) DO NOTHING
       RETURNING id`,
      [companyId, bucket, alvo.fonte, alvo.fonte === 'franquia' ? periodo : null, refKey, outboxId, conversaId]
    );
    if (!ins.rows.length) return recusa('SALDO_INDISPONIVEL', { motivo: 'REF_DUPLICADA' });

    const total = montado.fontes.reduce((s, f) => s + f.total, 0);
    const resta = montado.fontes.reduce((s, f) => s + f.restante, 0) - 1;
    return {
      ok: true,
      fonte: alvo.fonte,
      lancamento_id: Number(ins.rows[0].id),
      restante: resta,
      baixo: resta > 0 && resta * 5 <= total,
    };
  } catch (e) {
    console.error('[waSaldo] reservar falhou (bloqueia):', e.code || '', e.message);
    return recusa('SALDO_INDISPONIVEL', { motivo: e.code || 'ERRO' });
  }
}

// Reserva avulsa, com transacao propria: para quem NAO enfileira pela
// waOutbox (ex.: a Aurinha). Quem enfileira usa reservar() dentro da
// propria transacao do INSERT.
async function reservarAvulso(opts) {
  let client;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '3s'");
    const r = await reservar(client, opts);
    if (r.ok) await client.query('COMMIT'); else await client.query('ROLLBACK');
    return r;
  } catch (e) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* ja caiu */ } }
    console.error('[waSaldo] reservarAvulso falhou (bloqueia):', e.code || '', e.message);
    return recusa('SALDO_INDISPONIVEL', { motivo: e.code || 'ERRO' });
  } finally {
    if (client) client.release();
  }
}

// ── DEVOLVER ────────────────────────────────────────────────
// Estorna o debito de uma mensagem que falhou de vez (permanente, 5
// tentativas, pulada no despacho ou recusada pela Meta). Idempotente:
// o estorno tem ref_key proprio. Nunca lanca; falha de estorno vai para
// o log (o cliente nao perde por erro nosso sem a gente saber).
//   devolver({ outboxId })  |  devolver({ companyId, refKey })
async function devolver({ outboxId = null, companyId = null, refKey = null } = {}) {
  // Sem checar a trava: reserva feita com ela ligada volta mesmo depois de desligada.
  if (!outboxId && !(companyId && refKey)) return { devolvido: false };
  if (outboxId) {
    // Barato e sem transacao: a imensa maioria dos pulados nunca reservou.
    try {
      const r = await db.query(
        `-- wa:saldo-devolver-existe
         SELECT 1 FROM wa_saldo_lancamentos WHERE outbox_id = $1 AND kind = 'consumo' LIMIT 1`,
        [outboxId]
      );
      if (!r || !r.rows || !r.rows.length) return { devolvido: false };
    } catch (e) {
      if (schemaMissing(e)) return { devolvido: false };
      console.error('[waSaldo] devolver (checagem) falhou:', e.code || '', e.message);
      return { devolvido: false, erro: e.code || 'ERRO' };
    }
  }
  let client;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '3s'");
    const { rows } = await client.query(
      outboxId
        ? `SELECT company_id, bucket, fonte, periodo::text AS periodo, ref_key FROM wa_saldo_lancamentos
            WHERE outbox_id = $1 AND kind = 'consumo' LIMIT 1`
        : `SELECT company_id, bucket, fonte, periodo::text AS periodo, ref_key FROM wa_saldo_lancamentos
            WHERE company_id = $1 AND ref_key = $2 AND kind = 'consumo' LIMIT 1`,
      outboxId ? [outboxId] : [companyId, refKey]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return { devolvido: false }; }
    const o = rows[0];
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`wa_saldo:${o.company_id}:${o.bucket}`]);
    const ins = await client.query(
      `INSERT INTO wa_saldo_lancamentos (company_id, bucket, kind, fonte, qty, periodo, ref_key, outbox_id)
       VALUES ($1, $2, 'estorno', $3, 1, $4, $5, $6)
       ON CONFLICT (company_id, ref_key) DO NOTHING
       RETURNING id`,
      [o.company_id, o.bucket, o.fonte, o.periodo, `estorno:${o.ref_key}`, outboxId]
    );
    await client.query('COMMIT');
    return { devolvido: ins.rows.length > 0 };
  } catch (e) {
    if (client) { try { await client.query('ROLLBACK'); } catch (_) { /* ja caiu */ } }
    if (!schemaMissing(e)) console.error('[waSaldo] devolver falhou:', e.code || '', e.message);
    return { devolvido: false, erro: e.code || 'ERRO' };
  } finally {
    if (client) client.release();
  }
}

module.exports = {
  BUCKETS, FRANQUIA_MENSAL, BOAS_VINDAS, PACOTES, SOURCE_BUCKET, FORA_DO_SALDO, FUSO,
  ativo, isento, bucketDaOrigem, foraDoSaldo, periodoDe, renovaEmDe,
  getSaldos, restante, reservar, reservarAvulso, devolver,
};
